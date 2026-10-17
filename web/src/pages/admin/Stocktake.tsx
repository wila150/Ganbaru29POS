import { collection, doc, limit, onSnapshot, orderBy, query, type Timestamp } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth";
import { ScanInput, type ScanInputHandle } from "../../components/ScanInput";
import { Badge, Empty, Field, Modal, useAction, useToast } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { resolveCode } from "../../lib/lookup";
import { atLeast, beep, fmtTime } from "../../lib/util";

interface Stocktake {
  id: string;
  name: string;
  scope: { type: "all" } | { type: "location"; prefix: string };
  status: "open" | "applying" | "applied" | "canceled";
  startedByName: string;
  startedAt: Timestamp | null;
  appliedAt?: Timestamp;
  appliedByName?: string;
  itemCount: number;
  adjusted?: number;
  failed?: number;
  onlyCounted?: boolean;
  syncWarning?: string | null;
}
interface Item {
  id: string;
  productTitle: string;
  options: string;
  sku: string | null;
  location: string | null;
  book: number;
  counted: number;
  touched: boolean;
  inScope: boolean;
  live?: number | null;
  diff?: number | null;
  lastBy?: string;
  note?: string;
}

const ST_STATUS: Record<Stocktake["status"], React.ReactNode> = {
  open: <Badge tone="info">進行中</Badge>,
  applying: <Badge tone="warn">套用中</Badge>,
  applied: <Badge tone="ok">已套用</Badge>,
  canceled: <Badge>已取消</Badge>,
};

