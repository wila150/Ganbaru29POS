import type { Timestamp } from "firebase/firestore";
import type { MoveType } from "./lib/util";

export interface Batch {
  id: string;
  lot: string | null;
  exp: string | null;
  qty: number;
  receivedAt: Timestamp;
}

export interface Variant {
  id: string;
  productId: string;
  productTitle: string;
  productStatus: "LISTED" | "NOT_LISTED";
  tags: string[];
  options: string;
  optionList: { name: string; value: string }[];
  variantIndex: number;
  sku: string | null;
  barcode: string | null;
  vendorSku: string | null;
  price: number;
  status: "LISTED" | "NOT_LISTED";
  shopStock: number | null;
  shopStockAt?: Timestamp;
  active: boolean;
  location: string | null;
  safety: number;
  extraCodes: string[];
  storeCode?: string;
  batches: Batch[];
  posCategory: string | null;
  posSort: number;
  posHidden?: boolean;
  labelPrinted?: boolean;
  material?: string | null;
  careText?: string | null;
  imageUrl: string | null;
  /** 360px 縮圖（列表、POS 商品格用；沒有就用原圖） */
  thumbUrl?: string | null;
  imageSource: "auto" | "manual" | null;
  searchText: string;
  sales30?: number;
  sales30Store?: number;
  sales30Online?: number;
  lastSoldAt?: Timestamp | null;
  statsAt?: Timestamp;
  shopCreatedAt?: Timestamp | null;
  reorderQty?: number;
}

export interface Movement {
  id: string;
  variantId: string;
  productTitle: string;
  options: string;
  sku: string | null;
  location: string | null;
  type: MoveType;
  delta: number;
  unitCost: number | null;
  lot: string | null;
  exp: string | null;
  ref: string | null;
  undoOf: string | null;
  undoneBy?: string;
  note: string | null;
  by: string;
  byName: string;
  device: string | null;
  at: Timestamp | null;
  status: string;
  attempts: number;
  retryable: boolean;
  shopStockAfter: number | null;
  error: string | null;
  resolveNote?: string;
}

export interface ShopSettings {
  shopName?: string;
  leadDays?: number;
  expiryDays?: number;
  lineTargets?: string[];
  rewardPercent?: number;
  pointValue?: number;
  staffCanRefund?: boolean;
  siteBaseUrl?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  serviceFeeDefault?: number;
  shiftNames?: string[];
  currentShiftId?: string | null;
  currentShifts?: Record<string, string | null>;
  lastCatalogSyncAt?: Timestamp;
  lastIncrementalSyncAt?: Timestamp;
  statsAt?: Timestamp;
  statsOnlineError?: string | null;
  apiKeySetAt?: Timestamp;
  apiKeySetBy?: string;
  lineTokenSetAt?: Timestamp;
  memberTiers?: TierDef[];
  rewardRules?: RewardRule[];
  /** 會員生日／會員加入購物金（meepShop 寄送，這裡只記錄） */
  pointGifts?: PointGift[];
  memberGroups?: string[];
  birthdayGiftPoints?: number;
  birthdayPointMultiplier?: number;
  tiersAt?: Timestamp;
  payment?: { provider: "ecpay" | "newebpay" | null; stage: boolean };
  /** 滯銷條件：幾天沒賣出、上架未滿幾天不算 */
  slowRule?: { days: number; newDays: number };
  /** 熱銷：近 30 天賣出至少幾件 */
  hotRule?: { sales30: number };
  /** 每日 LINE 提醒要送哪些項目 */
  alerts?: AlertPrefs;
  /** 側邊選單：順序（主項目路徑）與隱藏的項目 */
  navConfig?: { order?: string[]; hidden?: string[] };
  /** 結帳完成音效 */
  checkoutSound?: import("./lib/sound").CheckoutSound;
  /** LINE Pay 線下支付串接（掃客人付款碼） */
  linePay?: { enabled: boolean; stage: boolean };
  invoice?: { enabled: boolean; stage: boolean; notifyEmail?: string; address?: string };
  credsSet?: Record<string, boolean>;
  locations?: { id: string; name: string; type: "store" | "warehouse" }[];
  onlineLocationId?: string | null;
  locationStockInitAt?: Timestamp;
  merchantId?: string;
  lineLogin?: { channelId?: string; liffId?: string };
  commissionPct?: number;
  commissionByUser?: Record<string, number>;
  expenseCategories?: string[];
  merchantSync?: { at?: Timestamp; trigger?: string; products?: number; done?: number; failed?: number; error?: string | null };
  tiersError?: string | null;
}

