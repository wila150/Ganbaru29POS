import bwipjs from "bwip-js";
import { createHmac, timingSafeEqual } from "crypto";
import QRCode from "qrcode";
import sharp from "sharp";
import { logger } from "firebase-functions";
import { onCall, onRequest } from "firebase-functions/v2/https";
import { cardLabel, ensureMemberCodes, isVip } from "./cards";
import { requireRole } from "./lib/auth";
import * as meep from "./lib/meepshop";
import { getSecret, setSecret } from "./lib/secrets";
import { assert, db, errMsg, FieldValue, str } from "./lib/util";
import { describePromo, promoIsLive, taipeiClock, type Promotion } from "./shared/promo";
import { mobileKeyCandidates } from "./sync";
import { askHuman, embedImage, learnFromQuery, markMiss, nextPage, rankByImage, saveQuery } from "./imageSearch";
import { birthDateInput } from "./lib/util";
import { mobileKey } from "./sync";

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
    return [text("還沒綁定會員喔！\n已經是會員：請輸入註冊用的「手機號碼」（例如 0912345678；香港／澳門加區碼，例如 85291234567）。\n還不是會員：點下面「加入會員」。", [["加入會員", "a=join"]])];
  }
  await ensureMemberCodes([s.id]);
  const x = (await s.ref.get()).data()!;
  const live = await meep.getShopper(s.id).catch(() => null);
  const points = live?.usableRewardPoints ?? x.points ?? 0;
  // 超級VIP（甘爹）黑金卡；一般會員（尊貴的客人）咖啡卡
  const st0 = await shopSettings();
  const vip = isVip(x, st0);
  const group = cardLabel(x, st0);
  const banner: string | null = vip ? st0.lineBot?.vipBanners?.[group] || st0.lineBot?.vipBanners?.["超級VIP"] || null : null;
  // 有效期限：系統升級的看 tierUntil；meepShop 直接設的拿不到期限
  const until = x.tierUntil?.toDate?.() as Date | undefined;
  const expiry = vip ? (until ? until.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }) : "依官網會員資格") : null;
  const theme = vip ? { bg: "#111111", title: "#d4af37", sub: "#f3e5ab", accent: "#b8912e", text: `${group} 會員卡` } : { bg: "#4a3b32", title: "#ffffff", sub: "#d9c3a5", accent: "#059669", text: "ganbaru29 會員卡" };
  return [
    {
      type: "flex",
      altText: `${x.name || "會員"} 的會員卡`,
      contents: {
        type: "bubble",
        size: "giga",
        // 超級VIP／甘爹：最上面是會動的金色閃光橫幅（APNG）；一般會員：咖啡色標題
        header: banner
          ? { type: "box", layout: "vertical", paddingAll: "0px", backgroundColor: "#0d0d0d", contents: [{ type: "image", url: banner, size: "full", aspectRatio: "750:220", aspectMode: "cover", animated: true }] }
          : { type: "box", layout: "vertical", backgroundColor: theme.bg, contents: [{ type: "text", text: vip ? "★ ganbaru29" : "ganbaru29", color: theme.sub, size: "xs", weight: "bold" }, { type: "text", text: theme.text, color: theme.title, weight: "bold", size: "lg" }, { type: "text", text: group, color: theme.sub, size: "sm" }] },
        // 條碼直接放大顯示在卡片上，結帳時打開就能掃，不用再點放大
        hero: { type: "image", url: `${CARD_IMG}?t=${x.cardToken}`, size: "full", aspectRatio: "1:1", aspectMode: "fit", backgroundColor: "#ffffff" },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "text", text: x.name || "會員", weight: "bold", size: "xl", color: vip ? "#f3e5ab" : "#111827" },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "可用購物金", color: vip ? "#bfae7a" : "#6b7280", size: "sm" }, { type: "text", text: `${points} 點`, align: "end", weight: "bold", color: vip ? "#e6c76a" : theme.accent }] },
            { type: "box", layout: "horizontal", contents: [{ type: "text", text: "會員編號", color: vip ? "#bfae7a" : "#6b7280", size: "sm" }, { type: "text", text: x.memberCode ?? "—", align: "end", size: "sm", color: vip ? "#f3e5ab" : "#111827" }] },
            ...(expiry ? [{ type: "box", layout: "horizontal", contents: [{ type: "text", text: "有效期限", color: "#bfae7a", size: "sm" }, { type: "text", text: expiry, align: "end", size: "sm", color: "#f3e5ab" }] }] : []),
          ],
          ...(vip ? { backgroundColor: "#111111" } : {}),
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          ...(vip ? { backgroundColor: "#111111" } : {}),
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

/** 「水洗寬管落地寬褲 咖色 共兩色」→ 款式「水洗寬管落地寬褲」＋顏色「咖色」 */
function splitStyle(title: string): { style: string; color: string | null } {
  const m = String(title).match(/^(.*?)\s+(\S+?)\s*共[一二兩三四五六七八九十\d]+色\s*$/);
  return m ? { style: m[1].trim(), color: m[2] } : { style: String(title).trim(), color: null };
}

/** 挑到某一色時，把同款的其他顏色也帶進來（卡片上一起顯示） */
function withSiblings(pick: P[], all: P[]): P[] {
  const styles = new Set(pick.map((p) => splitStyle(p.productTitle).style));
  const out = [...pick];
  for (const p of all) if (styles.has(splitStyle(p.productTitle).style) && !out.some((x) => x.productId === p.productId)) out.push(p);
  // 保持挑選的順序：同款排在一起
  const order = [...styles];
  return out.sort((a, b) => order.indexOf(splitStyle(a.productTitle).style) - order.indexOf(splitStyle(b.productTitle).style));
}

