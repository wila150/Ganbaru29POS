import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { Actor, atLeast, requireRole } from "./lib/auth";
import * as meep from "./lib/meepshop";
import { createMovement, pushBulk } from "./lib/movements";
import { assert, db, errMsg, FieldValue, HttpsError, int, num, str, taipeiDate, Timestamp } from "./lib/util";
import { mobileKey } from "./sync";

/**
 * posOrders/{id}  id is generated on the tablet, so a double-tapped / re-sent checkout is stored once.
 * status: pending → completed | canceled ; later partial / refunded / void
 * shifts/{id}     one cashier shift (開班零用金、存提款、日結)
 * settings/shop.currentShiftId  the open shift (one register)
 */

const METHODS = ["cash", "card", "linepay", "transfer"] as const;
type Method = (typeof METHODS)[number];
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
  total: number;
  refundedQty: number;
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
  const shiftId = settings.currentShiftId as string | undefined;
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
      total: Math.round((unitPrice * qty * (100 - discountPct)) / 100),
      refundedQty: 0,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const orderDiscountPct = num(d.orderDiscountPct ?? 0, "整單折扣", { min: 0, max: 100 });
  const orderDiscount = Math.round((subtotal * orderDiscountPct) / 100);
  const serviceFeePct = num(d.serviceFeePct ?? 0, "服務費", { min: 0, max: 100 });
  const serviceFee = Math.round(((subtotal - orderDiscount) * serviceFeePct) / 100);
  const allowance = num(d.allowance ?? 0, "折讓", { min: 0, max: 1e7 });
  const shopperId = d.shopperId ? str(d.shopperId, "會員", { max: 64 }) : null;
  const rewardPoints = shopperId ? int(d.rewardPoints ?? 0, "購物金折抵", { min: 0, max: 1e7 }) : 0;
  const rewardDiscount = rewardPoints * pointValue;
  const total = subtotal - orderDiscount + serviceFee - allowance - rewardDiscount;
  assert(total >= 0, "折扣超過應收金額");

  const payments = (Array.isArray(d.payments) ? d.payments : []).map((p: Record<string, unknown>) => {
    assert(METHODS.includes(p.method as Method), "付款方式不正確");
    return { method: p.method as Method, amount: num(p.amount, "付款金額", { min: 0, max: 1e8 }) };
  }).filter((p: { amount: number }) => p.amount > 0);
  const paid = payments.reduce((s: number, p: { amount: number }) => s + p.amount, 0);
  const nonCash = payments.filter((p: { method: Method }) => p.method !== "cash").reduce((s: number, p: { amount: number }) => s + p.amount, 0);
  assert(paid >= total, `收款不足，還差 ${total - paid} 元`);
  assert(nonCash <= total, "非現金付款不能超過應收金額（不能找零）");
  const change = paid - total;

  let shopper: { id: string; name: string; email: string; mobile: string } | null = null;
  if (shopperId) {
    const s = (await db.doc(`shoppers/${shopperId}`).get()).data();
    shopper = { id: shopperId, name: s?.name ?? "", email: s?.email ?? "", mobile: s?.mobile ?? "" };
  }

  // --- 1. pending record (idempotent) ---
  if (!existing) {
    const orderNo = await nextOrderNo();
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return;
      tx.create(ref, {
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
        itemCount: lines.reduce((s, l) => s + l.qty, 0),
        subtotal,
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
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
  const order = (await ref.get()).data()!;

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
    await createMovement({ id: moveId, variantId: l.variantId, type: "sale", delta: -l.qty, ref: id, note: order.orderNo, device: order.device, status: "processing" }, actor);
    moveIds.push(moveId);
  }
  await ref.update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
  await pushBulk(moveIds);

  // --- 4. 回饋購物金 ---
  const rewardPercent = Number(settings.rewardPercent ?? 0);
  if (order.shopper && rewardPercent > 0 && order.total > 0) {
    const earned = Math.floor((order.total * rewardPercent) / 100 / pointValue);
    if (earned > 0) {
      try {
        await meep.sendRewardPoints(order.shopper.id, earned, `門市消費回饋 ${order.orderNo}`);
        await ref.update({ rewardEarned: earned, rewardEarnStatus: "ok" });
      } catch (e) {
        await ref.update({ rewardEarned: 0, rewardEarnStatus: `failed: ${errMsg(e)}` });
      }
    }
  }
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
  return { id, orderNo: o.orderNo, status: o.status, total: o.total, change: o.change, rewardEarned: o.rewardEarned ?? 0, stockIssues };
}

// ---------- refund / void ----------

async function canRefund(actor: Actor) {
  if (atLeast(actor.role, "manager")) return;
  const s = await shopSettings();
  if (!s.staffCanRefund) throw new HttpsError("permission-denied", "退貨 / 作廢限店長以上");
}

async function doRefund(actor: Actor, orderId: string, refundId: string, wanted: { index: number; qty: number }[], method: Method | "original", reason: string, isVoid: boolean) {
  const ref = db.doc(`posOrders/${orderId}`);
  const settings = await shopSettings();
  const shiftId = settings.currentShiftId as string | undefined;
  assert(shiftId, "請先到「錢櫃」開班", "failed-precondition");

  const plan = await db.runTransaction(async (tx) => {
    const o = (await tx.get(ref)).data();
    assert(o, "找不到這張單", "not-found");
    const done = (o.refunds ?? []).find((r: { id: string }) => r.id === refundId);
    if (done) return { already: true as const, o };
    assert(["completed", "partial"].includes(o.status), "這張單不能退貨（已作廢或已全退）", "failed-precondition");
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

    let refundPayments: { method: Method; amount: number }[];
    if (method === "original") {
      // Pay back the original way: non-cash first in full, the rest in cash.
      let left = amount;
      refundPayments = [];
      for (const p of o.payments.filter((x: { method: Method }) => x.method !== "cash")) {
        const a = Math.min(left, p.amount);
        if (a > 0) refundPayments.push({ method: p.method, amount: a });
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

  const o = plan.o;
  const moveIds: string[] = [];
  for (const w of plan.record.lines) {
    const l = o.lines[w.index] as Line;
    const moveId = `${refundId}_${w.index}`;
    await createMovement({ id: moveId, variantId: l.variantId, type: "refund", delta: w.qty, ref: orderId, note: `${o.orderNo} ${isVoid ? "作廢" : "退貨"}`, status: "processing" }, actor);
    moveIds.push(moveId);
  }
  await pushBulk(moveIds);

  const notes: string[] = [];
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
  const method = d.method === "original" || METHODS.includes(d.method) ? d.method : "original";
  const lines = (Array.isArray(d.lines) ? d.lines : []).map((l: Record<string, unknown>) => ({ index: int(l.index, "項目", { min: 0, max: 99 }), qty: int(l.qty, "數量", { min: 0, max: 999 }) }));
  return doRefund(actor, str(d.orderId, "訂單", { max: 64 }), str(d.refundId, "退貨 id", { max: 64 }), lines, method, str(d.reason, "原因", { optional: true, max: 200 }), false);
});

/** 作廢：整單退回（加回庫存、退回購物金），用原付款方式退款 */
export const posVoid = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "staff");
  await canRefund(actor);
  const orderId = str(req.data?.orderId, "訂單", { max: 64 });
  const o = (await db.doc(`posOrders/${orderId}`).get()).data();
  assert(o, "找不到這張單", "not-found");
  const lines = (o.lines as Line[]).map((l, index) => ({ index, qty: l.qty - l.refundedQty }));
  return doRefund(actor, orderId, `void_${orderId}`, lines, "original", str(req.data?.reason, "原因", { optional: true, max: 200 }) || "作廢", true);
});

// ---------- shifts / cash drawer ----------

export const openShift = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const float = num(req.data?.float ?? 0, "零用金", { min: 0, max: 1e7 });
  const name = str(req.data?.name, "班別", { optional: true, max: 20 }) || "早班";
  const sRef = db.doc("settings/shop");
  const shiftRef = db.collection("shifts").doc();
  await db.runTransaction(async (tx) => {
    const s = (await tx.get(sRef)).data() ?? {};
    assert(!s.currentShiftId, "已經有開著的班，請先日結交班", "failed-precondition");
    tx.set(shiftRef, { name, businessDate: taipeiDate(), status: "open", float, cashMoves: [], openedBy: actor.uid, openedByName: actor.name, openedAt: FieldValue.serverTimestamp() });
    tx.set(sRef, { currentShiftId: shiftRef.id }, { merge: true });
  });
  return { id: shiftRef.id };
});

