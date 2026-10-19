import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import { logger } from "firebase-functions";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { requireRole } from "../lib/auth";
import { getSecret, setSecret, type SecretName } from "../lib/secrets";
import { assert, db, errMsg, FieldValue, HttpsError, REGION, str, Timestamp } from "../lib/util";
import * as ecpay from "./ecpay";
import * as neweb from "./newebpay";

/**
 * 門市線上付款（掃 QR 付款）：
 *  1. POS 呼叫 createOnlinePayment → posPayments/{id}（status waiting）＋付款頁網址，畫成 QR 給客人掃。
 *  2. 客人手機開 payPage → 自動送到綠界／藍新付款頁 → 付款。
 *  3. 綠界／藍新 POST 結果到 ecpayNotify / newebpayNotify → status paid（POS 即時看到）。
 *  4. POS 帶著 posPayments id 呼叫 posCheckout；posCheckout 確認已付款、金額相符、沒被別張單用過。
 */

export type Provider = "ecpay" | "newebpay";
const PAY_TTL_MS = 30 * 60_000;
const project = () => process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
export const fnUrl = (name: string) => `https://${REGION}-${project()}.cloudfunctions.net/${name}`;

async function settings() {
  return (await db.doc("settings/shop").get()).data() ?? {};
}

async function secretJson(name: SecretName, fresh = false): Promise<Record<string, string> | null> {
  const v = await getSecret(name, fresh);
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export async function ecpayPaymentCreds(): Promise<ecpay.EcpayCreds> {
  const stage = (await settings()).payment?.stage !== false;
  const s = await secretJson("ECPAY_PAYMENT");
  if (s?.merchantId) return { merchantId: s.merchantId, hashKey: s.hashKey, hashIv: s.hashIv, stage };
  if (stage) return ecpay.ECPAY_TEST_PAYMENT;
  throw new HttpsError("failed-precondition", "尚未設定綠界金流的商店代號與金鑰");
}

export async function ecpayInvoiceCreds(): Promise<ecpay.EcpayCreds> {
  const stage = (await settings()).invoice?.stage !== false;
  const s = await secretJson("ECPAY_INVOICE");
  if (s?.merchantId) return { merchantId: s.merchantId, hashKey: s.hashKey, hashIv: s.hashIv, stage };
  if (stage) return ecpay.ECPAY_TEST_INVOICE;
  throw new HttpsError("failed-precondition", "尚未設定綠界電子發票的商店代號與金鑰");
}

async function newebCreds(): Promise<neweb.NewebCreds> {
  const stage = (await settings()).payment?.stage !== false;
  const s = await secretJson("NEWEBPAY_PAYMENT");
  if (!s?.merchantId) throw new HttpsError("failed-precondition", "尚未設定藍新金流的商店代號與金鑰（藍新沒有公用測試帳號，測試也需要你們的測試商店）");
  return { merchantId: s.merchantId, hashKey: s.hashKey, hashIv: s.hashIv, stage };
}

// ---------- POS side ----------

export const createOnlinePayment = onCall(async (req) => {
  const actor = await requireRole(req, "staff");
  const s = await settings();
  const provider = s.payment?.provider as Provider | undefined;
  assert(provider === "ecpay" || provider === "newebpay", "尚未在「設定 → 金流」選擇線上付款服務", "failed-precondition");
  const amount = Math.round(Number(req.data?.amount));
  assert(Number.isInteger(amount) && amount > 0 && amount <= 1e7, "金額不正確");
  const ref = db.collection("posPayments").doc();
  const token = randomBytes(12).toString("hex");
  await ref.set({
    provider,
    stage: s.payment?.stage !== false,
    orderId: str(req.data?.orderId, "訂單", { max: 64 }),
    amount,
    itemName: str(req.data?.itemName, "品名", { optional: true, max: 300 }) || "門市消費",
    // 這筆讓客人用哪些方式付（只能選設定頁有開的）：null = 照設定
    payExtra: Array.isArray(req.data?.extra) ? (req.data.extra as unknown[]).map(String).filter((k) => ((s.payment?.newebExtra as string[]) ?? []).includes(k)) : null,
    payInst: typeof req.data?.inst === "boolean" ? req.data.inst : null,
    status: "waiting",
    token,
    tradeNos: [],
    createdBy: actor.name,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + PAY_TTL_MS),
    usedBy: null,
  });
  return { id: ref.id, url: `${fnUrl("payPage")}?id=${ref.id}&t=${token}` };
});

