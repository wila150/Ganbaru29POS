import { logger } from "firebase-functions";
import { getSecret } from "./secrets";
import { db } from "./util";

/** Push a text message to every LINE user/group id in settings/shop.lineTargets (LINE Messaging API). */
export async function notifyOwner(text: string): Promise<void> {
  try {
    const token = await getSecret("LINE_CHANNEL_TOKEN");
    const targets: string[] = (await db.doc("settings/shop").get()).data()?.lineTargets ?? [];
    if (!token || !targets.length) {
      logger.warn("LINE 推播未設定，略過：", text);
      return;
    }
    const message = text.length > 4900 ? text.slice(0, 4900) + "…" : text;
    await Promise.all(
      targets.map(async (to) => {
        const res = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ to, messages: [{ type: "text", text: message }] }),
        });
        if (!res.ok) logger.error("LINE push failed", to, res.status, await res.text());
      })
    );
  } catch (e) {
    logger.error("LINE push error", e);
  }
}
