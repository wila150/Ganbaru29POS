import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { requireRole } from "./lib/auth";
import { notifyOwner } from "./lib/line";
import { ordersPage, sendRewardPoints } from "./lib/meepshop";
import { db, errMsg, FieldValue, sleep, taipeiDate, Timestamp, TZ } from "./lib/util";
import type { TierDef } from "./pos";

/**
 * 會員等級：近 12 個月消費（門市 POS 淨額 + 網店訂單）達門檻自動升降級。
 * meepShop API 不能改會員等級，所以等級存在本系統的 shoppers/{id}.tier。
 */
export async function recomputeTiers() {
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  const tiers = [...((settings.memberTiers ?? []) as TierDef[])].sort((a, b) => b.minSpend - a.minSpend);
  const since = new Date(Date.now() - 365 * 86400_000);
  const spend = new Map<string, { store: number; online: number }>();
  const add = (id: string, k: "store" | "online", v: number) => {
    const cur = spend.get(id) ?? { store: 0, online: 0 };
    cur[k] += v;
    spend.set(id, cur);
  };

  const pos = await db.collection("posOrders").where("createdAt", ">=", Timestamp.fromDate(since)).select("shopper", "total", "refunds", "status").get();
  for (const d of pos.docs) {
    const o = d.data();
    if (!o.shopper?.id || ["pending", "canceled", "void"].includes(o.status)) continue;
    const refunded = (o.refunds ?? []).reduce((s: number, r: { amount: number }) => s + r.amount, 0);
    add(o.shopper.id, "store", (o.total ?? 0) - refunded);
  }

  let onlineError: string | null = null;
  try {
    let after: string | null = null;
    for (let page = 0; page < 200; page++) {
      const p = await ordersPage({ first: 50, after, query: { createdAt: { start: since.toISOString() } } });
      for (const e of p.edges) {
        const o = e.node;
        if (!o?.shopper?.id || o.status === "CANCELED" || o.status === "RETURN") continue;
        add(o.shopper.id, "online", o.totalPrice);
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

  const writer = db.bulkWriter();
  let updated = 0;
  const seen = new Set<string>();
  for (const [id, s] of spend) {
    seen.add(id);
    const total = Math.round(s.store + s.online);
    const tier = tiers.find((t) => total >= t.minSpend)?.name ?? null;
    writer.set(db.doc(`shoppers/${id}`), { spend12m: total, spendStore12m: Math.round(s.store), spendOnline12m: Math.round(s.online), tier, tierAt: Timestamp.now() }, { merge: true });
    updated++;
  }
  // Members with no purchases in 12 months drop to the base tier.
  const lowest = [...tiers].sort((a, b) => a.minSpend - b.minSpend)[0];
  const baseTier = lowest && lowest.minSpend <= 0 ? lowest.name : null;
  const withTier = await db.collection("shoppers").where("spend12m", ">", 0).select().get();
  for (const d of withTier.docs) if (!seen.has(d.id)) writer.set(d.ref, { spend12m: 0, spendStore12m: 0, spendOnline12m: 0, tier: baseTier, tierAt: Timestamp.now() }, { merge: true });
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
