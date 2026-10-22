import bwipjs from "bwip-js";
import { createHmac, timingSafeEqual } from "crypto";
import QRCode from "qrcode";
import sharp from "sharp";
import { logger } from "firebase-functions";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { ensureMemberCodes } from "./cards";
import { requireRole } from "./lib/auth";
import * as meep from "./lib/meepshop";
import { getSecret, setSecret } from "./lib/secrets";
import { assert, db, errMsg, FieldValue, str } from "./lib/util";
import { describePromo, promoIsLive, taipeiClock, type Promotion } from "./shared/promo";
import { mobileKeyCandidates } from "./sync";

/**
 * LINE 官方帳號（Messaging API）：圖文選單按鈕 → webhook → 回覆。
 * 回覆（reply）不算每月訊息則數，所以會員卡、消費紀錄、新品、活動、門市資訊都不花錢；
 * 主動推播（push／multicast）才會用掉官方帳號的每月額度。
 * 金鑰：Secret Manager「LINE_BOT」= { channelId, channelSecret }；token 用 channel ID＋secret 換（30 天），存在 private/lineBotToken。
 */

const API = "https://api.line.me/v2/bot";
const DEFAULT_SITE = "https://www.ganbaru29.com";
// 會員條碼圖片（放在 LINE 聊天室裡，客人不會被帶到 POS 網站）
const CARD_IMG = "https://asia-east1-ganbaru29.cloudfunctions.net/lineCardImage";

type Msg = Record<string, unknown>;

async function botCreds(): Promise<{ channelId: string; channelSecret: string }> {
  const raw = await getSecret("LINE_BOT");
  assert(raw, "尚未設定 LINE 官方帳號", "failed-precondition");
  return JSON.parse(raw!);
}

let memToken: { token: string; exp: number } | null = null;
/** Messaging API 的 channel access token（短效 30 天，到期前自動換） */
export async function botToken(): Promise<string> {
  if (memToken && memToken.exp > Date.now() + 86400_000) return memToken.token;
  const ref = db.doc("private/lineBotToken");
  const saved = (await ref.get()).data();
  if (saved?.token && saved.exp > Date.now() + 86400_000) return (memToken = { token: saved.token, exp: saved.exp }).token;
  const c = await botCreds();
  const res = await fetch("https://api.line.me/v2/oauth/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.channelId, client_secret: c.channelSecret }),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  assert(j.access_token, `LINE token 取得失敗：${j.error_description ?? res.status}`);
  memToken = { token: j.access_token!, exp: Date.now() + (j.expires_in ?? 2592000) * 1000 };
  await ref.set(memToken);
  return memToken.token;
}

export async function lineApi(path: string, body?: unknown, method = "POST") {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${await botToken()}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE ${path} ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const reply = (replyToken: string, messages: Msg[]) => lineApi("/message/reply", { replyToken, messages: messages.slice(0, 5) });
const text = (t: string, quick?: [string, string][]): Msg => ({
  type: "text",
  text: t.slice(0, 4900),
  ...(quick ? { quickReply: { items: quick.map(([label, data]) => ({ type: "action", action: { type: "postback", label, data, displayText: label } })) } } : {}),
});
const MENU: [string, string][] = [
  ["會員卡", "a=card"],
  ["為你推薦", "a=foryou"],
  ["消費紀錄", "a=history"],
  ["新品", "a=new"],
  ["本月活動", "a=promo"],
  ["門市資訊", "a=store"],
];
const $ = (n: number) => `NT$ ${Math.round(n).toLocaleString("en-US")}`;

async function shopSettings() {
  return (await db.doc("settings/shop").get()).data() ?? {};
}

async function shopperByLine(uid: string) {
  const q = await db.collection("shoppers").where("lineUserId", "==", uid).limit(1).get();
  return q.docs[0] ?? null;
}

// ---------- 各按鈕的回覆 ----------

async function replyCard(uid: string): Promise<Msg[]> {
  const s = await shopperByLine(uid);
  if (!s) {
    await db.doc(`lineSessions/${uid}`).set({ step: "phone", tries: 0, at: FieldValue.serverTimestamp() });
    return [text("還沒綁定會員喔！\n請輸入你在 ganbaru29 註冊會員的「手機號碼」（例如 0912345678）。\n\n香港／澳門手機請加區碼，例如 85291234567。")];
  }
  await ensureMemberCodes([s.id]);
  const x = (await s.ref.get()).data()!;
  const live = await meep.getShopper(s.id).catch(() => null);
  const points = live?.usableRewardPoints ?? x.points ?? 0;
  const group = x.posGroup ?? x.memberGroup ?? "會員";
  return [
    {
      type: "flex",
      altText: `${x.name || "會員"} 的會員卡`,
      contents: {
        type: "bubble",
        size: "giga",
        header: { type: "box", layout: "vertical", backgroundColor: "#4a3b32", contents: [{ type: "text", text: "ganbaru29 會員卡", color: "#ffffff", weight: "bold", size: "lg" }, { type: "text", text: group, color: "#d1d5db", size: "sm" }] },
        // 條碼直接放大顯示在卡片上，結帳時打開就能掃，不用再點放大
        hero: { type: "image", url: `${CARD_IMG}?t=${x.cardToken}`, size: "full", aspectRatio: "1:1", aspectMode: "fit", backgroundColor: "#ffffff" },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "text", text: x.name || "會員", weight: "bold", size: "xl" },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "可用購物金", color: "#6b7280", size: "sm" }, { type: "text", text: `${points} 點`, align: "end", weight: "bold", color: "#059669" }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "會員編號", color: "#6b7280", size: "sm" }, { type: "text", text: x.memberCode ?? "—", align: "end", size: "sm" }] },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "button", style: "secondary", action: { type: "postback", label: "消費紀錄", data: "a=history", displayText: "消費紀錄" } },
            { type: "box", layout: "horizontal", spacing: "sm", contents: [
              { type: "button", style: "secondary", action: { type: "postback", label: "✨ 為你推薦", data: "a=foryou", displayText: "為你推薦" } },
              { type: "button", style: "secondary", action: { type: "postback", label: "❤️ 我的喜好", data: "a=prefs", displayText: "我的喜好" } },
            ] },
          ],
        },
      },
    },
  ];
}

