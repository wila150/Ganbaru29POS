import type { Timestamp } from "firebase/firestore";

export type Role = "owner" | "engineer" | "manager" | "staff";
const RANK: Record<Role, number> = { staff: 1, manager: 2, owner: 3, engineer: 3 };
export const atLeast = (role: Role | null | undefined, min: Role) => !!role && RANK[role] >= RANK[min];
export const ROLE_LABEL: Record<Role, string> = { owner: "老闆", engineer: "工程師", manager: "店長", staff: "員工" };

export type MoveType = "in" | "return" | "scrap" | "sale" | "refund" | "stocktake" | "undo";
export const MOVE_LABEL: Record<MoveType, string> = {
  in: "進貨",
  return: "退貨",
  scrap: "報廢",
  sale: "門市售出",
  refund: "門市退貨",
  stocktake: "盤點調整",
  undo: "撤銷",
};
export const STATUS_LABEL: Record<string, string> = {
  pending: "待同步",
  processing: "同步中",
  synced: "已同步",
  failed: "失敗",
  unknown: "待確認",
  canceled: "已取消",
  resolved: "已處理",
};

/** Methods the cashier picks at checkout. */
/** 結帳可選的付款方式（依「設定 → 付款方式」的順序與開關；applyPayMethods 會更新這個物件） */
export const PAY_LABEL: Record<string, string> = { cash: "現金", card: "信用卡", linepay: "LINE Pay", transfer: "轉帳" };
/** Every method that can appear on an order (display), incl. disabled / custom ones. */
export const PAY_NAME: Record<string, string> = { ...PAY_LABEL, exchange: "換貨抵用", ecpay: "綠界線上付款", newebpay: "藍新線上付款" };

export interface PayMethodDef {
  key: string;
  label: string;
  enabled: boolean;
  /** 金流手續費 %（報表「實際總收入」扣掉；例：LINE Pay 5） */
  feePct?: number;
}
export const BUILTIN_PAY: PayMethodDef[] = [
  { key: "cash", label: "現金", enabled: true },
  { key: "card", label: "信用卡", enabled: true },
  { key: "linepay", label: "LINE Pay", enabled: true, feePct: 5 },
  { key: "transfer", label: "轉帳", enabled: true },
];
/** 合併設定與內建：內建的一定在清單裡（可改名、關閉），自訂的接在後面；現金不能關 */
export function payMethodList(cfg?: PayMethodDef[] | null): PayMethodDef[] {
  const list = [...(cfg ?? [])].filter((m) => m && m.key && m.label);
  for (const b of BUILTIN_PAY) if (!list.some((m) => m.key === b.key)) list.push({ ...b });
  return list.map((m) => (m.key === "cash" ? { ...m, enabled: true } : m.feePct === undefined ? { ...m, feePct: BUILTIN_PAY.find((b) => b.key === m.key)?.feePct } : m));
}
/** 設定變了就更新 PAY_LABEL／PAY_NAME（所有畫面共用） */
export function applyPayMethods(cfg?: PayMethodDef[] | null) {
  const list = payMethodList(cfg);
  for (const k of Object.keys(PAY_LABEL)) delete PAY_LABEL[k];
  for (const m of list) {
    if (m.enabled) PAY_LABEL[m.key] = m.label;
    PAY_NAME[m.key] = m.label;
  }
}

/** Same rule as the backend: Firestore ids cannot contain "/". */
export const codeKey = (code: string) => encodeURIComponent(code.trim());

export function newId(prefix = ""): string {
  const raw = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
  return prefix + raw.slice(0, 24);
}

export function deviceId(): string {
  try {
    let id = localStorage.getItem("g29.device");
    if (!id) {
      const ua = navigator.userAgent;
      const kind = /iPad|Tablet/.test(ua) ? "平板" : /Mobile|iPhone|Android/.test(ua) ? "手機" : "電腦";
      id = `${kind}-${Math.random().toString(36).slice(2, 7)}`;
      localStorage.setItem("g29.device", id);
    }
    return id;
  } catch {
    return "未知裝置";
  }
}

export const money = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("zh-TW")}`);
export const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("zh-TW"));

type TsLike = Timestamp | { toDate(): Date } | Date | number | null | undefined;
export function toDate(t: TsLike): Date | null {
  if (!t) return null;
  if (t instanceof Date) return t;
  if (typeof t === "number") return new Date(t);
  return t.toDate();
}
export function fmtTime(t: TsLike, withDate = true) {
  const d = toDate(t);
  if (!d) return "—";
  return d.toLocaleString("zh-TW", withDate ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function todayStr(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function dayStart(d = new Date()) {
  return new Date(`${todayStr(d)}T00:00:00+08:00`);
}
export function addDays(dateStr: string, days: number) {
  return todayStr(new Date(new Date(`${dateStr}T12:00:00+08:00`).getTime() + days * 86400_000));
}

/** Excel opens UTF-8 CSV correctly when it starts with a BOM. */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function beep(ok = true) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1200 : 300;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.08 : 0.3));
    o.onended = () => ctx.close();
  } catch {
    /* no audio */
  }
}

/**
 * 台灣習慣的「幾折」↔ 折扣 %：85 或 8.5 → 85 折（打掉 15%）；9 → 9 折（10%）；95 → 95 折（5%）。
 * 0、10、空白 = 不打折。
 */
export function zheToPct(z: number): number {
  if (!(z > 0) || z >= 100 || z === 10) return 0;
  const pct = z < 10 ? 100 - z * 10 : 100 - z;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}
/** 15 → "85"、10 → "9"、0 → "" */
export function pctToZhe(pct: number | undefined): string {
  if (!pct) return "";
  const z = Math.round((100 - pct) * 10) / 10;
  return String(z % 10 === 0 ? z / 10 : z);
}
