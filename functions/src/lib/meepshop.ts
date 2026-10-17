import { logger } from "firebase-functions";
import { getSecret } from "./secrets";
import { sleep } from "./util";

/**
 * meepShop Open API client.
 * Schema: https://studio.apollographql.com/public/open-api?variant=production
 *
 * Error kinds decide what we do with a stock change:
 *  - "not-sent":  the request never reached meepShop (DNS, refused, 429, missing key) → safe to retry
 *  - "unknown":   it may or may not have been applied (timeout, reset, 5xx) → never auto-retry
 *  - "rejected":  meepShop answered with a UserError / GraphQL error → not applied, retrying won't help
 */
export type MeepErrorKind = "not-sent" | "unknown" | "rejected";

export class MeepError extends Error {
  constructor(public kind: MeepErrorKind, message: string) {
    super(message);
  }
}

const ENDPOINT = "https://open-api.meepshop.com/graphql";
const BUDGET = 5000; // official limit is 6000 points / 60 s; we queue above 5000
const WINDOW_MS = 60_000;
const TIMEOUT_MS = 20_000;

// Per-instance complexity window. Functions that hit meepShop heavily run with low maxInstances.
let windowStart = Date.now();
let windowUsed = 0;

async function reserve(estimate: number) {
  for (;;) {
    const now = Date.now();
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now;
      windowUsed = 0;
    }
    if (windowUsed + estimate <= BUDGET) return;
    const wait = WINDOW_MS - (now - windowStart) + 50;
    logger.info(`meepShop complexity ${windowUsed}/${BUDGET}, waiting ${wait}ms`);
    await sleep(wait);
  }
}

const NOT_SENT_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"]);

export async function gql<T>(query: string, variables: Record<string, unknown> = {}, opts: { key?: string; estimate?: number } = {}): Promise<T> {
  const key = opts.key ?? (await getSecret("MEEPSHOP_API_KEY"));
  if (!key) throw new MeepError("not-sent", "尚未設定 meepShop API 金鑰");
  const estimate = opts.estimate ?? 1;
  await reserve(estimate);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
  } catch (e: unknown) {
    clearTimeout(timer);
    const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
    if (NOT_SENT_CODES.has(code)) throw new MeepError("not-sent", `連不上 meepShop（${code}）`);
    throw new MeepError("unknown", `meepShop 連線中斷，不確定是否已處理（${code || (e as Error).name}）`);
  }

  const score = Number(res.headers.get("x-meepshop-complexity-score"));
  windowUsed += Number.isFinite(score) && score > 0 ? score : estimate;

  let body: { data?: T; errors?: { message: string }[] } | undefined;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new MeepError("not-sent", "meepShop API 金鑰無效或已過期");
  if (res.status === 429) throw new MeepError("not-sent", "meepShop 速度限制，稍後重試");
  if (res.status >= 500 || !body) throw new MeepError("unknown", `meepShop 回應異常（HTTP ${res.status}）`);
  if (body.errors?.length) throw new MeepError("rejected", body.errors.map((e) => e.message).join("; "));
  if (!body.data) throw new MeepError("unknown", "meepShop 沒有回傳資料");
  return body.data;
}

// ---------- Types (subset of the schema we use) ----------

export interface MVariant {
  id: string;
  sku: string | null;
  barcode: string | null;
  vendorSku: string | null;
  warehouseNumber: string | null;
  stock: number | null;
  status: "LISTED" | "NOT_LISTED";
  retailPrice: number | null;
  listPrice: number | null;
  suggestedPrice: number | null;
  selectedOptions: { name: string; value: string }[];
  createdAt: string;
}

export interface MProduct {
  id: string;
  title: string | null;
  status: "LISTED" | "NOT_LISTED";
  tags: string[] | null;
  updatedAt: string;
  variants: MVariant[];
}

export interface MShopper {
  id: string;
  email: string;
  name: string | null;
  mobile: string | null;
  usableRewardPoints: number;
  birthDate: string | null;
  updatedAt: string;
}