export const cashMove = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const shiftId = (await shopSettings()).currentShiftId;
  assert(shiftId, "目前沒有開班", "failed-precondition");
  const type = req.data?.type === "out" ? "out" : "in";
  const amount = num(req.data?.amount, "金額", { min: 1, max: 1e7 });
  await db.doc(`shifts/${shiftId}`).update({
    cashMoves: FieldValue.arrayUnion({ id: db.collection("x").doc().id, type, amount, note: str(req.data?.note, "說明", { optional: true, max: 100 }) || null, by: actor.name, at: Timestamp.now() }),
  });
  return { ok: true };
});

async function computeShift(shiftId: string) {
  const shift = (await db.doc(`shifts/${shiftId}`).get()).data();
  assert(shift, "找不到這個班", "not-found");
  const [sales, refunded] = await Promise.all([
    db.collection("posOrders").where("shiftId", "==", shiftId).get(),
    db.collection("posOrders").where("refundShiftIds", "array-contains", shiftId).get(),
  ]);
  const byMethod: Record<string, { sales: number; refunds: number }> = Object.fromEntries(METHODS.map((m) => [m, { sales: 0, refunds: 0 }]));
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
      byMethod[p.method].sales += amt;
    }
  }
  let refundTotal = 0;
  for (const doc of refunded.docs) {
    for (const r of doc.data().refunds ?? []) {
      if (r.shiftId !== shiftId) continue;
      refundTotal += r.amount;
      for (const p of r.payments) byMethod[p.method].refunds += p.amount;
    }
  }
  const ins = (shift.cashMoves ?? []).filter((m: { type: string }) => m.type === "in").reduce((s: number, m: { amount: number }) => s + m.amount, 0);
  const outs = (shift.cashMoves ?? []).filter((m: { type: string }) => m.type === "out").reduce((s: number, m: { amount: number }) => s + m.amount, 0);
  const expectedCash = shift.float + byMethod.cash.sales - byMethod.cash.refunds + ins - outs;
  const shiftData: FirebaseFirestore.DocumentData = { id: shiftId, ...shift };
  return { shift: shiftData, orders, total, refundTotal, rewardPoints, byMethod, ins, outs, expectedCash };
}