/** 放大條碼：用 LINE 內建看圖畫面全螢幕顯示 */
async function replyBarcode(uid: string): Promise<Msg[]> {
  const s = await shopperByLine(uid);
  if (!s) return replyCard(uid);
  await ensureMemberCodes([s.id]);
  const url = `${CARD_IMG}?t=${(await s.ref.get()).data()!.cardToken}`;
  return [{ type: "image", originalContentUrl: url, previewImageUrl: url }, text("結帳時請把這張條碼給店員掃描 🙏", MENU)];
}

async function replyHistory(uid: string): Promise<Msg[]> {
  const s = await shopperByLine(uid);
  if (!s) return replyCard(uid);
  const [live, store, online] = await Promise.all([
    meep.getShopper(s.id).catch(() => null),
    db.collection("posOrders").where("shopper.id", "==", s.id).orderBy("createdAt", "desc").limit(5).get(),
    meep.ordersPage({ first: 5, query: { shopperId: s.id } }).catch(() => null),
  ]);
  type Row = { at: number; label: string; amount: number; items: string };
  const rows: Row[] = [
    ...store.docs
      .map((d) => d.data())
      .filter((o) => o.status === "completed" || o.status === "partial")
      .map((o) => ({ at: o.createdAt?.toMillis?.() ?? 0, label: "門市", amount: o.total, items: (o.lines as { productTitle: string; qty: number }[]).map((l) => `${l.productTitle}×${l.qty}`).join("、") })),
    ...(online?.edges ?? []).flatMap((e) => (e.node ? [e.node] : [])).map((o) => ({ at: new Date(o.createdAt).getTime(), label: "網店", amount: o.totalPrice, items: (o.lineItems ?? []).map((l) => `${l.title}×${l.quantity}`).join("、") })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);
  const points = live?.usableRewardPoints ?? s.data().points ?? 0;
  const date = (ms: number) => new Date(ms).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" });
  return [
    {
      type: "flex",
      altText: `消費紀錄（購物金 ${points} 點）`,
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "text", text: "消費紀錄", weight: "bold", size: "lg" },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "可用購物金", color: "#6b7280" }, { type: "text", text: `${points} 點`, align: "end", weight: "bold", color: "#059669" }] },
            { type: "separator" },
            ...(rows.length
              ? rows.map((r) => ({
                  type: "box",
                  layout: "vertical",
                  contents: [
                    { type: "box", layout: "horizontal", contents: [{ type: "text", text: `${date(r.at)}　${r.label}`, size: "sm", color: "#6b7280" }, { type: "text", text: $(r.amount), align: "end", size: "sm", weight: "bold" }] },
                    { type: "text", text: r.items || "—", size: "xs", color: "#374151", wrap: true, maxLines: 2 },
                  ],
                }))
              : [{ type: "text", text: "還沒有消費紀錄", color: "#6b7280", size: "sm" }]),
          ],
        },
      },
    },
  ];
}

type P = FirebaseFirestore.DocumentData & { productId: string; cats: string[]; at: number };

/** 上架中的商品（一個商品一筆，帶分類與上架時間） */
async function listedProducts(): Promise<P[]> {
  const vs = await db.collection("variants").where("active", "==", true).where("productStatus", "==", "LISTED").select("productId", "productTitle", "price", "listPrice", "imageUrl", "shopCreatedAt", "tags", "posCategory").get();
  const byProduct = new Map<string, P>();
  for (const d of vs.docs) {
    const v = d.data();
    const cur = byProduct.get(v.productId);
    if (!cur || (!cur.imageUrl && v.imageUrl)) byProduct.set(v.productId, { ...v, productId: v.productId, cats: [...new Set([v.posCategory, ...(v.tags ?? [])].filter(Boolean) as string[])], at: v.shopCreatedAt?.toMillis?.() ?? 0 });
  }
  return [...byProduct.values()].filter((v) => v.imageUrl?.startsWith("https://"));
}

