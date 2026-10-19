import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from "firebase/firestore";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../../auth";
import { Badge, Empty } from "../../components/ui";
import { daysSince, useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { useDeviceLocation } from "../../lib/location";
import { addDays, atLeast, downloadCsv, fmtTime, money, num, PAY_NAME, todayStr } from "../../lib/util";

interface Report {
  variantSales?: { variantId: string; productId: string; store: number; online: number; sales: number }[];
  from: string;
  to: string;
  days: number;
  generatedAt: number;
  revenue: {
    orders: number;
    items: number;
    guests: number;
    gross: number;
    discounts: { promo: number; member: number; order: number; allowance: number; reward: number };
    discountTotal: number;
    serviceFee: number;
    sales: number;
    refunds: number;
    refundCount: number;
    net: number;
    avgTicket: number;
    itemsPerOrder: number;
    perGuest: number | null;
  };
  daily: { date: string; orders: number; sales: number; refunds: number; items: number; guests: number; onlineOrders: number; onlineSales: number }[];
  byHour: { hour: number; orders: number; sales: number }[];
  byWeekday: { weekday: number; orders: number; sales: number }[];
  payments: { method: string; sales: number; refunds: number; net: number; count: number }[];
  products: { productId: string; title: string; store: number; online: number; total: number; sales: number; cogs?: number; margin?: number }[];
  sizes: { value: string; qty: number; sales: number; online: number }[];
  colors: { value: string; qty: number; sales: number; online: number }[];
  sizeColor: { color: string; size: string; qty: number }[];
  brokenSizes: { productId: string; title: string; out: string[]; inStock: number; total: number; sold: number }[];
  online: { included: boolean; orders: number; sales: number; items: number; returned: number; avgTicket: number; error: string | null };
  combined: { sales: number; orders: number };
  staff: { uid: string; name: string; orders: number; sales: number; items: number; refunds: number; net: number; avgTicket: number; commissionPct: number; commission: number }[];
  members: {
    memberOrders: number;
    memberSales: number;
    memberShare: number;
    walkInOrders: number;
    shoppers: number;
    newMembers: number;
    returning: number;
    repeatInRange: number;
    repeatRate: number;
    rewardUsed: number;
    rewardEarned: number;
    top: { id: string; name: string; orders: number; sales: number; favSize: string | null }[];
  };
  invoices: { issued: number; amount: number; voided: number; failed: number; needAllowance: number; byType: Record<string, number> };
  profit?: {
    net: number;
    cogs: number;
    grossProfit: number;
    grossMargin: number | null;
    expenses: { category: string; amount: number }[];
    expenseTotal: number;
    netProfit: number;
    storeNet?: number;
    storeCogs?: number;
    onlineSales?: number;
    onlineShipping?: number;
    onlineCogs?: number;
    onlineIncluded?: boolean;
    noCostItems?: number;
    fees?: { method: string; base: number; pct: number; fee: number }[];
    feeTotal?: number;
    actual?: number;
    opex?: { category: string; amount: number }[];
    opexTotal?: number;
    people?: { category: string; amount: number }[];
    peopleTotal?: number;
    purchaseTotal?: number;
  };
}

type Tab = "revenue" | "products" | "stock" | "members" | "payments" | "staff" | "profit" | "audit";
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

function presetRange(key: string): [string, string] {
  const t = todayStr();
  const d = new Date(`${t}T12:00:00+08:00`);
  const monthStart = `${t.slice(0, 8)}01`;
  switch (key) {
    case "today":
      return [t, t];
    case "yesterday":
      return [addDays(t, -1), addDays(t, -1)];
    case "week":
      return [addDays(t, -((d.getUTCDay() + 6) % 7)), t];
    case "month":
      return [monthStart, t];
    case "lastMonth": {
      const end = addDays(monthStart, -1);
      return [`${end.slice(0, 8)}01`, end];
    }
    case "30":
      return [addDays(t, -29), t];
    case "year":
      return [`${t.slice(0, 4)}-01-01`, t];
  }
  return [t, t];
}

export function Reports() {
  const { profile } = useAuth();
  const isOwner = atLeast(profile?.role, "owner");
  const { multi, locations } = useDeviceLocation();
  const [preset, setPreset] = useState("month");
  const [[from, to], setRange] = useState<[string, string]>(presetRange("month"));
  const [loc, setLoc] = useState("");
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState<Tab>("revenue");
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (tab === "stock" || tab === "audit") return;
    setLoading(true);
    setErr("");
    call<Report>("reportCenter", { from, to, locationId: loc || null, online })
      .then(setR)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [from, to, loc, online, tab === "stock" || tab === "audit"]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: [Tab, string][] = [
    ["revenue", "營收"],
    ["products", "商品／尺寸顏色"],
    ["stock", "庫存／斷碼／周轉"],
    ["members", "會員"],
    ["payments", "付款與發票"],
    ["staff", "員工業績"],
    ...(isOwner ? ([["profit", "損益"]] as [Tab, string][]) : []),
    ["audit", "操作紀錄"],
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>報表中心</h1>
          <div className="muted small">
            {isOwner ? "老闆版（含成本、毛利、損益）" : "店長版（不含成本）"}
            {r && ` · 產生於 ${fmtTime(r.generatedAt)}`}
          </div>
        </div>
      </div>
      <div className="filters">
        <select
          value={preset}
          onChange={(e) => {
            setPreset(e.target.value);
            if (e.target.value !== "custom") setRange(presetRange(e.target.value));
          }}
        >
          <option value="today">今天</option>
          <option value="yesterday">昨天</option>
          <option value="week">本週</option>
          <option value="month">本月</option>
          <option value="lastMonth">上個月</option>
          <option value="30">近 30 天</option>
          <option value="year">今年</option>
          <option value="custom">自訂</option>
        </select>
        <input type="date" value={from} max={to} onChange={(e) => (setPreset("custom"), setRange([e.target.value, to]))} />
        <span>～</span>
        <input type="date" value={to} min={from} max={todayStr()} onChange={(e) => (setPreset("custom"), setRange([from, e.target.value]))} />
        {multi && (
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">全部門市</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} /> 含網店銷量
        </label>
      </div>
      <div className="chips">
        {tabs.map(([k, l]) => (
          <button key={k} className={`chip ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab === "stock" ? (
        <StockTab />
      ) : tab === "audit" ? (
        <AuditTab />
      ) : loading ? (
        <div className="loading">計算中{online ? "（會讀取網店訂單）" : ""}…</div>
      ) : err ? (
        <p className="error">{err}</p>
      ) : !r ? null : (
        <>
          {r.online.error && <div className="notice notice-warn">網店訂單讀取失敗，網店數字不完整：{r.online.error}</div>}
          {tab === "revenue" && <RevenueTab r={r} />}
          {tab === "products" && <ProductsTab r={r} />}
          {tab === "members" && <MembersTab r={r} />}
          {tab === "payments" && <PaymentsTab r={r} />}
          {tab === "staff" && <StaffTab r={r} />}
          {tab === "profit" && r.profit && <ProfitTab r={r} />}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "bad" }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone === "bad" ? "error" : tone === "ok" ? "ok" : ""}`}>{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

function Section({ title, onExport, children }: { title: string; onExport?: () => void; children: React.ReactNode }) {
  return (
    <section>
      <div className="row-between">
        <h2>{title}</h2>
        {onExport && (
          <button className="btn btn-sm" onClick={onExport}>
            匯出 Excel
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function RevenueTab({ r }: { r: Report }) {
  const v = r.revenue;
  const d = v.discounts;
  const on = r.online;
  const maxDay = Math.max(1, ...r.daily.map((x) => x.sales - x.refunds + (on.included ? x.onlineSales : 0)));
  return (
    <>
      <div className="kpis kpis-split">
        <Kpi label="總營收（門市＋網店）" value={money(r.combined.sales)} hint={`${num(r.combined.orders)} 筆`} />
        <Kpi label="門市淨營收" value={money(v.net)} hint={`銷售 ${money(v.sales)} − 退貨 ${money(v.refunds)}`} />
        <Kpi
          label="網店營收"
          value={on.included ? money(on.sales) : "—"}
          hint={on.included ? `${num(on.orders)} 筆 · 客單價 ${money(on.avgTicket)}${on.returned ? ` · 退貨單 ${money(on.returned)}` : ""}` : "勾選「含網店銷量」才會統計"}
        />
      </div>
      <h3>門市</h3>
      <div className="kpis">
        <Kpi label="交易筆數" value={num(v.orders)} hint={`退貨 ${v.refundCount} 筆`} />
        <Kpi label="客單價" value={money(v.avgTicket)} hint={`每單 ${v.itemsPerOrder} 件`} />
        <Kpi label="來客數" value={num(v.guests)} hint={v.perGuest != null ? `每人 ${money(v.perGuest)}` : "結帳時輸入人數才會統計"} />
        <Kpi label="售出件數" value={num(v.items)} />
        <Kpi label="折扣合計" value={money(v.discountTotal)} hint={`原價 ${money(v.gross)}`} />
      </div>
      <Section title="折扣明細">
        <table className="table table-compact">
          <tbody>
            {(
              [
                ["促銷活動", d.promo],
                ["會員等級折扣", d.member],
                ["整單折扣", d.order],
                ["折讓", d.allowance],
                ["購物金折抵", d.reward],
                ["服務費（加收）", -v.serviceFee],
              ] as [string, number][]
            ).map(([k, n]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="num">{n < 0 ? `+${money(-n)}` : money(n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <p className="muted small">網店營收來自 meepShop 訂單金額（含運費、已扣網店折扣；不含已取消、退貨的訂單），依下單日期計算。</p>
      <Section
        title="每日營收"
        onExport={() =>
          downloadCsv(`每日營收_${r.from}_${r.to}.csv`, [
            ["日期", "門市筆數", "門市銷售", "門市退貨", "門市淨額", "網店筆數", "網店營收", "合計"],
            ...r.daily.map((x) => [x.date, x.orders, x.sales, x.refunds, x.sales - x.refunds, x.onlineOrders, x.onlineSales, x.sales - x.refunds + x.onlineSales]),
          ])
        }
      >
        {r.daily.length === 0 ? (
          <Empty>這段期間沒有交易</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>日期</th>
                  <th className="num">門市</th>
                  <th className="num">門市退貨</th>
                  <th className="num">網店</th>
                  <th className="num">合計</th>
                  <th className="bar-col" />
                </tr>
              </thead>
              <tbody>
                {r.daily.map((x) => (
                  <tr key={x.date}>
                    <td>
                      {x.date}（{WEEKDAY[new Date(`${x.date}T12:00:00+08:00`).getUTCDay()]}）
                    </td>
                    <td className="num">
                      {money(x.sales)}
                      <div className="muted small">{x.orders} 筆</div>
                    </td>
                    <td className="num">{x.refunds ? `-${money(x.refunds)}` : "—"}</td>
                    <td className="num">
                      {on.included ? money(x.onlineSales) : "—"}
                      {on.included && <div className="muted small">{x.onlineOrders} 筆</div>}
                    </td>
                    <td className="num strong">{money(x.sales - x.refunds + (on.included ? x.onlineSales : 0))}</td>
                    <td className="bar-col">
                      <span className="bar-stack">
                        <span className="bar" style={{ width: `${(Math.max(0, x.sales - x.refunds) / maxDay) * 100}%` }} title="門市" />
                        {on.included && <span className="bar bar-online" style={{ width: `${(x.onlineSales / maxDay) * 100}%` }} title="網店" />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <div className="two-col">
        <Section title="時段（幾點最多人）">
          <table className="table table-compact">
            <tbody>
              {r.byHour.map((h) => (
                <tr key={h.hour}>
                  <td>
                    {String(h.hour).padStart(2, "0")}:00
                  </td>
                  <td className="num">{h.orders} 筆</td>
                  <td className="num">{money(h.sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title="星期">
          <table className="table table-compact">
            <tbody>
              {r.byWeekday.map((w) => (
                <tr key={w.weekday}>
                  <td>星期{WEEKDAY[w.weekday]}</td>
                  <td className="num">{w.orders} 筆</td>
                  <td className="num">{money(w.sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </>
  );
}

/**
 * 單品規格排行：每個商品裡，哪個尺寸／顏色賣最好（或最差）。
 * 沒賣出的規格也列出來（0 件），從低到高時就看得到哪個顏色完全沒動。
 */
function VariantRank({ r }: { r: Report }) {
  const { variants } = useData();
  const [desc, setDesc] = useState(true);
  const [by, setBy] = useState<"qty" | "sales">("qty");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const sold = new Map((r.variantSales ?? []).map((x) => [x.variantId, x]));
    const m = new Map<string, { productId: string; title: string; total: number; amount: number; rows: { id: string; label: string; qty: number; store: number; online: number; amount: number; stock: number }[] }>();
    for (const v of variants) {
      const x = sold.get(v.id);
      const g = m.get(v.productId) ?? m.set(v.productId, { productId: v.productId, title: v.productTitle, total: 0, amount: 0, rows: [] }).get(v.productId)!;
      const qty = (x?.store ?? 0) + (x?.online ?? 0);
      g.rows.push({ id: v.id, label: v.options || "單一規格", qty, store: x?.store ?? 0, online: x?.online ?? 0, amount: x?.sales ?? 0, stock: v.shopStock ?? 0 });
      g.total += qty;
      g.amount += x?.sales ?? 0;
    }
    const key = (a: { qty: number; amount: number }) => (by === "qty" ? a.qty : a.amount);
    const dir = desc ? -1 : 1;
    const t = q.trim().toLowerCase();
    return [...m.values()]
      .filter((g) => g.rows.length > 1 && (!t || g.title.toLowerCase().includes(t)))
      .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => dir * (key(a) - key(b)) || a.label.localeCompare(b.label, "zh-Hant")) }))
      .sort((a, b) => dir * ((by === "qty" ? a.total - b.total : a.amount - b.amount)) || a.title.localeCompare(b.title, "zh-Hant"));
  }, [r, variants, desc, by, q]);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Section
      title="單品規格排行（每個商品哪個尺寸／顏色最好賣）"
      onExport={() =>
        downloadCsv(`單品規格排行_${r.from}_${r.to}.csv`, [
          ["商品", "規格", "名次", "門市件數", "網店件數", "合計件數", "金額", "目前庫存"],
          ...groups.flatMap((g) => g.rows.map((x, i) => [g.title, x.label, i + 1, x.store, x.online, x.qty, x.amount, x.stock])),
        ])
      }
    >
      <div className="filters">
        <input placeholder="搜尋商品" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips">
          <button className={`chip ${desc ? "active" : ""}`} onClick={() => setDesc(true)}>
            從高到低
          </button>
          <button className={`chip ${!desc ? "active" : ""}`} onClick={() => setDesc(false)}>
            從低到高
          </button>
          <span className="muted small">　依</span>
          <button className={`chip ${by === "qty" ? "active" : ""}`} onClick={() => setBy("qty")}>
            件數
          </button>
          <button className={`chip ${by === "sales" ? "active" : ""}`} onClick={() => setBy("sales")}>
            金額
          </button>
        </div>
      </div>
      {groups.length === 0 ? (
        <Empty>沒有多規格的商品</Empty>
      ) : (
        <div className="vrank">
          {groups.slice(0, 150).map((g) => {
            const max = Math.max(1, ...g.rows.map((x) => (by === "qty" ? x.qty : x.amount)));
            const expanded = open.has(g.productId);
            const shown = expanded ? g.rows : g.rows.slice(0, 3);
            return (
              <div key={g.productId} className="vrank-item">
                <div className="row-between">
                  <strong>{g.title}</strong>
                  <span className="muted small">
                    共 {g.total} 件　{money(g.amount)}
                  </span>
                </div>
                {shown.map((x, i) => {
                  const v = by === "qty" ? x.qty : x.amount;
                  return (
                    <div key={x.id} className="vrank-row">
                      <span className="vrank-no">{desc && v > 0 && i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}</span>
                      <span className="vrank-label">{x.label}</span>
                      <span className="vrank-bar">
                        <span style={{ width: `${(v / max) * 100}%` }} />
                      </span>
                      <span className="num vrank-val">{by === "qty" ? `${x.qty} 件` : money(x.amount)}</span>
                      <span className="muted small vrank-stock">庫存 {x.stock}</span>
                    </div>
                  );
                })}
                {g.rows.length > 3 && (
                  <button className="link-btn small" onClick={() => toggle(g.productId)}>
                    {expanded ? "收起" : `看全部 ${g.rows.length} 個規格`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted small">件數＝門市＋網店；只列有 2 個以上規格的商品。從低到高可以看出哪個顏色、尺寸賣不動。</p>
    </Section>
  );
}

function ProductsTab({ r }: { r: Report }) {
  const showCost = r.products.some((p) => p.cogs !== undefined);
  const sizes = useMemo(() => [...new Set(r.sizeColor.map((x) => x.size))], [r]);
  const colors = useMemo(() => [...new Set(r.sizeColor.map((x) => x.color))], [r]);
  const cell = (c: string, s: string) => r.sizeColor.find((x) => x.color === c && x.size === s)?.qty ?? 0;
  const maxCell = Math.max(1, ...r.sizeColor.map((x) => x.qty));
  return (
    <>
      <p className="muted small">門市銷量為淨額（扣退貨）；網店銷量來自 meepShop 訂單（{r.online.included ? `${r.online.orders} 筆` : "未包含"}）。</p>
      <div className="two-col">
        <Section title="尺寸銷售" onExport={() => downloadCsv(`尺寸銷售_${r.from}_${r.to}.csv`, [["尺寸", "門市件數", "網店件數", "門市金額"], ...r.sizes.map((x) => [x.value, x.qty, x.online, x.sales])])}>
          <OptionTable rows={r.sizes} label="尺寸" />
        </Section>
        <Section title="顏色銷售" onExport={() => downloadCsv(`顏色銷售_${r.from}_${r.to}.csv`, [["顏色", "門市件數", "網店件數", "門市金額"], ...r.colors.map((x) => [x.value, x.qty, x.online, x.sales])])}>
          <OptionTable rows={r.colors} label="顏色" />
        </Section>
      </div>
      {sizes.length > 0 && colors.length > 0 && (
        <Section title="顏色 × 尺寸（件數，門市＋網店）">
          <div className="matrix-wrap">
            <table className="matrix heat">
              <thead>
                <tr>
                  <th />
                  {sizes.map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {colors.map((c) => (
                  <tr key={c}>
                    <th>{c}</th>
                    {sizes.map((s) => {
                      const q = cell(c, s);
                      return (
                        <td key={s} style={{ background: q ? `rgba(37, 99, 235, ${0.08 + (q / maxCell) * 0.6})` : undefined }}>
                          {q || ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      <VariantRank r={r} />
      <Section
        title="商品銷售排行"
        onExport={() =>
          downloadCsv(`商品排行_${r.from}_${r.to}.csv`, [["商品", "門市件數", "網店件數", "合計", "門市金額", ...(showCost ? ["成本", "毛利"] : [])], ...r.products.map((p) => [p.title, p.store, p.online, p.total, p.sales, ...(showCost ? [p.cogs, p.margin] : [])])])
        }
      >
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>#</th>
                <th>商品</th>
                <th className="num">門市</th>
                <th className="num">網店</th>
                <th className="num">合計</th>
                <th className="num">門市金額</th>
                {showCost && <th className="num">毛利</th>}
              </tr>
            </thead>
            <tbody>
              {r.products.map((p, i) => (
                <tr key={p.productId}>
                  <td>{i + 1}</td>
                  <td>{p.title}</td>
                  <td className="num">{p.store}</td>
                  <td className="num">{p.online}</td>
                  <td className="num strong">{p.total}</td>
                  <td className="num">{money(p.sales)}</td>
                  {showCost && <td className="num">{money(p.margin)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="斷碼（同款部分規格缺貨，依目前庫存）" onExport={() => downloadCsv(`斷碼_${todayStr()}.csv`, [["商品", "缺貨規格", "有貨規格數", "總規格數", "期間門市銷量"], ...r.brokenSizes.map((b) => [b.title, b.out.join("、"), b.inStock, b.total, b.sold])])}>
        {r.brokenSizes.length === 0 ? (
          <Empty>沒有斷碼的商品</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>缺貨規格</th>
                  <th className="num">有貨</th>
                  <th className="num">期間銷量</th>
                </tr>
              </thead>
              <tbody>
                {r.brokenSizes.map((b) => (
                  <tr key={b.productId}>
                    <td>{b.title}</td>
                    <td>
                      {b.out.map((o) => (
                        <Badge key={o} tone="bad">
                          {o}
                        </Badge>
                      ))}
                    </td>
                    <td className="num">
                      {b.inStock}/{b.total}
                    </td>
                    <td className="num">{b.sold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function OptionTable({ rows, label }: { rows: { value: string; qty: number; sales: number; online: number }[]; label: string }) {
  const max = Math.max(1, ...rows.map((x) => x.qty + x.online));
  if (!rows.length) return <Empty>沒有{label}資料（商品規格名稱需含「{label}」）</Empty>;
  return (
    <table className="table table-compact">
      <thead>
        <tr>
          <th>{label}</th>
          <th className="num">門市</th>
          <th className="num">網店</th>
          <th className="bar-col" />
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <tr key={x.value}>
            <td>{x.value}</td>
            <td className="num">{x.qty}</td>
            <td className="num">{x.online}</td>
            <td className="bar-col">
              <span className="bar" style={{ width: `${((x.qty + x.online) / max) * 100}%` }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 庫存面（不受日期影響）：周轉天數、補貨、即將到期 — 用即時資料在前端算。 */
function StockTab() {
  const { variants, settings } = useData();
  const rows = useMemo(
    () =>
      variants
        .filter((v) => (v.shopStock ?? 0) > 0)
        .map((v) => {
          const perDay = (v.sales30 ?? 0) / 30;
          return { v, perDay, daysOfStock: perDay > 0 ? Math.round((v.shopStock ?? 0) / perDay) : null, lastSold: daysSince(v.lastSoldAt) };
        }),
    [variants]
  );
  const slowest = [...rows].sort((a, b) => (b.daysOfStock ?? 99999) - (a.daysOfStock ?? 99999)).slice(0, 100);
  const reorder = variants.filter((v) => (v.reorderQty ?? 0) > 0).sort((a, b) => (b.reorderQty ?? 0) - (a.reorderQty ?? 0));
  const limit = todayStr(new Date(Date.now() + (settings.expiryDays ?? 30) * 86400_000));
  const expiring = variants.flatMap((v) => (v.batches ?? []).filter((b) => b.exp && b.exp <= limit).map((b) => ({ v, b }))).sort((a, b) => a.b.exp!.localeCompare(b.b.exp!));
  const withSales = rows.filter((x) => x.daysOfStock != null);
  const avgDays = withSales.length ? Math.round(withSales.reduce((s, x) => s + x.daysOfStock!, 0) / withSales.length) : null;
  return (
    <>
      <div className="kpis">
        <Kpi label="有庫存款式" value={num(rows.length)} />
        <Kpi label="平均可賣天數" value={avgDays == null ? "—" : `${avgDays} 天`} hint="目前庫存 ÷ 近 30 天日均銷量（門市＋網店）" />
        <Kpi label="30 天沒賣出" value={num(rows.filter((x) => x.perDay === 0).length)} hint="有庫存但近 30 天零銷量" tone="bad" />
        <Kpi label="建議補貨" value={`${reorder.length} 款`} />
      </div>
      <Section
        title="周轉最慢（庫存要賣最久）"
        onExport={() => downloadCsv(`周轉天數_${todayStr()}.csv`, [["商品", "庫存", "近30天銷量", "可賣天數", "最後賣出(天前)"], ...slowest.map((x) => [variantName(x.v), x.v.shopStock, x.v.sales30 ?? 0, x.daysOfStock ?? "30天無銷售", x.lastSold ?? ">120"])])}
      >
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>商品</th>
                <th className="num">庫存</th>
                <th className="num">近 30 天銷量</th>
                <th className="num">可賣天數</th>
                <th>最後賣出</th>
              </tr>
            </thead>
            <tbody>
              {slowest.map((x) => (
                <tr key={x.v.id}>
                  <td>{variantName(x.v)}</td>
                  <td className="num">{x.v.shopStock}</td>
                  <td className="num">{x.v.sales30 ?? 0}</td>
                  <td className="num">{x.daysOfStock == null ? <span className="error">無銷售</span> : `${x.daysOfStock} 天`}</td>
                  <td>{x.lastSold == null ? "120 天以上" : `${x.lastSold} 天前`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="建議補貨" onExport={() => downloadCsv(`建議補貨_${todayStr()}.csv`, [["商品", "儲位", "庫存", "安全庫存", "建議補貨"], ...reorder.map((v) => [variantName(v), v.location, v.shopStock, v.safety, v.reorderQty])])}>
        {reorder.length === 0 ? (
          <Empty>目前不需要補貨</Empty>
        ) : (
          <table className="table table-compact">
            <tbody>
              {reorder.slice(0, 100).map((v) => (
                <tr key={v.id}>
                  <td>{variantName(v)}</td>
                  <td>{v.location || "—"}</td>
                  <td className="num">庫存 {v.shopStock}</td>
                  <td className="num strong">補 {v.reorderQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {expiring.length > 0 && (
        <Section title={`即將到期批次（${settings.expiryDays ?? 30} 天內）`}>
          <table className="table table-compact">
            <tbody>
              {expiring.map(({ v, b }) => (
                <tr key={`${v.id}-${b.id}`}>
                  <td>{b.exp}</td>
                  <td>{variantName(v)}</td>
                  <td>{b.lot || "—"}</td>
                  <td className="num">{b.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

function MembersTab({ r }: { r: Report }) {
  const m = r.members;
  return (
    <>
      <div className="kpis">
        <Kpi label="會員消費佔比" value={pct(m.memberShare)} hint={`會員 ${money(m.memberSales)}／${m.memberOrders} 筆`} />
        <Kpi label="非會員交易" value={`${m.walkInOrders} 筆`} />
        <Kpi label="消費會員數" value={num(m.shoppers)} hint={`新客 ${m.newMembers}、舊客 ${m.returning}`} />
        <Kpi label="期間內回購率" value={pct(m.repeatRate)} hint={`${m.repeatInRange} 位買了 2 次以上`} />
        <Kpi label="購物金" value={`用 ${num(m.rewardUsed)}／發 ${num(m.rewardEarned)}`} hint="門市折抵與回饋（點）" />
      </div>
      <p className="muted small">新客 = 這段期間之前沒有門市消費紀錄的會員。購物金餘額與到期以 meepShop 為準。</p>
      <Section title="消費最多的會員" onExport={() => downloadCsv(`會員排行_${r.from}_${r.to}.csv`, [["會員", "筆數", "金額", "常買尺寸"], ...m.top.map((x) => [x.name, x.orders, x.sales, x.favSize])])}>
        {m.top.length === 0 ? (
          <Empty>這段期間沒有會員消費</Empty>
        ) : (
          <table className="table table-compact">
            <thead>
              <tr>
                <th>會員</th>
                <th className="num">筆數</th>
                <th className="num">金額</th>
                <th>常買尺寸</th>
              </tr>
            </thead>
            <tbody>
              {m.top.map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td className="num">{x.orders}</td>
                  <td className="num">{money(x.sales)}</td>
                  <td>{x.favSize ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function PaymentsTab({ r }: { r: Report }) {
  const total = r.payments.reduce((s, p) => s + p.net, 0) || 1;
  const inv = r.invoices;
  const TYPE: Record<string, string> = { print: "紙本", mobile: "手機條碼", taxId: "統編", donate: "捐贈" };
  return (
    <>
      <Section title="付款方式" onExport={() => downloadCsv(`付款方式_${r.from}_${r.to}.csv`, [["方式", "收款", "退款", "淨額", "筆數"], ...r.payments.map((p) => [PAY_NAME[p.method] ?? p.method, p.sales, p.refunds, p.net, p.count])])}>
        <table className="table table-compact">
          <thead>
            <tr>
              <th>方式</th>
              <th className="num">收款</th>
              <th className="num">退款</th>
              <th className="num">淨額</th>
              <th className="num">佔比</th>
              <th className="bar-col" />
            </tr>
          </thead>
          <tbody>
            {r.payments.map((p) => (
              <tr key={p.method}>
                <td>{PAY_NAME[p.method] ?? p.method}</td>
                <td className="num">{money(p.sales)}</td>
                <td className="num">{p.refunds ? `-${money(p.refunds)}` : "—"}</td>
                <td className="num strong">{money(p.net)}</td>
                <td className="num">{pct(p.net / total)}</td>
                <td className="bar-col">
                  <span className="bar" style={{ width: `${Math.max(0, p.net / total) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">「換貨抵用」是退回商品折抵新單的金額，不是實際收款。</p>
      </Section>
      <Section title="電子發票">
        <div className="kpis">
          <Kpi label="已開立" value={`${inv.issued} 張`} hint={`金額 ${money(inv.amount)}`} />
          <Kpi label="已作廢" value={`${inv.voided} 張`} />
          <Kpi label="開立失敗" value={`${inv.failed} 張`} tone={inv.failed ? "bad" : undefined} hint="可在交易瀏覽重開" />
          <Kpi label="待開折讓" value={`${inv.needAllowance} 張`} tone={inv.needAllowance ? "bad" : undefined} hint="部分退貨，請到綠界後台開" />
        </div>
        <p className="muted small">
          載具：{Object.entries(inv.byType).map(([k, n]) => `${TYPE[k] ?? k} ${n}`).join("、") || "—"}。報稅以綠界後台的發票明細為準。
        </p>
      </Section>
    </>
  );
}

function StaffTab({ r }: { r: Report }) {
  return (
    <Section
      title="員工銷售業績"
      onExport={() => downloadCsv(`員工業績_${r.from}_${r.to}.csv`, [["員工", "筆數", "件數", "銷售", "退貨", "淨額", "客單價", "抽成%", "抽成"], ...r.staff.map((s) => [s.name, s.orders, s.items, s.sales, s.refunds, s.net, s.avgTicket, s.commissionPct, s.commission])])}
    >
      {r.staff.length === 0 ? (
        <Empty>這段期間沒有交易</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>員工</th>
                <th className="num">筆數</th>
                <th className="num">件數</th>
                <th className="num">淨額</th>
                <th className="num">客單價</th>
                <th className="num">抽成</th>
              </tr>
            </thead>
            <tbody>
              {r.staff.map((s) => (
                <tr key={s.uid}>
                  <td>{s.name}</td>
                  <td className="num">{s.orders}</td>
                  <td className="num">{s.items}</td>
                  <td className="num strong">
                    {money(s.net)}
                    {s.refunds > 0 && <div className="muted small">退 {money(s.refunds)}</div>}
                  </td>
                  <td className="num">{money(s.avgTicket)}</td>
                  <td className="num">
                    {money(s.commission)}
                    <div className="muted small">{s.commissionPct}%</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">業績算在結帳的收銀員；退貨扣在辦理退貨的人。抽成比例在「設定 → 員工抽成」調整。出勤工時請看「打卡」頁。</p>
    </Section>
  );
}

function ProfitTab({ r }: { r: Report }) {
  const p = r.profit!;
  const fees = p.fees ?? [];
  const feeTotal = p.feeTotal ?? 0;
  const actual = p.actual ?? p.net;
  const opex = p.opex ?? p.expenses;
  const people = p.people ?? [];
  const opexTotal = p.opexTotal ?? p.expenseTotal;
  const peopleTotal = p.peopleTotal ?? 0;
  const feeName = (m: string) => (m === "online" ? "網店金流" : PAY_NAME[m] ?? m);
  const Row = ({ label, value, cls = "", minus = false }: { label: ReactNode; value: number; cls?: string; minus?: boolean }) => (
    <tr className={cls}>
      <td>{label}</td>
      <td className="num">{minus ? `−${money(value)}` : money(value)}</td>
    </tr>
  );
  const csv = () =>
    downloadCsv(`三階損益_${r.from}_${r.to}.csv`, [
      ["項目", "金額"],
      ["當期銷售總額", p.net],
      ...fees.map((f) => [`金流手續費：${feeName(f.method)} ${money(f.base)} × ${f.pct}%`, -f.fee]),
      ["【實際總收入】", actual],
      ["已銷商品總成本", -p.cogs],
      ["【營業毛利】", p.grossProfit],
      ...opex.map((e) => [`營業雜支：${e.category}`, -e.amount]),
      ...people.map((e) => [`人事薪資與老闆提款：${e.category}`, -e.amount]),
      ["【當期淨收入】", p.netProfit],
    ]);
  return (
    <>
      <div className="kpis">
        <Kpi label="實際總收入" value={money(actual)} hint={`銷售 ${money(p.net)} − 手續費 ${money(feeTotal)}`} />
        <Kpi label="營業毛利" value={money(p.grossProfit)} hint={`毛利率 ${pct(p.grossMargin)}`} />
        <Kpi label="營運總開銷" value={money(opexTotal + peopleTotal)} />
        <Kpi label="當期淨收入" value={money(p.netProfit)} tone={p.netProfit < 0 ? "bad" : "ok"} hint={p.netProfit > 0 ? "店鋪有真正賺錢" : "這段期間沒有賺錢"} />
      </div>
      <Section title="三階損益" onExport={csv}>
        <table className="table table-compact pl3">
          <tbody>
            <Row label="當期銷售總額（顧客付的金額，扣退貨）" value={p.net} />
            {p.onlineIncluded && (
              <>
                <tr className="sub">
                  <td>門市 {money(p.storeNet ?? 0)}　網店 {money(p.onlineSales ?? 0)}（含運費 {money(p.onlineShipping ?? 0)}）</td>
                  <td />
                </tr>
              </>
            )}
            {fees.length ? (
              fees.map((f) => <Row key={f.method} cls="minus" minus label={`➖ 金流手續費：${feeName(f.method)}（${money(f.base)} × ${f.pct}%）`} value={f.fee} />)
            ) : (
              <Row cls="minus" minus label="➖ 金流手續費（沒有設定手續費 %）" value={0} />
            )}
            <Row cls="tier" label="＝ 【實際總收入】" value={actual} />
            <Row cls="minus" minus label="➖ 已銷商品總成本（賣出商品的成本 × 數量）" value={p.cogs} />
            {p.onlineIncluded && (
              <tr className="sub">
                <td>門市 {money(p.storeCogs ?? 0)}　網店 {money(p.onlineCogs ?? 0)}</td>
                <td />
              </tr>
            )}
            <Row cls="tier" label={<>＝ 【營業毛利】<span className="muted small">　毛利率 {pct(p.grossMargin)}</span></>} value={p.grossProfit} />
            <Row cls="minus" minus label="➖ 營業雜支（店租、水電、包材、行銷…）" value={opexTotal} />
            {opex.map((e) => (
              <tr key={e.category} className="sub">
                <td>{e.category}</td>
                <td className="num">−{money(e.amount)}</td>
              </tr>
            ))}
            <Row cls="minus" minus label="➖ 人事薪資與老闆提款" value={peopleTotal} />
            {people.map((e) => (
              <tr key={e.category} className="sub">
                <td>{e.category}</td>
                <td className="num">−{money(e.amount)}</td>
              </tr>
            ))}
            <Row cls={`tier final ${p.netProfit < 0 ? "bad" : ""}`} label="＝ 【當期淨收入】" value={p.netProfit} />
          </tbody>
        </table>
        <p className="muted small">
          手續費 % 在「設定 → 金流管理 → 付款方式」調整（LINE Pay 預設 5%）；開支在「報表 → 開支」登記，哪些分類算人事／老闆提款在「設定 → 抽成與開支」勾選。
          {p.purchaseTotal ? `本期「進貨」開支 ${money(p.purchaseTotal)} 沒有扣（已經算在已銷商品總成本，避免重複扣）。` : ""}
          {p.noCostItems ? `有 ${p.noCostItems} 件商品沒有成本（例：用「新品」結帳的），以 0 計。` : ""}
        </p>
      </Section>
    </>
  );
}

interface AuditLog {
  id: string;
  action: string;
  byName: string;
  role: string;
  detail: Record<string, unknown>;
  at: Timestamp | null;
}
const ACTION: Record<string, string> = {
  "pos.void": "作廢交易",
  "pos.refund": "退貨",
  "pos.discount": "改價／折扣",
  "shift.close": "日結交班",
  "drawer.in": "錢櫃存入",
  "drawer.out": "錢櫃提出",
  "staff.role": "改員工角色",
  "staff.enable": "啟用員工",
  "staff.disable": "停用員工",
  "staff.invite": "邀請員工",
  "settings.meepshopKey": "更換 meepShop 金鑰",
  "movement.retry": "重送庫存同步",
  "movement.confirm": "確認庫存已套用",
  "movement.dismiss": "標記庫存已處理",
  "stocktake.apply": "套用盤點",
  "attendance.fix": "修正打卡",
  "attendance.add": "補登打卡",
};

function AuditTab() {
  const [list, setList] = useState<AuditLog[]>([]);
  const [filter, setFilter] = useState("");
  useEffect(() => onSnapshot(query(collection(db, "auditLogs"), orderBy("at", "desc"), limit(500)), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as AuditLog))), []);
  const rows = list.filter((l) => !filter || l.action === filter);
  const summary = (l: AuditLog) => {
    const d = l.detail as Record<string, unknown>;
    if (d.orderNo) return `${d.orderNo}${d.amount != null ? ` ${money(d.amount as number)}` : ""}${d.reason ? `（${d.reason}）` : ""}`;
    if (l.action === "shift.close") return `應有 ${money(d.expectedCash as number)}、實點 ${money(d.countedCash as number)}、差額 ${money(d.diff as number)}`;
    if (l.action.startsWith("drawer.")) return `${money(d.amount as number)} ${d.note ?? ""}${d.expenseCategory ? `（開支：${d.expenseCategory}）` : ""}`;
    if (l.action.startsWith("staff.")) return `${d.name ?? d.email ?? ""} ${d.from ? `${d.from} → ${d.to}` : d.role ?? ""}`;
    return Object.entries(d)
      .filter(([, v]) => typeof v !== "object")
      .map(([k, v]) => `${k}: ${v}`)
      .join("、");
  };
  return (
    <Section title="操作紀錄（最近 500 筆）" onExport={() => downloadCsv(`操作紀錄_${todayStr()}.csv`, [["時間", "人員", "動作", "內容"], ...rows.map((l) => [fmtTime(l.at), l.byName, ACTION[l.action] ?? l.action, summary(l)])])}>
      <div className="filters">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部動作</option>
          {Object.entries(ACTION).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <Empty>沒有紀錄</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-compact">
            <tbody>
              {rows.map((l) => (
                <Fragment key={l.id}>
                  <tr>
                    <td>{fmtTime(l.at)}</td>
                    <td>{l.byName}</td>
                    <td>{ACTION[l.action] ?? l.action}</td>
                    <td className="small">{summary(l)}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">紀錄只能新增、不能修改或刪除。庫存異動的詳細紀錄在「異動紀錄」頁。</p>
    </Section>
  );
}
