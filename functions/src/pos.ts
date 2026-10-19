import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { Actor, atLeast, requireRole } from "./lib/auth";
import * as meep from "./lib/meepshop";
import { createMovement, pushBulk } from "./lib/movements";
import { assert, birthDateInput, db, errMsg, FieldValue, HttpsError, int, num, str, taipeiDate, Timestamp } from "./lib/util";
import { applyPromotions, taipeiClock, type Promotion } from "./shared/promo";
import { claimOnlinePayment } from "./payments/index";
import { refundLinePay } from "./payments/linepay";
import { invoiceAfterRefund, issueForOrder, parseInvoiceRequest } from "./payments/invoice";
import { audit } from "./lib/audit";
import { consumeCoupons, ensureMemberCodes, validateCoupons } from "./cards";
import { mobileKey } from "./sync";

/**
 * posOrders/{id}  id is generated on the tablet, so a double-tapped / re-sent checkout is stored once.
 * status: pending → completed | canceled ; later partial / refunded / void
 * shifts/{id}     one cashier shift (開班零用金、存提款、日結)
 * settings/shop.currentShifts[locationId|"main"]  the open shift of each store's register
 */

const METHODS = ["cash", "card", "linepay", "transfer"] as const;
/** "exchange" = credit from items returned in an exchange; never sent by the tablet directly. */
type Method = (typeof METHODS)[number] | "exchange" | "ecpay" | "newebpay";
/** 線上付款（掃 QR）：必須帶 posPayments 的 id（ref），posCheckout 會確認已付款 */
const ONLINE_METHODS = ["ecpay", "newebpay"];
/** 設定 → 付款方式 新增的自訂方式（例：街口、悠遊付、禮券），key = c_xxxx，當作非現金記帳 */
const isCustomMethod = (m: unknown, settings: FirebaseFirestore.DocumentData) =>
  typeof m === "string" && /^c_[a-z0-9]{3,16}$/.test(m) && ((settings.payMethods ?? []) as { key: string }[]).some((x) => x.key === m);
const manualMethod = (m: unknown, settings: FirebaseFirestore.DocumentData) => (METHODS as readonly string[]).includes(m as string) || isCustomMethod(m, settings);
const opts = { maxInstances: 5 };

interface Line {
  variantId: string;
  productTitle: string;
  options: string;
  sku: string | null;
  qty: number;
  listPrice: number;
  unitPrice: number;
  discountPct: number;
  /** promotion discount on this line (dollars); total is already net of it */
  promoDiscount: number;
  promoLabels: string[];
  total: number;
  refundedQty: number;
  /** 這一項的備註 */
  note?: string | null;
}

/**
 * 購物金回饋規則（滿額贈購物金）：例「尊貴的客人 每消費 $10 送 $1，$1～$1,000,000，365 天到期」。
 * 符合多條規則時取送最多的一條；沒有規則時沿用舊的「消費回饋 %」。
 */
export interface RewardRule {
  name: string;
  active: boolean;
  /** meepShop 會員群組；空 = 所有會員 */
  groups?: string[];
  /** 本系統會員等級；空 = 不限 */
  tiers?: string[];
  every: number;
  points: number;
  minSpend?: number;
  maxSpend?: number;
  expiryDays?: number;
}
export function rewardFor(settings: FirebaseFirestore.DocumentData, total: number, group: string | null, tier: string | null) {
  const rules = ((settings.rewardRules ?? []) as RewardRule[]).filter(
    (r) => r.active && (!r.groups?.length || (group && r.groups.includes(group))) && (!r.tiers?.length || (tier && r.tiers.includes(tier))) && total >= (r.minSpend ?? 0)
  );
  if (!rules.length) {
    const pct = Number(settings.rewardPercent ?? 0);
    const pv = Number(settings.pointValue ?? 1);
    return pct > 0 ? { points: (total * pct) / 100 / pv, rule: "消費回饋", expiryDays: undefined } : null;
  }
  const calc = (r: RewardRule) => Math.floor(Math.min(total, r.maxSpend || Infinity) / Math.max(1, r.every)) * Math.max(0, r.points);
  const best = rules.reduce((a, b) => (calc(b) > calc(a) ? b : a));
  return { points: calc(best), rule: best.name, expiryDays: best.expiryDays || undefined };
}

/** 升級／續會條件：在 months 個月內「單次購物」或「累計購物」滿 amount 元 */
export interface TierCond {
  kind: "single" | "cumulative";
  amount: number;
  months?: number;
}
/**
 * 會員等級（與 meepShop 顧客群組相同的規則）：
 *  - 沒有升級條件的是「基本等級」（例：尊貴的客人），所有會員預設都在這裡
 *  - 升級資格任一達成即升級，使用期限 validityMonths 個月（0 / 空 = 永久）
 *  - 到期時，期限內達成任一續會資格就再延一期，否則回到基本等級
 */
export interface TierDef {
  name: string;
  enabled?: boolean;
  validityMonths?: number | null;
  upgrade?: TierCond[];
  renew?: TierCond[];
  /** 舊版欄位（相容） */
  minSpend?: number;
  minSingle?: number;
  discountPct?: number;
  pointMultiplier?: number;
}

/** 舊版設定（累計滿／單次滿）轉成新格式 */
export function normalizeTier(t: TierDef): TierDef {
  if (t.upgrade) return { enabled: true, ...t };
  const conds: TierCond[] = [];
  if (t.minSingle) conds.push({ kind: "single", amount: t.minSingle, months: 12 });
  if (t.minSpend) conds.push({ kind: "cumulative", amount: t.minSpend, months: 12 });
  return { ...t, enabled: true, validityMonths: conds.length ? 12 : null, upgrade: conds, renew: conds.map((c) => ({ kind: c.kind, amount: c.amount })) };
}
export function memberTier(settings: FirebaseFirestore.DocumentData, name: string | undefined | null): TierDef | null {
  if (!name) return null;
  return ((settings.memberTiers ?? []) as TierDef[]).find((t) => t.name === name) ?? null;
}

/** 每家門市各自開班、日結（單店時 key = "main"，相容舊的 currentShiftId）。 */
const shiftKey = (loc: unknown) => (typeof loc === "string" && loc ? loc : "main");
function currentShift(settings: FirebaseFirestore.DocumentData, loc: unknown): string | undefined {
  const k = shiftKey(loc);
  return settings.currentShifts?.[k] ?? (k === "main" ? settings.currentShiftId ?? undefined : undefined);
}

async function shopSettings() {
  return (await db.doc("settings/shop").get()).data() ?? {};
}

async function nextOrderNo(): Promise<string> {
  const day = taipeiDate().replace(/-/g, "");
  const ref = db.doc(`counters/pos-${day}`);
  const seq = await db.runTransaction(async (tx) => {
    const n = ((await tx.get(ref)).data()?.n ?? 0) + 1;
    tx.set(ref, { n });
    return n;
  });
  return `P${day}-${String(seq).padStart(4, "0")}`;
}

// ---------- checkout ----------

