import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { getStorage, getDownloadURL } from "firebase-admin/storage";
import { requireRole } from "./lib/auth";
import { MProduct, productsPage, shoppersPage } from "./lib/meepshop";
import { Batch, consumeFifo } from "./lib/movements";
import { codeKey, db, errMsg, FieldValue, sleep, Timestamp, TZ } from "./lib/util";
import { reconcileLocations } from "./locations";

const DEFAULT_SITE = "https://www.ganbaru29.com";

// ---------- lock so a manual sync and a scheduled one never overlap ----------

async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const ref = db.doc(`locks/${name}`);
  const got = await db.runTransaction(async (tx) => {
    const l = (await tx.get(ref)).data();
    if (l && l.until.toMillis() > Date.now()) return false;
    tx.set(ref, { until: Timestamp.fromMillis(Date.now() + ttlMs) });
    return true;
  });
  if (!got) return null;
  try {
    return await fn();
  } finally {
    await ref.delete();
  }
}

// ---------- catalog ----------

/** "MM" from a meepShop birthDate (YYYY-MM-DD or YYYY/MM/DD), or null. */
export function birthMonth(b: string | null | undefined): string | null {
  const m = b?.match(/^\d{4}[-/](\d{1,2})/);
  return m ? m[1].padStart(2, "0") : null;
}

export function mobileKey(m: string | null | undefined): string | null {
  if (!m) return null;
  let d = m.replace(/\D/g, "");
  if (d.startsWith("886")) d = "0" + d.slice(3);
  return d || null;
}

