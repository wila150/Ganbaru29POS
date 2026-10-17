import { collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, where, type Timestamp } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth";
import { Empty, Field, Modal, useAction } from "../../components/ui";
import { useData } from "../../data";
import { db, storage } from "../../firebase";
import { useDeviceLocation } from "../../lib/location";
import { downloadCsv, money, PAY_LABEL, todayStr } from "../../lib/util";

export const DEFAULT_EXPENSE_CATEGORIES = ["進貨", "房租", "薪資", "水電瓦斯", "網路電話", "運費", "包材耗材", "廣告行銷", "裝潢設備", "刷卡／金流手續費", "稅金規費", "雜支"];

interface Expense {
  id: string;
  date: string;
  category: string;
  amount: number;
  note: string | null;
  vendor: string | null;
  payMethod: string;
  locationId: string | null;
  receiptUrl: string | null;
  receiptPath: string | null;
  source?: string;
  createdByName: string;
  createdAt: Timestamp | null;
}

/** 開支登記：分類、金額、付款方式、收據照片；報表中心「損益」會扣掉這些開支。 */
export function Expenses() {
  const { settings } = useData();
  const { multi, locations } = useDeviceLocation();
  const categories = settings.expenseCategories?.length ? settings.expenseCategories : DEFAULT_EXPENSE_CATEGORIES;
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [list, setList] = useState<Expense[]>([]);
  const [edit, setEdit] = useState<Expense | "new" | null>(null);
  const [cat, setCat] = useState("");

  useEffect(() => {
    const from = `${month}-01`;
    const to = `${month}-31`;
    return onSnapshot(query(collection(db, "expenses"), where("date", ">=", from), where("date", "<=", to), orderBy("date", "desc")), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Expense)));
  }, [month]);

  const rows = list.filter((e) => !cat || e.category === cat);
  const byCat = useMemo(() => {
    const m = new Map<string, number>();
    list.forEach((e) => m.set(e.category, (m.get(e.category) ?? 0) + e.amount));
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [list]);
  const total = list.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>開支</h1>
          <div className="muted small">登記房租、薪資、進貨等支出，報表中心的「損益」會自動扣除。錢櫃提款時選了開支分類，也會自動記在這裡。</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEdit("new")}>
          新增開支
        </button>
      </div>
      <div className="filters">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">全部分類</option>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <button
          className="btn btn-sm"
          disabled={!rows.length}
          onClick={() => downloadCsv(`開支_${month}.csv`, [["日期", "分類", "金額", "付款方式", "廠商", "說明", "門市", "登記人", "收據"], ...rows.map((e) => [e.date, e.category, e.amount, PAY_LABEL[e.payMethod] ?? e.payMethod, e.vendor, e.note, locations.find((l) => l.id === e.locationId)?.name ?? "", e.createdByName, e.receiptUrl ? "有" : ""])])}
        >
          匯出 Excel
        </button>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">{month} 開支合計</div>
          <div className="kpi-value">{money(total)}</div>
          <div className="kpi-hint">{list.length} 筆</div>
        </div>
        {byCat.slice(0, 5).map(([c, n]) => (
          <div key={c} className="kpi">
            <div className="kpi-label">{c}</div>
            <div className="kpi-value">{money(n)}</div>
          </div>
        ))}
      </div>
      {rows.length === 0 ? (
        <Empty>這個月還沒有開支紀錄</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table table-click">
            <thead>
              <tr>
                <th>日期</th>
                <th>分類</th>
                <th>說明</th>
                <th>付款</th>
                <th className="num">金額</th>
                <th>收據</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} onClick={() => setEdit(e)}>
                  <td>{e.date}</td>
                  <td>{e.category}</td>
                  <td>
                    {e.vendor && <strong>{e.vendor} </strong>}
                    {e.note}
                    {e.source === "drawer" && <span className="tag">錢櫃提款</span>}
                    {multi && e.locationId && <div className="muted small">{locations.find((l) => l.id === e.locationId)?.name}</div>}
                  </td>
                  <td>{PAY_LABEL[e.payMethod] ?? e.payMethod}</td>
                  <td className="num strong">{money(e.amount)}</td>
                  <td onClick={(ev) => ev.stopPropagation()}>
                    {e.receiptUrl ? (
                      <a href={e.receiptUrl} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <ExpenseEditor expense={edit === "new" ? null : edit} categories={categories} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ExpenseEditor({ expense, categories, onClose }: { expense: Expense | null; categories: string[]; onClose: () => void }) {
  const { user, profile } = useAuth();
  const { multi, locations, locationId } = useDeviceLocation();
  const [f, setF] = useState({
    date: expense?.date ?? todayStr(),
    category: expense?.category ?? categories[0],
    amount: expense ? String(expense.amount) : "",
    payMethod: expense?.payMethod ?? "transfer",
    vendor: expense?.vendor ?? "",
    note: expense?.note ?? "",
    locationId: expense?.locationId ?? locationId ?? "",
  });
  const [file, setFile] = useState<File | null>(null);
  const { busy, run } = useAction();
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));

  const save = () =>
    run(async () => {
      const amount = Number(f.amount);
      if (!(amount > 0)) throw new Error("請輸入金額");
      const id = expense?.id ?? doc(collection(db, "expenses")).id;
      let receipt: { receiptPath?: string; receiptUrl?: string } = {};
      if (file) {
        const path = `receipts/${id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, "_")}`;
        await uploadBytes(ref(storage, path), file, { contentType: file.type });
        receipt = { receiptPath: path, receiptUrl: await getDownloadURL(ref(storage, path)) };
      }
      const data = {
        date: f.date,
        category: f.category,
        amount,
        payMethod: f.payMethod,
        vendor: f.vendor.trim() || null,
        note: f.note.trim() || null,
        locationId: f.locationId || null,
        ...receipt,
      };
      if (expense) await setDoc(doc(db, "expenses", id), { ...data, updatedAt: serverTimestamp() }, { merge: true });
      else await setDoc(doc(db, "expenses", id), { ...data, receiptPath: data.receiptPath ?? null, receiptUrl: data.receiptUrl ?? null, source: "manual", createdBy: user!.uid, createdByName: profile?.name ?? "", createdAt: serverTimestamp() });
      onClose();
    }, "已儲存");

  return (
    <Modal
      title={expense ? "編輯開支" : "新增開支"}
      onClose={onClose}
      footer={
        <>
          {expense && (
            <button className="btn btn-danger" disabled={busy} onClick={() => confirm("刪除這筆開支？") && run(() => deleteDoc(doc(db, "expenses", expense.id)), "已刪除").then(onClose)}>
              刪除
            </button>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            儲存
          </button>
        </>
      }
    >
      <div className="grid-fields">
        <Field label="日期">
          <input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
        </Field>
        <Field label="分類">
          <select value={f.category} onChange={(e) => set({ category: e.target.value })}>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="金額">
          <input type="number" min={1} inputMode="numeric" value={f.amount} onChange={(e) => set({ amount: e.target.value })} autoFocus />
        </Field>
        <Field label="付款方式">
          <select value={f.payMethod} onChange={(e) => set({ payMethod: e.target.value })}>
            {Object.entries(PAY_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="廠商／對象">
          <input value={f.vendor} onChange={(e) => set({ vendor: e.target.value })} placeholder="選填" />
        </Field>
        {multi && (
          <Field label="門市">
            <select value={f.locationId} onChange={(e) => set({ locationId: e.target.value })}>
              <option value="">全店共用</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label="說明">
        <input value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="例：10 月房租" />
      </Field>
      <Field label="收據／發票照片（選填）" hint={expense?.receiptUrl ? "已有收據，重新選擇會取代" : "可拍照或選 PDF"}>
        <input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
    </Modal>
  );
}