export const posCheckout = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "staff");
  const d = req.data ?? {};
  const id = str(d.id, "訂單 id", { max: 64 });
  assert(/^[\w-]+$/.test(id), "訂單 id 格式不正確");
  const ref = db.doc(`posOrders/${id}`);

  const existing = (await ref.get()).data();
  if (existing && existing.status !== "pending") return summarize(id);

  const settings = await shopSettings();
  const shiftId = currentShift(settings, d.locationId);
  assert(shiftId, "請先到「錢櫃」開班", "failed-precondition");
  const pointValue = Number(settings.pointValue ?? 1);

  // --- compute on the server; the tablet's numbers are only a preview ---
  const rawItems = Array.isArray(d.items) ? d.items : [];
  assert(rawItems.length > 0 && rawItems.length <= 100, "購物車是空的");
  const vSnaps = await db.getAll(...rawItems.map((i: { variantId: string }) => db.doc(`variants/${str(i.variantId, "款式", { max: 100 })}`)));
  const lines: Line[] = rawItems.map((i: Record<string, unknown>, idx: number) => {
    const v = vSnaps[idx].data();
    assert(v, `第 ${idx + 1} 項商品不存在`, "not-found");
    const qty = int(i.qty, "數量", { min: 1, max: 999 });
    const unitPrice = num(i.unitPrice ?? v.price, "單價", { min: 0, max: 1e7 });
    const discountPct = num(i.discountPct ?? 0, "單品折扣", { min: 0, max: 100 });
    return {
      variantId: vSnaps[idx].id,
      productTitle: v.productTitle,
      options: v.options ?? "",
      sku: v.sku ?? null,
      qty,
      listPrice: v.price ?? 0,
      unitPrice,
      discountPct,
      promoDiscount: 0,
      promoLabels: [],
      total: Math.round((unitPrice * qty * (100 - discountPct)) / 100),
      refundedQty: 0,
      note: str(i.note, "備註", { optional: true, max: 100 }) || null,
    };
  });

  const shopperId = d.shopperId ? str(d.shopperId, "會員", { max: 64 }) : null;
  const shopperDoc = shopperId ? (await db.doc(`shoppers/${shopperId}`).get()).data() : undefined;

  // --- 優惠碼：驗證後解鎖對應的促銷（pending 重送時沿用已驗證的碼） ---
  const couponCheck = existing?.coupons ? { promoIds: existing.coupons.map((c: { promoId: string }) => c.promoId), coupons: existing.coupons } : await validateCoupons(Array.isArray(d.coupons) ? d.coupons.map(String) : []);

  // --- 促銷：伺服器重算一次（與 POS 畫面用同一個引擎） ---
  const promoSnap = await db.collection("promotions").where("active", "==", true).get();
  const promotions = promoSnap.docs.map((p) => ({ id: p.id, ...p.data() }) as Promotion);
  const infoById = new Map(vSnaps.map((v) => [v.id, { productId: v.data()?.productId ?? "", category: v.data()?.posCategory ?? null, tags: v.data()?.tags ?? [] }]));
  const promo = applyPromotions(
    lines.map((l, i) => ({ key: String(i), variantId: l.variantId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct })),
    (vid) => infoById.get(vid),
    promotions,
    { ...taipeiClock(), isMember: !!shopperId, tier: shopperDoc?.tier ?? null, group: shopperDoc?.posGroup ?? shopperDoc?.memberGroup ?? null, coupons: couponCheck.promoIds }
  );
  lines.forEach((l, i) => {
    l.promoDiscount = promo.lineDiscount[String(i)] ?? 0;
    l.promoLabels = promo.lineLabels[String(i)] ?? [];
    l.total -= l.promoDiscount;
  });

  // --- 結帳前向 meepShop 確認即時庫存，避免網店剛賣掉最後一件 ---
  if (!existing && d.allowOversell !== true) {
    const want = new Map<string, number>();
    for (const l of lines) want.set(l.variantId, (want.get(l.variantId) ?? 0) + l.qty);
    let live: Map<string, number> | null = null;
    try {
      live = await meep.variantStocks([...want.keys()]);
    } catch (e) {
      logger.warn("live stock check skipped", e); // meepShop unreachable: don't block the sale
    }
    if (live) {
      const short = [...want].filter(([vid, q]) => live!.has(vid) && q > live!.get(vid)!);
      for (const [vid, stock] of live) await db.doc(`variants/${vid}`).update({ shopStock: stock, shopStockAt: FieldValue.serverTimestamp() });
      if (short.length) {
        const names = short.map(([vid, q]) => {
          const l = lines.find((x) => x.variantId === vid)!;
          return `${l.productTitle} ${l.options}：要 ${q} 件，網店只剩 ${live!.get(vid)} 件`;
        });
        throw new HttpsError("failed-precondition", `網店庫存不足（可能剛被網路訂單買走）\n${names.join("\n")}`, { code: "oversell" });
      }
    }
  }

  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const promoTotal = promo.total;
  // --- 會員等級折扣、生日月（以伺服器上的會員資料為準） ---
  const tier = memberTier(settings, shopperDoc?.tier);
  const birthdayMonth = !!shopperDoc?.birthMonth && shopperDoc.birthMonth === taipeiDate().slice(5, 7);
  const memberDiscountPct = tier?.discountPct ?? 0;
  // 設了「不併用會員折扣」的促銷，那些品項不再打會員折扣
  const noStack = new Set(promo.noMemberStack.map(Number));
  const memberBase = lines.reduce((s2, l, i) => s2 + (noStack.has(i) ? 0 : l.total), 0);
  const memberDiscount = Math.round((memberBase * memberDiscountPct) / 100);
  const afterMember = subtotal - memberDiscount;

  const orderDiscountPct = num(d.orderDiscountPct ?? 0, "整單折扣", { min: 0, max: 100 });
  const orderDiscount = Math.round((afterMember * orderDiscountPct) / 100);
  const serviceFeePct = num(d.serviceFeePct ?? 0, "服務費", { min: 0, max: 100 });
  const serviceFee = Math.round(((afterMember - orderDiscount) * serviceFeePct) / 100);
  const allowance = num(d.allowance ?? 0, "折讓", { min: 0, max: 1e7 });
  const rewardPoints = shopperId ? int(d.rewardPoints ?? 0, "購物金折抵", { min: 0, max: 1e7 }) : 0;
  const rewardDiscount = rewardPoints * pointValue;
  const total = afterMember - orderDiscount + serviceFee - allowance - rewardDiscount;
  assert(total >= 0, "折扣超過應收金額");

  const payments = (Array.isArray(d.payments) ? d.payments : []).map((p: Record<string, unknown>) => {
    // LINE Pay 有 ref = 串接扣款（posPayments），沒有 ref = 店員另外收款後手動記帳
    const online = ONLINE_METHODS.includes(p.method as string) || (p.method === "linepay" && typeof p.ref === "string" && p.ref.length > 0);
    assert(online || manualMethod(p.method, settings), "付款方式不正確");
    return { method: p.method as Method, amount: num(p.amount, "付款金額", { min: 0, max: 1e8 }), ...(online ? { ref: str(p.ref, "線上付款編號", { max: 40 }) } : {}) };
  }).filter((p: { amount: number }) => p.amount > 0) as { method: Method; amount: number; ref?: string }[];
  const invoiceRequest = parseInvoiceRequest(d.invoice);

  // --- 換貨：退回商品的金額當作這張新單的抵用 ---
  let exchange: (ExchangeQuote & { refundDue: number; refundMethod: Method }) | null = existing?.exchange ?? null;
  if (!existing && d.exchange) {
    const actorCanRefund = await canRefund(actor).then(() => true);
    assert(actorCanRefund, "換貨限店長以上");
    const q = await quoteExchange(d.exchange);
    const used = Math.min(q.credit, total);
    const refundMethod = manualMethod(d.exchangeRefundMethod, settings) ? (d.exchangeRefundMethod as Method) : "cash";
    exchange = { ...q, refundDue: q.credit - used, refundMethod };
  }
  if (exchange) {
    const used = exchange.credit - exchange.refundDue;
    if (used > 0) payments.unshift({ method: "exchange", amount: used });
  }
  const paid = payments.reduce((s: number, p: { amount: number }) => s + p.amount, 0);
  const nonCash = payments.filter((p: { method: Method }) => p.method !== "cash").reduce((s: number, p: { amount: number }) => s + p.amount, 0);
  assert(paid >= total, `收款不足，還差 ${total - paid} 元`);
  assert(nonCash <= total, "非現金付款不能超過應收金額（不能找零）");
  const change = paid - total;

  const shopper = shopperId ? { id: shopperId, name: shopperDoc?.name ?? "", email: shopperDoc?.email ?? "", mobile: shopperDoc?.mobile ?? "", tier: tier?.name ?? null, group: shopperDoc?.posGroup ?? shopperDoc?.memberGroup ?? null } : null;
  const pointMultiplier = (tier?.pointMultiplier || 1) * (birthdayMonth ? Number(settings.birthdayPointMultiplier || 1) : 1);

  // --- 1. pending record (idempotent) ---
  if (!existing) {
    const orderNo = await nextOrderNo();
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return;
      // 線上付款：確認已付款、金額相符，並標記給這張單用（一筆付款只能用一次）
      const claims = [];
      for (const p of payments.filter((x) => x.ref)) claims.push(await claimOnlinePayment(tx, p.ref!, id, p.method, p.amount));
      claims.forEach((apply) => apply());
      tx.create(ref, {
        invoiceRequest,
        locationId: str(d.locationId, "地點", { optional: true, max: 40 }) || null,
        orderNo,
        status: "pending",
        shiftId,
        businessDate: taipeiDate(),
        cashier: actor.uid,
        cashierName: actor.name,
        device: d.device ?? null,
        guests: d.guests ? int(d.guests, "人數", { min: 0, max: 999 }) : null,
        note: str(d.note, "備註", { optional: true, max: 300 }) || null,
        shopper,
        lines,
        promotions: promo.applied,
        coupons: couponCheck.coupons,
        promoTotal,
        itemCount: lines.reduce((s, l) => s + l.qty, 0),
        subtotal,
        memberTier: tier?.name ?? null,
        memberDiscountPct,
        memberDiscount,
        birthdayMonth,
        pointMultiplier,
        orderDiscountPct,
        orderDiscount,
        serviceFeePct,
        serviceFee,
        allowance,
        rewardPoints,
        rewardDiscount,
        total,
        payments,
        paid,
        change,
        pointsDeducted: false,
        rewardEarned: 0,
        refunds: [],
        refundShiftIds: [],
        exchange,
        exchangeReturned: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
  const order = (await ref.get()).data()!;

  // --- 換貨：先把退回的商品加回庫存（失敗時整單停在 pending，同一個 id 重送會接著做） ---
  if (order.exchange && !order.exchangeReturned) {
    await processExchangeReturn(actor, id, order);
    await ref.update({ exchangeReturned: true });
  }

  // --- 2. 扣購物金（失敗就整單取消，庫存還沒動） ---
  if (order.rewardPoints > 0 && !order.pointsDeducted) {
    try {
      await meep.deductRewardPoints(order.shopper.id, order.rewardPoints);
      await ref.update({ pointsDeducted: true });
    } catch (e) {
      const unknown = e instanceof meep.MeepError && e.kind === "unknown";
      await ref.update({ status: "canceled", error: errMsg(e), rewardDeductUnknown: unknown });
      throw new HttpsError(
        "failed-precondition",
        unknown
          ? `購物金扣抵結果不明，這張單已取消。請到 meepShop 後台查這位會員的購物金：若已被扣，請手動補回後再重新結帳。（${e.message}）`
          : `購物金扣抵失敗：${errMsg(e)}`
      );
    }
  }

  // --- 3. 每個商品一筆「門市售出」異動，bulkAdjustStockQuantity 一次扣 ---
  const moveIds: string[] = [];
  for (let i = 0; i < order.lines.length; i++) {
    const l = order.lines[i] as Line;
    const moveId = `${id}_${i}`;
    await createMovement({ id: moveId, variantId: l.variantId, type: "sale", delta: -l.qty, ref: id, note: order.orderNo, device: order.device, status: "processing", locationId: order.locationId ?? null }, actor);
    moveIds.push(moveId);
  }
  await ref.update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
  if (order.coupons?.length) await consumeCoupons(id, order.coupons);
  const changed = (order.lines as Line[]).filter((l) => l.unitPrice !== l.listPrice || l.discountPct > 0);
  if (changed.length || order.orderDiscount || order.allowance) {
    await audit(actor, "pos.discount", { orderId: id, orderNo: order.orderNo, priceChanges: changed.map((l) => ({ title: `${l.productTitle} ${l.options}`, listPrice: l.listPrice, unitPrice: l.unitPrice, discountPct: l.discountPct })), orderDiscountPct: order.orderDiscountPct, allowance: order.allowance });
  }
  await pushBulk(moveIds);

  // --- 4. 回饋購物金 ---
  const reward = order.shopper && order.total > 0 ? rewardFor(settings, order.total, order.shopper.group ?? null, order.shopper.tier ?? null) : null;
  if (order.shopper && reward) {
    const earned = Math.floor(reward.points * (order.pointMultiplier || 1));
    if (earned > 0) {
      try {
        await meep.sendRewardPoints(order.shopper.id, earned, `門市消費回饋 ${order.orderNo}（${reward.rule}）`, reward.expiryDays);
        await ref.update({ rewardEarned: earned, rewardEarnStatus: "ok", rewardRule: reward.rule });
      } catch (e) {
        await ref.update({ rewardEarned: 0, rewardEarnStatus: `failed: ${errMsg(e)}` });
      }
    }
  }
  // --- 4b. 顧客名單即時更新（消費、已用購物金、餘額）；每天凌晨的重算會再校正一次 ---
  if (order.shopper) {
    try {
      const first = await db.runTransaction(async (tx) => {
        const o = (await tx.get(ref)).data();
        if (o?.shopperStatsApplied) return false;
        tx.update(ref, { shopperStatsApplied: true });
        return true;
      });
      if (first) {
        const used = Math.max(0, order.rewardPoints ?? 0); // 走到這裡代表購物金已扣成功
        const patch: Record<string, unknown> = {
          spend12m: FieldValue.increment(order.total),
          spendStore12m: FieldValue.increment(order.total),
          spendTotal: FieldValue.increment(order.total),
          ordersTotal: FieldValue.increment(1),
          orders12m: FieldValue.increment(1),
          orders6m: FieldValue.increment(1),
          orders3m: FieldValue.increment(1),
          orders1m: FieldValue.increment(1),
          spend6m: FieldValue.increment(order.total),
          spend3m: FieldValue.increment(order.total),
          spend1m: FieldValue.increment(order.total),
          lastOrderAt: FieldValue.serverTimestamp(),
          pointsUsed: FieldValue.increment(used),
          pointsUsedStore: FieldValue.increment(used),
        };
        const live = await meep.getShopper(order.shopper.id).catch(() => null);
        if (live) patch.points = live.usableRewardPoints;
        await db.doc(`shoppers/${order.shopper.id}`).set(patch, { merge: true });
      }
    } catch (e) {
      logger.warn(`shopper stats ${id}`, e);
    }
  }
  // --- 5. 電子發票（啟用時；失敗不影響交易，可在交易瀏覽重開） ---
  await issueForOrder(id);
  if (d.holdId) await db.doc(`posHolds/${str(d.holdId, "掛單", { max: 64 })}`).delete().catch(() => undefined);
  return summarize(id);
});

async function summarize(id: string) {
  const o = (await db.doc(`posOrders/${id}`).get()).data()!;
  const moves = await db.collection("movements").where("ref", "==", id).get();
  const stockIssues = moves.docs
    .map((m) => m.data())
    .filter((m) => m.type === "sale" && m.status !== "synced")
    .map((m) => ({ title: `${m.productTitle} ${m.options}`.trim(), status: m.status, error: m.error }));
  return { id, orderNo: o.orderNo, status: o.status, total: o.total, change: o.change, rewardEarned: o.rewardEarned ?? 0, stockIssues, invoice: o.invoice ?? null, invoiceError: o.invoiceError ?? null };
}

// ---------- refund / void ----------

async function canRefund(actor: Actor) {
  if (atLeast(actor.role, "manager")) return;
  const s = await shopSettings();
  if (!s.staffCanRefund) throw new HttpsError("permission-denied", "退貨 / 作廢限店長以上");
}

/** The amounts a refund of these lines would give back (pure; used by refunds and exchange quotes). */
function planRefund(o: FirebaseFirestore.DocumentData, wanted: { index: number; qty: number }[]) {
  assert(["completed", "partial"].includes(o.status), "這張單不能退換貨（已作廢或已全退）", "failed-precondition");
  const lines: Line[] = o.lines.map((l: Line) => ({ ...l }));
  const picked = wanted.filter((w) => w.qty > 0);
  assert(picked.length, "沒有選擇要退的商品");
  let gross = 0;
  for (const w of picked) {
    const l = lines[w.index];
    assert(l, "商品項目不正確");
    assert(w.qty <= l.qty - l.refundedQty, `${l.productTitle} 最多只能退 ${l.qty - l.refundedQty} 件`);
    l.refundedQty += w.qty;
    gross += (l.total * w.qty) / l.qty;
  }
  const ratio = o.subtotal > 0 ? gross / o.subtotal : 0;
  const allBack = lines.every((l) => l.refundedQty === l.qty);
  const prevAmount = (o.refunds ?? []).reduce((s: number, r: { amount: number }) => s + r.amount, 0);
  const prevPoints = (o.refunds ?? []).reduce((s: number, r: { pointsReturned: number }) => s + r.pointsReturned, 0);
  const prevReclaim = (o.refunds ?? []).reduce((s: number, r: { pointsReclaimed: number }) => s + r.pointsReclaimed, 0);
  // The last refund takes whatever is left, so rounding never leaves a 1-dollar gap.
  const amount = allBack ? o.total - prevAmount : Math.min(o.total - prevAmount, Math.round(o.total * ratio));
  const pointsReturned = allBack ? o.rewardPoints - prevPoints : Math.round(o.rewardPoints * ratio);
  const pointsReclaimed = allBack ? (o.rewardEarned ?? 0) - prevReclaim : Math.round((o.rewardEarned ?? 0) * ratio);
  return { lines, picked, amount, pointsReturned, pointsReclaimed, allBack };
}

async function doRefund(
  actor: Actor,
  orderId: string,
  refundId: string,
  wanted: { index: number; qty: number }[],
  method: Method | "original",
  reason: string,
  isVoid: boolean,
  explicitPayments?: { method: Method; amount: number }[],
  locationId?: string | null
) {
  const ref = db.doc(`posOrders/${orderId}`);
  const settings = await shopSettings();
  const shiftId = currentShift(settings, locationId);
  assert(shiftId, "請先到「錢櫃」開班", "failed-precondition");

  const plan = await db.runTransaction(async (tx) => {
    const o = (await tx.get(ref)).data();
    assert(o, "找不到這張單", "not-found");
    const done = (o.refunds ?? []).find((r: { id: string }) => r.id === refundId);
    if (done) return { already: true as const, o };
    const { lines, picked, amount, pointsReturned, pointsReclaimed, allBack } = planRefund(o, wanted);

    let refundPayments: { method: Method; amount: number; ref?: string }[];
    if (explicitPayments) {
      refundPayments = explicitPayments;
    } else if (method === "original") {
      // Pay back the original way: card / LINE Pay / transfer first in full, the rest in cash
      // (exchange credit is paid back as cash).
      let left = amount;
      refundPayments = [];
      for (const p of o.payments.filter((x: { method: Method }) => x.method !== "cash" && x.method !== "exchange")) {
        const a = Math.min(left, p.amount);
        if (a > 0) refundPayments.push({ method: p.method, amount: a, ...((p as { ref?: string }).ref ? { ref: (p as { ref?: string }).ref } : {}) });
        left -= a;
      }
      if (left > 0) refundPayments.push({ method: "cash", amount: left });
    } else {
      refundPayments = [{ method, amount }];
    }
    const record = {
      id: refundId,
      at: Timestamp.now(),
      by: actor.uid,
      byName: actor.name,
      shiftId,
      lines: picked,
      amount,
      payments: refundPayments,
      pointsReturned,
      pointsReclaimed,
      reason,
      void: isVoid,
    };
    tx.update(ref, {
      lines,
      refunds: FieldValue.arrayUnion(record),
      refundShiftIds: FieldValue.arrayUnion(shiftId),
      status: isVoid ? "void" : allBack ? "refunded" : "partial",
    });
    return { already: false as const, o, record };
  });
  if (plan.already) return { refundId, already: true };
  await audit(actor, isVoid ? "pos.void" : "pos.refund", { orderId, orderNo: plan.o.orderNo, amount: plan.record.amount, lines: plan.record.lines, reason, payments: plan.record.payments });

  const o = plan.o;
  const moveIds: string[] = [];
  for (const w of plan.record.lines) {
    const l = o.lines[w.index] as Line;
    const moveId = `${refundId}_${w.index}`;
    await createMovement({ id: moveId, variantId: l.variantId, type: "refund", delta: w.qty, ref: orderId, note: `${o.orderNo} ${isVoid ? "作廢" : "退貨"}`, status: "processing", locationId: locationId ?? o.locationId ?? null }, actor);
    moveIds.push(moveId);
  }
  await pushBulk(moveIds);

  const notes: string[] = [];
  for (const p of plan.record.payments) {
    if (p.method === "linepay") {
      // 串接扣款的 LINE Pay 自動退回客人帳戶；手動記帳的照舊請店員另外處理
      const ref = (p as { ref?: string }).ref ?? (o.payments as { method: string; ref?: string }[]).find((x) => x.method === "linepay" && x.ref)?.ref;
      if (ref) {
        try {
          await refundLinePay(ref, p.amount);
        } catch (e) {
          notes.push(`LINE Pay 自動退款 $${p.amount} 失敗：${errMsg(e)}。請到 LINE Pay 商家中心手動退款`);
        }
      }
    }
    if (p.method === "ecpay" || p.method === "newebpay") notes.push(`${p.method === "ecpay" ? "綠界" : "藍新"}線上付款 $${p.amount}：請到${p.method === "ecpay" ? "綠界" : "藍新"}商店後台辦理退款`);
  }
  if (o.shopper && plan.record.pointsReturned > 0 && o.pointsDeducted) {
    try {
      await meep.sendRewardPoints(o.shopper.id, plan.record.pointsReturned, `門市退貨退回購物金 ${o.orderNo}`);
    } catch (e) {
      notes.push(`退回購物金失敗：${errMsg(e)}`);
    }
  }
  if (o.shopper && plan.record.pointsReclaimed > 0) {
    try {
      await meep.deductRewardPoints(o.shopper.id, plan.record.pointsReclaimed);
    } catch (e) {
      notes.push(`收回回饋購物金失敗：${errMsg(e)}`);
    }
  }
  await invoiceAfterRefund(orderId, isVoid || plan.record.lines.length > 0 && (await db.doc(`posOrders/${orderId}`).get()).data()?.status === "refunded", isVoid ? "作廢" : "退貨");
  if (notes.length) {
    logger.warn(`refund ${refundId}`, notes);
    await db.doc(`posOrders/${orderId}`).update({ refundNotes: FieldValue.arrayUnion(...notes) });
  }
  return { refundId, amount: plan.record.amount, payments: plan.record.payments, notes };
}

export const posRefund = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "staff");
  await canRefund(actor);
  const d = req.data ?? {};
  const method = d.method === "original" || manualMethod(d.method, await shopSettings()) ? d.method : "original";
  const lines = (Array.isArray(d.lines) ? d.lines : []).map((l: Record<string, unknown>) => ({ index: int(l.index, "項目", { min: 0, max: 99 }), qty: int(l.qty, "數量", { min: 0, max: 999 }) }));
  return doRefund(actor, str(d.orderId, "訂單", { max: 64 }), str(d.refundId, "退貨 id", { max: 64 }), lines, method, str(d.reason, "原因", { optional: true, max: 200 }), false, undefined, str(d.locationId, "地點", { optional: true, max: 40 }) || null);
});

