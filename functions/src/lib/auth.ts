import type { CallableRequest } from "firebase-functions/v2/https";
import { db, HttpsError } from "./util";

/** engineer = the developer maintaining the system; same rights as owner, granted only via ENGINEER_EMAILS. */
export type Role = "owner" | "engineer" | "manager" | "staff";
const RANK: Record<Role, number> = { staff: 1, manager: 2, owner: 3, engineer: 3 };

export interface Actor {
  uid: string;
  name: string;
  role: Role;
}

export function atLeast(role: Role, min: Role) {
  return RANK[role] >= RANK[min];
}

/**
 * Every callable starts here. The users/{uid} doc (not the token claim) is checked,
 * so a disabled account stops writing immediately instead of when its token expires.
 */
export async function requireRole(req: CallableRequest, min: Role): Promise<Actor> {
  if (!req.auth) throw new HttpsError("unauthenticated", "請先登入");
  const snap = await db.doc(`users/${req.auth.uid}`).get();
  const u = snap.data();
  if (!u || !u.active) throw new HttpsError("permission-denied", "帳號未啟用或已停用");
  const role = u.role as Role;
  if (!atLeast(role, min)) throw new HttpsError("permission-denied", "權限不足");
  return { uid: req.auth.uid, name: u.name || u.email, role };
}
