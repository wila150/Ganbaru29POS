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
  const plain = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString("utf8").replace(/[\x00-\x1f]+$/g, "");
  try {
    return JSON.parse(plain);
  } catch {
    return Object.fromEntries(new URLSearchParams(plain));
  }
}
export const tradeSha = (tradeInfo: string, c: NewebCreds) => createHash("sha256").update(`HashKey=${c.hashKey}&${tradeInfo}&HashIV=${c.hashIv}`).digest("hex").toUpperCase();

export function mpgForm(c: NewebCreds, o: { orderNo: string; amount: number; itemDesc: string; notifyUrl: string; returnUrl?: string; email?: string }) {
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
    // 只開即時完成的付款方式
    CREDIT: "1",
    APPLEPAY: "1",
    ANDROIDPAY: "1",
    LINEPAY: "1",
    TAIWANPAY: "1",
  }).toString();
  const TradeInfo = encrypt(q, c);
  return { action: mpgUrl(c.stage), params: { MerchantID: c.merchantId, TradeInfo, TradeSha: tradeSha(TradeInfo, c), Version: "2.0" } };
}
