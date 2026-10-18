import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { getDownloadURL, getStorage } from "firebase-admin/storage";
import sharp from "sharp";
import { requireRole } from "./lib/auth";
import { db, errMsg } from "./lib/util";

/**
 * 商品縮圖：原圖 720×1080，POS 商品格一次顯示上百張，iPad 解碼後吃掉幾百 MB 記憶體、切換頁面會卡。
 * 這裡把每張商品圖縮成 360px 寬的 webp（thumbs/…），存在 variants.thumbUrl；thumbFor 記下是哪張原圖縮的，
 * 原圖換了（自動抓圖、手動上傳）下次就重做。前端沒有縮圖時直接用原圖。
 */
const THUMB_WIDTH = 360;

/** Firebase Storage 下載網址 → 物件路徑 */
function objectPath(url: string): string | null {
  const m = url.match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function ensureThumbs(deadline: number) {
  const bucket = getStorage().bucket();
  const snap = await db.collection("variants").select("imageUrl", "thumbFor", "productId").get();
  // 同一張原圖只做一次
  const todo = new Map<string, FirebaseFirestore.DocumentReference[]>();
  for (const d of snap.docs) {
    const { imageUrl, thumbFor } = d.data();
    if (!imageUrl || thumbFor === imageUrl) continue;
    (todo.get(imageUrl) ?? todo.set(imageUrl, []).get(imageUrl)!).push(d.ref);
  }
  let done = 0;
  let failed = 0;
  for (const [url, refs] of todo) {
    if (Date.now() > deadline) break;
    try {
      const path = objectPath(url);
      let input: Buffer;
      if (path && url.includes(bucket.name)) [input] = await bucket.file(path).download();
      else input = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(20_000) })).arrayBuffer());
      const out = await sharp(input).rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      const name = `thumbs/${(path ?? refs[0].id).replace(/\.[a-z0-9]+$/i, "")}.webp`;
      const file = bucket.file(name);
      await file.save(out, { contentType: "image/webp", metadata: { cacheControl: "public, max-age=31536000" } });
      const thumbUrl = await getDownloadURL(file);
      const batch = db.batch();
      refs.forEach((r) => batch.update(r, { thumbUrl, thumbFor: url }));
      await batch.commit();
      done++;
    } catch (e) {
      failed++;
      logger.warn(`thumb ${url}`, errMsg(e));
      // 壞圖不要每次重試：標記處理過，前端照用原圖
      const batch = db.batch();
      refs.forEach((r) => batch.update(r, { thumbUrl: null, thumbFor: url }));
      await batch.commit();
    }
  }
  return { done, failed, left: Math.max(0, todo.size - done - failed) };
}

/** 設定頁「產生縮圖」／第一次補齊 */
export const buildThumbs = onCall({ timeoutSeconds: 540, memory: "1GiB", maxInstances: 1 }, async (req) => {
  await requireRole(req, "manager");
  return ensureThumbs(Date.now() + 500_000);
});
