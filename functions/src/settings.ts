import { onCall } from "firebase-functions/v2/https";
import { audit } from "./lib/audit";
import { requireRole } from "./lib/auth";
import { notifyOwner } from "./lib/line";
import { gql, MeepError } from "./lib/meepshop";
import { getSecret, setSecret } from "./lib/secrets";
import { assert, db, errMsg, FieldValue, HttpsError, str } from "./lib/util";

async function tryKey(key?: string) {
  const d = await gql<{ products: { total: number } }>(`query { products(first: 1) { total } }`, {}, { key, estimate: 5 });
  return d.products.total;
}

/** 存入或更換 meepShop 金鑰：先用新金鑰試一次查詢，成功才存 */
export const setApiKey = onCall(async (req) => {
  const actor = await requireRole(req, "owner");
  const key = str(req.data?.key, "API 金鑰", { max: 4000 });
  let total: number;
  try {
    total = await tryKey(key);
  } catch (e) {
    throw new HttpsError("failed-precondition", `金鑰測試失敗：${e instanceof MeepError ? e.message : errMsg(e)}`);
  }
  await setSecret("MEEPSHOP_API_KEY", key);
  await db.doc("settings/shop").set({ apiKeySetAt: FieldValue.serverTimestamp(), apiKeySetBy: actor.name }, { merge: true });
  await audit(actor, "settings.meepshopKey", {});
  return { ok: true, products: total };
});

export const testConnection = onCall(async (req) => {
  await requireRole(req, "owner");
  try {
    return { ok: true, products: await tryKey() };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
});

export const setLineToken = onCall(async (req) => {
  await requireRole(req, "owner");
  await setSecret("LINE_CHANNEL_TOKEN", str(req.data?.token, "LINE Channel access token", { max: 1000 }));
  await db.doc("settings/shop").set({ lineTokenSetAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

export const testLine = onCall(async (req) => {
  const actor = await requireRole(req, "owner");
  assert(await getSecret("LINE_CHANNEL_TOKEN"), "尚未設定 LINE token", "failed-precondition");
  await notifyOwner(`【ganbaru29】測試推播（${actor.name}）`);
  return { ok: true };
});

/** 只回傳「是否已設定」，永遠不回傳金鑰本身 */
export const secretStatus = onCall(async (req) => {
  await requireRole(req, "owner");
  const [meep, line] = await Promise.all([getSecret("MEEPSHOP_API_KEY"), getSecret("LINE_CHANNEL_TOKEN")]);
  return { meepshop: !!meep, line: !!line };
});