function searchText(parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

async function upsertPage(products: MProduct[], seen: Set<string>, full: boolean) {
  const variantRefs = products.flatMap((p) => p.variants.map((v) => db.doc(`variants/${v.id}`)));
  const imgRefs = products.map((p) => db.doc(`productImages/${p.id}`));
  const [vSnaps, imgSnaps] = await Promise.all([variantRefs.length ? db.getAll(...variantRefs) : [], imgRefs.length ? db.getAll(...imgRefs) : []]);
  const existing = new Map(vSnaps.map((s) => [s.id, s.data()]));
  const images = new Map(imgSnaps.map((s) => [s.id, s.data()]));

  const writer = db.bulkWriter();
  writer.onWriteError((err) => err.code !== 6 && err.failedAttempts < 3); // 6 = ALREADY_EXISTS (codes.create)
  let count = 0;

  for (const p of products) {
    const img = images.get(p.id);
    const productUpdated = new Date(p.updatedAt).getTime();
    if (!img) {
      writer.set(db.doc(`productImages/${p.id}`), { url: null, source: "auto", status: "pending", productUpdatedAt: p.updatedAt });
    } else if (img.source === "auto" && (img.status === "missing" ? full : (img.fetchedAt?.toMillis?.() ?? 0) < productUpdated)) {
      writer.update(db.doc(`productImages/${p.id}`), { status: "pending", productUpdatedAt: p.updatedAt });
    }

    p.variants.forEach((v, idx) => {
      seen.add(v.id);
      count++;
      const old = existing.get(v.id);
      const stock = v.stock ?? 0;
      const options = v.selectedOptions.map((o) => o.value).join(" / ");
      const data: Record<string, unknown> = {
        productId: p.id,
        productTitle: p.title ?? "(未命名商品)",
        productStatus: p.status,
        tags: p.tags ?? [],
        options,
        optionList: v.selectedOptions,
        variantIndex: idx,
        sku: v.sku,
        barcode: v.barcode,
        vendorSku: v.vendorSku,
        warehouseNumber: v.warehouseNumber,
        shopCreatedAt: v.createdAt ? Timestamp.fromDate(new Date(v.createdAt)) : null,
        price: v.retailPrice ?? v.listPrice ?? v.suggestedPrice ?? 0,
        listPrice: v.listPrice,
        status: v.status,
        shopStock: stock,
        shopStockAt: FieldValue.serverTimestamp(),
        active: true,
        searchText: searchText([p.title, options, v.sku, v.barcode, v.vendorSku, old?.location, ...(old?.extraCodes ?? [])]),
        syncedAt: FieldValue.serverTimestamp(),
      };
      if (!old?.posCategoryManual) data.posCategory = p.tags?.[0] ?? null;
      if (!old) {
        Object.assign(data, { location: v.warehouseNumber || null, safety: 0, extraCodes: [], batches: [], posSort: 0, imageUrl: img?.url ?? null, imageSource: img?.source ?? null });
      } else if (img?.url && old.imageSource !== "manual" && old.imageUrl !== img.url) {
        data.imageUrl = img.url;
      }
      // Online orders deduct in meepShop without us; assume they took the oldest batches.
      const batches: Batch[] = old?.batches ?? [];
      const inBatches = batches.reduce((s, b) => s + b.qty, 0);
      if (inBatches > stock) data.batches = consumeFifo(batches, inBatches - Math.max(0, stock));

      writer.set(db.doc(`variants/${v.id}`), data, { merge: true });
      for (const [code, source] of [
        [v.barcode, "meepshop-barcode"],
        [v.sku, "meepshop-sku"],
      ] as const) {
        if (code && code.trim()) writer.create(db.doc(`codes/${codeKey(code)}`), { code: code.trim(), variantId: v.id, source, at: FieldValue.serverTimestamp() }).catch(() => undefined);
      }
    });
  }
  await writer.close();
  return count;
}

export async function runCatalogSync(mode: "full" | "incremental", trigger: string) {
  const res = await withLock("catalog", 9 * 60_000, async () => {
    const logRef = db.collection("syncLogs").doc();
    const startedAt = new Date();
    await logRef.set({ kind: `catalog-${mode}`, trigger, startedAt, status: "running", count: 0, errors: [] });
    const settingsRef = db.doc("settings/shop");
    const settings = (await settingsRef.get()).data() ?? {};
    const sinceTs: Timestamp | undefined = settings.lastIncrementalSyncAt ?? settings.lastCatalogSyncAt;
    const since = mode === "incremental" && sinceTs ? new Date(sinceTs.toMillis() - 2 * 60_000) : undefined;
    const full = mode === "full" || !since;
    const seen = new Set<string>();
    let count = 0;
    const errors: string[] = [];
    try {
      let after: string | null = null;
      for (;;) {
        const page = await productsPage(after, full ? undefined : since);
        const products = page.edges.flatMap((e) => (e.node ? [e.node] : []));
        count += await upsertPage(products, seen, full);
        await logRef.update({ count });
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
        after = page.pageInfo.endCursor;
        await sleep(2000);
      }
      if (full) {
        const active = await db.collection("variants").where("active", "==", true).select().get();
        const writer = db.bulkWriter();
        active.docs.filter((d) => !seen.has(d.id)).forEach((d) => writer.update(d.ref, { active: false }));
        await writer.close();
      }
      await settingsRef.set(full ? { lastCatalogSyncAt: Timestamp.fromDate(startedAt), lastIncrementalSyncAt: Timestamp.fromDate(startedAt) } : { lastIncrementalSyncAt: Timestamp.fromDate(startedAt) }, { merge: true });
    } catch (e) {
      errors.push(errMsg(e));
      logger.error("catalog sync failed", e);
    }
    await logRef.update({ status: errors.length ? "failed" : "done", count, errors, finishedAt: new Date() });
    return { count, errors };
  });
  return res ?? { count: 0, errors: ["另一個同步正在進行中"], skipped: true };
}

// ---------- product images (og:image from the shop's own product page) ----------

async function fetchOgImage(site: string, productId: string): Promise<{ buf: Buffer; type: string } | null> {
  const page = await fetch(`${site}/products/${productId}`, { headers: { "user-agent": "ganbaru29-pos/1.0 (+image sync)" }, redirect: "follow" });
  if (!page.ok) throw new Error(`商品頁 HTTP ${page.status}`);
  const html = await page.text();
  const m = html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i);
  const content = m?.[0].match(/content=["']([^"']+)["']/i)?.[1];
  if (!content) return null;
  const imgUrl = new URL(content.replace(/&amp;/g, "&"), site).toString();
  const img = await fetch(imgUrl);
  if (!img.ok) throw new Error(`圖片 HTTP ${img.status}`);
  const type = img.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) throw new Error(`不是圖片：${type}`);
  return { buf: Buffer.from(await img.arrayBuffer()), type };
}

