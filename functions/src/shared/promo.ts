/**
 * 促銷計價引擎 — shared by the POS (preview) and posCheckout (authoritative).
 * Pure TypeScript, no imports: web/ imports this file directly so both sides always compute the same price.
 *
 * Each unit in the cart is used by at most one promotion. The engine repeatedly takes the
 * promotion that saves the customer the most on the units still free, until nothing saves more —
 * that is how "自動判定最優惠" is decided.
 * Lines with a manual discount (單品打折 / 改價) are left out of promotions.
 */

export type PromoType = "percent_off" | "nth_discount" | "bundle_price" | "addon";

export type PromoScope =
  | { kind: "all" }
  | { kind: "products"; productIds: string[] }
  | { kind: "categories"; categories: string[] };

export interface Promotion {
  id: string;
  name: string;
  active: boolean;
  type: PromoType;
  /** YYYY-MM-DD, inclusive; empty = no limit */
  startDate?: string | null;
  endDate?: string | null;
  scope: PromoScope;
  /** percent_off: X% off every eligible item (例：打 7 折 = 30) */
  percentOff?: number;
  /** nth_discount: every Nth item gets percentOff (例：第二件 6 折 = n 2, percentOff 40) */
  n?: number;
  /** bundle_price: any n eligible items for this price (例：任選 3 件 1000) */
  bundlePrice?: number;
  /** addon: buying a scope item lets one addonScope item per trigger be bought at addonPrice */
  addonScope?: PromoScope;
  addonPrice?: number;
}

export interface PromoLine {
  key: string;
  variantId: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
}

export interface PromoItemInfo {
  productId: string;
  category: string | null;
  tags: string[];
}

export interface PromoApplied {
  promoId: string;
  name: string;
  discount: number;
}

export interface PromoResult {
  /** line key → promotion discount in dollars */
  lineDiscount: Record<string, number>;
  /** line key → promotion names used on that line */
  lineLabels: Record<string, string[]>;
  applied: PromoApplied[];
  total: number;
}

interface Unit {
  lineKey: string;
  price: number;
  info: PromoItemInfo;
}

export function promoIsLive(p: Promotion, today: string): boolean {
  if (!p.active) return false;
  if (p.startDate && today < p.startDate) return false;
  if (p.endDate && today > p.endDate) return false;
  return true;
}

export function inScope(scope: PromoScope | undefined, info: PromoItemInfo): boolean {
  if (!scope || scope.kind === "all") return true;
  if (scope.kind === "products") return scope.productIds.includes(info.productId);
  return scope.categories.some((c) => c === info.category || info.tags.includes(c));
}

const byPriceDesc = (a: Unit, b: Unit) => b.price - a.price;

