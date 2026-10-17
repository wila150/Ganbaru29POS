import { collection, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth";
import { Keypad, KeypadDialog } from "../../components/Keypad";
import { ScanInput } from "../../components/ScanInput";
import { Modal, useAction, useToast } from "../../components/ui";
import { OtherLocations } from "../../components/OtherLocations";
import { VariantMatrix } from "../../components/VariantMatrix";
import { useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { cartPromos, lineTotal, totals, type CartDiscounts, type CartLine } from "../../lib/cart";
import { resolveCode, searchVariants } from "../../lib/lookup";
import { beep, deviceId, money, newId, PAY_LABEL, todayStr } from "../../lib/util";
import type { ExchangeQuote, PosOrder, Shopper, Variant } from "../../types";
import { useDeviceLocation } from "../../lib/location";
import { Checkout, Done } from "./Checkout";
import { useCurrentShift } from "./PosLayout";

export interface HoldState {
  holdId?: string;
  cart?: CartLine[];
  shopper?: Shopper | null;
  note?: string;
  guests?: number;
  discounts?: CartDiscounts;
  exchange?: ExchangeQuote | null;
}

const DRAFT_KEY = "g29.posDraft";
const emptyDiscounts = (serviceFeePct = 0): CartDiscounts => ({ serviceFeePct, orderDiscountPct: 0, allowance: 0, rewardPoints: 0 });

export function Register() {
  const { variants, byId, settings, promotions, locStock } = useData();
  const { multi, locationId } = useDeviceLocation();
  const { user, profile } = useAuth();
  const shift = useCurrentShift();
  const toast = useToast();
  const nav = useNavigate();
  const incoming = useLocation().state as HoldState | null;

  // Restore an unsaved cart after a reload so a crash never loses a sale in progress.
  const draft = useMemo<HoldState>(() => {
    if (incoming) return incoming;
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    } catch {
      return {};
    }
  }, [incoming]);
  const [cart, setCart] = useState<CartLine[]>(draft.cart ?? []);
  const [shopper, setShopper] = useState<Shopper | null>(draft.shopper ?? null);
  const [note, setNote] = useState(draft.note ?? "");
  const [guests, setGuests] = useState(draft.guests ?? 1);
  const [disc, setDisc] = useState<CartDiscounts>(draft.discounts ?? emptyDiscounts(settings.serviceFeeDefault ?? 0));
  const [holdId, setHoldId] = useState<string | undefined>(draft.holdId);
  const [exchange, setExchange] = useState<ExchangeQuote | null>(draft.exchange ?? null);
  const [refundMethod, setRefundMethod] = useState("cash");
  const [coupons, setCoupons] = useState<{ code: string; promoId: string; promoName: string }[]>([]);
  const [cat, setCat] = useState<string>("全部");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Variant[] | null>(null);
  const [editLine, setEditLine] = useState<CartLine | null>(null);
  const [keypad, setKeypad] = useState<null | { key: keyof CartDiscounts | "guests"; title: string; suffix?: string; hint?: string }>(null);
  const [memberOpen, setMemberOpen] = useState(false);
  const [checkout, setCheckout] = useState(false);
  // One id per checkout attempt, reused on retry, so a dropped connection never records the sale twice.
  const orderId = useRef<string>(newId("o"));
  useEffect(() => {
    orderId.current = newId("o"); // the cart changed → it is a different sale
  }, [cart, disc, shopper, exchange, coupons]);
  const [done, setDone] = useState<{ order: PosOrder; issues: { title: string; status: string; error: string | null }[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ cart, shopper, note, guests, discounts: disc, holdId, exchange }));
    } catch {
      /* ignore */
    }
  }, [cart, shopper, note, guests, disc, holdId, exchange]);
  useEffect(() => {
    if (incoming) nav(".", { replace: true, state: null });
  }, [incoming, nav]);

  const pointValue = settings.pointValue ?? 1;
  const promo = useMemo(() => cartPromos(cart, byId, promotions, shopper, coupons.map((c) => c.promoId)), [cart, byId, promotions, shopper, coupons]);

  /** 會員條碼（M + 9 碼）→ 帶入會員 */
  const scanMember = async (code: string) => {
    const q = await getDocs(query(collection(db, "shoppers"), where("memberCode", "==", code), limit(1)));
    const d = q.docs[0];
    if (!d) return false;
    const x = d.data();
    const s: Shopper = { id: d.id, name: x.name ?? "", email: x.email ?? "", mobile: x.mobile ?? "", points: x.points ?? 0, tier: x.tier ?? null, group: x.memberGroup ?? null, birthMonth: x.birthMonth ?? null };
    setShopper(s);
    toast(`會員：${s.name || s.mobile}`, "ok");
    if (s.email)
      call<{ shoppers: Shopper[] }>("searchShopper", { q: s.email })
        .then((r) => {
          const live = r.shoppers.find((y) => y.id === s.id);
          if (live) setShopper((cur) => (cur?.id === s.id ? { ...cur, ...live } : cur));
        })
        .catch(() => undefined);
    return true;
  };

  /** 優惠碼 → 解鎖「需要優惠碼」的促銷 */
  const applyCoupon = async (raw: string): Promise<boolean> => {
    const code = raw.trim().toUpperCase().replace(/\s+/g, "");
    if (!code) return false;
    const snap = await getDoc(doc(db, "coupons", code)).catch(() => null);
    if (!snap?.exists()) return false;
    const c = snap.data();
    const problem = !c.active ? "已停用" : c.expiresAt && c.expiresAt.toMillis() < Date.now() ? "已過期" : c.maxUses && c.used >= c.maxUses ? "已經用過" : null;
    if (problem) {
      beep(false);
      toast(`優惠碼 ${code} ${problem}`, "bad");
      return true;
    }
    if (coupons.some((x) => x.code === code)) return true;
    setCoupons((l) => [...l, { code, promoId: c.promoId, promoName: c.promoName }]);
    beep(true);
    toast(`已套用優惠碼：${c.promoName}`, "ok");
    return true;
  };
  const tier = shopper?.tier ? (settings.memberTiers ?? []).find((x) => x.name === shopper.tier) : undefined;
  const isBirthday = !!shopper?.birthMonth && shopper.birthMonth === todayStr().slice(5, 7);
  const t = totals(cart, disc, pointValue, promo, tier?.discountPct ?? 0);
  const credit = exchange?.credit ?? 0;
  const due = Math.max(0, t.total - credit);
  const refundDue = Math.max(0, credit - t.total);

  // ---- product grid ----
  const sellable = useMemo(() => variants.filter((v) => !v.posHidden), [variants]);
  const categories = useMemo(() => ["全部", ...[...new Set(sellable.map((v) => v.posCategory).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "zh-Hant"))], [sellable]);
  const products = useMemo(() => {
    let list = q ? searchVariants(sellable, q) : sellable;
    if (cat !== "全部") list = list.filter((v) => v.posCategory === cat);
    const map = new Map<string, Variant[]>();
    for (const v of list) map.set(v.productId, [...(map.get(v.productId) ?? []), v]);
    return [...map.values()]
      .map((vs) => vs.sort((a, b) => a.variantIndex - b.variantIndex))
      .sort((a, b) => (a[0].posSort ?? 0) - (b[0].posSort ?? 0) || a[0].productTitle.localeCompare(b[0].productTitle, "zh-Hant"));
  }, [sellable, cat, q]);

  const add = (v: Variant, qty = 1) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.variantId === v.id && l.unitPrice === v.price && l.discountPct === 0);
      if (i >= 0) {
        const n = [...c];
        n[i] = { ...n[i], qty: n[i].qty + qty };
        setSelected(n[i].key);
        return n;
      }
      const line = { key: newId("l"), variantId: v.id, qty, unitPrice: v.price ?? 0, discountPct: 0 };
      setSelected(line.key);
      return [...c, line];
    });
  };

  const onProduct = (vs: Variant[]) => (vs.length === 1 ? add(vs[0]) : setPick(vs));

  const onScan = async (code: string) => {
    const v = await resolveCode(code, byId);
    if (!v) {
      // 不是商品：試會員條碼、優惠碼
      if (/^M\d{9}$/.test(code.trim()) && (await scanMember(code.trim()))) return beep(true);
      if (await applyCoupon(code)) return;
      beep(false);
      toast(`找不到商品、會員或優惠碼：${code}`, "bad");
      return;
    }
    beep(true);
    add(v);
  };

  // Barcode gun anywhere on the page (not just in the scan box): fast keystrokes ending in Enter.
  const buf = useRef({ s: "", at: 0 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (document.querySelector(".modal")) return;
      const now = Date.now();
      if (now - buf.current.at > 80) buf.current.s = "";
      buf.current.at = now;
      if (e.key === "Enter") {
        if (buf.current.s.length >= 4) onScan(buf.current.s);
        buf.current.s = "";
      } else if (e.key.length === 1) buf.current.s += e.key;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const reset = () => {
    setCart([]);
    setShopper(null);
    setNote("");
    setGuests(1);
    setDisc(emptyDiscounts(settings.serviceFeeDefault ?? 0));
    setHoldId(undefined);
    setExchange(null);
    setCoupons([]);
    setSelected(null);
  };

  const hold = async () => {
    if (!cart.length || !user) return;
    const id = holdId ?? newId("h");
    const label = prompt("掛單名稱（桌號、客人名字…）", shopper?.name || `${guests} 位`);
    if (label === null) return;
    await setDoc(doc(db, "posHolds", id), { label, cart, shopper, note, guests, discounts: disc, by: user.uid, byName: profile?.name ?? "", at: serverTimestamp() });
    toast("已掛單", "ok");
    reset();
  };

  // 多店：商品卡與規格表顯示「本店」數量；單店：meepShop 庫存
  const stockOf = (v: Variant) => (multi && locationId ? locStock.get(v.id)?.[locationId] ?? 0 : v.shopStock ?? 0);
  const inCart = (variantId: string) => cart.filter((l) => l.variantId === variantId).reduce((s, l) => s + l.qty, 0);

  return (
    <div className="register">
      <section className="reg-products">
        <div className="reg-search">
          <ScanInput onCode={onScan} placeholder="掃條碼或輸入編號" autoFocus={false} />
          <input className="search" placeholder="搜尋商品" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="cat-tabs">
          {categories.map((c) => (
            <button key={c} className={cat === c ? "active" : ""} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="product-grid">
          {products.slice(0, 300).map((vs) => {
            const v = vs[0];
            const stock = vs.reduce((s, x) => s + stockOf(x), 0);
            return (
              <button key={v.productId} className="product-card" onClick={() => onProduct(vs)}>
                <div className="product-img">{v.imageUrl ? <img src={v.imageUrl} alt="" loading="lazy" /> : <span>{v.productTitle.slice(0, 6)}</span>}</div>
                <div className="product-name">{v.productTitle}</div>
                <div className="product-meta">
                  <span>{money(Math.min(...vs.map((x) => x.price ?? 0)))}{vs.length > 1 && " 起"}</span>
                </div>
                <span className={`stock-corner ${stock <= 0 ? "out" : ""}`}>{stock}</span>
              </button>
            );
          })}
          {products.length === 0 && <p className="muted">沒有商品</p>}
        </div>
      </section>

      <aside className="reg-cart">
        {exchange && (
          <div className="exchange-banner">
            <div className="row-between">
              <strong>換貨：{exchange.kind === "online" ? `網店訂單 ${exchange.orderNumber}` : exchange.orderNo}</strong>
              <button className="btn btn-sm btn-ghost" onClick={() => confirm("取消這次換貨？") && setExchange(null)}>
                取消換貨
              </button>
            </div>
            <div className="small">
              退回：{exchange.lines.map((l) => `${l.title} ×${l.qty}`).join("、")}
            </div>
            <div>
              可抵用 <strong>{money(credit)}</strong>
              {cart.length > 0 && (refundDue > 0 ? <>，要退客人 <strong>{money(refundDue)}</strong></> : <>，客人補 <strong>{money(due)}</strong></>)}
            </div>
            {refundDue > 0 && (
              <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                {Object.entries(PAY_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    差額用{l}退
                  </option>
                ))}
              </select>
            )}
            {cart.length === 0 && <div className="muted small">請加入要換的新商品</div>}
          </div>
        )}
        <div className="cart-head">
          <div>
            <strong>{holdId ? "掛單取回" : "新單"}</strong>
            <button className="link-btn" onClick={() => setKeypad({ key: "guests", title: "人數", suffix: "位" })}>
              {guests} 位
            </button>
          </div>
          <button className={`member-btn ${shopper ? "has" : ""}`} onClick={() => setMemberOpen(true)}>
            {shopper ? (
              <>
                {isBirthday && "🎂 "}
                {shopper.name || shopper.mobile} {shopper.tier && <span className="tag">{shopper.tier}</span>}
                {shopper.group && <span className="tag tag-promo">{shopper.group}</span>}
                <small>購物金 {shopper.points}</small>
              </>
            ) : (
              "＋會員"
            )}
          </button>
        </div>

        {(coupons.length > 0 || cart.length > 0) && (
          <div className="coupon-chips">
            {coupons.map((c) => (
              <span key={c.code} className="tag tag-promo">
                🎟 {c.code}（{c.promoName}）
                <button className="btn-icon" onClick={() => setCoupons((l) => l.filter((x) => x.code !== c.code))} aria-label="移除優惠碼">
                  ✕
                </button>
              </span>
            ))}
            <button
              className="link-btn small"
              onClick={async () => {
                const code = prompt("輸入或掃描優惠碼");
                if (code && !(await applyCoupon(code))) toast(`找不到優惠碼 ${code}`, "bad");
              }}
            >
              ＋ 優惠碼
            </button>
          </div>
        )}
        <ul className="cart-lines">
          {cart.length === 0 && <li className="muted center cart-empty">點商品或掃條碼加入</li>}
          {cart.map((l) => {
            const v = byId.get(l.variantId);
            const over = v && inCart(l.variantId) > stockOf(v);
            return (
              <li key={l.key} className={selected === l.key ? "selected" : ""} onClick={() => setSelected(l.key)}>
                <div className="cl-main" onDoubleClick={() => setEditLine(l)}>
                  <div className="cl-name">{v ? variantName(v) : l.variantId}</div>
                  <div className="cl-sub">
                    {money(l.unitPrice)}
                    {l.discountPct > 0 && <span className="tag">-{l.discountPct}%</span>}
                    {(promo.lineLabels[l.key] ?? []).map((n) => (
                      <span key={n} className="tag tag-promo">{n}</span>
                    ))}
                    {over && <span className="tag tag-warn">庫存不足</span>}
                  </div>
                </div>
                <div className="cl-qty">
                  <button onClick={(e) => (e.stopPropagation(), setCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: Math.max(1, x.qty - 1) } : x))))}>−</button>
                  <span>{l.qty}</span>
                  <button onClick={(e) => (e.stopPropagation(), setCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x))))}>＋</button>
                </div>
                <div className="cl-total">
                  {promo.lineDiscount[l.key] ? (
                    <>
                      <s className="muted small">{money(lineTotal(l))}</s>
                      <div>{money(lineTotal(l) - promo.lineDiscount[l.key])}</div>
                    </>
                  ) : (
                    money(lineTotal(l))
                  )}
                </div>
                <button className="btn-icon" onClick={(e) => (e.stopPropagation(), setEditLine(l))} aria-label="編輯">
                  ⋯
                </button>
              </li>
            );
          })}
        </ul>

        <input className="cart-note" placeholder="備註" value={note} onChange={(e) => setNote(e.target.value)} />

        <div className="disc-row">
          <button onClick={() => setKeypad({ key: "serviceFeePct", title: "服務費", suffix: "%" })}>
            服務費<strong>{disc.serviceFeePct}%</strong>
          </button>
          <button onClick={() => setKeypad({ key: "orderDiscountPct", title: "整單打折（折扣 %）", suffix: "%", hint: "例：打 9 折 = 輸入 10" })}>
            整單折扣<strong>{disc.orderDiscountPct}%</strong>
          </button>
          <button onClick={() => setKeypad({ key: "allowance", title: "折讓金額", suffix: "元" })}>
            折讓<strong>{money(disc.allowance)}</strong>
          </button>
          <button disabled={!shopper} onClick={() => setKeypad({ key: "rewardPoints", title: "購物金折抵", suffix: "點", hint: shopper ? `可用 ${shopper.points} 點（1 點 = ${pointValue} 元）` : "" })}>
            購物金<strong>{disc.rewardPoints}</strong>
          </button>
        </div>

        <div className="cart-sum">
          {promo.applied.map((a) => (
            <div key={a.promoId} className="promo-row">
              <span>🏷 {a.name}</span>
              <span>-{money(a.discount)}</span>
            </div>
          ))}
          <div>
            <span>小計</span>
            <span>{money(t.subtotal)}</span>
          </div>
          {t.memberDiscount > 0 && (
            <div className="promo-row">
              <span>
                會員折扣（{tier?.name} {tier?.discountPct}%）
              </span>
              <span>-{money(t.memberDiscount)}</span>
            </div>
          )}
          {t.orderDiscount + disc.allowance + t.rewardDiscount > 0 && (
            <div>
              <span>折扣</span>
              <span>-{money(t.orderDiscount + disc.allowance + t.rewardDiscount)}</span>
            </div>
          )}
          {t.serviceFee > 0 && (
            <div>
              <span>服務費</span>
              <span>{money(t.serviceFee)}</span>
            </div>
          )}
        </div>

        <div className="cart-actions">
          <button className="btn" disabled={!cart.length} onClick={() => confirm("清空購物車？") && reset()}>
            清空
          </button>
          <button className="btn" disabled={!cart.length} onClick={hold}>
            掛單
          </button>
          <button className="btn btn-pay" disabled={!cart.length || t.total < 0} onClick={() => (shift ? setCheckout(true) : toast("請先到「錢櫃」開班", "bad"))}>
            {exchange ? "換貨結帳" : "結帳"} · {t.items} 件 <strong>{money(exchange ? due : t.total)}</strong>
          </button>
        </div>
      </aside>

      {pick && (
        <Modal title={pick[0].productTitle} onClose={() => setPick(null)}>
          <VariantMatrix variants={pick} stockOf={stockOf} onPick={(v) => (add(v), setPick(null))} />
          {multi && <OtherLocations variants={pick} />}
        </Modal>
      )}

      {editLine && (
        <LineEditor
          line={editLine}
          title={byId.get(editLine.variantId) ? variantName(byId.get(editLine.variantId)!) : ""}
          onClose={() => setEditLine(null)}
          onSave={(l) => setCart((c) => c.map((x) => (x.key === l.key ? l : x)))}
          onDelete={() => setCart((c) => c.filter((x) => x.key !== editLine.key))}
        />
      )}

      {keypad && (
        <KeypadDialog
          title={keypad.title}
          suffix={keypad.suffix}
          hint={keypad.hint}
          initial={String(keypad.key === "guests" ? guests : disc[keypad.key] || "")}
          onClose={() => setKeypad(null)}
          onOk={(n) => {
            if (keypad.key === "guests") return setGuests(Math.max(0, Math.floor(n)));
            if (keypad.key === "rewardPoints") {
              const max = Math.min(shopper?.points ?? 0, Math.floor((t.total + t.rewardDiscount) / pointValue));
              if (n > max) toast(`最多可折抵 ${max} 點`, "bad");
              return setDisc((d) => ({ ...d, rewardPoints: Math.min(Math.floor(n), max) }));
            }
            if (keypad.key.endsWith("Pct")) n = Math.min(100, n);
            setDisc((d) => ({ ...d, [keypad.key]: n }));
          }}
        />
      )}

      {memberOpen && (
        <MemberPicker
          current={shopper}
          onClose={() => setMemberOpen(false)}
          onPick={(s) => {
            setShopper(s);
            if (!s) setDisc((d) => ({ ...d, rewardPoints: 0 }));
          }}
        />
      )}

      {checkout && (
        <Checkout
          total={due}
          onClose={() => setCheckout(false)}
          itemName={cart.map((l) => byId.get(l.variantId)?.productTitle ?? "商品").slice(0, 5).join("、") + (cart.length > 5 ? " 等" : "")}
          submit={async (payments, invoice) => {
            const id = orderId.current;
            type R = { id: string; status: string; stockIssues: { title: string; status: string; error: string | null }[] };
            const send = (allowOversell: boolean) =>
              call<R>("posCheckout", {
              id,
              allowOversell,
              exchange: exchange ? { kind: exchange.kind, orderId: exchange.orderId, orderNumber: exchange.orderNumber, lines: exchange.lines.map((l) => ({ index: l.index, variantId: l.variantId, qty: l.qty })) } : null,
              exchangeRefundMethod: refundMethod,
              items: cart.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct })),
              ...disc,
              shopperId: shopper?.id ?? null,
              payments,
              invoice,
              coupons: coupons.map((c) => c.code),
              note,
              guests,
              holdId,
              device: deviceId(),
              locationId,
            });
            const r = await send(false)
              .catch(async (e: Error) => {
                // 網店剛賣掉：讓店員決定（客人手上真的有這件時可以照賣，系統會記錄扣庫存失敗）
                if (/^網店庫存不足/.test(e.message) && confirm(`${e.message}\n\n確定這件商品在店裡、仍要結帳嗎？`)) return send(true);
                throw e;
              })
              .catch((e: Error) => {
                if (/購物金/.test(e.message)) orderId.current = newId("o"); // server canceled this order
                throw e;
              });
            if (r.status !== "completed") {
              orderId.current = newId("o");
              throw new Error("這張單沒有完成，請再按一次結帳");
            }
            orderId.current = newId("o");
            const order = { id, ...(await getDoc(doc(db, "posOrders", id))).data() } as PosOrder;
            setCheckout(false);
            setDone({ order, issues: r.stockIssues });
            reset();
          }}
        />
      )}

      {done && <Done order={done.order} issues={done.issues} onClose={() => setDone(null)} />}
    </div>
  );
}

