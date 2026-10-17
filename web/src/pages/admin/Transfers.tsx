import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { ScanInput } from "../../components/ScanInput";
import { Badge, Empty, Field, Modal, useAction, useToast } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { useDeviceLocation } from "../../lib/location";
import { resolveCode, searchVariants } from "../../lib/lookup";
import { beep, fmtTime } from "../../lib/util";

interface Transfer {
  id: string;
  from: string;
  to: string;
  items: { variantId: string; qty: number; title: string; sku: string | null }[];
  note: string | null;
  status: "requested" | "shipped" | "received" | "canceled";
  requestedBy: string;
  requestedAt: Timestamp | null;
  shippedBy?: string;
  shippedAt?: Timestamp;
  receivedBy?: string;
  receivedAt?: Timestamp;
}

const STATUS: Record<Transfer["status"], React.ReactNode> = {
  requested: <Badge tone="warn">待出貨</Badge>,
  shipped: <Badge tone="info">運送中</Badge>,
  received: <Badge tone="ok">已收貨</Badge>,
  canceled: <Badge>已取消</Badge>,
};

type Tab = "todo" | "all";

/** 調貨：申請 → 調出地點出貨（扣）→ 調入地點收貨（加）。meepShop 總庫存不變。 */
export function Transfers() {
  const { multi, locationId, locations } = useDeviceLocation();
  const [list, setList] = useState<Transfer[]>([]);
  const [tab, setTab] = useState<Tab>("todo");
  const [creating, setCreating] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => onSnapshot(query(collection(db, "transfers"), orderBy("requestedAt", "desc"), limit(200)), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Transfer))), []);
  const name = (id: string) => locations.find((l) => l.id === id)?.name ?? id;

  const rows = useMemo(
    () => (tab === "todo" ? list.filter((t) => (t.status === "requested" && t.from === locationId) || (t.status === "shipped" && t.to === locationId) || (t.status === "requested" && t.to === locationId)) : list),
    [list, tab, locationId]
  );

  if (!multi)
    return (
      <div className="page">
        <h1>調貨</h1>
        <Empty>目前只有一個地點。老闆在「設定 → 門市與倉庫」新增第二家門市或倉庫後，就可以跨店查庫存、調貨。</Empty>
      </div>
    );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>調貨</h1>
          <div className="muted small">目前所在：{name(locationId ?? "")}</div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          新增調貨單
        </button>
      </div>
      <div className="segmented">
        <button className={tab === "todo" ? "active" : ""} onClick={() => setTab("todo")}>
          本店待處理
        </button>
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          全部
        </button>
      </div>
      {rows.length === 0 ? (
        <Empty>沒有調貨單</Empty>
      ) : (
        <div className="cards">
          {rows.map((t) => (
            <div key={t.id} className="card">
              <div className="row-between">
                <strong>
                  {name(t.from)} → {name(t.to)}
                </strong>
                {STATUS[t.status]}
              </div>
              <ul className="transfer-items">
                {t.items.map((i) => (
                  <li key={i.variantId}>
                    {i.title} × <strong>{i.qty}</strong>
                  </li>
                ))}
              </ul>
              {t.note && <div className="small">備註：{t.note}</div>}
              <div className="muted small">
                {t.requestedBy} 申請 {fmtTime(t.requestedAt)}
                {t.shippedAt && `　${t.shippedBy} 出貨 ${fmtTime(t.shippedAt)}`}
                {t.receivedAt && `　${t.receivedBy} 收貨 ${fmtTime(t.receivedAt)}`}
              </div>
              <div className="btn-row">
                {t.status === "requested" && t.from === locationId && (
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => call("shipTransfer", { id: t.id }), "已出貨，本店庫存已扣除")}>
                    確認出貨
                  </button>
                )}
                {t.status === "shipped" && t.to === locationId && (
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => call("receiveTransfer", { id: t.id }), "已收貨，本店庫存已增加")}>
                    確認收貨
                  </button>
                )}
                {(t.status === "requested" || t.status === "shipped") && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => confirm("取消這張調貨單？已出貨的會退回調出地點。") && run(() => call("cancelTransfer", { id: t.id }), "已取消")}>
                    取消
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && <CreateTransfer onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateTransfer({ onClose }: { onClose: () => void }) {
  const { variants, byId, locStock } = useData();
  const { locationId, locations } = useDeviceLocation();
  const [from, setFrom] = useState(locations.find((l) => l.id !== locationId)?.id ?? "");
  const [to, setTo] = useState(locationId ?? "");
  const [items, setItems] = useState<{ variantId: string; qty: number }[]>([]);
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const { busy, run } = useAction();
  const toast = useToast();
  const add = (vid: string) =>
    setItems((list) => {
      const i = list.findIndex((x) => x.variantId === vid);
      if (i >= 0) return list.map((x, k) => (k === i ? { ...x, qty: x.qty + 1 } : x));
      return [...list, { variantId: vid, qty: 1 }];
    });
  const results = q.trim() ? searchVariants(variants, q).slice(0, 20) : [];
  const fromQty = (vid: string) => locStock.get(vid)?.[from] ?? 0;

  return (
    <Modal
      title="新增調貨單"
      onClose={onClose}
      wide
      footer={
        <button className="btn btn-primary" disabled={busy || !items.length || !from || !to || from === to} onClick={() => run(() => call("requestTransfer", { from, to, items, note }), "已送出調貨申請").then(onClose)}>
          送出申請
        </button>
      }
    >
      <div className="grid-fields">
        <Field label="從（調出）">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="到（調入）">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ScanInput
        autoFocus={false}
        placeholder="掃描商品加入（每掃一次 +1）"
        continuousCamera
        onCode={async (code) => {
          const v = await resolveCode(code, byId);
          if (!v) {
            beep(false);
            toast(`找不到 ${code}`, "bad");
            return;
          }
          beep(true);
          add(v.id);
        }}
      />
      <input placeholder="或搜尋商品名稱" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.length > 0 && (
        <ul className="pick-list">
          {results.map((v) => (
            <li key={v.id}>
              <button onClick={() => (add(v.id), setQ(""))}>
                <span>{variantName(v)}</span>
                <small className="muted">調出地點有 {fromQty(v.id)} 件</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <table className="table table-compact">
        <tbody>
          {items.map((it) => {
            const v = byId.get(it.variantId);
            return (
              <tr key={it.variantId}>
                <td>{v ? variantName(v) : it.variantId}</td>
                <td className="num">
                  <span className={fromQty(it.variantId) < it.qty ? "error" : "muted"}>可調 {fromQty(it.variantId)}</span>
                </td>
                <td>
                  <input type="number" min={1} value={it.qty} onChange={(e) => setItems((l) => l.map((x) => (x.variantId === it.variantId ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x)))} style={{ width: 80 }} />
                </td>
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => setItems((l) => l.filter((x) => x.variantId !== it.variantId))}>
                    移除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <input placeholder="備註" value={note} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  );
}
