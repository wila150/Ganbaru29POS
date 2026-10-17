import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth";
import { ExchangeDialog } from "../../components/ExchangeDialog";
import { Badge, Empty, Modal, useAction, useToast } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { printReceipt } from "../../lib/receipt";
import { atLeast, fmtTime, money, newId, PAY_LABEL, PAY_NAME, todayStr } from "../../lib/util";
import type { PosOrder, Shopper } from "../../types";
import { MemberPicker } from "./Register";

const ORDER_BADGE: Record<PosOrder["status"], React.ReactNode> = {
  pending: <Badge tone="warn">處理中</Badge>,
  completed: <Badge tone="ok">完成</Badge>,
  canceled: <Badge>已取消</Badge>,
  partial: <Badge tone="warn">部分退貨</Badge>,
  refunded: <Badge tone="bad">已退貨</Badge>,
  void: <Badge tone="bad">作廢</Badge>,
};

// ---------- 交易瀏覽：查單、補印、作廢、退貨 ----------

export function Transactions() {
  const [date, setDate] = useState(todayStr());
  const [q, setQ] = useState("");
  const [list, setList] = useState<PosOrder[]>([]);
  const [open, setOpen] = useState<PosOrder | null>(null);

  useEffect(
    () =>
      onSnapshot(query(collection(db, "posOrders"), where("businessDate", "==", date), orderBy("createdAt", "desc"), limit(500)), (s) =>
        setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as PosOrder))
      ),
    [date]
  );
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((o) => !t || o.orderNo.toLowerCase().includes(t) || (o.shopper && `${o.shopper.name} ${o.shopper.mobile}`.toLowerCase().includes(t)) || o.lines.some((l) => l.productTitle.toLowerCase().includes(t)));
  }, [list, q]);
  const current = open ? list.find((o) => o.id === open.id) ?? open : null;
  const dayTotal = rows.filter((o) => !["canceled", "pending"].includes(o.status)).reduce((s, o) => s + o.total - (o.refunds ?? []).reduce((a, r) => a + r.amount, 0), 0);

  return (
    <div className="page">
      <h1>交易瀏覽</h1>
      <div className="filters">
        <input type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
        <input placeholder="單號、會員、商品" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted">
          {rows.length} 筆 · 淨額 {money(dayTotal)}
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>沒有交易</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>單號</th>
                <th>時間</th>
                <th>商品</th>
                <th>會員</th>
                <th>付款</th>
                <th className="num">金額</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} onClick={() => setOpen(o)}>
                  <td>{o.orderNo}</td>
                  <td>{fmtTime(o.createdAt, false)}</td>
                  <td className="ellipsis">
                    {o.lines.map((l) => l.productTitle).join("、")}（{o.itemCount} 件）
                  </td>
                  <td>{o.shopper ? o.shopper.name || o.shopper.mobile : "—"}</td>
                  <td>{o.payments.map((p) => PAY_NAME[p.method]).join("+")}</td>
                  <td className="num strong">{money(o.total)}</td>
                  <td>{ORDER_BADGE[o.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current && <OrderDetail order={current} onClose={() => setOpen(null)} />}
    </div>
  );
}