function LineEditor({ line, title, onClose, onSave, onDelete }: { line: CartLine; title: string; onClose: () => void; onSave: (l: CartLine) => void; onDelete: () => void }) {
  const [field, setField] = useState<"qty" | "discountPct" | "unitPrice">("qty");
  const [vals, setVals] = useState({ qty: String(line.qty), discountPct: String(line.discountPct || ""), unitPrice: String(line.unitPrice) });
  const labels = { qty: "數量", discountPct: "單品折扣 %", unitPrice: "單價" };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-danger"
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            刪除
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onSave({ ...line, qty: Math.max(1, Math.floor(Number(vals.qty) || 1)), discountPct: Math.min(100, Number(vals.discountPct) || 0), unitPrice: Math.max(0, Number(vals.unitPrice) || 0) });
              onClose();
            }}
          >
            確定
          </button>
        </>
      }
    >
      <div className="segmented">
        {(Object.keys(labels) as (keyof typeof labels)[]).map((k) => (
          <button key={k} className={field === k ? "active" : ""} onClick={() => setField(k)}>
            {labels[k]}
            <small>{vals[k] || "0"}</small>
          </button>
        ))}
      </div>
      <Keypad value={vals[field]} onChange={(v) => setVals((x) => ({ ...x, [field]: v }))} allowDot={field !== "qty"} />
    </Modal>
  );
}