async function carousel(list: P[], alt: string): Promise<Msg> {
  const st = await shopSettings();
  const site = (st.siteBaseUrl || DEFAULT_SITE).replace(/\/$/, "");
  return {
    type: "flex",
    altText: alt,
    contents: {
      type: "carousel",
      contents: list.slice(0, 10).map((v) => ({
        type: "bubble",
        size: "kilo",
        hero: { type: "image", url: v.imageUrl, size: "full", aspectRatio: "3:4", aspectMode: "cover", action: { type: "uri", uri: `${site}/products/${v.productId}` } },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: [
            { type: "text", text: v.productTitle, weight: "bold", size: "sm", wrap: true, maxLines: 2 },
            ...((v.listPrice ?? 0) > v.price ? [{ type: "text", text: `$${Number(v.listPrice).toLocaleString("en-US")}`, size: "xs", color: "#9ca3af", decoration: "line-through" }] : []),
            { type: "text", text: $(v.price), weight: "bold", color: (v.listPrice ?? 0) > v.price ? "#b91c1c" : "#111827" },
          ],
        },
        footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#4a3b32", height: "sm", action: { type: "uri", label: "看商品", uri: `${site}/products/${v.productId}` } }] },
      })),
    },
  };
}

async function replyNew(sale = false): Promise<Msg[]> {
  const list = (await listedProducts()).filter((v) => !sale || (v.listPrice ?? 0) > v.price).sort((a, b) => b.at - a.at);
  if (!list.length) return [text(sale ? "目前沒有特價商品，請到官網看看！" : "新品整理中，請到官網看看！", MENU)];
  return [await carousel(list, sale ? "ganbaru29 限時特惠" : "ganbaru29 新品")];
}

/** 會員標籤 → 商品分類關鍵字（例：常買褲子 → 長褲、短褲） */
const TAG_HINTS: [RegExp, string[]][] = [
  [/褲/, ["長褲", "短褲", "褲"]],
  [/外套|夾克|大衣/, ["外套"]],
  [/上衣|T|短袖/, ["短袖", "上衣"]],
  [/長袖|襯衫|衛衣/, ["長袖"]],
  [/套裝/, ["套裝"]],
  [/包/, ["包款"]],
  [/特價|優惠|折扣/, ["特價專區"]],
];

// ---------- 找商品（關鍵字，不用 AI、免費） ----------

const COLORS = ["黑", "白", "灰", "咖", "棕", "卡其", "米", "杏", "藍", "深藍", "淺藍", "綠", "軍綠", "紅", "酒紅", "粉", "紫", "黃", "橘", "奶茶", "牛仔", "深灰", "淺灰"];
const CAT_WORDS: [RegExp, string[]][] = [
  [/寬褲|長褲|褲子|牛仔褲|工作褲/, ["長褲"]],
  [/短褲/, ["短褲"]],
  [/短袖|短T|T恤|t恤|tee/i, ["短袖"]],
  [/長袖|衛衣|大學T|襯衫/, ["長袖"]],
  [/外套|夾克|大衣|風衣|背心/, ["外套"]],
  [/套裝/, ["套裝"]],
  [/包/, ["包款"]],
];

