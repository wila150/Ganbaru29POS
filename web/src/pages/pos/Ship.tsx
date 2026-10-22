import { useEffect, useMemo, useState } from "react";
import { ScanInput } from "../../components/ScanInput";
import { Badge, Empty, Modal, useAction, useToast } from "../../components/ui";
import { useData, variantName } from "../../data";
import { doc, setDoc } from "firebase/firestore";
import { useAuth } from "../../auth";
import { call, db } from "../../firebase";
import { resolveCode } from "../../lib/lookup";
import { atLeast, beep, money } from "../../lib/util";

/** meepShop 網店訂單（待出貨） */
interface ShipOrder {
  id: string;
  orderNumber: string;
  paymentStatus: string;
  shipmentStatus: string;
  totalPrice: number;
  createdAt: string;
  shopper: { name: string | null; email?: string | null } | null;
  shipmentDetail: {
    name: string | null;
    receiverName: string | null;
    phone: string | null;
    note: string | null;
    shippingAddress: string | null;
    convenienceStore: { name: string | null; address: string | null; storeCode: string | null } | null;
  } | null;
  paymentDetail: { name: string | null } | null;
  lineItems: { title: string; quantity: number; unitPrice: number; variant: { id: string } | null }[] | null;
}

type Kind = "711" | "family" | "home" | "other";
const KIND_LABEL: Record<Kind, string> = { "711": "7-11", family: "全家", home: "宅配", other: "其他" };
function kindOf(o: ShipOrder): Kind {
  const n = o.shipmentDetail?.name ?? "";
  if (/7-?11|統一|交貨便/.test(n)) return "711";
  if (/全家/.test(n)) return "family";
  if (/宅配|黑貓|新竹|郵局|郵寄|宅急便/.test(n)) return "home";
  return "other";
}
const SHIP_STATUS: Record<string, string> = { PROCESSING: "待處理", PREPARING: "備貨中", OUT_OF_STOCK: "缺貨", PRE_ORDER: "預購" };
const PAY_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "mute" }> = {
  PAID: { label: "已付款", tone: "ok" },
  RECONCILED: { label: "已付款", tone: "ok" },
  NOT_PAID: { label: "未付款", tone: "bad" },
  FAILED: { label: "付款失敗", tone: "bad" },
  REFUNDED: { label: "已退款", tone: "mute" },
};
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmtDate = (iso: string) => new Date(iso).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const dest = (o: ShipOrder) => {
  const s = o.shipmentDetail;
  const cs = s?.convenienceStore;
  return cs?.name ? `${cs.name}${cs.storeCode ? `（${cs.storeCode}）` : ""}　${cs.address ?? ""}` : s?.shippingAddress ?? "";
};

/** 寄件人（7-11 交貨便匯入檔用），存在這台裝置 */
interface Sender {
  name: string;
  phone: string;
  email: string;
}
function loadSender(): Sender {
  try {
    return { name: "", phone: "", email: "", ...JSON.parse(localStorage.getItem("g29.shipSender") || "{}") };
  } catch {
    return { name: "", phone: "", email: "" };
  }
}

/** 台灣地址拆成 縣市／鄉鎮市區／其餘（全家宅配匯入要分開填）；去掉開頭的郵遞區號和「臺灣」 */
export function splitAddress(raw: string): { city: string; district: string; rest: string } | null {
  const a = raw.replace(/^\s*\d{3,6}\s*/, "").replace(/^(臺灣|台灣)\s*/, "").replace(/\s+/g, "");
  const m = a.match(/^(\S{2}[縣市])(\S{1,4}?[區鄉鎮市])(.+)$/);
  return m ? { city: m[1], district: m[2], rest: m[3] } : null;
}