export function MemberPicker({ current, onClose, onPick }: { current: Shopper | null; onClose: () => void; onPick: (s: Shopper | null) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<(Shopper & { live?: boolean })[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", mobile: "" });
  const { busy, run } = useAction();
  const search = () =>
    run(async () => {
      // 會員條碼（掃描槍或手動輸入 M + 9 碼）
      if (/^M\d{9}$/i.test(q.trim())) {
        const r = await getDocs(query(collection(db, "shoppers"), where("memberCode", "==", q.trim().toUpperCase()), limit(1)));
        setList(r.docs.map((d) => ({ id: d.id, name: d.data().name ?? "", email: d.data().email ?? "", mobile: d.data().mobile ?? "", points: d.data().points ?? 0, tier: d.data().tier ?? null, group: d.data().memberGroup ?? null })));
        return;
      }
      setList((await call<{ shoppers: Shopper[] }>("searchShopper", { q })).shoppers);
    });
  const choose = (s: Shopper) => {
    onPick(s);
    onClose();
  };
  return (
    <Modal title="會員" onClose={onClose}>
      {current && (
        <div className="notice row-between">
          目前：{current.name || current.mobile}（購物金 {current.points}）
          <button
            className="btn btn-sm"
            onClick={() => {
              onPick(null);
              onClose();
            }}
          >
            移除會員
          </button>
        </div>
      )}
      {!creating ? (
        <>
          <div className="inline-form">
            <input autoFocus placeholder="手機號碼、Email 或掃會員條碼" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q && search()} />
            <button className="btn btn-primary" disabled={busy || !q} onClick={search}>
              查詢
            </button>
          </div>
          {!q.includes("@") && <Keypad value={q} onChange={setQ} />}
          {list && (
            <ul className="pick-list">
              {list.length === 0 && <li className="muted">找不到會員</li>}
              {list.map((s) => (
                <li key={s.id}>
                  <button onClick={() => choose(s)}>
                    <span>{s.name || "(未填姓名)"}</span>
                    <small className="muted">
                      {s.mobile} · {s.email} · 購物金 {s.points}
                      {s.group && ` · ${s.group}`}
                      {s.live === false && "（快取）"}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-ghost" onClick={() => (setCreating(true), setForm((f) => ({ ...f, mobile: q.includes("@") ? "" : q, email: q.includes("@") ? q : "" })))}>
            ＋ 現場新增會員
          </button>
        </>
      ) : (
        <>
          <p className="muted small">會員會建立在 meepShop，Email 為必填（meepShop 規定）。</p>
          <input placeholder="Email（必填）" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="姓名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="手機" inputMode="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
          <div className="btn-row">
            <button className="btn" onClick={() => setCreating(false)}>
              返回
            </button>
            <button className="btn btn-primary" disabled={busy || !form.email} onClick={() => run(async () => choose(await call<Shopper>("createShopper", form)), "已新增會員")}>
              新增並帶入
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
