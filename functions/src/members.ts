import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { requireRole } from "./lib/auth";
import { notifyOwner } from "./lib/line";
import { ordersPage, sendRewardPoints } from "./lib/meepshop";
import { db, errMsg, FieldValue, sleep, taipeiDate, Timestamp, TZ } from "./lib/util";
import { normalizeTier, type TierCond, type TierDef } from "./pos";

const MONTH = 30.44 * 86400_000;

/**
 * 會員等級（門市 POS 淨額 + 網店已結案訂單），規則同 meepShop 顧客群組：升級資格、使用期限、續會資格。
 * meepShop API 不能改會員群組，所以等級存在本系統的 shoppers/{id}.tier（tierSince / tierUntil）。
 */
export async function recomputeTiers() {
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  // 設定順序 = 由低到高；第一個沒有升級條件的是基本等級
  const all = ((settings.memberTiers ?? []) as TierDef[]).map(normalizeTier);
  const base = all.find((t) => !t.upgrade?.length) ?? null;
  const ranked = all.filter((t) => t.enabled !== false && t.upgrade?.length);
  const rank = (name: string | null | undefined) => ranked.findIndex((t) => t.name === name);
  const now = Date.now();
  const purchases = new Map<string, { at: number; amount: number }[]>();
  const met = (c: TierCond, list: { at: number; amount: number }[], from: number, to: number) => {
    const inRange = list.filter((p) => p.at >= from && p.at <= to);
    return c.kind === "single" ? inRange.some((p) => p.amount >= c.amount) : inRange.reduce((s, p) => s + p.amount, 0) >= c.amount;
  };
  /**
   * 每位會員：近 12 個月（等級用）＋全部歷史（顧客分眾用：消費次數、首購／最後消費日、累計金額）。
   */
  interface Stat {
    store: number;
    online: number;
    maxSingle: number;
    orders: number;
    total: number;
    first: number;
    last: number;
    orders12m: number;
    orders6m: number;
    orders3m: number;
  }
  const spend = new Map<string, Stat>();
  const add = (id: string, k: "store" | "online", v: number, at: number) => {
    (purchases.get(id) ?? purchases.set(id, []).get(id)!).push({ at, amount: v });
    const cur = spend.get(id) ?? { store: 0, online: 0, maxSingle: 0, orders: 0, total: 0, first: at, last: at, orders12m: 0, orders6m: 0, orders3m: 0 };
    cur.orders++;
    cur.total += v;
    cur.first = Math.min(cur.first, at);
    cur.last = Math.max(cur.last, at);
    const age = now - at;
    if (age <= 365 * 86400_000) {
      cur[k] += v;
      cur.maxSingle = Math.max(cur.maxSingle, v);
      cur.orders12m++;
    }
    if (age <= 183 * 86400_000) cur.orders6m++;
    if (age <= 92 * 86400_000) cur.orders3m++;
    spend.set(id, cur);
  };

  const pos = await db.collection("posOrders").select("shopper", "total", "refunds", "status", "createdAt").get();
  for (const d of pos.docs) {
    const o = d.data();
    if (!o.shopper?.id || ["pending", "canceled", "void", "refunded"].includes(o.status)) continue;
    const refunded = (o.refunds ?? []).reduce((s: number, r: { amount: number }) => s + r.amount, 0);
    add(o.shopper.id, "store", (o.total ?? 0) - refunded, o.createdAt?.toMillis?.() ?? now);
  }

  let onlineError: string | null = null;
  try {
    let after: string | null = null;
    // 全部歷史訂單（顧客分眾需要「首購」「最後消費」）
    for (let page = 0; page < 400; page++) {
      const p = await ordersPage({ first: 50, after });
      for (const e of p.edges) {
        const o = e.node;
        // 與 meepShop 顧客分眾一致：只算「已結案」的網店訂單（處理中、取消、退貨不算消費）
        if (!o?.shopper?.id || o.status !== "CLOSED") continue;
        add(o.shopper.id, "online", o.totalPrice, new Date(o.createdAt).getTime());
      }
      if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor) break;
      after = p.pageInfo.endCursor;
      await sleep(1000);
    }
  } catch (e) {
    onlineError = errMsg(e);
    logger.warn("tier recompute: online orders failed", e);
  }
  if (onlineError) {
    // Without online orders the totals would be too low and demote people — keep yesterday's tiers.
    await db.doc("settings/shop").set({ tiersAt: Timestamp.now(), tiersError: onlineError }, { merge: true });
    return { updated: 0, error: onlineError };
  }

  /** 一位會員的等級：先處理目前等級的到期／續會，再看能不能升到更高等級 */
  const decide = (list: { at: number; amount: number }[], curTier: string | null, curUntil: number | null, curSince: number | null) => {
    let tier: TierDef | null = null;
    let until: number | null = null;
    let since: number | null = curSince;
    const cur = ranked.find((t) => t.name === curTier);
    if (cur) {
      const v = cur.validityMonths ? cur.validityMonths * MONTH : 0;
      if (!v) tier = cur; // 永久
      else {
        let u = curUntil ?? now;
        // 到期：期限內達成續會資格就延一期（可能連續延好幾期）
        while (u <= now && cur.renew?.some((c) => met(c, list, u - v, u))) u += v;
        if (u > now) {
          tier = cur;
          until = u;
        }
      }
    }
    for (let i = ranked.length - 1; i >= 0 && i > rank(tier?.name); i--) {
      const t = ranked[i];
      if (t.upgrade?.some((c) => met(c, list, now - (c.months || 12) * MONTH, now))) {
        tier = t;
        since = now;
        until = t.validityMonths ? now + t.validityMonths * MONTH : null;
        break;
      }
    }
    if (!tier) return { tier: base?.name ?? null, since: null, until: null };
    return { tier: tier.name, since: tier.name === curTier ? curSince ?? now : since, until };
  };

  const shoppers = await db.collection("shoppers").select("tier", "tierUntil", "tierSince").get();
  const writer = db.bulkWriter();
  let updated = 0;
  for (const d of shoppers.docs) {
    const s = spend.get(d.id);
    const cur = d.data();
    const t = decide(purchases.get(d.id) ?? [], cur.tier ?? null, cur.tierUntil?.toMillis?.() ?? null, cur.tierSince?.toMillis?.() ?? null);
    writer.set(
      d.ref,
      {
        spend12m: s ? Math.round(s.store + s.online) : 0,
        spendStore12m: s ? Math.round(s.store) : 0,
        spendOnline12m: s ? Math.round(s.online) : 0,
        maxSingle12m: s ? Math.round(s.maxSingle) : 0,
        tier: t.tier,
        tierSince: t.since ? Timestamp.fromMillis(t.since) : null,
        tierUntil: t.until ? Timestamp.fromMillis(t.until) : null,
        tierAt: Timestamp.now(),
        ordersTotal: s?.orders ?? 0,
        spendTotal: s ? Math.round(s.total) : 0,
        firstOrderAt: s ? Timestamp.fromMillis(s.first) : null,
        lastOrderAt: s ? Timestamp.fromMillis(s.last) : null,
        orders12m: s?.orders12m ?? 0,
        orders6m: s?.orders6m ?? 0,
        orders3m: s?.orders3m ?? 0,
      },
      { merge: true }
    );
    updated++;
  }
  await writer.close();
  await db.doc("settings/shop").set({ tiersAt: Timestamp.now(), tiersError: null }, { merge: true });
  return { updated, error: null };
}