/** 商品卡片：同款不同顏色合成一張（下面每個顏色一個按鈕），最多 10 款 */
async function carousel(list: P[], alt: string, fb?: { qid: string }): Promise<Msg> {
  const st = await shopSettings();
  const site = (st.siteBaseUrl || DEFAULT_SITE).replace(/\/$/, "");
  const groups: { style: string; items: (P & { color: string | null })[] }[] = [];
  for (const p of list) {
    const { style, color } = splitStyle(p.productTitle);
    const g = groups.find((x) => x.style === style);
    if (g) g.items.push({ ...p, color });
    else groups.push({ style, items: [{ ...p, color }] });
  }
  return {
    type: "flex",
    altText: alt,
    contents: {
      type: "carousel",
      contents: groups.slice(0, 10).map(({ style, items }) => {
        const v = items[0];
        const prices = items.map((x) => x.price);
        const lo = Math.min(...prices);
        const sale = items.find((x) => (x.listPrice ?? 0) > x.price);
        const colors = items.map((x) => x.color).filter(Boolean) as string[];
        return {
          type: "bubble",
          size: "kilo",
          hero: { type: "image", url: v.imageUrl, size: "full", aspectRatio: "3:4", aspectMode: "cover", action: { type: "uri", uri: `${site}/products/${v.productId}` } },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            contents: [
              { type: "text", text: style, weight: "bold", size: "sm", wrap: true, maxLines: 2 },
              ...(colors.length > 1 ? [{ type: "text", text: `${colors.join("・")}　共 ${colors.length} 色`, size: "xs", color: "#8a7a6d", wrap: true }] : []),
              ...(sale ? [{ type: "text", text: `$${Number(sale.listPrice).toLocaleString("en-US")}`, size: "xs", color: "#9ca3af", decoration: "line-through" }] : []),
              { type: "text", text: $(lo), weight: "bold", color: sale ? "#b91c1c" : "#111827" },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "xs",
            // 每個顏色一個按鈕（最多 3 個），點了到那個顏色的官網頁
            contents: [
              ...items.slice(0, 3).map((x, i) => ({
                type: "button",
                style: i === 0 ? "primary" : "secondary",
                color: i === 0 ? "#4a3b32" : undefined,
                height: "sm",
                action: { type: "uri", label: (items.length > 1 && x.color ? `看${x.color}` : "看商品").slice(0, 20), uri: `${site}/products/${x.productId}` },
              })),
              // 以圖搜圖：客人確認「就是這件」→ 系統記住這張照片（學習）
              ...(fb ? [{ type: "button", style: "link", height: "sm", action: { type: "postback", label: "✓ 就是這件", data: `a=fb&q=${fb.qid}&p=${v.productId}`, displayText: `就是這件：${style}`.slice(0, 300) } }] : []),
            ],
          },
        };
      }),
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

/** w 裡最長、出現在 hay 的連續片段（至少 2 字）→ 分數 */
function partial(w: string, hay: string): number {
  for (let k = w.length; k >= 2; k--) for (let i = 0; i + k <= w.length; i++) if (hay.includes(w.slice(i, i + k))) return k >= w.length ? 3 + k : 1 + k;
  return 0;
}

/** 把客人的話拆成條件：顏色、分類、其他關鍵字 */
function parseQuery(q: string) {
  const t = q
    .replace(/^(我)?(想|要)?(找|買|看)(一件|一條|件|條)?/, "")
    .replace(/[，。,.!！?？]/g, " ")
    .replace(/丹寧|denim/gi, "牛仔")
    .replace(/襯(?!衫)/g, "襯衫")
    .trim();
  const colors = COLORS.filter((c) => t.includes(c));
  const cats = CAT_WORDS.filter(([re]) => re.test(t)).flatMap(([, c]) => c);
  let rest = t;
  for (const c of colors) rest = rest.split(c).join(" ");
  for (const [re] of CAT_WORDS) rest = rest.replace(re, " ");
  const words = rest.replace(/色|的|有沒有|嗎|一件|一條|款/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  return { text: t, colors, cats, words };
}

/** 老闆設定的同義詞（例：丹寧＝牛仔、大學T＝衛衣），搜尋前先換掉 */
async function applySynonyms(q: string): Promise<string> {
  const syn = ((await shopSettings()).lineBot?.synonyms ?? {}) as Record<string, string>;
  let out = q;
  for (const [k, v] of Object.entries(syn)) if (k && v) out = out.split(k).join(v);
  return out;
}

const logMiss = (q: string, kind: string) => db.collection("aiMisses").add({ q: q.slice(0, 80), kind, at: FieldValue.serverTimestamp() }).catch(() => undefined);

async function replySearch(q0: string): Promise<Msg[]> {
  const q = await applySynonyms(q0);
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
      // 關鍵字部分相符也算（「拼接襯」裡的「拼接」對到「層次拼接工裝寬褲」），越長分越高
      for (const w of words) score += partial(w, hay);
      if (!cats.length && !colors.length && !words.some((w) => partial(w, hay) > 0) && !hay.includes(t)) score -= 10;
      if (hay.includes(t)) score += 6;
      return { p, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.p.at - a.p.at);
  if (!scored.length) await logMiss(q0, "text");
  if (!scored.length) return [text(`找不到「${t}」相關的商品 🙏\n可以換個說法試試，例如「找 黑色長褲」，或點「新品」看看最近上架的。`, MENU)];
  return [text(`幫你找到 ${Math.min(scored.length, 10)} 款「${t}」👇`), await carousel(scored.map((r) => r.p), `找商品：${t}`)];
}

// ---------- AI 找商品（NVIDIA 免費 API：打字描述或傳截圖） ----------

const AI_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const AI_MODEL = "nvidia/nemotron-3.5-super-vl-120b-a12b";

/** AI 使用次數（只記錄、不限制；老闆要求取消每日上限） */
async function aiQuota(uid: string): Promise<boolean> {
  const ref = db.doc(`lineAiUsage/${uid}_${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" })}`);
  await ref.set({ n: FieldValue.increment(1), at: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined);
  return true;
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

async function aiPick(prompt: string, imageB64?: string): Promise<{ ids: number[]; note: string; ask: string; suggest: string[] } | null> {
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
    const r = JSON.parse(m[0]) as { ids?: unknown[]; note?: string; ask?: string; suggest?: unknown[] };
    return {
      ids: (r.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0),
      note: String(r.note ?? "").slice(0, 120),
      ask: String(r.ask ?? "").slice(0, 60),
      suggest: (r.suggest ?? []).map((x) => String(x).slice(0, 14)).filter(Boolean).slice(0, 4),
    };
  } catch {
    return null;
  }
}

const AI_RULES = `你是 ganbaru29（29 STUDIO）服飾店的店員，只能從下面的商品清單挑商品，不可以編造清單外的商品。
清單格式：編號|品名|分類|顏色/尺寸|價格
客人可能只打部分字（例：「拼接襯」＝拼接的襯衫／上衣，「寬褲」＝寬版褲子），請理解意思；名稱部分相符的也算候選。
規則：客人指定的「品類」一定要相符（說短袖就只能挑短袖／T恤／短襯，說長褲就只能挑褲子），顏色、版型盡量相符；寧可少挑，不要挑不相符的。
挑出最符合的商品（最多 6 個，越像越前面）；完全沒有相符的就回空陣列。
如果沒有完全相符、或客人說得不清楚：ids 放最接近的幾件，並在 ask 用一句話反問（例：「你是要找拼接襯衫嗎？」），suggest 給 2～4 個更明確的說法（例：["拼接襯衫","拼接上衣","拼接寬褲"]）。完全相符時 ask 留空。
只輸出 JSON：{"ids":[編號...],"note":"一句繁體中文說明（例：找到 3 款咖啡色寬版短袖）","ask":"","suggest":[]}`;

/** 留給店家手動回的訊息（訂單、付款、客服、打招呼） */
const HUMAN_TOPIC = /訂單|出貨|寄出|到貨|物流|退貨|換貨|退款|匯款|轉帳|付款|發票|請問|謝謝|感謝|你好|您好|哈囉|嗨|hi|hello|在嗎|客服|真人|聯絡|預約|營業|地址|電話/i;
/** 沒有指令、但看起來像在說商品（短、像品名）→ 直接幫他找；找不到就不回，留給店家 */
const looksLikeProduct = (t: string) => t.length >= 2 && t.length <= 20 && !HUMAN_TOPIC.test(t) && !/^[\d\s+-]+$/.test(t) && !/@/.test(t);

async function replyAiText(uid: string, q0: string, quiet = false): Promise<Msg[] | null> {
  const q = await applySynonyms(q0);
  await aiQuota(uid);
  const cat = await aiCatalog();
  const r = await aiPick(`${AI_RULES}\n\n商品清單：\n${cat.text}\n\n客人說：「${q.slice(0, 200)}」`).catch(() => null);
  if (!r) {
    // AI 沒回應 → 用關鍵字找；安靜模式下關鍵字也找不到就不回
    const k = await replySearch(q);
    return quiet && !k.some((m) => m.type === "flex") ? null : k;
  }
  const pick = r.ids.map((i) => cat.list[i]).filter(Boolean);
  if (!pick.length) {
    // AI 說沒有 → 再用關鍵字找一次（部分相符），有相近的就給相近的
    const k = await replySearch(q0);
    if (k.some((m) => m.type === "flex")) return k;
  }
  if (!pick.length) await logMiss(q0, quiet ? "auto" : "ai");
  if (!pick.length) return quiet ? null : [text(`${r.note || "店裡目前沒有很符合的商品"} 🙏\n可以換個說法，或點「新品」看看最近上架的。`, MENU)];
  // 說得不夠清楚 → 反問「你是要找拼接襯衫嗎？」＋按鈕，同時先給最接近的
  if (r.ask && r.suggest.length) {
    const quick = { type: "text", text: `${r.ask}\n先給你最接近的 👇`, quickReply: { items: r.suggest.map((x) => ({ type: "action", action: { type: "message", label: x, text: `找 ${x}` } })) } };
    return [quick, await carousel(withSiblings(pick, cat.list), "AI 幫你找的商品")];
  }
  return [text(`${r.note || `幫你找到 ${pick.length} 款`} 👇`), await carousel(withSiblings(pick, cat.list), "AI 幫你找的商品")];
}

const FOCUS_WORDS: [RegExp, string][] = [
  [/褲/, "褲子"],
  [/外套|夾克|大衣|背心/, "外套"],
  [/上衣|衣服|T恤|t恤|短袖|長袖|襯衫|衛衣/i, "上衣"],
  [/套裝/, "套裝"],
  [/包/, "包包"],
];
const focusOf = (t: string) => FOCUS_WORDS.find(([re]) => re.test(t))?.[1] ?? null;

/** 「褲子」「外套」→ 對應的商品分類（以圖搜圖時只比同一類，不會褲子比到外套） */
const FOCUS_CATS: [RegExp, string[]][] = [
  [/褲/, ["長褲", "短褲"]],
  [/外套|夾克|大衣|背心|風衣/, ["外套"]],
  [/上衣|T恤|t恤|短袖|襯衫|POLO|polo/i, ["短袖", "長袖"]],
  [/長袖|衛衣|大學T|針織/, ["長袖"]],
  [/套裝/, ["套裝"]],
  [/包/, ["包款"]],
];

/**
 * 以圖搜圖：AI 先看圖找出要找的那件（客人指定的或最顯眼的）並框出位置 → 裁切那件 → 跟所有商品照片（含客人確認過的照片）比相似度。
 * 圖裡有好幾件時附「只找褲子／上衣／外套」；每張結果有「✓ 就是這件」讓系統學習。
 */
async function replyAiImage(uid: string, messageId: string, focus: string | null = null): Promise<Msg[] | null> {
  await db.doc(`lineSessions/${uid}`).set({ lastImageId: messageId, lastImageAt: FieldValue.serverTimestamp() }, { merge: true });
  await aiQuota(uid);
  const img = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${await botToken()}` } });
  if (!img.ok) return [text("圖片已過期或讀取失敗，請再傳一次 🙏")];
  const buf = Buffer.from(await img.arrayBuffer());
  const small = await sharp(buf).rotate().resize({ width: 1024, height: 1024, fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
  const cat = await aiCatalog();
  const prompt = `${AI_RULES.replace(/只輸出 JSON：.*$/s, "")}
客人傳了一張圖片（截圖、穿搭照或實拍）。
${focus ? `客人要找的是圖片中的「${focus}」，只看那一件，其他衣服忽略。` : "如果圖裡有好幾件衣服，找最顯眼、佔畫面最大的那一件。"}
步驟：1. 先仔細看那件的品類、顏色、版型（寬／直筒／短版）、材質（丹寧、水洗、格紋…）、細節（打褶、口袋、印花、文字）。2. 品類一定要一樣（褲子只能挑褲子），再比顏色、版型、細節，挑最像的。圖上有商品名稱時，優先找同名商品。
box = 那件衣服在圖中的位置 [左, 上, 右, 下]，用 0～1000 的比例。
如果圖片裡沒有衣服或包（例如轉帳截圖、訂單畫面、聊天截圖、風景），只輸出 {"seen":"","kind":"","items":[],"ids":[],"box":[],"note":"NOT_CLOTHING"}。
只輸出 JSON：{"seen":"你看到的那件（例：灰色寬版打褶長褲）","kind":"品類（褲子／上衣／外套／套裝／包包）","items":["圖中所有衣服的品類"],"box":[左,上,右,下],"ids":[編號...],"note":"一句繁體中文說明"}

商品清單：
${cat.text}`;
  const r = await aiPickImage(prompt, small.toString("base64"));
  if (r?.note === "NOT_CLOTHING") return null; // 不是衣服的圖（轉帳、訂單截圖…）：不回，留給店家
  // 裁出那件衣服再比相似度（整張穿搭照會混到別件）
  let target = small;
  const bx = r?.box ?? [];
  if (bx.length === 4 && bx.every((n) => Number.isFinite(n))) {
    const meta = await sharp(small).metadata();
    const W = meta.width ?? 1024;
    const H = meta.height ?? 1024;
    const [x1, y1, x2, y2] = bx.map((n) => Math.max(0, Math.min(1000, n)) / 1000);
    const pad = 0.04;
    const left = Math.max(0, Math.floor((Math.min(x1, x2) - pad) * W));
    const top = Math.max(0, Math.floor((Math.min(y1, y2) - pad) * H));
    const width = Math.min(W - left, Math.ceil((Math.abs(x2 - x1) + pad * 2) * W));
    const height = Math.min(H - top, Math.ceil((Math.abs(y2 - y1) + pad * 2) * H));
    if (width > 60 && height > 60) target = await sharp(small).extract({ left, top, width, height }).toBuffer().catch(() => small);
  }
  const qv = await embedImage(target).catch(() => null);
  // 同品類的商品才比（褲子只比褲子）
  const kindText = `${focus ?? ""} ${r?.kind ?? ""} ${r?.seen ?? ""}`;
  const allowCats = FOCUS_CATS.find(([re]) => re.test(kindText))?.[1];
  const allow = allowCats ? new Set(cat.list.filter((p) => p.cats.some((c) => allowCats.includes(c))).map((p) => p.productId)) : undefined;
  const byPid = new Map(cat.list.map((p) => [p.productId, p]));
  const aiIds = new Set((r?.ids ?? []).map((i) => cat.list[i]?.productId).filter(Boolean) as string[]);
  let ranked: { pid: string; score: number }[] = [];
  if (qv) {
    ranked = (await rankByImage(qv, allow && allow.size ? allow : undefined))
      .filter((x) => byPid.has(x.pid))
      .map((x) => ({ pid: x.pid, score: x.score + (aiIds.has(x.pid) ? 0.03 : 0) + (x.learned ? 0.02 : 0) }))
      .sort((a, b) => b.score - a.score);
  }
  // 圖片特徵還沒建好時，退回 AI 文字比對的結果
  const allIds = ranked.length ? ranked.map((x) => x.pid) : [...aiIds];
  const pickIds = allIds.slice(0, 8);
  if (!pickIds.length) return r ? [text(`我看到的是「${r.seen || "這件衣服"}」，店裡好像沒有很像的 🙏\n可以拍清楚一點，或打字描述，例如「找 灰色寬褲」。`, MENU)] : [text("AI 暫時忙線中，請稍後再傳一次，或直接打字「找 黑色長褲」🙏", MENU)];
  const pick = pickIds.map((pid) => byPid.get(pid)!).filter(Boolean);
  const qid = qv ? await saveQuery(uid, qv, allIds, target, r?.seen).catch(() => null) : null;
  const others = [...new Set((r?.items ?? []).map((x) => focusOf(x)).filter(Boolean) as string[])];
  const quick: [string, string][] = [
    ...(qid ? ([["都不是", `a=fbno&q=${qid}`]] as [string, string][]) : []),
    ...(!focus && others.length > 1 ? others.slice(0, 3).map((f) => [`只找${f}`, `a=imgfocus&f=${encodeURIComponent(f)}`] as [string, string]) : []),
  ];
  const head = r?.seen ? `我看到的是「${r.seen}」，` : "";
  return [
    text(`${head}這幾款最像 👇\n找到的話點「✓ 就是這件」，我會記住，下次更快找到！`, quick.length ? quick : undefined),
    await carousel(withSiblings(pick, cat.list), "以圖搜圖", qid ? { qid } : undefined),
  ];
}

/** 圖片版 aiPick：多回傳 seen（看到什麼）與 items（圖中有哪些衣服） */
async function aiPickImage(prompt: string, imageB64: string): Promise<{ ids: number[]; note: string; seen: string; kind: string; items: string[]; box: number[] } | null> {
  const key = await getSecret("AI_NVIDIA");
  if (!key) return null;
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: AI_MODEL, temperature: 0, max_tokens: 500, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: "detailed thinking off" }, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageB64}` } }] }] }),
    signal: AbortSignal.timeout(45_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const out = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]) as { ids?: unknown[]; note?: string; seen?: string; kind?: string; items?: unknown[]; box?: unknown[] };
    return {
      ids: (r.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 0),
      note: String(r.note ?? "").slice(0, 120),
      seen: String(r.seen ?? "").slice(0, 60),
      kind: String(r.kind ?? "").slice(0, 20),
      items: (r.items ?? []).map(String).slice(0, 6),
      box: (r.box ?? []).map(Number).slice(0, 4),
    };
  } catch {
    return null;
  }
}

