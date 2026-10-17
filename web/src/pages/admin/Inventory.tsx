import { collection, limit, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { QrImg } from "../../components/QrImg";
import { VariantMatrix } from "../../components/VariantMatrix";
import { useAuth } from "../../auth";
import { Badge, Empty, Modal, SyncBadge, useAction } from "../../components/ui";
import { daysSince, isSlow, SLOW_DAYS, stockAge, stockState, useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { searchVariants } from "../../lib/lookup";
import { atLeast, fmtTime, MOVE_LABEL, todayStr } from "../../lib/util";
import type { Movement, Variant } from "../../types";

type Filter = "all" | "low" | "out" | "expiring" | "slow" | "failed";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "low", label: "低庫存" },
  { key: "out", label: "缺貨" },
  { key: "expiring", label: "即將到期" },
  { key: "slow", label: `滯銷（${SLOW_DAYS} 天沒賣）` },
  { key: "failed", label: "同步失敗" },
];
type Sort = "name" | "sales" | "lastSold" | "age" | "stock";
const SORTS: { key: Sort; label: string }[] = [
  { key: "name", label: "名稱" },
  { key: "sales", label: "近 30 天銷量（多→少）" },
  { key: "lastSold", label: "最久沒賣出" },
  { key: "age", label: "庫存放最久" },
  { key: "stock", label: "庫存（多→少）" },
];

const STATE_BADGE = {
  out: <Badge tone="bad">缺貨</Badge>,
  low: <Badge tone="warn">低庫存</Badge>,
  expiring: <Badge tone="warn">即將到期</Badge>,
  ok: <Badge tone="ok">正常</Badge>,
};

export function LastSold({ v }: { v: Variant }) {
  if (!v.statsAt) return <span className="muted">—</span>;
  const d = daysSince(v.lastSoldAt);
  if (d === null) return <span className="error">120 天以上</span>;
  return <span className={d >= SLOW_DAYS ? "error" : ""}>{d === 0 ? "今天" : `${d} 天前`}</span>;
}

export function AgeCell({ v }: { v: Variant }) {
  const a = stockAge(v);
  if (!a) return <span className="muted">—</span>;
  return (
    <span title={a.basis === "batch" ? "最早一批進貨距今" : "沒有進貨批次紀錄，從 meepShop 上架日起算"}>
      {a.days} 天{a.basis === "listed" && <small className="muted">（上架）</small>}
    </span>
  );
}

