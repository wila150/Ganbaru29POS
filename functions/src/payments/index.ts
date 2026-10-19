import { randomBytes } from "crypto";
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
  if (p.status !== "waiting" || p.provider !== "ecpay") return { status: p.status };
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
      const f = neweb.mpgForm(await newebCreds(), { orderNo: tradeNo, amount: p.amount, itemDesc: p.itemName, notifyUrl: fnUrl("newebpayNotify"), returnUrl: `${fnUrl("payReturn")}?id=${id}&t=${p.token}` });
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

export const paymentCredsStatus = onCall(async (req) => {
  await requireRole(req, "owner");
  // 只回傳遮罩過的金鑰（前 4 後 4），讓老闆核對有沒有填對
  const mask = (v?: string) => (v ? (v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : `${v.slice(0, 2)}…`) : null);
  const out: Record<string, string | null> = {};
  for (const [k, n] of Object.entries(CRED_SECRET)) {
    const s = await secretJson(n, true);
    out[k] = s?.merchantId ?? null;
    out[`${k}_mask`] = s?.merchantId ? `HashKey ${mask(s.hashKey)}（${s.hashKey?.length ?? 0} 碼）・HashIV ${mask(s.hashIv)}（${s.hashIv?.length ?? 0} 碼）` : null;
  }
  return out;
});
