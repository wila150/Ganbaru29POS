import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { requireRole } from "./lib/auth";
import { assert, db, errMsg, FieldValue, TZ } from "./lib/util";
import { importImageRows } from "./sync";

/**
 * 商品圖自動補齊：Google Merchant Center 每天抓 meepShop 的商品 Feed（Google 的機器人可以讀），
 * 系統再用 Merchant API 讀「商品 ID（offerId）＋主圖網址」，從 meepShop 圖片主機下載。
 * 前提：Merchant Center 已把 functions 的服務帳號加為「標準」使用者，settings/shop.merchantId 已設定。
 */

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/content"] });

interface MerchantAttrs {
  imageLink?: string;
  additionalImageLinks?: string[];
  title?: string;
  description?: string;
  link?: string;
}
interface MerchantProduct {
  offerId?: string;
  productAttributes?: MerchantAttrs;
  attributes?: MerchantAttrs;
}

interface MerchantRow {
  id: string;
  image: string;
  images: string[];
  title: string | null;
  description: string | null;
  link: string | null;
}

async function listMerchantImages(merchantId: string): Promise<MerchantRow[]> {
  const client = await auth.getClient();
  const rows: MerchantRow[] = [];
  let pageToken = "";
  for (let page = 0; page < 40; page++) {
    const url = `https://merchantapi.googleapis.com/products/v1/accounts/${merchantId}/products?pageSize=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await client.request<{ products?: MerchantProduct[]; nextPageToken?: string }>({ url }).catch((e: { response?: { data?: { error?: { message?: string } } } }) => {
      throw new Error(e.response?.data?.error?.message ?? errMsg(e));
    });
    for (const p of res.data.products ?? []) {
      const a = p.productAttributes ?? p.attributes ?? {};
      const image = a.imageLink;
      if (p.offerId && image)
        rows.push({ id: p.offerId, image, images: [image, ...(a.additionalImageLinks ?? [])].filter((x, i, arr) => x && arr.indexOf(x) === i).slice(0, 12), title: a.title ?? null, description: a.description ?? null, link: a.link ?? null });
    }
    pageToken = res.data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return rows;
}

async function syncFromMerchant(trigger: string) {
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  const merchantId = String(settings.merchantId ?? "").trim();
  if (!merchantId) return { skipped: "尚未設定 Merchant Center ID" };
  if (!/^\d{6,20}$/.test(merchantId)) throw new Error(`Merchant Center ID 應該只有數字，現在設定的是「${merchantId.slice(0, 12)}…」，請到設定頁改正`);
  try {
    const rows = await listMerchantImages(merchantId);
    // 官網換了主圖時，網址會不同 → 重新下載（手動上傳的不覆蓋）
    const r = await importImageRows(rows.map((x) => ({ id: x.id, image: x.image })), true);
    // 商品資訊（App 內看官網商品用）：說明、所有圖片、官網網址
    const writer = db.bulkWriter();
    for (const x of rows) writer.set(db.doc(`productInfo/${x.id}`), { images: x.images, title: x.title, description: x.description, link: x.link, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await writer.close();
    await db.doc("settings/shop").set({ merchantSync: { at: FieldValue.serverTimestamp(), trigger, products: rows.length, done: r.done, failed: r.failedCount, error: null } }, { merge: true });
    return { products: rows.length, ...r };
  } catch (e) {
    logger.error("merchant image sync", e);
    await db.doc("settings/shop").set({ merchantSync: { at: FieldValue.serverTimestamp(), trigger, error: errMsg(e) } }, { merge: true });
    throw e;
  }
}

/** 每天 08:00（Merchant Center 每天抓 Feed 之後）自動補圖 */
export const merchantImagesDaily = onSchedule({ schedule: "0 8 * * *", timeZone: TZ, timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  await syncFromMerchant("daily");
});

export const syncImagesFromMerchant = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  await requireRole(req, "manager");
  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  assert(settings.merchantId, "請先在「設定」填 Merchant Center ID", "failed-precondition");
  return syncFromMerchant("manual");
});