export interface MOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  shipmentStatus: string;
  totalPrice: number;
  createdAt: string;
  shopper: { id: string; name: string | null; email: string } | null;
  shipmentDetail: { name: string; phone: string | null; receiverName: string | null; carrier: string | null; note: string | null };
  paymentDetail: { name: string };
  lineItems: { id: string; title: string; quantity: number; unitPrice: number; totalPrice: number; variant: { id: string } | null }[] | null;
}

interface Connection<T> {
  edges: { node: T | null }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  total: number;
}

const VARIANT_FIELDS = `id createdAt sku barcode vendorSku warehouseNumber stock status retailPrice listPrice suggestedPrice selectedOptions { name value }`;

// ---------- Stock ----------

export async function adjustStock(variantId: string, delta: number): Promise<number> {
  const data = await gql<{ adjustStockQuantity: { __typename: string; currentStock?: number; message?: string } }>(
    `mutation Adjust($input: AdjustStockQuantityInput!) {
      adjustStockQuantity(input: $input) {
        __typename
        ... on VariantCurrentStock { variantId currentStock }
        ... on UserError { message }
      }
    }`,
    { input: { variantId, availableDelta: delta } }
  );
  const r = data.adjustStockQuantity;
  if (r.__typename === "UserError") throw new MeepError("rejected", r.message || "meepShop 拒絕這次調整");
  return r.currentStock!;
}

export async function bulkAdjustStock(items: { variantId: string; availableDelta: number }[]): Promise<{ stocks: Map<string, number>; errors: string[] }> {
  const data = await gql<{ bulkAdjustStockQuantity: { variantCurrentStocks: { variantId: string; currentStock: number }[]; userErrors: { message: string | null }[] } }>(
    `mutation Bulk($input: [AdjustStockQuantityInput!]!) {
      bulkAdjustStockQuantity(input: $input) {
        variantCurrentStocks { variantId currentStock }
        userErrors { message }
      }
    }`,
    { input: items },
    { estimate: items.length }
  );
  const r = data.bulkAdjustStockQuantity;
  return {
    stocks: new Map(r.variantCurrentStocks.map((s) => [s.variantId, s.currentStock])),
    errors: r.userErrors.map((e) => e.message || "未知錯誤"),
  };
}

// ---------- Catalog ----------

export async function productsPage(after: string | null, updatedSince?: Date, first = 50) {
  const data = await gql<{ products: Connection<MProduct> }>(
    `query Products($first: PositiveInt!, $after: String, $query: ProductQueryTermsInput) {
      products(first: $first, after: $after, query: $query) {
        total
        pageInfo { hasNextPage endCursor }
        edges { node { id title status tags updatedAt variants { ${VARIANT_FIELDS} } } }
      }
    }`,
    { first, after, query: updatedSince ? { updatedAt: { start: updatedSince.toISOString() } } : null },
    { estimate: 150 }
  );
  return data.products;
}

export async function variantStocks(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const data = await gql<{ variants: Connection<{ id: string; stock: number | null }> }>(
    `query Stocks($first: PositiveInt!, $query: VariantQueryTermsInput) {
      variants(first: $first, query: $query) { edges { node { id stock } } }
    }`,
    { first: ids.length, query: { id: ids } },
    { estimate: 150 }
  );
  for (const e of data.variants.edges) if (e.node) out.set(e.node.id, e.node.stock ?? 0);
  return out;
}

export async function getVariant(id: string) {
  const data = await gql<{ variant: (MVariant & { product: { id: string; title: string | null } }) | null }>(
    `query V($id: ID!) { variant(id: $id) { ${VARIANT_FIELDS} product { id title } } }`,
    { id },
    { estimate: 5 }
  );
  return data.variant;
}

// ---------- Orders ----------

const ORDER_FIELDS = `id orderNumber status paymentStatus shipmentStatus totalPrice createdAt
  shopper { id name email }
  shipmentDetail { name phone receiverName carrier note }
  paymentDetail { name }
  lineItems { id title quantity unitPrice totalPrice variant { id } }`;

export async function ordersPage(args: { first?: number; after?: string | null; query?: Record<string, unknown> }) {
  const data = await gql<{ orders: Connection<MOrder> }>(
    `query Orders($first: PositiveInt!, $after: String, $query: OrderQueryTermsInput) {
      orders(first: $first, after: $after, query: $query) {
        total
        pageInfo { hasNextPage endCursor }
        edges { node { ${ORDER_FIELDS} } }
      }
    }`,
    { first: args.first ?? 50, after: args.after ?? null, query: args.query ?? null },
    { estimate: 150 }
  );
  return data.orders;
}