/** 作廢：整單退回（加回庫存、退回購物金），用原付款方式退款 */
export const posVoid = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "staff");
  await canRefund(actor);
  const orderId = str(req.data?.orderId, "訂單", { max: 64 });
  const o = (await db.doc(`posOrders/${orderId}`).get()).data();
  assert(o, "找不到這張單", "not-found");
  const lines = (o.lines as Line[]).map((l, index) => ({ index, qty: l.qty - l.refundedQty }));
  return doRefund(actor, orderId, `void_${orderId}`, lines, "original", str(req.data?.reason, "原因", { optional: true, max: 200 }) || "作廢", true, undefined, str(req.data?.locationId, "地點", { optional: true, max: 40 }) || null);
});

// ---------- 編輯已完成的單（只限不影響庫存、金額的欄位） ----------

/**
 * 交易瀏覽「編輯」：
 *  - 備註（整單、各商品）：員工以上
 *  - 付款方式更正（例：刷卡記成現金）：店長以上，而且那一班還沒結班（結班後現金已點收，不能再改）
 * 商品、數量、金額要改請用退貨／換貨（才會同步庫存、購物金、發票）。每次修改都留紀錄。
 */
export const posEditOrder = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const orderId = str(req.data?.orderId, "訂單", { max: 64 });
  const ref = db.doc(`posOrders/${orderId}`);
  const changes: string[] = [];
  // 更換商品（例：先用「新品」結帳，上架後換成真正的商品）：價格不變，庫存一加一減
  const swaps: { index: number; from: string; to: string; qty: number; moveBase: string }[] = [];
  const order0 = (await ref.get()).data();
  const shopCfg = await shopSettings();
  const swapReq = Array.isArray(req.data?.replace) ? (req.data.replace as { index: number; variantId: string }[]) : [];
  const newVariants = new Map<string, FirebaseFirestore.DocumentData>();
  for (const r of swapReq) {
    const v = (await db.doc(`variants/${str(r.variantId, "商品", { max: 100 })}`).get()).data();
    assert(v, "找不到要換成的商品", "not-found");
    newVariants.set(r.variantId, v);
  }
  await db.runTransaction(async (tx) => {
    const o = (await tx.get(ref)).data();
    assert(o, "找不到這張單", "not-found");
    assert(["completed", "partial", "refunded"].includes(o.status), "這張單不能編輯", "failed-precondition");
    const patch: Record<string, unknown> = {};
    if (req.data?.note !== undefined) {
      const note = str(req.data.note, "備註", { optional: true, max: 300 }) || "";
      if (note !== (o.note ?? "")) {
        patch.note = note;
        changes.push(`整單備註：${o.note || "（空）"} → ${note || "（空）"}`);
      }
    }
    if (Array.isArray(req.data?.lineNotes)) {
      const lines = (o.lines as Line[]).map((l) => ({ ...l }));
      for (const x of req.data.lineNotes as { index: number; note: string }[]) {
        const i = int(x.index, "第幾項", { min: 0, max: lines.length - 1 });
        const note = str(x.note, "備註", { optional: true, max: 100 }) || null;
        if ((lines[i].note ?? null) !== note) {
          changes.push(`${lines[i].productTitle} 備註：${lines[i].note || "（空）"} → ${note || "（空）"}`);
          lines[i].note = note;
        }
      }
      patch.lines = lines;
    }
    if (swapReq.length) {
      const lines = ((patch.lines as Line[] | undefined) ?? (o.lines as Line[]).map((l) => ({ ...l })));
      const n = (o.edits ?? []).length;
      for (const r of swapReq) {
        const i = int(r.index, "第幾項", { min: 0, max: lines.length - 1 });
        const l = lines[i];
        const v = newVariants.get(r.variantId)!;
        if (l.variantId === r.variantId) continue;
        assert(!l.refundedQty, `${l.productTitle} 已經退過貨，不能更換商品`, "failed-precondition");
        swaps.push({ index: i, from: l.variantId, to: r.variantId, qty: l.qty, moveBase: `swap_${orderId}_${i}_${n}` });
        changes.push(`更換商品：${l.productTitle} ${l.options} → ${v.productTitle} ${v.options ?? ""}（${l.qty} 件，金額不變）`);
        lines[i] = { ...l, variantId: r.variantId, productTitle: v.productTitle, options: v.options ?? "", sku: v.sku ?? null, listPrice: v.price ?? 0, replacedFrom: { variantId: l.variantId, productTitle: l.productTitle, options: l.options } } as Line;
      }
      patch.lines = lines;
    }
    if (Array.isArray(req.data?.payments)) {
      assert(atLeast(actor.role, "manager"), "更正付款方式限店長以上", "permission-denied");
      const shift = o.shiftId ? (await tx.get(db.doc(`shifts/${o.shiftId}`))).data() : undefined;
      assert(shift && shift.status !== "closed", "這一班已經結班，不能再改付款方式（請改用退貨後重新結帳）", "failed-precondition");
      const old = o.payments as { method: string; amount: number; ref?: string }[];
      assert(!old.some((p) => p.ref || p.method === "exchange" || ONLINE_METHODS.includes(p.method)), "線上付款、換貨抵用的單不能改付款方式", "failed-precondition");
      const pays = (req.data.payments as Record<string, unknown>[])
        .map((p) => {
          assert(manualMethod(p.method, shopCfg), "付款方式不正確");
          return { method: p.method as Method, amount: num(p.amount, "付款金額", { min: 0, max: 1e8 }) };
        })
        .filter((p) => p.amount > 0);
      const paid = pays.reduce((a, p) => a + p.amount, 0);
      const nonCash = pays.filter((p) => p.method !== "cash").reduce((a, p) => a + p.amount, 0);
      assert(paid >= o.total, `付款合計 $${paid} 少於應收 $${o.total}`);
      assert(nonCash <= o.total, "刷卡、LINE Pay、轉帳不能超過應收金額（只有現金可以找零）");
      patch.payments = pays;
      patch.change = paid - o.total;
      changes.push(`付款：${old.map((p) => `${p.method} ${p.amount}`).join("+")} → ${pays.map((p) => `${p.method} ${p.amount}`).join("+")}`);
    }
    if (!changes.length) return;
    patch.edits = FieldValue.arrayUnion({ at: Timestamp.now(), by: actor.name, changes });
    tx.update(ref, patch);
  });
  if (changes.length) await audit(actor, "pos.edit", { orderId, changes });
  // 庫存：原商品加回、新商品扣掉（同步到 meepShop）
  const moveIds: string[] = [];
  for (const w of swaps) {
    const note = `${order0?.orderNo ?? orderId} 更換商品`;
    await createMovement({ id: `${w.moveBase}_back`, variantId: w.from, type: "refund", delta: w.qty, ref: orderId, note, status: "processing", locationId: order0?.locationId ?? null }, actor);
    await createMovement({ id: `${w.moveBase}_out`, variantId: w.to, type: "sale", delta: -w.qty, ref: orderId, note, status: "processing", locationId: order0?.locationId ?? null }, actor);
    moveIds.push(`${w.moveBase}_back`, `${w.moveBase}_out`);
  }
  if (moveIds.length) await pushBulk(moveIds);
  return { changes };
});

