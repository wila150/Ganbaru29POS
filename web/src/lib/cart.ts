/** Same arithmetic as functions/src/pos.ts → posCheckout (the server recomputes; this is the preview). */
import type { Variant } from "../types";
import { applyPromotions, taipeiClock, type PromoResult, type Promotion } from "./promo";

export interface CartLine {
  key: string;
  variantId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  /** 這一項的備註（例：要修褲長、客人預留） */
  note?: string;
}
export interface CartDiscounts {
  serviceFeePct: number;
  orderDiscountPct: number;
  allowance: number;
  rewardPoints: number;
}

export const lineTotal = (l: Pick<CartLine, "qty" | "unitPrice" | "discountPct">) => Math.round((l.unitPrice * l.qty * (100 - l.discountPct)) / 100);

const NO_PROMO: PromoResult = { lineDiscount: {}, lineLabels: {}, noMemberStack: [], noDiscount: [], applied: [], total: 0 };

export function cartPromos(lines: CartLine[], byId: Map<string, Variant>, promotions: Promotion[], shopper?: { tier?: string | null; group?: string | null } | null, couponPromoIds: string[] = [], noDiscountTags?: string[]): PromoResult {
  if (!lines.length) return NO_PROMO;
  return applyPromotions(
    lines,
    (vid) => {
      const v = byId.get(vid);
      return v ? { productId: v.productId, category: v.posCategory, tags: v.tags ?? [] } : undefined;
    },
    promotions,
    { ...taipeiClock(), isMember: !!shopper, tier: shopper?.tier ?? null, group: shopper?.group ?? null, coupons: couponPromoIds, noDiscountTags }
  );
}

/** memberPct = 會員等級折扣 %, applied after promotions and before the order discount (same as the server). */
export function totals(lines: CartLine[], d: CartDiscounts, pointValue = 1, promo: PromoResult = NO_PROMO, memberPct = 0) {
  const gross = lines.reduce((s, l) => s + lineTotal(l), 0);
  const subtotal = gross - promo.total;
  // 「不併用會員折扣」的促銷品項不算進會員折扣
  const noStack = new Set(promo.noMemberStack);
  const memberBase = lines.reduce((s, l) => s + (noStack.has(l.key) ? 0 : lineTotal(l) - (promo.lineDiscount[l.key] ?? 0)), 0);
  const memberDiscount = Math.round((memberBase * memberPct) / 100);
  const afterMember = subtotal - memberDiscount;
  // 特價商品（不再折扣）不算整單打折
  const noDisc = new Set(promo.noDiscount ?? []);
  const orderBase = afterMember - lines.reduce((s, l) => s + (noDisc.has(l.key) ? lineTotal(l) : 0), 0);
  const orderDiscount = Math.round((orderBase * d.orderDiscountPct) / 100);
  const serviceFee = Math.round(((afterMember - orderDiscount) * d.serviceFeePct) / 100);
  const rewardDiscount = d.rewardPoints * pointValue;
  const total = afterMember - orderDiscount + serviceFee - d.allowance - rewardDiscount;
  return { gross, promoTotal: promo.total, subtotal, memberDiscount, orderDiscount, serviceFee, rewardDiscount, total, items: lines.reduce((s, l) => s + l.qty, 0) };
}
