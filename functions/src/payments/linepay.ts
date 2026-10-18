import { createHmac, randomUUID } from "crypto";
import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { requireRole } from "../lib/auth";
import { getSecret, setSecret } from "../lib/secrets";
import { assert, db, errMsg, FieldValue, HttpsError, sleep, str } from "../lib/util";

/**
 * LINE Pay 線下支付（Offline API v4）：店員掃客人 LINE Pay「付款碼」(My Code / oneTimeKey) 直接扣款。
 * 文件：https://developers-pay.line.me/offline-api-v4
 *  - 簽章：Base64(HMAC-SHA256(key = channelSecret, channelSecret + apiPath + (body | queryString) + nonce))
 *  - 付款請求等 20 秒；逾時（或回「付款處理中」）就每秒查一次狀態，AUTH_READY = 客人還在 LINE 上確認
 *  - 交易編號是 19 位數，一律當字串處理（JS number 會失真）
 * 金鑰只在 Secret Manager（LINEPAY：{channelId, channelSecret}）；settings/shop.linePay = { enabled, stage }。
 */

export interface LinePayCreds {
  channelId: string;
  channelSecret: string;
  stage: boolean;
}

export const LINEPAY_HOST = (stage: boolean) => (stage ? "https://sandbox-api-pay.line.me" : "https://api-pay.line.me");
const PAY_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;
/** 付款請求逾時後最多再查多久（客人可能要在 LINE 上輸入密碼） */
const POLL_MS = 45_000;

export const LINEPAY_ERRORS: Record<string, string> = {
  "1101": "這位客人不是 LINE Pay 用戶",
  "1102": "這位客人目前無法使用 LINE Pay 交易",
  "1104": "LINE Pay 商店資料錯誤，請檢查 Channel ID／Secret",
  "1105": "此商店目前無法使用 LINE Pay",
  "1106": "LINE Pay 連線資料（標頭）錯誤",
  "1110": "這張信用卡無法使用",
  "1124": "金額錯誤",
  "1133": "付款碼無效或已過期，請客人重新產生付款碼",
  "1141": "客人帳戶狀態異常",
  "1142": "客人餘額不足",
  "1145": "付款處理中",
  "1150": "查無交易",
  "1152": "重複的交易",
  "1155": "交易編號錯誤",
  "1163": "已超過可退款期限",
  "1164": "退款金額超過可退金額",
  "1165": "這筆交易已經退款",
  "1169": "請客人在 LINE Pay 上選擇付款方式並輸入密碼",
  "1170": "客人帳戶餘額有變動，請重新付款",
  "1172": "訂單編號重複",
  "1178": "商店不支援此幣別",
  "1179": "目前無法處理，請稍後再試",
  "1183": "金額低於最低付款金額",
  "1184": "金額超過最高付款金額",
  "1198": "重複的請求",
  "1199": "LINE Pay 內部錯誤",
  "1280": "信用卡暫時無法付款",
  "1281": "信用卡付款錯誤",
  "1282": "信用卡授權錯誤",
  "1283": "疑似盜刷，付款被拒",
  "1284": "信用卡付款暫停",
  "1287": "信用卡已過期",
  "1288": "信用卡額度不足",
  "1289": "超過信用卡額度",
  "1290": "超過單筆信用卡額度",
  "1291": "此卡已掛失",
  "1292": "此卡已停用",
  "1294": "此卡被拒絕交易",
  "1298": "信用卡拒絕交易",
  "2101": "參數錯誤",
  "2102": "資料格式錯誤",
  "9000": "LINE Pay 內部錯誤",
};
export const lpMessage = (code: string, fallback?: string) => LINEPAY_ERRORS[code] ?? (code.startsWith("190") ? "LINE Pay 暫時錯誤，請稍後再試" : `${fallback || "LINE Pay 錯誤"}（${code}）`);

export function signature(secret: string, apiPath: string, payload: string, nonce: string) {
  return createHmac("sha256", secret).update(secret + apiPath + payload + nonce).digest("base64");
}

/** 19 位數交易編號 → 字串，避免 JSON.parse 失真 */
export function parseLinePay(text: string) {
  return JSON.parse(text.replace(/"(transactionId|refundTransactionId)"\s*:\s*(\d+)/g, '"$1":"$2"'));
}

