import { onCall } from "firebase-functions/v2/https";
import { getStorage, getDownloadURL } from "firebase-admin/storage";
import { audit } from "./lib/audit";
import { atLeast, requireRole } from "./lib/auth";
import { getVariant } from "./lib/meepshop";
import { createMovement, MoveType, pushMovement } from "./lib/movements";
import { assert, codeKey, db, FieldValue, HttpsError, int, num, str } from "./lib/util";

const UNDO_WINDOW_MS = 10 * 60 * 1000;
const SCAN_TYPES: Record<string, { sign: 1 | -1; min: "staff" | "manager" }> = {
  in: { sign: 1, min: "staff" },
  return: { sign: -1, min: "staff" }, // 退回廠商
  scrap: { sign: -1, min: "manager" },
};

const opts = { maxInstances: 5 };

/** Find a variant by any code: bound barcode / QR, or the meepShop variant id itself (our QR labels). */
async function resolveCode(code: string): Promise<string | null> {
  const c = await db.doc(`codes/${codeKey(code)}`).get();
  if (c.exists) return c.data()!.variantId;
  if (/^[\w-]{8,}$/.test(code)) {
    const v = await db.doc(`variants/${code}`).get();
    if (v.exists) return code;
  }
  return null;
}

/** 用條碼找商品，順便抓 meepShop 即時庫存 */
export const lookupCode = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const code = str(req.data?.code, "條碼");
  const variantId = await resolveCode(code);
  if (!variantId) return { found: false };
  let liveStock: number | null = null;
  try {
    const live = await getVariant(variantId);
    if (live) {
      liveStock = live.stock ?? 0;
      await db.doc(`variants/${variantId}`).update({ shopStock: liveStock, shopStockAt: FieldValue.serverTimestamp() });
    }
  } catch {
    // Offline from meepShop — the cached stock is shown instead.
  }
  const v = (await db.doc(`variants/${variantId}`).get()).data()!;
  return { found: true, variantId, liveStock, variant: { productTitle: v.productTitle, options: v.options, location: v.location ?? null, shopStock: v.shopStock ?? null } };
});

/** 掃碼後記一筆異動（進貨 / 退貨 / 報廢）並同步 meepShop */
export const scanMove = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const d = req.data ?? {};
  const type = d.type as string;
  const rule = SCAN_TYPES[type];
  assert(rule, "動作不正確（門市賣出請用 POS 結帳）");
  if (!atLeast(actor.role, rule.min)) throw new HttpsError("permission-denied", "報廢限店長以上");
  const id = str(d.id, "異動 id", { max: 64 });
  assert(/^[\w-]+$/.test(id), "異動 id 格式不正確");
  const qty = int(d.qty, "數量", { min: 1, max: 9999 });
  const exp = str(d.exp, "有效期限", { optional: true, max: 10 });
  if (exp) assert(/^\d{4}-\d{2}-\d{2}$/.test(exp), "有效期限格式為 YYYY-MM-DD");

  await createMovement(
    {
      id,
      variantId: str(d.variantId, "款式", { max: 100 }),
      type: type as MoveType,
      delta: rule.sign * qty,
      unitCost: type === "in" && d.unitCost !== undefined && d.unitCost !== "" && d.unitCost !== null ? num(d.unitCost, "進貨單價", { min: 0, max: 1e7 }) : undefined,
      lot: type === "in" ? str(d.lot, "批號", { optional: true, max: 50 }) : undefined,
      exp: type === "in" ? exp : undefined,
      note: str(d.note, "備註", { optional: true, max: 200 }),
      device: str(d.device, "裝置", { optional: true, max: 80 }),
      locationId: str(d.locationId, "地點", { optional: true, max: 40 }) || null,
    },
    actor
  );
  const m = await pushMovement(id);
  return { id, status: m.status, shopStockAfter: m.shopStockAfter ?? null, error: m.error ?? null };
});