// ---------- exchange (換貨) ----------

type ExchangeInput =
  | { kind: "pos"; orderId: string; lines: { index: number; qty: number }[] }
  | { kind: "online"; orderNumber: string; lines: { variantId: string; qty: number }[] };

interface ExchangeQuote {
  kind: "pos" | "online";
  orderId: string | null;
  orderNumber: string | null;
  orderNo: string;
  lines: { index?: number; variantId: string; qty: number; title: string; amount: number }[];
  credit: number;
}

async function onlineOrder(orderNumber: string) {
  const page = await meep.ordersPage({ first: 1, query: { orderNumber: [orderNumber] } });
  const o = page.edges[0]?.node;
  assert(o, `找不到網店訂單 ${orderNumber}`, "not-found");
  assert(o.status !== "CANCELED", "這張網店訂單已取消", "failed-precondition");
  return o;
}

/** How much the returned items are worth (what the customer actually paid for them). */
async function quoteExchange(raw: Record<string, unknown>): Promise<ExchangeQuote> {
  const ex = raw as unknown as ExchangeInput;
  if (ex.kind === "pos") {
    const orderId = str(ex.orderId, "原訂單", { max: 64 });
    const o = (await db.doc(`posOrders/${orderId}`).get()).data();
    assert(o, "找不到原訂單", "not-found");
    const wanted = (ex.lines ?? []).map((l) => ({ index: int(l.index, "項目", { min: 0, max: 99 }), qty: int(l.qty, "數量", { min: 0, max: 999 }) }));
    const plan = planRefund(o, wanted);
    const gross = plan.picked.reduce((s, w) => s + (o.lines[w.index].total * w.qty) / o.lines[w.index].qty, 0);
    return {
      kind: "pos",
      orderId,
      orderNumber: null,
      orderNo: o.orderNo,
      lines: plan.picked.map((w) => {
        const l = o.lines[w.index] as Line;
        return { index: w.index, variantId: l.variantId, qty: w.qty, title: `${l.productTitle} ${l.options}`.trim(), amount: gross ? Math.round((plan.amount * ((l.total * w.qty) / l.qty)) / gross) : 0 };
      }),
      credit: plan.amount,
    };
  }
  assert(ex.kind === "online", "換貨來源不正確");
  const orderNumber = str(ex.orderNumber, "網店訂單編號", { max: 40 });
  const o = await onlineOrder(orderNumber);
  const done = (await db.doc(`onlineReturns/${orderNumber}`).get()).data()?.qty ?? {};
  const lines = (ex.lines ?? [])
    .map((l) => ({ variantId: str(l.variantId, "款式", { max: 100 }), qty: int(l.qty, "數量", { min: 0, max: 999 }) }))
    .filter((l) => l.qty > 0)
    .map((l) => {
      const li = (o.lineItems ?? []).find((x) => x.variant?.id === l.variantId);
      assert(li, "這張網店訂單沒有這個商品");
      const left = li.quantity - (done[l.variantId] ?? 0);
      assert(l.qty <= left, `${li.title} 最多只能換 ${left} 件`);
      return { variantId: l.variantId, qty: l.qty, title: li.title, amount: Math.round((li.totalPrice / li.quantity) * l.qty) };
    });
  assert(lines.length, "沒有選擇要換的商品");
  return { kind: "online", orderId: null, orderNumber, orderNo: orderNumber, lines, credit: lines.reduce((s, l) => s + l.amount, 0) };
}

