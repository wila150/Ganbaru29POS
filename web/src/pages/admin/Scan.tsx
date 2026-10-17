import { collection, limit, onSnapshot, orderBy, query, Timestamp, where } from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth";
import { ScanInput, type ScanInputHandle } from "../../components/ScanInput";
import { Badge, Empty, Field, Modal, SyncBadge, useAction, useToast } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { resolveCode, searchVariants } from "../../lib/lookup";
import { atLeast, beep, dayStart, deviceId, fmtTime, MOVE_LABEL, newId } from "../../lib/util";
import type { Movement, Variant } from "../../types";

type Action = "in" | "return" | "scrap";
const ACTIONS: { key: Action; label: string; hint: string; min: "staff" | "manager" }[] = [
  { key: "in", label: "進貨", hint: "加庫存", min: "staff" },
  { key: "return", label: "退貨", hint: "退回廠商，扣庫存", min: "staff" },
  { key: "scrap", label: "報廢", hint: "扣庫存", min: "manager" },
];

interface ScanPayload {
  id: string;
  variantId: string;
  type: Action;
  qty: number;
  unitCost?: number;
  lot?: string;
  exp?: string;
  device: string;
}
interface ScanResult {
  id: string;
  status: string;
  shopStockAfter: number | null;
  error: string | null;
}

// ---- offline queue: the id is made here, so re-sending a queued scan never double-counts ----
const QKEY = "g29.scanQueue";
function readQueue(): ScanPayload[] {
  try {
    return JSON.parse(localStorage.getItem(QKEY) || "[]");
  } catch {
    return [];
  }
}
function writeQueue(q: ScanPayload[]) {
  try {
    localStorage.setItem(QKEY, JSON.stringify(q));
  } catch {
    /* storage full / private mode */
  }
}

