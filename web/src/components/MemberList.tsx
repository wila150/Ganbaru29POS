import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useData } from "../data";
import { db } from "../firebase";
import { downloadCsv, money, todayStr } from "../lib/util";
import type { Shopper } from "../types";
import { Badge, Empty, useAction } from "./ui";
import { useAuth } from "../auth";
import { call } from "../firebase";
import { atLeast } from "../lib/util";

interface Row extends Shopper {
  birthDate?: string | null;
  spendStore12m?: number;
  spendOnline12m?: number;
  pointsUsed?: number;
  pointsUsedStore?: number;
  pointsUsedOnline?: number;
  joinedAt?: string | null;
  lastOrderMs?: number;
  pinned?: boolean;
  pinnedMs?: number;
}

type Sort = "newest" | "recent" | "spend" | "points" | "used" | "name";

/** 顧客名單：每 15 分鐘從 meepShop 同步的全部會員，可搜尋、篩選群組／等級、匯出 Excel。 */
export function MemberList({ onPick }: { onPick: (s: Shopper) => void }) {
  const { settings } = useData();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [tier, setTier] = useState("");
  const [sort, setSort] = useState<Sort>(() => {
    try {
      return (localStorage.getItem("g29.memberSort") as Sort) || "newest";
    } catch {
      return "newest";
    }
  });
  const { profile } = useAuth();
  const canPin = atLeast(profile?.role, "manager");
  const { run } = useAction();
  const [birthdayOnly, setBirthdayOnly] = useState(false);
  useEffect(
    () =>
      onSnapshot(collection(db, "shoppers"), (s) =>
        setRows(
          s.docs.map((d) => {
            const x = d.data();
            return { id: d.id, name: x.name ?? "", email: x.email ?? "", mobile: x.mobile ?? "", points: x.points ?? 0, tier: x.tier ?? null, group: x.memberGroup ?? null, birthMonth: x.birthMonth ?? null, birthDate: x.birthDate ?? null, spend12m: x.spend12m ?? 0, spendStore12m: x.spendStore12m ?? 0, spendOnline12m: x.spendOnline12m ?? 0, pointsUsed: x.pointsUsed ?? 0, pointsUsedStore: x.pointsUsedStore ?? 0, pointsUsedOnline: x.pointsUsedOnline ?? 0, joinedAt: x.joinedAt ?? null, lastOrderMs: x.lastOrderAt?.toMillis?.() ?? 0, pinned: !!x.pinned, pinnedMs: x.pinnedAt?.toMillis?.() ?? 0 };
          })
        )
      ),
    []
  );
  const month = todayStr().slice(5, 7);
  const groups = useMemo(() => [...new Set(rows.map((r) => r.group).filter(Boolean) as string[])].sort(), [rows]);
  const tiers = (settings.memberTiers ?? []).map((t) => t.name);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    const digits = t.replace(/\D/g, "");
    return rows
      .filter((r) => !t || `${r.name} ${r.email}`.toLowerCase().includes(t) || (digits.length >= 3 && r.mobile.replace(/\D/g, "").includes(digits)))
      .filter((r) => !group || r.group === group)
      .filter((r) => !tier || r.tier === tier)
      .filter((r) => !birthdayOnly || r.birthMonth === month)
      .sort((a, b) => {
        // 釘選的永遠在最上面（先釘的在前）
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        if (a.pinned && b.pinned) return (a.pinnedMs ?? 0) - (b.pinnedMs ?? 0);
        switch (sort) {
          case "newest":
            return (b.joinedAt ?? "").localeCompare(a.joinedAt ?? "");
          case "recent":
            return (b.lastOrderMs ?? 0) - (a.lastOrderMs ?? 0);
          case "spend":
            return (b.spend12m ?? 0) - (a.spend12m ?? 0);
          case "points":
            return b.points - a.points;
          case "used":
            return (b.pointsUsed ?? 0) - (a.pointsUsed ?? 0);
          default:
            return a.name.localeCompare(b.name, "zh-Hant");
        }
      });
  }, [rows, q, group, tier, sort, birthdayOnly, month]);

  return (
    <section>
      <div className="row-between">
        <h2>顧客名單（{list.length}／{rows.length} 位）</h2>
        <button
          className="btn btn-sm"
          disabled={!list.length}
          onClick={() =>
            downloadCsv(`顧客名單_${todayStr()}.csv`, [
              ["姓名", "手機", "Email", "加入日期", "meepShop 群組", "本系統等級", "購物金", "已使用購物金", "門市已使用", "網店已使用", "近12個月消費", "門市", "網店", "生日"],
              ...list.map((r) => [r.name, r.mobile, r.email, r.joinedAt?.slice(0, 10) ?? "", r.group, r.tier, r.points, r.pointsUsed, r.pointsUsedStore, r.pointsUsedOnline, r.spend12m, r.spendStore12m, r.spendOnline12m, r.birthDate]),
            ])
          }
        >
          匯出 Excel
        </button>
      </div>
      <div className="filters">
        <input placeholder="搜尋姓名、手機、Email" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px" }} />
        <select value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">全部群組</option>
          {groups.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        {tiers.length > 0 && (
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">全部等級</option>
            {tiers.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </select>
        )}
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            try {
              localStorage.setItem("g29.memberSort", e.target.value);
            } catch {
              /* ignore */
            }
          }}
        >
          <option value="newest">最新加入在上面</option>
          <option value="recent">最近消費在上面</option>
          <option value="spend">依近 12 個月消費</option>
          <option value="points">依購物金</option>
          <option value="used">依已使用購物金</option>
          <option value="name">依姓名</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={birthdayOnly} onChange={(e) => setBirthdayOnly(e.target.checked)} /> 本月壽星
        </label>
      </div>
      {rows.length === 0 ? (
        <Empty>會員資料同步中…（每 15 分鐘從 meepShop 自動同步）</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-compact table-click">
            <thead>
              <tr>
                <th>姓名</th>
                <th>手機</th>
                <th>群組／等級</th>
                <th className="num">購物金</th>
                <th className="num">已使用</th>
                <th className="num">近 12 個月消費</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 300).map((r) => (
                <tr key={r.id} onClick={() => onPick(r)} className={r.pinned ? "row-pinned" : ""}>
                  <td>
                    {canPin && (
                      <button
                        type="button"
                        className={`pin-btn ${r.pinned ? "on" : ""}`}
                        title={r.pinned ? "取消釘選" : "釘選在最上面"}
                        onClick={(e) => {
                          e.stopPropagation();
                          run(() => call("setShopperPin", { id: r.id, pinned: !r.pinned }), r.pinned ? "已取消釘選" : "已釘選在最上面");
                        }}
                      >
                        📌
                      </button>
                    )}
                    {r.name || "(未填姓名)"} {r.birthMonth === month && "🎂"}
                    <div className="muted small">
                      {r.email}
                      {r.joinedAt && `　${r.joinedAt.slice(0, 10)} 加入`}
                    </div>
                  </td>
                  <td>{r.mobile || "—"}</td>
                  <td>
                    {r.group && <Badge tone="info">{r.group}</Badge>}
                    {r.tier && <Badge>{r.tier}</Badge>}
                  </td>
                  <td className="num">{r.points}</td>
                  <td className="num" title={`門市 ${r.pointsUsedStore ?? 0}／網店 ${r.pointsUsedOnline ?? 0}`}>{r.pointsUsed || "—"}</td>
                  <td className="num">{money(r.spend12m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 300 && <p className="muted center">只顯示前 300 位，請用搜尋縮小範圍（匯出 Excel 會包含全部）</p>}
        </div>
      )}
      <p className="muted small">購物金數字是同步時的快取；點進會員會向 meepShop 查即時餘額。「已使用」= 門市＋網店累計用掉的購物金（取消的單不算），和消費金額一樣每天凌晨更新。</p>
    </section>
  );
}
