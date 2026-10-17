import { collection, onSnapshot, type Timestamp } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { Badge, Empty, Modal } from "../../components/ui";
import { useData } from "../../data";
import { db } from "../../firebase";
import { downloadCsv, fmtTime, money, todayStr } from "../../lib/util";

interface Member {
  id: string;
  name: string;
  email: string;
  mobile: string;
  group: string | null;
  tier: string | null;
  points: number;
  birthMonth: string | null;
  ordersTotal: number;
  spendTotal: number;
  spend12m: number;
  orders12m: number;
  orders6m: number;
  orders3m: number;
  firstOrderAt: Timestamp | null;
  lastOrderAt: Timestamp | null;
}

interface Segment {
  key: string;
  name: string;
  rule: string;
  test: (m: Member) => boolean;
}

/**
 * 顧客分眾（門市＋網店合併計算，每天凌晨更新）。
 * RFM：最近一次消費（R）、消費次數（F）、消費金額（M）。
 */
export function Segments() {
  const { settings } = useData();
  const [rows, setRows] = useState<Member[]>([]);
  const [highSpend, setHighSpend] = useState(10000);
  const [open, setOpen] = useState<Segment | null>(null);
  useEffect(
    () =>
      onSnapshot(collection(db, "shoppers"), (s) =>
        setRows(
          s.docs.map((d) => {
            const x = d.data();
            return {
              id: d.id,
              name: x.name ?? "",
              email: x.email ?? "",
              mobile: x.mobile ?? "",
              group: x.memberGroup ?? null,
              tier: x.tier ?? null,
              points: x.points ?? 0,
              birthMonth: x.birthMonth ?? null,
              ordersTotal: x.ordersTotal ?? 0,
              spendTotal: x.spendTotal ?? 0,
              spend12m: x.spend12m ?? 0,
              orders12m: x.orders12m ?? 0,
              orders6m: x.orders6m ?? 0,
              orders3m: x.orders3m ?? 0,
              firstOrderAt: x.firstOrderAt ?? null,
              lastOrderAt: x.lastOrderAt ?? null,
            };
          })
        )
      ),
    []
  );
  const month = todayStr().slice(5, 7);
  const thisMonth = todayStr().slice(0, 7);
  const isCore = (m: Member) => m.orders3m > 0 && m.ordersTotal >= 3;

  const rfm: Segment[] = [
    { key: "core", name: "核心顧客", rule: "近 3 個月有消費，且累計消費 3 次以上", test: isCore },
    { key: "grow", name: "成長顧客", rule: "近 6 個月有消費，但還不是核心顧客", test: (m) => m.orders6m > 0 && !isCore(m) },
    { key: "lost", name: "流失顧客", rule: "曾經消費，但超過 6 個月沒有再消費", test: (m) => m.ordersTotal > 0 && m.orders6m === 0 },
  ];
  const behavior: Segment[] = [
    { key: "once", name: "僅消費一次顧客", rule: "累計只消費過 1 次", test: (m) => m.ordersTotal === 1 },
    { key: "never", name: "註冊未消費顧客", rule: "是會員，但從來沒有消費", test: (m) => !m.ordersTotal },
    { key: "y1", name: "近一年有消費顧客", rule: "近 12 個月內有消費", test: (m) => m.orders12m > 0 },
    { key: "m6", name: "近半年有消費顧客", rule: "近 6 個月內有消費", test: (m) => m.orders6m > 0 },
    { key: "m3", name: "近 3 個月有消費顧客", rule: "近 3 個月內有消費", test: (m) => m.orders3m > 0 },
    { key: "new", name: "本月新客", rule: "本月第一次消費", test: (m) => !!m.firstOrderAt && todayStr(m.firstOrderAt.toDate()).slice(0, 7) === thisMonth },
    { key: "high", name: `高消費顧客（近一年 ≥ ${money(highSpend)}）`, rule: `近 12 個月消費滿 ${money(highSpend)}`, test: (m) => m.spend12m >= highSpend },
    { key: "bday", name: "本月壽星", rule: "生日在這個月", test: (m) => m.birthMonth === month },
  ];
  const counted = useMemo(() => new Map([...rfm, ...behavior].map((s) => [s.key, rows.filter(s.test)])), [rows, highSpend]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasStats = rows.some((m) => m.ordersTotal > 0);

  const exportSeg = (s: Segment) =>
    downloadCsv(`顧客分眾_${s.name}_${todayStr()}.csv`, [
      ["姓名", "手機", "Email", "meepShop 群組", "等級", "購物金", "累計消費次數", "累計消費金額", "近12個月消費", "首次消費", "最後消費"],
      ...(counted.get(s.key) ?? []).map((m) => [m.name, m.mobile, m.email, m.group, m.tier, m.points, m.ordersTotal, m.spendTotal, m.spend12m, m.firstOrderAt ? todayStr(m.firstOrderAt.toDate()) : "", m.lastOrderAt ? todayStr(m.lastOrderAt.toDate()) : ""]),
    ]);

  const table = (title: string, list: Segment[], help: string) => (
    <section className="card">
      <h2>
        {title} <span className="muted small">{help}</span>
      </h2>
      <table className="table">
        <thead>
          <tr>
            <th>分眾</th>
            <th className="num">人數</th>
            <th className="num">佔會員</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((s) => {
            const n = counted.get(s.key)?.length ?? 0;
            return (
              <tr key={s.key}>
                <td>
                  <button className="link-btn" onClick={() => setOpen(s)}>
                    {s.name}
                  </button>
                  <div className="muted small">{s.rule}</div>
                </td>
                <td className="num strong">{n}</td>
                <td className="num">{rows.length ? `${((n / rows.length) * 100).toFixed(1)}%` : "—"}</td>
                <td className="num">
                  <div className="btn-row" style={{ justifyContent: "flex-end" }}>
                    <button className="btn btn-sm" onClick={() => setOpen(s)} disabled={!n}>
                      查看名單
                    </button>
                    <button className="btn btn-sm" onClick={() => exportSeg(s)} disabled={!n} title="下載 Excel">
                      ⤓ 下載
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>顧客分眾</h1>
          <div className="muted small">
            共 {rows.length} 位會員；消費資料合併門市＋網店全部歷史訂單（網店只算「已結案」的訂單，與 meepShop 相同），每天凌晨 3:30 更新
            {settings.tiersAt && `（上次 ${fmtTime(settings.tiersAt)}）`}。
          </div>
        </div>
        <label className="check">
          高消費門檻 $
          <input type="number" min={0} step={1000} value={highSpend} onChange={(e) => setHighSpend(Number(e.target.value) || 0)} style={{ width: 110 }} />
        </label>
      </div>
      {!hasStats && <div className="notice notice-warn">消費資料還在第一次計算中（每天凌晨自動計算；也可以到「顧客管理 → 會員等級」按「立即重算等級」）。</div>}
      {table("RFM 分眾", rfm, "依最近一次消費、消費次數")}
      {table("消費行為分眾", behavior, "")}
      {open && (
        <Modal title={`${open.name}（${counted.get(open.key)?.length ?? 0} 位）`} onClose={() => setOpen(null)} wide footer={<button className="btn" onClick={() => exportSeg(open)}>⤓ 下載 Excel</button>}>
          <p className="muted small">{open.rule}</p>
          {(counted.get(open.key) ?? []).length === 0 ? (
            <Empty>沒有符合的會員</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>手機</th>
                    <th>群組</th>
                    <th className="num">次數</th>
                    <th className="num">累計</th>
                    <th>最後消費</th>
                  </tr>
                </thead>
                <tbody>
                  {(counted.get(open.key) ?? [])
                    .slice()
                    .sort((a, b) => b.spendTotal - a.spendTotal)
                    .slice(0, 500)
                    .map((m) => (
                      <tr key={m.id}>
                        <td>
                          {m.name || "(未填姓名)"}
                          <div className="muted small">{m.email}</div>
                        </td>
                        <td>{m.mobile || "—"}</td>
                        <td>{m.group && <Badge tone="info">{m.group}</Badge>}</td>
                        <td className="num">{m.ordersTotal}</td>
                        <td className="num">{money(m.spendTotal)}</td>
                        <td>{m.lastOrderAt ? todayStr(m.lastOrderAt.toDate()) : "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
