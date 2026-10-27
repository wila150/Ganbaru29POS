import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
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
import { InvoiceInfo } from "./Checkout";
import { getDeviceLocationId } from "../../lib/location";
import { MemberCardDialog } from "../../components/MemberCardDialog";
import { MemberList } from "../../components/MemberList";
import { MemberTagEditor, ShopperGroup, TagChips, useShopperPrefs } from "../../components/MemberTags";
import { MemberPicker } from "./Register";

interface OnlineOrder {
  id: string;
  orderNumber: string;
  createdAt: string;
  status: string;
  total: number;
  pointsUsed: number;
  items: string[];
}
const ONLINE_STATUS: Record<string, string> = { PROCESSING: "處理中", CLOSED: "已結案", CANCELED: "已取消", RETURN: "退貨" };

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
  const [editing, setEditing] = useState(false);
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
          {o.status !== "void" && o.status !== "canceled" && o.status !== "pending" && (
            <button className="btn" onClick={() => setEditing(true)}>
              編輯
            </button>
          )}
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
                  if (reason !== null) run(() => call("posVoid", { orderId: o.id, reason, locationId: getDeviceLocationId() }), "已作廢，庫存已加回");
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
                {l.note && <div className="small muted">📝 {l.note}</div>}
                {l.replacedFrom && <div className="small muted">（原本是 {l.replacedFrom.productTitle} {l.replacedFrom.options}）</div>}
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
      {(o.edits ?? []).length > 0 && (
        <details className="edit-log">
          <summary>修改紀錄（{o.edits!.length}）</summary>
          {o.edits!.map((e, i) => (
            <div key={i} className="small">
              {fmtTime(e.at as never)} {e.by}：{e.changes.join("；")}
            </div>
          ))}
        </details>
      )}
      {editing && <EditOrder order={o} onClose={() => setEditing(false)} />}
      <InvoiceInfo order={o} />
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
              const r = await call<{ amount: number; notes?: string[] }>("posRefund", { orderId: o.id, refundId, lines: qty.map((n, index) => ({ index, qty: n })), method, reason, locationId: getDeviceLocationId() });
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

function ShopperTagLine({ id }: { id: string }) {
  const { tags, pref, likes } = useShopperPrefs(id);
  return (
    <>
      {tags.length ? <TagChips tags={tags} /> : <span className="muted">沒有標籤</span>}
      {pref && <div className="member-pref">💬 喜好：{pref}</div>}
      {likes.length > 0 && <div className="member-pref">❤️ 客人自選（LINE）：{likes.join("、")}</div>}
      <LineBound id={id} />
    </>
  );
}

/** LINE 綁定狀態；店長以上可以解除（客人換 LINE 帳號、或要測試加入會員流程時） */
function LineBound({ id }: { id: string }) {
  const { profile } = useAuth();
  const [bound, setBound] = useState<{ on: boolean; via?: string; todo?: string } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => onSnapshot(doc(db, "shoppers", id), (d) => setBound({ todo: d.data()?.meepGroupTodo ?? undefined, on: !!d.data()?.lineUserId, via: d.data()?.joinedVia === "line" ? "從 LINE 加入" : d.data()?.lineBoundVia === "chat" ? "聊天室綁定" : undefined })), [id]);
  if (!bound) return null;
  return (
    <>
    {bound.todo && (
      <div className="notice notice-warn small">
        ⚠️ 這位會員已在門市升級為「{bound.todo}」，下次在門市消費開始享優惠。官網群組 meepShop 不能用程式改，請到 meepShop 後台把他的顧客群組改成「{bound.todo}」。
        {atLeast(profile?.role, "manager") && (
          <button className="btn btn-sm" disabled={busy} onClick={() => run(() => call("clearMeepGroupTodo", { id }), "已標記")}>
            已在 meepShop 改好
          </button>
        )}
      </div>
    )}
    <div className="member-pref">
      💬 LINE 官方帳號：{bound.on ? `已綁定${bound.via ? `（${bound.via}）` : ""}` : "未綁定"}
      {bound.on && atLeast(profile?.role, "manager") && (
        <button className="link-btn small" disabled={busy} onClick={() => confirm("解除這位會員的 LINE 綁定？（客人要重新在 LINE 綁定才能用會員卡）") && run(() => call("lineUnbindMember", { shopperId: id }), "已解除 LINE 綁定")}>
          　解除綁定
        </button>
      )}
    </div>
    </>
  );
}