/** 撤銷：反向加減一筆，原紀錄標記已撤銷 */
export const undoMove = onCall(opts, async (req) => {
  const actor = await requireRole(req, "staff");
  const id = str(req.data?.id, "異動 id", { max: 64 });
  const ref = db.doc(`movements/${id}`);
  const orig = (await ref.get()).data();
  assert(orig, "找不到這筆紀錄", "not-found");
  assert(["in", "return", "scrap"].includes(orig.type), "這類異動不能在這裡撤銷（POS 單請到交易瀏覽退貨）", "failed-precondition");
  assert(!orig.undoneBy, "這筆已經撤銷過了", "failed-precondition");
  if (!atLeast(actor.role, "manager")) {
    const at = orig.at?.toMillis?.() ?? 0;
    assert(orig.by === actor.uid && Date.now() - at <= UNDO_WINDOW_MS, "員工只能撤銷自己 10 分鐘內的紀錄", "permission-denied");
  }

  // Not applied yet → just cancel it; nothing to reverse at meepShop.
  const canceled = await db.runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data()!;
    if (s.status === "pending" || s.status === "failed") {
      tx.update(ref, { status: "canceled", undoneBy: actor.uid, undoneAt: FieldValue.serverTimestamp(), retryable: false });
      return true;
    }
    assert(s.status !== "processing", "這筆正在同步中，請稍候再試", "failed-precondition");
    assert(s.status !== "unknown", "這筆同步結果不明，請店長先在「待確認」確認後再撤銷", "failed-precondition");
    return false;
  });
  if (canceled) {
    // Put the batch quantities back as they were.
    await createMovement({ id: `${id}_undo`, variantId: orig.variantId, type: "undo", delta: -orig.delta, ref: id, undoOf: id, status: "processing", locationId: orig.locationId ?? null }, actor);
    await db.doc(`movements/${id}_undo`).update({ status: "canceled", note: "原紀錄未同步，直接取消" });
    return { status: "canceled" };
  }

  const undoId = `${id}_undo`;
  await createMovement({ id: undoId, variantId: orig.variantId, type: "undo", delta: -orig.delta, ref: id, undoOf: id, device: req.data?.device, locationId: orig.locationId ?? null }, actor);
  await ref.update({ undoneBy: actor.uid, undoneAt: FieldValue.serverTimestamp(), undoId });
  const m = await pushMovement(undoId);
  return { status: m.status, shopStockAfter: m.shopStockAfter ?? null, error: m.error ?? null };
});

/** 同步失敗 / 待確認清單的處理：retry 重送、confirm 確認已套用、dismiss 確認已手動處理 */
export const resolveMovement = onCall(opts, async (req) => {
  const actor = await requireRole(req, "manager");
  const id = str(req.data?.id, "異動 id", { max: 80 });
  const action = req.data?.action as string;
  assert(["retry", "confirm", "dismiss"].includes(action), "動作不正確");
  const ref = db.doc(`movements/${id}`);
  const m = (await ref.get()).data();
  assert(m && ["failed", "unknown"].includes(m.status), "這筆不是失敗或待確認狀態", "failed-precondition");
  const note = str(req.data?.note, "備註", { optional: true, max: 200 });
  await audit(actor, "movement." + action, { id, title: `${m.productTitle} ${m.options}`, delta: m.delta, status: m.status, note });
  if (action === "retry") {
    await ref.update({ status: "pending", retryable: true, attempts: 0, resolvedBy: actor.uid, resolveNote: note || null });
    const r = await pushMovement(id);
    return { status: r.status, error: r.error ?? null };
  }
  await ref.update({
    status: action === "confirm" ? "synced" : "resolved",
    retryable: false,
    resolvedBy: actor.uid,
    resolvedByName: actor.name,
    resolvedAt: FieldValue.serverTimestamp(),
    resolveNote: note || (action === "confirm" ? "店長確認 meepShop 已套用" : "店長確認已手動處理"),
  });
  return { status: action === "confirm" ? "synced" : "resolved" };
});