export const memberTiersDaily = onSchedule({ schedule: "30 3 * * *", timeZone: TZ, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  await recomputeTiers();
});

export const recomputeMemberTiers = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  await requireRole(req, "manager");
  return recomputeTiers();
});

/** 生日禮：每月 1 日把購物金送給當月壽星（同一年只送一次）。 */
export async function sendBirthdayGifts() {
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  const points = Math.floor(Number(settings.birthdayGiftPoints ?? 0));
  if (points <= 0) return { sent: 0, failed: 0 };
  const today = taipeiDate();
  const month = today.slice(5, 7);
  const year = today.slice(0, 4);
  const list = await db.collection("shoppers").where("birthMonth", "==", month).get();
  let sent = 0;
  let failed = 0;
  for (const d of list.docs) {
    if (d.data().birthdayGiftYear === year) continue;
    try {
      await sendRewardPoints(d.id, points, `${year} 年生日禮`);
      await d.ref.update({ birthdayGiftYear: year, birthdayGiftAt: FieldValue.serverTimestamp() });
      sent++;
    } catch (e) {
      failed++;
      logger.warn(`birthday gift ${d.id}`, e);
    }
    await sleep(300);
  }
  if (sent || failed) await notifyOwner(`【ganbaru29】${Number(month)} 月生日禮：已送 ${sent} 位會員各 ${points} 點購物金${failed ? `，${failed} 位失敗` : ""}`);
  return { sent, failed };
}

export const birthdayGiftsMonthly = onSchedule({ schedule: "0 8 1 * *", timeZone: TZ, timeoutSeconds: 540, maxInstances: 1 }, async () => {
  await sendBirthdayGifts();
});
