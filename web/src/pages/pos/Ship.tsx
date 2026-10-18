import { useEffect, useMemo, useState } from "react";
import { ScanInput } from "../../components/ScanInput";
import { Badge, Empty, Modal, useAction, useToast } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call } from "../../firebase";
import { resolveCode } from "../../lib/lookup";
import { beep, money } from "../../lib/util";

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

/**
 * 7-11 交貨便（取貨不付款）批次匯入檔：用官方範本（public/templates/myship-711.xlsx），
 * 第 1、2 列是標題，從第 3 列開始一張訂單一列（範例列會被蓋掉）。
 * 電話、店號都用文字格式，開頭的 0 才不會不見。
 */
async function downloadMyShip(orders: ShipOrder[], sender: Sender) {
  const { default: JSZip } = await import("jszip");
  const buf = await (await fetch("/templates/myship-711.xlsx")).arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const path = "xl/worksheets/sheet1.xml";
  let xml = await zip.file(path)!.async("string");
  const x = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const cell = (col: string, row: number, v: string | number) =>
    typeof v === "number" ? `<c r="${col}${row}" s="5"><v>${v}</v></c>` : `<c r="${col}${row}" s="5" t="inlineStr"><is><t>${x(v)}</t></is></c>`;
  const rows = orders.map((o, i) => {
    const r = i + 3;
    const s = o.shipmentDetail;
    const cs = s?.convenienceStore;
    const vals: [string, string | number][] = [
      ["B", sender.name],
      ["C", sender.phone],
      ["D", sender.email],
      ["E", Math.round(o.totalPrice)],
      ["F", cs?.name ?? ""],
      ["G", cs?.storeCode ?? ""],
      ["H", s?.receiverName ?? o.shopper?.name ?? ""],
      ["I", (s?.phone ?? "").replace(/[^\d]/g, "")],
      ["J", o.shopper?.email || sender.email], // 交貨便規定必填；客人沒有 Email 時用寄件人的
    ];
    return `<row r="${r}">${vals.map(([c, v]) => cell(c, r, v)).join("")}</row>`;
  });
  // 拿掉範本第 3 列以後（範例），換成訂單
  xml = xml.replace(/<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (m, n) => (Number(n) >= 3 ? "" : m));
  xml = xml.replace(/<row r="(\d+)"[^>]*\/>/g, (m, n) => (Number(n) >= 3 ? "" : m));
  xml = xml.replace("</sheetData>", `${rows.join("")}</sheetData>`);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:L${orders.length + 2}"/>`);
  zip.file(path, xml);
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `7-11交貨便匯入_${new Date().toISOString().slice(0, 10)}_${orders.length}筆.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 撿貨單（合併所有選取訂單，同款加總）＋每張訂單一頁出貨單 */
function printDocs(orders: ShipOrder[], label: (variantId: string | undefined, title: string) => string, paper: "a4" | "label") {
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
</style></head><body>${pickPage}${slips}<script>onload = () => setTimeout(() => print(), 300)</script></body></html>`);
  w.document.close();
}

export function Ship() {
  const { byId } = useData();
  const [orders, setOrders] = useState<ShipOrder[] | null>(null);
  const [kind, setKind] = useState<Kind | "all">("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [packing, setPacking] = useState<ShipOrder | null>(null);
  const [senderOpen, setSenderOpen] = useState(false);
  const [sender, setSender] = useState<Sender>(loadSender);
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
  const chosen711 = chosen.filter((o) => kindOf(o) === "711" && o.shipmentDetail?.convenienceStore?.storeCode);
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
          <div className="muted small">近 60 天還沒出貨的 meepShop 訂單（先下單的在前面）。勾選後列印撿貨單＋出貨單；包貨時按「包貨核對」掃吊牌確認。</div>
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
        <button className="btn btn-primary" disabled={!chosen.length} onClick={() => printDocs(chosen, label, paper)}>
          列印撿貨單＋出貨單（{chosen.length}）
        </button>
        <button
          className="btn"
          disabled={!chosen711.length || busy}
          title="勾選的 7-11 訂單，產生 7-11 交貨便（取貨不付款）批次匯入的 Excel"
          onClick={() => {
            if (!sender.name || !sender.phone || !sender.email) return setSenderOpen(true);
            run(async () => {
              await downloadMyShip(chosen711, sender);
              toast(`已下載 ${chosen711.length} 筆，到 7-11 交貨便網站「批次匯入」上傳`, "ok");
            });
          }}
        >
          下載 7-11 交貨便匯入檔（{chosen711.length}）
        </button>
        <button className="link-btn small" onClick={() => setSenderOpen(true)}>
          寄件人資料
        </button>
      </div>
      {chosen.length > chosen711.length && chosen711.length > 0 && <p className="muted small">交貨便匯入檔只會包含 7-11 的訂單；全家、宅配請另外處理。</p>}
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
        <Modal
          title="寄件人資料（7-11 交貨便）"
          onClose={() => setSenderOpen(false)}
          footer={
            <button
              className="btn btn-primary"
              disabled={!sender.name || !/^09\d{8}$/.test(sender.phone) || !sender.email.includes("@")}
              onClick={() => {
                try {
                  localStorage.setItem("g29.shipSender", JSON.stringify(sender));
                } catch {
                  /* ignore */
                }
                setSenderOpen(false);
              }}
            >
              儲存
            </button>
          }
        >
          <p className="muted small">交貨便規定寄件人姓名、手機、Email 都要填（存在這台裝置）。</p>
          <input placeholder="寄件人姓名" value={sender.name} onChange={(e) => setSender({ ...sender, name: e.target.value })} />
          <input placeholder="寄件人手機（09 開頭）" inputMode="tel" value={sender.phone} onChange={(e) => setSender({ ...sender, phone: e.target.value.replace(/\D/g, "") })} />
          <input placeholder="寄件人 Email" type="email" value={sender.email} onChange={(e) => setSender({ ...sender, email: e.target.value.trim() })} />
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