type ExportKind = "711" | "family" | "home" | "cat";
interface ExportDef {
  label: string;
  file: string;
  /** 第一列資料在第幾列（前面是標題） */
  start: number;
  lastCol: string;
  match: (o: ShipOrder) => boolean;
  /** 檢查問題（名字太長、沒有店號…），有問題的不匯出 */
  problem: (o: ShipOrder, s: Sender) => string | null;
  row: (o: ShipOrder, s: Sender) => [string, string | number | { date: number }][];
  name: string;
}
/** 今天（台灣時間）的 Excel 日期序號 */
const excelToday = () => {
  const t = new Date(Date.now() + 8 * 3600_000);
  return Math.round((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86400_000);
};
/** 去掉郵遞區號和「臺灣」，留下完整地址（含縣市、區） */
const cleanAddress = (raw: string | null | undefined) => (raw ?? "").replace(/^\s*\d{3,6}\s*/, "").replace(/^(臺灣|台灣)\s*/, "").replace(/\s+/g, "");
const receiver = (o: ShipOrder) => (o.shipmentDetail?.receiverName ?? o.shopper?.name ?? "").trim();
const phone = (v: string | null | undefined) => (v ?? "").replace(/[^\d]/g, "");
const len = (t: string) => [...t].length;

export const EXPORTS: Record<ExportKind, ExportDef> = {
  "711": {
    label: "7-11 交貨便",
    name: "7-11交貨便匯入",
    file: "/templates/myship-711.xlsx",
    start: 3,
    lastCol: "L",
    match: (o) => kindOf(o) === "711",
    problem: (o) => (!o.shipmentDetail?.convenienceStore?.storeCode ? "沒有門市店號" : !phone(o.shipmentDetail?.phone) ? "沒有收件人電話" : null),
    row: (o, s) => [
      ["B", s.name],
      ["C", s.phone],
      ["D", s.email],
      ["E", 999], // 實際包裹價值：固定 999（填售價會超過 1000、運費變高）
      ["F", o.shipmentDetail?.convenienceStore?.name ?? ""],
      ["G", o.shipmentDetail?.convenienceStore?.storeCode ?? ""],
      ["H", receiver(o)],
      ["I", phone(o.shipmentDetail?.phone)],
      ["J", o.shopper?.email || s.email], // 交貨便規定必填；客人沒有 Email 時用寄件人的
    ],
  },
  family: {
    label: "全家店到店",
    name: "全家店到店匯入",
    file: "/templates/family-store.xlsx",
    start: 2,
    lastCol: "S",
    match: (o) => kindOf(o) === "family",
    problem: (o, s) =>
      len(s.name) > 4 ? "寄件人姓名超過 4 個字（全家規定）" : len(receiver(o)) > 4 ? `收件人姓名「${receiver(o)}」超過 4 個字（全家規定）` : !o.shipmentDetail?.convenienceStore?.storeCode ? "沒有門市店號" : null,
    row: (o, s) => [
      ["A", "A"], // A = 店到店
      ["B", s.name],
      ["C", "886"],
      ["D", s.phone],
      ["E", "1"], // 1 = (常溫)一般寄件
      ["F", o.shipmentDetail?.convenienceStore?.name ?? ""],
      ["G", o.shipmentDetail?.convenienceStore?.storeCode ?? ""],
      ["H", receiver(o)],
      ["I", "886"],
      ["J", phone(o.shipmentDetail?.phone)],
      ["K", 0], // 代收金額 0 = 已付款
      ["S", o.orderNumber],
    ],
  },
  home: {
    label: "全家寄宅配（全+郵）",
    name: "全家宅配匯入",
    file: "/templates/family-home.xlsx",
    start: 2,
    lastCol: "M",
    match: (o) => kindOf(o) === "home",
    problem: (o, s) =>
      len(s.name) > 4 ? "寄件人姓名超過 4 個字（全家規定）" : len(receiver(o)) > 4 ? `收件人姓名「${receiver(o)}」超過 4 個字（全家規定）` : !splitAddress(o.shipmentDetail?.shippingAddress ?? "") ? "地址無法分出縣市／區，請手動填" : null,
    row: (o, s) => {
      const a = splitAddress(o.shipmentDetail?.shippingAddress ?? "")!;
      return [
        ["A", "D"], // D = 全+郵宅配
        ["B", s.name],
        ["C", "886"],
        ["D", s.phone],
        ["E", receiver(o)],
        ["F", "886"],
        ["G", phone(o.shipmentDetail?.phone)],
        ["H", a.city],
        ["I", a.district],
        ["J", a.rest],
        ["M", o.orderNumber],
      ];
    },
  },
  cat: {
    label: "黑貓宅急便",
    name: "黑貓宅急便匯入",
    file: "/templates/blackcat.xlsx",
    start: 2,
    lastCol: "I",
    match: (o) => kindOf(o) === "home",
    problem: (o) => {
      const m = phone(o.shipmentDetail?.phone);
      return len(receiver(o)) > 14 ? `收件人姓名超過 14 個字` : !/^09\d{8}$/.test(m) ? "收件人不是台灣手機號碼，請手動處理" : !splitAddress(o.shipmentDetail?.shippingAddress ?? "") ? "地址沒有縣市、區（可能是海外），請手動處理" : null;
    },
    row: (o) => {
      const m = phone(o.shipmentDetail?.phone);
      const qty = (o.lineItems ?? []).reduce((a, l) => a + l.quantity, 0);
      return [
        ["A", "常溫"],
        ["B", receiver(o)],
        ["D", `${m.slice(0, 4)}-${m.slice(4)}`], // 黑貓規定 09XX-XXXXXX
        ["E", cleanAddress(o.shipmentDetail?.shippingAddress)],
        ["F", { date: excelToday() }], // 寄件日期：今天（只接受 7 天內）
        ["G", `服飾${qty}件`.slice(0, 10)],
        ["H", "服飾配件"],
        ["I", "不指定"],
      ];
    },
  },
};

/** 用官方範本產生批次匯入檔：範本標題列保留，資料從 def.start 列開始（範例列會被蓋掉）。電話、店號用文字格式，開頭的 0 不會不見。 */
async function downloadImport(def: ExportDef, orders: ShipOrder[], sender: Sender) {
  const { default: JSZip } = await import("jszip");
  const buf = await (await fetch(def.file)).arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const path = "xl/worksheets/sheet1.xml";
  let xml = await zip.file(path)!.async("string");
  const x = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  // 日期欄位：在 styles.xml 加一個日期格式（內建 14 = yyyy/m/d），讓 Excel 顯示成日期
  let dateStyle = -1;
  const needDate = orders.some((o) => def.row(o, sender).some(([, v]) => typeof v === "object"));
  if (needDate) {
    const sp = "xl/styles.xml";
    let st = await zip.file(sp)!.async("string");
    const m = st.match(/<cellXfs count="(\d+)">/);
    if (m) {
      dateStyle = Number(m[1]);
      st = st.replace(m[0], `<cellXfs count="${dateStyle + 1}">`).replace("</cellXfs>", `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`);
      zip.file(sp, st);
    }
  }
  const cell = (col: string, row: number, v: string | number | { date: number }) =>
    typeof v === "object"
      ? `<c r="${col}${row}"${dateStyle >= 0 ? ` s="${dateStyle}"` : ""}><v>${v.date}</v></c>`
      : typeof v === "number"
        ? `<c r="${col}${row}"><v>${v}</v></c>`
        : `<c r="${col}${row}" t="inlineStr"><is><t>${x(v)}</t></is></c>`;
  const rows = orders.map((o, i) => {
    const r = i + def.start;
    return `<row r="${r}">${def.row(o, sender).map(([c, v]) => cell(c, r, v)).join("")}</row>`;
  });
  xml = xml.replace(/<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (m, n) => (Number(n) >= def.start ? "" : m));
  xml = xml.replace(/<row r="(\d+)"[^>]*\/>/g, (m, n) => (Number(n) >= def.start ? "" : m));
  xml = xml.replace("</sheetData>", `${rows.join("")}</sheetData>`).replace("<sheetData/>", `<sheetData>${rows.join("")}</sheetData>`);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${def.lastCol}${orders.length + def.start - 1}"/>`);
  zip.file(path, xml);
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${def.name}_${new Date().toISOString().slice(0, 10)}_${orders.length}筆.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 撿貨單（合併所有選取訂單，同款加總）＋每張訂單一頁出貨單 */
function printDocs(orders: ShipOrder[], label: (variantId: string | undefined, title: string) => string, paper: "a4" | "label", what: { pick: boolean; slip: boolean }) {
  const w = window.open("", "_blank");
  if (!w) return alert("瀏覽器擋了彈出視窗，請允許後再按一次");
  const pick = new Map<string, { name: string; qty: number; orders: string[] }>();
  for (const o of orders)
    for (const l of o.lineItems ?? []) {
      const key = l.variant?.id ?? l.title;
      const cur = pick.get(key) ?? { name: label(l.variant?.id, l.title), qty: 0, orders: [] };
      cur.qty += l.quantity;
      cur.orders.push(o.orderNumber);
      pick.set(key, cur);
    }
  const pickRows = [...pick.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  const pickPage = `<section class="page"><h1>撿貨單</h1><p>${new Date().toLocaleString("zh-TW", { hour12: false })}　共 ${orders.length} 張訂單、${pickRows.reduce((s, r) => s + r.qty, 0)} 件</p>
<table><tr><th style="width:28px">✓</th><th>商品／規格</th><th class="r">數量</th><th>訂單</th></tr>${pickRows.map((r) => `<tr><td>□</td><td>${esc(r.name)}</td><td class="r b">${r.qty}</td><td class="s">${esc([...new Set(r.orders)].join("、"))}</td></tr>`).join("")}</table></section>`;
  const slips = orders
    .map((o) => {
      const s = o.shipmentDetail;
      return `<section class="page"><div class="hd"><h1>${esc(KIND_LABEL[kindOf(o)])}　${esc(o.orderNumber)}</h1><span>${esc(fmtDate(o.createdAt))}</span></div>
<p class="big">收件人：${esc(s?.receiverName ?? o.shopper?.name ?? "")}　${esc(s?.phone ?? "")}</p>
<p>${esc(s?.name ?? "")}</p><p class="b">${esc(dest(o))}</p>
${s?.note ? `<p>備註：${esc(s.note)}</p>` : ""}
<table><tr><th style="width:28px">✓</th><th>商品／規格</th><th class="r">數量</th></tr>${(o.lineItems ?? []).map((l) => `<tr><td>□</td><td>${esc(label(l.variant?.id, l.title))}</td><td class="r b">${l.quantity}</td></tr>`).join("")}</table>
<p class="r">共 ${(o.lineItems ?? []).reduce((a, l) => a + l.quantity, 0)} 件　${esc(o.paymentDetail?.name ?? "")}　${money(o.totalPrice)}</p></section>`;
    })
    .join("");
  const size = paper === "label" ? "@page { size: 100mm 150mm; margin: 4mm; } body { font-size: 11px; }" : "@page { size: A4; margin: 12mm; } body { font-size: 13px; }";
  w.document.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>出貨單</title><style>
${size}
body { font-family: -apple-system, "PingFang TC", "Noto Sans TC", sans-serif; color: #000; margin: 0; }
.page { page-break-after: always; } .page:last-child { page-break-after: auto; }
h1 { font-size: 1.5em; margin: 0 0 6px; } .hd { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #000; margin-bottom: 6px; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; } th, td { border-bottom: 1px solid #999; padding: 4px; text-align: left; vertical-align: top; }
.r { text-align: right; } .b { font-weight: 700; } .s { font-size: .85em; color: #333; } .big { font-size: 1.2em; font-weight: 700; margin: 4px 0; } p { margin: 3px 0; }
</style></head><body>${what.pick ? pickPage : ""}${what.slip ? slips : ""}<script>onload = () => setTimeout(() => print(), 300)</script></body></html>`);
  w.document.close();
}

export function Ship() {
  const { byId, settings } = useData();
  const { profile } = useAuth();
  const isOwner = atLeast(profile?.role, "owner");
  const senders = settings.shipSenders ?? [];
  const [orders, setOrders] = useState<ShipOrder[] | null>(null);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [packing, setPacking] = useState<ShipOrder | null>(null);
  const [senderOpen, setSenderOpen] = useState(false);
  // 要印哪些：撿貨單、出貨單（記在這台裝置）
  const [what, setWhat] = useState<{ pick: boolean; slip: boolean }>(() => {
    try {
      return { pick: true, slip: true, ...JSON.parse(localStorage.getItem("g29.shipPrint") || "{}") };
    } catch {
      return { pick: true, slip: true };
    }
  });
  const setWhatSave = (w: { pick: boolean; slip: boolean }) => {
    setWhat(w);
    try {
      localStorage.setItem("g29.shipPrint", JSON.stringify(w));
    } catch {
      /* ignore */
    }
  };
  // 寄件人：老闆在這裡新增一次，全店每台裝置都能選；這台裝置記住上次選哪一個
  const [senderIdx, setSenderIdx] = useState(() => {
    try {
      return Number(localStorage.getItem("g29.shipSenderIdx") || 0);
    } catch {
      return 0;
    }
  });
  const [draft, setDraft] = useState<Sender>(loadSender);
  const sender: Sender = senders[senderIdx] ?? senders[0] ?? draft;
  const toast = useToast();
  const [paper, setPaper] = useState<"a4" | "label">(() => {
    try {
      return (localStorage.getItem("g29.shipPaper") as "a4" | "label") || "a4";
    } catch {
      return "a4";
    }
  });
  const { busy, run } = useAction();
  const load = () => run(async () => setOrders((await call<{ orders: ShipOrder[] }>("pendingShipments", { days: 60 })).orders));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const label = (variantId: string | undefined, title: string) => {
    const v = variantId ? byId.get(variantId) : undefined;
    return v ? variantName(v) : title;
  };
  const list = useMemo(() => (orders ?? []).filter((o) => kind === "all" || kindOf(o) === kind), [orders, kind]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: orders?.length ?? 0 };
    for (const o of orders ?? []) c[kindOf(o)] = (c[kindOf(o)] ?? 0) + 1;
    return c;
  }, [orders]);
  const chosen = list.filter((o) => sel.has(o.id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>網店出貨</h1>
          <div className="muted small">近 60 天還沒出貨的 meepShop 訂單（先下單的在前面）。勾選訂單、選要印撿貨單（同款加總，拿貨用）或出貨單（每張訂單一頁，放進包裹）；包貨時按「包貨核對」掃吊牌確認。</div>
        </div>
        <button className="btn" disabled={busy} onClick={load}>
          {busy ? "讀取中…" : "重新整理"}
        </button>
      </div>
      <div className="chips">
        {(["all", "711", "family", "home", "other"] as const).map((k) => (
          <button key={k} className={`chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
            {k === "all" ? "全部" : KIND_LABEL[k]} <span className="chip-count">{counts[k] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="row-inline ship-actions">
        <label className="check">
          <input type="checkbox" checked={list.length > 0 && chosen.length === list.length} onChange={(e) => setSel(e.target.checked ? new Set(list.map((o) => o.id)) : new Set())} /> 全選（{chosen.length}／{list.length}）
        </label>
        <select
          value={paper}
          onChange={(e) => {
            setPaper(e.target.value as "a4" | "label");
            try {
              localStorage.setItem("g29.shipPaper", e.target.value);
            } catch {
              /* ignore */
            }
          }}
        >
          <option value="a4">A4 紙</option>
          <option value="label">標籤機 10×15 cm</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={what.pick} onChange={(e) => setWhatSave({ ...what, pick: e.target.checked })} /> 撿貨單
        </label>
        <label className="check">
          <input type="checkbox" checked={what.slip} onChange={(e) => setWhatSave({ ...what, slip: e.target.checked })} /> 出貨單
        </label>
        <button className="btn btn-primary" disabled={!chosen.length || (!what.pick && !what.slip)} onClick={() => printDocs(chosen, label, paper, what)}>
          列印{what.pick && what.slip ? "撿貨單＋出貨單" : what.pick ? "撿貨單" : what.slip ? "出貨單" : ""}（{chosen.length}）
        </button>
        {(Object.keys(EXPORTS) as ExportKind[]).map((k) => {
          const def = EXPORTS[k];
          const os = chosen.filter(def.match);
          if (!os.length) return null;
          return (
            <button
              key={k}
              className="btn"
              disabled={busy}
              title={`勾選的${def.label}訂單，產生官方批次匯入的 Excel`}
              onClick={() => {
                if (!sender.name || !sender.phone || !sender.email) return setSenderOpen(true);
                const bad = os.map((o) => ({ o, why: def.problem(o, sender) })).filter((x) => x.why);
                const ok = os.filter((o) => !def.problem(o, sender));
                if (bad.length) alert(`這幾張不會放進匯入檔，請手動處理：\n${bad.map((x) => `・${x.o.orderNumber}：${x.why}`).join("\n")}`);
                if (!ok.length) return;
                run(async () => {
                  await downloadImport(def, ok, sender);
                  toast(`已下載 ${def.label} ${ok.length} 筆，到官方網站「批次匯入」上傳`, "ok");
                });
              }}
            >
              下載{def.label}匯入檔（{os.length}）
            </button>
          );
        })}
        <button className="link-btn small" onClick={() => setSenderOpen(true)}>
          寄件人：{sender.name || "未設定"}
        </button>
      </div>

      {orders === null ? (
        <p className="muted">讀取中…</p>
      ) : list.length === 0 ? (
        <Empty>沒有待出貨的網店訂單 🎉</Empty>
      ) : (
        <div className="ship-list">
          {list.map((o) => {
            const s = o.shipmentDetail;
            const pay = PAY_STATUS[o.paymentStatus];
            const qty = (o.lineItems ?? []).reduce((a, l) => a + l.quantity, 0);
            return (
              <div key={o.id} className={`card ship-card ${sel.has(o.id) ? "on" : ""}`}>
                <div className="ship-head">
                  <input type="checkbox" checked={sel.has(o.id)} onChange={() => toggle(o.id)} />
                  <Badge tone="info">{KIND_LABEL[kindOf(o)]}</Badge>
                  <strong>{o.orderNumber}</strong>
                  <span className="muted small">{fmtDate(o.createdAt)}</span>
                  {pay && <Badge tone={pay.tone}>{pay.label}</Badge>}
                  <Badge tone={o.shipmentStatus === "OUT_OF_STOCK" ? "bad" : "warn"}>{SHIP_STATUS[o.shipmentStatus] ?? o.shipmentStatus}</Badge>
                  <span className="grow" />
                  <button className="btn btn-sm btn-primary" onClick={() => setPacking(o)}>
                    包貨核對
                  </button>
                </div>
                <div className="ship-body">
                  <div>
                    <div>
                      <b>{s?.receiverName ?? o.shopper?.name}</b>　{s?.phone}
                    </div>
                    <div className="muted small">
                      {s?.name}　{dest(o)}
                    </div>
                    {s?.note && <div className="small">📝 {s.note}</div>}
                  </div>
                  <ul className="ship-items">
                    {(o.lineItems ?? []).map((l, i) => (
                      <li key={i}>
                        {label(l.variant?.id, l.title)} <b>× {l.quantity}</b>
                      </li>
                    ))}
                  </ul>
                  <div className="r small muted">
                    {qty} 件　{money(o.totalPrice)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {senderOpen && (
        <Modal title="寄件人（7-11 交貨便、全家）" onClose={() => setSenderOpen(false)}>
          {senders.length > 0 && (
            <>
              <p className="muted small">選一個寄件人（全店共用，每台平板、電腦都能用）：</p>
              {senders.map((x, i) => (
                <label key={i} className="check sender-opt">
                  <input
                    type="radio"
                    checked={i === (senders[senderIdx] ? senderIdx : 0)}
                    onChange={() => {
                      setSenderIdx(i);
                      try {
                        localStorage.setItem("g29.shipSenderIdx", String(i));
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                  <b>{x.name}</b>　{x.phone}　<span className="muted">{x.email}</span>
                  {isOwner && (
                    <button type="button" className="btn-icon danger" title="刪除" onClick={() => confirm(`刪除寄件人「${x.name}」？`) && run(() => setDoc(doc(db, "settings", "shop"), { shipSenders: senders.filter((_, j) => j !== i) }, { merge: true }))}>
                      ✕
                    </button>
                  )}
                </label>
              ))}
            </>
          )}
          {isOwner ? (
            <>
              <h3>新增寄件人</h3>
              <input placeholder="寄件人姓名（全家規定最多 4 個字）" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <input placeholder="寄件人手機（09 開頭）" inputMode="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value.replace(/\D/g, "") })} />
              <input placeholder="寄件人 Email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value.trim() })} />
              <button
                className="btn btn-primary"
                disabled={busy || !draft.name || !/^09\d{8}$/.test(draft.phone) || !draft.email.includes("@")}
                onClick={() =>
                  run(async () => {
                    await setDoc(doc(db, "settings", "shop"), { shipSenders: [...senders, draft] }, { merge: true });
                    setSenderIdx(senders.length);
                    setDraft({ name: "", phone: "", email: "" });
                  }, "已新增寄件人")
                }
              >
                新增
              </button>
            </>
          ) : (
            senders.length === 0 && <p className="error">還沒有寄件人，請老闆在這裡新增一次。</p>
          )}
        </Modal>
      )}
      {packing && (
        <PackCheck
          order={packing}
          label={label}
          onClose={() => setPacking(null)}
          onDone={() => {
            setPacking(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/** 包貨核對：掃吊牌，系統比對拿的商品、尺寸顏色、數量是否正確 */
function PackCheck({ order: o, label, onClose, onDone }: { order: ShipOrder; label: (id: string | undefined, t: string) => string; onClose: () => void; onDone: () => void }) {
  const { byId } = useData();
  const lines = (o.lineItems ?? []).map((l, i) => ({ key: l.variant?.id ?? `t${i}`, variantId: l.variant?.id, name: label(l.variant?.id, l.title), qty: l.quantity }));
  const [scanned, setScanned] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const done = lines.every((l) => (scanned[l.key] ?? 0) === l.qty);
  const onCode = async (code: string) => {
    const v = await resolveCode(code, byId);
    if (!v) {
      beep(false);
      return setMsg({ ok: false, text: `找不到這個條碼：${code}` });
    }
    const line = lines.find((l) => l.variantId === v.id);
    if (!line) {
      beep(false);
      const sameProduct = lines.find((l) => l.variantId && byId.get(l.variantId)?.productId === v.productId);
      return setMsg({ ok: false, text: sameProduct ? `⚠️ 尺寸／顏色拿錯了：掃到「${variantName(v)}」，訂單要的是「${sameProduct.name}」` : `⚠️ 這張訂單沒有「${variantName(v)}」` });
    }
    const n = (scanned[line.key] ?? 0) + 1;
    if (n > line.qty) {
      beep(false);
      return setMsg({ ok: false, text: `⚠️「${line.name}」只要 ${line.qty} 件，已經掃滿了` });
    }
    beep(true);
    setScanned((x) => ({ ...x, [line.key]: n }));
    setMsg({ ok: true, text: `✓ ${line.name}（${n}／${line.qty}）` });
  };
  const markShipped = (status: "PREPARING" | "FULFILLED") =>
    run(async () => {
      await call("updateShipment", { orderNumber: o.orderNumber, status });
      toast(status === "FULFILLED" ? "已標成已出貨（meepShop 同步更新）" : "已標成備貨中", "ok");
      onDone();
    });
  return (
    <Modal
      title={`包貨核對 ${o.orderNumber}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" disabled={busy} onClick={() => markShipped("PREPARING")}>
            標成備貨中
          </button>
          <button className="btn btn-primary" disabled={busy || !done} onClick={() => markShipped("FULFILLED")}>
            {done ? "核對完成，標成已出貨" : "全部掃完才能標成已出貨"}
          </button>
        </>
      }
    >
      <p className="small">
        <b>{o.shipmentDetail?.receiverName}</b>　{o.shipmentDetail?.name}　{dest(o)}
      </p>
      <ScanInput onCode={onCode} placeholder="掃商品吊牌 QR／條碼" continuousCamera />
      {msg && <p className={msg.ok ? "ok strong" : "error strong"}>{msg.text}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>商品／規格</th>
            <th className="num">要</th>
            <th className="num">已掃</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const n = scanned[l.key] ?? 0;
            return (
              <tr key={l.key} className={n === l.qty ? "row-done" : ""}>
                <td>{l.name}</td>
                <td className="num">{l.qty}</td>
                <td className="num strong">{n}</td>
                <td>
                  {n === l.qty ? (
                    "✅"
                  ) : (
                    <button className="btn btn-sm btn-ghost" title="沒有吊牌可掃時手動 +1" onClick={() => setScanned((x) => ({ ...x, [l.key]: n + 1 }))}>
                      手動 +1
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {done && <p className="ok strong">✅ 全部核對正確，可以封箱了</p>}
      <p className="muted small">標成「已出貨」會同步到 meepShop；網店庫存在客人下單時已經扣過，這裡不會再扣一次。</p>
    </Modal>
  );
}