export function StocktakeList() {
  const { profile } = useAuth();
  const [list, setList] = useState<Stocktake[]>([]);
  const [creating, setCreating] = useState(false);
  useEffect(() => onSnapshot(query(collection(db, "stocktakes"), orderBy("startedAt", "desc"), limit(30)), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Stocktake))), []);
  const isManager = atLeast(profile?.role, "manager");

  return (
    <div className="page">
      <div className="page-head">
        <h1>盤點</h1>
        {isManager && (
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            開盤點單
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <Empty>{isManager ? "還沒有盤點單，按「開盤點單」開始" : "目前沒有盤點單，請店長開單"}</Empty>
      ) : (
        <div className="cards">
          {list.map((s) => (
            <Link key={s.id} to={`/admin/stocktake/${s.id}`} className="card card-link">
              <div className="row-between">
                <strong>{s.name}</strong>
                {ST_STATUS[s.status]}
              </div>
              <div className="muted small">
                {s.scope.type === "all" ? "全部儲位" : `儲位 ${s.scope.prefix}*`} · {s.itemCount} 款 · {s.startedByName} {fmtTime(s.startedAt)}
              </div>
              {s.status === "applied" && (
                <div className="small">
                  調整 {s.adjusted} 款{s.failed ? <span className="error">，{s.failed} 款同步失敗</span> : ""}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
      {creating && <CreateStocktake onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateStocktake({ onClose }: { onClose: () => void }) {
  const [prefix, setPrefix] = useState("");
  const [name, setName] = useState("");
  const { busy, run } = useAction();
  const nav = useNavigate();
  const { variants } = useData();
  const locations = useMemo(() => [...new Set(variants.map((v) => v.location).filter(Boolean) as string[])].sort(), [variants]);
  return (
    <Modal
      title="開盤點單"
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await call<{ id: string; syncWarning: string | null }>("createStocktake", { locationPrefix: prefix, name });
              if (r.syncWarning) alert(`同步 meepShop 時有問題，帳面可能不是最新：${r.syncWarning}`);
              nav(`/admin/stocktake/${r.id}`);
            })
          }
        >
          {busy ? "同步 meepShop 庫存中…" : "開始盤點"}
        </button>
      }
    >
      <Field label="範圍（儲位開頭）" hint="留空 = 全部；例如填 A 會包含 A1、A2-3…">
        <input list="locs" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="全部" />
        <datalist id="locs">
          {locations.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </Field>
      <Field label="名稱（選填）">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={prefix ? `盤點 ${prefix}` : "全店盤點"} />
      </Field>
      <p className="muted small">開單時會先完整同步一次 meepShop，拿最新庫存當帳面。</p>
    </Modal>
  );
}

type View = "all" | "counted" | "uncounted" | "diff";

export function StocktakeDetail() {
  const { id } = useParams();
  const { profile } = useAuth();
  const { byId } = useData();
  const toast = useToast();
  const [st, setSt] = useState<Stocktake | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [view, setView] = useState<View>("all");
  const [last, setLast] = useState<{ title: string; counted: number; inScope: boolean } | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const scanRef = useRef<ScanInputHandle>(null);
  const isManager = atLeast(profile?.role, "manager");

  useEffect(() => {
    if (!id) return;
    const u1 = onSnapshot(doc(db, "stocktakes", id), (s) => setSt(s.exists() ? ({ id: s.id, ...s.data() } as Stocktake) : null));
    const u2 = onSnapshot(collection(db, "stocktakes", id, "items"), (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Item)));
    return () => {
      u1();
      u2();
    };
  }, [id]);

  const onCode = async (code: string) => {
    const v = await resolveCode(code, byId);
    if (!v) {
      beep(false);
      toast(`不認得的條碼 ${code}`, "bad");
      return;
    }
    try {
      const r = await call<{ counted: number; productTitle: string; options: string; inScope: boolean }>("stocktakeCount", { id, variantId: v.id, delta: 1 });
      setLast({ title: variantName(r), counted: r.counted, inScope: r.inScope });
      beep(true);
    } catch (e) {
      beep(false);
      toast((e as Error).message, "bad");
    }
  };

  const rows = useMemo(() => {
    const sorted = [...items].sort((a, b) => (a.location ?? "").localeCompare(b.location ?? "") || a.productTitle.localeCompare(b.productTitle, "zh-Hant"));
    const diffOf = (i: Item) => (i.diff !== undefined && i.diff !== null ? i.diff : i.counted - i.book);
    if (view === "counted") return sorted.filter((i) => i.touched);
    if (view === "uncounted") return sorted.filter((i) => !i.touched);
    if (view === "diff") return sorted.filter((i) => i.touched && diffOf(i) !== 0);
    return sorted;
  }, [items, view]);

  if (!st) return <div className="page loading">載入中…</div>;
  const open = st.status === "open";
  const counted = items.filter((i) => i.touched).length;
  const applied = st.status === "applied";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/admin/stocktake" className="muted small">
            ← 盤點
          </Link>
          <h1>
            {st.name} {ST_STATUS[st.status]}
          </h1>
          <div className="muted small">
            {st.scope.type === "all" ? "全部儲位" : `儲位 ${st.scope.prefix}*`} · 已盤 {counted}/{items.length} 款 · {st.startedByName} 開單於 {fmtTime(st.startedAt)}
          </div>
        </div>
        {open && isManager && (
          <div className="btn-row">
            <button className="btn" onClick={() => confirm("確定取消這張盤點單？") && call("cancelStocktake", { id }).catch((e) => toast(e.message, "bad"))}>
              取消盤點
            </button>
            <button className="btn btn-primary" onClick={() => setApplyOpen(true)}>
              套用到 meepShop
            </button>
          </div>
        )}
      </div>
      {st.syncWarning && <div className="notice notice-warn">開單時同步有問題，帳面可能不是最新：{st.syncWarning}</div>}

      {open && (
        <div className="card">
          <ScanInput ref={scanRef} onCode={onCode} continuousCamera placeholder="掃一下 = 實盤 +1" />
          {last && (
            <div className="count-flash">
              {last.title} → 實盤 <strong>{last.counted}</strong>
              {!last.inScope && <Badge tone="warn">不在範圍內</Badge>}
            </div>
          )}
          <p className="muted small">多支手機可以同時掃。數錯了點表格裡的數字直接修改。</p>
        </div>
      )}

      <div className="chips">
        {(
          [
            ["all", "全部"],
            ["counted", "已盤"],
            ["uncounted", "未盤"],
            ["diff", "有差異"],
          ] as [View, string][]
        ).map(([k, l]) => (
          <button key={k} className={`chip ${view === k ? "active" : ""}`} onClick={() => setView(k)}>
            {l}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>儲位</th>
              <th>商品</th>
              <th className="num">帳面</th>
              <th className="num">實盤</th>
              <th className="num">{applied ? "網店（套用時）" : "差異"}</th>
              {applied && <th className="num">調整</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => {
              const diff = applied ? i.diff : i.counted - i.book;
              return (
                <tr key={i.id} className={!i.touched ? "row-muted" : ""}>
                  <td>{i.location || "—"}</td>
                  <td>
                    {variantName(i)} {!i.inScope && <Badge tone="warn">範圍外</Badge>}
                    {i.note && <div className="muted small">{i.note}</div>}
                  </td>
                  <td className="num">{i.book}</td>
                  <td className="num">
                    {open ? (
                      <button className="link-btn strong" onClick={() => setEdit(i)}>
                        {i.touched ? i.counted : "—"}
                      </button>
                    ) : i.touched ? (
                      i.counted
                    ) : (
                      "—"
                    )}
                  </td>
                  {applied ? (
                    <>
                      <td className="num">{i.live ?? "—"}</td>
                      <td className={`num ${(diff ?? 0) > 0 ? "plus" : (diff ?? 0) < 0 ? "minus" : ""}`}>{diff == null ? "—" : diff > 0 ? `+${diff}` : diff}</td>
                    </>
                  ) : (
                    <td className={`num ${i.touched && diff ? (diff > 0 ? "plus" : "minus") : ""}`}>{i.touched ? (diff! > 0 ? `+${diff}` : diff) : "—"}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {edit && <EditCount stocktakeId={id!} item={edit} onClose={() => setEdit(null)} />}
      {applyOpen && <ApplyDialog st={st} items={items} onClose={() => setApplyOpen(false)} />}
    </div>
  );
}

function EditCount({ stocktakeId, item, onClose }: { stocktakeId: string; item: Item; onClose: () => void }) {
  const [n, setN] = useState(String(item.counted));
  const { busy, run } = useAction();
  return (
    <Modal
      title={variantName(item)}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" disabled={busy || n === ""} onClick={() => run(() => call("stocktakeCount", { id: stocktakeId, variantId: item.id, set: Number(n) }), "已更新").then(onClose)}>
          儲存
        </button>
      }
    >
      <Field label={`實盤數量（帳面 ${item.book}）`}>
        <input type="number" min={0} autoFocus value={n} onChange={(e) => setN(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ApplyDialog({ st, items, onClose }: { st: Stocktake; items: Item[]; onClose: () => void }) {
  const [onlyCounted, setOnlyCounted] = useState(true);
  const { busy, run } = useAction();
  const uncounted = items.filter((i) => !i.touched && i.inScope).length;
  const preview = items.filter((i) => (onlyCounted ? i.touched : true) && i.counted - i.book !== 0).length;
  return (
    <Modal
      title="套用盤點結果"
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await call<{ adjusted: number; failed: number }>("applyStocktake", { id: st.id, onlyCounted });
              alert(`已調整 ${r.adjusted} 款${r.failed ? `，其中 ${r.failed} 款同步失敗，請到「異動紀錄」處理` : ""}`);
              onClose();
            })
          }
        >
          {busy ? "套用中…" : "確定套用"}
        </button>
      }
    >
      <p>差異以「實盤 − 套用當下的 meepShop 庫存」計算，一次更新 meepShop。</p>
      <label className="check">
        <input type="radio" checked={onlyCounted} onChange={() => setOnlyCounted(true)} /> 只調整有盤到的款式（建議）
      </label>
      <label className="check">
        <input type="radio" checked={!onlyCounted} onChange={() => setOnlyCounted(false)} /> 範圍內沒盤到的 {uncounted} 款視為 0 件
      </label>
      {!onlyCounted && uncounted > 0 && <p className="notice notice-bad">注意：這 {uncounted} 款在 meepShop 會被改成 0。</p>}
      <p className="muted small">依開單時帳面估計約 {preview} 款會調整。</p>
    </Modal>
  );
}
