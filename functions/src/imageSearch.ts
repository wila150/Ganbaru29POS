import { randomBytes, createHash } from "crypto";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import sharp from "sharp";
import { requireRole } from "./lib/auth";
import { getSecret } from "./lib/secrets";
import { db, FieldValue } from "./lib/util";

/**
 * 以圖搜圖：每張商品照片轉成「特徵向量」（NVIDIA 免費 API，多模態 embedding），客人傳的照片也轉一次，比最像的。
 * 會學習：客人按「✓ 就是這件」→ 他那張照片也變成這個商品的參考照片（imgLearned），之後類似的照片更容易找到。
 *
 * 索引放在 Storage 的 ai/image-index.json（不佔 Firestore 讀取），學到的照片放 Firestore imgLearned。
 */

const EMB_URL = "https://integrate.api.nvidia.com/v1/embeddings";
const EMB_MODEL = "nvidia/llama-nemotron-embed-vl-1b-v2";
const INDEX_PATH = "ai/image-index.json";

type Stored = { id: string; pid: string; src: "product" | "extra"; url: string; v: string };
type Vec = { pid: string; src: "product" | "extra" | "learned"; v: Float32Array };

const toB64 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const fromB64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
function normalize(a: number[]): Float32Array {
  const n = Math.hypot(...a) || 1;
  return Float32Array.from(a, (x) => x / n);
}
const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 圖片 → 特徵向量（429 太快時自動等一下再試） */
export async function embedImage(buf: Buffer): Promise<Float32Array | null> {
  const key = await getSecret("AI_NVIDIA");
  if (!key) return null;
  const jpg = await sharp(buf).rotate().resize({ width: 512, height: 512, fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
  for (let t = 0; t < 5; t++) {
    const res = await fetch(EMB_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: EMB_MODEL, input: [`data:image/jpeg;base64,${jpg.toString("base64")}`], input_type: "passage", encoding_format: "float" }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      await sleep(2500 * (t + 1));
      continue;
    }
    if (!res.ok) {
      logger.warn("embed", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const j = (await res.json()) as { data?: { embedding: number[] }[] };
    return j.data?.[0]?.embedding ? normalize(j.data[0].embedding) : null;
  }
  return null;
}

let cache: { at: number; vecs: Vec[] } | null = null;
export const invalidateIndex = () => (cache = null);

async function readStored(): Promise<Stored[]> {
  const f = getStorage().bucket().file(INDEX_PATH);
  const [exists] = await f.exists();
  if (!exists) return [];
  const [buf] = await f.download();
  return JSON.parse(buf.toString("utf8")) as Stored[];
}

/** 載入全部參考照片的特徵（商品照＋店員補的照片＋客人確認過的照片），快取 10 分鐘 */
export async function loadIndex(): Promise<Vec[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.vecs;
  const [stored, learned] = await Promise.all([readStored(), db.collection("imgLearned").get()]);
  const vecs: Vec[] = [
    ...stored.map((s) => ({ pid: s.pid, src: s.src, v: fromB64(s.v) })),
    ...learned.docs.map((d) => ({ pid: d.data().pid as string, src: "learned" as const, v: fromB64(d.data().v as string) })),
  ];
  cache = { at: Date.now(), vecs };
  return vecs;
}

/** 找最像的商品：每個商品取它所有參考照片裡最像的一張分數；可以限定商品範圍（例：只看褲子） */
export async function rankByImage(q: Float32Array, allow?: Set<string>): Promise<{ pid: string; score: number; learned: boolean }[]> {
  const best = new Map<string, { score: number; learned: boolean }>();
  for (const x of await loadIndex()) {
    if (allow && !allow.has(x.pid)) continue;
    const s = dot(q, x.v);
    const cur = best.get(x.pid);
    if (!cur || s > cur.score) best.set(x.pid, { score: s, learned: x.src === "learned" });
  }
  return [...best.entries()].map(([pid, r]) => ({ pid, ...r })).sort((a, b) => b.score - a.score);
}

/** 記住這次查詢（客人之後按「✓ 就是這件」時用） */
/** 記住這次查詢：特徵、排好的商品（給「再多看幾件」用）、縮小的照片（給店員看「客人找不到的照片」） */
export async function saveQuery(uid: string, v: Float32Array, ranked: string[], photo?: Buffer, seen?: string): Promise<string> {
  const qid = randomBytes(6).toString("hex");
  let photoUrl: string | null = null;
  if (photo) {
    const token = randomBytes(12).toString("hex");
    const f = getStorage().bucket().file(`ai/queries/${qid}.jpg`);
    await f.save(await sharp(photo).resize({ width: 480, height: 480, fit: "inside" }).jpeg({ quality: 75 }).toBuffer(), { contentType: "image/jpeg", resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
    photoUrl = `https://firebasestorage.googleapis.com/v0/b/${getStorage().bucket().name}/o/${encodeURIComponent(`ai/queries/${qid}.jpg`)}?alt=media&token=${token}`;
  }
  await db.doc(`aiQueries/${qid}`).set({ uid, v: toB64(v), ranked: ranked.slice(0, 40), shown: ranked.slice(0, 8), page: 1, photoUrl, seen: seen ?? null, at: FieldValue.serverTimestamp() });
  return qid;
}

/** 再多看幾件：同一次查詢的下一批（第 9～16 名…） */
export async function nextPage(qid: string, uid: string): Promise<string[] | null> {
  const ref = db.doc(`aiQueries/${qid}`);
  const q = (await ref.get()).data();
  if (!q || q.uid !== uid) return null;
  const page = (q.page ?? 1) as number;
  const ids = ((q.ranked ?? []) as string[]).slice(page * 8, page * 8 + 8);
  await ref.update({ page: page + 1 });
  return ids;
}

/** 請店員幫我找：列進後台「客人找不到的照片」 */
export async function askHuman(qid: string, uid: string, name: string | null) {
  const ref = db.doc(`aiQueries/${qid}`);
  const q = (await ref.get()).data();
  if (q?.uid !== uid) return false;
  await ref.update({ needHuman: true, customer: name, helpAt: FieldValue.serverTimestamp() });
  return true;
}

/** ✓ 就是這件：把客人那張照片加進這個商品的參考照片 */
export async function learnFromQuery(qid: string, pid: string, uid: string): Promise<boolean> {
  const q = (await db.doc(`aiQueries/${qid}`).get()).data();
  if (!q || q.uid !== uid) return false;
  await db.doc(`imgLearned/${qid}`).set({ pid, v: q.v, uid, at: FieldValue.serverTimestamp() });
  await db.doc(`aiQueries/${qid}`).update({ confirmed: pid, confirmedAt: FieldValue.serverTimestamp() });
  invalidateIndex();
  return true;
}

export async function markMiss(qid: string, uid: string) {
  const ref = db.doc(`aiQueries/${qid}`);
  const q = (await ref.get()).data();
  if (q?.uid === uid) await ref.update({ miss: true, missAt: FieldValue.serverTimestamp() });
}

// ---------- 建立／更新索引 ----------

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** 補上還沒有特徵的照片（上架商品主圖＋商品資訊裡店員上傳的照片）；下架的移除 */
export async function buildIndex(deadline: number) {
  const vs = await db.collection("variants").where("active", "==", true).where("productStatus", "==", "LISTED").select("productId", "imageUrl").get();
  const main = new Map<string, string>();
  for (const d of vs.docs) {
    const v = d.data();
    if (v.imageUrl?.startsWith("https://") && !main.has(v.productId)) main.set(v.productId, v.imageUrl);
  }
  const want: { id: string; pid: string; src: "product" | "extra"; url: string }[] = [...main].map(([pid, url]) => ({ id: `${pid}:${hash(url)}`, pid, src: "product", url }));
  const infos = await db.collection("productInfo").select("extraImages").get();
  for (const d of infos.docs) {
    if (!main.has(d.id)) continue;
    for (const x of (d.data().extraImages ?? []) as { url: string }[]) if (x.url) want.push({ id: `${d.id}:${hash(x.url)}`, pid: d.id, src: "extra", url: x.url });
  }
  const stored = await readStored();
  const keep = new Set(want.map((w) => w.id));
  const out = stored.filter((s) => keep.has(s.id));
  const have = new Set(out.map((s) => s.id));
  let added = 0;
  let failed = 0;
  const save = () => getStorage().bucket().file(INDEX_PATH).save(JSON.stringify(out), { contentType: "application/json", resumable: false });
  for (const w of want) {
    if (have.has(w.id)) continue;
    if (Date.now() > deadline) break;
    try {
      const buf = Buffer.from(await (await fetch(w.url, { signal: AbortSignal.timeout(20_000) })).arrayBuffer());
      const v = await embedImage(buf);
      if (!v) {
        failed++;
        continue;
      }
      out.push({ ...w, v: toB64(v) });
      added++;
      if (added % 20 === 0) await save();
      await sleep(1200); // 免費 API 每分鐘約 40 次
    } catch (e) {
      failed++;
      logger.warn("index image", w.url, e);
    }
  }
  await save();
  invalidateIndex();
  const remaining = want.filter((w) => !out.some((o) => o.id === w.id)).length;
  await db.doc("private/imageIndex").set({ remaining, total: out.length, at: FieldValue.serverTimestamp() });
  logger.info("image index", { total: out.length, added, failed, remaining });
  return { total: out.length, added, failed, remaining, removed: stored.length - (out.length - added) };
}

/**
 * 每 20 分鐘補一批（免費 API 很慢，一次只能做十幾張）；全部做完後只讀 1 筆狀態就結束，
 * 每 20 小時才完整檢查一次有沒有新商品／新照片（避免一直讀資料庫）。
 */
export const imageIndexDaily = onSchedule({ schedule: "every 20 minutes", timeZone: "Asia/Taipei", timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async () => {
  const st = (await db.doc("private/imageIndex").get()).data();
  const at = st?.at?.toMillis?.() ?? 0;
  if (st && st.remaining === 0 && Date.now() - at < 20 * 3600_000) return;
  await buildIndex(Date.now() + 480_000);
});

/** 老闆手動更新（例如剛上傳很多商品照片） */
export const buildImageIndex = onCall({ timeoutSeconds: 540, memory: "512MiB", maxInstances: 1 }, async (req) => {
  await requireRole(req, "owner");
  return buildIndex(Date.now() + 500_000);
});

/** 後台看學習狀況：索引幾張、學到幾張、最近找不到的字 */
export const aiLearnStatus = onCall(async (req) => {
  await requireRole(req, "manager");
  const [stored, learned, misses, confirmed] = await Promise.all([
    readStored(),
    db.collection("imgLearned").count().get(),
    db.collection("aiMisses").orderBy("at", "desc").limit(40).get(),
    db.collection("aiQueries").where("confirmed", ">", "").count().get(),
  ]);
  const help = await db.collection("aiQueries").where("needHuman", "==", true).orderBy("helpAt", "desc").limit(20).get().catch(() => null);
  return {
    indexed: stored.length,
    products: new Set(stored.map((s) => s.pid)).size,
    learned: learned.data().count,
    confirmed: confirmed.data().count,
    misses: misses.docs.map((d) => ({ q: d.data().q as string, kind: d.data().kind as string, at: d.data().at?.toMillis?.() ?? 0 })),
    help: (help?.docs ?? []).map((d) => ({ id: d.id, photoUrl: d.data().photoUrl as string | null, seen: d.data().seen as string | null, customer: d.data().customer as string | null, at: d.data().helpAt?.toMillis?.() ?? 0, done: !!d.data().helpDone })),
  };
});

/** 店員處理完「客人找不到的照片」 */
export const aiHelpDone = onCall(async (req) => {
  await requireRole(req, "staff");
  const id = String(req.data?.id ?? "").replace(/[^0-9a-f]/g, "");
  if (id) await db.doc(`aiQueries/${id}`).update({ helpDone: true, needHuman: false });
  return { ok: true };
});