export const cancelOnlinePayment = onCall(async (req) => {
  await requireRole(req, "staff");
  const ref = db.doc(`posPayments/${str(req.data?.id, "付款", { max: 40 })}`);
  await db.runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data();
    if (p?.status === "waiting") tx.update(ref, { status: "canceled" });
  });
  return { ok: true };
});

/** 補查：通知還沒到時，直接問綠界這筆有沒有付款（藍新靠通知）。 */
export const checkOnlinePayment = onCall(async (req) => {
  await requireRole(req, "staff");
  const ref = db.doc(`posPayments/${str(req.data?.id, "付款", { max: 40 })}`);
  const p = (await ref.get()).data();
  assert(p, "找不到這筆付款", "not-found");
  if (p.status !== "waiting") return { status: p.status };
  if (p.provider === "newebpay") {
    const c = await newebCreds();
    for (const no of p.tradeNos ?? []) {
      const r = await neweb.queryTrade(c, no, p.amount);
      if (r.ok && String(r.data.TradeStatus) === "1" && Number(r.data.Amt) === p.amount) {
        await markPaid(ref, { tradeNo: no, providerTradeNo: String(r.data.TradeNo ?? ""), paymentType: String(r.data.PaymentType ?? ""), card4: String(r.data.Card4No ?? ""), raw: r.data });
        return { status: "paid" };
      }
    }
    return { status: p.status };
  }
  if (p.provider !== "ecpay") return { status: p.status };
  const c = await ecpayPaymentCreds();
  for (const no of p.tradeNos ?? []) {
    const r = await ecpay.queryTrade(c, no);
    if (r.ok && r.data.TradeStatus === "1" && Number(r.data.TradeAmt) === p.amount) {
      await markPaid(ref, { tradeNo: no, providerTradeNo: r.data.TradeNo, paymentType: r.data.PaymentType, raw: r.data });
      return { status: "paid" };
    }
  }
  return { status: p.status };
});

async function markPaid(ref: FirebaseFirestore.DocumentReference, info: { tradeNo: string; providerTradeNo?: string; paymentType?: string; card4?: string; inst?: number; raw: unknown }) {
  await db.runTransaction(async (tx) => {
    const p = (await tx.get(ref)).data();
    if (!p || p.status === "paid") return;
    tx.update(ref, { status: "paid", paidAt: FieldValue.serverTimestamp(), paidTradeNo: info.tradeNo, providerTradeNo: info.providerTradeNo ?? null, paymentType: info.paymentType ?? null, card4: info.card4 || null, inst: info.inst || 0, raw: JSON.parse(JSON.stringify(info.raw)) });
  });
}

// ---------- customer's phone ----------

const page = (title: string, body: string) =>
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f4f5f7;color:#111}
.c{background:#fff;padding:28px;border-radius:14px;max-width:360px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1)}h1{font-size:20px}.big{font-size:32px;font-weight:800}</style></head><body><div class="c">${body}</div></body></html>`;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function autoSubmit(action: string, params: Record<string, string | number>, amount: number) {
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return page("前往付款", `<h1>ganbaru29 門市付款</h1><div class="big">$${amount.toLocaleString("zh-TW")}</div><p>正在前往付款頁…</p>
<form id="f" method="post" action="${esc(action)}">${inputs}<button type="submit">若沒有自動跳轉請按這裡</button></form><script>document.getElementById("f").submit()</script>`);
}

