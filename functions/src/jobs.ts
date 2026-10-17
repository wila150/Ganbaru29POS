import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { atLeast, requireRole } from "./lib/auth";
import { notifyOwner } from "./lib/line";
import { ordersPage } from "./lib/meepshop";
import { pushMovement } from "./lib/movements";
import { db, int, sleep, taipeiDate, Timestamp, TZ } from "./lib/util";

const STALE_PROCESSING_MS = 5 * 60_000;

/** 每 5 分鐘：重送 failed（可重試）的異動；卡在 processing 太久的標為 unknown */
export const retryFailed = onSchedule({ schedule: "every 5 minutes", timeZone: TZ, timeoutSeconds: 300, maxInstances: 1 }, async () => {
  const due = await db.collection("movements").where("status", "==", "failed").where("retryable", "==", true).where("nextRetryAt", "<=", Timestamp.now()).limit(100).get();
  for (const d of due.docs) await pushMovement(d.id);

  const stale = await db.collection("movements").where("status", "==", "processing").where("processingAt", "<=", Timestamp.fromMillis(Date.now() - STALE_PROCESSING_MS)).limit(100).get();
  for (const d of stale.docs) {
    await d.ref.update({ status: "unknown", retryable: false, error: "同步途中中斷，不確定 meepShop 是否已套用" });
  }
  if (stale.size) await notifyOwner(`【ganbaru29】有 ${stale.size} 筆庫存同步中斷、結果不明，請到「異動紀錄 → 待確認」處理。`);
  logger.info(`retryFailed: retried ${due.size}, stale ${stale.size}`);
});

/**
 * 每天 9:00：算近 30 天門市銷量、建議補貨量，低於安全庫存 / 快到期的商品用 LINE 推播給老闆。
 * 建議補貨量 = 安全庫存 + 日均銷量 × 補貨到貨天數 − 目前庫存
 */
export const lowStockAlert = onSchedule({ schedule: "0 9 * * *", timeZone: TZ, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  const leadDays = Number(settings.leadDays ?? 7);
  const expiryDays = Number(settings.expiryDays ?? 30);
  const since = Timestamp.fromMillis(Date.now() - 30 * 86400_000);

  const sold = new Map<string, number>();
  const moves = await db.collection("movements").where("at", ">=", since).where("type", "in", ["sale", "refund"]).select("variantId", "delta", "status").get();
  for (const m of moves.docs) {
    const d = m.data();
    if (d.status === "canceled") continue;
    sold.set(d.variantId, (sold.get(d.variantId) ?? 0) - d.delta);
  }

  const variants = await db.collection("variants").where("active", "==", true).get();
  const today = taipeiDate();
  const expiryLimit = taipeiDate(new Date(Date.now() + expiryDays * 86400_000));
  const low: string[] = [];
  const expiring: string[] = [];
  const writer = db.bulkWriter();
  for (const v of variants.docs) {
    const d = v.data();
    const sales30 = Math.max(0, sold.get(v.id) ?? 0);
    const stock = d.shopStock ?? 0;
    const reorderQty = Math.max(0, Math.ceil((d.safety ?? 0) + (sales30 / 30) * leadDays - stock));
    if (d.sales30 !== sales30 || d.reorderQty !== reorderQty) writer.update(v.ref, { sales30, reorderQty });
    const name = `${d.productTitle}${d.options ? " " + d.options : ""}`;
    if ((d.safety ?? 0) > 0 && stock <= d.safety) low.push(`・${name}：剩 ${stock}（安全 ${d.safety}，建議補 ${reorderQty}）`);
    for (const b of d.batches ?? []) {
      if (b.exp && b.exp <= expiryLimit) expiring.push(`・${name} 批號 ${b.lot ?? "-"}：${b.exp}${b.exp < today ? "（已過期）" : ""}，${b.qty} 件`);
    }
  }
  await writer.close();

  const [failed, unknown] = await Promise.all([
    db.collection("movements").where("status", "==", "failed").count().get(),
    db.collection("movements").where("status", "==", "unknown").count().get(),
  ]);
  const parts = [`【ganbaru29】${today} 庫存提醒`];
  if (low.length) parts.push(`\n低於安全庫存（${low.length}）\n${low.slice(0, 40).join("\n")}${low.length > 40 ? "\n…其餘請看系統" : ""}`);
  if (expiring.length) parts.push(`\n${expiryDays} 天內到期（${expiring.length}）\n${expiring.slice(0, 30).join("\n")}`);
  const f = failed.data().count;
  const u = unknown.data().count;
  if (f || u) parts.push(`\n同步失敗 ${f} 筆、待確認 ${u} 筆`);
  if (parts.length > 1) await notifyOwner(parts.join("\n"));
});

