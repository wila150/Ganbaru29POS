import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth";
import { Badge, Empty } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call } from "../../firebase";
import { atLeast, downloadCsv, fmtTime, money, num, todayStr } from "../../lib/util";

interface Report {
  days: number;
  generatedAt: number;
  variantCount: number;
  outOfStock: number;
  stockoutRate: number;
  storeQty: number;
  onlineOrders: number;
  onlineError: string | null;
  scrapQty: number;
  ranking: { variantId: string; title: string; options: string; store: number; online: number; total: number }[];
  reorder: { variantId: string; title: string; options: string; stock: number; safety: number; reorderQty: number; location: string | null }[];
  inventoryValue?: number;
  cogs?: number;
  scrapLoss?: number;
  turnover?: number | null;
}

export function Reports() {
  const { profile } = useAuth();
  const { variants, settings } = useData();
  const isOwner = atLeast(profile?.role, "owner");
  const [days, setDays] = useState(30);
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setErr("");
    call<Report>("salesReport", { days })
      .then(setR)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const expiring = useMemo(() => {
    const limit = todayStr(new Date(Date.now() + (settings.expiryDays ?? 30) * 86400_000));
    return variants
      .flatMap((v) => (v.batches ?? []).filter((b) => b.exp && b.exp <= limit).map((b) => ({ v, b })))
      .sort((a, b) => a.b.exp!.localeCompare(b.b.exp!));
  }, [variants, settings.expiryDays]);
  const today = todayStr();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>報表</h1>
          <div className="muted small">{isOwner ? "老闆版（含成本）" : "店長版（不含成本）"} · {r && `產生於 ${fmtTime(r.generatedAt)}`}</div>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
        </select>
      </div>
      {loading && <div className="loading">計算中（會讀取 meepShop 網店訂單）…</div>}
      {err && <p className="error">{err}</p>}
      {r && !loading && (
        <>
          <div className="kpis">
            {isOwner && <Kpi label="庫存總值（成本）" value={money(r.inventoryValue)} />}
            {isOwner && <Kpi label={`近 ${r.days} 天門市銷貨成本`} value={money(r.cogs)} />}
            {isOwner && <Kpi label="周轉率（期間）" value={r.turnover == null ? "—" : r.turnover.toFixed(2)} hint="銷貨成本 ÷ 目前庫存總值" />}
            <Kpi label={`近 ${r.days} 天門市銷量`} value={`${num(r.storeQty)} 件`} />
            <Kpi label={`近 ${r.days} 天網店訂單`} value={`${num(r.onlineOrders)} 筆`} />
            <Kpi label="缺貨率" value={`${(r.stockoutRate * 100).toFixed(1)}%`} hint={`${r.outOfStock} / ${r.variantCount} 款`} />
            <Kpi label="報廢" value={`${num(r.scrapQty)} 件`} hint={isOwner ? `損失 ${money(r.scrapLoss)}` : undefined} />
          </div>
          {r.onlineError && <div className="notice notice-warn">網店訂單讀取失敗，排行只含門市：{r.onlineError}</div>}

          <section>
            <div className="row-between">
              <h2>門市＋網店銷量排行</h2>
              <button className="btn btn-sm" onClick={() => downloadCsv(`銷量排行_近${r.days}天.csv`, [["商品", "規格", "門市", "網店", "合計"], ...r.ranking.map((x) => [x.title, x.options, x.store, x.online, x.total])])}>
                匯出
              </button>
            </div>
            {r.ranking.length === 0 ? (
              <Empty>這段期間沒有銷售</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>商品</th>
                      <th className="num">門市</th>
                      <th className="num">網店</th>
                      <th className="num">合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.ranking.map((x, i) => (
                      <tr key={x.variantId}>
                        <td>{i + 1}</td>
                        <td>{x.options ? `${x.title}（${x.options}）` : x.title}</td>
                        <td className="num">{x.store}</td>
                        <td className="num">{x.online}</td>
                        <td className="num strong">{x.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <div className="row-between">
              <h2>建議補貨清單</h2>
              <button className="btn btn-sm" onClick={() => downloadCsv(`建議補貨_${today}.csv`, [["商品", "規格", "儲位", "目前庫存", "安全庫存", "建議補貨"], ...r.reorder.map((x) => [x.title, x.options, x.location, x.stock, x.safety, x.reorderQty])])}>
                匯出
              </button>
            </div>
            <p className="muted small">建議補貨 = 安全庫存 + 日均門市銷量 × 補貨到貨天數（{settings.leadDays ?? 7} 天）− 目前庫存，每天 9:00 更新。</p>
            {r.reorder.length === 0 ? (
              <Empty>目前不需要補貨</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>儲位</th>
                      <th className="num">庫存</th>
                      <th className="num">安全</th>
                      <th className="num">建議補</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.reorder.map((x) => (
                      <tr key={x.variantId}>
                        <td>{x.options ? `${x.title}（${x.options}）` : x.title}</td>
                        <td>{x.location || "—"}</td>
                        <td className="num">{x.stock}</td>
                        <td className="num">{x.safety}</td>
                        <td className="num strong">{x.reorderQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section>
        <h2>即將到期批次（{settings.expiryDays ?? 30} 天內）</h2>
        {expiring.length === 0 ? (
          <Empty>沒有即將到期的批次</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>有效期限</th>
                  <th>商品</th>
                  <th>批號</th>
                  <th className="num">數量</th>
                  <th>儲位</th>
                </tr>
              </thead>
              <tbody>
                {expiring.map(({ v, b }) => (
                  <tr key={`${v.id}-${b.id}`}>
                    <td>
                      {b.exp} {b.exp! < today && <Badge tone="bad">已過期</Badge>}
                    </td>
                    <td>{variantName(v)}</td>
                    <td>{b.lot || "—"}</td>
                    <td className="num">{b.qty}</td>
                    <td>{v.location || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}
