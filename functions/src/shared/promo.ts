/**
 * 促銷計價引擎 — shared by the POS (preview) and posCheckout (authoritative).
 * Pure TypeScript, no imports: web/ imports this file directly so both sides always compute the same price.
 *
 * Each unit in the cart is used by at most one promotion. The engine repeatedly takes the
 * promotion that saves the customer the most on the units still free, until nothing saves more —
 * that is how "自動判定最優惠" is decided.
 * Lines with a manual discount (單品打折 / 改價) are left out of promotions.
 */

export type PromoType = "percent_off" | "amount_off" | "nth_discount" | "bundle_price" | "addon" | "threshold" | "gift";

/** 滿額折扣的一層條件（新增條件）：消費滿 threshold → 優惠 value（元或 % off，依 thresholdReward） */
export interface PromoLevel {
  threshold: number;
  value: number;
}

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
  /** 不參加的商品／分類（例：新品不參加） */
  excludeScope?: PromoScope | null;

  /** percent_off / nth_discount / threshold(percent): % off (例：打 7 折 = 30) */
  percentOff?: number;
  /** amount_off: $ off each item; threshold(amount): $ off per reached threshold */
  amountOff?: number;
  /** nth_discount: every Nth item gets percentOff; bundle_price: any n items */
  n?: number;
  /** bundle_price: price of n items */
  bundlePrice?: number;
  /** addon: buying a scope item lets one addonScope item per trigger be bought at addonPrice
   *  gift: 滿額贈 — reaching the threshold makes addonScope items free (levels[].value = 贈品件數) */
  addonScope?: PromoScope;
  addonPrice?: number;
  /** threshold: 滿額（amount）或 滿件（qty） */
  thresholdType?: "amount" | "qty";
  threshold?: number;
  /** threshold: discount kind once reached */
  thresholdReward?: "percent" | "amount";
  /** threshold(amount reward): 每滿一次就再折一次 */
  repeat?: boolean;
  /** threshold / gift: 多層條件，達到的最高一層生效（有設定時取代 threshold / amountOff / percentOff） */
  levels?: PromoLevel[];
  /** 顯示分類：true = 訂單層級（列在「訂單」） */
  orderLevel?: boolean;

  // ---- 條件 ----
  /** 會員限定：none = 不限；members = 任何會員；tiers = 指定等級（本系統）；groups = 指定 meepShop 會員群組 */
  memberRule?: "none" | "members" | "tiers" | "groups";
  memberTiers?: string[];
  memberGroups?: string[];
  /** 星期幾（0 = 週日）；空 = 每天 */
  days?: number[];
  /** "HH:MM"；空 = 全天 */
  timeFrom?: string | null;
  timeTo?: string | null;
  /** 適用商品合計滿多少才生效 */
  minSpend?: number;
  /** 每張單最多套用次數（件數／組數）；0 = 不限 */
  maxUses?: number;
  /** true = 套用這個活動的商品，不再打會員等級折扣 */
  noMemberStack?: boolean;
  /** true = 要掃／輸入這個活動的優惠碼才會套用 */
  couponOnly?: boolean;
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

/** 結帳當下的情境（台灣時間、會員） */
export interface PromoContext {
  date: string; // YYYY-MM-DD
  weekday: number; // 0 = Sunday
  hhmm: string; // "14:05"
  isMember: boolean;
  tier: string | null;
  /** meepShop 會員群組名稱 */
  group?: string | null;
  /** 結帳時輸入的優惠碼解鎖的促銷 id */
  coupons?: string[];
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
  /** line keys touched by a promotion that does not stack with the member discount */
  noMemberStack: string[];
  applied: PromoApplied[];
  total: number;
}

interface Unit {
  lineKey: string;
  price: number;
  info: PromoItemInfo;
}