export interface PosLine {
  variantId: string;
  productTitle: string;
  options: string;
  sku: string | null;
  qty: number;
  listPrice: number;
  unitPrice: number;
  discountPct: number;
  promoDiscount?: number;
  promoLabels?: string[];
  total: number;
  refundedQty: number;
  note?: string | null;
  /** 更換商品前原本是什麼（例：新品） */
  replacedFrom?: { variantId: string; productTitle: string; options: string } | null;
}

export interface Refund {
  id: string;
  at: Timestamp;
  byName: string;
  shiftId: string;
  lines: { index: number; qty: number }[];
  amount: number;
  payments: { method: string; amount: number }[];
  pointsReturned: number;
  pointsReclaimed: number;
  reason: string;
  void: boolean;
}

export interface PosOrder {
  id: string;
  orderNo: string;
  status: "pending" | "completed" | "canceled" | "partial" | "refunded" | "void";
  shiftId: string;
  businessDate: string;
  cashierName: string;
  guests: number | null;
  note: string | null;
  shopper: { id: string; name: string; email: string; mobile: string } | null;
  edits?: { at: { toMillis(): number }; by: string; changes: string[] }[];
  lines: PosLine[];
  promotions?: { promoId: string; name: string; discount: number }[];
  promoTotal?: number;
  itemCount: number;
  subtotal: number;
  memberTier?: string | null;
  memberDiscountPct?: number;
  memberDiscount?: number;
  birthdayMonth?: boolean;
  orderDiscountPct: number;
  orderDiscount: number;
  serviceFeePct: number;
  serviceFee: number;
  allowance: number;
  rewardPoints: number;
  rewardDiscount: number;
  total: number;
  payments: { method: string; amount: number }[];
  paid: number;
  change: number;
  rewardEarned: number;
  refunds: Refund[];
  refundNotes?: string[];
  invoice?: { no: string; date: string; random: string; print: boolean; stage: boolean; type: string; taxId: string | null; voided?: boolean } | null;
  invoiceError?: string | null;
  invoiceNote?: string | null;
  exchange?: ExchangeQuote & { refundDue: number; refundMethod: string };
  createdAt: Timestamp | null;
}

/** 換貨：退回的商品與可抵用金額（由 exchangeQuote 算出） */
export interface ExchangeQuote {
  kind: "pos" | "online";
  orderId: string | null;
  orderNumber: string | null;
  orderNo: string;
  lines: { index?: number; variantId: string; qty: number; title: string; amount: number }[];
  credit: number;
}

export interface Shopper {
  id: string;
  name: string;
  email: string;
  mobile: string;
  points: number;
  tier?: string | null;
  birthMonth?: string | null;
  spend12m?: number;
  /** meepShop 會員群組 */
  group?: string | null;
}

export interface PointGift {
  kind: "birthday" | "join";
  name: string;
  active: boolean;
  groups?: string[];
  daysBefore?: number;
  points: number;
  expiryDays?: number;
}

export interface RewardRule {
  name: string;
  active: boolean;
  groups?: string[];
  tiers?: string[];
  every: number;
  points: number;
  minSpend?: number;
  maxSpend?: number;
  expiryDays?: number;
}

export interface TierCond {
  kind: "single" | "cumulative";
  amount: number;
  months?: number;
}

export interface TierDef {
  name: string;
  enabled?: boolean;
  /** 使用期限（月）；0 / 空 = 永久 */
  validityMonths?: number | null;
  upgrade?: TierCond[];
  renew?: TierCond[];
  /** 舊版欄位（相容） */
  minSpend?: number;
  minSingle?: number;
  discountPct?: number;
  pointMultiplier?: number;
}

export interface AlertPrefs {
  lowStock?: boolean;
  expiry?: boolean;
  sync?: boolean;
  labels?: boolean;
  dailySales?: boolean;
  slowMoving?: boolean;
  slowDays?: number;
  birthdays?: boolean;
}