/** 客人剛傳過圖（15 分鐘內），接著說「這件褲子」→ 用那張圖找 */
async function recentImage(uid: string): Promise<string | null> {
  const x = (await db.doc(`lineSessions/${uid}`).get()).data();
  const at = x?.lastImageAt?.toMillis?.() ?? 0;
  return x?.lastImageId && Date.now() - at < 15 * 60_000 ? (x.lastImageId as string) : null;
}

/** 客人自己勾的喜好選項（可在設定頁改 lineBot.prefOptions） */
/** 「想要收到」表單（照老闆的手寫稿）：通知類＋特定種類上新 */
const NOTIFY_PREFS: [string, string][] = [
  ["新品通知", "新品上架一週內，每件現折 $100"],
  ["特價活動", "特價專區、直播、福袋"],
];
const CAT_PREFS = ["長褲", "短褲", "長袖", "短袖", "外套"];
const DEFAULT_PREFS = [...NOTIFY_PREFS.map(([k]) => k), ...CAT_PREFS];
/** 喜好 → 商品分類（推薦用） */
const PREF_CATS: Record<string, string[]> = { 特價活動: ["特價專區"], 特價優惠: ["特價專區"], 新品通知: [] };

const PREFS_URL = "https://asia-east1-ganbaru29.cloudfunctions.net/linePrefs";
/** 喜好表單連結：簽章（channel secret）＋30 分鐘到期，只有本人能開 */
async function prefsLink(uid: string) {
  const exp = Date.now() + 30 * 60_000;
  const sig = createHmac("sha256", (await botCreds()).channelSecret).update(`${uid}.${exp}`).digest("hex").slice(0, 32);
  return `${PREFS_URL}?u=${encodeURIComponent(uid)}&e=${exp}&s=${sig}`;
}

