import { onCall } from "firebase-functions/v2/https";
import { requireRole } from "./lib/auth";
import { variantStocks } from "./lib/meepshop";
import { createMovement, pushBulk } from "./lib/movements";
import { assert, chunk, db, FieldValue, int, str } from "./lib/util";
import { runCatalogSync } from "./sync";

/**
 * stocktakes/{id}               scope, status (open / applying / applied / canceled), startedBy …
 * stocktakes/{id}/items/{vid}   book (帳面), counted (實盤), live / diff after apply
 * Counts live in a subcollection so several phones can count at once without fighting over one doc.
 */

/** 開盤點單：先跑一次完整同步，拿 meepShop 最新庫存當帳面 */
export const createStocktake = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  const actor = await requireRole(req, "manager");
  const prefix = str(req.data?.locationPrefix, "儲位", { optional: true, max: 40 });
  // 多店：盤某一家門市／倉庫時，帳面 = 該地點的數量，套用時只調整該地點（以及 meepShop 總數同步加減）
  const locationId = str(req.data?.locationId, "門市／倉庫", { optional: true, max: 40 }) || null;
  const name = str(req.data?.name, "名稱", { optional: true, max: 60 }) || (prefix ? `盤點 ${prefix}` : "全店盤點");

  const sync = await runCatalogSync("full", "stocktake");
  let q = db.collection("variants").where("active", "==", true);
  if (prefix) q = q.where("location", ">=", prefix).where("location", "<=", prefix + "");
  const variants = await q.get();
  assert(!variants.empty, "這個範圍沒有任何款式", "failed-precondition");

  const ref = db.collection("stocktakes").doc();
  await ref.set({
    name,
    scope: prefix ? { type: "location", prefix } : { type: "all" },
    status: "open",
    startedBy: actor.uid,
    startedByName: actor.name,
    startedAt: FieldValue.serverTimestamp(),
    itemCount: variants.size,
    locationId,
    syncWarning: sync.errors.length ? sync.errors.join("; ") : null,
  });
  const locQty = new Map<string, number>();
  if (locationId) {
    for (const ids of chunk(variants.docs.map((v) => v.id), 300)) {
      const ls = await db.getAll(...ids.map((id) => db.doc(`locationStock/${id}`)));
      ls.forEach((x) => locQty.set(x.id, x.data()?.qty?.[locationId] ?? 0));
    }
  }
  const writer = db.bulkWriter();
  variants.forEach((v) => {
    const d = v.data();
    writer.set(ref.collection("items").doc(v.id), {
      productTitle: d.productTitle,
      options: d.options,
      sku: d.sku ?? null,
      location: d.location ?? null,
      book: locationId ? locQty.get(v.id) ?? 0 : d.shopStock ?? 0,
      counted: 0,
      touched: false,
      inScope: true,
    });
  });
  await writer.close();
  return { id: ref.id, items: variants.size, syncWarning: sync.errors[0] ?? null };
});

/** 掃一下實盤 +1（delta），或手動改數字（set） */
export const stocktakeCount = onCall({ maxInstances: 10 }, async (req) => {
  const actor = await requireRole(req, "staff");
  const id = str(req.data?.id, "盤點單", { max: 60 });
  const variantId = str(req.data?.variantId, "款式", { max: 100 });
  const st = (await db.doc(`stocktakes/${id}`).get()).data();
  assert(st?.status === "open", "盤點單不是進行中", "failed-precondition");
  const itemRef = db.doc(`stocktakes/${id}/items/${variantId}`);
  const item = await itemRef.get();
  if (!item.exists) {
    // Scanned something outside the chosen scope — still count it, flagged.
    const v = (await db.doc(`variants/${variantId}`).get()).data();
    assert(v, "找不到這個款式", "not-found");
    await itemRef.create({ productTitle: v.productTitle, options: v.options, sku: v.sku ?? null, location: v.location ?? null, book: v.shopStock ?? 0, counted: 0, touched: false, inScope: false }).catch(() => undefined);
  }
  const by = { lastBy: actor.name, lastAt: FieldValue.serverTimestamp(), touched: true };
  if (req.data?.set !== undefined) {
    await itemRef.update({ counted: int(req.data.set, "實盤數量", { min: 0, max: 99999 }), ...by });
  } else {
    await itemRef.update({ counted: FieldValue.increment(int(req.data?.delta ?? 1, "數量", { min: -999, max: 999 })), ...by });
  }
  const after = (await itemRef.get()).data()!;
  if (after.counted < 0) await itemRef.update({ counted: 0 });
  return { counted: Math.max(0, after.counted), productTitle: after.productTitle, options: after.options, inScope: after.inScope };
});

