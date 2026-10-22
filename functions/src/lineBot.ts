import { createHmac, timingSafeEqual } from "crypto";
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
const CARD_BASE = "https://ganbaru29.web.app/card";

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
        header: { type: "box", layout: "vertical", backgroundColor: "#1f2937", contents: [{ type: "text", text: "ganbaru29 會員卡", color: "#ffffff", weight: "bold", size: "lg" }, { type: "text", text: group, color: "#d1d5db", size: "sm" }] },
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
            { type: "button", style: "primary", color: "#059669", action: { type: "uri", label: "顯示會員條碼（結帳用）", uri: `${CARD_BASE}/${x.cardToken}` } },
            { type: "button", style: "secondary", action: { type: "postback", label: "消費紀錄", data: "a=history", displayText: "消費紀錄" } },
          ],
        },
      },
    },
  ];
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

async function replyNew(): Promise<Msg[]> {
  const st = await shopSettings();
  const site = (st.siteBaseUrl || DEFAULT_SITE).replace(/\/$/, "");
  const vs = await db.collection("variants").where("active", "==", true).where("productStatus", "==", "LISTED").select("productId", "productTitle", "price", "listPrice", "imageUrl", "shopCreatedAt").get();
  const byProduct = new Map<string, FirebaseFirestore.DocumentData>();
  for (const d of vs.docs) {
    const v = d.data();
    const cur = byProduct.get(v.productId);
    if (!cur || (!cur.imageUrl && v.imageUrl)) byProduct.set(v.productId, v);
  }
  const list = [...byProduct.values()]
    .filter((v) => v.imageUrl?.startsWith("https://"))
    .sort((a, b) => (b.shopCreatedAt?.toMillis?.() ?? 0) - (a.shopCreatedAt?.toMillis?.() ?? 0))
    .slice(0, 10);
  if (!list.length) return [text("新品整理中，請到官網看看！", MENU)];
  return [
    {
      type: "flex",
      altText: "ganbaru29 新品",
      contents: {
        type: "carousel",
        contents: list.map((v) => ({
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
          footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#1f2937", height: "sm", action: { type: "uri", label: "看商品", uri: `${site}/products/${v.productId}` } }] },
        })),
      },
    },
  ];
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
  const out: Msg[] = [];
  if (info.lat && info.lng && info.address) out.push({ type: "location", title: st.shopName || "ganbaru29", address: info.address, latitude: Number(info.lat), longitude: Number(info.lng) });
  const map = info.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(info.address)}` : "";
  out.push(
    text(
      [`📍 ${st.shopName || "ganbaru29"} 門市`, info.address && `地址：${info.address}`, info.hours && `營業時間：${info.hours}`, info.phone && `電話：${info.phone}`, map && `地圖：${map}`].filter(Boolean).join("\n") ||
        "門市資訊整理中",
      MENU
    )
  );
  return out;
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
  if (/新品|新貨|上新/.test(t)) return replyNew();
  if (/活動|優惠|折扣/.test(t)) return replyPromo();
  if (/門市|地址|營業|電話|地圖|在哪/.test(t)) return replyStore();
  return null; // 其他訊息交給店家在 LINE 後台手動回覆
}

async function handleEvent(e: { type: string; replyToken?: string; source?: { userId?: string }; postback?: { data?: string }; message?: { type: string; text?: string } }) {
  const uid = e.source?.userId;
  if (!uid || !e.replyToken) return;
  let out: Msg[] | null = null;
  if (e.type === "follow") {
    const st = await shopSettings();
    out = [text(`歡迎加入 ${st.shopName || "ganbaru29"}！👋\n點下方選單可以看會員卡、消費紀錄、新品和本月活動。\n第一次使用請先點「會員卡」綁定會員。`, MENU)];
    await db.doc(`lineFollowers/${uid}`).set({ followedAt: FieldValue.serverTimestamp(), blocked: false }, { merge: true });
  } else if (e.type === "unfollow") {
    await db.doc(`lineFollowers/${uid}`).set({ blocked: true, unfollowedAt: FieldValue.serverTimestamp() }, { merge: true });
    return;
  } else if (e.type === "postback") {
    const a = new URLSearchParams(e.postback?.data ?? "").get("a");
    out = a === "card" ? await replyCard(uid) : a === "history" ? await replyHistory(uid) : a === "new" ? await replyNew() : a === "promo" ? await replyPromo() : a === "store" ? await replyStore() : null;
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