async function processExchangeReturn(actor: Actor, newOrderId: string, order: FirebaseFirestore.DocumentData) {
  const ex = order.exchange as ExchangeQuote & { refundDue: number; refundMethod: Method };
  const used = ex.credit - ex.refundDue;
  const payments: { method: Method; amount: number }[] = [];
  if (used > 0) payments.push({ method: "exchange", amount: used });
  if (ex.refundDue > 0) payments.push({ method: ex.refundMethod, amount: ex.refundDue });

  if (ex.kind === "pos") {
    await doRefund(actor, ex.orderId!, `ex_${newOrderId}`, ex.lines.map((l) => ({ index: l.index!, qty: l.qty })), "original", `換貨 → ${order.orderNo}`, false, payments, order.locationId ?? null);
    return;
  }
  // 網店訂單：記錄已換數量（防止同一件換兩次），把商品加回 meepShop 庫存
  const retRef = db.doc(`onlineReturns/${ex.orderNumber}`);
  const fresh = await onlineOrder(ex.orderNumber!);
  await db.runTransaction(async (tx) => {
    const r = (await tx.get(retRef)).data() ?? { qty: {}, exchanges: [] };
    if ((r.exchanges ?? []).some((e: { orderId: string }) => e.orderId === newOrderId)) return;
    for (const l of ex.lines) {
      const li = (fresh.lineItems ?? []).find((x) => x.variant?.id === l.variantId);
      const left = (li?.quantity ?? 0) - (r.qty[l.variantId] ?? 0);
      assert(l.qty <= left, `${l.title} 已經換過，最多只能再換 ${Math.max(0, left)} 件`, "failed-precondition");
      r.qty[l.variantId] = (r.qty[l.variantId] ?? 0) + l.qty;
    }
    tx.set(retRef, {
      qty: r.qty,
      exchanges: [...(r.exchanges ?? []), { orderId: newOrderId, orderNo: order.orderNo, lines: ex.lines, credit: ex.credit, payments, by: actor.name, shiftId: order.shiftId, at: Timestamp.now() }],
    });
  });
  const moveIds: string[] = [];
  for (let i = 0; i < ex.lines.length; i++) {
    const l = ex.lines[i];
    const moveId = `${newOrderId}_ret_${i}`;
    await createMovement({ id: moveId, variantId: l.variantId, type: "refund", delta: l.qty, ref: newOrderId, note: `網店訂單 ${ex.orderNumber} 門市換貨`, status: "processing", locationId: order.locationId ?? null }, actor);
    moveIds.push(moveId);
  }
  await pushBulk(moveIds);
  if (ex.refundDue > 0) await db.doc(`posOrders/${newOrderId}`).update({ exchangeRefundShiftId: order.shiftId });
}

