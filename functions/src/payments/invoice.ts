import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { requireRole } from "../lib/auth";
import { assert, db, errMsg, FieldValue, HttpsError, str } from "../lib/util";
import * as ecpay from "./ecpay";
import { ecpayInvoiceCreds } from "./index";

/** 結帳時顧客選的發票開立方式 */
export interface InvoiceRequest {
  type: "print" | "mobile" | "taxId" | "donate";
  mobileBarcode?: string;
  taxId?: string;
  companyName?: string;
  loveCode?: string;
  email?: string;
}

export function parseInvoiceRequest(raw: unknown): InvoiceRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type as InvoiceRequest["type"];
  assert(["print", "mobile", "taxId", "donate"].includes(type), "發票類型不正確");
  const out: InvoiceRequest = { type, email: str(r.email, "Email", { optional: true, max: 100 }) || undefined };
  if (type === "mobile") {
    out.mobileBarcode = str(r.mobileBarcode, "手機條碼", { max: 8 }).toUpperCase();
    assert(ecpay.validMobileBarcode(out.mobileBarcode), "手機條碼格式為 / 加 7 碼");
  }
  if (type === "taxId") {
    out.taxId = str(r.taxId, "統一編號", { max: 8 });
    assert(/^\d{8}$/.test(out.taxId), "統一編號為 8 碼數字");
    out.companyName = str(r.companyName, "公司名稱", { optional: true, max: 60 }) || undefined;
  }
  if (type === "donate") {
    out.loveCode = str(r.loveCode, "愛心碼", { max: 7 });
    assert(/^\d{3,7}$/.test(out.loveCode), "愛心碼為 3～7 碼數字");
  }
  return out;
}

/** Invoice lines must add up to the order total: item lines + one 折扣 line (+ 服務費). */
function invoiceItems(o: FirebaseFirestore.DocumentData): ecpay.InvoiceItem[] {
  const items: ecpay.InvoiceItem[] = (o.lines ?? [])
    .filter((l: { total: number }) => l.total !== 0)
    .map((l: { productTitle: string; options: string; qty: number; total: number }) => ({
      name: `${l.productTitle}${l.options ? " " + l.options : ""}`,
      qty: l.qty,
      unitPrice: Math.round((l.total / l.qty) * 100) / 100,
      amount: l.total,
    }));
  if (o.serviceFee) items.push({ name: "服務費", qty: 1, unitPrice: o.serviceFee, amount: o.serviceFee });
  const sum = items.reduce((s, i) => s + i.amount, 0);
  const diff = o.total - sum;
  if (diff !== 0) items.push({ name: diff < 0 ? "折扣" : "調整", qty: 1, unitPrice: diff, amount: diff });
  return items;
}

/** 開立電子發票；失敗不影響交易，記在訂單上可重開。 */
export async function issueForOrder(orderId: string) {
  const ref = db.doc(`posOrders/${orderId}`);
  const o = (await ref.get()).data();
  if (!o || o.invoice?.no || !(o.total > 0)) return null;
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  if (!settings.invoice?.enabled) return null;
  const req = (o.invoiceRequest ?? { type: "print" }) as InvoiceRequest;
  try {
    const c = await ecpayInvoiceCreds();
    const r = await ecpay.issueInvoice(c, {
      // unique per merchant: order number + part of the order id (+ attempt for re-issues)
      relateNumber: (o.orderNo.replace(/[^\w]/g, "") + orderId.slice(-6) + (o.invoiceAttempts ? `R${o.invoiceAttempts}` : "")).slice(0, 30),
      amount: o.total,
      items: invoiceItems(o),
      customerName: o.shopper?.name || undefined,
      buyer: {
        mobileBarcode: req.type === "mobile" ? req.mobileBarcode : undefined,
        taxId: req.type === "taxId" ? req.taxId : undefined,
        companyName: req.companyName,
        loveCode: req.type === "donate" ? req.loveCode : undefined,
        email: req.email || o.shopper?.email || settings.invoice?.notifyEmail || undefined,
        phone: o.shopper?.mobile || undefined,
        address: settings.invoice?.address || undefined,
      },
    });
    const invoice = { no: r.invoiceNo, date: r.invoiceDate, random: r.randomNumber, print: r.print, stage: c.stage, type: req.type, taxId: req.taxId ?? null };
    await ref.update({ invoice, invoiceError: null });
    return invoice;
  } catch (e) {
    logger.warn(`invoice ${orderId}`, e);
    await ref.update({ invoiceError: errMsg(e), invoiceAttempts: FieldValue.increment(1) });
    return null;
  }
}

/** Refund side: a full refund / void cancels the invoice; a partial one needs an allowance (折讓). */
export async function invoiceAfterRefund(orderId: string, full: boolean, reason: string) {
  const ref = db.doc(`posOrders/${orderId}`);
  const o = (await ref.get()).data();
  if (!o?.invoice?.no || o.invoice.voided) return;
  if (!full) {
    await ref.update({ invoiceNote: "部分退貨：請到綠界後台開立折讓單" });
    return;
  }
  try {
    const c = await ecpayInvoiceCreds();
    await ecpay.invalidInvoice(c, o.invoice.no, o.invoice.date, reason);
    await ref.update({ "invoice.voided": true, invoiceNote: null });
  } catch (e) {
    await ref.update({ invoiceNote: `發票作廢失敗，請到綠界後台處理：${errMsg(e)}` });
  }
}

export const reissueInvoice = onCall(async (req) => {
  await requireRole(req, "manager");
  const id = str(req.data?.orderId, "訂單", { max: 64 });
  const r = await issueForOrder(id);
  if (!r) throw new HttpsError("failed-precondition", (await db.doc(`posOrders/${id}`).get()).data()?.invoiceError || "沒有開立（可能已開過、金額為 0 或未啟用電子發票）");
  return r;
});

export const invoicePrint = onCall(async (req) => {
  await requireRole(req, "staff");
  const o = (await db.doc(`posOrders/${str(req.data?.orderId, "訂單", { max: 64 })}`).get()).data();
  assert(o?.invoice?.no, "這張單沒有電子發票", "not-found");
  return { url: await ecpay.invoicePrintUrl(await ecpayInvoiceCreds(), o.invoice.no, o.invoice.date, req.data?.style === "3" ? "3" : "1") };
});
