import { getAuth } from "firebase-admin/auth";
import { defineString } from "firebase-functions/params";
import { onCall } from "firebase-functions/v2/https";
import { requireRole, Role } from "./lib/auth";
import { assert, db, FieldValue, HttpsError, str, Timestamp } from "./lib/util";

/** The owner's Google email, set at deploy time (functions/.env). Only this account can become owner. */
const OWNER_EMAIL = defineString("OWNER_EMAIL");
/** Engineers' Google emails, comma separated (functions/.env). Same rights as the owner. */
const ENGINEER_EMAILS = defineString("ENGINEER_EMAILS", { default: "" });
const ASSIGNABLE: Role[] = ["manager", "staff"];
const PROTECTED: Role[] = ["owner", "engineer"];
const INVITE_DAYS = 7;

async function setUser(uid: string, data: { email: string; name: string; role: Role; active: boolean }) {
  await db.doc(`users/${uid}`).set({ ...data, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await getAuth().setCustomUserClaims(uid, { role: data.role, active: data.active });
}

/**
 * First login of the owner or an engineer: creates their account from functions/.env.
 * Safe to call repeatedly. An engineer the owner has disabled stays disabled.
 */
export const claimOwner = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "請先登入");
  const email = (req.auth.token.email || "").toLowerCase();
  assert(email && req.auth.token.email_verified, "請用已驗證的 Google 帳號登入", "permission-denied");
  const engineers = ENGINEER_EMAILS.value().split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const role: Role | null = email === OWNER_EMAIL.value().trim().toLowerCase() ? "owner" : engineers.includes(email) ? "engineer" : null;
  assert(role, "這個帳號不是老闆或工程師帳號", "permission-denied");
  const existing = (await db.doc(`users/${req.auth.uid}`).get()).data();
  if (existing?.role === role && existing.active) return { role };
  assert(!(existing && role === "engineer" && !existing.active), "工程師帳號已被老闆停用", "permission-denied");
  await setUser(req.auth.uid, { email, name: existing?.name || req.auth.token.name || email, role, active: true });
  return { role };
});

/** 老闆輸入 Email 和角色 → 產生邀請連結 */
export const inviteStaff = onCall(async (req) => {
  const actor = await requireRole(req, "owner");
  const email = str(req.data?.email, "Email", { max: 120 }).toLowerCase();
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), "Email 格式不正確");
  const role = req.data?.role as Role;
  assert(role === "manager" || role === "staff", "角色只能是店長或員工");
  const ref = db.collection("invites").doc();
  await ref.set({
    email,
    role,
    name: str(req.data?.name, "姓名", { optional: true, max: 40 }) || null,
    createdBy: actor.uid,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + INVITE_DAYS * 86400_000),
    usedBy: null,
  });
  return { id: ref.id };
});

/** 員工打開連結、用自己的 Google 帳號登入 → 角色寫進 custom claim */
export const acceptInvite = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "請先用 Google 帳號登入");
  const id = str(req.data?.id, "邀請", { max: 60 });
  const email = (req.auth.token.email || "").toLowerCase();
  const uid = req.auth.uid;
  const ref = db.doc(`invites/${id}`);
  const inv = await db.runTransaction(async (tx) => {
    const i = (await tx.get(ref)).data();
    assert(i, "邀請不存在", "not-found");
    assert(!i.usedBy || i.usedBy === uid, "這個邀請已經被使用", "failed-precondition");
    assert(i.expiresAt.toMillis() > Date.now(), "邀請已過期，請老闆重新邀請", "failed-precondition");
    assert(i.email === email, `請用 ${i.email} 這個 Google 帳號登入`, "permission-denied");
    tx.update(ref, { usedBy: uid, usedAt: FieldValue.serverTimestamp() });
    return i;
  });
  const existing = (await db.doc(`users/${uid}`).get()).data();
  assert(!PROTECTED.includes(existing?.role), "老闆／工程師帳號不需要接受邀請", "failed-precondition");
  await setUser(uid, { email, name: inv.name || req.auth.token.name || email, role: inv.role, active: true });
  return { role: inv.role };
});

export const setRole = onCall(async (req) => {
  const actor = await requireRole(req, "owner");
  const uid = str(req.data?.uid, "員工", { max: 128 });
  const role = req.data?.role as Role;
  assert(ASSIGNABLE.includes(role), "角色只能是店長或員工");
  assert(uid !== actor.uid, "不能改自己的角色");
  const u = (await db.doc(`users/${uid}`).get()).data();
  assert(u, "找不到這位員工", "not-found");
  assert(!PROTECTED.includes(u.role), "老闆／工程師的角色不能在這裡更改", "permission-denied");
  await setUser(uid, { email: u.email, name: u.name, role, active: u.active });
  return { ok: true };
});

/** 停用後立刻不能寫入（每個函式都會查 users.active），過去的紀錄保留 */
export const setActive = onCall(async (req) => {
  const actor = await requireRole(req, "owner");
  const uid = str(req.data?.uid, "員工", { max: 128 });
  const active = req.data?.active === true;
  assert(uid !== actor.uid, "不能停用自己");
  const u = (await db.doc(`users/${uid}`).get()).data();
  assert(u, "找不到這位員工", "not-found");
  assert(u.role !== "owner", "不能停用老闆帳號", "permission-denied");
  assert(u.role !== "engineer" || actor.role === "owner", "只有老闆可以停用工程師", "permission-denied");
  await setUser(uid, { email: u.email, name: u.name, role: u.role, active });
  if (!active) await getAuth().revokeRefreshTokens(uid);
  return { ok: true };
});

export const renameStaff = onCall(async (req) => {
  await requireRole(req, "owner");
  const uid = str(req.data?.uid, "員工", { max: 128 });
  await db.doc(`users/${uid}`).update({ name: str(req.data?.name, "姓名", { max: 40 }) });
  return { ok: true };
});
