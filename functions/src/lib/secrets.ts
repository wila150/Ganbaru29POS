import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

/**
 * Secrets are read at call time (not pinned at deploy) so the owner can rotate the
 * meepShop key from the settings page without a redeploy.
 * The secrets must exist beforehand (see README) — this module only adds versions.
 */
export type SecretName = "MEEPSHOP_API_KEY" | "LINE_CHANNEL_TOKEN" | "ECPAY_PAYMENT" | "ECPAY_INVOICE" | "NEWEBPAY_PAYMENT" | "LINEPAY";

const client = new SecretManagerServiceClient();
const cache = new Map<SecretName, { value: string | null; at: number }>();
const TTL = 5 * 60 * 1000;

function projectId(): string {
  const p = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!p) throw new Error("找不到 GCP 專案 ID");
  return p;
}

export async function getSecret(name: SecretName, fresh = false): Promise<string | null> {
  const hit = cache.get(name);
  // 「沒設定」只記 20 秒：剛在設定頁存好金鑰，其他函式很快就讀得到
  if (!fresh && hit && Date.now() - hit.at < (hit.value === null ? 20_000 : TTL)) return hit.value;
  // Emulator / local dev: allow env override.
  if (process.env.FUNCTIONS_EMULATOR === "true" && process.env[name]) return process.env[name]!;
  let value: string | null = null;
  try {
    const [v] = await client.accessSecretVersion({ name: `projects/${projectId()}/secrets/${name}/versions/latest` });
    value = v.payload?.data?.toString().trim() || null;
  } catch (e: unknown) {
    const code = (e as { code?: number }).code;
    if (code !== 5 && code !== 9) throw e; // 5 NOT_FOUND, 9 FAILED_PRECONDITION (no enabled version)
  }
  cache.set(name, { value, at: Date.now() });
  return value;
}

export async function setSecret(name: SecretName, value: string): Promise<void> {
  const parent = `projects/${projectId()}/secrets/${name}`;
  const [created] = await client.addSecretVersion({ parent, payload: { data: Buffer.from(value, "utf8") } });
  // Disable older versions so a leaked old key stops working from our side.
  const [versions] = await client.listSecretVersions({ parent, filter: "state:ENABLED" });
  await Promise.all(
    versions.filter((v) => v.name !== created.name).map((v) => client.disableSecretVersion({ name: v.name! }))
  );
  cache.set(name, { value, at: Date.now() });
}
