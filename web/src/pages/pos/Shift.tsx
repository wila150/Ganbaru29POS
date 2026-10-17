import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, type Timestamp } from "firebase/firestore";
import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Empty, Field, useAction } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { totals, type CartDiscounts, type CartLine } from "../../lib/cart";
import { fmtTime, money, PAY_LABEL } from "../../lib/util";
import type { Shopper } from "../../types";
import { useCurrentShift } from "./PosLayout";

// ---------- 訂單（門市掛單：先下單後結帳） ----------

interface Hold {
  id: string;
  label: string;
  cart: CartLine[];
  shopper: Shopper | null;
  note: string;
  guests: number;
  discounts: CartDiscounts;
  byName: string;
  at: Timestamp | null;
}

export function Holds() {
  const [list, setList] = useState<Hold[]>([]);
  const { settings } = useData();
  const nav = useNavigate();
  useEffect(() => onSnapshot(query(collection(db, "posHolds"), orderBy("at", "desc")), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Hold))), []);
  return (
    <div className="page">
      <h1>訂單（掛單）</h1>
      {list.length === 0 ? (
        <Empty>沒有掛單。在收銀畫面按「掛單」可先存起來，之後再結帳。</Empty>
      ) : (
        <div className="cards">
          {list.map((h) => {
            const t = totals(h.cart, h.discounts, settings.pointValue ?? 1);
            return (
              <div key={h.id} className="card">
                <div className="row-between">
                  <strong>{h.label}</strong>
                  <span className="strong">{money(t.total)}</span>
                </div>
                <div className="muted small">
                  {t.items} 件 · {h.guests} 位 {h.shopper && `· 會員 ${h.shopper.name || h.shopper.mobile}`} · {h.byName} {fmtTime(h.at)}
                </div>
                {h.note && <div className="small">{h.note}</div>}
                <div className="btn-row">
                  <button className="btn btn-primary" onClick={() => nav("/pos", { state: { holdId: h.id, cart: h.cart, shopper: h.shopper, note: h.note, guests: h.guests, discounts: h.discounts } })}>
                    取回結帳
                  </button>
                  <button className="btn btn-ghost" onClick={() => confirm(`刪除掛單「${h.label}」？`) && deleteDoc(doc(db, "posHolds", h.id))}>
                    刪除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- 線上訂單（meepShop 網店訂單） ----------

const SHIP_LABEL: Record<string, string> = {
  PROCESSING: "未出貨",
  PREPARING: "備貨中",
  OUT_OF_STOCK: "缺貨",
  FULFILLED: "已出貨",
  PRE_ORDER: "預購",
  EXCHANGE: "換貨",
  RETURN: "退貨",
  DATA_ERROR: "資料錯誤",
  PARTIALLY_SHIPPED: "部分出貨",
  ARRIVE_IN_STORE: "已到店",
  PICKUP_IN_STORE: "已取貨",
  RETURN_IN_STORE: "門市退貨",
};
const UPDATABLE = ["PROCESSING", "PREPARING", "OUT_OF_STOCK", "FULFILLED", "PRE_ORDER"];
const ORDER_STATUS: Record<string, string> = { PROCESSING: "處理中", CLOSED: "已結案", CANCELED: "已取消", RETURN: "退貨" };

interface MOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  shipmentStatus: string;
  totalPrice: number;
  createdAt: string;
  shopper: { name: string | null; email: string } | null;
  shipmentDetail: { name: string; phone: string | null; receiverName: string | null; note: string | null };
  paymentDetail: { name: string };
  lineItems: { id: string; title: string; quantity: number; totalPrice: number }[] | null;
}

export function OnlineOrders() {
  const [days, setDays] = useState(14);
  const [ship, setShip] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [orders, setOrders] = useState<MOrder[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAction();

  const load = (after: string | null = null) =>
    run(async () => {
      const r = await call<{ total: number; next: string | null; orders: MOrder[] }>("listOnlineOrders", { days, shipmentStatus: ship || undefined, orderNumber: orderNumber || undefined, after });
      setOrders((o) => (after ? [...o, ...r.orders] : r.orders));
      setNext(r.next);
      setTotal(r.total);
    });

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, ship]);

  const setStatus = (o: MOrder, status: string) =>
    run(async () => {
      await call("updateShipment", { orderNumber: o.orderNumber, status });
      setOrders((list) => list.map((x) => (x.id === o.id ? { ...x, shipmentStatus: status } : x)));
    }, "已更新出貨狀態");

  return (
    <div className="page">
      <h1>線上訂單</h1>
      <div className="filters">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={3}>近 3 天</option>
          <option value={14}>近 14 天</option>
          <option value={60}>近 60 天</option>
        </select>
        <select value={ship} onChange={(e) => setShip(e.target.value)}>
          <option value="">全部出貨狀態</option>
          {Object.entries(SHIP_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <input placeholder="訂單編號" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
        <button className="btn" disabled={busy} onClick={() => load()}>
          查詢
        </button>
      </div>
      <p className="muted small">共 {total} 筆。網路訂單由 meepShop 自己扣庫存，這裡只看訂單、處理門市取貨與出貨狀態。</p>
      {orders.length === 0 && !busy ? (
        <Empty>沒有訂單</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>訂單編號</th>
                <th>時間</th>
                <th>顧客</th>
                <th className="num">金額</th>
                <th>付款</th>
                <th>出貨狀態</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <Fragment key={o.id}>
                  <tr onClick={() => setOpen(open === o.id ? null : o.id)}>
                    <td>
                      {o.orderNumber} {o.status !== "PROCESSING" && <Badge>{ORDER_STATUS[o.status] ?? o.status}</Badge>}
                    </td>
                    <td>{fmtTime(new Date(o.createdAt))}</td>
                    <td>{o.shipmentDetail.receiverName || o.shopper?.name || o.shipmentDetail.name}</td>
                    <td className="num">{money(o.totalPrice)}</td>
                    <td>{o.paymentDetail.name}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {UPDATABLE.includes(o.shipmentStatus) && o.status === "PROCESSING" ? (
                        <select value={o.shipmentStatus} disabled={busy} onChange={(e) => setStatus(o, e.target.value)}>
                          {UPDATABLE.map((s) => (
                            <option key={s} value={s}>
                              {SHIP_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        SHIP_LABEL[o.shipmentStatus] ?? o.shipmentStatus
                      )}
                    </td>
                  </tr>
                  {open === o.id && (
                    <tr className="row-detail">
                      <td colSpan={6}>
                        <div>
                          {o.shipmentDetail.name} · {o.shipmentDetail.phone} {o.shipmentDetail.note && `· 備註：${o.shipmentDetail.note}`}
                        </div>
                        <ul>
                          {(o.lineItems ?? []).map((li) => (
                            <li key={li.id}>
                              {li.title} × {li.quantity}　{money(li.totalPrice)}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button className="btn block" disabled={busy} onClick={() => load(next)}>
          載入更多
        </button>
      )}
    </div>
  );
}

// ---------- 錢櫃（開班零用金、中途存提款） ----------

interface ShiftDoc {
  id: string;
  name: string;
  businessDate: string;
  float: number;
  cashMoves: { id: string; type: "in" | "out"; amount: number; note: string | null; by: string; at: Timestamp }[];
  openedByName: string;
  openedAt: Timestamp | null;
}

export function Drawer() {
  const shift = useCurrentShift();
  const { settings } = useData();
  const names = settings.shiftNames?.length ? settings.shiftNames : ["早班", "晚班"];
  const [name, setName] = useState(names[0]);
  const [float, setFloat] = useState("");
  const [full, setFull] = useState<ShiftDoc | null>(null);
  const [type, setType] = useState<"in" | "out">("out");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const { busy, run } = useAction();

  useEffect(() => {
    if (!shift) return setFull(null);
    return onSnapshot(doc(db, "shifts", shift.id), (s) => setFull({ id: s.id, ...s.data() } as ShiftDoc));
  }, [shift]);

  if (shift === undefined) return <div className="page loading">載入中…</div>;
  if (!shift)
    return (
      <div className="page narrow">
        <h1>開班</h1>
        <div className="card">
          <Field label="班別">
            <select value={name} onChange={(e) => setName(e.target.value)}>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </Field>
          <Field label="開班零用金（錢櫃裡的現金）">
            <input type="number" min={0} inputMode="numeric" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="0" />
          </Field>
          <button className="btn btn-primary btn-lg block" disabled={busy} onClick={() => run(() => call("openShift", { name, float: Number(float) || 0 }), "已開班")}>
            開班
          </button>
        </div>
      </div>
    );

  return (
    <div className="page narrow">
      <h1>錢櫃 · {shift.name}</h1>
      <div className="card">
        <dl className="kv">
          <dt>營業日</dt>
          <dd>{shift.businessDate}</dd>
          <dt>開班</dt>
          <dd>
            {full?.openedByName} {fmtTime(full?.openedAt)}
          </dd>
          <dt>零用金</dt>
          <dd>{money(shift.float)}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>存提款</h2>
        <div className="segmented">
          <button className={type === "out" ? "active" : ""} onClick={() => setType("out")}>
            提款（拿出現金）
          </button>
          <button className={type === "in" ? "active" : ""} onClick={() => setType("in")}>
            存款（放入現金）
          </button>
        </div>
        <div className="inline-form">
          <input type="number" min={1} placeholder="金額" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input placeholder="說明（例如：付貨款、換零錢）" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            className="btn btn-primary"
            disabled={busy || !(Number(amount) > 0)}
            onClick={() =>
              run(() => call("cashMove", { type, amount: Number(amount), note }), "已記錄").then(() => {
                setAmount("");
                setNote("");
              })
            }
          >
            記錄
          </button>
        </div>
        {(full?.cashMoves ?? []).length > 0 && (
          <table className="table table-compact">
            <tbody>
              {[...(full?.cashMoves ?? [])].reverse().map((m) => (
                <tr key={m.id}>
                  <td>{fmtTime(m.at, false)}</td>
                  <td>{m.type === "in" ? "存入" : "提出"}</td>
                  <td className={`num ${m.type === "in" ? "plus" : "minus"}`}>{m.type === "in" ? "+" : "−"}{money(m.amount)}</td>
                  <td>{m.note}</td>
                  <td className="muted">{m.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------- 日結（各付款方式小計、現金點收、交班） ----------

interface Summary {
  shift: { id: string; name: string; businessDate: string; float: number; openedByName: string; openedAt: number | null };
  orders: number;
  total: number;
  refundTotal: number;
  rewardPoints: number;
  byMethod: Record<string, { sales: number; refunds: number }>;
  ins: number;
  outs: number;
  expectedCash: number;
}
const DENOMS = [1000, 500, 100, 50, 10, 5, 1];

export function DayClose() {
  const shift = useCurrentShift();
  const [sum, setSum] = useState<Summary | null>(null);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ expectedCash: number; countedCash: number; diff: number } | null>(null);
  const [history, setHistory] = useState<(ShiftDoc & { closedByName: string; closedAt: Timestamp; countedCash: number; expectedCash: number; cashDiff: number; summary: { total: number; orders: number } })[]>([]);
  const { busy, run } = useAction();

  useEffect(() => {
    if (shift) call<Summary>("shiftSummary").then(setSum).catch(() => setSum(null));
  }, [shift]);
  useEffect(
    () =>
      onSnapshot(query(collection(db, "shifts"), orderBy("openedAt", "desc"), limit(10)), (s) =>
        setHistory(s.docs.map((d) => ({ id: d.id, ...d.data() }) as never).filter((x: { status?: string }) => x.status === "closed"))
      ),
    []
  );

  const counted = DENOMS.reduce((s, d) => s + d * (Number(counts[d]) || 0), 0);

  return (
    <div className="page">
      <h1>日結交班</h1>
      {result && (
        <div className={`notice ${result.diff === 0 ? "" : "notice-warn"}`}>
          已交班。應有現金 {money(result.expectedCash)}，實點 {money(result.countedCash)}，差額 {result.diff > 0 ? "+" : ""}
          {money(result.diff)}
        </div>
      )}
      {!shift && !result && <Empty>目前沒有開班。</Empty>}
      {shift && sum && (
        <div className="close-grid">
          <div className="card">
            <h2>
              {sum.shift.name} · {sum.shift.businessDate}
            </h2>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>付款方式</th>
                  <th className="num">銷售</th>
                  <th className="num">退款</th>
                  <th className="num">淨額</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(sum.byMethod).map(([k, v]) => (
                  <tr key={k}>
                    <td>{PAY_LABEL[k]}</td>
                    <td className="num">{money(v.sales)}</td>
                    <td className="num">{v.refunds ? `-${money(v.refunds)}` : "—"}</td>
                    <td className="num strong">{money(v.sales - v.refunds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="kv">
              <dt>交易筆數</dt>
              <dd>{sum.orders}</dd>
              <dt>營業額</dt>
              <dd>{money(sum.total)}</dd>
              <dt>退款</dt>
              <dd>{money(sum.refundTotal)}</dd>
              <dt>購物金折抵</dt>
              <dd>{sum.rewardPoints} 點</dd>
              <dt>零用金</dt>
              <dd>{money(sum.shift.float)}</dd>
              <dt>存入 / 提出</dt>
              <dd>
                +{money(sum.ins)} / −{money(sum.outs)}
              </dd>
              <dt>應有現金</dt>
              <dd className="strong big">{money(sum.expectedCash)}</dd>
            </dl>
          </div>
          <div className="card">
            <h2>現金點收</h2>
            <table className="table table-compact">
              <tbody>
                {DENOMS.map((d) => (
                  <tr key={d}>
                    <td>{d} 元</td>
                    <td>
                      <input type="number" min={0} inputMode="numeric" value={counts[d] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))} style={{ width: 90 }} />
                    </td>
                    <td className="num">{money(d * (Number(counts[d]) || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row-between big">
              <span>實點 {money(counted)}</span>
              <span className={counted - sum.expectedCash === 0 ? "ok" : "error"}>
                差額 {counted - sum.expectedCash > 0 ? "+" : ""}
                {money(counted - sum.expectedCash)}
              </span>
            </div>
            <input placeholder="備註（差額原因）" value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              className="btn btn-primary btn-lg block"
              disabled={busy}
              onClick={() => confirm(`確定交班？實點現金 ${money(counted)}`) && run(async () => setResult(await call("closeShift", { countedCash: counted, note })), "已交班")}
            >
              日結交班
            </button>
          </div>
        </div>
      )}
      <section>
        <h2>最近交班紀錄</h2>
        {history.length === 0 ? (
          <Empty>沒有紀錄</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>營業日</th>
                  <th>班別</th>
                  <th className="num">筆數</th>
                  <th className="num">營業額</th>
                  <th className="num">應有現金</th>
                  <th className="num">實點</th>
                  <th className="num">差額</th>
                  <th>交班</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.businessDate}</td>
                    <td>{h.name}</td>
                    <td className="num">{h.summary?.orders}</td>
                    <td className="num">{money(h.summary?.total)}</td>
                    <td className="num">{money(h.expectedCash)}</td>
                    <td className="num">{money(h.countedCash)}</td>
                    <td className={`num ${h.cashDiff ? "error" : ""}`}>{money(h.cashDiff)}</td>
                    <td>
                      {h.closedByName} {fmtTime(h.closedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
