import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { onCall } from "firebase-functions/v2/https";
import { getDownloadURL, getStorage } from "firebase-admin/storage";
import ffmpegPath from "ffmpeg-static";
import { requireRole } from "./lib/auth";
import { assert, errMsg, HttpsError, str } from "./lib/util";

const run = promisify(execFile);

/**
 * 結帳音效：上傳的影片或音檔（soundsrc/…）→ 取出聲音、剪成指定片段、轉 mp3（sounds/…）。
 * 影片太大不能當音效，所以一律轉成單聲道 128kbps 的短 mp3，結尾淡出避免「啪」一聲。
 */
export const convertSound = onCall({ timeoutSeconds: 180, memory: "1GiB", maxInstances: 3 }, async (req) => {
  // 健康檢查：只回報轉檔工具在不在（部署後確認用，不需登入、不碰任何資料）
  if (req.data?.ping === true) {
    const ok = !!ffmpegPath && (await fs.stat(ffmpegPath as unknown as string).then(() => true).catch(() => false));
    const version = ok ? (await run(ffmpegPath as unknown as string, ["-version"]).then((r) => r.stdout.split("\n")[0]).catch((e) => `error ${errMsg(e)}`)) : null;
    return { ffmpeg: ok, version };
  }
  await requireRole(req, "manager");
  const src = str(req.data?.path, "檔案", { max: 200 });
  assert(/^soundsrc\/[\w.-]+$/.test(src), "檔案路徑不正確");
  const start = Math.max(0, Math.min(600, Number(req.data?.start) || 0));
  const duration = Math.max(1, Math.min(30, Number(req.data?.duration) || 5));
  assert(ffmpegPath, "伺服器沒有轉檔工具", "failed-precondition");

  const bucket = getStorage().bucket();
  const id = randomUUID();
  const inFile = join(tmpdir(), `${id}-in`);
  const outFile = join(tmpdir(), `${id}.mp3`);
  try {
    await bucket.file(src).download({ destination: inFile });
    const fade = Math.min(0.4, duration / 4);
    try {
      await run(ffmpegPath as unknown as string, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(duration), "-i", inFile, "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", "-af", `afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`, outFile], { timeout: 120_000 });
    } catch (e) {
      throw new HttpsError("failed-precondition", `轉檔失敗：這個檔案可能沒有聲音，或格式不支援（${errMsg(e).slice(-120)}）`);
    }
    const stat = await fs.stat(outFile);
    assert(stat.size > 1000, "轉出來沒有聲音：請確認影片有聲音，或開始秒數沒有超過影片長度");
    const name = `sounds/checkout-${Date.now()}.mp3`;
    const file = bucket.file(name);
    await file.save(await fs.readFile(outFile), { contentType: "audio/mpeg", metadata: { cacheControl: "public, max-age=31536000" } });
    return { url: await getDownloadURL(file), seconds: duration };
  } finally {
    await Promise.all([fs.rm(inFile, { force: true }), fs.rm(outFile, { force: true }), bucket.file(src).delete().catch(() => undefined)]);
  }
});
