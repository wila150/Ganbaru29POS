import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { ordersPage } from "./lib/meepshop";
import { db, errMsg, sleep, Timestamp, TZ } from "./lib/util";

/**
 * 網店訂單在系統存一份（onlineOrders/{id}）：
 * 每 15 分鐘只抓「最近有更新」的（幾筆、幾秒）；每週日完整重抓一次當保險。
 * 凌晨重算會員等級改讀這份，不用每晚把 meepShop 全部訂單重讀一遍（又慢又容易斷線）。
 */

const STATE = "private/onlineOrdersSync";

type Page = Awaited<ReturnType<typeof ordersPage>>;

/** 讀一頁，連線中斷最多重試 3 次 */
async function page(args: Parameters<typeof ordersPage>[0]): Promise<Page> {
  for (let t = 0; ; t++) {
    try {
      return await ordersPage(args);
    } catch (e) {
      if (t >= 3) throw e;
      logger.warn(`online orders page retry ${t + 1}`, errMsg(e));
      await sleep(3000 * (t + 1));
    }
  }
}

function toDoc(o: NonNullable<Page["edges"][number]["node"]>) {
  return {
    orderNumber: o.orderNumber,
    status: o.status,
    shopperId: o.shopper?.id ?? null,
    totalPrice: o.totalPrice ?? 0,
    rewardPointUsed: Math.round(o.rewardPointUsed ?? 0),
    shippingFee: o.shippingFee ?? 0,
    createdAt: Timestamp.fromDate(new Date(o.createdAt)),
    lineItems: (o.lineItems ?? []).map((l) => ({ title: l.title ?? "", quantity: l.quantity ?? 0, unitPrice: l.unitPrice ?? 0, variantId: l.variant?.id ?? null })),
    syncedAt: Timestamp.now(),
  };
}

/** full = 全部重抓；否則只抓上次同步之後有更新的（往前多抓 10 分鐘避免漏） */
export async function syncOnlineOrders(full: boolean, deadline = Date.now() + 480_000) {
  const ref = db.doc(STATE);
  const st = (await ref.get()).data() ?? {};
  const startedAt = new Date();
  // 還沒完整匯入過 → 一律走完整匯入（接著上次停下的地方繼續）
  if (!st.ready) full = true;
  const since: Date | null = full ? null : new Date(st.lastAt.toMillis() - 10 * 60_000);
  const writer = db.bulkWriter();
  let after: string | null = full ? (st.fullCursor ?? null) : null;
  let n = 0;
  let done = false;
  for (let p = 0; p < 1000; p++) {
    if (Date.now() > deadline) break;
    const res = await page({ first: 50, after, query: since ? { updatedAt: { start: since.toISOString() } } : undefined });
    for (const e of res.edges) if (e.node) {
      writer.set(db.doc(`onlineOrders/${e.node.id}`), toDoc(e.node));
      n++;
    }
    if (!res.pageInfo.hasNextPage || !res.pageInfo.endCursor) {
      done = true;
      break;
    }
    after = res.pageInfo.endCursor;
    await sleep(full ? 1000 : 300);
  }
  await writer.close();
  if (full && !done) {
    // 時間到還沒抓完：記下停在哪一頁，下一次接著抓
    await ref.set({ fullCursor: after, ...(st.fullStartedAt ? {} : { fullStartedAt: Timestamp.fromDate(startedAt) }) }, { merge: true });
  } else if (done) {
    // 完整匯入跑完才標記 ready（凌晨重算才會改讀這份）；lastAt 用這次完整匯入開始的時間，之後增量從那裡接
    const from = full ? (st.fullStartedAt?.toDate?.() ?? startedAt) : startedAt;
    await ref.set({ lastAt: Timestamp.fromDate(from), fullCursor: null, fullStartedAt: null, ...(full ? { fullAt: Timestamp.fromDate(startedAt), ready: true } : {}) }, { merge: true });
  }
  logger.info("online orders sync", { full, n, done });
  return { n, done };
}

/** 系統裡的網店訂單是否已經可以用（完整匯入過一次） */
export async function onlineOrdersReady(): Promise<boolean> {
  return !!(await db.doc(STATE).get()).data()?.ready;
}

/** 每週日 04:15 完整重抓一次（也用來第一次匯入） */
export const onlineOrdersWeekly = onSchedule({ schedule: "15 4 * * 0", timeZone: TZ, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  await syncOnlineOrders(true, Date.now() + 500_000);
});