export const payPage = onRequest(async (req, res) => {
  const id = String(req.query.id ?? "");
  const ref = db.doc(`posPayments/${id.replace(/[^\w]/g, "")}`);
  const p = id ? (await ref.get()).data() : undefined;
  res.set("cache-control", "no-store");
  if (!p || p.token !== req.query.t) {
    res.status(404).send(page("找不到", "<h1>付款連結無效</h1><p>請向店員重新取得 QR code。</p>"));
    return;
  }
  if (p.status === "paid") {
    res.send(page("已付款", `<h1>✅ 已付款完成</h1><div class="big">$${p.amount.toLocaleString("zh-TW")}</div><p>請回到櫃台。</p>`));
    return;
  }
  if (p.status !== "waiting" || p.expiresAt.toMillis() < Date.now()) {
    res.send(page("已失效", "<h1>這個付款連結已失效</h1><p>請向店員重新取得 QR code。</p>"));
    return;
  }
  // 每次開頁都用新的交易編號（綠界、藍新都不允許重複），全部記在 tradeNos 以便對應通知。
  const tradeNo = `G${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 20);
  await ref.update({ tradeNos: FieldValue.arrayUnion(tradeNo) });
  try {
    if (p.provider === "ecpay") {
      const f = ecpay.aioForm(await ecpayPaymentCreds(), { tradeNo, amount: p.amount, itemName: p.itemName, returnUrl: fnUrl("ecpayNotify"), resultUrl: `${fnUrl("payReturn")}?id=${id}&t=${p.token}` });
      res.send(autoSubmit(f.action, f.params, p.amount));
    } else {
      const f = neweb.mpgForm(await newebCreds(), { orderNo: tradeNo, amount: p.amount, itemDesc: p.itemName, notifyUrl: fnUrl("newebpayNotify"), extra: (p.payExtra as string[] | null) ?? ((await settings()).payment?.newebExtra as string[] | undefined) ?? [], inst: p.payInst === false ? [] : ((await settings()).payment?.newebInst as number[] | undefined) ?? [], returnUrl: `${fnUrl("payReturn")}?id=${id}&t=${p.token}` });
      res.send(autoSubmit(f.action, f.params, p.amount));
    }
  } catch (e) {
    logger.error("payPage", e);
    res.status(500).send(page("錯誤", `<h1>暫時無法付款</h1><p>${esc(errMsg(e))}</p>`));
  }
});

/** 付款後顧客瀏覽器回到這裡（綠界 ClientBackURL / 藍新 ReturnURL）。結果以伺服器通知為準。 */
export const payReturn = onRequest(async (req, res) => {
  const id = String(req.query.id ?? "").replace(/[^\w]/g, "");
  const p = id ? (await db.doc(`posPayments/${id}`).get()).data() : undefined;
  const ok = p && p.token === req.query.t && p.status === "paid";
  res.send(page("付款結果", ok ? `<h1>✅ 付款完成</h1><div class="big">$${p.amount.toLocaleString("zh-TW")}</div><p>謝謝，請回到櫃台。</p>` : "<h1>付款處理中</h1><p>請回到櫃台，店員會確認付款結果。</p>"));
});

export const ecpayNotify = onRequest(async (req, res) => {
  try {
    const body = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
    const c = await ecpayPaymentCreds();
    if (!ecpay.verifyCheckMac(body, c)) {
      logger.warn("ecpayNotify: bad CheckMacValue", body.MerchantTradeNo);
      res.status(400).send("0|CheckMacValue Error");
      return;
    }
    const snap = await db.collection("posPayments").where("tradeNos", "array-contains", body.MerchantTradeNo).limit(1).get();
    const doc = snap.docs[0];
    if (doc && body.RtnCode === "1" && Number(body.TradeAmt) === doc.data().amount) {
      await markPaid(doc.ref, { tradeNo: body.MerchantTradeNo, providerTradeNo: body.TradeNo, paymentType: body.PaymentType, raw: body });
    } else if (doc && body.RtnCode !== "1") {
      await doc.ref.update({ lastError: `${body.RtnCode} ${body.RtnMsg}` });
    }
    res.send("1|OK");
  } catch (e) {
    logger.error("ecpayNotify", e);
    res.status(500).send("0|error");
  }
});

export const newebpayNotify = onRequest(async (req, res) => {
  try {
    const c = await newebCreds();
    const { TradeInfo, TradeSha } = req.body ?? {};
    if (!TradeInfo || neweb.tradeSha(TradeInfo, c) !== String(TradeSha).toUpperCase()) {
      res.status(400).send("bad sha");
      return;
    }
    const info = neweb.decryptTradeInfo(TradeInfo, c) as { Status?: string; Message?: string; Result?: Record<string, unknown> };
    const r = (typeof info.Result === "string" ? JSON.parse(info.Result) : info.Result) ?? {};
    const no = String(r.MerchantOrderNo ?? "");
    const snap = await db.collection("posPayments").where("tradeNos", "array-contains", no).limit(1).get();
    const doc = snap.docs[0];
    if (doc && info.Status === "SUCCESS" && Number(r.Amt) === doc.data().amount) {
      await markPaid(doc.ref, { tradeNo: no, providerTradeNo: String(r.TradeNo ?? ""), paymentType: String(r.PaymentType ?? ""), card4: String(r.Card4No ?? ""), inst: Number(r.Inst ?? 0), raw: info });
    } else if (doc) {
      await doc.ref.update({ lastError: `${info.Status} ${info.Message ?? ""}` });
    }
    res.send("OK");
  } catch (e) {
    logger.error("newebpayNotify", e);
    res.status(500).send("error");
  }
});

/** posCheckout: confirm an online payment and claim it for this order (one payment, one order). */
export async function claimOnlinePayment(tx: FirebaseFirestore.Transaction, paymentId: string, orderId: string, provider: string, amount: number) {
  const ref = db.doc(`posPayments/${paymentId}`);
  const p = (await tx.get(ref)).data();
  assert(p, "找不到線上付款紀錄", "not-found");
  assert(p.provider === provider, "付款方式不符");
  assert(p.status === "paid", "這筆線上付款還沒完成", "failed-precondition");
  assert(p.amount === amount, "線上付款金額與結帳金額不符", "failed-precondition");
  assert(!p.usedBy || p.usedBy === orderId, "這筆線上付款已經用在別張單", "failed-precondition");
  return () => tx.update(ref, { usedBy: orderId });
}

// ---------- settings ----------

const CRED_SECRET: Record<string, SecretName> = { ecpay_payment: "ECPAY_PAYMENT", ecpay_invoice: "ECPAY_INVOICE", newebpay_payment: "NEWEBPAY_PAYMENT" };

/** 存金流／發票的商店代號與金鑰（只存在 Secret Manager，畫面上不會再顯示）。 */
export const setPaymentCreds = onCall(async (req) => {
  await requireRole(req, "owner");
  const kind = String(req.data?.kind);
  const name = CRED_SECRET[kind];
  assert(name, "類型不正確");
  const merchantId = str(req.data?.merchantId, "商店代號", { max: 20 });
  const hashKey = str(req.data?.hashKey, "HashKey", { max: 64 });
  const hashIv = str(req.data?.hashIv, "HashIV", { max: 64 });
  if (kind === "newebpay_payment") assert(hashKey.length === 32 && hashIv.length === 16, "藍新 HashKey 應為 32 碼、HashIV 16 碼");
  else assert(hashKey.length === 16 && hashIv.length === 16, "綠界 HashKey、HashIV 應各為 16 碼");
  await setSecret(name, JSON.stringify({ merchantId, hashKey, hashIv }));
  await db.doc("settings/shop").set({ credsSet: { [kind]: true } }, { merge: true });
  return { ok: true };
});

// ---------- 寄付款連結（用店家 Gmail＋應用程式密碼） ----------

/** 存寄信用的 Gmail 帳號與應用程式密碼（Secret Manager） */
export const setMailCreds = onCall(async (req) => {
  await requireRole(req, "owner");
  const user = str(req.data?.user, "寄件 Email", { max: 120 }).toLowerCase();
  const host = (str(req.data?.host, "寄信伺服器", { optional: true, max: 120 }) || "smtp.gmail.com").toLowerCase();
  const port = Number(req.data?.port) || 465;
  const google = host === "smtp.gmail.com";
  const pass = google ? str(req.data?.pass, "應用程式密碼", { max: 40 }).replace(/\s+/g, "") : str(req.data?.pass, "密碼", { max: 200 });
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user), "寄件 Email 格式不正確");
  assert(!google || /^[a-z]{16}$/i.test(pass), "Google 應用程式密碼是 16 個英文字母（中間的空格可以不打）");
  assert([465, 587, 25, 2525].includes(port), "連接埠只能是 465 或 587");
  // 先試著登入，確定帳密可以用再存
  const t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  try {
    await t.verify();
  } catch (e) {
    throw new HttpsError("failed-precondition", `寄信伺服器登入失敗，請確認帳號、密碼、伺服器（${errMsg(e).slice(0, 120)}）`);
  }
  await setSecret("MAIL_SMTP", JSON.stringify({ user, pass, host, port }));
  return { ok: true };
});

async function mailer() {
  const m = await secretJson("MAIL_SMTP", true);
  assert(m?.user && m?.pass, "還沒設定寄信用的信箱（後台設定 → 金流管理 → 寄付款連結的信箱）", "failed-precondition");
  const port = Number(m.port) || 465;
  const t = nodemailer.createTransport({ host: m.host || "smtp.gmail.com", port, secure: port === 465, auth: { user: m.user, pass: m.pass } });
  const shop = ((await settings()).shopName as string) || "ganbaru29";
  return { t, from: { name: shop, address: m.user as string }, shop };
}

const $ = (n: number) => `$${Math.round(n).toLocaleString("zh-TW")}`;
const PAY_ZH: Record<string, string> = { cash: "現金", card: "信用卡", linepay: "LINE Pay", transfer: "轉帳", newebpay: "線上刷卡（藍新）", ecpay: "線上刷卡（綠界）", exchange: "換貨抵用" };

/**
 * 寄消費明細給客人。email 沒給時：會員 Email → 這張單線上刷卡寄過付款連結的 Email。
 * 回傳 sent=false 表示找不到 Email（不算錯誤）。
 */
export const sendReceipt = onCall({ timeoutSeconds: 60 }, async (req) => {
  const actor = await requireRole(req, "staff");
  const orderId = str(req.data?.orderId, "訂單", { max: 64 });
  const ref = db.doc(`posOrders/${orderId}`);
  const o = (await ref.get()).data();
  assert(o, "找不到這張單", "not-found");
  let to = req.data?.email ? str(req.data.email, "Email", { max: 120 }).trim() : "";
  if (!to) to = o.shopper?.email ?? "";
  if (!to) {
    const pay = await db.collection("posPayments").where("usedBy", "==", orderId).limit(1).get();
    const mailed = (pay.docs[0]?.data().mailedTo as string[] | undefined) ?? [];
    to = mailed[mailed.length - 1] ?? "";
  }
  if (!to) return { sent: false };
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to), "Email 格式不正確");
  const { t, from, shop } = await mailer();
  const s = await settings();
  const when = (o.createdAt?.toDate?.() ?? new Date()).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
  type L = { productTitle: string; options: string; qty: number; listPrice: number; unitPrice: number; discountPct: number; promoLabels?: string[]; total: number };
  const lines = (o.lines as L[]).map((l) => {
    const orig = l.listPrice * l.qty;
    const note = [l.discountPct > 0 ? `${(100 - l.discountPct) % 10 === 0 ? (100 - l.discountPct) / 10 : 100 - l.discountPct} 折` : "", ...(l.promoLabels ?? [])].filter(Boolean).join("、");
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(l.productTitle)}<div style="color:#6b7280;font-size:13px">${esc(l.options || "")} × ${l.qty}${note ? `　<span style="color:#059669">${esc(note)}</span>` : ""}</div></td>
<td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${orig !== l.total ? `<s style="color:#9ca3af;font-size:13px">${$(orig)}</s><br>` : ""}${$(l.total)}</td></tr>`;
  });
  const gross = (o.lines as L[]).reduce((a, l) => a + l.listPrice * l.qty, 0);
  const rows: [string, number][] = [
    ["商品原價", gross],
    ...(((o.lines as L[]).reduce((a, l) => a + l.listPrice * l.qty - l.total, 0) ? [["商品折扣", -(o.lines as L[]).reduce((a, l) => a + l.listPrice * l.qty - l.total, 0)]] : []) as [string, number][]),
    ...((o.memberDiscount ? [[`會員折扣${o.memberTier ? `（${o.memberTier}）` : ""}`, -o.memberDiscount]] : []) as [string, number][]),
    ...((o.orderDiscount ? [["整單折扣", -o.orderDiscount]] : []) as [string, number][]),
    ...((o.serviceFee ? [["服務費", o.serviceFee]] : []) as [string, number][]),
    ...((o.allowance ? [["折讓", -o.allowance]] : []) as [string, number][]),
    ...((o.rewardDiscount ? [[`購物金折抵（${o.rewardPoints} 點）`, -o.rewardDiscount]] : []) as [string, number][]),
  ];
  const totalOff = gross - o.total + (o.serviceFee ?? 0);
  const pays = (o.payments as { method: string; amount: number }[]).map((p) => `${esc(PAY_ZH[p.method] ?? p.method)} ${$(p.amount)}`).join("、");
  const html = `<div style="font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px;color:#111">
<h2 style="margin:0">${esc(shop)}</h2><p style="color:#6b7280;margin:4px 0 16px">消費明細　${esc(o.orderNo)}<br>${esc(when)}</p>
${o.shopper?.name ? `<p style="margin:0 0 12px">${esc(o.shopper.name)} 您好，感謝您的光臨！</p>` : ""}
<table style="width:100%;border-collapse:collapse;font-size:15px">${lines.join("")}</table>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:12px">${rows
    .map(([k, v]) => `<tr><td style="color:#6b7280;padding:3px 0">${esc(k)}</td><td style="text-align:right;${v < 0 ? "color:#b91c1c" : ""}">${v < 0 ? `−${$(-v)}` : $(v)}</td></tr>`)
    .join("")}${totalOff > 0 ? `<tr><td style="padding:6px 0 3px;border-top:1px dashed #ddd;font-weight:700;color:#b91c1c">總折扣</td><td style="text-align:right;border-top:1px dashed #ddd;font-weight:700;color:#b91c1c">−${$(totalOff)}</td></tr>` : ""}
