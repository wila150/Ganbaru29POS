import { collection, limit, onSnapshot, orderBy, query, Timestamp, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { Badge, Empty, SyncBadge, useAction } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { addDays, downloadCsv, fmtTime, MOVE_LABEL, STATUS_LABEL, todayStr, type MoveType } from "../../lib/util";
import type { Movement } from "../../types";

type Tab = "all" | "failed" | "unknown";

export function Movements() {
  const [tab, setTab] = useState<Tab>("all");
  const [from, setFrom] = useState(addDays(todayStr(), -6));
  const [to, setTo] = useState(todayStr());
  const [type, setType] = useState<"" | MoveType>("");
  const [person, setPerson] = useState("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<Movement[]>([]);
  const [problemCounts, setProblemCounts] = useState({ failed: 0, unknown: 0 });

  useEffect(() => {
    const qy =
      tab === "all"
        ? query(collection(db, "movements"), where("at", ">=", Timestamp.fromDate(new Date(`${from}T00:00:00+08:00`))), where("at", "<", Timestamp.fromDate(new Date(`${addDays(to, 1)}T00:00:00+08:00`))), orderBy("at", "desc"), limit(2000))
        : query(collection(db, "movements"), where("status", "==", tab), orderBy("at", "desc"), limit(500));
    return onSnapshot(qy, (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Movement)));
  }, [tab, from, to]);

  useEffect(
    () =>
      onSnapshot(query(collection(db, "movements"), where("status", "in", ["failed", "unknown"]), limit(1000)), (s) => {
        let failed = 0;
        let unknown = 0;
        s.forEach((d) => (d.data().status === "failed" ? failed++ : unknown++));
        setProblemCounts({ failed, unknown });
      }),
    []
  );

  const people = useMemo(() => [...new Set(list.map((m) => m.byName))].sort(), [list]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((m) => (!type || m.type === type) && (!person || m.byName === person) && (!t || `${m.productTitle} ${m.options} ${m.sku ?? ""} ${m.note ?? ""}`.toLowerCase().includes(t)));
  }, [list, type, person, q]);

  const exportCsv = () =>
    downloadCsv(`異動紀錄_${from}_${to}.csv`, [
      ["時間", "動作", "商品", "規格", "商品編號", "數量", "進貨單價", "批號", "效期", "人員", "裝置", "同步狀態", "同步後網店庫存", "備註", "錯誤"],
      ...rows.map((m) => [fmtTime(m.at), MOVE_LABEL[m.type], m.productTitle, m.options, m.sku, m.delta, m.unitCost, m.lot, m.exp, m.byName, m.device, STATUS_LABEL[m.status] ?? m.status, m.shopStockAfter, m.note, m.error]),
    ]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>異動紀錄</h1>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          匯出 Excel（CSV）
        </button>
      </div>
      <div className="segmented">
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          全部紀錄
        </button>
        <button className={tab === "failed" ? "active" : ""} onClick={() => setTab("failed")}>
          同步失敗 {problemCounts.failed > 0 && <Badge tone="bad">{problemCounts.failed}</Badge>}
        </button>
        <button className={tab === "unknown" ? "active" : ""} onClick={() => setTab("unknown")}>
          待確認 {problemCounts.unknown > 0 && <Badge tone="bad">{problemCounts.unknown}</Badge>}
        </button>
      </div>

      {tab === "unknown" && <div className="notice notice-warn">這些紀錄送出後連線中斷，不確定 meepShop 有沒有收到。請比對「目前網店庫存」：已經套用就按「確認已套用」，沒有就按「重送」。</div>}
      {tab === "failed" && <div className="notice">失敗的紀錄沒有改到 meepShop。網路類錯誤系統會在 1、5、15、60 分鐘自動重送；「網店已無庫存」這類要人工處理。</div>}

      <div className="filters">
        {tab === "all" && (
          <>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <span>～</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </>
        )}
        <select value={type} onChange={(e) => setType(e.target.value as MoveType | "")}>
          <option value="">全部動作</option>
          {Object.entries(MOVE_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">全部人員</option>
          {people.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <input placeholder="商品" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {rows.length === 0 ? (
        <Empty>沒有紀錄</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>時間</th>
                <th>動作</th>
                <th>商品</th>
                <th className="num">數量</th>
                <th>人員</th>
                <th>狀態</th>
                <th className="num">同步後庫存</th>
                {tab !== "all" && <th className="num">目前網店</th>}
                {tab !== "all" && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <MoveRow key={m.id} m={m} actions={tab !== "all"} />
              ))}
            </tbody>
          </table>
          {rows.length >= 2000 && <p className="muted center">最多顯示 2000 筆，請縮小日期範圍</p>}
        </div>
      )}
    </div>
  );
}

function MoveRow({ m, actions }: { m: Movement; actions: boolean }) {
  const { byId } = useData();
  const { busy, run } = useAction();
  const act = (action: "retry" | "confirm" | "dismiss") => {
    const note = action === "dismiss" ? prompt("處理說明（例如：已在 meepShop 後台手動調整）") : "";
    if (note === null) return;
    run(() => call("resolveMovement", { id: m.id, action, note }), action === "retry" ? "已重送" : "已更新");
  };
  return (
    <tr className={m.undoneBy ? "row-muted" : ""}>
      <td>{fmtTime(m.at)}</td>
      <td>
        {MOVE_LABEL[m.type]}
        {m.undoneBy && <Badge>已撤銷</Badge>}
      </td>
      <td>
        {variantName(m)}
        {m.lot && <div className="muted small">批號 {m.lot}{m.exp && ` · 效期 ${m.exp}`}</div>}
        {m.note && <div className="muted small">{m.note}</div>}
        {m.error && <div className="error small">{m.error}</div>}
        {m.resolveNote && <div className="muted small">處理：{m.resolveNote}</div>}
      </td>
      <td className={`num ${m.delta > 0 ? "plus" : "minus"}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
      <td>
        {m.byName}
        {m.device && <div className="muted small">{m.device}</div>}
      </td>
      <td>
        <SyncBadge status={m.status} />
        {m.status === "failed" && m.retryable && <div className="muted small">第 {m.attempts} 次，將自動重送</div>}
      </td>
      <td className="num">{m.shopStockAfter ?? "—"}</td>
      {actions && <td className="num">{byId.get(m.variantId)?.shopStock ?? "—"}</td>}
      {actions && (
        <td>
          <div className="btn-row">
            <button className="btn btn-sm" disabled={busy} onClick={() => act("retry")}>
              重送
            </button>
            {m.status === "unknown" && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act("confirm")}>
                確認已套用
              </button>
            )}
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act("dismiss")}>
              確認已處理
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}