export interface LpResponse {
  returnCode: string;
  returnMessage?: string;
  info?: Record<string, unknown> & { transactionId?: string; status?: string; orderId?: string };
}

/** 呼叫 LINE Pay。逾時或連線失敗會丟出 kind = "timeout" | "network" 的錯誤。 */
export async function lpCall(c: LinePayCreds, method: "GET" | "POST", apiPath: string, opts: { body?: unknown; query?: Record<string, string>; timeoutMs?: number; host?: string } = {}): Promise<LpResponse> {
  const nonce = randomUUID();
  const qs = opts.query ? new URLSearchParams(opts.query).toString() : "";
  const body = method === "POST" ? JSON.stringify(opts.body ?? {}) : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-LINE-ChannelId": c.channelId,
    "X-LINE-Authorization-Nonce": nonce,
    "X-LINE-Authorization": signature(c.channelSecret, apiPath, method === "POST" ? body : qs, nonce),
    "X-LINE-MerchantDeviceType": "POS",
    "X-LINE-MerchantDeviceProfileId": "ganbaru29-pos",
  };
  const url = `${opts.host ?? LINEPAY_HOST(c.stage)}${apiPath}${qs ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: method === "POST" ? body : undefined, signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS) });
  } catch (e) {
    const err = new Error(`LINE Pay 連線${(e as Error).name === "TimeoutError" ? "逾時" : "失敗"}：${errMsg(e)}`) as Error & { kind: string };
    err.kind = (e as Error).name === "TimeoutError" ? "timeout" : "network";
    throw err;
  }
  const text = await res.text();
  try {
    const j = parseLinePay(text);
    return { returnCode: String(j.returnCode ?? j.resultCode ?? ""), returnMessage: j.returnMessage ?? j.statusMessage, info: j.info };
  } catch {
    throw new Error(`LINE Pay 回應格式錯誤（HTTP ${res.status}）`);
  }
}

export async function linePayCreds(): Promise<LinePayCreds> {
  const s = (await db.doc("settings/shop").get()).data()?.linePay ?? {};
  const raw = await getSecret("LINEPAY");
  let v: { channelId?: string; channelSecret?: string } = {};
  try {
    v = raw ? JSON.parse(raw) : {};
  } catch {
    /* ignore */
  }
  if (!v.channelId || !v.channelSecret) throw new HttpsError("failed-precondition", "尚未設定 LINE Pay 的 Channel ID 與 Channel Secret（設定 → 金流）");
  return { channelId: v.channelId, channelSecret: v.channelSecret, stage: s.stage !== false };
}

export type ChargeOutcome = { status: "paid"; transactionId: string; payInfo?: unknown } | { status: "failed"; code: string; message: string } | { status: "unknown"; message: string };

/** 付款逾時／處理中：每秒查一次，直到成功、失敗或超過 POLL_MS。 */
export async function waitForResult(c: LinePayCreds, orderId: string, pollMs = POLL_MS, intervalMs = 1000, host?: string): Promise<ChargeOutcome> {
  const until = Date.now() + pollMs;
  let last = "LINE Pay 還在等待客人確認";
  while (Date.now() < until) {
    await sleep(intervalMs);
    try {
      const r = await lpCall(c, "GET", `/v4/payments/orders/${encodeURIComponent(orderId)}/check`, { host });
      if (r.returnCode === "0000") {
        const st = r.info?.status;
        if (st === "COMPLETE") {
          const d = await paymentDetail(c, orderId, host).catch(() => null);
          return { status: "paid", transactionId: d?.transactionId ?? "", payInfo: d?.payInfo };
        }
        if (st === "FAIL") return { status: "failed", code: "FAIL", message: "付款失敗" };
        if (st === "CANCEL") return { status: "failed", code: "CANCEL", message: "客人取消付款" };
        last = "等待客人在 LINE 上確認付款";
      } else if (r.returnCode !== "1150" && r.returnCode !== "1145") {
        last = lpMessage(r.returnCode, r.returnMessage);
      }
    } catch (e) {
      last = errMsg(e);
    }
  }
  return { status: "unknown", message: last };
}

/** 付款明細（拿 transactionId） */
async function paymentDetail(c: LinePayCreds, orderId: string, host?: string): Promise<{ transactionId: string; payInfo?: unknown } | null> {
  const r = await lpCall(c, "GET", "/v4/payments", { query: { orderId }, host });
  const list = (r.info as unknown as { transactionId: string; payInfo?: unknown }[] | undefined) ?? [];
  const first = Array.isArray(list) ? list[0] : null;
  return r.returnCode === "0000" && first ? { transactionId: String(first.transactionId), payInfo: first.payInfo } : null;
}

/** 付款：送出付款碼 → 成功／失敗／結果不明（不明時不重送，交給查詢）。 */
export async function charge(c: LinePayCreds, o: { orderId: string; amount: number; oneTimeKey: string; productName: string }, host?: string, pollMs?: number): Promise<ChargeOutcome> {
  let r: LpResponse;
  try {
    r = await lpCall(c, "POST", "/v4/payments/oneTimeKeys/pay", { body: { productName: o.productName.slice(0, 100), amount: o.amount, currency: "TWD", orderId: o.orderId, oneTimeKey: o.oneTimeKey }, timeoutMs: PAY_TIMEOUT_MS, host });
  } catch (e) {
    logger.warn("linepay pay: no response, checking status", errMsg(e));
    return waitForResult(c, o.orderId, pollMs, undefined, host);
  }
  if (r.returnCode === "0000") return { status: "paid", transactionId: String(r.info?.transactionId ?? ""), payInfo: r.info?.payInfo };
  if (r.returnCode === "1145" || r.returnCode === "1169" || r.returnCode.startsWith("190")) return waitForResult(c, o.orderId, pollMs, undefined, host);
  return { status: "failed", code: r.returnCode, message: lpMessage(r.returnCode, r.returnMessage) };
}

export async function refund(c: LinePayCreds, orderId: string, amount: number | null, host?: string) {
  const r = await lpCall(c, "POST", `/v4/payments/orders/${encodeURIComponent(orderId)}/refund`, { body: amount === null ? {} : { refundAmount: amount }, host });
  if (r.returnCode !== "0000") throw new Error(lpMessage(r.returnCode, r.returnMessage));
  return { refundTransactionId: String(r.info?.refundTransactionId ?? ""), at: String(r.info?.refundTransactionDate ?? "") };
}

// ---------- callables ----------

async function applyOutcome(ref: FirebaseFirestore.DocumentReference, out: ChargeOutcome) {
  if (out.status === "paid") await ref.update({ status: "paid", paidAt: FieldValue.serverTimestamp(), providerTradeNo: out.transactionId, paymentType: "LINE Pay", raw: JSON.parse(JSON.stringify(out.payInfo ?? null)), lastError: null });
  else if (out.status === "failed") await ref.update({ status: "failed", lastError: out.message, errorCode: out.code });
  else await ref.update({ status: "unknown", lastError: out.message });
}

/** POS：掃到客人的 LINE Pay 付款碼 → 扣款。每次掃碼都是新的一筆（LINE Pay 不允許重複訂單編號）。 */
export const linePayCharge = onCall({ timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "staff");
  const s = (await db.doc("settings/shop").get()).data() ?? {};
  assert(s.linePay?.enabled, "尚未啟用 LINE Pay 串接（設定 → 金流）", "failed-precondition");
  const amount = Math.round(Number(req.data?.amount));
  assert(Number.isInteger(amount) && amount > 0 && amount <= 1e7, "金額不正確");
  const oneTimeKey = str(req.data?.oneTimeKey, "付款碼", { max: 40 }).replace(/\s/g, "");
  assert(/^\d{12,24}$/.test(oneTimeKey), "這不是 LINE Pay 付款碼，請掃客人 LINE Pay 的「付款」條碼");
  const c = await linePayCreds();
  const ref = db.collection("posPayments").doc();
  const orderId = `GB${ref.id}`;
  await ref.set({
    provider: "linepay",
    stage: c.stage,
    orderId: str(req.data?.orderId, "訂單", { optional: true, max: 64 }) || "pos",
    lpOrderId: orderId,
    amount,
    itemName: str(req.data?.itemName, "品名", { optional: true, max: 300 }) || "門市消費",
    status: "processing",
    createdBy: actor.name,
    createdAt: FieldValue.serverTimestamp(),
    usedBy: null,
    refunded: 0,
  });
  const out = await charge(c, { orderId, amount, oneTimeKey, productName: str(req.data?.itemName, "品名", { optional: true, max: 300 }) || "ganbaru29 門市消費" });
  await applyOutcome(ref, out);
  return { id: ref.id, status: out.status, message: out.status === "paid" ? null : out.message };
});

/** 結果不明時，店員按「查詢付款結果」 */
export const linePayCheck = onCall({ timeoutSeconds: 60 }, async (req) => {
  await requireRole(req, "staff");
  const ref = db.doc(`posPayments/${str(req.data?.id, "付款", { max: 40 })}`);
  const p = (await ref.get()).data();
  assert(p && p.provider === "linepay", "找不到這筆 LINE Pay 付款", "not-found");
  if (p.status === "paid" || p.status === "failed") return { status: p.status, message: p.lastError ?? null };
  const out = await waitForResult(await linePayCreds(), p.lpOrderId, 3000);
  await applyOutcome(ref, out);
  return { status: out.status, message: out.status === "paid" ? null : out.message };
});

/** 退款（posRefund 用）：同一筆可分次部分退款 */
export async function refundLinePay(paymentId: string, amount: number) {
  const ref = db.doc(`posPayments/${paymentId}`);
  const p = (await ref.get()).data();
  if (!p || p.provider !== "linepay" || p.status !== "paid") throw new Error("找不到已付款的 LINE Pay 紀錄");
  const left = p.amount - (p.refunded ?? 0);
  if (amount > left) throw new Error(`LINE Pay 可退金額只剩 $${left}`);
  const r = await refund(await linePayCreds(), p.lpOrderId, amount === p.amount && !(p.refunded > 0) ? null : amount);
  await ref.update({ refunded: FieldValue.increment(amount), refunds: FieldValue.arrayUnion({ amount, refundTransactionId: r.refundTransactionId, at: r.at }) });
  return r;
}

/** 已扣款但沒結成帳（例如店員取消）：店長以上可以直接退回 */
export const linePayRefundUnused = onCall({ timeoutSeconds: 60 }, async (req) => {
  await requireRole(req, "manager");
  const id = str(req.data?.id, "付款", { max: 40 });
  const ref = db.doc(`posPayments/${id}`);
  const claimed = await db.runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data();
    assert(p && p.provider === "linepay" && p.status === "paid", "找不到已付款的 LINE Pay 紀錄", "not-found");
    assert(!p.usedBy, "這筆付款已經用在訂單上，請用交易瀏覽的退貨功能", "failed-precondition");
    tx.update(ref, { usedBy: "refunded-unused" });
    return p;
  });
  try {
    await refundLinePay(id, claimed.amount - (claimed.refunded ?? 0));
  } catch (e) {
    await ref.update({ usedBy: null });
    throw new HttpsError("failed-precondition", `退款失敗：${errMsg(e)}`);
  }
  return { ok: true };
});

// ---------- 設定 ----------

export const setLinePayCreds = onCall(async (req) => {
  await requireRole(req, "owner");
  const channelId = str(req.data?.channelId, "Channel ID", { max: 20 });
  const channelSecret = str(req.data?.channelSecret, "Channel Secret", { max: 64 });
  assert(/^\d{6,20}$/.test(channelId), "Channel ID 應為數字");
  assert(/^[0-9a-zA-Z]{16,64}$/.test(channelSecret), "Channel Secret 格式不正確");
  await setSecret("LINEPAY", JSON.stringify({ channelId, channelSecret }));
  await db.doc("settings/shop").set({ credsSet: { linepay: true } }, { merge: true });
  return { ok: true };
});

/** 測試連線：查一筆不存在的訂單；回「查無交易」代表金鑰正確 */
export const testLinePay = onCall(async (req) => {
  await requireRole(req, "owner");
  const c = await linePayCreds();
  const r = await lpCall(c, "GET", "/v4/payments", { query: { orderId: `TEST${Date.now()}` } });
  const ok = r.returnCode === "0000" || r.returnCode === "1150";
  return { ok, channelId: c.channelId, stage: c.stage, message: ok ? `連線成功（${c.stage ? "測試環境" : "正式環境"}）` : lpMessage(r.returnCode, r.returnMessage) };
});

export const linePayStatus = onCall(async (req) => {
  await requireRole(req, "owner");
  try {
    const raw = await getSecret("LINEPAY");
    const v = raw ? JSON.parse(raw) : null;
    return { channelId: v?.channelId ?? null };
  } catch {
    return { channelId: null };
  }
});
