import { randomBytes, randomInt } from "crypto";
import { onCall } from "firebase-functions/v2/https";
import { requireRole } from "./lib/auth";
import { getShopper } from "./lib/meepshop";
import { assert, db, FieldValue, HttpsError, int, str, Timestamp } from "./lib/util";

/**
 * 會員卡：每位會員一個會員編號（掃描用）＋一個會員卡網址 token（給客人用手機打開）。
 * 優惠碼：coupons/{CODE}，綁定一個「需要優惠碼」的促銷活動；可以是共用碼或單次碼。
 */

const memberCode = () => `M${String(randomInt(0, 1e9)).padStart(9, "0")}`;

/** 沒有會員編號的會員補上（同步會員後、POS 新增會員時呼叫） */
export async function ensureMemberCodes(ids?: string[]) {
  const docs = ids?.length ? await db.getAll(...ids.map((id) => db.doc(`shoppers/${id}`))) : (await db.collection("shoppers").get()).docs;
  const missing = docs.filter((d) => d.exists && !d.data()?.memberCode);
  if (!missing.length) return 0;
  const writer = db.bulkWriter();
  for (const d of missing) writer.update(d.ref, { memberCode: memberCode(), cardToken: randomBytes(12).toString("hex") });
  await writer.close();
  return missing.length;
}

export const ensureAllMemberCodes = onCall({ timeoutSeconds: 300 }, async (req) => {
  await requireRole(req, "manager");
  return { added: await ensureMemberCodes() };
});

/** 客人手機上的會員卡（不用登入；以網址裡的 token 辨識，不會露出其他會員資料） */
export const memberCard = onCall({ maxInstances: 10 }, async (req) => {
  const token = String(req.data?.token ?? "");
  assert(/^[0-9a-f]{24}$/.test(token), "會員卡連結不正確", "not-found");
  const q = await db.collection("shoppers").where("cardToken", "==", token).limit(1).get();
  const d = q.docs[0];
  assert(d, "會員卡連結不正確或已失效", "not-found");
  const s = d.data();
  let points = s.points ?? 0;
  try {
    const live = await getShopper(d.id);
    if (live) points = live.usableRewardPoints;
  } catch {
    /* cached points */
  }
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  return { name: s.name || "會員", code: s.memberCode, points, group: s.memberGroup ?? null, tier: s.tier ?? null, shopName: settings.shopName || "ganbaru29" };
});

/** 重新產生會員卡連結（舊連結立即失效，例如客人手機遺失） */
export const resetMemberCard = onCall(async (req) => {
  await requireRole(req, "manager");
  const id = str(req.data?.shopperId, "會員", { max: 64 });
  const token = randomBytes(12).toString("hex");
  await db.doc(`shoppers/${id}`).update({ cardToken: token });
  return { token };
});

// ---------- 優惠碼 ----------

const COUPON_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉容易看錯的 0/O、1/I
const randomCode = (prefix: string) => prefix + Array.from({ length: 8 }, () => COUPON_ALPHABET[randomInt(0, COUPON_ALPHABET.length)]).join("");
export const normalizeCoupon = (c: string) => c.trim().toUpperCase().replace(/\s+/g, "");

export const createCoupons = onCall({ timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "manager");
  const promoId = str(req.data?.promoId, "促銷活動", { max: 60 });
  const promo = (await db.doc(`promotions/${promoId}`).get()).data();
  assert(promo, "找不到促銷活動", "not-found");
  const kind = req.data?.kind === "shared" ? "shared" : "single";
  const expiresAt = req.data?.expiresAt ? Timestamp.fromDate(new Date(`${str(req.data.expiresAt, "到期日", { max: 10 })}T23:59:59+08:00`)) : null;
  const base = { promoId, promoName: promo.name, kind, used: 0, active: true, expiresAt, createdBy: actor.name, createdAt: FieldValue.serverTimestamp() };

  if (kind === "shared") {
    const code = normalizeCoupon(str(req.data?.code, "優惠碼", { max: 30 }));
    assert(/^[A-Z0-9-]{3,30}$/.test(code), "優惠碼只能用英文、數字、-，3～30 個字");
    const ref = db.doc(`coupons/${code}`);
    const ok = await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return false;
      tx.set(ref, { ...base, code, maxUses: int(req.data?.maxUses ?? 0, "使用次數上限", { min: 0, max: 1e6 }) });
      return true;
    });
    if (!ok) throw new HttpsError("already-exists", "這個優惠碼已經存在");
    return { codes: [code] };
  }

  const count = int(req.data?.count, "張數", { min: 1, max: 1000 });
  const prefix = normalizeCoupon(str(req.data?.prefix, "前綴", { optional: true, max: 6 }) || "G");
  const codes: string[] = [];
  const writer = db.bulkWriter();
  while (codes.length < count) {
    const code = randomCode(prefix);
    if (codes.includes(code)) continue;
    codes.push(code);
    writer.create(db.doc(`coupons/${code}`), { ...base, code, maxUses: 1 });
  }
  await writer.close();
  return { codes };
});

export const setCouponActive = onCall(async (req) => {
  await requireRole(req, "manager");
  const code = normalizeCoupon(str(req.data?.code, "優惠碼", { max: 30 }));
  await db.doc(`coupons/${code}`).update({ active: req.data?.active === true });
  return { ok: true };
});

/** 結帳時驗證：回傳可解鎖的促銷 id；錯誤訊息直接給收銀員看 */
export async function validateCoupons(codes: string[]): Promise<{ promoIds: string[]; coupons: { code: string; promoId: string }[] }> {
  const out: { code: string; promoId: string }[] = [];
  for (const raw of codes.slice(0, 5)) {
    const code = normalizeCoupon(raw);
    const c = (await db.doc(`coupons/${code}`).get()).data();
    assert(c, `優惠碼 ${code} 不存在`, "not-found");
    assert(c.active, `優惠碼 ${code} 已停用`, "failed-precondition");
    assert(!c.expiresAt || c.expiresAt.toMillis() > Date.now(), `優惠碼 ${code} 已過期`, "failed-precondition");
    assert(!c.maxUses || c.used < c.maxUses, `優惠碼 ${code} 已經用過`, "failed-precondition");
    out.push({ code, promoId: c.promoId });
  }
  return { promoIds: out.map((x) => x.promoId), coupons: out };
}

/** 結帳完成後扣用次數（transaction，避免同一張單次碼被兩台同時用掉） */
export async function consumeCoupons(orderId: string, coupons: { code: string }[]) {
  for (const { code } of coupons) {
    const ref = db.doc(`coupons/${code}`);
    await db.runTransaction(async (tx) => {
      const c = (await tx.get(ref)).data();
      if (!c) return;
      if ((c.usedBy ?? []).includes(orderId)) return;
      tx.update(ref, { used: FieldValue.increment(1), usedBy: FieldValue.arrayUnion(orderId), lastUsedAt: FieldValue.serverTimestamp() });
    });
  }
}