/** 換貨試算：退回這些商品可以抵多少 */
export const exchangeQuote = onCall({ ...opts, timeoutSeconds: 60 }, async (req) => {
  const actor = await requireRole(req, "staff");
  await canRefund(actor);
  return quoteExchange(req.data?.exchange ?? {});
});

// ---------- shifts / cash drawer ----------

export const openShift = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const float = num(req.data?.float ?? 0, "零用金", { min: 0, max: 1e7 });
  const name = str(req.data?.name, "班別", { optional: true, max: 20 }) || "早班";
  const loc = str(req.data?.locationId, "門市", { optional: true, max: 40 });
  const sRef = db.doc("settings/shop");
  const shiftRef = db.collection("shifts").doc();
  await db.runTransaction(async (tx) => {
    const s = (await tx.get(sRef)).data() ?? {};
    assert(!currentShift(s, loc), "已經有開著的班，請先日結交班", "failed-precondition");
    tx.set(shiftRef, { name, businessDate: taipeiDate(), status: "open", float, cashMoves: [], openedBy: actor.uid, openedByName: actor.name, openedAt: FieldValue.serverTimestamp(), locationId: loc || null });
    tx.set(sRef, { currentShifts: { [shiftKey(loc)]: shiftRef.id }, ...(shiftKey(loc) === "main" ? { currentShiftId: shiftRef.id } : {}) }, { merge: true });
  });
  return { id: shiftRef.id };
});

export const cashMove = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const shiftId = currentShift(await shopSettings(), req.data?.locationId);
  assert(shiftId, "目前沒有開班", "failed-precondition");
  const type = req.data?.type === "out" ? "out" : "in";
  const amount = num(req.data?.amount, "金額", { min: 1, max: 1e7 });
  const note = str(req.data?.note, "說明", { optional: true, max: 100 }) || null;
  const expenseCategory = type === "out" ? str(req.data?.expenseCategory, "開支分類", { optional: true, max: 30 }) : "";
  // 歸屬月份（例：這個月的薪水下個月初才發 → 記到上個月）：YYYY-MM；不是本月就記在那個月最後一天
  const today = taipeiDate();
  let expenseDate = today;
  const month = str(req.data?.expenseMonth, "歸屬月份", { optional: true, max: 7 });
  if (expenseCategory && month && month !== today.slice(0, 7)) {
    assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month < today.slice(0, 7), "歸屬月份要是過去的月份");
    const [y, m] = month.split("-").map(Number);
    expenseDate = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  await db.doc(`shifts/${shiftId}`).update({
    cashMoves: FieldValue.arrayUnion({ id: db.collection("x").doc().id, type, amount, note, by: actor.name, at: Timestamp.now(), expenseCategory: expenseCategory || null, expenseDate: expenseCategory ? expenseDate : null }),
  });
  // 錢櫃提款同時記為開支（例如付貨運、買文具）
  if (expenseCategory) {
    await db.collection("expenses").add({ date: expenseDate, category: expenseCategory, amount, note, payMethod: "cash", source: "drawer", shiftId, locationId: str(req.data?.locationId, "門市", { optional: true, max: 40 }) || null, createdBy: actor.uid, createdByName: actor.name, createdAt: FieldValue.serverTimestamp() });
  }
  await audit(actor, "drawer." + type, { amount, note, expenseCategory: expenseCategory || null, expenseDate: expenseCategory ? expenseDate : null, shiftId });
  return { ok: true };
});

