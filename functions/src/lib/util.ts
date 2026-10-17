import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError } from "firebase-functions/v2/https";

initializeApp();

export const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

export { FieldValue, Timestamp, HttpsError };

export const REGION = "asia-east1";
// Must run before any function is defined; every module imports this file first.
setGlobalOptions({ region: REGION, maxInstances: 10 });
export const TZ = "Asia/Taipei";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** YYYY-MM-DD in Taiwan time. */
export function taipeiDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Start of today (Taiwan time) as a Date. */
export function taipeiDayStart(d = new Date()): Date {
  return new Date(`${taipeiDate(d)}T00:00:00+08:00`);
}

/** Firestore doc ids cannot contain "/", so barcodes are URI-encoded. The web app uses the same rule. */
export function codeKey(code: string): string {
  return encodeURIComponent(code.trim());
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function assert(cond: unknown, message: string, code: "invalid-argument" | "failed-precondition" | "not-found" | "permission-denied" | "unauthenticated" | "resource-exhausted" | "already-exists" = "invalid-argument"): asserts cond {
  if (!cond) throw new HttpsError(code, message);
}

export function int(v: unknown, name: string, { min = -Infinity, max = Infinity } = {}): number {
  const n = Number(v);
  assert(Number.isInteger(n) && n >= min && n <= max, `${name} 必須是 ${min}~${max} 的整數`);
  return n;
}

export function num(v: unknown, name: string, { min = -Infinity, max = Infinity } = {}): number {
  const n = Number(v);
  assert(Number.isFinite(n) && n >= min && n <= max, `${name} 數值不正確`);
  return n;
}

export function str(v: unknown, name: string, { max = 200, optional = false } = {}): string {
  if ((v === undefined || v === null || v === "") && optional) return "";
  assert(typeof v === "string" && v.trim().length > 0 && v.length <= max, `${name} 未填或過長`);
  return v.trim();
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 生日：接受 YYYY-MM-DD 或 YYYY/MM/DD，回傳 meepShop 要的 YYYY/MM/DD */
export function birthDateInput(v: unknown): string {
  const m = String(v ?? "").trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  assert(m, "請填生日（例：1995/08/20）");
  const [y, mo, d] = [Number(m![1]), Number(m![2]), Number(m![3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  assert(dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && y >= 1900 && dt.getTime() < Date.now(), "生日日期不正確");
  return `${y}/${String(mo).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
}
