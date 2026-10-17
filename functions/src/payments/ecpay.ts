import { createCipheriv, createDecipheriv, createHash } from "crypto";

/**
 * 綠界 ECPay
 *  - 全方位金流 AIO (AioCheckOut/V5): the customer scans a QR on the POS and pays on ECPay's page
 *    (credit card, Apple Pay, TWQR, LINE Pay via ECPay, …); ECPay posts the result to our ReturnURL.
 *  - B2C 電子發票 (B2CInvoice/Issue, Invalid): AES-128-CBC JSON API.
 * Spec: https://developers.ecpay.com.tw
 */

export interface EcpayCreds {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  stage: boolean;
}

/** ECPay's public test merchants (from the developer site). */
export const ECPAY_TEST_PAYMENT: EcpayCreds = { merchantId: "3002607", hashKey: "pwFHCqoQZGmho4w6", hashIv: "EkRm7iFT261dpevs", stage: true };
export const ECPAY_TEST_INVOICE: EcpayCreds = { merchantId: "2000132", hashKey: "ejCk326UnaZWKisg", hashIv: "q9jcZX8Ib9LM8wYk", stage: true };

export const aioUrl = (stage: boolean) => (stage ? "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5" : "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5");
const queryUrl = (stage: boolean) => (stage ? "https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5" : "https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5");
const invoiceBase = (stage: boolean) => (stage ? "https://einvoice-stage.ecpay.com.tw" : "https://einvoice.ecpay.com.tw");

/** PHP urlencode() + ECPay's .NET restore table, lowercased. */
function ecpayEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .toLowerCase()
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")");
}

export function checkMacValue(params: Record<string, string | number>, c: Pick<EcpayCreds, "hashKey" | "hashIv">): string {
  const body = Object.keys(params)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const raw = `HashKey=${c.hashKey}&${body}&HashIV=${c.hashIv}`;
  return createHash("sha256").update(ecpayEncode(raw)).digest("hex").toUpperCase();
}

export function verifyCheckMac(params: Record<string, string>, c: Pick<EcpayCreds, "hashKey" | "hashIv">): boolean {
  return !!params.CheckMacValue && checkMacValue(params, c) === params.CheckMacValue.toUpperCase();
}

function tradeDate(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600_000); // Taiwan time
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** Form fields for AioCheckOut/V5 (posted from the customer's phone by our pay page). */
export function aioForm(c: EcpayCreds, o: { tradeNo: string; amount: number; itemName: string; returnUrl: string; resultUrl?: string; desc?: string }) {
  const params: Record<string, string | number> = {
    MerchantID: c.merchantId,
    MerchantTradeNo: o.tradeNo,
    MerchantTradeDate: tradeDate(),
    PaymentType: "aio",
    TotalAmount: Math.round(o.amount),
    TradeDesc: o.desc ?? "ganbaru29 門市消費",
    ItemName: o.itemName.slice(0, 380),
    ReturnURL: o.returnUrl,
    ChoosePayment: "ALL",
    // Only payments that finish on the spot; ATM / 超商 would leave the customer waiting at the counter.
    IgnorePayment: "ATM#CVS#BARCODE#WebATM#BNPL",
    EncryptType: 1,
  };
  if (o.resultUrl) params.ClientBackURL = o.resultUrl;
  params.CheckMacValue = checkMacValue(params, c);
  return { action: aioUrl(c.stage), params };
}

/** Ask ECPay directly whether a trade was paid (used when the callback is late). */
export async function queryTrade(c: EcpayCreds, tradeNo: string) {
  const params: Record<string, string | number> = { MerchantID: c.merchantId, MerchantTradeNo: tradeNo, TimeStamp: Math.floor(Date.now() / 1000) };
  params.CheckMacValue = checkMacValue(params, c);
  const res = await fetch(queryUrl(c.stage), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params as Record<string, string>).toString() });
  const out = Object.fromEntries(new URLSearchParams(await res.text()));
  return { ok: verifyCheckMac(out, c), data: out as Record<string, string> };
}

// ---------- B2C 電子發票 ----------

