/** Same arithmetic as functions/src/pos.ts → posCheckout (the server recomputes; this is the preview). */
export interface CartLine {
  key: string;
  variantId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
}
export interface CartDiscounts {
  serviceFeePct: number;
  orderDiscountPct: number;
  allowance: number;
  rewardPoints: number;
}

export const lineTotal = (l: Pick<CartLine, "qty" | "unitPrice" | "discountPct">) => Math.round((l.unitPrice * l.qty * (100 - l.discountPct)) / 100);

export function totals(lines: CartLine[], d: CartDiscounts, pointValue = 1) {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const orderDiscount = Math.round((subtotal * d.orderDiscountPct) / 100);
  const serviceFee = Math.round(((subtotal - orderDiscount) * d.serviceFeePct) / 100);
  const rewardDiscount = d.rewardPoints * pointValue;
  const total = subtotal - orderDiscount + serviceFee - d.allowance - rewardDiscount;
  return { subtotal, orderDiscount, serviceFee, rewardDiscount, total, items: lines.reduce((s, l) => s + l.qty, 0) };
}
