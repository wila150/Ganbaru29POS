import { logger } from "firebase-functions";
import type { Actor } from "./auth";
import { db, FieldValue } from "./util";

/** 操作紀錄：誰、何時、做了什麼（作廢、退貨、改價、日結、權限、金鑰…）。只增不改，店長以上可查。 */
export async function audit(actor: Pick<Actor, "uid" | "name" | "role">, action: string, detail: Record<string, unknown> = {}) {
  try {
    await db.collection("auditLogs").add({ action, by: actor.uid, byName: actor.name, role: actor.role, detail: JSON.parse(JSON.stringify(detail)), at: FieldValue.serverTimestamp() });
  } catch (e) {
    logger.warn("audit failed", action, e);
  }
}