export const shiftSummary = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const shiftId = req.data?.shiftId || (await shopSettings()).currentShiftId;
  assert(shiftId, "目前沒有開班", "failed-precondition");
  const s = await computeShift(shiftId);
  return { ...s, shift: { ...s.shift, openedAt: s.shift.openedAt?.toMillis?.() ?? null, closedAt: s.shift.closedAt?.toMillis?.() ?? null, cashMoves: (s.shift.cashMoves ?? []).map((m: { at: Timestamp }) => ({ ...m, at: m.at.toMillis() })) } };
});

/** 日結交班：各付款方式小計、現金點收、差額 */
export const closeShift = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const sRef = db.doc("settings/shop");
  const shiftId = (await shopSettings()).currentShiftId;
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
  await sRef.set({ currentShiftId: null }, { merge: true });
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
        await db.doc(`shoppers/${id}`).update({ points, name: live.name ?? "", mobile: live.mobile ?? "", mobileKey: mobileKey(live.mobile) });
      }
    } catch {
      // fall back to cached points
    }
    const s = (await db.doc(`shoppers/${id}`).get()).data()!;
    out.push({ id, name: s.name, email: s.email, mobile: s.mobile, points: points ?? s.points ?? 0, live: points !== null });
  }
  return { shoppers: out };
});

/** 現場新增會員（meepShop 規定一定要有 Email） */
export const createShopper = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const email = str(req.data?.email, "Email", { max: 120 }).toLowerCase();
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Email 格式不正確");
  const mobile = str(req.data?.mobile, "手機", { optional: true, max: 20 });
  try {
    const s = await meep.createShopper({ email, name: str(req.data?.name, "姓名", { optional: true, max: 40 }) || undefined, mobile: mobile || undefined });
    await db.doc(`shoppers/${s.id}`).set({ email: s.email, emailLower: s.email.toLowerCase(), name: s.name ?? "", mobile: s.mobile ?? "", mobileKey: mobileKey(s.mobile), points: s.usableRewardPoints ?? 0, updatedAt: s.updatedAt ?? null });
    return { id: s.id, name: s.name, email: s.email, mobile: s.mobile, points: s.usableRewardPoints ?? 0 };
  } catch (e) {
    throw new HttpsError("failed-precondition", `新增會員失敗：${errMsg(e)}`);
  }
});
