import { onCall } from "firebase-functions/v2/https";
import { atLeast, requireRole } from "./lib/auth";
import { ordersPage } from "./lib/meepshop";
import { assert, db, errMsg, sleep } from "./lib/util";

/**
 * 報表中心：一個日期區間（含頭尾，台灣時間的營業日），可選門市。
 * 老闆／工程師拿到含成本、毛利、淨利（扣開支）的版本；店長拿到的版本沒有成本相關欄位。
 */

const SIZE_NAMES = /尺寸|尺碼|size|號/i;
const COLOR_NAMES = /顏色|色|color|colour/i;
const DAY = 86400_000;

interface Line {
  variantId: string;
  productTitle: string;
  options: string;
  qty: number;
  total: number;
  refundedQty: number;
}

const dateOk = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const tw = (d: string, end = false) => new Date(`${d}T${end ? "23:59:59.999" : "00:00:00"}+08:00`);

export const reportCenter = onCall({ timeoutSeconds: 300, memory: "1GiB", maxInstances: 3 }, async (req) => {
  const actor = await requireRole(req, "manager");
  const withCost = atLeast(actor.role, "owner");
  const from = req.data?.from;
  const to = req.data?.to;
  assert(dateOk(from) && dateOk(to) && from <= to, "日期區間不正確");
  const days = Math.round((tw(to).getTime() - tw(from).getTime()) / DAY) + 1;
  assert(days <= 400, "區間最多 400 天");
  const loc: string | null = typeof req.data?.locationId === "string" && req.data.locationId ? req.data.locationId : null;
  const includeOnline = req.data?.online !== false;

  const settings = (await db.doc("settings/shop").get()).data() ?? {};
  const commissionPct = Number(settings.commissionPct ?? 0);
  const commissionByUser: Record<string, number> = settings.commissionByUser ?? {};

  // ---- 資料 ----
  const [ordersSnap, refundSnap, variantsSnap, costsSnap, expensesSnap, usersSnap] = await Promise.all([
    db.collection("posOrders").where("businessDate", ">=", from).where("businessDate", "<=", to).get(),
    // 退款以「退款發生日」計：拿可能有退款的單（建立於區間開始前 400 天內）再依 refund.at 篩
    db.collection("posOrders").where("createdAt", ">=", new Date(tw(from).getTime() - 400 * DAY)).select("refunds", "locationId", "orderNo", "lines", "shopper").get(),
    db.collection("variants").get(),
    withCost ? db.collection("costs").get() : Promise.resolve(null),
    withCost ? db.collection("expenses").where("date", ">=", from).where("date", "<=", to).get() : Promise.resolve(null),
    db.collection("users").get(),
  ]);
  const variants = new Map(variantsSnap.docs.map((v) => [v.id, v.data()]));
  const cost = new Map<string, number>();
  costsSnap?.forEach((c) => c.data().avgCost != null && cost.set(c.id, c.data().avgCost));
  const userName = new Map(usersSnap.docs.map((u) => [u.id, u.data().name || u.data().email]));

  const orders = ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as FirebaseFirestore.DocumentData).filter((o) => !["pending", "canceled"].includes(o.status) && (!loc || o.locationId === loc));

  // ---- 營收 ----
  const sum = { orders: 0, items: 0, guests: 0, gross: 0, promo: 0, member: 0, orderDiscount: 0, allowance: 0, reward: 0, serviceFee: 0, sales: 0, refunds: 0, refundCount: 0, cogs: 0, refundCogs: 0 };
  const daily = new Map<string, { date: string; orders: number; sales: number; refunds: number; items: number; guests: number; onlineOrders: number; onlineSales: number }>();
  const dayRow = (date: string) => daily.get(date) ?? daily.set(date, { date, orders: 0, sales: 0, refunds: 0, items: 0, guests: 0, onlineOrders: 0, onlineSales: 0 }).get(date)!;
  const pay = new Map<string, { sales: number; refunds: number; count: number }>();
  const payRow = (m: string) => pay.get(m) ?? pay.set(m, { sales: 0, refunds: 0, count: 0 }).get(m)!;
  const byHour = new Array(24).fill(0).map((_, h) => ({ hour: h, orders: 0, sales: 0 }));
  const byWeekday = new Array(7).fill(0).map((_, w) => ({ weekday: w, orders: 0, sales: 0 }));

  // 商品／尺寸／顏色
  const prod = new Map<string, { productId: string; title: string; qty: number; sales: number; online: number; cogs: number }>();
  const size = new Map<string, { value: string; qty: number; sales: number; online: number }>();
  const color = new Map<string, { value: string; qty: number; sales: number; online: number }>();
  const sizeColor = new Map<string, number>();
  const optionOf = (vid: string) => {
    const v = variants.get(vid);
    const opts = (v?.optionList ?? []) as { name: string; value: string }[];
    return {
      productId: v?.productId ?? vid,
      title: v?.productTitle ?? "",
      size: opts.find((o) => SIZE_NAMES.test(o.name))?.value ?? (opts.length === 2 ? opts[1]?.value : null),
      color: opts.find((o) => COLOR_NAMES.test(o.name) && !SIZE_NAMES.test(o.name))?.value ?? (opts.length === 2 ? opts[0]?.value : null),
    };
  };
  const addItem = (vid: string, qty: number, sales: number, online: boolean) => {
    const o = optionOf(vid);
    const p = prod.get(o.productId) ?? prod.set(o.productId, { productId: o.productId, title: o.title, qty: 0, sales: 0, online: 0, cogs: 0 }).get(o.productId)!;
    if (online) p.online += qty;
    else {
      p.qty += qty;
      p.sales += sales;
      p.cogs += qty * (cost.get(vid) ?? 0);
    }
    for (const [map, val] of [
      [size, o.size],
      [color, o.color],
    ] as const) {
      if (!val) continue;
      const r = map.get(val) ?? map.set(val, { value: val, qty: 0, sales: 0, online: 0 }).get(val)!;
      if (online) r.online += qty;
      else {
        r.qty += qty;
        r.sales += sales;
      }
    }
    if (o.size && o.color) sizeColor.set(`${o.color}|${o.size}`, (sizeColor.get(`${o.color}|${o.size}`) ?? 0) + qty);
  };

  // 員工、會員
  const staff = new Map<string, { uid: string; name: string; orders: number; sales: number; items: number; refunds: number }>();
  const shopperOrders = new Map<string, { id: string; name: string; orders: number; sales: number; sizes: Map<string, number> }>();
  let memberSales = 0;
  let memberOrders = 0;
  let rewardUsed = 0;
  let rewardEarned = 0;

  for (const o of orders) {
    const t = o.createdAt?.toDate?.() as Date | undefined;
    sum.orders++;
    sum.items += o.itemCount ?? 0;
    sum.guests += o.guests ?? 0;
    sum.promo += o.promoTotal ?? 0;
    sum.member += o.memberDiscount ?? 0;
    sum.orderDiscount += o.orderDiscount ?? 0;
    sum.allowance += o.allowance ?? 0;
    sum.reward += o.rewardDiscount ?? 0;
    sum.serviceFee += o.serviceFee ?? 0;
    sum.sales += o.total ?? 0;
    sum.gross += (o.lines as Line[]).reduce((s, l) => s + l.total, 0) + (o.promoTotal ?? 0);
    rewardUsed += o.rewardPoints ?? 0;
    rewardEarned += o.rewardEarned ?? 0;
    const dr = dayRow(o.businessDate);
    dr.orders++;
    dr.sales += o.total ?? 0;
    dr.items += o.itemCount ?? 0;
    dr.guests += o.guests ?? 0;
    if (t) {
      const twTime = new Date(t.getTime() + 8 * 3600_000);
      byHour[twTime.getUTCHours()].orders++;
      byHour[twTime.getUTCHours()].sales += o.total ?? 0;
      byWeekday[twTime.getUTCDay()].orders++;
      byWeekday[twTime.getUTCDay()].sales += o.total ?? 0;
    }
    let changeLeft = o.change ?? 0;
    for (const p of o.payments ?? []) {
      let a = p.amount;
      if (p.method === "cash" && changeLeft > 0) {
        const c = Math.min(changeLeft, a);
        a -= c;
        changeLeft -= c;
      }
      const r = payRow(p.method);
      r.sales += a;
      r.count++;
    }
    for (const l of o.lines as Line[]) {
      addItem(l.variantId, l.qty, l.total, false);
      sum.cogs += l.qty * (cost.get(l.variantId) ?? 0);
    }
    const st = staff.get(o.cashier) ?? staff.set(o.cashier, { uid: o.cashier, name: userName.get(o.cashier) ?? o.cashierName, orders: 0, sales: 0, items: 0, refunds: 0 }).get(o.cashier)!;
    st.orders++;
    st.sales += o.total ?? 0;
    st.items += o.itemCount ?? 0;
    if (o.shopper?.id) {
      memberSales += o.total ?? 0;
      memberOrders++;
      const m = shopperOrders.get(o.shopper.id) ?? shopperOrders.set(o.shopper.id, { id: o.shopper.id, name: o.shopper.name || o.shopper.mobile || o.shopper.email, orders: 0, sales: 0, sizes: new Map() }).get(o.shopper.id)!;
      m.orders++;
      m.sales += o.total ?? 0;
      for (const l of o.lines as Line[]) {
        const s = optionOf(l.variantId).size;
        if (s) m.sizes.set(s, (m.sizes.get(s) ?? 0) + l.qty);
      }
    }
  }

  // 退款（依退款日期）
  const fromMs = tw(from).getTime();
  const toMs = tw(to, true).getTime();
  for (const d of refundSnap.docs) {
    const o = d.data();
    if (loc && o.locationId !== loc) continue;
    for (const r of o.refunds ?? []) {
      const at = r.at?.toMillis?.() ?? 0;
      if (at < fromMs || at > toMs) continue;
      sum.refunds += r.amount;
      sum.refundCount++;
      const date = new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
      dayRow(date).refunds += r.amount;
      for (const p of r.payments ?? []) payRow(p.method).refunds += p.amount;
      for (const w of r.lines ?? []) {
        const l = (o.lines ?? [])[w.index] as Line | undefined;
        if (!l) continue;
        sum.refundCogs += w.qty * (cost.get(l.variantId) ?? 0);
        const pr = prod.get(optionOf(l.variantId).productId);
        if (pr) pr.qty -= w.qty;
      }
      const st = staff.get(r.by);
      if (st) st.refunds += r.amount;
    }
  }

  // 網店銷量（尺寸／顏色／排行用）
  let onlineOrders = 0;
  let onlineSales = 0;
  let onlineItems = 0;
  let onlineReturned = 0;
  let onlineError: string | null = null;
  if (includeOnline) {
    try {
      let after: string | null = null;
      for (let page = 0; page < 100; page++) {
        const p = await ordersPage({ first: 50, after, query: { createdAt: { start: tw(from).toISOString(), end: tw(to, true).toISOString() } } });
        for (const e of p.edges) {
          const o = e.node;
          if (!o || o.status === "CANCELED") continue;
          if (o.status === "RETURN") {
            onlineReturned += o.totalPrice;
            continue;
          }
          onlineOrders++;
          onlineSales += o.totalPrice;
          const date = new Date(new Date(o.createdAt).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
          const dr = dayRow(date);
          dr.onlineOrders++;
          dr.onlineSales += o.totalPrice;
          for (const li of o.lineItems ?? []) {
            onlineItems += li.quantity;
            if (li.variant?.id) addItem(li.variant.id, li.quantity, li.totalPrice, true);
          }
        }
        if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor) break;
        after = p.pageInfo.endCursor;
        await sleep(800);
      }
    } catch (e) {
      onlineError = errMsg(e);
    }
  }

  // 會員：新客 / 回購
  let newMembers = 0;
  let returning = 0;
  if (shopperOrders.size) {
    const ids = [...shopperOrders.keys()];
    for (let i = 0; i < ids.length; i += 30) {
      const prior = await db.collection("posOrders").where("shopper.id", "in", ids.slice(i, i + 30)).where("businessDate", "<", from).select("shopper").get();
      const had = new Set(prior.docs.map((d) => d.data().shopper.id));
      ids.slice(i, i + 30).forEach((id) => (had.has(id) ? returning++ : newMembers++));
    }
  }
  const repeatInRange = [...shopperOrders.values()].filter((m) => m.orders >= 2).length;

  // 發票
  const inv = { issued: 0, amount: 0, voided: 0, failed: 0, needAllowance: 0, byType: {} as Record<string, number> };
  for (const o of orders) {
    if (o.invoice?.no) {
      inv.issued++;
      inv.amount += o.total ?? 0;
      inv.byType[o.invoice.type] = (inv.byType[o.invoice.type] ?? 0) + 1;
      if (o.invoice.voided) inv.voided++;
    } else if (o.invoiceError) inv.failed++;
    if (/折讓/.test(o.invoiceNote ?? "")) inv.needAllowance++;
  }

  // 斷碼：同款有些規格有貨、有些缺貨（依目前庫存）
  const byProduct = new Map<string, { title: string; vs: { options: string; stock: number }[] }>();
  for (const [, v] of variants) {
    if (!v.active) continue;
    const g = byProduct.get(v.productId) ?? byProduct.set(v.productId, { title: v.productTitle, vs: [] }).get(v.productId)!;
    g.vs.push({ options: v.options, stock: v.shopStock ?? 0 });
  }
  const brokenSizes = [...byProduct]
    .filter(([, g]) => g.vs.length > 1 && g.vs.some((x) => x.stock > 0) && g.vs.some((x) => x.stock <= 0))
    .map(([productId, g]) => ({ productId, title: g.title, out: g.vs.filter((x) => x.stock <= 0).map((x) => x.options), inStock: g.vs.filter((x) => x.stock > 0).length, total: g.vs.length, sold: prod.get(productId)?.qty ?? 0 }))
    .sort((a, b) => b.sold - a.sold || b.out.length - a.out.length)
    .slice(0, 200);

  const expenses = new Map<string, number>();
  let expenseTotal = 0;
  expensesSnap?.forEach((e) => {
    const x = e.data();
    if (loc && x.locationId && x.locationId !== loc) return;
    expenses.set(x.category, (expenses.get(x.category) ?? 0) + x.amount);
    expenseTotal += x.amount;
  });

  const net = sum.sales - sum.refunds;
  const round = (n: number) => Math.round(n);
  const result: Record<string, unknown> = {
    from,
    to,
    days,
    locationId: loc,
    generatedAt: Date.now(),
    revenue: {
      orders: sum.orders,
      items: sum.items,
      guests: sum.guests,
      gross: round(sum.gross),
      discounts: { promo: sum.promo, member: sum.member, order: sum.orderDiscount, allowance: sum.allowance, reward: sum.reward },
      discountTotal: sum.promo + sum.member + sum.orderDiscount + sum.allowance + sum.reward,
      serviceFee: sum.serviceFee,
      sales: sum.sales,
      refunds: sum.refunds,
      refundCount: sum.refundCount,
      net,
      avgTicket: sum.orders ? round(net / sum.orders) : 0,
      itemsPerOrder: sum.orders ? Math.round((sum.items / sum.orders) * 10) / 10 : 0,
      perGuest: sum.guests ? round(net / sum.guests) : null,
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byHour: byHour.filter((h) => h.orders),
    byWeekday,
    payments: [...pay].map(([method, r]) => ({ method, ...r, net: r.sales - r.refunds })).sort((a, b) => b.net - a.net),
    products: [...prod.values()]
      .map((p) => ({ productId: p.productId, title: p.title, store: p.qty, online: p.online, total: p.qty + p.online, sales: round(p.sales), ...(withCost ? { cogs: round(p.cogs), margin: round(p.sales - p.cogs) } : {}) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 100),
    sizes: [...size.values()].sort((a, b) => b.qty + b.online - (a.qty + a.online)),
    colors: [...color.values()].sort((a, b) => b.qty + b.online - (a.qty + a.online)),
    sizeColor: [...sizeColor].map(([k, qty]) => ({ color: k.split("|")[0], size: k.split("|")[1], qty })),
    brokenSizes,
    online: {
      included: includeOnline,
      orders: onlineOrders,
      sales: Math.round(onlineSales),
      items: onlineItems,
      returned: Math.round(onlineReturned),
      avgTicket: onlineOrders ? Math.round(onlineSales / onlineOrders) : 0,
      error: onlineError,
    },
    combined: { sales: Math.round(net + (includeOnline ? onlineSales : 0)), orders: sum.orders + (includeOnline ? onlineOrders : 0) },
    staff: [...staff.values()]
      .map((s) => {
        const pct = commissionByUser[s.uid] ?? commissionPct;
        const netSales = s.sales - s.refunds;
        return { ...s, name: s.name, net: netSales, avgTicket: s.orders ? round(netSales / s.orders) : 0, commissionPct: pct, commission: round((netSales * pct) / 100) };
      })
      .sort((a, b) => b.net - a.net),
    members: {
      memberOrders,
      memberSales,
      memberShare: sum.sales ? memberSales / sum.sales : 0,
      walkInOrders: sum.orders - memberOrders,
      shoppers: shopperOrders.size,
      newMembers,
      returning,
      repeatInRange,
      repeatRate: shopperOrders.size ? repeatInRange / shopperOrders.size : 0,
      rewardUsed,
      rewardEarned,
      top: [...shopperOrders.values()]
        .sort((a, b) => b.sales - a.sales)
        .slice(0, 30)
        .map((m) => ({ id: m.id, name: m.name, orders: m.orders, sales: m.sales, favSize: [...m.sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null })),
    },
    invoices: inv,
  };
  if (withCost) {
    const cogs = round(sum.cogs - sum.refundCogs);
    result.profit = {
      net,
      cogs,
      grossProfit: net - cogs,
      grossMargin: net ? (net - cogs) / net : null,
      expenses: [...expenses].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
      expenseTotal,
      netProfit: net - cogs - expenseTotal,
    };
  }
  return result;
});