function aesEncrypt(data: unknown, c: EcpayCreds): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(c.hashKey, "utf8"), Buffer.from(c.hashIv, "utf8"));
  const plain = encodeURIComponent(JSON.stringify(data));
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}
function aesDecrypt(b64: string, c: EcpayCreds): unknown {
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(c.hashKey, "utf8"), Buffer.from(c.hashIv, "utf8"));
  const plain = Buffer.concat([decipher.update(Buffer.from(b64, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(decodeURIComponent(plain.replace(/\+/g, " ")));
}

async function invoiceCall<T>(c: EcpayCreds, path: string, data: Record<string, unknown>): Promise<T & { RtnCode: number; RtnMsg: string }> {
  const res = await fetch(invoiceBase(c.stage) + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ MerchantID: c.merchantId, RqHeader: { Timestamp: Math.floor(Date.now() / 1000) }, Data: aesEncrypt({ MerchantID: c.merchantId, ...data }, c) }),
  });
  const body = (await res.json()) as { TransCode: number; TransMsg: string; Data?: string };
  if (body.TransCode !== 1 || !body.Data) throw new Error(`綠界發票 API 錯誤：${body.TransMsg}（${body.TransCode}）`);
  return aesDecrypt(body.Data, c) as T & { RtnCode: number; RtnMsg: string };
}

export interface InvoiceItem {
  name: string;
  qty: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceBuyer {
  /** 統一編號 (B2B on a B2C invoice) */
  taxId?: string;
  companyName?: string;
  /** 手機條碼 /ABC1234 */
  mobileBarcode?: string;
  /** 自然人憑證 */
  citizenCert?: string;
  /** 愛心碼 */
  loveCode?: string;
  email?: string;
  phone?: string;
  /** required by ECPay when the invoice is printed (統編); the shop address is used if empty */
  address?: string;
}

export async function issueInvoice(c: EcpayCreds, o: { relateNumber: string; amount: number; items: InvoiceItem[]; buyer: InvoiceBuyer; customerName?: string }) {
  const b = o.buyer;
  const carrier = b.mobileBarcode ? { CarrierType: "3", CarrierNum: b.mobileBarcode } : b.citizenCert ? { CarrierType: "2", CarrierNum: b.citizenCert } : { CarrierType: "", CarrierNum: "" };
  const print = b.taxId ? "1" : carrier.CarrierType || b.loveCode ? "0" : "1";
  const data = {
    RelateNumber: o.relateNumber,
    CustomerIdentifier: b.taxId ?? "",
    CustomerName: b.taxId ? b.companyName || "公司" : o.customerName || (print === "1" ? "消費者" : ""),
    CustomerAddr: print === "1" ? b.address ?? "" : "",
    CustomerPhone: b.phone ?? "",
    CustomerEmail: b.email ?? "",
    Print: print,
    Donation: b.loveCode && !b.taxId ? "1" : "0",
    LoveCode: b.loveCode && !b.taxId ? b.loveCode : "",
    ...carrier,
    TaxType: "1",
    SalesAmount: Math.round(o.amount),
    InvType: "07",
    vat: "1",
    Items: o.items.map((it, i) => ({ ItemSeq: i + 1, ItemName: it.name.slice(0, 100), ItemCount: it.qty, ItemWord: "件", ItemPrice: it.unitPrice, ItemTaxType: "1", ItemAmount: it.amount })),
  };
  const r = await invoiceCall<{ InvoiceNo?: string; InvoiceDate?: string; RandomNumber?: string }>(c, "/B2CInvoice/Issue", data);
  if (r.RtnCode !== 1) throw new Error(`開立發票失敗：${r.RtnMsg}`);
  return { invoiceNo: r.InvoiceNo!, invoiceDate: r.InvoiceDate!, randomNumber: r.RandomNumber!, print: print === "1" };
}

export async function invalidInvoice(c: EcpayCreds, invoiceNo: string, invoiceDate: string, reason: string) {
  const r = await invoiceCall<{ InvoiceNo?: string }>(c, "/B2CInvoice/Invalid", { InvoiceNo: invoiceNo, InvoiceDate: invoiceDate.slice(0, 10), Reason: reason.slice(0, 20) || "退貨" });
  if (r.RtnCode !== 1) throw new Error(`作廢發票失敗：${r.RtnMsg}`);
}

/** 手機條碼驗證：/ + 7 碼（大寫英數與 +-.） */
export const validMobileBarcode = (s: string) => /^\/[0-9A-Z+\-.]{7}$/.test(s);

/** 電子發票證明聯列印網址（綠界產生，含財政部規定的條碼與 QR code）。PrintStyle 1 = 熱感應一聯式。 */
export async function invoicePrintUrl(c: EcpayCreds, invoiceNo: string, invoiceDate: string, style: "1" | "3" = "1") {
  const r = await invoiceCall<{ InvoiceHtml?: string }>(c, "/B2CInvoice/InvoicePrint", { InvoiceNo: invoiceNo, InvoiceDate: invoiceDate.slice(0, 10), PrintStyle: style, IsShowingDetail: "1" });
  if (r.RtnCode !== 1 || !r.InvoiceHtml) throw new Error(`取得發票列印頁失敗：${r.RtnMsg}`);
  return r.InvoiceHtml;
}
