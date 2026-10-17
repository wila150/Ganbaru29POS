import { onCall } from "firebase-functions/v2/https";
import { ensureMemberCodes } from "./cards";
import { requireRole } from "./lib/auth";
import { createShopper } from "./lib/meepshop";
import { assert, birthDateInput, db, errMsg, FieldValue, HttpsError, str, taipeiDate } from "./lib/util";
import { mobileKey } from "./sync";

/**
 * LINE 會員卡（LIFF）：客人在 LINE 裡打開 → LINE 登入 → 第一次用「手機＋Email」綁定 meepShop 會員
 * （兩個都要對，避免冒用）→ 之後直接顯示會員條碼。
 * settings/shop.lineLogin = { channelId, liffId }（LINE Login 頻道，老闆在設定頁填）。
 */

async function lineSettings() {
  const s = (await db.doc("settings/shop").get()).data() ?? {};
  return { channelId: String(s.lineLogin?.channelId ?? ""), liffId: String(s.lineLogin?.liffId ?? ""), shopName: s.shopName || "ganbaru29" };
}

/** 驗證 LIFF 的 ID token，回傳 LINE userId 與名字 */
async function verifyLine(idToken: unknown): Promise<{ sub: string; name: string }> {
  const { channelId } = await lineSettings();
  assert(channelId, "店家尚未設定 LINE 登入", "failed-precondition");
  assert(typeof idToken === "string" && idToken.length > 20, "LINE 登入資訊不正確，請重新開啟", "unauthenticated");
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString() });
  const j = (await res.json()) as { sub?: string; name?: string; error_description?: string };
  if (!res.ok || !j.sub) throw new HttpsError("unauthenticated", `LINE 登入已過期，請關閉後重新開啟（${j.error_description ?? res.status}）`);
  return { sub: j.sub, name: j.name ?? "" };
}

async function cardFor(shopperId: string) {
  await ensureMemberCodes([shopperId]);
  return (await db.doc(`shoppers/${shopperId}`).get()).data()!.cardToken as string;
}

/** 公開：LIFF 頁要知道 liffId 才能初始化 */
export const lineConfig = onCall(async () => {
  const s = await lineSettings();
  return { liffId: s.liffId || null, shopName: s.shopName };
});

/** 已綁定 → 回傳會員卡 token；未綁定 → bound: false */
export const lineMemberCard = onCall({ maxInstances: 10 }, async (req) => {
  const { sub, name } = await verifyLine(req.data?.idToken);
  const q = await db.collection("shoppers").where("lineUserId", "==", sub).limit(1).get();
  if (q.empty) return { bound: false, lineName: name };
  return { bound: true, token: await cardFor(q.docs[0].id) };
});

/** 每個 LINE 帳號每天最多試 10 次（避免亂猜別人的手機、Email） */
async function rateLimit(sub: string) {
  const ref = db.doc(`lineBindAttempts/${sub}`);
  const today = taipeiDate();
  const n = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const count = d?.date === today ? d.count + 1 : 1;
    tx.set(ref, { date: today, count });
    return count;
  });
  assert(n <= 10, "今天嘗試太多次了，請明天再試或洽店員", "resource-exhausted");
}

export const lineBindMember = onCall({ maxInstances: 10 }, async (req) => {
  const { sub } = await verifyLine(req.data?.idToken);
  await rateLimit(sub);
  const digits = str(req.data?.mobile, "手機", { max: 20 }).replace(/\D/g, "");
  const email = str(req.data?.email, "Email", { max: 120 }).toLowerCase();
  assert(digits.length >= 8, "請輸入完整手機號碼");
  // 先用 Email 找，再比對手機後 8 碼（不管有沒有輸入 +886、+852 國碼都對得上）
  const q = await db.collection("shoppers").where("emailLower", "==", email).limit(5).get();
  const tail = digits.slice(-8);
  const match = q.docs.find((d) => String(d.data().mobile ?? "").replace(/\D/g, "").slice(-8) === tail);
  assert(match, "找不到符合的會員：請確認手機和 Email 都和註冊網店時一樣，或選擇「註冊新會員」", "not-found");
  const bound = match.data().lineUserId;
  assert(!bound || bound === sub, "這個會員已經綁定其他 LINE 帳號，請洽店員協助", "already-exists");
  await match.ref.update({ lineUserId: sub, lineBoundAt: FieldValue.serverTimestamp() });
  return { token: await cardFor(match.id) };
});

/** 不是會員：直接在 meepShop 建會員並綁定 */
export const lineRegisterMember = onCall({ maxInstances: 10 }, async (req) => {
  const { sub, name: lineName } = await verifyLine(req.data?.idToken);
  await rateLimit(sub);
  const exists = await db.collection("shoppers").where("lineUserId", "==", sub).limit(1).get();
  assert(exists.empty, "這個 LINE 帳號已經綁定會員", "already-exists");
  const email = str(req.data?.email, "Email", { max: 120 }).toLowerCase();
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Email 格式不正確");
  const mobile = str(req.data?.mobile, "手機", { max: 20 });
  const name = str(req.data?.name, "姓名", { optional: true, max: 40 }) || lineName;
  const birthDate = birthDateInput(req.data?.birthDate);
  let s;
  try {
    s = await createShopper({ email, name, mobile, birthDate });
  } catch (e) {
    throw new HttpsError("failed-precondition", `註冊失敗：${errMsg(e)}（如果這個 Email 已經是會員，請改用「我已經是會員」綁定）`);
  }
  await db.doc(`shoppers/${s.id}`).set({ email: s.email, emailLower: s.email.toLowerCase(), name: s.name ?? name, mobile: s.mobile ?? mobile, mobileKey: mobileKey(s.mobile ?? mobile), points: s.usableRewardPoints ?? 0, birthDate: s.birthDate ?? birthDate, birthMonth: birthDate.slice(5, 7), lineUserId: sub, lineBoundAt: FieldValue.serverTimestamp() }, { merge: true });
  return { token: await cardFor(s.id) };
});

/** 店員端：解除綁定（客人換 LINE 帳號時） */
export const lineUnbindMember = onCall(async (req) => {
  await requireRole(req, "manager");
  await db.doc(`shoppers/${str(req.data?.shopperId, "會員", { max: 64 })}`).update({ lineUserId: null });
  return { ok: true };
});