async function computeShift(shiftId: string) {
  const shift = (await db.doc(`shifts/${shiftId}`).get()).data();
  assert(shift, "找不到這個班", "not-found");
  const [sales, refunded, onlineExchanges] = await Promise.all([
    db.collection("posOrders").where("shiftId", "==", shiftId).get(),
    db.collection("posOrders").where("refundShiftIds", "array-contains", shiftId).get(),
    db.collection("posOrders").where("exchangeRefundShiftId", "==", shiftId).get(),
  ]);
  const bucket = (m: string) => (byMethod[m] ??= { sales: 0, refunds: 0 });
  const byMethod: Record<string, { sales: number; refunds: number }> = Object.fromEntries([...METHODS, "exchange"].map((m) => [m, { sales: 0, refunds: 0 }]));
  let orders = 0;
  let total = 0;
  let rewardPoints = 0;
  for (const doc of sales.docs) {
    const o = doc.data();
    if (o.status === "pending" || o.status === "canceled") continue;
    orders++;
    total += o.total;
    rewardPoints += o.rewardPoints ?? 0;
    let changeLeft = o.change ?? 0;
    for (const p of o.payments) {
      let amt = p.amount;
      if (p.method === "cash" && changeLeft > 0) {
        const c = Math.min(changeLeft, amt);
        amt -= c;
        changeLeft -= c;
      }
      bucket(p.method).sales += amt;
    }
  }
  let refundTotal = 0;
  for (const doc of refunded.docs) {
    for (const r of doc.data().refunds ?? []) {
      if (r.shiftId !== shiftId) continue;
      refundTotal += r.amount;
      for (const p of r.payments) bucket(p.method).refunds += p.amount;
    }
  }
  // 網店訂單門市換貨：退給客人的差額
  for (const doc of onlineExchanges.docs) {
    const ex = doc.data().exchange;
    if (!ex?.refundDue) continue;
    refundTotal += ex.refundDue;
    bucket(ex.refundMethod).refunds += ex.refundDue;
  }
  const ins = (shift.cashMoves ?? []).filter((m: { type: string }) => m.type === "in").reduce((s: number, m: { amount: number }) => s + m.amount, 0);
  const outs = (shift.cashMoves ?? []).filter((m: { type: string }) => m.type === "out").reduce((s: number, m: { amount: number }) => s + m.amount, 0);
  const expectedCash = shift.float + byMethod.cash.sales - byMethod.cash.refunds + ins - outs;
  const shiftData: FirebaseFirestore.DocumentData = { id: shiftId, ...shift };
  return { shift: shiftData, orders, total, refundTotal, rewardPoints, byMethod, ins, outs, expectedCash };
}

export const shiftSummary = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const shiftId = req.data?.shiftId || currentShift(await shopSettings(), req.data?.locationId);
  assert(shiftId, "目前沒有開班", "failed-precondition");
  const s = await computeShift(shiftId);
  return { ...s, shift: { ...s.shift, openedAt: s.shift.openedAt?.toMillis?.() ?? null, closedAt: s.shift.closedAt?.toMillis?.() ?? null, cashMoves: (s.shift.cashMoves ?? []).map((m: { at: Timestamp }) => ({ ...m, at: m.at.toMillis() })) } };
});

/** 日結交班：各付款方式小計、現金點收、差額 */
export const closeShift = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const sRef = db.doc("settings/shop");
  const shiftId = currentShift(await shopSettings(), req.data?.locationId);
  assert(shiftId, "目前沒有開班", "failed-precondition");
  const countedCash = num(req.data?.countedCash, "實點現金", { min: 0, max: 1e8 });
  const s = await computeShift(shiftId);
  await db.doc(`shifts/${shiftId}`).update({
    status: "closed",
    closedBy: actor.uid,
    closedByName: actor.name,
    closedAt: FieldValue.serverTimestamp(),
    countedCash,
    expectedCash: s.expectedCash,
    cashDiff: countedCash - s.expectedCash,
    summary: { orders: s.orders, total: s.total, refundTotal: s.refundTotal, rewardPoints: s.rewardPoints, byMethod: s.byMethod, ins: s.ins, outs: s.outs },
    closeNote: str(req.data?.note, "備註", { optional: true, max: 300 }) || null,
  });
  await audit(actor, "shift.close", { shiftId, expectedCash: s.expectedCash, countedCash, diff: countedCash - s.expectedCash });
  const k = shiftKey(req.data?.locationId);
  await sRef.set({ currentShifts: { [k]: null }, ...(k === "main" ? { currentShiftId: null } : {}) }, { merge: true });
  return { expectedCash: s.expectedCash, countedCash, diff: countedCash - s.expectedCash };
});

// ---------- online (meepShop) orders ----------

export const listOnlineOrders = onCall({ ...opts, timeoutSeconds: 60 }, async (req) => {
  await requireRole(req, "staff");
  const d = req.data ?? {};
  const query: Record<string, unknown> = {};
  if (d.orderNumber) query.orderNumber = [str(d.orderNumber, "訂單編號", { max: 40 })];
  else {
    const days = int(d.days ?? 14, "天數", { min: 1, max: 180 });
    query.createdAt = { start: new Date(Date.now() - days * 86400_000).toISOString() };
    if (d.shipmentStatus) query.shipmentStatus = str(d.shipmentStatus, "出貨狀態", { max: 30 });
  }
  const page = await meep.ordersPage({ first: 30, after: d.after ?? null, query });
  return { total: page.total, next: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null, orders: page.edges.flatMap((e) => (e.node ? [e.node] : [])) };
});

/** 網店待出貨：近 N 天、還沒出貨（處理中／備貨中／缺貨／預購）的有效訂單，含收件資料與商品 */
export const pendingShipments = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  await requireRole(req, "staff");
  const days = int(req.data?.days ?? 60, "天數", { min: 1, max: 180 });
  const out: meep.ShipOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const p = await meep.shipOrdersPage({ after, query: { createdAt: { start: new Date(Date.now() - days * 86400_000).toISOString() } } });
    for (const e of p.edges) {
      const o = e.node;
      if (o && o.status === "PROCESSING" && ["PROCESSING", "PREPARING", "OUT_OF_STOCK", "PRE_ORDER"].includes(o.shipmentStatus)) out.push(o);
    }
    if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor) break;
    after = p.pageInfo.endCursor;
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // 先下單的先出
  return { orders: out };
});

export const updateShipment = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const status = str(req.data?.status, "出貨狀態", { max: 30 });
  assert(["PROCESSING", "PREPARING", "OUT_OF_STOCK", "FULFILLED", "PRE_ORDER"].includes(status), "出貨狀態不正確");
  try {
    await meep.updateOrderShipmentStatus(str(req.data?.orderNumber, "訂單編號", { max: 40 }), status);
  } catch (e) {
    throw new HttpsError("failed-precondition", errMsg(e));
  }
  return { ok: true };
});

// ---------- shoppers (members) ----------