export function Members() {
  const [shopper, setShopper] = useState<Shopper | null>(null);
  const [picking, setPicking] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [tagEdit, setTagEdit] = useState(false);
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [online, setOnline] = useState<OnlineOrder[] | null>(null);
  const [onlineErr, setOnlineErr] = useState<string | null>(null);
  const [src, setSrc] = useState<"all" | "store" | "online">("all");
  const nav = useNavigate();
  useEffect(() => {
    setOnline(null);
    setOnlineErr(null);
    if (!shopper) return;
    let alive = true;
    call<{ orders: OnlineOrder[] }>("shopperOnlineOrders", { id: shopper.id })
      .then((r) => alive && setOnline(r.orders))
      .catch((e) => alive && setOnlineErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [shopper?.id]);

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
        <MemberList
          onPick={(s) => {
            setShopper(s);
            // 名單上的購物金是快取，點進來再向 meepShop 查即時餘額
            if (s.email)
              call<{ shoppers: Shopper[] }>("searchShopper", { q: s.email })
                .then((r) => {
                  const live = r.shoppers.find((x) => x.id === s.id);
                  if (live) setShopper((cur) => (cur?.id === s.id ? { ...cur, ...live } : cur));
                })
                .catch(() => undefined);
          }}
        />
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
                <div className="small">
                  群組 <ShopperGroup shopperId={shopper.id} />　<ShopperTagLine id={shopper.id} />
                </div>
                <div className="small">近 12 個月消費 {money(shopper.spend12m ?? 0)}（門市＋網店「已結案」訂單；網店處理中的訂單結案後才計入）</div>
              </div>
              <div className="center">
                <div className="kpi-value">{shopper.points}</div>
                <small className="muted">可用購物金</small>
              </div>
            </div>
            <div className="btn-row">
              <button className="btn" onClick={() => setShopper(null)}>
                ← 回顧客名單
              </button>
              <button className="btn btn-primary" onClick={() => nav("/pos", { state: { shopper } })}>
                帶入收銀
              </button>
              <button className="btn" onClick={() => setShowCard(true)}>
                會員卡／會員條碼
              </button>
              <button className="btn" onClick={() => setTagEdit(true)}>
                標籤／喜好
              </button>
            </div>
          </div>
          <div className="row-between">
            <h2>消費紀錄</h2>
            <div className="chips">
              {(
                [
                  ["all", `全部 ${orders.length + (online?.length ?? 0)}`],
                  ["store", `門市 ${orders.length}`],
                  ["online", `網店 ${online?.length ?? "…"}`],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`chip ${src === k ? "active" : ""}`} onClick={() => setSrc(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {onlineErr && src !== "store" && <p className="notice notice-warn">網店訂單讀取失敗：{onlineErr}</p>}
          {(() => {
            type Row = { key: string; src: "store" | "online"; at: number; no: string; items: string; total: number; earned: number; used: number; back: number; status: React.ReactNode };
            const rows: Row[] = [
              ...(src === "online"
                ? []
                : orders.map((o) => ({
                    key: o.id,
                    src: "store" as const,
                    at: o.createdAt?.toMillis?.() ?? 0,
                    no: o.orderNo,
                    items: o.lines.map((l) => l.productTitle).join("、"),
                    total: o.total,
                    earned: o.rewardEarned ?? 0,
                    used: o.rewardPoints ?? 0,
                    back: (o.refunds ?? []).reduce((s2, r) => s2 + (r.pointsReclaimed ?? 0), 0),
                    status: ORDER_BADGE[o.status],
                  }))),
              ...(src === "store"
                ? []
                : (online ?? []).map((o) => ({
                    key: o.id,
                    src: "online" as const,
                    at: new Date(o.createdAt).getTime(),
                    no: o.orderNumber,
                    items: o.items.join("、"),
                    total: o.total,
                    earned: 0,
                    used: o.pointsUsed,
                    back: 0,
                    status: <Badge tone={o.status === "CLOSED" ? "ok" : o.status === "PROCESSING" ? "warn" : o.status === "CANCELED" ? "mute" : "bad"}>{ONLINE_STATUS[o.status] ?? o.status}</Badge>,
                  }))),
            ].sort((a, b) => b.at - a.at);
            if (src !== "store" && online === null && !onlineErr && rows.length === 0) return <p className="muted">讀取網店訂單中…</p>;
            if (!rows.length) return <Empty>{src === "online" ? "沒有網店訂單" : src === "store" ? "沒有門市消費紀錄" : "沒有消費紀錄"}</Empty>;
            return (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>時間</th>
                      <th>來源</th>
                      <th>單號</th>
                      <th>商品</th>
                      <th className="num">金額</th>
                      <th className="num">購物金</th>
                      <th>狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td>{new Date(r.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</td>
                        <td>{r.src === "store" ? <Badge>門市</Badge> : <Badge tone="info">網店</Badge>}</td>
                        <td>{r.no}</td>
                        <td className="ellipsis">{r.items}</td>
                        <td className="num">{money(r.total)}</td>
                        <td className="num points-cell">
                          {r.earned > 0 && <span className="ok">+{r.earned}</span>}
                          {r.used > 0 && <span className="error">−{r.used}</span>}
                          {r.back > 0 && <span className="muted small">退貨收回 {r.back}</span>}
                          {!r.earned && !r.used && <span className="muted">—</span>}
                        </td>
                        <td>{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted small">購物金：＋ 本單回饋　− 本單折抵使用。網店訂單的回饋由 meepShop 發送，這裡只顯示使用的購物金；網店最多顯示最近 50 筆。</p>
              </>
            );
          })()}
        </>
      )}
      {tagEdit && shopper && <MemberTagEditor shopperId={shopper.id} name={shopper.name || shopper.mobile} onClose={() => setTagEdit(false)} />}
      {showCard && shopper && <MemberCardDialog shopperId={shopper.id} name={shopper.name || shopper.mobile} onClose={() => setShowCard(false)} />}
      {picking && <MemberPicker current={null} onClose={() => setPicking(false)} onPick={setShopper} />}
    </div>
  );
}

/**
 * 編輯已完成的單：備註、更換商品（例：先用「新品」結帳，上架後換成真正的商品，價格不變、庫存一加一減）、
 * 更正付款方式（店長以上、該班還沒結班）。商品數量、金額要改請用退貨／換貨。
 */
function EditOrder({ order: o, onClose }: { order: PosOrder; onClose: () => void }) {
  const { profile } = useAuth();
  const { variants, byId } = useData();
  const isManager = atLeast(profile?.role, "manager");
  const [note, setNote] = useState(o.note ?? "");
  const [lineNotes, setLineNotes] = useState(o.lines.map((l) => l.note ?? ""));
  const [replace, setReplace] = useState<Record<number, string>>({});
  const [picking, setPicking] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [shiftOpen, setShiftOpen] = useState<boolean | null>(null);
  const manualPays = !(o.payments as { method: string; amount: number; ref?: string }[]).some((p) => p.ref || p.method === "exchange" || p.method === "ecpay" || p.method === "newebpay");
  const [pays, setPays] = useState(o.payments.map((p) => ({ method: p.method, amount: String(p.amount) })));
  const [editPay, setEditPay] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    if (!o.shiftId) return setShiftOpen(false);
    getDoc(doc(db, "shifts", o.shiftId))
      .then((d) => setShiftOpen(d.data()?.status !== "closed"))
      .catch(() => setShiftOpen(false));
  }, [o.shiftId]);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return variants.filter((v) => `${v.productTitle} ${v.options} ${v.sku ?? ""}`.toLowerCase().includes(t)).slice(0, 30);
  }, [q, variants]);
  const paid = pays.reduce((a, p) => a + (Number(p.amount) || 0), 0);

  const save = () =>
    run(async () => {
      const payload: Record<string, unknown> = { orderId: o.id, note, lineNotes: lineNotes.map((n, index) => ({ index, note: n })) };
      const rep = Object.entries(replace).map(([index, variantId]) => ({ index: Number(index), variantId }));
      if (rep.length) payload.replace = rep;
      if (editPay) payload.payments = pays.map((p) => ({ method: p.method, amount: Number(p.amount) || 0 }));
      const r = await call<{ changes: string[] }>("posEditOrder", payload);
      toast(r.changes.length ? `已修改 ${r.changes.length} 項` : "沒有變更", r.changes.length ? "ok" : "info");
      onClose();
    });

  return (
    <Modal
      title={`編輯 ${o.orderNo}`}
      onClose={onClose}
      wide
      footer={
        <button className="btn btn-primary" disabled={busy || (editPay && paid < o.total)} onClick={save}>
          {busy ? "儲存中…" : "儲存"}
        </button>
      }
    >
      <p className="muted small">可以改備註、把商品換成正確的商品（金額不變，庫存自動調整）、更正付款方式。要改數量或金額請用「退貨／換貨」。</p>
      <h3>商品</h3>
      {o.lines.map((l, i) => {
        const to = replace[i] ? byId.get(replace[i]) : null;
        return (
          <div key={i} className="edit-line">
            <div className="row-between">
              <div>
                <strong>
                  {to ? (
                    <>
                      <s className="muted">
                        {l.productTitle} {l.options}
                      </s>{" "}
                      → {to.productTitle} {to.options}
                    </>
                  ) : (
                    `${l.productTitle} ${l.options}`
                  )}
                </strong>
                <span className="muted small">
                  　× {l.qty}　{money(l.total)}
                </span>
              </div>
              {!l.refundedQty && (
                <button className="btn btn-sm" onClick={() => (setPicking(i), setQ(""))}>
                  {to ? "重選" : "更換商品"}
                </button>
              )}
            </div>
            <input placeholder="這一項的備註" value={lineNotes[i]} maxLength={100} onChange={(e) => setLineNotes((x) => x.map((n, j) => (j === i ? e.target.value : n)))} />
          </div>
        );
      })}
      <h3>整單備註</h3>
      <textarea rows={2} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      <h3>付款方式</h3>
      {!isManager ? (
        <p className="muted small">更正付款方式限店長以上。</p>
      ) : !manualPays ? (
        <p className="muted small">線上付款、換貨抵用的單不能改付款方式。</p>
      ) : shiftOpen === false ? (
        <p className="muted small">這一班已經結班，現金已點收，不能再改付款方式。</p>
      ) : !editPay ? (
        <button className="btn btn-sm" onClick={() => setEditPay(true)}>
          更正付款方式（目前：{o.payments.map((p) => `${PAY_NAME[p.method]} ${money(p.amount)}`).join("、")}）
        </button>
      ) : (
        <div>
          {pays.map((p, i) => (
            <div key={i} className="inline-form">
              <select value={p.method} onChange={(e) => setPays((x) => x.map((y, j) => (j === i ? { ...y, method: e.target.value as typeof p.method } : y)))}>
                {Object.entries(PAY_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <input inputMode="numeric" value={p.amount} onChange={(e) => setPays((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value.replace(/\D/g, "") } : y)))} />
              {pays.length > 1 && (
                <button className="btn-icon danger" onClick={() => setPays((x) => x.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button className="link-btn small" onClick={() => setPays((x) => [...x, { method: "card", amount: "0" }])}>
            ＋ 再加一種付款
          </button>
          <p className={`small ${paid < o.total ? "error" : "muted"}`}>
            應收 {money(o.total)}，付款合計 {money(paid)}
            {paid > o.total && `（找零 ${money(paid - o.total)}，只有現金可以找零）`}
          </p>
        </div>
      )}
      {picking !== null && (
        <Modal title={`把「${o.lines[picking].productTitle}」換成…`} onClose={() => setPicking(null)}>
          <input autoFocus placeholder="搜尋商品名稱、編號" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="pick-list">
            {results.map((v) => (
              <li key={v.id}>
                <button
                  className="pick-row"
                  onClick={() => {
                    setReplace((x) => ({ ...x, [picking]: v.id }));
                    setPicking(null);
                  }}
                >
                  {v.thumbUrl || v.imageUrl ? <img src={v.thumbUrl || v.imageUrl!} alt="" className="thumb-sm" /> : null}
                  <span>
                    {v.productTitle} {v.options}
                  </span>
                  <span className="muted small">
                    {money(v.price ?? 0)}・庫存 {v.shopStock ?? 0}
                  </span>
                </button>
              </li>
            ))}
            {q && results.length === 0 && <li className="muted">找不到商品（新商品上架後約 15 分鐘會同步過來）</li>}
          </ul>
          <p className="muted small">金額維持原本結帳的金額；庫存會把原商品加回、新商品扣掉，並同步到網店。</p>
        </Modal>
      )}
    </Modal>
  );
}