/** Process pending images until the deadline, one request per second to be gentle on the shop site. */
export async function processPendingImages(deadline: number) {
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  const site = (settings.siteBaseUrl || DEFAULT_SITE).replace(/\/$/, "");
  const bucket = getStorage().bucket();
  let done = 0;
  while (Date.now() < deadline - 15_000) {
    const pending = await db.collection("productImages").where("status", "==", "pending").limit(20).get();
    if (pending.empty) break;
    for (const doc of pending.docs) {
      if (Date.now() >= deadline - 15_000) break;
      const productId = doc.id;
      try {
        const got = await fetchOgImage(site, productId);
        if (!got) throw new Error("商品頁沒有 og:image（可能未上架）");
        const ext = got.type.includes("png") ? "png" : got.type.includes("webp") ? "webp" : "jpg";
        const file = bucket.file(`products/${productId}.${ext}`);
        await file.save(got.buf, { contentType: got.type, resumable: false, metadata: { cacheControl: "public, max-age=86400" } });
        const url = await getDownloadURL(file);
        await doc.ref.update({ url, status: "ok", source: "auto", fetchedAt: FieldValue.serverTimestamp(), error: null });
        const vs = await db.collection("variants").where("productId", "==", productId).get();
        const batch = db.batch();
        vs.docs.filter((v) => v.data().imageSource !== "manual").forEach((v) => batch.update(v.ref, { imageUrl: url, imageSource: "auto" }));
        await batch.commit();
        done++;
      } catch (e) {
        await doc.ref.update({ status: "missing", error: errMsg(e), fetchedAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1) });
      }
      await sleep(1000);
    }
  }
  return done;
}

// ---------- shoppers (cached so the POS can look members up by phone) ----------

export async function runShopperSync(mode: "full" | "incremental") {
  return withLock("shoppers", 9 * 60_000, async () => {
    const settingsRef = db.doc("settings/shop");
    const settings = (await settingsRef.get()).data() ?? {};
    const startedAt = new Date();
    const since = mode === "incremental" && settings.lastShopperSyncAt ? new Date(settings.lastShopperSyncAt.toMillis() - 2 * 60_000) : undefined;
    let after: string | null = null;
    let count = 0;
    const groups = new Set<string>(settings.memberGroups ?? []);
    for (;;) {
      const page = await shoppersPage(after, since);
      page.edges.forEach((e) => e.node?.memberGroup?.title && groups.add(e.node.memberGroup.title));
      const writer = db.bulkWriter();
      for (const e of page.edges) {
        const s = e.node;
        if (!s) continue;
        count++;
        writer.set(db.doc(`shoppers/${s.id}`), {
          email: s.email,
          emailLower: s.email.toLowerCase(),
          name: s.name ?? "",
          mobile: s.mobile ?? "",
          mobileKey: mobileKey(s.mobile),
          points: s.usableRewardPoints,
          birthDate: s.birthDate ?? null,
          memberGroup: s.memberGroup?.title ?? null,
          birthMonth: birthMonth(s.birthDate),
          updatedAt: s.updatedAt,
          syncedAt: FieldValue.serverTimestamp(),
        }, { merge: true }); // merge keeps tier / spend computed by memberTiersJob
      }
      await writer.close();
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
      await sleep(2000);
    }
    // meepShop 會員群組清單（促銷、購物金回饋規則選群組用）
    await settingsRef.set({ lastShopperSyncAt: Timestamp.fromDate(startedAt), memberGroups: [...groups].sort() }, { merge: true });
    return count;
  });
}

// ---------- entry points ----------

/** 「立即同步 meepShop 商品」 */
export const syncCatalog = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  await requireRole(req, "manager");
  const deadline = Date.now() + 520_000;
  const r = await runCatalogSync("full", "manual");
  await reconcileLocations();
  const images = await processPendingImages(Math.min(deadline, Date.now() + 120_000));
  return { ...r, images };
});

export const syncShoppersNow = onCall({ timeoutSeconds: 540, maxInstances: 1 }, async (req) => {
  await requireRole(req, "manager");
  return { count: await runShopperSync("full") };
});