function OrderDetail({ order: o, onClose }: { order: PosOrder; onClose: () => void }) {
  const { settings } = useData();
  const { profile } = useAuth();
  const [refunding, setRefunding] = useState(false);
  const [exchanging, setExchanging] = useState(false);
  const { busy, run } = useAction();
  const canRefund = atLeast(profile?.role, "manager") || settings.staffCanRefund;
  const open = o.status === "completed" || o.status === "partial";

  return (
    <Modal
      title={`${o.orderNo}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={() => printReceipt(o, settings, { copy: true })}>
            補印收據
          </button>
          {open && canRefund && (
            <>
              <button className="btn" onClick={() => setExchanging(true)}>
                換貨
              </button>
              <button className="btn" onClick={() => setRefunding(true)}>
                退貨
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => {
                  const reason = prompt("作廢原因");
                  if (reason !== null) run(() => call("posVoid", { orderId: o.id, reason }), "已作廢，庫存已加回");
                }}
              >
                作廢
              </button>
            </>
          )}
        </>
      }
    >
      <div className="row-between">
        <span>
          {fmtTime(o.createdAt)} · {o.cashierName} {o.guests ? `· ${o.guests} 位` : ""}
        </span>
        {ORDER_BADGE[o.status]}
      </div>
      {o.shopper && (
        <p>
          會員：{o.shopper.name} {o.shopper.mobile} {o.rewardPoints > 0 && `· 折抵 ${o.rewardPoints} 點`} {o.rewardEarned > 0 && `· 回饋 ${o.rewardEarned} 點`}
        </p>
      )}
      <table className="table table-compact">
        <thead>
          <tr>
            <th>商品</th>
            <th className="num">單價</th>
            <th className="num">數量</th>
            <th className="num">小計</th>
          </tr>
        </thead>
        <tbody>
          {o.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.productTitle} {l.options}
                {l.discountPct > 0 && <span className="tag">-{l.discountPct}%</span>}
                {(l.promoLabels ?? []).map((n) => (
                  <span key={n} className="tag tag-promo">{n}</span>
                ))}
                {l.refundedQty > 0 && <Badge tone="bad">已退 {l.refundedQty}</Badge>}
              </td>
              <td className="num">{money(l.unitPrice)}</td>
              <td className="num">{l.qty}</td>
              <td className="num">{money(l.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="kv">
        {(o.promotions ?? []).map((p) => (
          <Fragment key={p.promoId}>
            <dt>🏷 {p.name}</dt>
            <dd>-{money(p.discount)}（已計入各品項）</dd>
          </Fragment>
        ))}
        <dt>小計</dt>
        <dd>{money(o.subtotal)}</dd>
        {(o.memberDiscount ?? 0) > 0 && (
          <>
            <dt>會員折扣 {o.memberTier} {o.memberDiscountPct}%</dt>
            <dd>-{money(o.memberDiscount)}</dd>
          </>
        )}
        {o.orderDiscount > 0 && (
          <>
            <dt>整單折扣 {o.orderDiscountPct}%</dt>
            <dd>-{money(o.orderDiscount)}</dd>
          </>
        )}
        {o.serviceFee > 0 && (
          <>
            <dt>服務費</dt>
            <dd>{money(o.serviceFee)}</dd>
          </>
        )}
        {o.allowance > 0 && (
          <>
            <dt>折讓</dt>
            <dd>-{money(o.allowance)}</dd>
          </>
        )}
        {o.rewardDiscount > 0 && (
          <>
            <dt>購物金</dt>
            <dd>-{money(o.rewardDiscount)}</dd>
          </>
        )}
        <dt>合計</dt>
        <dd className="strong">{money(o.total)}</dd>
        <dt>付款</dt>
        <dd>
          {o.payments.map((p) => `${PAY_NAME[p.method]} ${money(p.amount)}`).join("、")}
          {o.change > 0 && `（找零 ${money(o.change)}）`}
        </dd>
      </dl>
      {o.note && <p>備註：{o.note}</p>}
      {(o.refunds ?? []).length > 0 && (
        <>
          <h3>退貨紀錄</h3>
          <ul>
            {o.refunds.map((r) => (
              <li key={r.id}>
                {fmtTime(r.at)} {r.byName} {r.void ? "作廢" : "退貨"} {money(r.amount)}（{r.payments.map((p) => PAY_NAME[p.method]).join("+")}）
                {r.pointsReturned > 0 && ` · 退回購物金 ${r.pointsReturned} 點`}
                {r.reason && ` · ${r.reason}`}
              </li>
            ))}
          </ul>
        </>
      )}
      {o.refundNotes?.map((n, i) => (
        <p key={i} className="error small">
          {n}
        </p>
      ))}
      {refunding && <RefundDialog order={o} onClose={() => setRefunding(false)} />}
      {exchanging && (
        <ExchangeDialog
          title={`換貨：${o.orderNo}`}
          items={o.lines.map((l, i) => ({ key: String(i), title: `${l.productTitle} ${l.options}`.trim(), max: l.qty - l.refundedQty, unit: l.qty ? l.total / l.qty : 0 }))}
          request={(q) => ({ kind: "pos", orderId: o.id, lines: Object.entries(q).filter(([, n]) => n > 0).map(([i, n]) => ({ index: Number(i), qty: n })) })}
          onClose={() => setExchanging(false)}
        />
      )}
    </Modal>
  );
}

function RefundDialog({ order: o, onClose }: { order: PosOrder; onClose: () => void }) {
  const [qty, setQty] = useState<number[]>(o.lines.map(() => 0));
  const [method, setMethod] = useState("original");
  const [reason, setReason] = useState("");
  const [refundId] = useState(() => newId("r"));
  const { busy, run } = useAction();
  const toast = useToast();
  const gross = o.lines.reduce((s, l, i) => s + (l.total * qty[i]) / l.qty, 0);
  const estimate = o.subtotal ? Math.round((o.total * gross) / o.subtotal) : 0;

  return (
    <Modal
      title="退貨"
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          disabled={busy || !qty.some((n) => n > 0)}
          onClick={() =>
            run(async () => {
              const r = await call<{ amount: number; notes?: string[] }>("posRefund", { orderId: o.id, refundId, lines: qty.map((n, index) => ({ index, qty: n })), method, reason });
              toast(`已退貨，退款 ${money(r.amount)}，庫存已加回`, "ok");
              r.notes?.forEach((n) => toast(n, "bad"));
              onClose();
            })
          }
        >
          確認退貨
        </button>
      }
    >
      <table className="table table-compact">
        <tbody>
          {o.lines.map((l, i) => {
            const max = l.qty - l.refundedQty;
            return (
              <tr key={i}>
                <td>
                  {l.productTitle} {l.options}
                </td>
                <td className="num">可退 {max}</td>
                <td>
                  <div className="stepper">
                    <button onClick={() => setQty((q) => q.map((x, j) => (j === i ? Math.max(0, x - 1) : x)))}>−</button>
                    <input value={qty[i]} readOnly />
                    <button onClick={() => setQty((q) => q.map((x, j) => (j === i ? Math.min(max, x + 1) : x)))}>＋</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p>
        預估退款 <strong>{money(estimate)}</strong>（依整單折扣比例分攤）
      </p>
      <select value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="original">原付款方式</option>
        {Object.entries(PAY_LABEL).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <input placeholder="退貨原因" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}

// ---------- 會員：用手機查 meepShop 會員、現場新增、看消費紀錄 ----------

export function Members() {
  const [shopper, setShopper] = useState<Shopper | null>(null);
  const [picking, setPicking] = useState(true);
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const nav = useNavigate();

  useEffect(() => {
    if (!shopper) return setOrders([]);
    return onSnapshot(query(collection(db, "posOrders"), where("shopper.id", "==", shopper.id), orderBy("createdAt", "desc"), limit(50)), (s) =>
      setOrders(s.docs.map((d) => ({ id: d.id, ...d.data() }) as PosOrder))
    );
  }, [shopper]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>會員</h1>
        <button className="btn btn-primary" onClick={() => setPicking(true)}>
          查詢 / 新增會員
        </button>
      </div>
      {!shopper ? (
        <Empty>用手機號碼或 Email 查詢 meepShop 會員</Empty>
      ) : (
        <>
          <div className="card">
            <div className="row-between">
              <div>
                <h2>
                  {shopper.name || "(未填姓名)"} {shopper.tier && <Badge tone="info">{shopper.tier}</Badge>}
                  {shopper.birthMonth === todayStr().slice(5, 7) && <Badge tone="warn">🎂 本月壽星</Badge>}
                </h2>
                <div className="muted">
                  {shopper.mobile} · {shopper.email}
                </div>
                <div className="small">近 12 個月消費 {money(shopper.spend12m ?? 0)}（門市＋網店，每天凌晨更新）</div>
              </div>
              <div className="center">
                <div className="kpi-value">{shopper.points}</div>
                <small className="muted">可用購物金</small>
              </div>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => nav("/pos", { state: { shopper } })}>
                帶入收銀
              </button>
            </div>
          </div>
          <h2>門市消費紀錄</h2>
          {orders.length === 0 ? (
            <Empty>沒有門市消費紀錄（網店訂單請看 meepShop 後台）</Empty>
          ) : (
            <table className="table">
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{fmtTime(o.createdAt)}</td>
                    <td>{o.orderNo}</td>
                    <td className="ellipsis">{o.lines.map((l) => l.productTitle).join("、")}</td>
                    <td className="num">{money(o.total)}</td>
                    <td>{ORDER_BADGE[o.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {picking && <MemberPicker current={null} onClose={() => setPicking(false)} onPick={setShopper} />}
    </div>
  );
}
