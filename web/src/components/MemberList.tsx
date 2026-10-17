import { collection, onSnapshot } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useData } from "../data";
import { db } from "../firebase";
import { downloadCsv, money, todayStr } from "../lib/util";
import type { Shopper } from "../types";
import { Badge, Empty } from "./ui";

interface Row extends Shopper {
  birthDate?: string | null;
  spendStore12m?: number;
  spendOnline12m?: number;
}

type Sort = "spend" | "points" | "name";

/** 顧客名單：每 15 分鐘從 meepShop 同步的全部會員，可搜尋、篩選群組／等級、匯出 Excel。 */
export function MemberList({ onPick }: { onPick: (s: Shopper) => void }) {
  const { settings } = useData();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [tier, setTier] = useState("");
  const [sort, setSort] = useState<Sort>("spend");
  const [birthdayOnly, setBirthdayOnly] = useState(false);
  useEffect(
    () =>
      onSnapshot(collection(db, "shoppers"), (s) =>
        setRows(
          s.docs.map((d) => {
            const x = d.data();
            return { id: d.id, name: x.name ?? "", email: x.email ?? "", mobile: x.mobile ?? "", points: x.points ?? 0, tier: x.tier ?? null, group: x.memberGroup ?? null, birthMonth: x.birthMonth ?? null, birthDate: x.birthDate ?? null, spend12m: x.spend12m ?? 0, spendStore12m: x.spendStore12m ?? 0, spendOnline12m: x.spendOnline12m ?? 0 };
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
      .sort((a, b) => (sort === "spend" ? (b.spend12m ?? 0) - (a.spend12m ?? 0) : sort === "points" ? b.points - a.points : a.name.localeCompare(b.name, "zh-Hant")));
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
              ["姓名", "手機", "Email", "meepShop 群組", "本系統等級", "購物金", "近12個月消費", "門市", "網店", "生日"],
              ...list.map((r) => [r.name, r.mobile, r.email, r.group, r.tier, r.points, r.spend12m, r.spendStore12m, r.spendOnline12m, r.birthDate]),
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
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="spend">依近 12 個月消費</option>
          <option value="points">依購物金</option>
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
                <th className="num">近 12 個月消費</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 300).map((r) => (
                <tr key={r.id} onClick={() => onPick(r)}>
                  <td>
                    {r.name || "(未填姓名)"} {r.birthMonth === month && "🎂"}
                    <div className="muted small">{r.email}</div>
                  </td>
                  <td>{r.mobile || "—"}</td>
                  <td>
                    {r.group && <Badge tone="info">{r.group}</Badge>}
                    {r.tier && <Badge>{r.tier}</Badge>}
                  </td>
                  <td className="num">{r.points}</td>
                  <td className="num">{money(r.spend12m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 300 && <p className="muted center">只顯示前 300 位，請用搜尋縮小範圍（匯出 Excel 會包含全部）</p>}
        </div>
      )}
      <p className="muted small">購物金數字是同步時的快取；點進會員會向 meepShop 查即時餘額。消費金額每天凌晨更新。</p>
    </section>
  );
}
