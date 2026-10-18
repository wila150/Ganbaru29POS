import { collection, doc, limit, onSnapshot, orderBy, query, setDoc, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { QrImg } from "../../components/QrImg";
import { VariantMatrix } from "../../components/VariantMatrix";
import { useAuth } from "../../auth";
import { Badge, Empty, Modal, SyncBadge, useAction } from "../../components/ui";
import { daysSince, DEFAULT_SLOW, isSlow, stockAge, stockState, useData, variantName, type SlowRule } from "../../data";
import { call, db } from "../../firebase";
import { searchVariants } from "../../lib/lookup";
import { useDeviceLocation } from "../../lib/location";
import { atLeast, fmtTime, MOVE_LABEL, todayStr } from "../../lib/util";
import type { Movement, Variant } from "../../types";

type Filter = "all" | "low" | "out" | "expiring" | "slow" | "failed";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "low", label: "低庫存" },
  { key: "out", label: "缺貨" },
  { key: "expiring", label: "即將到期" },
  { key: "slow", label: "滯銷" },
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

export function LastSold({ v, slowDays = DEFAULT_SLOW.days }: { v: Variant; slowDays?: number }) {
  if (!v.statsAt) return <span className="muted">—</span>;
  const d = daysSince(v.lastSoldAt);
  if (d === null) return <span className="error">120 天以上</span>;
  return <span className={d >= slowDays ? "error" : ""}>{d === 0 ? "今天" : `${d} 天前`}</span>;
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
  const { variants, settings, locStock } = useData();
  const { profile } = useAuth();
  const isOwner = atLeast(profile?.role, "owner");
  const { multi, locationId, name: locName } = useDeviceLocation();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Variant | null>(null);
  const { busy, run } = useAction();
  const expiryDays = settings.expiryDays ?? 30;
  const slowRule: SlowRule = { ...DEFAULT_SLOW, ...(settings.slowRule ?? {}) };
  const [slowEdit, setSlowEdit] = useState(false);

  useEffect(
    () =>
      onSnapshot(query(collection(db, "movements"), where("status", "in", ["failed", "unknown"]), limit(500)), (s) => setFailedIds(new Set(s.docs.map((d) => d.data().variantId)))),
    []
  );

  const rows = useMemo(() => {
    let list = searchVariants(variants, q);
    if (filter === "failed") list = list.filter((v) => failedIds.has(v.id));
    else if (filter === "slow") list = list.filter((v) => isSlow(v, slowRule));
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
  }, [variants, q, filter, sort, failedIds, expiryDays, slowRule.days, slowRule.newDays]);

  const counts = useMemo(() => {
    const c = { all: variants.length, low: 0, out: 0, expiring: 0, slow: 0, failed: 0 };
    for (const v of variants) {
      const s = stockState(v, expiryDays);
      if (s !== "ok") c[s]++;
      if (isSlow(v, slowRule)) c.slow++;
      if (failedIds.has(v.id)) c.failed++;
    }
    return c;
  }, [variants, failedIds, expiryDays, slowRule.days, slowRule.newDays]);

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
            {f.key === "slow" ? `滯銷（${slowRule.days} 天沒賣）` : f.label} <span className="chip-count">{counts[f.key]}</span>
          </button>
        ))}
        {isOwner && (
          <button className="link-btn small" onClick={() => setSlowEdit(!slowEdit)}>
            滯銷條件
          </button>
        )}
      </div>
      {slowEdit && <SlowRuleEditor rule={slowRule} onClose={() => setSlowEdit(false)} />}
      {rows.length === 0 ? (
        <Empty>沒有符合的商品</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>商品（規格）</th>
                <th>儲位</th>
                <th className="num">{multi ? "總庫存" : "庫存"}</th>
                {multi && <th className="num">{locName}</th>}
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
                  {multi && <td className="num">{locStock.get(v.id)?.[locationId ?? ""] ?? 0}</td>}
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
                    <LastSold v={v} slowDays={slowRule.days} />
                  </td>
                  <td>
                    <AgeCell v={v} />
                  </td>
                  <td className="num">{v.safety || "—"}</td>
                  <td className="num">{v.reorderQty ? v.reorderQty : "—"}</td>
                  <td>
                    {STATE_BADGE[stockState(v, expiryDays)]}
                    {isSlow(v, slowRule) && <Badge tone="warn">滯銷</Badge>}
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
  const { byId, settings, variants, locStock } = useData();
  const { multi, locations } = useDeviceLocation();
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

      {multi && (
        <>
          <h3>各門市／倉庫</h3>
          <div className="chips">
            {locations.map((l) => (
              <span key={l.id} className="chip">
                {l.name} <strong>{locStock.get(v.id)?.[l.id] ?? 0}</strong>
              </span>
            ))}
          </div>
        </>
      )}
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

/** 滯銷條件（老闆）：存在 settings，庫存查詢、每日 LINE 提醒共用 */
function SlowRuleEditor({ rule, onClose }: { rule: SlowRule; onClose: () => void }) {
  const [r, setR] = useState(rule);
  const { busy, run } = useAction();
  const num = (v: string) => Math.max(0, Number(v.replace(/\D/g, "")) || 0);
  return (
    <div className="card slow-rule">
      <div className="cond-row">
        <span>有庫存，且超過</span>
        <input inputMode="numeric" value={String(r.days)} onChange={(e) => setR({ ...r, days: num(e.target.value) })} />
        <span>天門市和網店都沒賣出 → 算滯銷</span>
      </div>
      <div className="cond-row">
        <span>上架未滿</span>
        <input inputMode="numeric" value={String(r.newDays)} onChange={(e) => setR({ ...r, newDays: num(e.target.value) })} />
        <span>天的新品不算（還在觀察期）</span>
      </div>
      <div className="chips">
        {[30, 60, 90, 120].map((d) => (
          <button key={d} type="button" className={`chip ${r.days === d ? "active" : ""}`} onClick={() => setR({ days: d, newDays: d })}>
            {d} 天
          </button>
        ))}
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy || r.days < 1} onClick={() => run(() => setDoc(doc(db, "settings", "shop"), { slowRule: r }, { merge: true }), "已儲存").then(onClose)}>
          儲存
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          取消
        </button>
      </div>
      <p className="muted small">每日 LINE 提醒的「滯銷商品」也用這個條件。銷售紀錄目前最多回推 120 天。</p>
    </div>
  );
}