export function Scan() {
  const { user, profile } = useAuth();
  const { byId, variants } = useData();
  const toast = useToast();
  const [action, setAction] = useState<Action>("in");
  const [qty, setQty] = useState(1);
  const [resetQty, setResetQty] = useState(true);
  const [unitCost, setUnitCost] = useState("");
  const [lot, setLot] = useState("");
  const [exp, setExp] = useState("");
  const [last, setLast] = useState<{ variant: Variant; delta: number; result?: ScanResult; queued?: boolean; error?: string } | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [today, setToday] = useState<Movement[]>([]);
  const [queue, setQueue] = useState<ScanPayload[]>(readQueue);
  const [busy, setBusy] = useState(false);
  const scanRef = useRef<ScanInputHandle>(null);
  const isManager = atLeast(profile?.role, "manager");

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, "movements"), where("by", "==", user.uid), where("at", ">=", Timestamp.fromDate(dayStart())), orderBy("at", "desc"), limit(200));
    return onSnapshot(q, (s) => setToday(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Movement)));
  }, [user]);

  const flushQueue = useCallback(async () => {
    const q = readQueue();
    if (!q.length || !navigator.onLine) return;
    const left: ScanPayload[] = [];
    for (const p of q) {
      try {
        await call("scanMove", p);
      } catch (e) {
        if (!navigator.onLine || /網路/.test((e as Error).message)) left.push(p);
        else toast(`補送失敗：${(e as Error).message}`, "bad");
      }
    }
    writeQueue(left);
    setQueue(left);
    if (left.length < q.length) toast(`已補送 ${q.length - left.length} 筆離線掃碼`, "ok");
  }, [toast]);

  useEffect(() => {
    flushQueue();
    window.addEventListener("online", flushQueue);
    const t = setInterval(flushQueue, 30_000);
    return () => {
      window.removeEventListener("online", flushQueue);
      clearInterval(t);
    };
  }, [flushQueue]);

  const submit = async (variant: Variant) => {
    const payload: ScanPayload = {
      id: newId("m"),
      variantId: variant.id,
      type: action,
      qty,
      device: deviceId(),
      ...(action === "in" ? { unitCost: unitCost === "" ? undefined : Number(unitCost), lot: lot || undefined, exp: exp || undefined } : {}),
    };
    const delta = action === "in" ? qty : -qty;
    setLast({ variant, delta });
    setBusy(true);
    try {
      const result = await call<ScanResult>("scanMove", payload);
      setLast({ variant, delta, result });
      beep(result.status === "synced");
    } catch (e) {
      const msg = (e as Error).message;
      if (!navigator.onLine || /網路/.test(msg)) {
        const q = [...readQueue(), payload];
        writeQueue(q);
        setQueue(q);
        setLast({ variant, delta, queued: true });
        beep(false);
      } else {
        setLast({ variant, delta, error: msg });
        beep(false);
      }
    } finally {
      setBusy(false);
      if (resetQty) setQty(1);
      scanRef.current?.focus();
    }
  };

  const onCode = async (code: string) => {
    const v = await resolveCode(code, byId);
    if (!v) {
      beep(false);
      setUnknownCode(code);
      return;
    }
    await submit(v);
  };

  const undo = async (id: string) => {
    try {
      const r = await call<{ status: string; error?: string }>("undoMove", { id, device: deviceId() });
      toast(r.status === "synced" || r.status === "canceled" ? "已撤銷" : `撤銷已記錄，同步狀態：${r.status}`, r.status === "failed" ? "bad" : "ok");
      if (last?.result?.id === id) setLast(null);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  const canUndo = (m: Movement) => {
    if (m.undoneBy || m.type === "undo" || !["in", "return", "scrap"].includes(m.type) || ["canceled", "resolved"].includes(m.status)) return false;
    if (isManager) return true;
    const at = m.at?.toMillis() ?? Date.now();
    return Date.now() - at < 10 * 60_000;
  };

  return (
    <div className="page">
      <h1>進貨掃碼</h1>
      <div className="segmented" role="tablist">
        {ACTIONS.filter((a) => atLeast(profile?.role, a.min)).map((a) => (
          <button key={a.key} role="tab" aria-selected={action === a.key} className={action === a.key ? `active seg-${a.key}` : ""} onClick={() => setAction(a.key)}>
            {a.label}
            <small>{a.hint}</small>
          </button>
        ))}
      </div>

      <div className="card scan-card">
        <div className="grid-fields">
          <Field label="數量">
            <div className="stepper">
              <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))}>
                −
              </button>
              <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))} />
              <button type="button" onClick={() => setQty((q) => q + 1)}>
                ＋
              </button>
            </div>
          </Field>
          {action === "in" && (
            <>
              <Field label="進貨單價">
                <input type="number" min={0} inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="選填" />
              </Field>
              <Field label="批號">
                <input value={lot} onChange={(e) => setLot(e.target.value)} placeholder="選填" />
              </Field>
              <Field label="有效期限">
                <input type="date" value={exp} onChange={(e) => setExp(e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={resetQty} onChange={(e) => setResetQty(e.target.checked)} /> 每次掃完數量回到 1
        </label>
        <ScanInput ref={scanRef} onCode={onCode} disabled={busy} />
        <p className="muted small">掃完立即送出：{ACTIONS.find((a) => a.key === action)?.label} {qty} 件。</p>
      </div>

      {queue.length > 0 && (
        <div className="notice notice-warn">
          有 {queue.length} 筆掃碼在網路斷線時存在這台裝置，恢復連線後會自動補送。
          <button className="btn btn-sm" onClick={flushQueue}>
            立即補送
          </button>
        </div>
      )}

      {last && <LastResult last={last} onUndo={undo} canUndo={!!last.result && !last.queued} />}

      <section>
        <h2>我今天的掃碼紀錄（{today.length}）</h2>
        {today.length === 0 ? (
          <Empty>今天還沒有紀錄</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>動作</th>
                  <th>商品</th>
                  <th className="num">數量</th>
                  <th className="num">網店庫存</th>
                  <th>狀態</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {today.map((m) => (
                  <tr key={m.id} className={m.undoneBy ? "row-muted" : ""}>
                    <td>{fmtTime(m.at, false)}</td>
                    <td>{MOVE_LABEL[m.type]}</td>
                    <td>
                      {variantName(m)}
                      {m.undoneBy && <Badge>已撤銷</Badge>}
                      {m.error && <div className="error small">{m.error}</div>}
                    </td>
                    <td className={`num ${m.delta > 0 ? "plus" : "minus"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                    <td className="num">{m.shopStockAfter ?? "—"}</td>
                    <td>
                      <SyncBadge status={m.status} />
                    </td>
                    <td>
                      {canUndo(m) && (
                        <button className="btn btn-sm btn-ghost" onClick={() => undo(m.id)}>
                          撤銷
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {unknownCode && <UnknownCode code={unknownCode} variants={variants} canBind={isManager} onClose={() => setUnknownCode(null)} onBound={(v) => (setUnknownCode(null), submit(v))} />}
    </div>
  );
}

function LastResult({ last, onUndo, canUndo }: { last: { variant: Variant; delta: number; result?: ScanResult; queued?: boolean; error?: string }; onUndo: (id: string) => void; canUndo: boolean }) {
  const { variant, delta, result, queued, error } = last;
  const tone = error || result?.status === "failed" || result?.status === "unknown" ? "bad" : queued || !result || result.status !== "synced" ? "warn" : "ok";
  return (
    <div className={`card result result-${tone}`}>
      <div className="result-main">
        <div>
          <div className="result-title">{variantName(variant)}</div>
          <div className="muted">儲位 {variant.location || "未設定"}</div>
        </div>
        <div className={`result-delta ${delta > 0 ? "plus" : "minus"}`}>{delta > 0 ? `+${delta}` : delta}</div>
      </div>
      <div className="result-foot">
        {error ? (
          <span className="error">{error}</span>
        ) : queued ? (
          <Badge tone="warn">離線，待送出</Badge>
        ) : !result ? (
          <span className="muted">送出中…</span>
        ) : result.status === "synced" ? (
          <span>
            <SyncBadge status="synced" /> 網店現在 <strong>{result.shopStockAfter}</strong> 件
          </span>
        ) : (
          <span>
            <SyncBadge status={result.status} /> {result.error}
            {result.status === "failed" && <span className="muted">（系統會自動重送）</span>}
          </span>
        )}
        {canUndo && result && (
          <button className="btn btn-sm" onClick={() => onUndo(result.id)}>
            撤銷這筆
          </button>
        )}
      </div>
    </div>
  );
}

/** 掃到未知條碼：員工看到提示；店長可以直接綁定 */
function UnknownCode({ code, variants, canBind, onClose, onBound }: { code: string; variants: Variant[]; canBind: boolean; onClose: () => void; onBound: (v: Variant) => void }) {
  const [q, setQ] = useState("");
  const { busy, run } = useAction();
  const results = q.trim() ? searchVariants(variants, q).slice(0, 30) : [];
  const bind = (v: Variant) =>
    run(async () => {
      const r = await call<{ conflict: boolean; boundTo?: { title: string } }>("bindCode", { code, variantId: v.id });
      if (r.conflict) {
        if (!confirm(`這個條碼已綁定到「${r.boundTo?.title}」，要改綁到「${variantName(v)}」嗎？`)) return;
        await call("bindCode", { code, variantId: v.id, force: true });
      }
      onBound(v);
    }, "已綁定");

  return (
    <Modal title="不認得的條碼" onClose={onClose}>
      <p>
        條碼 <code>{code}</code> 還沒有對應商品。
      </p>
      {!canBind ? (
        <p className="notice notice-warn">請店長綁定商品後再掃。</p>
      ) : (
        <>
          <input autoFocus placeholder="輸入商品名稱搜尋 meepShop 款式" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="pick-list">
            {results.map((v) => (
              <li key={v.id}>
                <button disabled={busy} onClick={() => bind(v)}>
                  <span>{variantName(v)}</span>
                  <small className="muted">
                    {v.sku || "無編號"} · 庫存 {v.shopStock ?? "—"}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
