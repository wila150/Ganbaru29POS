import { collection, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from "firebase/firestore";
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
import { playCheckoutSound, unlockAudio } from "../../lib/sound";
import { ProductInfo } from "../../components/ProductInfo";
import { MemberTagEditor, TagChips, useShopperPrefs } from "../../components/MemberTags";
import { beep, deviceId, money, newId, PAY_LABEL, pctToZhe, todayStr, zheToPct } from "../../lib/util";
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
  // iPad 要在點畫面時解鎖聲音，結帳完成才能播放音效
  const soundUrls = [settings.checkoutSound?.customUrl, ...(settings.checkoutSound?.rules ?? []).map((r) => r.customUrl)].filter(Boolean).join("|");
  useEffect(() => unlockAudio(soundUrls ? soundUrls.split("|") : null), [soundUrls]);
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

  // 帶入的會員：資料改了（購物金、群組、等級）畫面跟著更新
  const shopperId = shopper?.id;
  useEffect(() => {
    if (!shopperId) return;
    return onSnapshot(doc(db, "shoppers", shopperId), (d) => {
      const x = d.data();
      if (!x) return;
      setShopper((cur) =>
        cur?.id === shopperId && (cur.points !== (x.points ?? 0) || cur.group !== (x.memberGroup ?? null) || cur.tier !== (x.tier ?? null) || cur.name !== (x.name ?? ""))
          ? { ...cur, name: x.name ?? cur.name, points: x.points ?? 0, group: x.memberGroup ?? null, tier: x.tier ?? null, birthMonth: x.birthMonth ?? cur.birthMonth }
          : cur
      );
    });
  }, [shopperId]);
  // 剛新增的會員：meepShop 幾秒後才補上入會禮購物金與預設群組 → 再讀幾次
  const newMemberId = useRef<string | null>(null);
  useEffect(() => {
    if (!shopperId || newMemberId.current !== shopperId) return;
    const timers = [3000, 8000, 20000].map((ms) => setTimeout(() => call("refreshShopper", { id: shopperId }).catch(() => undefined), ms));
    return () => timers.forEach(clearTimeout);
  }, [shopperId]);

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
  // 分類頁籤 = meepShop 商品的所有標籤（一個商品有幾個標籤就出現在幾個頁籤），商品多的排前面
  const catsOf = (v: Variant) => [...new Set([v.posCategory, ...(v.tags ?? [])].filter(Boolean) as string[])];
  const categories = useMemo(() => {
    const count = new Map<string, Set<string>>();
    for (const v of sellable) for (const c of catsOf(v)) (count.get(c) ?? count.set(c, new Set()).get(c)!).add(v.productId);
    const off = sellable.some((v) => v.productStatus === "NOT_LISTED");
    return ["全部", ...[...count.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "zh-Hant")).map(([c]) => c), ...(off ? [OFF_TAB] : [])];
  }, [sellable]);
  const products = useMemo(() => {
    let list = q ? searchVariants(sellable, q) : sellable;
    if (cat === OFF_TAB) list = list.filter((v) => v.productStatus === "NOT_LISTED");
    else if (cat !== "全部") list = list.filter((v) => catsOf(v).includes(cat));
    const map = new Map<string, Variant[]>();
    for (const v of list) map.set(v.productId, [...(map.get(v.productId) ?? []), v]);
    return [...map.values()]
      .map((vs) => vs.sort((a, b) => a.variantIndex - b.variantIndex))
      .sort((a, b) => (a[0].posSort ?? 0) - (b[0].posSort ?? 0) || a[0].productTitle.localeCompare(b[0].productTitle, "zh-Hant"));
  }, [sellable, cat, q]);

  const add = (v: Variant, qty = 1) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.variantId === v.id && l.unitPrice === v.price && l.discountPct === 0 && !l.note);
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

  // 商品格很大（上百張圖）：只在商品、庫存改變時重畫，加減購物車不重畫
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<CartLine | null>(null);
  const onProductRef = useRef(onProduct);
  onProductRef.current = onProduct;
  const grid = useMemo(
    () => (
      <div className="product-grid">
        {products.slice(0, 300).map((vs) => {
          const v = vs[0];
          const stock = vs.reduce((s, x) => s + (multi && locationId ? locStock.get(x.id)?.[locationId] ?? 0 : x.shopStock ?? 0), 0);
          const img = v.thumbUrl || v.imageUrl;
          return (
            <button key={v.productId} className="product-card" onClick={() => onProductRef.current(vs)}>
              <span
                role="button"
                aria-label="商品資訊"
                className="info-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setInfoFor(v.productId);
                }}
              >
                i
              </span>
              <div className="product-img">{img ? <img src={img} alt="" loading="lazy" decoding="async" /> : <span>{v.productTitle.slice(0, 6)}</span>}</div>
              <div className="product-name">{v.productTitle}</div>
              {v.productStatus === "NOT_LISTED" && <span className="off-badge">官網下架</span>}
              <div className="product-meta">
                <span>
                  {money(Math.min(...vs.map((x) => x.price ?? 0)))}
                  {vs.length > 1 && " 起"}
                </span>
              </div>
              <span className={`stock-corner ${stock <= 0 ? "out" : ""}`}>{stock}</span>
            </button>
          );
        })}
        {products.length === 0 && <p className="muted">沒有商品</p>}
      </div>
    ),
    [products, multi, locationId, locStock]
  );

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
        {grid}
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
        {/* 折扣工具列放在購物車最上面（同 BV SHOP：先決定優惠，再看明細） */}
        <div className="disc-row disc-top">
          <button className={disc.serviceFeePct ? "on" : ""} onClick={() => setKeypad({ key: "serviceFeePct", title: "服務費", suffix: "%" })}>
            <span className="disc-ic">％</span>
            服務費<strong>{disc.serviceFeePct}%</strong>
          </button>
          <button className={disc.orderDiscountPct ? "on" : ""} onClick={() => setKeypad({ key: "orderDiscountPct", title: "整單打折", suffix: "折", hint: "直接輸入幾折：85 = 85 折、9 = 9 折、8.5 = 85 折；輸入 0 取消" })}>
            <span className="disc-ic">🏷</span>
            整單打折<strong>{disc.orderDiscountPct ? `${pctToZhe(disc.orderDiscountPct)} 折` : "無"}</strong>
          </button>
          <button className={disc.allowance ? "on" : ""} onClick={() => setKeypad({ key: "allowance", title: "折讓金額", suffix: "元" })}>
            <span className="disc-ic">＄</span>
            折讓<strong>{money(disc.allowance)}</strong>
          </button>
          <button className={disc.rewardPoints ? "on" : ""} disabled={!shopper} onClick={() => setKeypad({ key: "rewardPoints", title: "購物金折抵", suffix: "點", hint: shopper ? `可用 ${shopper.points} 點（1 點 = ${pointValue} 元）` : "" })}>
            <span className="disc-ic">🪙</span>
            購物金<strong>{disc.rewardPoints}</strong>
          </button>
        </div>

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
                    {l.discountPct > 0 && <span className="tag">{pctToZhe(l.discountPct)} 折</span>}
                    {(promo.lineLabels[l.key] ?? []).map((n) => (
                      <span key={n} className="tag tag-promo">{n}</span>
                    ))}
                    {over && <span className="tag tag-warn">庫存不足</span>}
                  </div>
                  {l.note ? (
                    <button className="cl-note" onClick={(e) => (e.stopPropagation(), setNoteFor(l))}>
                      📝 {l.note}
                    </button>
                  ) : (
                    selected === l.key && (
                      <button className="cl-note add" onClick={(e) => (e.stopPropagation(), setNoteFor(l))}>
                        ＋ 備註
                      </button>
                    )
                  )}
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
                會員折扣（{tier?.name} {pctToZhe(tier?.discountPct)} 折）
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
          initial={keypad.key === "orderDiscountPct" ? pctToZhe(disc.orderDiscountPct) : String(keypad.key === "guests" ? guests : disc[keypad.key] || "")}
          allowDot={keypad.key === "orderDiscountPct"}
          onClose={() => setKeypad(null)}
          onOk={(n) => {
            if (keypad.key === "guests") return setGuests(Math.max(0, Math.floor(n)));
            if (keypad.key === "rewardPoints") {
              const max = Math.min(shopper?.points ?? 0, Math.floor((t.total + t.rewardDiscount) / pointValue));
              if (n > max) toast(`最多可折抵 ${max} 點`, "bad");
              return setDisc((d) => ({ ...d, rewardPoints: Math.min(Math.floor(n), max) }));
            }
            if (keypad.key === "orderDiscountPct") return setDisc((d) => ({ ...d, orderDiscountPct: zheToPct(n) }));
            if (keypad.key.endsWith("Pct")) n = Math.min(100, n);
            setDisc((d) => ({ ...d, [keypad.key]: n }));
          }}
        />
      )}

      {memberOpen && (
        <MemberPicker
          current={shopper}
          onClose={() => setMemberOpen(false)}
          onPick={(s, created) => {
            if (created && s) newMemberId.current = s.id;
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
              items: cart.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, note: l.note || null })),
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
            void (async () => {
              // 條件音效（例：會員生日）要知道會員生日、群組
              let birthDate: string | null = null;
              if (shopper && settings.checkoutSound?.rules?.some((x) => x.when.startsWith("birthday")))
                birthDate = ((await getDoc(doc(db, "shoppers", shopper.id)).catch(() => null))?.data()?.birthDate as string | undefined) ?? null;
              playCheckoutSound(settings.checkoutSound, false, { isMember: !!shopper, birthDate, group: shopper?.group ?? null, total: due, today: todayStr() });
            })();
            setDone({ order, issues: r.stockIssues });
            reset();
          }}
        />
      )}

      {done && <Done order={done.order} issues={done.issues} onClose={() => setDone(null)} />}
      {noteFor && (
        <LineNote
          line={noteFor}
          title={(() => {
            const v = byId.get(noteFor.variantId);
            return v ? variantName(v) : "";
          })()}
          onClose={() => setNoteFor(null)}
          onSave={(note) => setCart((c) => c.map((x) => (x.key === noteFor.key ? { ...x, note: note || undefined } : x)))}
        />
      )}
      {infoFor && <ProductInfo productId={infoFor} onClose={() => setInfoFor(null)} stockOf={(id) => { const v = byId.get(id); return v ? stockOf(v) : 0; }} />}
    </div>
  );
}