/** 把客人的話拆成條件：顏色、分類、其他關鍵字 */
function parseQuery(q: string) {
  const t = q.replace(/^(我)?(想|要)?(找|買|看)(一件|一條|件|條)?/, "").replace(/[，。,.!！?？]/g, " ").trim();
  const colors = COLORS.filter((c) => t.includes(c));
  const cats = CAT_WORDS.filter(([re]) => re.test(t)).flatMap(([, c]) => c);
  let rest = t;
  for (const c of colors) rest = rest.split(c).join(" ");
  for (const [re] of CAT_WORDS) rest = rest.replace(re, " ");
  const words = rest.replace(/色|的|有沒有|嗎|一件|一條|款/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  return { text: t, colors, cats, words };
}

async function replySearch(q: string): Promise<Msg[]> {
  const { text: t, colors, cats, words } = parseQuery(q);
  if (!t) return [text("想找什麼呢？例如：「找 咖啡色短袖」「找 寬褲」「找 外套」", MENU)];
  const vs = await db.collection("variants").where("active", "==", true).where("productStatus", "==", "LISTED").select("productId", "productTitle", "options", "price", "listPrice", "imageUrl", "shopCreatedAt", "tags", "posCategory").get();
  const byP = new Map<string, P & { opts: string[] }>();
  for (const d of vs.docs) {
    const v = d.data();
    const cur = byP.get(v.productId);
    if (cur) {
      cur.opts.push(v.options ?? "");
      if (!cur.imageUrl && v.imageUrl) cur.imageUrl = v.imageUrl;
    } else byP.set(v.productId, { ...v, productId: v.productId, cats: [...new Set([v.posCategory, ...(v.tags ?? [])].filter(Boolean) as string[])], at: v.shopCreatedAt?.toMillis?.() ?? 0, opts: [v.options ?? ""] });
  }
  const scored = [...byP.values()]
    .filter((p) => p.imageUrl?.startsWith("https://"))
    .map((p) => {
      const hay = `${p.productTitle} ${p.opts.join(" ")}`;
      let score = 0;
      if (cats.length) score += cats.some((c) => p.cats.includes(c) || hay.includes(c.replace("長", ""))) ? 5 : -10;
      for (const c of colors) score += hay.includes(c) ? 4 : -3;
      for (const w of words) score += hay.includes(w) ? 3 : 0;
      if (!cats.length && !colors.length && !words.some((w) => hay.includes(w)) && !hay.includes(t)) score -= 10;
      if (hay.includes(t)) score += 6;
      return { p, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.p.at - a.p.at);
  if (!scored.length) return [text(`找不到「${t}」相關的商品 🙏\n可以換個說法試試，例如「找 黑色長褲」，或點「新品」看看最近上架的。`, MENU)];
  return [text(`幫你找到 ${Math.min(scored.length, 10)} 款「${t}」👇`), await carousel(scored.map((r) => r.p), `找商品：${t}`)];
}

// ---------- AI 找商品（NVIDIA 免費 API：打字描述或傳截圖） ----------

const AI_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const AI_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const AI_DAILY_LIMIT = 20;

/** 每位客人每天 AI 次數上限（避免被亂刷） */
async function aiQuota(uid: string): Promise<boolean> {
  const ref = db.doc(`lineAiUsage/${uid}_${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" })}`);
  return db.runTransaction(async (tx) => {
    const n = ((await tx.get(ref)).data()?.n ?? 0) as number;
    if (n >= AI_DAILY_LIMIT) return false;
    tx.set(ref, { n: n + 1, at: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

/** 給 AI 看的商品清單（編號｜品名｜分類｜顏色尺寸｜價格），只有公開資訊 */
async function aiCatalog() {
  const vs = await db.collection("variants").where("active", "==", true).where("productStatus", "==", "LISTED").select("productId", "productTitle", "options", "price", "listPrice", "imageUrl", "shopCreatedAt", "tags", "posCategory").get();
  const byP = new Map<string, P & { opts: Set<string> }>();
  for (const d of vs.docs) {
    const v = d.data();
    const cur = byP.get(v.productId);
    if (cur) {
      if (v.options) cur.opts.add(v.options);
      if (!cur.imageUrl && v.imageUrl) cur.imageUrl = v.imageUrl;
    } else byP.set(v.productId, { ...v, productId: v.productId, cats: [...new Set([v.posCategory, ...(v.tags ?? [])].filter(Boolean) as string[])], at: v.shopCreatedAt?.toMillis?.() ?? 0, opts: new Set(v.options ? [v.options] : []) });
  }
  const list = [...byP.values()].filter((p) => p.imageUrl?.startsWith("https://")).sort((a, b) => b.at - a.at);
  const lines = list.map((p, i) => `${i}|${p.productTitle}|${p.cats.filter((c) => !/^\d|STUDIO|熱/.test(c)).join("/")}|${[...p.opts].slice(0, 6).join(",")}|${p.price}${(p.listPrice ?? 0) > p.price ? `(原${p.listPrice})` : ""}`);
  return { list, text: lines.join("\n") };
}

async function aiPick(prompt: string, imageB64?: string): Promise<{ ids: number[]; note: string } | null> {
  const key = await getSecret("AI_NVIDIA");
  if (!key) return null;
  const content: unknown = imageB64
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageB64}` } }]
    : prompt;
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: AI_MODEL, temperature: 0, max_tokens: 300, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: "detailed thinking off" }, { role: "user", content }] }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) {
    logger.warn("ai search", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = j.choices?.[0]?.message?.content ?? "";
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]) as { ids?: unknown[]; note?: string };
    return { ids: (r.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0), note: String(r.note ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}

const AI_RULES = `你是 ganbaru29（29 STUDIO）服飾店的店員，只能從下面的商品清單挑商品，不可以編造清單外的商品。
清單格式：編號|品名|分類|顏色/尺寸|價格
規則：客人指定的「品類」一定要相符（說短袖就只能挑短袖／T恤／短襯，說長褲就只能挑褲子），顏色、版型盡量相符；寧可少挑，不要挑不相符的。
挑出最符合的商品（最多 6 個，越像越前面）；完全沒有相符的就回空陣列。
只輸出 JSON：{"ids":[編號...],"note":"一句繁體中文說明（例：找到 3 款咖啡色寬版短袖）"}`;

async function replyAiText(uid: string, q: string): Promise<Msg[]> {
  if (!(await aiQuota(uid))) return replySearch(q);
  const cat = await aiCatalog();
  const r = await aiPick(`${AI_RULES}\n\n商品清單：\n${cat.text}\n\n客人說：「${q.slice(0, 200)}」`).catch(() => null);
  if (!r) return replySearch(q); // AI 沒回應 → 用關鍵字找
  const pick = r.ids.map((i) => cat.list[i]).filter(Boolean);
  if (!pick.length) return [text(`${r.note || "店裡目前沒有很符合的商品"} 🙏\n可以換個說法，或點「新品」看看最近上架的。`, MENU)];
  return [text(`${r.note || `幫你找到 ${pick.length} 款`} 👇`), await carousel(pick, "AI 幫你找的商品")];
}

async function replyAiImage(uid: string, messageId: string): Promise<Msg[] | null> {
  if (!(await aiQuota(uid))) return [text(`今天的「截圖找商品」已經用了 ${AI_DAILY_LIMIT} 次，明天再試試，或直接打字「找 黑色長褲」🙏`, MENU)];
  const img = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${await botToken()}` } });
  if (!img.ok) return [text("圖片讀取失敗，請再傳一次 🙏")];
  const buf = Buffer.from(await img.arrayBuffer());
  const small = await sharp(buf).rotate().resize({ width: 768, height: 768, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  const cat = await aiCatalog();
  const r = await aiPick(`${AI_RULES}\n客人傳了一張衣服的圖片（可能是截圖、穿搭照或商品照）。先看圖片裡衣服的品類、顏色、版型、印花或文字，再從清單挑最像的；圖上如果有商品名稱，優先找同名商品。如果圖片裡沒有衣服或包（例如轉帳截圖、訂單畫面、聊天截圖、風景），只輸出 {"ids":[],"note":"NOT_CLOTHING"}。\n\n商品清單：\n${cat.text}`, small.toString("base64")).catch(() => null);
  if (!r) return [text("AI 暫時忙線中，請稍後再傳一次，或直接打字「找 黑色長褲」🙏", MENU)];
  if (r.note === "NOT_CLOTHING") return null; // 不是衣服的圖（轉帳、訂單截圖…）：不回，留給店家手動回覆
  const pick = r.ids.map((i) => cat.list[i]).filter(Boolean);
  if (!pick.length) return [text(`${r.note || "店裡好像沒有這件"} 🙏\n看看我們最近的新品？`, MENU)];
  return [text(`${r.note || `這幾款最像`} 👇`), await carousel(pick, "AI 截圖找商品")];
}

/** 客人自己勾的喜好選項（可在設定頁改 lineBot.prefOptions） */
const DEFAULT_PREFS = ["長褲", "短褲", "長袖", "短袖", "外套", "套裝", "包款", "特價優惠", "新品通知"];
/** 喜好 → 商品分類 */
const PREF_CATS: Record<string, string[]> = { 特價優惠: ["特價專區"], 新品通知: [] };

async function replyPrefs(uid: string, toggle?: string): Promise<Msg[]> {
  const s = await shopperByLine(uid);
  if (!s) return replyCard(uid);
  const st = await shopSettings();
  const options: string[] = (st.lineBot?.prefOptions as string[] | undefined)?.length ? st.lineBot.prefOptions : DEFAULT_PREFS;
  let likes: string[] = (s.data().likes ?? []) as string[];
  if (toggle && options.includes(toggle)) {
    likes = likes.includes(toggle) ? likes.filter((x) => x !== toggle) : [...likes, toggle];
    await s.ref.update({ likes, likesAt: FieldValue.serverTimestamp() });
  }
  const btn = (o: string) => {
    const on = likes.includes(o);
    return { type: "button", style: on ? "primary" : "secondary", color: on ? "#4a3b32" : "#eae3da", height: "sm", action: { type: "postback", label: `${on ? "✓ " : ""}${o}`, data: `a=pref&v=${encodeURIComponent(o)}` } };
  };
  const rows = [];
  for (let i = 0; i < options.length; i += 2) rows.push({ type: "box", layout: "horizontal", spacing: "sm", contents: options.slice(i, i + 2).map(btn).concat(options.length - i === 1 ? [{ type: "box", layout: "vertical", contents: [], flex: 1 } as never] : []) });
  return [
    {
      type: "flex",
      altText: "選擇你的喜好",
      contents: {
        type: "bubble",
        header: { type: "box", layout: "vertical", backgroundColor: "#4a3b32", contents: [{ type: "text", text: "MY STYLE", color: "#c9ae90", size: "sm", weight: "bold" }, { type: "text", text: "你喜歡哪些？（可複選）", color: "#ffffff", weight: "bold" }] },
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [...rows, { type: "text", text: likes.length ? `已選：${likes.join("、")}` : "點一下勾選，再點一下取消", size: "xs", color: "#6b7280", wrap: true, margin: "md" }] },
        footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#059669", action: { type: "postback", label: "完成，看推薦", data: "a=foryou", displayText: "為你推薦" } }] },
      },
    },
  ];
}

/** 為你推薦：看他買過的分類＋會員標籤，挑還沒買過的新品；沒資料就給最新 */
async function replyForYou(uid: string): Promise<Msg[]> {
  const s = await shopperByLine(uid);
  if (!s) return replyCard(uid);
  const x = s.data();
  const [store, online, all] = await Promise.all([
    db.collection("posOrders").where("shopper.id", "==", s.id).orderBy("createdAt", "desc").limit(20).get(),
    meep.ordersPage({ first: 20, query: { shopperId: s.id } }).catch(() => null),
    listedProducts(),
  ]);
  const boughtVariantIds = new Set<string>([
    ...store.docs.flatMap((d) => ((d.data().lines ?? []) as { variantId: string }[]).map((l) => l.variantId)),
    ...(online?.edges ?? []).flatMap((e) => (e.node?.lineItems ?? []).map((l) => l.variant?.id).filter(Boolean) as string[]),
  ]);
  const boughtSnaps = boughtVariantIds.size ? await db.getAll(...[...boughtVariantIds].slice(0, 100).map((id) => db.doc(`variants/${id}`))) : [];
  const weight = new Map<string, number>();
  const boughtProducts = new Set<string>();
  for (const v of boughtSnaps) {
    const d = v.data();
    if (!d) continue;
    boughtProducts.add(d.productId);
    for (const c of [d.posCategory, ...(d.tags ?? [])].filter(Boolean) as string[]) if (c !== "29 STUDIO") weight.set(c, (weight.get(c) ?? 0) + 2);
  }
  for (const t of (x.tags ?? []) as string[]) for (const [re, cats] of TAG_HINTS) if (re.test(t)) cats.forEach((c) => weight.set(c, (weight.get(c) ?? 0) + 3));
  // 客人自己勾的喜好最準
  for (const l of (x.likes ?? []) as string[]) for (const c of PREF_CATS[l] ?? [l]) weight.set(c, (weight.get(c) ?? 0) + 4);
  const newest = Math.max(...all.map((p) => p.at), 0);
  const scored = all
    .filter((p) => !boughtProducts.has(p.productId))
    .map((p) => ({ p, score: p.cats.reduce((a, c) => a + (weight.get(c) ?? 0), 0) + Math.max(0, 2 - (newest - p.at) / (30 * 86400_000)) }))
    .sort((a, b) => b.score - a.score || b.p.at - a.p.at);
  const personal = weight.size > 0;
  const pick = scored.slice(0, 10).map((r) => r.p);
  if (!pick.length) return replyNew();
  const top = [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  return [text(personal ? `${x.name || ""} 您好！依你常買的「${top.join("、")}」挑了這些 👇` : "先推薦你最新上架的商品，買過幾次之後會越推越準 👇"), await carousel(pick, "為你推薦")];
}

async function replyPromo(): Promise<Msg[]> {
  const st = await shopSettings();
  const promos = (await db.collection("promotions").where("active", "==", true).get()).docs.map((d) => ({ id: d.id, ...d.data() }) as Promotion);
  const live = promos.filter((p) => !p.couponOnly && promoIsLive(p, { ...taipeiClock(), isMember: true, tier: null }));
  const lines = live.map((p) => `・${p.name}${describePromo(p) ? `：${describePromo(p)}` : ""}${p.endDate ? `（到 ${p.endDate.slice(5).replace("-", "/")}）` : ""}`);
  const custom = (st.lineBot?.monthlyText as string | undefined)?.trim();
  const out: Msg[] = [];
  if (st.lineBot?.monthlyImageUrl) out.push({ type: "image", originalContentUrl: st.lineBot.monthlyImageUrl, previewImageUrl: st.lineBot.monthlyImageUrl });
  out.push(text(`🎉 本月活動\n\n${custom || ""}${custom && lines.length ? "\n\n" : ""}${lines.length ? `門市優惠：\n${lines.join("\n")}` : custom ? "" : "目前沒有進行中的活動，敬請期待！"}`, MENU));
  return out;
}

async function replyStore(): Promise<Msg[]> {
  const st = await shopSettings();
  const info = st.lineBot ?? {};
  const name = st.shopName === "ganbaru29" || !st.shopName ? "29 STUDIO 台中門市" : st.shopName;
  const map = info.mapUrl || (info.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(info.address)}` : info.lat && info.lng ? `https://www.google.com/maps/search/?api=1&query=${info.lat},${info.lng}` : "");
  const row = (k: string, v?: string) => (v ? [{ type: "box", layout: "baseline", spacing: "md", contents: [{ type: "text", text: k, size: "sm", color: "#8a7a6d", flex: 2 }, { type: "text", text: v, size: "sm", color: "#3b2f28", flex: 7, wrap: true }] }] : []);
  return [
    {
      type: "flex",
      altText: `${name}：${info.address ?? "門市資訊"}`,
      contents: {
        type: "bubble",
        header: { type: "box", layout: "vertical", backgroundColor: "#4a3b32", contents: [{ type: "text", text: "STORE", color: "#c9ae90", size: "sm", weight: "bold" }, { type: "text", text: name, color: "#ffffff", weight: "bold", size: "lg" }] },
        body: { type: "box", layout: "vertical", spacing: "md", contents: [...row("地址", info.address), ...row("營業", info.hours), ...row("電話", info.phone), ...(!info.address && !info.hours && !info.phone ? [{ type: "text", text: "點下方按鈕用 Google 地圖導航到門市 👇", size: "sm", color: "#6b7280", wrap: true }] : [])] },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            ...(map ? [{ type: "button", style: "primary", color: "#4a3b32", action: { type: "uri", label: "📍 開啟 Google 地圖", uri: map } }] : []),
            ...(info.phone ? [{ type: "button", style: "secondary", action: { type: "uri", label: "📞 打電話", uri: `tel:${String(info.phone).replace(/[^\d+]/g, "")}` } }] : []),
          ],
        },
      },
      quickReply: { items: MENU.map(([label, data]) => ({ type: "action", action: { type: "postback", label, data, displayText: label } })) },
    },
  ];
}

// ---------- 綁定會員（在聊天室輸入手機 → Email 確認） ----------

async function handleText(uid: string, msg: string): Promise<Msg[] | null> {
  const t = msg.trim();
  const sRef = db.doc(`lineSessions/${uid}`);
  const sess = (await sRef.get()).data();
  if (sess?.step === "phone") {
    const keys = mobileKeyCandidates(t);
    if (!keys.length || keys[0].length < 8) return [text("手機號碼格式不對，請再輸入一次（例如 0912345678）。輸入「取消」可以離開。")];
    const found = await db.collection("shoppers").where("mobileKey", "in", keys.slice(0, 10)).limit(2).get();
    if (found.empty) {
      await sRef.delete();
      return [text("查不到這支手機的會員 🙏\n可以到門市請店員協助加入會員，或到官網註冊後再來綁定。", MENU)];
    }
    await sRef.set({ step: "email", shopperId: found.docs[0].id, tries: 0, at: FieldValue.serverTimestamp() });
    return [text("找到了！為了確認是本人，請輸入註冊會員時用的 Email。")];
  }
  if (sess?.step === "email") {
    if (/^取消$/.test(t)) return (await sRef.delete(), [text("已取消綁定。", MENU)]);
    const s = (await db.doc(`shoppers/${sess.shopperId}`).get()).data();
    if (!s || String(s.email ?? "").toLowerCase() !== t.toLowerCase()) {
      const tries = (sess.tries ?? 0) + 1;
      if (tries >= 3) return (await sRef.delete(), [text("Email 不正確，已取消綁定。需要協助請到門市找店員。", MENU)]);
      await sRef.update({ tries });
      return [text(`Email 不正確，請再試一次（還可以試 ${3 - tries} 次）。`)];
    }
    // 一個 LINE 只綁一位會員：先拿掉別人身上的這個 LINE
    const prev = await db.collection("shoppers").where("lineUserId", "==", uid).get();
    await Promise.all(prev.docs.map((d) => d.ref.update({ lineUserId: FieldValue.delete() })));
    await db.doc(`shoppers/${sess.shopperId}`).update({ lineUserId: uid, lineBoundAt: FieldValue.serverTimestamp(), lineBoundVia: "chat" });
    await sRef.delete();
    return [text(`綁定完成 🎉 ${s.name || ""} 您好！`), ...(await replyCard(uid))];
  }
  if (/會員卡|會員/.test(t)) return replyCard(uid);
  if (/消費|紀錄|購物金|點數/.test(t)) return replyHistory(uid);
  if (/^(我)?(想|要)?(找|搜尋|搜)/.test(t) || /有沒有.+(褲|袖|衣|外套|包|裙)|適合|推薦.+(褲|袖|衣|外套)/.test(t)) return replyAiText(uid, t);
  if (/喜好|偏好|我的風格/.test(t)) return replyPrefs(uid);
  if (/推薦|喜歡|適合我/.test(t)) return replyForYou(uid);
  if (/新品|新貨|上新/.test(t)) return replyNew();
  if (/特價|特惠|出清|sale/i.test(t)) return replyNew(true);
  if (/客服|真人|聯絡/.test(t)) return [text("收到了！客服會盡快回覆您 🙏\n可以先告訴我們：想問的商品（或截圖）、身高體重，或訂單編號。")];
  if (/活動|優惠|折扣/.test(t)) return replyPromo();
  if (/門市|地址|營業|電話|地圖|在哪/.test(t)) return replyStore();
  return null; // 其他訊息交給店家在 LINE 後台手動回覆
}

async function handleEvent(e: { type: string; replyToken?: string; source?: { userId?: string }; postback?: { data?: string }; message?: { type: string; text?: string; id?: string } }) {
  const uid = e.source?.userId;
  if (!uid || !e.replyToken) return;
  let out: Msg[] | null = null;
  // 聊天室顯示「…」輸入中動畫（回覆送到就自動消失；不算訊息則數）。AI 找商品（圖片、找…）比較久，給長一點
  if (e.type === "postback" || e.type === "message") {
    const slow = e.message?.type === "image" || /^(我)?(想|要)?(找|搜)|有沒有|適合|推薦|喜歡/.test(e.message?.text ?? "") || /a=(foryou|history|new|sale)/.test(e.postback?.data ?? "");
    lineApi("/chat/loading/start", { chatId: uid, loadingSeconds: slow ? 30 : 10 }).catch(() => undefined);
  }
  if (e.type === "follow") {
    const st = await shopSettings();
    out = [text(`歡迎加入 ${st.shopName || "ganbaru29"}！👋\n點下方選單可以看會員卡、消費紀錄、新品和本月活動。\n第一次使用請先點「會員卡」綁定會員。`, MENU)];
    await db.doc(`lineFollowers/${uid}`).set({ followedAt: FieldValue.serverTimestamp(), blocked: false }, { merge: true });
  } else if (e.type === "unfollow") {
    await db.doc(`lineFollowers/${uid}`).set({ blocked: true, unfollowedAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  } else if (e.type === "postback") {
    const qp = new URLSearchParams(e.postback?.data ?? "");
    const a = qp.get("a");
    out = a === "prefs" ? await replyPrefs(uid) : a === "pref" ? await replyPrefs(uid, qp.get("v") ?? "") : a === "foryou" ? await replyForYou(uid) : a === "barcode" ? await replyBarcode(uid) : a === "card" ? await replyCard(uid) : a === "history" ? await replyHistory(uid) : a === "new" ? await replyNew() : a === "sale" ? await replyNew(true) : a === "promo" ? await replyPromo() : a === "store" ? await replyStore() : null;
  } else if (e.type === "message" && e.message?.type === "image" && e.message.id) {
    out = await replyAiImage(uid, e.message.id);
  } else if (e.type === "message" && e.message?.type === "text") {
    out = await handleText(uid, e.message.text ?? "");
  }
  if (out?.length) await reply(e.replyToken, out);
}

/** LINE 平台送事件到這裡（官方帳號後台的 Webhook URL） */
export const lineWebhook = onRequest({ maxInstances: 10, timeoutSeconds: 60 }, async (req, res) => {
  try {
    const c = await botCreds();
    const sig = String(req.get("x-line-signature") ?? "");
    const expect = createHmac("sha256", c.channelSecret).update(req.rawBody).digest("base64");
    if (!sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      res.status(401).send("bad signature");
      return;
    }
    const events = (req.body?.events ?? []) as Parameters<typeof handleEvent>[0][];
    await Promise.all(events.map((e) => handleEvent(e).catch((err) => logger.error("line event", e.type, errMsg(err)))));
    res.send("ok");
  } catch (e) {
    logger.error("lineWebhook", e);
    res.status(200).send("ok"); // 回 200，避免 LINE 一直重送
  }
});

/** 老闆在設定頁存官方帳號的 Channel ID／secret（只存在 Secret Manager） */
export const setLineBotCreds = onCall(async (req) => {
  await requireRole(req, "owner");
  const channelId = str(req.data?.channelId, "Channel ID", { max: 20 });
  const channelSecret = str(req.data?.channelSecret, "Channel secret", { max: 64 });
  assert(/^\d{8,12}$/.test(channelId) && /^[0-9a-f]{32}$/i.test(channelSecret), "Channel ID 或 secret 格式不對");
  await setSecret("LINE_BOT", JSON.stringify({ channelId, channelSecret }));
  memToken = null;
  await db.doc("private/lineBotToken").delete().catch(() => undefined);
  const info = await lineApi("/info", undefined, "GET");
  return { name: info.displayName, basicId: info.basicId };
});

export const lineBotStatus = onCall(async (req) => {
  await requireRole(req, "owner");
  try {
    const [info, quota, usage, followers] = await Promise.all([
      lineApi("/info", undefined, "GET"),
      lineApi("/message/quota", undefined, "GET"),
      lineApi("/message/quota/consumption", undefined, "GET"),
      db.collection("shoppers").where("lineUserId", ">", "").count().get(),
    ]);
    return { ok: true, name: info.displayName, basicId: info.basicId, quota: quota.value ?? null, used: usage.totalUsage ?? 0, bound: followers.data().count };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
});

/** 圖文選單：on = 設成所有好友的預設選單；off = 取消（官方帳號後台設定的選單會回來） */
export const setLineRichMenu = onCall(async (req) => {
  await requireRole(req, "owner");
  const st = await shopSettings();
  const id = String(st.lineBot?.richMenuId ?? "");
  assert(id, "還沒有建立圖文選單", "failed-precondition");
  if (req.data?.on) await lineApi(`/user/all/richmenu/${id}`, {});
  else await lineApi("/user/all/richmenu", undefined, "DELETE");
  await db.doc("settings/shop").set({ lineBot: { richMenuOn: !!req.data?.on } }, { merge: true });
  return { ok: true };
});

/** 會員條碼圖片：QR＋一維條碼＋會員編號（t = 會員卡 token） */
export const lineCardImage = onRequest({ maxInstances: 10, memory: "512MiB" }, async (req, res) => {
  const t = String(req.query.t ?? "").replace(/[^0-9a-f]/gi, "");
  const q = t.length >= 16 ? await db.collection("shoppers").where("cardToken", "==", t).limit(1).get() : null;
  const code = q?.docs[0]?.data().memberCode as string | undefined;
  if (!code) {
    res.status(404).send("not found");
    return;
  }
  const W = 1000;
  const qr = await QRCode.toBuffer(code, { width: 560, margin: 1, errorCorrectionLevel: "M" });
  const bar = await bwipjs.toBuffer({ bcid: "code128", text: code, scale: 4, height: 18, includetext: true, textsize: 13, textxalign: "center" });
  const barMeta = await sharp(bar).metadata();
  const barW = Math.min(W - 80, barMeta.width ?? 800);
  const barImg = await sharp(bar).resize({ width: barW }).toBuffer();
  const png = await sharp({ create: { width: W, height: W, channels: 3, background: "#ffffff" } })
    .composite([
      { input: qr, top: 40, left: (W - 560) / 2 },
      { input: barImg, top: 640, left: Math.round((W - barW) / 2) },
    ])
    .png()
    .toBuffer();
  res.set("content-type", "image/png").set("cache-control", "public, max-age=86400").send(png);
});