<tr><td style="padding-top:10px;border-top:2px solid #111;font-size:17px;font-weight:700">實付金額</td><td style="padding-top:10px;border-top:2px solid #111;text-align:right;font-size:22px;font-weight:800;color:#059669">${$(o.total)}</td></tr></table>
<p style="font-size:14px;margin:14px 0 4px">付款方式：${pays}</p>
${o.rewardEarned > 0 ? `<p style="font-size:14px;margin:4px 0;color:#059669">本次回饋購物金 ${o.rewardEarned} 點</p>` : ""}
${o.invoice?.no ? `<p style="font-size:14px;margin:4px 0">電子發票：${esc(o.invoice.no)}</p>` : ""}
${s.receiptFooter ? `<p style="color:#6b7280;font-size:13px;margin-top:16px;white-space:pre-line">${esc(s.receiptFooter)}</p>` : ""}
</div>`;
  const text = `${shop} 消費明細 ${o.orderNo}\n${when}\n\n${(o.lines as L[]).map((l) => `${l.productTitle} ${l.options} ×${l.qty}  ${$(l.total)}`).join("\n")}\n\n${rows.map(([k, v]) => `${k} ${v < 0 ? "-" : ""}${$(Math.abs(v))}`).join("\n")}\n實付金額 ${$(o.total)}\n付款方式：${(o.payments as { method: string; amount: number }[]).map((p) => `${PAY_ZH[p.method] ?? p.method} ${$(p.amount)}`).join("、")}`;
  await t.sendMail({ from, to, replyTo: from.address, subject: `【${shop}】消費明細 ${o.orderNo}　${$(o.total)}`, html, text });
  await ref.update({ receiptMailedTo: FieldValue.arrayUnion(to), receiptMailedAt: FieldValue.serverTimestamp() });
  logger.info("receipt mailed", { orderId, by: actor.name });
  return { sent: true, email: to };
});

/** 把付款連結寄到客人 Email（寄件人：店家 Gmail） */
export const sendPayLink = onCall({ timeoutSeconds: 60 }, async (req) => {
  const actor = await requireRole(req, "staff");
  const id = str(req.data?.id, "付款", { max: 40 });
  const to = str(req.data?.email, "Email", { max: 120 }).trim();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to), "Email 格式不正確");
  const ref = db.doc(`posPayments/${id}`);
  const p = (await ref.get()).data();
  assert(p, "找不到這筆付款", "not-found");
  assert(p.status === "waiting", "這筆付款已完成或已取消");
  const m = await secretJson("MAIL_SMTP", true);
  assert(m?.user && m?.pass, "還沒設定寄信用的信箱（後台設定 → 金流管理 → 寄付款連結的信箱）", "failed-precondition");
  const shop = ((await settings()).shopName as string) || "ganbaru29";
  const url = `${fnUrl("payPage")}?id=${id}&t=${p.token}`;
  const amount = `$${Number(p.amount).toLocaleString("zh-TW")}`;
  const port = Number(m.port) || 465;
  const t = nodemailer.createTransport({ host: m.host || "smtp.gmail.com", port, secure: port === 465, auth: { user: m.user, pass: m.pass } });
  await t.sendMail({
    from: { name: shop, address: m.user },
    to,
    // 主旨用【店名】開頭，客人一眼認得是哪家店
    subject: `【${shop}】門市付款連結 ${amount}`,
    replyTo: m.user,
    text: `您好，這是您在 ${shop} 本次消費 ${amount} 的付款連結（30 分鐘內有效）：\n${url}\n\n付款完成後門市會自動完成結帳，謝謝光臨！`,
    html: `<div style="font-family:-apple-system,'PingFang TC','Noto Sans TC',sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