/** Taiwan time for a Date (UTC+8, no DST). */
export function taipeiClock(d = new Date()): Pick<PromoContext, "date" | "weekday" | "hhmm"> {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, weekday: t.getUTCDay(), hhmm: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}` };
}

/** Accepts a context or (backwards compatible) just a YYYY-MM-DD date. */
function ctxOf(c: PromoContext | string): PromoContext {
  return typeof c === "string" ? { date: c, weekday: new Date(`${c}T12:00:00Z`).getUTCDay(), hhmm: "12:00", isMember: false, tier: null } : c;
}

export function promoIsLive(p: Promotion, c: PromoContext | string): boolean {
  const ctx = ctxOf(c);
  if (!p.active) return false;
  if (p.couponOnly && !(ctx.coupons ?? []).includes(p.id)) return false;
  if (p.startDate && ctx.date < p.startDate) return false;
  if (p.endDate && ctx.date > p.endDate) return false;
  if (p.days?.length && !p.days.includes(ctx.weekday)) return false;
  if (p.timeFrom && ctx.hhmm < p.timeFrom) return false;
  if (p.timeTo && ctx.hhmm > p.timeTo) return false;
  if (p.memberRule === "members" && !ctx.isMember) return false;
  if (p.memberRule === "tiers" && !(ctx.tier && (p.memberTiers ?? []).includes(ctx.tier))) return false;
  if (p.memberRule === "groups" && !(ctx.group && (p.memberGroups ?? []).includes(ctx.group))) return false;
  return true;
}

export function inScope(scope: PromoScope | undefined | null, info: PromoItemInfo): boolean {
  if (!scope || scope.kind === "all") return true;
  if (scope.kind === "products") return scope.productIds.includes(info.productId);
  return scope.categories.some((c) => c === info.category || info.tags.includes(c));
}

function excluded(p: Promotion, info: PromoItemInfo) {
  const ex = p.excludeScope;
  if (!ex || ex.kind === "all") return false;
  return inScope(ex, info);
}

const byPriceDesc = (a: Unit, b: Unit) => b.price - a.price;
const capUses = (p: Promotion) => (p.maxUses && p.maxUses > 0 ? Math.floor(p.maxUses) : Infinity);

/** Spread `save` over the given units by price; the last unit takes the rounding remainder. */
function spread(uses: Map<number, number>, group: { u: Unit; i: number }[], save: number) {
  const sum = group.reduce((s, x) => s + x.u.price, 0);
  let left = save;
  group.forEach((x, k) => {
    const d = k === group.length - 1 ? left : sum ? Math.round((save * x.u.price) / sum) : 0;
    left -= d;
    uses.set(x.i, (uses.get(x.i) ?? 0) + d);
  });
}

/** What one promotion would save on the free units, and which units it uses (unit index → discount). */
function evaluate(p: Promotion, units: Unit[], free: boolean[]): { saving: number; uses: Map<number, number> } {
  const uses = new Map<number, number>();
  const eligible = units.map((u, i) => ({ u, i })).filter(({ u, i }) => free[i] && inScope(p.scope, u.info) && !excluded(p, u.info));
  const eligibleSum = eligible.reduce((s, x) => s + x.u.price, 0);
  if (p.minSpend && eligibleSum < p.minSpend) return { saving: 0, uses };
  const pct = Math.min(100, Math.max(0, p.percentOff ?? 0));
  const cap = capUses(p);

  if (p.type === "percent_off" || p.type === "amount_off") {
    const sorted = [...eligible].sort((a, b) => byPriceDesc(a.u, b.u)).slice(0, cap);
    for (const { u, i } of sorted) {
      const d = p.type === "percent_off" ? Math.round((u.price * pct) / 100) : Math.min(u.price, Math.max(0, Math.round(p.amountOff ?? 0)));
      if (d > 0) uses.set(i, d);
    }
  } else if (p.type === "nth_discount") {
    const n = Math.max(2, Math.floor(p.n ?? 2));
    const sorted = [...eligible].sort((a, b) => byPriceDesc(a.u, b.u));
    // Groups of n, most expensive first; the cheapest of each group gets the discount.
    for (let g = 0, used = 0; g + n <= sorted.length && used < cap; g += n, used++) {
      const group = sorted.slice(g, g + n);
      const cheapest = group[group.length - 1];
      for (const x of group) uses.set(x.i, 0);
      uses.set(cheapest.i, Math.round((cheapest.u.price * pct) / 100));
    }
  } else if (p.type === "bundle_price") {
    const n = Math.max(1, Math.floor(p.n ?? 1));
    const price = Math.max(0, p.bundlePrice ?? 0);
    const sorted = [...eligible].sort((a, b) => byPriceDesc(a.u, b.u));
    for (let g = 0, used = 0; g + n <= sorted.length && used < cap; g += n, used++) {
      const group = sorted.slice(g, g + n);
      const save = group.reduce((s, x) => s + x.u.price, 0) - price;
      if (save <= 0) break; // later groups are cheaper still
      spread(uses, group, save);
    }
  } else if (p.type === "addon") {
    const addonPrice = Math.max(0, p.addonPrice ?? 0);
    const addons = units
      .map((u, i) => ({ u, i }))
      .filter(({ u, i }) => free[i] && inScope(p.addonScope, u.info) && !excluded(p, u.info) && u.price > addonPrice)
      .sort((a, b) => byPriceDesc(a.u, b.u));
    const addonIdx = new Set(addons.map((a) => a.i));
    const triggers = eligible.filter((x) => !addonIdx.has(x.i));
    const pairs = Math.min(triggers.length, addons.length, cap);
    for (let k = 0; k < pairs; k++) {
      uses.set(triggers[k].i, 0);
      uses.set(addons[k].i, addons[k].u.price - addonPrice);
    }
  } else if (p.type === "gift") {
    const gifts = units
      .map((u, i) => ({ u, i }))
      .filter(({ u, i }) => free[i] && inScope(p.addonScope, u.info))
      .sort((a, b) => byPriceDesc(a.u, b.u));
    const giftIdx = new Set(gifts.map((g) => g.i));
    const buys = eligible.filter((x) => !giftIdx.has(x.i));
    const measure = p.thresholdType === "qty" ? buys.length : buys.reduce((s, x) => s + x.u.price, 0);
    const levels = p.levels?.length ? p.levels : [{ threshold: p.threshold ?? 0, value: 1 }];
    const hit = levels.filter((l) => l.threshold > 0 && measure >= l.threshold).sort((a, b) => b.threshold - a.threshold)[0];
    const count = hit ? Math.min(Math.max(1, Math.floor(hit.value || 1)), cap, gifts.length) : 0;
    for (let k = 0; k < count; k++) uses.set(gifts[k].i, gifts[k].u.price);
    if (count) for (const x of buys) if (!uses.has(x.i)) uses.set(x.i, 0);
  } else if (p.type === "threshold" && p.levels?.length) {
    const measure = p.thresholdType === "qty" ? eligible.length : eligibleSum;
    const hit = p.levels.filter((l) => l.threshold > 0 && measure >= l.threshold).sort((a, b) => b.threshold - a.threshold)[0];
    if (hit && eligible.length) {
      const save = Math.min(eligibleSum, Math.round(p.thresholdReward === "percent" ? (eligibleSum * Math.min(100, Math.max(0, hit.value))) / 100 : Math.max(0, hit.value)));
      if (save > 0) spread(uses, eligible, save);
    }
  } else if (p.type === "threshold") {
    const t = Math.max(0, p.threshold ?? 0);
    const measure = p.thresholdType === "qty" ? eligible.length : eligibleSum;
    if (t > 0 && measure >= t && eligible.length) {
      let save: number;
      if (p.thresholdReward === "amount") {
        const times = Math.min(p.repeat ? Math.floor(measure / t) : 1, cap);
        save = Math.round(Math.max(0, p.amountOff ?? 0) * times);
      } else {
        save = Math.round((eligibleSum * pct) / 100);
      }
      save = Math.min(save, eligibleSum);
      if (save > 0) spread(uses, eligible, save);
    }
  }

  let saving = 0;
  for (const d of uses.values()) saving += d;
  return { saving, uses };
}

export function applyPromotions(lines: PromoLine[], infoOf: (variantId: string) => PromoItemInfo | undefined, promotions: Promotion[], context: PromoContext | string): PromoResult {
  const ctx = ctxOf(context);
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
  const noStack = new Set<string>();
  const applied: PromoApplied[] = [];
  const remaining = promotions.filter((p) => promoIsLive(p, ctx));

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
      if (best.p.noMemberStack) noStack.add(key);
    }
    applied.push({ promoId: best.p.id, name: best.p.name, discount: best.saving });
    remaining.splice(remaining.indexOf(best.p), 1);
  }
  return { lineDiscount, lineLabels, noMemberStack: [...noStack], applied, total: applied.reduce((s, a) => s + a.discount, 0) };
}

export const PROMO_TYPE_LABEL: Record<PromoType, string> = {
  percent_off: "打折",
  amount_off: "每件折抵",
  nth_discount: "第 N 件折扣",
  bundle_price: "任選 N 件特價",
  threshold: "滿額折扣",
  addon: "加價購",
  gift: "滿額贈",
};

/** 30 (% off) → "7 折"；25 → "75 折" */
export const zhe = (percentOff: number | undefined) => {
  const z = 100 - (percentOff ?? 0);
  return `${z % 10 === 0 ? z / 10 : z} 折`;
};

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

export function describePromo(p: Promotion): string {
  let main: string;
  switch (p.type) {
    case "percent_off":
      main = `打 ${zhe(p.percentOff)}`;
      break;
    case "amount_off":
      main = `每件折 $${p.amountOff ?? 0}`;
      break;
    case "nth_discount":
      main = `第 ${p.n ?? 2} 件 ${zhe(p.percentOff)}`;
      break;
    case "bundle_price":
      main = `任選 ${p.n ?? 1} 件 $${p.bundlePrice ?? 0}`;
      break;
    case "addon":
      main = `加價 $${p.addonPrice ?? 0} 購`;
      break;
    case "threshold": {
      if (p.levels?.length) {
        main = levelText(p);
        break;
      }
      const cond = p.thresholdType === "qty" ? `買 ${p.threshold ?? 0} 件以上` : `${p.repeat ? "每滿" : "滿"} $${p.threshold ?? 0}`;
      main = `${cond}${p.thresholdReward === "amount" ? ` 折 $${p.amountOff ?? 0}` : ` 打 ${zhe(p.percentOff)}`}`;
      break;
    }
    case "gift":
      main = levelText(p);
      break;
  }
  const extra: string[] = [];
  if (p.memberRule === "members") extra.push("會員限定");
  if (p.memberRule === "tiers") extra.push(`限 ${(p.memberTiers ?? []).join("、")}`);
  if (p.memberRule === "groups") extra.push(`限 ${(p.memberGroups ?? []).join("、")}`);
  if (p.days?.length && p.days.length < 7) extra.push(`每週${p.days.map((d) => WEEK[d]).join("、")}`);
  if (p.timeFrom || p.timeTo) extra.push(`${p.timeFrom || "開店"}～${p.timeTo || "打烊"}`);
  if (p.minSpend) extra.push(`滿 $${p.minSpend} 才適用`);
  if (p.maxUses) extra.push(`每單限 ${p.maxUses} 次`);
  if (p.noMemberStack) extra.push("不併用會員折扣");
  if (p.couponOnly) extra.push("需優惠碼");
  return extra.length ? `${main}（${extra.join("，")}）` : main;
}

/** 多層條件文字：消費滿 $2000 折 $200；滿 $3000 享 85 折；滿 3 件 贈 1 件 */
export function levelText(p: Promotion): string {
  const levels = p.levels?.length ? p.levels : [{ threshold: p.threshold ?? 0, value: p.type === "gift" ? 1 : p.thresholdReward === "percent" ? p.percentOff ?? 0 : p.amountOff ?? 0 }];
  return [...levels]
    .sort((a, b) => a.threshold - b.threshold)
    .map((l) => {
      const cond = p.thresholdType === "qty" ? `滿 ${l.threshold} 件` : `消費滿 $${l.threshold}`;
      const reward = p.type === "gift" ? `贈 ${l.value || 1} 件贈品` : p.thresholdReward === "percent" ? `享 ${zhe(l.value)}` : `折 $${l.value}`;
      return `${cond} ${reward}`;
    })
    .join("；");
}
