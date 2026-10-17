import { onCall } from "firebase-functions/v2/https";
import { requireRole } from "./lib/auth";
import { assert, chunk, db, FieldValue, int, str, Timestamp } from "./lib/util";

/**
 * 多店／多倉庫存。meepShop 只有一個總庫存；各門市／倉庫的數量記在 locationStock/{variantId}.qty[locationId]。
 *  - 掃碼、POS、退貨、盤點：帶著裝置所在的 locationId，該地點數量跟著加減（同一個 transaction）。
 *  - 調貨 transfers/{id}：申請 → 出貨（調出地點扣）→ 收貨（調入地點加），meepShop 總數不變。
 *  - 網店訂單由 meepShop 扣總數：每天同步時把「總數 − 各地點合計」的差額記到「網店出貨地點」。
 */

interface Loc {
  id: string;
  name: string;
}

async function locations(): Promise<{ list: Loc[]; online: string | null }> {
  const s = (await db.doc("settings/shop").get()).data() ?? {};
  return { list: (s.locations ?? []) as Loc[], online: s.onlineLocationId ?? null };
}

async function assertLoc(id: string) {
  const { list } = await locations();
  assert(list.some((l) => l.id === id), "門市／倉庫不存在");
}

/** 開始用多店時：把目前 meepShop 庫存全部歸到一個地點（之後用盤點或調貨分配）。 */
export const initLocationStock = onCall({ timeoutSeconds: 300 }, async (req) => {
  await requireRole(req, "owner");
  const locationId = str(req.data?.locationId, "地點", { max: 40 });
  await assertLoc(locationId);
  const variants = await db.collection("variants").where("active", "==", true).select("shopStock").get();
  const writer = db.bulkWriter();
  variants.forEach((v) => writer.set(db.doc(`locationStock/${v.id}`), { qty: { [locationId]: Math.max(0, v.data().shopStock ?? 0) }, updatedAt: FieldValue.serverTimestamp() }));
  await writer.close();
  await db.doc("settings/shop").set({ locationStockInitAt: Timestamp.now() }, { merge: true });
  return { variants: variants.size };
});

/** Online orders change meepShop's total without a location: put the difference on the online-fulfilment location. */
export async function reconcileLocations() {
  const { list, online } = await locations();
  if (!list.length || !online) return 0;
  const variants = await db.collection("variants").where("active", "==", true).select("shopStock").get();
  let changed = 0;
  for (const group of chunk(variants.docs, 300)) {
    const ls = await db.getAll(...group.map((v) => db.doc(`locationStock/${v.id}`)));
    const batch = db.batch();
    group.forEach((v, i) => {
      const qty = { ...(ls[i].data()?.qty ?? {}) } as Record<string, number>;
      const sum = Object.values(qty).reduce((a, b) => a + b, 0);
      const diff = Math.max(0, v.data().shopStock ?? 0) - sum;
      if (diff === 0) return;
      qty[online] = (qty[online] ?? 0) + diff;
      batch.set(ls[i].ref, { qty, reconciledAt: FieldValue.serverTimestamp() }, { merge: true });
      changed++;
    });
    await batch.commit();
  }
  return changed;
}

// ---------- 調貨 ----------

export const requestTransfer = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  const from = str(req.data?.from, "調出地點", { max: 40 });
  const to = str(req.data?.to, "調入地點", { max: 40 });
  assert(from !== to, "調出、調入不能是同一個地點");
  await assertLoc(from);
  await assertLoc(to);
  const items = (Array.isArray(req.data?.items) ? req.data.items : []).map((i: Record<string, unknown>) => ({ variantId: str(i.variantId, "款式", { max: 100 }), qty: int(i.qty, "數量", { min: 1, max: 9999 }) }));
  assert(items.length > 0 && items.length <= 200, "請選擇要調的商品");
  const snaps = await db.getAll(...items.map((i: { variantId: string }) => db.doc(`variants/${i.variantId}`)));
  const ref = db.collection("transfers").doc();
  await ref.set({
    from,
    to,
    items: items.map((i: { variantId: string; qty: number }, k: number) => ({ ...i, title: `${snaps[k].data()?.productTitle ?? ""} ${snaps[k].data()?.options ?? ""}`.trim(), sku: snaps[k].data()?.sku ?? null })),
    note: str(req.data?.note, "備註", { optional: true, max: 200 }) || null,
    status: "requested",
    requestedBy: actor.name,
    requestedAt: FieldValue.serverTimestamp(),
  });
  return { id: ref.id };
});

async function moveTransfer(id: string, actorName: string, step: "ship" | "receive" | "cancel") {
  const ref = db.doc(`transfers/${id}`);
  await db.runTransaction(async (tx) => {
    const t = (await tx.get(ref)).data();
    assert(t, "找不到調貨單", "not-found");
    const need = step === "ship" ? "requested" : step === "receive" ? "shipped" : null;
    if (step === "cancel") assert(["requested", "shipped"].includes(t.status), "這張調貨單不能取消", "failed-precondition");
    else assert(t.status === need, step === "ship" ? "這張調貨單已出貨或已取消" : "這張調貨單還沒出貨或已收貨", "failed-precondition");
    const refs = t.items.map((i: { variantId: string }) => db.doc(`locationStock/${i.variantId}`));
    const snaps = await Promise.all(refs.map((r: FirebaseFirestore.DocumentReference) => tx.get(r)));
    t.items.forEach((i: { variantId: string; qty: number }, k: number) => {
      const qty = { ...(snaps[k].data()?.qty ?? {}) } as Record<string, number>;
      if (step === "ship") qty[t.from] = (qty[t.from] ?? 0) - i.qty;
      if (step === "receive") qty[t.to] = (qty[t.to] ?? 0) + i.qty;
      if (step === "cancel" && t.status === "shipped") qty[t.from] = (qty[t.from] ?? 0) + i.qty; // 已出貨的取消：退回調出地點
      if (step !== "cancel" || t.status === "shipped") tx.set(refs[k], { qty, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    const status = step === "ship" ? "shipped" : step === "receive" ? "received" : "canceled";
    tx.update(ref, { status, [`${status}By`]: actorName, [`${status}At`]: FieldValue.serverTimestamp() });
  });
}

export const shipTransfer = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  await moveTransfer(str(req.data?.id, "調貨單", { max: 40 }), actor.name, "ship");
  return { ok: true };
});
export const receiveTransfer = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  await moveTransfer(str(req.data?.id, "調貨單", { max: 40 }), actor.name, "receive");
  return { ok: true };
});
export const cancelTransfer = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  await moveTransfer(str(req.data?.id, "調貨單", { max: 40 }), actor.name, "cancel");
  return { ok: true };
});