<h2 style="margin:0 0 4px">${esc(shop)}</h2><p style="color:#6b7280;margin:0 0 16px">門市消費付款</p>
<div style="font-size:32px;font-weight:800;margin:8px 0 16px">${amount}</div>
<p style="margin:0 0 6px;color:#374151">${esc(p.itemName ?? "")}</p>
<a href="${esc(url)}" style="display:block;text-align:center;background:#059669;color:#fff;text-decoration:none;font-size:18px;font-weight:700;padding:14px;border-radius:10px;margin:18px 0">前往付款</a>
<p style="color:#6b7280;font-size:13px">連結 30 分鐘內有效。付款完成後門市會自動完成結帳，謝謝光臨！</p></div>`,
  });
  await ref.update({ mailedTo: FieldValue.arrayUnion(to), mailedAt: FieldValue.serverTimestamp(), mailedBy: actor.name });
  return { ok: true };
});

export const paymentCredsStatus = onCall(async (req) => {
  await requireRole(req, "owner");
  // 只回傳遮罩過的金鑰（前 4 後 4），讓老闆核對有沒有填對
  const mask = (v?: string) => (v ? (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : `${v.slice(0, 2)}…`) : null);
  const out: Record<string, string | null> = {};
  // 一把讀不到（例如權限）只影響那一欄，不要讓整個設定頁都變成「未設定」
  const safe = (n: SecretName) => secretJson(n, true).catch((e) => (logger.error("read secret", n, e), null));
  for (const [k, n] of Object.entries(CRED_SECRET)) {
    const s = await safe(n);
    out[k] = s?.merchantId ?? null;
    out[`${k}_mask`] = s?.merchantId ? `HashKey ${mask(s.hashKey)}（${s.hashKey?.length ?? 0} 碼）・HashIV ${mask(s.hashIv)}（${s.hashIv?.length ?? 0} 碼）` : null;
  }
  out.mail = (await safe("MAIL_SMTP"))?.user ?? null;
  return out;
});