/** 收銀分類頁籤：meepShop 官網沒上架的商品（門市照樣可以賣） */
const OFF_TAB = "官網下架";

const NOTE_PRESETS = ["修改褲長", "客人預留", "公關品", "瑕疵品折扣", "換貨"];

/** 單一商品的備註（會印在收據、存在交易紀錄） */
function LineNote({ line, title, onClose, onSave }: { line: CartLine; title: string; onClose: () => void; onSave: (note: string) => void }) {
  const [v, setV] = useState(line.note ?? "");
  const done = (text: string) => {
    onSave(text.trim().slice(0, 100));
    onClose();
  };
  return (
    <Modal
      title={`備註：${title}`}
      onClose={onClose}
      footer={
        <>
          {line.note && (
            <button className="btn btn-ghost" onClick={() => done("")}>
              清除備註
            </button>
          )}
          <button className="btn btn-primary" onClick={() => done(v)}>
            確定
          </button>
        </>
      }
    >
      <input autoFocus value={v} maxLength={100} placeholder="例：褲長改短 3cm、週六來拿" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && done(v)} />
      <div className="chips" style={{ marginTop: 10 }}>
        {NOTE_PRESETS.map((p) => (
          <button key={p} type="button" className="chip" onClick={() => setV((x) => (x ? `${x}、${p}` : p))}>
            {p}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function LineEditor({ line, title, onClose, onSave, onDelete }: { line: CartLine; title: string; onClose: () => void; onSave: (l: CartLine) => void; onDelete: () => void }) {
  const [field, setField] = useState<"qty" | "discountPct" | "unitPrice">("qty");
  // 單品打折用「幾折」輸入（85 = 85 折），存的時候換成折扣 %
  const [vals, setVals] = useState({ qty: String(line.qty), discountPct: pctToZhe(line.discountPct), unitPrice: String(line.unitPrice) });
  const labels = { qty: "數量", discountPct: "單品打折（折）", unitPrice: "單價" };
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
              onSave({ ...line, qty: Math.max(1, Math.floor(Number(vals.qty) || 1)), discountPct: zheToPct(Number(vals.discountPct) || 0), unitPrice: Math.max(0, Number(vals.unitPrice) || 0) });
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
            <small>{k === "discountPct" ? (vals[k] ? `${vals[k]} 折` : "無") : vals[k] || "0"}</small>
          </button>
        ))}
      </div>
      <Keypad value={vals[field]} onChange={(v) => setVals((x) => ({ ...x, [field]: v }))} allowDot={field !== "qty"} />
    </Modal>
  );
}