/** What one promotion would save on the free units, and which units it uses (unit index → discount). */
function evaluate(p: Promotion, units: Unit[], free: boolean[]): { saving: number; uses: Map<number, number> } {
  const uses = new Map<number, number>();
  const eligible = units.map((u, i) => ({ u, i })).filter(({ u, i }) => free[i] && inScope(p.scope, u.info));
  const pct = Math.min(100, Math.max(0, p.percentOff ?? 0));

  if (p.type === "percent_off") {
    for (const { u, i } of eligible) {
      const d = Math.round((u.price * pct) / 100);
      if (d > 0) uses.set(i, d);
    }
  } else if (p.type === "nth_discount") {
    const n = Math.max(2, Math.floor(p.n ?? 2));
    const sorted = [...eligible].sort((a, b) => byPriceDesc(a.u, b.u));
    // Groups of n, most expensive first; the cheapest of each group gets the discount.
    for (let g = 0; g + n <= sorted.length; g += n) {
      const group = sorted.slice(g, g + n);
      const cheapest = group[group.length - 1];
      for (const x of group) uses.set(x.i, 0);
      uses.set(cheapest.i, Math.round((cheapest.u.price * pct) / 100));
    }
  } else if (p.type === "bundle_price") {
    const n = Math.max(1, Math.floor(p.n ?? 1));
    const price = Math.max(0, p.bundlePrice ?? 0);
    const sorted = [...eligible].sort((a, b) => byPriceDesc(a.u, b.u));
    for (let g = 0; g + n <= sorted.length; g += n) {
      const group = sorted.slice(g, g + n);
      const sum = group.reduce((s, x) => s + x.u.price, 0);
      const save = sum - price;
      if (save <= 0) break; // later groups are cheaper still
      // Spread the saving over the group by price; the last unit takes the rounding remainder.
      let left = save;
      group.forEach((x, k) => {
        const d = k === group.length - 1 ? left : Math.round((save * x.u.price) / sum);
        left -= d;
        uses.set(x.i, d);
      });
    }
  } else if (p.type === "addon") {
    const addonPrice = Math.max(0, p.addonPrice ?? 0);
    const addons = units
      .map((u, i) => ({ u, i }))
      .filter(({ u, i }) => free[i] && inScope(p.addonScope, u.info) && u.price > addonPrice)
      .sort((a, b) => byPriceDesc(a.u, b.u));
    const addonIdx = new Set(addons.map((a) => a.i));
    const triggers = eligible.filter((x) => !addonIdx.has(x.i));
    const pairs = Math.min(triggers.length, addons.length);
    for (let k = 0; k < pairs; k++) {
      uses.set(triggers[k].i, 0);
      uses.set(addons[k].i, addons[k].u.price - addonPrice);
    }
  }

  let saving = 0;
  for (const d of uses.values()) saving += d;
  return { saving, uses };
}

export function applyPromotions(lines: PromoLine[], infoOf: (variantId: string) => PromoItemInfo | undefined, promotions: Promotion[], today: string): PromoResult {
  const units: Unit[] = [];
  for (const l of lines) {
    if (l.discountPct > 0) continue; // manual discount wins; no stacking
    const info = infoOf(l.variantId);
    if (!info) continue;
    for (let q = 0; q < l.qty; q++) units.push({ lineKey: l.key, price: l.unitPrice, info });
  }
  const free = units.map(() => true);
  const lineDiscount: Record<string, number> = {};
  const lineLabels: Record<string, string[]> = {};
  const applied: PromoApplied[] = [];
  const remaining = promotions.filter((p) => promoIsLive(p, today));

  for (;;) {
    let best: { p: Promotion; saving: number; uses: Map<number, number> } | null = null;
    for (const p of remaining) {
      const r = evaluate(p, units, free);
      if (r.saving > 0 && (!best || r.saving > best.saving)) best = { p, ...r };
    }
    if (!best) break;
    for (const [i, d] of best.uses) {
      free[i] = false;
      const key = units[i].lineKey;
      lineDiscount[key] = (lineDiscount[key] ?? 0) + d;
      const labels = (lineLabels[key] ??= []);
      if (!labels.includes(best.p.name)) labels.push(best.p.name);
    }
    applied.push({ promoId: best.p.id, name: best.p.name, discount: best.saving });
    remaining.splice(remaining.indexOf(best.p), 1);
  }
  return { lineDiscount, lineLabels, applied, total: applied.reduce((s, a) => s + a.discount, 0) };
}

export const PROMO_TYPE_LABEL: Record<PromoType, string> = {
  percent_off: "打折",
  nth_discount: "第 N 件折扣",
  bundle_price: "任選 N 件特價",
  addon: "加價購",
};

export function describePromo(p: Promotion): string {
  switch (p.type) {
    case "percent_off":
      return `全部 ${(100 - (p.percentOff ?? 0)) / 10} 折`;
    case "nth_discount":
      return `第 ${p.n ?? 2} 件 ${(100 - (p.percentOff ?? 0)) / 10} 折`;
    case "bundle_price":
      return `任選 ${p.n ?? 1} 件 $${p.bundlePrice ?? 0}`;
    case "addon":
      return `加價 $${p.addonPrice ?? 0} 購`;
  }
}
