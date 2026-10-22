/**
 * 預先叫醒伺服器函式：Cloud Functions 閒置一陣子會休眠，第一次呼叫要多等 2～5 秒。
 * 在店員「快要用到」時（打開收銀、購物車放第一件、打開結帳）先輕輕敲一下，真的按結帳時就不用等。
 * 敲的方式是一個不帶資料的 GET（函式會直接回錯誤，但已經醒了），不會做任何事情。
 */
const last = new Map<string, number>();
const base = `https://asia-east1-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net`;

export function warm(...names: string[]) {
  if (import.meta.env.DEV) return;
  const now = Date.now();
  for (const n of names) {
    if (now - (last.get(n) ?? 0) < 4 * 60_000) continue; // 4 分鐘內敲過就不再敲
    last.set(n, now);
    fetch(`${base}/${n}`, { method: "GET", mode: "no-cors", cache: "no-store", keepalive: true }).catch(() => undefined);
  }
}

/** 收銀會用到的函式 */
export const POS_FUNCTIONS = ["posCheckout", "searchShopper", "linePayCharge", "createOnlinePayment", "sendReceipt", "refreshShopper"];
