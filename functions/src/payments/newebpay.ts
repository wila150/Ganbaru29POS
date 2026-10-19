import { createCipheriv, createDecipheriv, createHash } from "crypto";

/**
 * 藍新金流 NewebPay MPG（多功能收款）。顧客在手機上開藍新付款頁付款，藍新把結果 POST 到 NotifyURL。
 * TradeInfo = AES-256-CBC(query string) hex；TradeSha = SHA256("HashKey=…&{TradeInfo}&HashIV=…") 大寫。
 * 藍新沒有公開的測試商店帳號：測試環境需用你們自己在 cwww.newebpay.com 申請的測試商店。
 */
export interface NewebCreds {
  merchantId: string;
  hashKey: string; // 32 chars
  hashIv: string; // 16 chars
  stage: boolean;
}

export const mpgUrl = (stage: boolean) => (stage ? "https://ccore.newebpay.com/MPG/mpg_gateway" : "https://core.newebpay.com/MPG/mpg_gateway");

function encrypt(query: string, c: NewebCreds) {
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(c.hashKey, "utf8"), Buffer.from(c.hashIv, "utf8"));
  return Buffer.concat([cipher.update(query, "utf8"), cipher.final()]).toString("hex");
}
export function decryptTradeInfo(hex: string, c: NewebCreds): Record<string, unknown> {
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(c.hashKey, "utf8"), Buffer.from(c.hashIv, "utf8"));
  // 藍新回傳的補位不一定是標準 PKCS7（直接 final() 會 bad decrypt）→ 關掉自動補位，自己去掉尾巴的補位字元
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(Buffer.from(hex.trim(), "hex")), decipher.final()]);
  const pad = buf[buf.length - 1];
  const body = pad > 0 && pad <= 32 && buf.subarray(buf.length - pad).every((b) => b === pad) ? buf.subarray(0, buf.length - pad) : buf;
  const plain = body.toString("utf8").replace(/[\x00-\x1f]+$/g, "");
  try {
    return JSON.parse(plain);
  } catch {
    return Object.fromEntries(new URLSearchParams(plain));
  }
}
export const tradeSha = (tradeInfo: string, c: NewebCreds) => createHash("sha256").update(`HashKey=${c.hashKey}&${tradeInfo}&HashIV=${c.hashIv}`).digest("hex").toUpperCase();

export const NEWEB_EXTRA = ["APPLEPAY", "ANDROIDPAY", "SAMSUNGPAY", "LINEPAY", "TAIWANPAY"];

export function mpgForm(c: NewebCreds, o: { orderNo: string; amount: number; itemDesc: string; notifyUrl: string; returnUrl?: string; email?: string; extra?: string[] }) {
  const q = new URLSearchParams({
    MerchantID: c.merchantId,
    RespondType: "JSON",
    TimeStamp: String(Math.floor(Date.now() / 1000)),
    Version: "2.0",
    MerchantOrderNo: o.orderNo,
    Amt: String(Math.round(o.amount)),
    ItemDesc: o.itemDesc.slice(0, 50),
    NotifyURL: o.notifyUrl,
    ...(o.returnUrl ? { ReturnURL: o.returnUrl } : {}),
    ...(o.email ? { Email: o.email } : {}),
    EmailModify: "1",
    LoginType: "0",
    // 只開信用卡（Apple Pay、LINE Pay 等要先向藍新申請啟用，沒啟用時送出會整筆失敗：MPG02003）
    CREDIT: "1",
    // 店家在設定頁勾選、且已向藍新申請啟用的其他付款方式
    ...Object.fromEntries((o.extra ?? []).filter((k) => NEWEB_EXTRA.includes(k)).map((k) => [k, "1"])),
  }).toString();
  const TradeInfo = encrypt(q, c);
  return { action: mpgUrl(c.stage), params: { MerchantID: c.merchantId, TradeInfo, TradeSha: tradeSha(TradeInfo, c), Version: "2.0" } };
}

/** 查詢單筆交易（通知沒收到時補查）。TradeStatus 1 = 付款成功 */
export async function queryTrade(c: NewebCreds, orderNo: string, amount: number): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const amt = String(Math.round(amount));
  const check = createHash("sha256").update(`IV=${c.hashIv}&Amt=${amt}&MerchantID=${c.merchantId}&MerchantOrderNo=${orderNo}&Key=${c.hashKey}`).digest("hex").toUpperCase();
  const url = c.stage ? "https://ccore.newebpay.com/API/QueryTradeInfo" : "https://core.newebpay.com/API/QueryTradeInfo";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ MerchantID: c.merchantId, Version: "1.3", RespondType: "JSON", CheckValue: check, TimeStamp: String(Math.floor(Date.now() / 1000)), MerchantOrderNo: orderNo, Amt: amt }),
  });
  const j = (await res.json()) as { Status?: string; Result?: Record<string, unknown> };
  return { ok: j.Status === "SUCCESS", data: j.Result ?? {} };
}
