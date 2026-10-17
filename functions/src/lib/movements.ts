import { logger } from "firebase-functions";
import type { Actor } from "./auth";
import { notifyOwner } from "./line";
import { adjustStock, bulkAdjustStock, MeepError } from "./meepshop";
import { chunk, db, errMsg, FieldValue, HttpsError, Timestamp } from "./util";

/**
 * movements/{id} — one stock change. The id is generated on the device (or derived from the
 * POS order / stocktake id), so a re-sent request never creates a second record.
 *
 * status:
 *   pending     recorded, not yet sent
 *   processing  being sent right now (claimed in a transaction)
 *   synced      meepShop confirmed; shopStockAfter holds its answer
 *   failed      not applied; retryable=true → retryFailed resends on 1/5/15/60 min
 *   unknown     sent but no answer — may or may not be applied; a manager must confirm or resend
 *   canceled    undone before it was ever applied
 *   resolved    a manager marked a failed/unknown record as handled by hand
 */
export type MoveType = "in" | "return" | "scrap" | "sale" | "refund" | "stocktake" | "undo";
export type MoveStatus = "pending" | "processing" | "synced" | "failed" | "unknown" | "canceled" | "resolved";

export const MOVE_LABEL: Record<MoveType, string> = {
  in: "進貨",
  return: "退貨",
  scrap: "報廢",
  sale: "門市售出",
  refund: "門市退貨",
  stocktake: "盤點調整",
  undo: "撤銷",
};

const RETRY_DELAYS_MIN = [1, 5, 15, 60];
export const MAX_ATTEMPTS = RETRY_DELAYS_MIN.length + 1;

export interface Batch {
  id: string;
  lot: string | null;
  exp: string | null; // YYYY-MM-DD
  qty: number;
  receivedAt: Timestamp;
}

export interface NewMovement {
  id: string;
  variantId: string;
  type: MoveType;
  delta: number;
  unitCost?: number;
  lot?: string;
  exp?: string;
  ref?: string; // posOrder / stocktake / original movement id
  undoOf?: string;
  note?: string;
  device?: string;
  status?: "pending" | "processing";
  /** 多店：這筆異動發生在哪個門市／倉庫（locationStock/{variantId}.qty[locationId] 跟著加減） */
  locationId?: string | null;
}

function fifo(a: Batch, b: Batch) {
  if (a.exp !== b.exp) {
    if (!a.exp) return 1;
    if (!b.exp) return -1;
    return a.exp < b.exp ? -1 : 1;
  }
  return a.receivedAt.toMillis() - b.receivedAt.toMillis();
}

/** Take qty out of batches, oldest expiry first. Returns the remaining batches. */
export function consumeFifo(batches: Batch[], qty: number): Batch[] {
  const sorted = [...batches].sort(fifo);
  let left = qty;
  for (const b of sorted) {
    if (left <= 0) break;
    const take = Math.min(b.qty, left);
    b.qty -= take;
    left -= take;
  }
  return sorted.filter((b) => b.qty > 0);
}

/**
 * Create the movement record (idempotent) and update batches / average cost in the same transaction.
 * Returns the stored record; `created` is false when the id already existed.
 */