/** 每 15 分鐘：只抓新增或改過的商品 + 補抓圖片 */
export const catalogIncremental = onSchedule({ schedule: "every 15 minutes", timeZone: TZ, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  const deadline = Date.now() + 520_000;
  await runCatalogSync("incremental", "schedule");
  try {
    await runShopperSync("incremental");
  } catch (e) {
    logger.warn("shopper sync failed", e);
  }
  await processPendingImages(deadline);
});

/** 每天 04:00：完整同步所有款式、會員 */
export const catalogDaily = onSchedule({ schedule: "0 4 * * *", timeZone: TZ, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  const deadline = Date.now() + 520_000;
  await runCatalogSync("full", "daily");
  await reconcileLocations();
  try {
    await runShopperSync("full");
  } catch (e) {
    logger.warn("shopper sync failed", e);
  }
  await processPendingImages(deadline);
});

// ---------- 商品圖：匯入 meepShop 的 Google 商品 Feed（老闆用瀏覽器下載的 .tsv） ----------

const FEED_IMAGE_HOSTS = ["img.meepshop.com", "storage.googleapis.com"];

/**
 * 官網與 Feed 網址都有 Cloudflare 機器人驗證，系統抓不到；但圖片主機沒有擋。
 * 老闆在瀏覽器下載 Feed（id = 商品 ID、image_link = 主圖），前端解析後把 [商品 ID, 圖片網址] 傳上來，
 * 這裡逐一從圖片主機下載、存進 Storage。手動上傳過的商品不會被覆蓋。
 */
export const importImageFeed = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  await requireRole(req, "manager");
  const rows = (Array.isArray(req.data?.rows) ? req.data.rows : []).slice(0, 3000) as { id: string; image: string }[];
  return importImageRows(rows, req.data?.overwrite === true);
});

/** [商品 ID, 圖片網址] → 從 meepShop 圖片主機下載、存進 Storage。已有圖或手動上傳的略過（overwrite 時官網換圖也會更新）。 */
export async function importImageRows(rows: { id: string; image: string }[], overwrite = false) {
  const bucket = getStorage().bucket();
  const deadline = Date.now() + 500_000;
  let done = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const r of rows) {
    if (Date.now() > deadline) {
      failed.push("時間不足，請再匯入一次以完成剩下的商品");
      break;
    }
    const productId = String(r.id ?? "").trim();
    let url: URL;
    try {
      url = new URL(String(r.image ?? ""));
    } catch {
      skipped++;
      continue;
    }
    if (!/^[\w-]{8,}$/.test(productId) || !FEED_IMAGE_HOSTS.includes(url.hostname)) {
      skipped++;
      continue;
    }
    const imgRef = db.doc(`productImages/${productId}`);
    const cur = (await imgRef.get()).data();
    if (cur?.source === "manual" || (cur?.status === "ok" && cur?.url && (!overwrite || cur?.sourceUrl === url.toString()))) {
      skipped++;
      continue;
    }
    const vs = await db.collection("variants").where("productId", "==", productId).get();
    if (vs.empty) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(url.toString(), { headers: { "user-agent": "ganbaru29-pos/1.0 (+image sync)" } });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.startsWith("image/")) throw new Error(`圖片 HTTP ${res.status} ${type}`);
      const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
      const file = bucket.file(`products/${productId}.${ext}`);
      await file.save(Buffer.from(await res.arrayBuffer()), { contentType: type, resumable: false, metadata: { cacheControl: "public, max-age=86400" } });
      const stored = await getDownloadURL(file);
      await imgRef.set({ url: stored, status: "ok", source: "feed", sourceUrl: url.toString(), fetchedAt: FieldValue.serverTimestamp(), error: null }, { merge: true });
      const batch = db.batch();
      vs.docs.filter((v) => v.data().imageSource !== "manual").forEach((v) => batch.update(v.ref, { imageUrl: stored, imageSource: "feed" }));
      await batch.commit();
      done++;
    } catch (e) {
      failed.push(`${productId}：${errMsg(e)}`);
    }
    await sleep(200);
  }
  return { done, skipped, failed: failed.slice(0, 20), failedCount: failed.length };
}