export function Inventory() {
  const { variants, settings } = useData();
  const { profile } = useAuth();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Variant | null>(null);
  const { busy, run } = useAction();
  const expiryDays = settings.expiryDays ?? 30;

  useEffect(
    () =>
      onSnapshot(query(collection(db, "movements"), where("status", "in", ["failed", "unknown"]), limit(500)), (s) => setFailedIds(new Set(s.docs.map((d) => d.data().variantId)))),
    []
  );

  const rows = useMemo(() => {
    let list = searchVariants(variants, q);
    if (filter === "failed") list = list.filter((v) => failedIds.has(v.id));
    else if (filter === "slow") list = list.filter(isSlow);
    else if (filter !== "all") list = list.filter((v) => stockState(v, expiryDays) === filter);
    const byName = (a: Variant, b: Variant) => a.productTitle.localeCompare(b.productTitle, "zh-Hant") || a.variantIndex - b.variantIndex;
    const lastSoldDays = (v: Variant) => (v.lastSoldAt ? daysSince(v.lastSoldAt)! : 9999);
    const cmp: Record<Sort, (a: Variant, b: Variant) => number> = {
      name: byName,
      sales: (a, b) => (b.sales30 ?? 0) - (a.sales30 ?? 0) || byName(a, b),
      lastSold: (a, b) => lastSoldDays(b) - lastSoldDays(a) || (b.shopStock ?? 0) - (a.shopStock ?? 0),
      age: (a, b) => (stockAge(b)?.days ?? -1) - (stockAge(a)?.days ?? -1) || byName(a, b),
      stock: (a, b) => (b.shopStock ?? 0) - (a.shopStock ?? 0) || byName(a, b),
    };
    return [...list].sort(cmp[sort]);
  }, [variants, q, filter, sort, failedIds, expiryDays]);

  const counts = useMemo(() => {
    const c = { all: variants.length, low: 0, out: 0, expiring: 0, slow: 0, failed: 0 };
    for (const v of variants) {
      const s = stockState(v, expiryDays);
      if (s !== "ok") c[s]++;
      if (isSlow(v)) c.slow++;
      if (failedIds.has(v.id)) c.failed++;
    }
    return c;
  }, [variants, failedIds, expiryDays]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>庫存查詢</h1>
          <div className="muted small">
            銷售統計更新於 {fmtTime(settings.statsAt)}（每天 9:00 自動更新，含門市與網店）
            {settings.statsOnlineError && <span className="error">　網店訂單讀取失敗：{settings.statsOnlineError}</span>}
          </div>
        </div>
        {atLeast(profile?.role, "manager") && (
          <button className="btn" disabled={busy} onClick={() => run(() => call("refreshStats"), "銷售統計已更新")}>
            {busy ? "計算中（會讀取網店訂單）…" : "更新銷售統計"}
          </button>
        )}
      </div>
      <div className="filters">
        <input className="search grow" placeholder="搜尋名稱、商品編號、條碼、儲位" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 260px", marginBottom: 0 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="排序">
          {SORTS.map((x) => (
            <option key={x.key} value={x.key}>
              排序：{x.label}
            </option>
          ))}
        </select>
      </div>
      <div className="chips">
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip ${filter === f.key ? "active" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label} <span className="chip-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty>沒有符合的商品</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>商品（規格）</th>
                <th>儲位</th>
                <th className="num">庫存</th>
                <th className="num">近 30 天銷量</th>
                <th>最後賣出</th>
                <th>庫齡</th>
                <th className="num">安全庫存</th>
                <th className="num">建議補貨</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((v) => (
                <tr key={v.id} onClick={() => setOpen(v)}>
                  <td>
                    <div>{v.productTitle}</div>
                    <small className="muted">
                      {v.options || "單一規格"} {v.sku && `· ${v.sku}`}
                    </small>
                  </td>
                  <td>{v.location || "—"}</td>
                  <td className="num strong">{v.shopStock ?? "—"}</td>
                  <td className="num">
                    {v.statsAt ? (
                      <span title={`門市 ${v.sales30Store ?? 0}、網店 ${v.sales30Online ?? 0}`}>
                        {v.sales30 ?? 0}
                        <small className="muted d-block">
                          門市 {v.sales30Store ?? 0}／網店 {v.sales30Online ?? 0}
                        </small>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <LastSold v={v} />
                  </td>
                  <td>
                    <AgeCell v={v} />
                  </td>
                  <td className="num">{v.safety || "—"}</td>
                  <td className="num">{v.reorderQty ? v.reorderQty : "—"}</td>
                  <td>
                    {STATE_BADGE[stockState(v, expiryDays)]}
                    {isSlow(v) && <Badge tone="warn">滯銷</Badge>}
                    {failedIds.has(v.id) && <Badge tone="bad">同步失敗</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 && <p className="muted center">只顯示前 500 筆，請用搜尋縮小範圍</p>}
        </div>
      )}
      {open && <VariantDetail variant={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function VariantDetail({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const { byId, settings, variants } = useData();
  const v = byId.get(variant.id) ?? variant;
  const siblings = useMemo(() => variants.filter((x) => x.productId === v.productId), [variants, v.productId]);
  const [current, setCurrent] = useState<Variant | null>(null);
  const [moves, setMoves] = useState<Movement[]>([]);
  useEffect(
    () => onSnapshot(query(collection(db, "movements"), where("variantId", "==", v.id), orderBy("at", "desc"), limit(20)), (s) => setMoves(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Movement))),
    [v.id]
  );
  const today = todayStr();
  const soon = todayStr(new Date(Date.now() + (settings.expiryDays ?? 30) * 86400_000));
  const batches = [...(v.batches ?? [])].sort((a, b) => (a.exp ?? "9999").localeCompare(b.exp ?? "9999"));

  return (
    <Modal title={variantName(v)} onClose={onClose} wide>
      <div className="detail-head">
        {v.imageUrl && <img src={v.imageUrl} alt="" className="detail-img" />}
        <dl className="kv">
          <dt>meepShop 庫存</dt>
          <dd className="strong">
            {v.shopStock ?? "—"} <small className="muted">（{fmtTime(v.shopStockAt)}）</small>
          </dd>
          <dt>儲位</dt>
          <dd>{v.location || "未設定"}</dd>
          <dt>安全庫存</dt>
          <dd>{v.safety || "未設定"}</dd>
          <dt>近 30 天銷量</dt>
          <dd>{v.statsAt ? `${v.sales30 ?? 0}（門市 ${v.sales30Store ?? 0}、網店 ${v.sales30Online ?? 0}）` : "—"}</dd>
          <dt>最後賣出</dt>
          <dd>
            <LastSold v={v} />
          </dd>
          <dt>庫齡</dt>
          <dd>
            <AgeCell v={v} />
          </dd>
          <dt>商品編號</dt>
          <dd>{v.sku || "—"}</dd>
          <dt>條碼</dt>
          <dd>{[v.barcode, ...(v.extraCodes ?? [])].filter(Boolean).join("、") || "—"}</dd>
        </dl>
        <div className="center">
          <QrImg value={v.id} size={120} />
          <small className="muted d-block">進貨用 QR code</small>
        </div>
      </div>

      {siblings.length > 1 && (
        <>
          <h3>同款各規格庫存</h3>
          <VariantMatrix variants={siblings} currentId={v.id} onPick={(x) => x.id !== v.id && setCurrent(x)} />
        </>
      )}

      <h3>批次與效期</h3>
      {batches.length === 0 ? (
        <p className="muted">沒有批次紀錄（進貨時填批號、效期才會出現）</p>
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>批號</th>
              <th>有效期限</th>
              <th className="num">數量</th>
              <th>進貨日</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id}>
                <td>{b.lot || "—"}</td>
                <td>
                  {b.exp || "—"} {b.exp && b.exp < today ? <Badge tone="bad">已過期</Badge> : b.exp && b.exp <= soon ? <Badge tone="warn">即將到期</Badge> : null}
                </td>
                <td className="num">{b.qty}</td>
                <td>{fmtTime(b.receivedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>最近 20 筆異動</h3>
      {moves.length === 0 ? (
        <p className="muted">沒有紀錄</p>
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>時間</th>
              <th>動作</th>
              <th className="num">數量</th>
              <th>人員</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.id}>
                <td>{fmtTime(m.at)}</td>
                <td>
                  {MOVE_LABEL[m.type]} {m.undoneBy && <Badge>已撤銷</Badge>}
                </td>
                <td className={`num ${m.delta > 0 ? "plus" : "minus"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                <td>{m.byName}</td>
                <td>
                  <SyncBadge status={m.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {current && <VariantDetail variant={current} onClose={() => setCurrent(null)} />}
    </Modal>
  );
}