/** 會員視窗上方：群組（meepShop，唯讀）＋本系統標籤（可編輯） */
function CurrentMemberTags({ current }: { current: Shopper }) {
  const { tags, pref } = useShopperPrefs(current.id);
  const [editing, setEditing] = useState(false);
  // 最近在門市買過的東西（最近 5 張單）
  const [bought, setBought] = useState<string[] | null>(null);
  useEffect(() => {
    getDocs(query(collection(db, "posOrders"), where("shopper.id", "==", current.id), orderBy("createdAt", "desc"), limit(5)))
      .then((r) => {
        const items = r.docs.flatMap((d) => ((d.data().lines ?? []) as { productTitle: string; options: string }[]).map((l) => `${l.productTitle}${l.options ? `（${l.options}）` : ""}`));
        setBought([...new Set(items)].slice(0, 8));
      })
      .catch(() => setBought([]));
  }, [current.id]);
  return (
    <div className="member-meta">
      <span className="muted small">群組</span>
      <span className="member-group" title="會員群組在 meepShop 後台設定（meepShop 不開放修改）">{current.group ?? "未加入群組"}</span>
      {current.tier && <span className="muted small">等級 {current.tier}</span>}
      <span className="muted small">　標籤</span>
      {tags.length ? <TagChips tags={tags} /> : <span className="muted small">無</span>}
      <button className="link-btn small" onClick={() => setEditing(true)}>
        編輯標籤／喜好
      </button>
      {pref && <div className="member-pref">💬 {pref}</div>}
      {bought && bought.length > 0 && <div className="member-pref bought">🛍 最近在門市買過：{bought.join("、")}</div>}
      {editing && <MemberTagEditor shopperId={current.id} name={current.name || current.mobile} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function MemberPicker({ current, onClose, onPick }: { current: Shopper | null; onClose: () => void; onPick: (s: Shopper | null, created?: boolean) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<(Shopper & { live?: boolean })[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", mobile: "", birthDate: "" });
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
  const choose = (s: Shopper, created = false) => {
    onPick(s, created);
    onClose();
  };
  return (
    <Modal title="會員" onClose={onClose}>
      {current && <CurrentMemberTags current={current} />}
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
            {/* 平板不跳出系統鍵盤：用下面的數字鍵或掃描槍輸入 */}
            <input autoFocus inputMode="none" placeholder="手機號碼或掃會員條碼" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q && search()} />
            <button className="btn btn-primary" disabled={busy || !q} onClick={search}>
              查詢
            </button>
          </div>
          {!q.includes("@") && <Keypad value={q} onChange={setQ} digits />}
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
          <p className="muted small">會員會建立在 meepShop，Email 和生日為必填（meepShop 規定）。</p>
          <input placeholder="Email（必填）" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="姓名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="手機" inputMode="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
          <label className="small muted">生日（必填，meepShop 規定）</label>
          <input type="date" max={new Date().toISOString().slice(0, 10)} value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
          <div className="btn-row">
            <button className="btn" onClick={() => setCreating(false)}>
              返回
            </button>
            <button className="btn btn-primary" disabled={busy || !form.email || !form.birthDate} onClick={() => run(async () => choose(await call<Shopper>("createShopper", form), true), "已新增會員")}>
              新增並帶入
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