/**
 * 套用：差異 = 實盤 − 「當下」meepShop 庫存（不是開單時的帳面，避免盤點期間網店售出被算錯），
 * 再用 bulkAdjustStockQuantity 一次送出。onlyCounted=true 時，沒掃到的款式不動。
 */
export const applyStocktake = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  const actor = await requireRole(req, "manager");
  const id = str(req.data?.id, "盤點單", { max: 60 });
  const onlyCounted = req.data?.onlyCounted !== false;
  const ref = db.doc(`stocktakes/${id}`);
  await db.runTransaction(async (tx) => {
    const st = (await tx.get(ref)).data();
    assert(st?.status === "open", "盤點單不是進行中（可能已套用）", "failed-precondition");
    tx.update(ref, { status: "applying", applyingBy: actor.uid });
  });

  try {
    const st = (await ref.get()).data()!;
    const items = await ref.collection("items").get();
    const targets = items.docs.filter((d) => !onlyCounted || d.data().touched);
    const live = new Map<string, number>();
    if (st.locationId) {
      // 該地點目前的數量（含盤點期間的銷售、調貨）
      for (const ids of chunk(targets.map((d) => d.id), 300)) {
        const ls = ids.length ? await db.getAll(...ids.map((id) => db.doc(`locationStock/${id}`))) : [];
        ls.forEach((x) => live.set(x.id, x.data()?.qty?.[st.locationId] ?? 0));
      }
    } else {
      for (const ids of chunk(targets.map((d) => d.id), 50)) for (const [k, v] of await variantStocks(ids)) live.set(k, v);
    }

    const moveIds: string[] = [];
    const writer = db.bulkWriter();
    for (const d of targets) {
      const it = d.data();
      const current = live.get(d.id);
      if (current === undefined) {
        writer.update(d.ref, { live: null, diff: null, note: "meepShop 找不到此款式，未調整" });
        continue;
      }
      const diff = it.counted - current;
      writer.update(d.ref, { live: current, diff });
      if (diff !== 0) {
        const moveId = `st_${id}_${d.id}`;
        await createMovement({ id: moveId, variantId: d.id, type: "stocktake", delta: diff, ref: id, note: `${it.counted}（實盤）− ${current}（${st.locationId ? "該地點帳面" : "網店"}）`, status: "processing", locationId: st.locationId ?? null }, actor);
        moveIds.push(moveId);
      }
    }
    await writer.close();
    await pushBulk(moveIds);

    const results = moveIds.length ? await db.getAll(...moveIds.map((m) => db.doc(`movements/${m}`))) : [];
    const failed = results.filter((r) => r.data()?.status !== "synced").length;
    await ref.update({ status: "applied", appliedAt: FieldValue.serverTimestamp(), appliedBy: actor.uid, appliedByName: actor.name, onlyCounted, adjusted: moveIds.length, failed });
    return { adjusted: moveIds.length, failed };
  } catch (e) {
    await ref.update({ status: "open" });
    throw e;
  }
});

export const cancelStocktake = onCall(async (req) => {
  await requireRole(req, "manager");
  const id = str(req.data?.id, "盤點單", { max: 60 });
  const ref = db.doc(`stocktakes/${id}`);
  const st = (await ref.get()).data();
  assert(st?.status === "open", "只有進行中的盤點單可以取消", "failed-precondition");
  await ref.update({ status: "canceled", canceledAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