export async function createMovement(m: NewMovement, actor: Actor) {
  const ref = db.doc(`movements/${m.id}`);
  const vRef = db.doc(`variants/${m.variantId}`);
  const cRef = db.doc(`costs/${m.variantId}`);
  return db.runTransaction(async (tx) => {
    const lRef = m.locationId ? db.doc(`locationStock/${m.variantId}`) : null;
    const [mSnap, vSnap, cSnap, lSnap] = await Promise.all([tx.get(ref), tx.get(vRef), tx.get(cRef), lRef ? tx.get(lRef) : Promise.resolve(null)]);
    if (mSnap.exists) return { created: false, data: mSnap.data()! };
    if (!vSnap.exists) throw new HttpsError("not-found", "找不到這個款式，請先同步 meepShop 商品");
    const v = vSnap.data()!;
    const cost = cSnap.data() ?? { avgCost: null, lots: {} };
    let batches: Batch[] = (v.batches ?? []).map((b: Batch) => ({ ...b }));
    const lots: Record<string, number> = { ...(cost.lots ?? {}) };
    let avgCost: number | null = cost.avgCost ?? null;
    let batchId: string | undefined;

    if (m.type === "in") {
      batchId = m.id;
      batches.push({ id: batchId, lot: m.lot || null, exp: m.exp || null, qty: m.delta, receivedAt: Timestamp.now() });
      if (m.unitCost !== undefined) {
        lots[batchId] = m.unitCost;
        const onHand = Math.max(0, v.shopStock ?? 0);
        avgCost = avgCost === null || onHand === 0 ? m.unitCost : (avgCost * onHand + m.unitCost * m.delta) / (onHand + m.delta);
        avgCost = Math.round(avgCost * 100) / 100;
      }
    } else if (m.delta < 0 && m.undoOf && m.ref) {
      // Undo of a receipt: take it back out of the batch it created.
      const b = batches.find((x) => x.id === m.ref);
      if (b) b.qty = Math.max(0, b.qty + m.delta);
      batches = batches.filter((x) => x.qty > 0);
    } else if (m.delta < 0) {
      batches = consumeFifo(batches, -m.delta);
    } else if (m.delta > 0) {
      const loose = batches.find((x) => x.id === "nolot");
      if (loose) loose.qty += m.delta;
      else batches.push({ id: "nolot", lot: null, exp: null, qty: m.delta, receivedAt: Timestamp.now() });
    }
    for (const k of Object.keys(lots)) if (!batches.some((b) => b.id === k)) delete lots[k];

    const data = {
      variantId: m.variantId,
      productTitle: v.productTitle ?? "",
      options: v.options ?? "",
      sku: v.sku ?? null,
      location: v.location ?? null,
      type: m.type,
      delta: m.delta,
      unitCost: m.unitCost ?? null,
      lot: m.lot || null,
      exp: m.exp || null,
      batchId: batchId ?? null,
      ref: m.ref ?? null,
      undoOf: m.undoOf ?? null,
      note: m.note || null,
      by: actor.uid,
      byName: actor.name,
      device: m.device || null,
      locationId: m.locationId || null,
      at: FieldValue.serverTimestamp(),
      status: m.status ?? "pending",
      processingAt: m.status === "processing" ? Timestamp.now() : null,
      attempts: m.status === "processing" ? 1 : 0,
      retryable: true,
      shopStockAfter: null,
      error: null,
    };
    tx.set(ref, data);
    tx.update(vRef, { batches });
    tx.set(cRef, { avgCost, lots }, { merge: true });
    if (lRef) {
      const qty = { ...(lSnap?.data()?.qty ?? {}) };
      qty[m.locationId!] = (qty[m.locationId!] ?? 0) + m.delta;
      tx.set(lRef, { qty, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    return { created: true, data };
  });
}

function failurePatch(e: unknown, attempts: number, delta: number) {
  const msg = errMsg(e);
  if (e instanceof MeepError && e.kind === "rejected") {
    return { status: "failed", retryable: false, error: delta < 0 ? `網店已無庫存或扣減被拒：${msg}` : msg };
  }
  if (e instanceof MeepError && e.kind === "not-sent") {
    if (attempts >= MAX_ATTEMPTS) return { status: "failed", retryable: false, exhausted: true, error: msg };
    const next = Date.now() + RETRY_DELAYS_MIN[attempts - 1] * 60_000;
    return { status: "failed", retryable: true, nextRetryAt: Timestamp.fromMillis(next), error: msg };
  }
  return { status: "unknown", retryable: false, error: msg };
}

async function afterFailure(id: string, patch: { status: string; exhausted?: boolean; error: string }) {
  if (patch.exhausted || patch.status === "unknown") {
    const m = (await db.doc(`movements/${id}`).get()).data();
    const what = m ? `${m.productTitle} ${m.options}（${MOVE_LABEL[m.type as MoveType]} ${m.delta > 0 ? "+" : ""}${m.delta}）` : id;
    await notifyOwner(
      patch.exhausted
        ? `【ganbaru29】庫存同步重試 ${MAX_ATTEMPTS} 次仍失敗\n${what}\n原因：${patch.error}\n請到「異動紀錄 → 同步失敗」處理。`
        : `【ganbaru29】庫存同步結果不明，需人工確認\n${what}\n請到「異動紀錄 → 待確認」比對 meepShop 庫存後確認或重送。`
    );
  }
}

async function saveStock(variantId: string, stock: number) {
  await db.doc(`variants/${variantId}`).update({ shopStock: stock, shopStockAt: FieldValue.serverTimestamp() });
}

/**
 * Send one movement to meepShop. Safe to call concurrently / repeatedly:
 * only the caller that wins the claim transaction actually sends.
 */
export async function pushMovement(id: string): Promise<FirebaseFirestore.DocumentData> {
  const ref = db.doc(`movements/${id}`);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const m = snap.data();
    if (!m || !["pending", "failed"].includes(m.status)) return null;
    tx.update(ref, { status: "processing", processingAt: Timestamp.now(), attempts: FieldValue.increment(1) });
    return { variantId: m.variantId as string, delta: m.delta as number, attempts: ((m.attempts as number) ?? 0) + 1 };
  });
  if (!claimed) return (await ref.get()).data()!;

  try {
    const stock = await adjustStock(claimed.variantId, claimed.delta);
    await ref.update({ status: "synced", shopStockAfter: stock, syncedAt: FieldValue.serverTimestamp(), error: null, nextRetryAt: null });
    await saveStock(claimed.variantId, stock);
  } catch (e) {
    const patch = failurePatch(e, claimed.attempts, claimed.delta);
    logger.warn(`movement ${id} → ${patch.status}`, patch.error);
    await ref.update(patch);
    await afterFailure(id, patch);
  }
  return (await ref.get()).data()!;
}

/**
 * Send many movements (already stored with status "processing") in bulkAdjustStockQuantity calls.
 * Used by POS checkout / refund and stocktake.
 */
export async function pushBulk(ids: string[]): Promise<void> {
  const snaps = await db.getAll(...ids.map((id) => db.doc(`movements/${id}`)));
  const moves = snaps.filter((s) => s.data()?.status === "processing").map((s) => ({ id: s.id, ...(s.data() as { variantId: string; delta: number; attempts: number }) }));

  for (const group of chunk(moves, 50)) {
    const perVariant = new Map<string, number>();
    for (const m of group) perVariant.set(m.variantId, (perVariant.get(m.variantId) ?? 0) + m.delta);
    const input = [...perVariant].filter(([, d]) => d !== 0).map(([variantId, availableDelta]) => ({ variantId, availableDelta }));
    const batch = db.batch();
    try {
      const { stocks, errors } = input.length ? await bulkAdjustStock(input) : { stocks: new Map<string, number>(), errors: [] };
      for (const m of group) {
        const ref = db.doc(`movements/${m.id}`);
        if (stocks.has(m.variantId) || perVariant.get(m.variantId) === 0) {
          const stock = stocks.get(m.variantId);
          batch.update(ref, { status: "synced", shopStockAfter: stock ?? null, syncedAt: FieldValue.serverTimestamp(), error: null });
        } else {
          const msg = errors.join("; ") || "meepShop 未回傳這個款式的結果";
          batch.update(ref, { status: "failed", retryable: false, error: m.delta < 0 ? `網店已無庫存或扣減被拒：${msg}` : msg });
        }
      }
      for (const [vid, stock] of stocks) batch.update(db.doc(`variants/${vid}`), { shopStock: stock, shopStockAt: FieldValue.serverTimestamp() });
      await batch.commit();
    } catch (e) {
      for (const m of group) batch.update(db.doc(`movements/${m.id}`), failurePatch(e, m.attempts || 1, m.delta));
      await batch.commit();
      const patch = failurePatch(e, group[0].attempts || 1, -1);
      if (patch.status === "unknown") {
        await notifyOwner(`【ganbaru29】批次庫存同步結果不明（${group.length} 筆），請到「異動紀錄 → 待確認」處理。`);
      }
    }
  }
}