async function prefOptions(): Promise<string[]> {
  const st = await shopSettings();
  return (st.lineBot?.prefOptions as string[] | undefined)?.length ? st.lineBot.prefOptions : DEFAULT_PREFS;
}

/** 「我的喜好」：一張卡片＋一個按鈕，打開表單一次勾完（不會每點一下就多一則訊息） */
async function replyPrefs(uid: string): Promise<Msg[]> {
  const s = await shopperByLine(uid);
  if (!s) return replyCard(uid);
  const likes: string[] = (s.data().likes ?? []) as string[];
  return [
    {
      type: "flex",
      altText: "我的喜好",
      contents: {
        type: "bubble",
        header: { type: "box", layout: "vertical", backgroundColor: "#4a3b32", contents: [{ type: "text", text: "MY STYLE", color: "#c9ae90", size: "sm", weight: "bold" }, { type: "text", text: "我的喜好", color: "#ffffff", weight: "bold", size: "lg" }] },
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "text", text: likes.length ? `目前：${likes.join("、")}` : "還沒有選喜好，選了之後「為你推薦」會更準喔！", size: "sm", color: "#3b2f28", wrap: true }] },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "button", style: "primary", color: "#4a3b32", action: { type: "uri", label: likes.length ? "修改通知設定" : "選擇想收到的通知", uri: await prefsLink(uid) } },
            { type: "button", style: "secondary", action: { type: "postback", label: "✨ 看為你推薦", data: "a=foryou", displayText: "為你推薦" } },
          ],
        },
      },
    },
  ];
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 喜好表單頁（在 LINE 內建瀏覽器打開）：GET 顯示、POST 儲存 */
export const linePrefs = onRequest({ maxInstances: 10 }, async (req, res) => {
  res.set("cache-control", "no-store");
  const u = String(req.query.u ?? req.body?.u ?? "");
  const e = Number(req.query.e ?? req.body?.e ?? 0);
  const sig = String(req.query.s ?? req.body?.s ?? "");
  const page = (body: string) =>
    res.send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的喜好</title>
<style>body{margin:0;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#efe6da;color:#3b2f28}
header{background:#4a3b32;color:#fff;padding:20px 20px 16px}header small{color:#c9ae90;letter-spacing:2px;font-weight:700}header h1{margin:4px 0 0;font-size:22px}
main{padding:18px}p{margin:0 0 14px;color:#6b5a4d;font-size:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
label{display:flex;align-items:center;justify-content:center;gap:6px;padding:14px 8px;border-radius:12px;background:#fff;border:2px solid #e2d5c4;font-size:17px;font-weight:600}
h2{font-size:16px;margin:18px 0 8px;color:#4a3b32}h2:first-of-type{margin-top:0}.grid.one{grid-template-columns:1fr}label.wide{justify-content:flex-start;padding:14px 16px}label span small{display:block;font-weight:400;font-size:13px;opacity:.8;margin-top:2px}
input{display:none}input:checked+span{color:#fff}label:has(input:checked){background:#4a3b32;border-color:#4a3b32;color:#fff}
button{margin-top:18px;width:100%;padding:15px;border:0;border-radius:12px;background:#059669;color:#fff;font-size:18px;font-weight:700}
.ok{text-align:center;padding:40px 10px}.ok b{font-size:44px;display:block}</style></head><body>
<header><small>MY STYLE</small><h1>想要收到哪些通知？</h1></header><main>${body}</main></body></html>`);
  try {
    const c = await botCreds();
    const expect = createHmac("sha256", c.channelSecret).update(`${u}.${e}`).digest("hex").slice(0, 32);
    if (!u || !sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) || e < Date.now()) {
      page(`<div class="ok"><b>⏰</b>連結已過期，請回到 LINE 再點一次「我的喜好」。</div>`);
      return;
    }
    const s = await shopperByLine(u);
    if (!s) {
      page(`<div class="ok"><b>🙏</b>請先回到 LINE 點「會員卡」綁定會員。</div>`);
      return;
    }
    const options = await prefOptions();
    if (req.method === "POST") {
      const raw = req.body?.likes;
      const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((x) => options.includes(x));
      await s.ref.update({ likes: picked, likesAt: FieldValue.serverTimestamp() });
      page(`<div class="ok"><b>✓</b>已儲存！<br><br>${picked.length ? esc(picked.join("、")) : "（沒有選）"}<br><br>回到 LINE 點「✨ 看為你推薦」就能看到推薦商品。</div><script>setTimeout(()=>{try{window.close()}catch(e){}},1800)</script>`);
      return;
    }
    const likes = (s.data().likes ?? []) as string[];
    const box = (o: string, sub = "") => `<label class="${sub ? "wide" : ""}"><input type="checkbox" name="likes" value="${esc(o)}"${likes.includes(o) ? " checked" : ""}><span>${esc(o)}${sub ? `<small>${esc(sub)}</small>` : ""}</span></label>`;
    const notify = NOTIFY_PREFS.filter(([k]) => options.includes(k));
    const cats = options.filter((o) => !NOTIFY_PREFS.some(([k]) => k === o));
    page(`<form method="post"><input type="hidden" name="u" value="${esc(u)}"><input type="hidden" name="e" value="${e}"><input type="hidden" name="s" value="${esc(sig)}">
<h2>想要收到</h2><div class="grid one">${notify.map(([k, sub]) => box(k, sub)).join("")}</div>
<h2>特定種類商品上新</h2><p>這幾類有新品時通知你（可複選）</p><div class="grid">${cats.map((o) => box(o)).join("")}</div>
<button type="submit">儲存</button></form>`);
  } catch (err) {
    logger.error("linePrefs", err);
    page(`<div class="ok"><b>😵</b>暫時無法儲存，請稍後再試。</div>`);
  }
});

// ---------- 在 LINE 加入會員（表單頁，簽章連結） ----------

const JOIN_URL = "https://asia-east1-ganbaru29.cloudfunctions.net/lineJoin";
async function joinLink(uid: string, mobile = "") {
  const exp = Date.now() + 30 * 60_000;
  const sig = createHmac("sha256", (await botCreds()).channelSecret).update(`join.${uid}.${exp}`).digest("hex").slice(0, 32);
  return `${JOIN_URL}?u=${encodeURIComponent(uid)}&e=${exp}&s=${sig}${mobile ? `&m=${encodeURIComponent(mobile)}` : ""}`;
}

async function replyJoin(uid: string, mobile = "", head = "加入 ganbaru29 會員"): Promise<Msg[]> {
  if (await shopperByLine(uid)) return replyCard(uid);
  await db.doc(`lineSessions/${uid}`).delete().catch(() => undefined);
  return [
    {
      type: "flex",
      altText: "加入會員",
      contents: {
        type: "bubble",
        header: { type: "box", layout: "vertical", backgroundColor: "#4a3b32", contents: [{ type: "text", text: "JOIN US", color: "#c9ae90", size: "sm", weight: "bold" }, { type: "text", text: head, color: "#ffffff", weight: "bold", wrap: true }] },
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "text", text: "填 Email、姓名、手機、生日，一分鐘完成。\n會員可以累積購物金、生日優惠，結帳出示 LINE 會員卡就好。", size: "sm", color: "#3b2f28", wrap: true }] },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            { type: "button", style: "primary", color: "#4a3b32", action: { type: "uri", label: "立即加入會員", uri: await joinLink(uid, mobile) } },
            { type: "button", style: "secondary", action: { type: "postback", label: "我已經是會員（輸入手機綁定）", data: "a=card", displayText: "會員卡" } },
          ],
        },
      },
    },
  ];
}

/** 加入會員表單：GET 顯示、POST 建立 meepShop 會員並綁定這個 LINE */
export const lineJoin = onRequest({ maxInstances: 10 }, async (req, res) => {
  res.set("cache-control", "no-store");
  const u = String(req.query.u ?? req.body?.u ?? "");
  const e = Number(req.query.e ?? req.body?.e ?? 0);
  const sig = String(req.query.s ?? req.body?.s ?? "");
  const page = (body: string): void => {
    res.send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>加入會員</title>
<style>body{margin:0;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#efe6da;color:#3b2f28}
header{background:#4a3b32;color:#fff;padding:20px 20px 16px}header small{color:#c9ae90;letter-spacing:2px;font-weight:700}header h1{margin:4px 0 0;font-size:22px}
main{padding:18px}label{display:block;margin:0 0 14px;font-size:14px;color:#6b5a4d}input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:13px;font-size:17px;border:2px solid #e2d5c4;border-radius:10px;background:#fff;color:#3b2f28}
button{margin-top:6px;width:100%;padding:15px;border:0;border-radius:12px;background:#059669;color:#fff;font-size:18px;font-weight:700}
.err{background:#fee2e2;color:#b91c1c;padding:10px 12px;border-radius:10px;margin-bottom:14px;font-size:14px}.ok{text-align:center;padding:40px 10px;line-height:1.7}.ok b{font-size:44px;display:block}.muted{color:#8a7a6d;font-size:13px}</style></head><body>
<header><small>JOIN US</small><h1>加入 ganbaru29 會員</h1></header><main>${body}</main></body></html>`);
  };
  const form = (v: Record<string, string>, err = ""): void =>
    page(`${err ? `<div class="err">${esc(err)}</div>` : ""}<form method="post"><input type="hidden" name="u" value="${esc(u)}"><input type="hidden" name="e" value="${e}"><input type="hidden" name="s" value="${esc(sig)}">
<label>Email<input type="email" name="email" required autocomplete="email" value="${esc(v.email)}"></label>
<label>姓名<input name="name" required autocomplete="name" value="${esc(v.name)}"></label>
<label>手機<input name="mobile" required inputmode="tel" autocomplete="tel" placeholder="0912345678" value="${esc(v.mobile)}"></label>
<label>生日<input type="date" name="birthDate" required value="${esc(v.birthDate)}" max="${new Date().toISOString().slice(0, 10)}"></label>
<button type="submit">加入會員</button><p class="muted">會員資料會同步到 ganbaru29 官網，可以用同一個 Email 登入官網。</p></form>`);
  try {
    const c = await botCreds();
    const expect = createHmac("sha256", c.channelSecret).update(`join.${u}.${e}`).digest("hex").slice(0, 32);
    if (!u || !sig || sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) || e < Date.now()) {
      page(`<div class="ok"><b>⏰</b>連結已過期，請回到 LINE 再點一次「加入會員」。</div>`);
      return;
    }
    if (await shopperByLine(u)) {
      page(`<div class="ok"><b>✓</b>你已經是會員了！<br>回到 LINE 點「會員卡」就能使用。</div>`);
      return;
    }
    if (req.method !== "POST") {
      form({ email: "", name: "", mobile: String(req.query.m ?? ""), birthDate: "" });
      return;
    }
    const v = { email: String(req.body?.email ?? "").trim().toLowerCase(), name: String(req.body?.name ?? "").trim().slice(0, 40), mobile: String(req.body?.mobile ?? "").trim().slice(0, 20), birthDate: String(req.body?.birthDate ?? "").trim() };
    // 同一個 LINE 30 分鐘內最多試 5 次
    const sRef = db.doc(`lineSessions/${u}`);
    const tries = ((await sRef.get()).data()?.joinTries ?? 0) as number;
    if (tries >= 5) return form(v, "嘗試太多次了，請稍後再試，或到門市請店員協助。");
    await sRef.set({ joinTries: tries + 1 }, { merge: true });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return form(v, "Email 格式不正確");
    if (!v.name) return form(v, "請填姓名");
    if (!/^(09\d{8}|(\+?(852|853))?\d{8})$/.test(v.mobile.replace(/[\s-]/g, ""))) return form(v, "手機號碼格式不對（台灣 09 開頭 10 碼；香港／澳門 8 碼）");
    let birthDate: string;
    try {
      birthDate = birthDateInput(v.birthDate);
    } catch {
      return form(v, "請填正確的生日");
    }
    let s;
    try {
      s = await meep.createShopper({ email: v.email, name: v.name, mobile: v.mobile.replace(/[\s-]/g, ""), birthDate });
    } catch (err) {
      const msg = errMsg(err);
      return form(v, /exist|已|重複|duplicate/i.test(msg) ? "這個 Email 已經是會員了，請回到 LINE 點「我已經是會員」，用手機綁定。" : `加入失敗：${msg.slice(0, 80)}`);
    }
    await db.doc(`shoppers/${s.id}`).set(
      {
        email: s.email,
        emailLower: s.email.toLowerCase(),
        name: s.name ?? v.name,
        mobile: s.mobile ?? v.mobile,
        mobileKey: mobileKey(s.mobile ?? v.mobile),
        points: s.usableRewardPoints ?? 0,
        memberGroup: s.memberGroup?.title ?? null,
        birthDate: s.birthDate ?? birthDate,
        birthMonth: birthDate.slice(5, 7),
        joinedAt: s.createdAt ?? new Date().toISOString(),
        joinedVia: "line",
        lineUserId: u,
        lineBoundAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await ensureMemberCodes([s.id]);
    await sRef.set({ joinTries: 0 }, { merge: true });
    page(`<div class="ok"><b>🎉</b>加入成功！歡迎 ${esc(v.name)}<br><br>回到 LINE 點「會員卡」，結帳時出示條碼就能累積購物金。</div><script>setTimeout(()=>{try{window.close()}catch(e){}},2500)</script>`);
  } catch (err) {
    logger.error("lineJoin", err);
    page(`<div class="ok"><b>😵</b>暫時無法加入，請稍後再試，或到門市請店員協助。</div>`);
  }
});

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
  // 每一類輪流挑（客人勾了長褲、短褲、外套…就每類都有，不會全部都是同一類）
  const cats = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const buckets = cats.map((c) => scored.filter((r) => r.p.cats.includes(c)).map((r) => r.p));
  const pick: P[] = [];
  for (let round = 0; pick.length < 10 && round < 10; round++)
    for (const b of buckets) {
      const next = b.find((p) => !pick.includes(p));
      if (next && pick.length < 10) pick.push(next);
    }
  for (const r of scored) if (pick.length < 10 && !pick.includes(r.p)) pick.push(r.p);
  if (!pick.length) return replyNew();
  // 說明寫客人自己勾的喜好（全部）；沒勾的話寫他常買的類別
  const likes = ((x.likes ?? []) as string[]).filter((l) => l !== "新品通知");
  const why = likes.length ? `依你的喜好「${likes.join("、")}」` : `依你常買的「${cats.slice(0, 3).join("、")}」`;
  return [text(personal ? `${x.name || ""} 您好！${why}挑了這些 👇` : "先推薦你最新上架的商品，買過幾次之後會越推越準 👇"), await carousel(withSiblings(pick, all), "為你推薦")];
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

// ---------- 查訂單（只查得到自己的） ----------

const ORDER_ST: Record<string, string> = { PROCESSING: "處理中", CLOSED: "已完成", CANCELED: "已取消", RETURN: "退貨" };
const SHIP_ST: Record<string, string> = {
  PROCESSING: "還沒出貨",
  PREPARING: "備貨中",
  OUT_OF_STOCK: "缺貨（店家會跟您聯絡）",
  FULFILLED: "已出貨",
  PRE_ORDER: "預購中",
  EXCHANGE: "換貨中",
  RETURN: "退貨中",
  PARTIALLY_SHIPPED: "部分出貨",
  ARRIVE_IN_STORE: "已到門市，可以取貨了",
  PICKUP_IN_STORE: "已取貨",
  RETURN_IN_STORE: "門市退貨",
};
const PAY_ST: Record<string, string> = { PAID: "已付款", RECONCILED: "已付款", NOT_PAID: "未付款", FAILED: "付款失敗", REFUNDED: "已退款" };

/** 訊息裡的訂單編號（8～20 碼數字；09 開頭 10 碼是手機，不算） */
function orderNumberIn(t: string): string | null {
  const p = t.replace(/\s/g, "").match(/P(\d{8})-?(\d{1,4})/i);
  if (p) return `P${p[1]}-${p[2].padStart(4, "0")}`;
  const m = t.replace(/\s/g, "").match(/(?:^#?|訂單[^\d]{0,6})(\d{8,20})$/);
  if (!m || /^09\d{8}$/.test(m[1])) return null;
  return m[1];
}
const ORDER_ASK = /^(查|我的|查詢)?(我的)?訂單(查詢|狀態|進度)?$|^查(貨|出貨|物流)|出貨了嗎|寄出了嗎|到貨了嗎|什麼時候(出貨|寄|到)/;

function orderText(o: meep.MOrder): string {
  const d = new Date(o.createdAt).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" });
  const sd = o.shipmentDetail as meep.MOrder["shipmentDetail"] & { trackingCode?: string | null; convenienceStore?: { name: string | null } | null };
  const status =
    o.status === "PROCESSING" ? SHIP_ST[o.shipmentStatus] ?? ORDER_ST[o.status] : o.status === "CLOSED" && o.shipmentStatus === "FULFILLED" ? "已出貨・已完成" : ORDER_ST[o.status] ?? o.status;
  const items = (o.lineItems ?? []).map((l) => `・${l.title} ×${l.quantity}`).slice(0, 6);
  const more = (o.lineItems?.length ?? 0) > 6 ? `…等 ${o.lineItems!.length} 項` : "";
  return [
    `📦 訂單 ${o.orderNumber}（${d}）`,
    `狀態：${status}`,
    `付款：${PAY_ST[o.paymentStatus] ?? o.paymentStatus}`,
    sd?.name ? `配送：${sd.name}${sd.convenienceStore?.name ? `（${sd.convenienceStore.name}）` : ""}` : "",
    sd?.trackingCode ? `追蹤碼：${sd.trackingCode}` : "",
    ...items,
    more,
    `金額：$${Math.round(o.totalPrice ?? 0).toLocaleString()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const POS_ST: Record<string, string> = { completed: "已完成", partial: "部分退貨", refunded: "已退貨", void: "已作廢" };

/** 門市消費（POS） */
function storeText(o: FirebaseFirestore.DocumentData): string {
  const d = (o.createdAt?.toDate?.() ?? new Date()).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" });
  const lines = (o.lines ?? []) as { productTitle: string; options?: string; qty: number }[];
  return [
    `🏬 門市消費 ${o.orderNo}（${d}）`,
    `狀態：${POS_ST[o.status] ?? o.status}`,
    ...lines.slice(0, 6).map((l) => `・${l.productTitle}${l.options ? ` ${l.options}` : ""} ×${l.qty}`),
    lines.length > 6 ? `…等 ${lines.length} 項` : "",
    `金額：$${Math.round(o.total ?? 0).toLocaleString()}`,
    o.invoice?.no && !o.invoice.voided ? `發票：${o.invoice.no}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const SHOWN_POS = ["completed", "partial", "refunded", "void"];

async function replyOrders(uid: string, num: string | null): Promise<Msg[]> {
  const me = await shopperByLine(uid);
  if (!me) return [text("查訂單要先綁定會員喔 🙏 綁定後就能隨時查自己的訂單。", [["綁定會員", "a=card"]])];
  const tail = "\n\n有其他問題直接留言，客服會回覆您 🙏";
  const notFound = (n: string) => [text(`查不到訂單 ${n} 🙏\n請確認編號，或這筆不是用您綁定的會員消費的。需要協助可以直接留言，客服會回覆您。`)];
  // 只回本人的訂單；別人的編號一律當作查不到
  if (num?.startsWith("P")) {
    const q = await db.collection("posOrders").where("orderNo", "==", num).limit(1).get();
    const o = q.docs[0]?.data();
    if (!o || o.shopper?.id !== me.id || !SHOWN_POS.includes(o.status)) return notFound(num);
    return [text(storeText(o) + tail)];
  }
  if (num) {
    const page = await meep.ordersPage({ first: 1, query: { orderNumber: [num] } });
    const o = page.edges[0]?.node;
    if (!o || o.shopper?.id !== me.id) return notFound(num);
    return [text(orderText(o) + tail)];
  }
  // 沒給編號：網店＋門市各抓最近幾筆，合在一起取最新 4 筆
  const [online, store] = await Promise.all([
    meep.ordersPage({ first: 3, query: { shopperId: me.id } }).catch(() => null),
    db.collection("posOrders").where("shopper.id", "==", me.id).orderBy("createdAt", "desc").limit(5).get(),
  ]);
  const rows = [
    ...(online?.edges ?? []).flatMap((e) => (e.node && e.node.shopper?.id === me.id ? [{ at: +new Date(e.node.createdAt), msg: orderText(e.node) }] : [])),
    ...store.docs.map((d) => d.data()).filter((o) => SHOWN_POS.includes(o.status)).map((o) => ({ at: o.createdAt?.toMillis?.() ?? 0, msg: storeText(o) })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 4);
  if (!rows.length) return [text("目前查不到您的訂單 🙏\n如果是剛下的單，請過幾分鐘再試，或直接傳訂單編號給我們。")];
  return [text(rows.map((r) => r.msg).join("\n\n") + (online ? "" : "\n\n（官網訂單暫時連不上，只列出門市消費）") + tail)];
}

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
      return replyJoin(uid, t, "查不到這支手機的會員 🙏 要現在加入嗎？");
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
  const on = orderNumberIn(t);
  if (on || ORDER_ASK.test(t)) return replyOrders(uid, on).catch((e) => (logger.warn("order lookup", errMsg(e)), [text("訂單系統暫時連不上 🙏 請稍後再試，或直接留言，客服會回覆您。")]));
  if (/會員卡|會員/.test(t)) return replyCard(uid);
  if (/消費|紀錄|購物金|點數/.test(t)) return replyHistory(uid);
  // 「想找這件褲子」「這件外套有嗎」：剛傳過圖 → 用圖找指定那件
  if (/這件|這條|這個|這套|圖|照片|同款|一樣/.test(t)) {
    const imgId = await recentImage(uid);
    if (imgId) return replyAiImage(uid, imgId, focusOf(t));
  }
  if (/^(我)?(想|要)?(找|搜尋|搜)/.test(t) || /有沒有.+(褲|袖|衣|外套|包|裙)|適合|推薦.+(褲|袖|衣|外套)/.test(t)) return replyAiText(uid, t);
  if (/喜好|偏好|我的風格/.test(t)) return replyPrefs(uid);
  if (/推薦|喜歡|適合我/.test(t)) return replyForYou(uid);
  if (/新品|新貨|上新/.test(t)) return replyNew();
  if (/特價|特惠|出清|sale/i.test(t)) return replyNew(true);
  if (/客服|真人|聯絡/.test(t)) return [text("收到了！客服會盡快回覆您 🙏\n可以先告訴我們：想問的商品（或截圖）、身高體重，或訂單編號。")];
  if (/活動|優惠|折扣/.test(t)) return replyPromo();
  if (/門市|地址|營業|電話|地圖|在哪/.test(t)) return replyStore();
  // 沒有指令但像在說商品（例：丹寧、寬褲、格紋襯衫）→ 幫他找；找不到就安靜，留給店家
  if (looksLikeProduct(t)) return replyAiText(uid, t, true);
  return null; // 其他訊息交給店家在 LINE 後台手動回覆
}

/** 機器人會回的關鍵字（跟 handleText 的判斷一致） */
const BOT_KEYWORDS = /這件|這條|同款|會員卡|會員|消費|紀錄|購物金|點數|推薦|喜歡|適合我|喜好|偏好|我的風格|新品|新貨|上新|特價|特惠|出清|sale|活動|優惠|折扣|門市|地址|營業|電話|地圖|在哪|客服|真人|聯絡|^(我)?(想|要)?(找|搜尋|搜)|有沒有.+(褲|袖|衣|外套|包|裙)/i;

async function handleEvent(e: { type: string; replyToken?: string; source?: { userId?: string }; postback?: { data?: string }; message?: { type: string; text?: string; id?: string } }) {
  const uid = e.source?.userId;
  if (!uid || !e.replyToken) return;
  let out: Msg[] | null = null;
  // 聊天室顯示「…」輸入中動畫（回覆送到就自動消失；不算訊息則數）。AI 找商品（圖片、找…）比較久，給長一點
  // 只有確定會回覆時才顯示（不然客人看到「…」卻沒下文，像當掉）
  if (e.type === "postback" || e.type === "message") {
    const txt = (e.message?.text ?? "").trim();
    const willReply =
      e.type === "postback" ||
      e.message?.type === "image" ||
      (e.message?.type === "text" && (BOT_KEYWORDS.test(txt) || !!orderNumberIn(txt) || ORDER_ASK.test(txt) || looksLikeProduct(txt) || (await db.doc(`lineSessions/${uid}`).get()).exists));
    const slow = e.message?.type === "image" || /^(我)?(想|要)?(找|搜)|有沒有|適合|推薦|喜歡/.test(txt) || looksLikeProduct(txt) || /a=(foryou|history|new|sale)/.test(e.postback?.data ?? "");
    if (willReply) lineApi("/chat/loading/start", { chatId: uid, loadingSeconds: slow ? 30 : 10 }).catch(() => undefined);
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
    out = a === "fb"
      ? (await learnFromQuery(qp.get("q") ?? "", qp.get("p") ?? "", uid).catch(() => false))
        ? [text("謝謝！已經記住這件了 🙌 下次有人傳類似的照片，會更快找到。", MENU)]
        : [text("這次的搜尋已經過期了，再傳一次照片就可以 🙏")]
      : a === "fbno"
      ? (await markMiss(qp.get("q") ?? "", uid).catch(() => undefined),
        [
          text("抱歉沒找到 🙏 你可以：\n① 再多看幾件相似的\n② 請店員幫你找（照片會轉給店員）\n③ 拍清楚一點、只拍那一件再傳一次", [
            ["再多看幾件", `a=more&q=${qp.get("q") ?? ""}`],
            ["請店員幫我找", `a=human&q=${qp.get("q") ?? ""}`],
          ]),
        ])
      : a === "more"
      ? await (async () => {
          const ids = await nextPage(qp.get("q") ?? "", uid);
          if (!ids?.length) return [text("相似的都給你看過了 🙏 要不要請店員幫你找？", [["請店員幫我找", `a=human&q=${qp.get("q") ?? ""}`]])];
          const all = await listedProducts();
          const by = new Map(all.map((p) => [p.productId, p]));
          const pick = ids.map((id) => by.get(id)).filter(Boolean) as P[];
          return [text("再給你幾件相似的 👇", [["都不是", `a=fbno&q=${qp.get("q") ?? ""}`]]), await carousel(withSiblings(pick, all), "更多相似商品", { qid: qp.get("q") ?? "" })];
        })()
      : a === "human"
      ? (await askHuman(qp.get("q") ?? "", uid, (await shopperByLine(uid))?.data().name ?? null).catch(() => false))
        ? [text("好的，已經把照片轉給店員了 🙌 店員會在這個聊天室回覆你（營業時間內會比較快）。", MENU)]
        : [text("這次的搜尋已經過期了，請再傳一次照片 🙏")]
      : a === "join"
      ? await replyJoin(uid)
      : a === "imgfocus" ? await (async () => { const id = await recentImage(uid); return id ? replyAiImage(uid, id, qp.get("f")) : [text("圖片已經過期了，請再傳一次 🙏")]; })() : a === "prefs" || a === "pref" ? await replyPrefs(uid) : a === "foryou" ? await replyForYou(uid) : a === "barcode" ? await replyBarcode(uid) : a === "card" ? await replyCard(uid) : a === "history" ? await replyHistory(uid) : a === "new" ? await replyNew() : a === "sale" ? await replyNew(true) : a === "promo" ? await replyPromo() : a === "store" ? await replyStore() : null;
  } else if (e.type === "message" && e.message?.type === "image" && e.message.id) {
    out = await replyAiImage(uid, e.message.id);
  } else if (e.type === "message" && e.message?.type === "text") {
    out = await handleText(uid, e.message.text ?? "");
  }
  if (out?.length) await reply(e.replyToken, out);
}

/** LINE 平台送事件到這裡（官方帳號後台的 Webhook URL） */
// 以圖搜圖要處理照片＋載入 180 張圖片特徵：256MB 會被系統砍掉（客人收不到回覆）→ 給 1GB
export const lineWebhook = onRequest({ maxInstances: 10, timeoutSeconds: 120, memory: "1GiB" }, async (req, res) => {
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

// ---------- 推播（主動發送，會用掉官方帳號每月額度：一人一則） ----------

/** 對象：notify = 勾了「新品通知／特價活動」或某個種類的人；all = 所有綁定 LINE 的會員 */
async function audience(kind: string): Promise<string[]> {
  const snap = await db.collection("shoppers").where("lineUserId", ">", "").select("lineUserId", "likes").get();
  const ids = snap.docs.filter((d) => kind === "all" || ((d.data().likes ?? []) as string[]).includes(kind)).map((d) => d.data().lineUserId as string);
  return [...new Set(ids)];
}

async function quotaLeft(): Promise<{ limit: number | null; used: number; left: number | null }> {
  const [q, u] = await Promise.all([lineApi("/message/quota", undefined, "GET"), lineApi("/message/quota/consumption", undefined, "GET")]);
  const limit = q.type === "limited" ? (q.value as number) : null;
  const used = (u.totalUsage as number) ?? 0;
  return { limit, used, left: limit == null ? null : Math.max(0, limit - used) };
}

/** 發送前預覽：會發給幾個人、本月還剩多少額度 */
export const linePushPreview = onCall(async (req) => {
  await requireRole(req, "manager");
  const kind = str(req.data?.kind, "對象", { max: 20 });
  const [ids, quota] = await Promise.all([audience(kind), quotaLeft()]);
  return { count: ids.length, ...quota };
});

/** 發送推播：一段文字＋（可選）商品卡片；對象人數超過剩餘額度就不發 */
export const linePushSend = onCall({ timeoutSeconds: 120 }, async (req) => {
  const actor = await requireRole(req, "manager");
  const kind = str(req.data?.kind, "對象", { max: 20 });
  const msg = str(req.data?.text, "訊息", { max: 1000 });
  const productIds: string[] = (Array.isArray(req.data?.productIds) ? (req.data.productIds as unknown[]) : []).map(String).slice(0, 10);
  const ids = await audience(kind);
  assert(ids.length, "沒有符合的對象（要有綁定 LINE、而且勾了這一項）");
  const q = await quotaLeft();
  assert(q.left == null || ids.length <= q.left, `本月推播額度不夠：要發 ${ids.length} 則，只剩 ${q.left} 則`);
  const messages: Msg[] = [text(msg)];
  if (productIds.length) {
    const all = await listedProducts();
    const pick = productIds.map((id) => all.find((p) => p.productId === id)).filter(Boolean) as P[];
    if (pick.length) messages.push(await carousel(withSiblings(pick, all), msg.slice(0, 60)));
  }
  for (let i = 0; i < ids.length; i += 500) await lineApi("/message/multicast", { to: ids.slice(i, i + 500), messages });
  await db.collection("linePushLogs").add({ kind, text: msg, productIds, count: ids.length, by: actor.name, at: FieldValue.serverTimestamp() });
  return { sent: ids.length };
});

/** 推播紀錄 */
export const linePushLogs = onCall(async (req) => {
  await requireRole(req, "manager");
  const s = await db.collection("linePushLogs").orderBy("at", "desc").limit(20).get();
  return { logs: s.docs.map((d) => ({ kind: d.data().kind, text: d.data().text, count: d.data().count, by: d.data().by, at: d.data().at?.toMillis?.() ?? 0 })) };
});

// ---------- 圖文選單編輯（後台自己改：版型、每格功能、圖片） ----------

const W_RM = 2500;
const H_RM = 1686;
/** 版型：每一格的位置（2500×1686） */
const RM_LAYOUTS: Record<string, { x: number; y: number; w: number; h: number }[]> = {
  "4": [
    { x: 0, y: 0, w: 1250, h: 843 },
    { x: 1250, y: 0, w: 1250, h: 843 },
    { x: 0, y: 843, w: 1250, h: 843 },
    { x: 1250, y: 843, w: 1250, h: 843 },
  ],
  "5": [
    { x: 0, y: 0, w: 1250, h: 843 },
    { x: 1250, y: 0, w: 1250, h: 843 },
    { x: 0, y: 843, w: 833, h: 843 },
    { x: 833, y: 843, w: 834, h: 843 },
    { x: 1667, y: 843, w: 833, h: 843 },
  ],
  "6": [
    { x: 0, y: 0, w: 833, h: 843 },
    { x: 833, y: 0, w: 834, h: 843 },
    { x: 1667, y: 0, w: 833, h: 843 },
    { x: 0, y: 843, w: 833, h: 843 },
    { x: 833, y: 843, w: 834, h: 843 },
    { x: 1667, y: 843, w: 833, h: 843 },
  ],
};
const RM_ACTIONS: Record<string, { data?: string; text?: string; label: string }> = {
  card: { data: "a=card", label: "會員卡" },
  new: { data: "a=new", label: "最新商品" },
  sale: { data: "a=sale", label: "限時特惠" },
  promo: { data: "a=promo", label: "本月活動" },
  store: { data: "a=store", label: "門市資訊" },
  foryou: { data: "a=foryou", label: "為你推薦" },
  prefs: { data: "a=prefs", label: "我的喜好" },
  service: { text: "我想聯絡客服", label: "一對一客服" },
  url: { label: "網址" },
  ig: { label: "追蹤 IG" },
};

/** 選單編輯器要畫商品照片：圖片伺服器不給瀏覽器直接讀，由這裡代抓（只限本店的圖） */
export const richMenuPhoto = onCall(async (req) => {
  await requireRole(req, "owner");
  const url = str(req.data?.url, "圖片", { max: 600 });
  assert(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/ganbaru29\./.test(url), "只能用本店的商品圖片");
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const jpg = await sharp(buf).rotate().resize({ width: 1250, height: 1250, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  return { dataUrl: `data:image/jpeg;base64,${jpg.toString("base64")}` };
});

/** 套用新選單：建立 → 上傳圖片 → 設成預設 → 確認成功才刪舊的 */
export const applyRichMenu = onCall({ timeoutSeconds: 120, memory: "512MiB" }, async (req) => {
  await requireRole(req, "owner");
  const layout = String(req.data?.layout ?? "");
  const boxes = RM_LAYOUTS[layout];
  assert(boxes, "版型不正確");
  const cells = (Array.isArray(req.data?.cells) ? req.data.cells : []) as { action?: string; url?: string; label?: string }[];
  assert(cells.length === boxes.length, "每一格都要設定功能");
  const areas = boxes.map((b, i) => {
    const c = cells[i];
    const a = RM_ACTIONS[String(c.action)];
    assert(a, `第 ${i + 1} 格的功能不正確`);
    let action: Record<string, string>;
    if (c.action === "url" || c.action === "ig") {
      const u = String(c.url ?? "").trim();
      assert(/^https?:\/\/\S+$/.test(u), `第 ${i + 1} 格的網址不正確`);
      assert(c.action !== "ig" || /instagram\.com\//i.test(u), `第 ${i + 1} 格請填 Instagram 網址（https://www.instagram.com/帳號）`);
      action = { type: "uri", uri: u };
    } else if (a.text) action = { type: "message", text: a.text };
    else action = { type: "postback", data: a.data!, displayText: (c.label || a.label).slice(0, 20) };
    return { bounds: { x: b.x, y: b.y, width: b.w, height: b.h }, action };
  });
  const raw = String(req.data?.image ?? "").replace(/^data:image\/\w+;base64,/, "");
  assert(raw.length > 1000, "請提供選單圖片");
  // 不管上傳什麼尺寸都裁成 2500×1686，JPEG 壓在 1MB 內（LINE 規定）
  let q = 88;
  let img = await sharp(Buffer.from(raw, "base64")).rotate().resize(W_RM, H_RM, { fit: "cover" }).jpeg({ quality: q }).toBuffer();
  while (img.length > 990_000 && q > 50) img = await sharp(img).jpeg({ quality: (q -= 8) }).toBuffer();
  const st = await shopSettings();
  const old = String(st.lineBot?.richMenuId ?? "");
  const created = await lineApi("/richmenu", { size: { width: W_RM, height: H_RM }, selected: true, name: `29 STUDIO ${layout} 格`, chatBarText: (String(req.data?.chatBarText ?? "") || "29 STUDIO 選單").slice(0, 14), areas });
  const id = created.richMenuId as string;
  const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, { method: "POST", headers: { authorization: `Bearer ${await botToken()}`, "content-type": "image/jpeg" }, body: img });
  if (!up.ok) {
    await lineApi(`/richmenu/${id}`, undefined, "DELETE").catch(() => undefined);
    throw new Error(`圖片上傳到 LINE 失敗：${(await up.text()).slice(0, 120)}`);
  }
  await lineApi(`/user/all/richmenu/${id}`, {});
  const cur = await lineApi("/user/all/richmenu", undefined, "GET").catch(() => ({}));
  assert(cur.richMenuId === id, "新選單沒有設成功，舊選單保留");
  if (old && old !== id) await lineApi(`/richmenu/${old}`, undefined, "DELETE").catch(() => undefined);
  await db.doc("settings/shop").set({ lineBot: { richMenuId: id, richMenuOn: true, richMenuConfig: { layout, cells: cells.map((c) => ({ action: c.action, url: c.url ?? null, label: c.label ?? null })) } } }, { merge: true });
  return { ok: true, id };
});