export const searchShopper = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const q = str(req.data?.q, "手機或 Email", { max: 120 });
  let ids: string[] = [];
  if (q.includes("@")) {
    const found = await meep.shoppersByEmail(q.toLowerCase());
    ids = found.map((s) => s.id);
    for (const s of found) {
      await db.doc(`shoppers/${s.id}`).set({ email: s.email, emailLower: s.email.toLowerCase(), name: s.name ?? "", mobile: s.mobile ?? "", mobileKey: mobileKey(s.mobile), points: s.usableRewardPoints, updatedAt: s.updatedAt }, { merge: true });
    }
  } else {
    const key = mobileKey(q);
    assert(key && key.length >= 6, "請輸入完整手機號碼");
    const snap = await db.collection("shoppers").where("mobileKey", "==", key).limit(5).get();
    ids = snap.docs.map((d) => d.id);
  }
  const out = [];
  for (const id of ids) {
    let points: number | null = null;
    try {
      const live = await meep.getShopper(id);
      if (live) {
        points = live.usableRewardPoints;
        await db.doc(`shoppers/${id}`).update({ points, name: live.name ?? "", mobile: live.mobile ?? "", mobileKey: mobileKey(live.mobile), memberGroup: live.memberGroup?.title ?? null });
      }
    } catch {
      // fall back to cached points
    }
    const s = (await db.doc(`shoppers/${id}`).get()).data()!;
    out.push({ id, name: s.name, email: s.email, mobile: s.mobile, points: points ?? s.points ?? 0, live: points !== null, tier: s.tier ?? null, birthMonth: s.birthMonth ?? null, spend12m: s.spend12m ?? 0, group: s.posGroup ?? s.memberGroup ?? null, meepGroup: s.memberGroup ?? null, posGroup: s.posGroup ?? null });
  }
  return { shoppers: out };
});

/**
 * 重新向 meepShop 讀一位會員（購物金、群組）。新會員的入會禮購物金、預設群組是 meepShop 建好之後才補上的，
 * POS 會在新增後幾秒再呼叫這個，畫面上的群組、購物金就會自己更新。
 */
export const refreshShopper = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const id = str(req.data?.id, "會員", { max: 64 });
  const live = await meep.getShopper(id);
  assert(live, "找不到這位會員", "not-found");
  const ref = db.doc(`shoppers/${id}`);
  const snap = await ref.get();
  await ref.set({ points: live.usableRewardPoints, name: live.name ?? "", mobile: live.mobile ?? "", mobileKey: mobileKey(live.mobile), memberGroup: live.memberGroup?.title ?? null, ...(live.birthDate ? { birthDate: live.birthDate } : {}) }, { merge: true });
  return { points: live.usableRewardPoints, group: snap.data()?.posGroup ?? live.memberGroup?.title ?? null, name: live.name ?? "" };
});

/** 會員的網店訂單（meepShop），會員頁和門市紀錄一起顯示 */
export const shopperOnlineOrders = onCall({ ...opts, timeoutSeconds: 60 }, async (req) => {
  await requireRole(req, "staff");
  const id = str(req.data?.id, "會員", { max: 64 });
  const page = await meep.ordersPage({ first: 50, query: { shopperId: id } });
  const orders = page.edges
    .map((e) => e.node)
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      status: o.status,
      paymentStatus: o.paymentStatus ?? null,
      shipmentStatus: o.shipmentStatus ?? null,
      total: o.totalPrice,
      pointsUsed: Math.round(o.rewardPointUsed ?? 0),
      items: (o.lineItems ?? []).map((l) => `${l.title}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { orders, more: page.pageInfo.hasNextPage };
});

/**
 * 會員標籤（本系統自己的，例：忠實顧客、關注新品、很在乎優惠）。meepShop 沒有標籤也不能改群組，所以存在 shoppers/{id}.tags；
 * 用過的標籤記在 meta/memberTags，給其他會員勾選。
 */
export const setShopperTags = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const id = str(req.data?.id, "會員", { max: 64 });
  const tags = [...new Set(((Array.isArray(req.data?.tags) ? req.data.tags : []) as unknown[]).map((t) => String(t ?? "").trim()).filter(Boolean))];
  assert(tags.length <= 15, "標籤最多 15 個");
  assert(tags.every((t) => [...t].length <= 12), "每個標籤最多 12 個字");
  const ref = db.doc(`shoppers/${id}`);
  assert((await ref.get()).exists, "找不到這位會員", "not-found");
  const prefNote = req.data?.prefNote === undefined ? undefined : str(req.data.prefNote, "喜好備註", { optional: true, max: 300 }) || "";
  await ref.update({ tags, ...(prefNote !== undefined ? { prefNote } : {}), tagsAt: FieldValue.serverTimestamp(), tagsBy: actor.name });
  if (tags.length) await db.doc("meta/memberTags").set({ tags: FieldValue.arrayUnion(...tags) }, { merge: true });
  return { tags };
});

/**
 * 門市指定群組（店長以上）：meepShop 群組不能用 API 改，這裡讓門市結帳時把客人當成某個群組
 * （折扣、購物金回饋都照這個群組算）。官網仍照 meepShop 的群組。group 傳 null = 取消，改回 meepShop 群組。
 */
export const setShopperGroup = onCall(opts, async (req) => {
  const actor = await requireRole(req, "manager");
  const id = str(req.data?.id, "會員", { max: 64 });
  const ref = db.doc(`shoppers/${id}`);
  const cur = (await ref.get()).data();
  assert(cur, "找不到這位會員", "not-found");
  const group = req.data?.group ? str(req.data.group, "群組", { max: 30 }) : null;
  if (group) assert(((await shopSettings()).memberGroups ?? []).includes(group), "沒有這個群組");
  await ref.update({ posGroup: group, posGroupBy: actor.name, posGroupAt: FieldValue.serverTimestamp() });
  await audit(actor, "member.group", { id, name: cur.name, from: cur.posGroup ?? cur.memberGroup ?? null, to: group });
  return { ok: true };
});

/** 從標籤清單移除（店長以上；已經貼在會員身上的不會被拿掉） */
export const removeMemberTag = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const tag = str(req.data?.tag, "標籤", { max: 12 });
  await db.doc("meta/memberTags").set({ tags: FieldValue.arrayRemove(tag) }, { merge: true });
  return { ok: true };
});

/** 顧客名單：把會員釘選在最上面（店長以上） */
export const setShopperPin = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const id = str(req.data?.id, "會員", { max: 64 });
  const pinned = req.data?.pinned === true;
  await db.doc(`shoppers/${id}`).update({ pinned, pinnedAt: pinned ? FieldValue.serverTimestamp() : null });
  return { pinned };
});

/** 現場新增會員（meepShop 規定一定要有 Email） */
export const createShopper = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const email = str(req.data?.email, "Email", { max: 120 }).toLowerCase();
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Email 格式不正確");
  const mobile = str(req.data?.mobile, "手機", { optional: true, max: 20 });
  const birthDate = birthDateInput(req.data?.birthDate);
  try {
    const s = await meep.createShopper({ email, name: str(req.data?.name, "姓名", { optional: true, max: 40 }) || undefined, mobile: mobile || undefined, birthDate });
    await db.doc(`shoppers/${s.id}`).set({ email: s.email, emailLower: s.email.toLowerCase(), name: s.name ?? "", mobile: s.mobile ?? "", mobileKey: mobileKey(s.mobile), points: s.usableRewardPoints ?? 0, memberGroup: s.memberGroup?.title ?? null, birthDate: s.birthDate ?? birthDate, birthMonth: birthDate.slice(5, 7), updatedAt: s.updatedAt ?? null, joinedAt: s.createdAt ?? new Date().toISOString() });
    await ensureMemberCodes([s.id]);
    return { id: s.id, name: s.name, email: s.email, mobile: s.mobile, points: s.usableRewardPoints ?? 0, group: s.memberGroup?.title ?? null, birthMonth: birthDate.slice(5, 7) };
  } catch (e) {
    throw new HttpsError("failed-precondition", `新增會員失敗：${errMsg(e)}`);
  }
});