/**
 * 報表：近 N 天門市 + 網店銷量。老闆拿到含成本的版本；店長拿到的版本沒有任何成本欄位。
 */
export const salesReport = onCall({ timeoutSeconds: 300, memory: "512MiB", maxInstances: 2 }, async (req) => {
  const actor = await requireRole(req, "manager");
  const withCost = atLeast(actor.role, "owner");
  const days = int(req.data?.days ?? 30, "天數", { min: 1, max: 90 });
  const start = new Date(Date.now() - days * 86400_000);
  const since = Timestamp.fromDate(start);

  const [variantsSnap, costsSnap, movesSnap] = await Promise.all([
    db.collection("variants").where("active", "==", true).get(),
    withCost ? db.collection("costs").get() : Promise.resolve(null),
    db.collection("movements").where("at", ">=", since).select("variantId", "type", "delta", "status").get(),
  ]);
  const cost = new Map<string, number>();
  costsSnap?.forEach((c) => c.data().avgCost != null && cost.set(c.id, c.data().avgCost));
  const info = new Map(variantsSnap.docs.map((v) => [v.id, v.data()]));

  const store = new Map<string, number>();
  let scrapQty = 0;
  let scrapLoss = 0;
  let cogs = 0;
  for (const m of movesSnap.docs) {
    const d = m.data();
    if (d.status === "canceled") continue;
    if (d.type === "sale" || d.type === "refund") {
      store.set(d.variantId, (store.get(d.variantId) ?? 0) - d.delta);
      cogs += -d.delta * (cost.get(d.variantId) ?? 0);
    }
    if (d.type === "scrap") {
      scrapQty += -d.delta;
      scrapLoss += -d.delta * (cost.get(d.variantId) ?? 0);
    }
  }

  // 網店銷量：meepShop 訂單（排除取消）
  const online = new Map<string, { qty: number; title: string }>();
  let onlineOrders = 0;
  let onlineError: string | null = null;
  try {
    let after: string | null = null;
    for (let page = 0; page < 40; page++) {
      const p = await ordersPage({ first: 50, after, query: { createdAt: { start: start.toISOString() } } });
      for (const e of p.edges) {
        const o = e.node;
        if (!o || o.status === "CANCELED") continue;
        onlineOrders++;
        for (const li of o.lineItems ?? []) {
          const key = li.variant?.id ?? `title:${li.title}`;
          const cur = online.get(key) ?? { qty: 0, title: li.title };
          cur.qty += li.quantity;
          online.set(key, cur);
        }
      }
      if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor) break;
      after = p.pageInfo.endCursor;
      await sleep(1000);
    }
  } catch (e) {
    onlineError = (e as Error).message;
  }

  let inventoryValue = 0;
  let outOfStock = 0;
  const reorder: unknown[] = [];
  for (const [id, v] of info) {
    const stock = v.shopStock ?? 0;
    if (stock <= 0) outOfStock++;
    inventoryValue += Math.max(0, stock) * (cost.get(id) ?? 0);
    if ((v.reorderQty ?? 0) > 0) reorder.push({ variantId: id, title: v.productTitle, options: v.options, stock, safety: v.safety ?? 0, reorderQty: v.reorderQty, location: v.location ?? null });
  }

  const keys = new Set([...store.keys(), ...online.keys()]);
  const ranking = [...keys]
    .map((k) => {
      const v = info.get(k);
      return { variantId: k, title: v?.productTitle ?? online.get(k)?.title ?? k, options: v?.options ?? "", store: store.get(k) ?? 0, online: online.get(k)?.qty ?? 0 };
    })
    .map((r) => ({ ...r, total: r.store + r.online }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);

  const result: Record<string, unknown> = {
    days,
    generatedAt: Date.now(),
    variantCount: info.size,
    outOfStock,
    stockoutRate: info.size ? outOfStock / info.size : 0,
    storeQty: [...store.values()].reduce((a, b) => a + b, 0),
    onlineOrders,
    onlineError,
    scrapQty,
    ranking,
    reorder: reorder.sort((a, b) => (b as { reorderQty: number }).reorderQty - (a as { reorderQty: number }).reorderQty).slice(0, 100),
  };
  if (withCost) {
    Object.assign(result, {
      inventoryValue: Math.round(inventoryValue),
      cogs: Math.round(cogs),
      scrapLoss: Math.round(scrapLoss),
      // 周轉率（期間）= 銷貨成本 ÷ 目前庫存總值
      turnover: inventoryValue > 0 ? cogs / inventoryValue : null,
    });
  }
  return result;
});