export async function updateOrderShipmentStatus(orderNumber: string, shipmentStatus: string) {
  const data = await gql<{ updateOrderShipmentStatus: { __typename: string; message?: string } }>(
    `mutation Ship($input: UpdateOrderShipmentStatusInput!) {
      updateOrderShipmentStatus(input: $input) { __typename ... on UserError { message } }
    }`,
    { input: { orderNumber, shipmentStatus } }
  );
  const r = data.updateOrderShipmentStatus;
  if (r.__typename === "UserError") throw new MeepError("rejected", r.message || "更新出貨狀態失敗");
}

// ---------- Shoppers ----------

const SHOPPER_FIELDS = `id email name mobile birthDate usableRewardPoints updatedAt`;

export async function shoppersPage(after: string | null, updatedSince?: Date) {
  const data = await gql<{ shoppers: Connection<MShopper> }>(
    `query Shoppers($first: PositiveInt!, $after: String, $query: ShopperQueryTermsInput) {
      shoppers(first: $first, after: $after, query: $query) {
        total
        pageInfo { hasNextPage endCursor }
        edges { node { ${SHOPPER_FIELDS} } }
      }
    }`,
    { first: 50, after, query: updatedSince ? { updatedAt: { start: updatedSince.toISOString() } } : null },
    { estimate: 150 }
  );
  return data.shoppers;
}

export async function shoppersByEmail(email: string): Promise<MShopper[]> {
  const data = await gql<{ shoppers: Connection<MShopper> }>(
    `query S($query: ShopperQueryTermsInput) { shoppers(first: 5, query: $query) { edges { node { ${SHOPPER_FIELDS} } } } }`,
    { query: { emails: [email] } },
    { estimate: 20 }
  );
  return data.shoppers.edges.flatMap((e) => (e.node ? [e.node] : []));
}

export async function getShopper(id: string): Promise<MShopper | null> {
  const data = await gql<{ shopper: MShopper | null }>(`query S($id: ID!) { shopper(id: $id) { ${SHOPPER_FIELDS} } }`, { id }, { estimate: 5 });
  return data.shopper;
}

export async function createShopper(input: { email: string; name?: string; mobile?: string }): Promise<MShopper> {
  const data = await gql<{ createShopper: { __typename: string; message?: string } & Partial<MShopper> }>(
    `mutation C($input: CreateShopperInput) {
      createShopper(input: $input) { __typename ... on Shopper { ${SHOPPER_FIELDS} } ... on UserError { message } }
    }`,
    { input }
  );
  const r = data.createShopper;
  if (r.__typename === "UserError") throw new MeepError("rejected", r.message || "新增會員失敗");
  return r as MShopper;
}

const REWARD_ERRORS: Record<string, string> = {
  FAIL_SHOPPER_ID_IS_NOT_EXIST: "找不到這位會員",
  FAIL_OVER_USABLE: "購物金不足",
  FAIL_AUTHORIZATION_ERROR: "API 金鑰沒有購物金權限",
};

export async function deductRewardPoints(shopperId: string, points: number) {
  const data = await gql<{ deductShopperRewardPoint: { status: string } }>(
    `mutation D($input: DeductShopperRewardPointInput!) { deductShopperRewardPoint(input: $input) { status } }`,
    { input: { shopperId, points } }
  );
  const s = data.deductShopperRewardPoint.status;
  if (s !== "OK") throw new MeepError("rejected", REWARD_ERRORS[s] ?? s);
}

export async function sendRewardPoints(shopperId: string, points: number, description: string) {
  const data = await gql<{ sendShopperRewardPoint: { status: string } }>(
    `mutation S($input: SendShopperRewardPointInput!) { sendShopperRewardPoint(input: $input) { status } }`,
    { input: { shopperId, points, methodType: "UNLIMITED", description } }
  );
  const s = data.sendShopperRewardPoint.status;
  if (s !== "OK") throw new MeepError("rejected", REWARD_ERRORS[s] ?? s);
}