/** 綁定條碼：一個規格可綁多個條碼 */
export const bindCode = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const code = str(req.data?.code, "條碼", { max: 100 });
  const variantId = str(req.data?.variantId, "款式", { max: 100 });
  const force = req.data?.force === true;
  const cRef = db.doc(`codes/${codeKey(code)}`);
  const vRef = db.doc(`variants/${variantId}`);
  return db.runTransaction(async (tx) => {
    const [c, v] = await Promise.all([tx.get(cRef), tx.get(vRef)]);
    assert(v.exists, "找不到這個款式", "not-found");
    const prev = c.data()?.variantId as string | undefined;
    if (prev && prev !== variantId) {
      if (!force) {
        const pv = (await tx.get(db.doc(`variants/${prev}`))).data();
        return { conflict: true, boundTo: { variantId: prev, title: pv ? `${pv.productTitle} ${pv.options}` : prev } };
      }
      tx.update(db.doc(`variants/${prev}`), { extraCodes: FieldValue.arrayRemove(code) });
    }
    tx.set(cRef, { code, variantId, source: "manual", at: FieldValue.serverTimestamp() });
    tx.update(vRef, { extraCodes: FieldValue.arrayUnion(code) });
    return { conflict: false };
  });
});

export const unbindCode = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const code = str(req.data?.code, "條碼", { max: 100 });
  const cRef = db.doc(`codes/${codeKey(code)}`);
  const c = (await cRef.get()).data();
  assert(c, "這個條碼沒有綁定", "not-found");
  await cRef.delete();
  await db.doc(`variants/${c.variantId}`).update({ extraCodes: FieldValue.arrayRemove(code) });
  return { ok: true };
});

/** 沒有原廠條碼的商品：產生店內條碼（G29 + 8 碼數字），之後印標籤貼上 */
export const generateStoreCode = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const variantId = str(req.data?.variantId, "款式", { max: 100 });
  for (let i = 0; i < 5; i++) {
    const code = `G29${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const cRef = db.doc(`codes/${code}`);
    const ok = await db.runTransaction(async (tx) => {
      if ((await tx.get(cRef)).exists) return false;
      tx.set(cRef, { code, variantId, source: "store", at: FieldValue.serverTimestamp() });
      tx.update(db.doc(`variants/${variantId}`), { extraCodes: FieldValue.arrayUnion(code), storeCode: code });
      return true;
    });
    if (ok) return { code };
  }
  throw new HttpsError("internal", "產生條碼失敗，請再試一次");
});

/** 一次幫多款沒有任何條碼的商品產生店內條碼（已有條碼／商品編號／店內碼的會跳過） */
export const generateStoreCodes = onCall({ ...opts, timeoutSeconds: 300 }, async (req) => {
  await requireRole(req, "manager");
  const ids: string[] = (Array.isArray(req.data?.variantIds) ? req.data.variantIds : []).map(String).slice(0, 2000);
  assert(ids.length, "沒有選擇商品");
  const snaps = [];
  for (let i = 0; i < ids.length; i += 300) snaps.push(...(await db.getAll(...ids.slice(i, i + 300).map((id) => db.doc(`variants/${id}`)))));
  const need = snaps.filter((s) => s.exists && !s.data()?.barcode && !s.data()?.storeCode && !s.data()?.sku).map((s) => s.id);
  const out: Record<string, string> = {};
  for (let i = 0; i < need.length; i += 150) {
    const chunk = need.slice(i, i + 150);
    // 先產生、確認沒有撞號，再一起寫入
    let codes = chunk.map(() => `G29${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`);
    for (let t = 0; t < 5; t++) {
      const exist = await db.getAll(...codes.map((c) => db.doc(`codes/${c}`)));
      const dup = new Set(codes.filter((c, k) => exist[k].exists || codes.indexOf(c) !== k));
      if (!dup.size) break;
      codes = codes.map((c) => (dup.has(c) ? `G29${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` : c));
    }
    const batch = db.batch();
    chunk.forEach((vid, k) => {
      batch.set(db.doc(`codes/${codes[k]}`), { code: codes[k], variantId: vid, source: "store", at: FieldValue.serverTimestamp() });
      batch.update(db.doc(`variants/${vid}`), { extraCodes: FieldValue.arrayUnion(codes[k]), storeCode: codes[k] });
      out[vid] = codes[k];
    });
    await batch.commit();
  }
  return { created: need.length, skipped: ids.length - need.length };
});

/** 標籤印好了：從「未印 QR」清單移除（printed=false 則放回清單，例如要補印） */
export const markLabelsPrinted = onCall(opts, async (req) => {
  await requireRole(req, "staff");
  const ids: string[] = (Array.isArray(req.data?.variantIds) ? req.data.variantIds : []).slice(0, 2000);
  assert(ids.length, "沒有選擇款式");
  const printed = req.data?.printed !== false;
  const writer = db.bulkWriter();
  ids.forEach((id) => writer.update(db.doc(`variants/${id}`), { labelPrinted: printed, labelPrintedAt: printed ? FieldValue.serverTimestamp() : null }));
  await writer.close();
  return { updated: ids.length };
});

/** 設定：儲位、安全庫存、POS 分類與排序 */
export const updateVariantMeta = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const ids: string[] = Array.isArray(req.data?.variantIds) ? req.data.variantIds.slice(0, 500) : [str(req.data?.variantId, "款式", { max: 100 })];
  const p = req.data?.patch ?? {};
  const patch: Record<string, unknown> = {};
  if ("location" in p) patch.location = str(p.location, "儲位", { optional: true, max: 40 }) || null;
  if ("safety" in p) patch.safety = int(p.safety, "安全庫存", { min: 0, max: 99999 });
  if ("posCategory" in p) {
    patch.posCategory = str(p.posCategory, "POS 分類", { optional: true, max: 40 }) || null;
    patch.posCategoryManual = true;
  }
  if ("posSort" in p) patch.posSort = int(p.posSort, "排序", { min: -99999, max: 99999 });
  if ("posHidden" in p) patch.posHidden = p.posHidden === true;
  if ("material" in p) patch.material = str(p.material, "材質", { optional: true, max: 100 }) || null;
  if ("careText" in p) patch.careText = str(p.careText, "洗滌標示", { optional: true, max: 300 }) || null;
  assert(Object.keys(patch).length, "沒有要更新的欄位");
  const batch = db.batch();
  for (const id of ids) batch.update(db.doc(`variants/${id}`), patch);
  await batch.commit();
  return { updated: ids.length };
});

/** 手動上傳的商品圖（優先於自動抓的官網圖）。path=null 會清除手動圖，下次同步重抓官網圖。 */
export const setProductImage = onCall(opts, async (req) => {
  await requireRole(req, "manager");
  const productId = str(req.data?.productId, "商品", { max: 100 });
  const path = req.data?.path as string | null;
  const imgRef = db.doc(`productImages/${productId}`);
  let url: string | null = null;
  if (path) {
    assert(path.startsWith(`manual/${productId}/`), "圖片路徑不正確");
    url = await getDownloadURL(getStorage().bucket().file(path));
    await imgRef.set({ url, source: "manual", status: "ok", path, at: FieldValue.serverTimestamp() });
  } else {
    await imgRef.set({ url: null, source: "auto", status: "pending", at: FieldValue.serverTimestamp() });
  }
  const vs = await db.collection("variants").where("productId", "==", productId).get();
  const batch = db.batch();
  vs.forEach((v) => batch.update(v.ref, { imageUrl: url, imageSource: path ? "manual" : null }));
  await batch.commit();
  return { url };
});

/**
 * 商品成本（老闆）：直接設定每個款式的成本（沒有進貨紀錄的現有庫存用）。
 * 存在 costs/{variantId}.avgCost；之後掃碼進貨有填進貨單價，會用加權平均繼續更新。
 */
export const setCosts = onCall({ ...opts, timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "owner");
  const items = Array.isArray(req.data?.items) ? (req.data.items as { variantId: string; cost: number | null }[]) : [];
  assert(items.length > 0 && items.length <= 2000, "沒有要更新的成本");
  const writer = db.bulkWriter();
  let n = 0;
  for (const it of items) {
    const id = str(it.variantId, "款式", { max: 100 });
    const cost = it.cost === null ? null : num(it.cost, "成本", { min: 0, max: 1e6 });
    writer.set(db.doc(`costs/${id}`), { avgCost: cost === null ? null : Math.round(cost * 100) / 100, manualCostAt: FieldValue.serverTimestamp(), manualCostBy: actor.name }, { merge: true });
    n++;
  }
  await writer.close();
  await audit(actor, "cost.set", { count: n, sample: items.slice(0, 5) });
  return { updated: n };
});
