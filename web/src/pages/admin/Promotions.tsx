import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth";
import { Badge, Empty, Field, Modal, useAction } from "../../components/ui";
import { daysSince, useData } from "../../data";
import { db } from "../../firebase";
import { searchVariants } from "../../lib/lookup";
import { describePromo, promoIsLive, PROMO_TYPE_LABEL, type PromoScope, type PromoType, type Promotion } from "../../lib/promo";
import { money, todayStr } from "../../lib/util";
import type { Variant } from "../../types";

type PromoDoc = Promotion & { note?: string };

export function Promotions() {
  const [list, setList] = useState<PromoDoc[]>([]);
  const [edit, setEdit] = useState<PromoDoc | "new" | null>(null);
  const { run } = useAction();
  useEffect(() => onSnapshot(query(collection(db, "promotions"), orderBy("createdAt", "desc")), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as PromoDoc))), []);
  const today = todayStr();

  const status = (p: PromoDoc) => {
    if (!p.active) return <Badge>停用</Badge>;
    if (p.startDate && today < p.startDate) return <Badge tone="info">{p.startDate} 開始</Badge>;
    if (p.endDate && today > p.endDate) return <Badge>已結束</Badge>;
    return <Badge tone="ok">進行中</Badge>;
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>促銷活動</h1>
          <div className="muted small">結帳時系統自動套用；同一件商品只套一個活動，多個活動重疊時自動選最優惠的組合。手動打折的品項不再套活動。</div>
        </div>
        <button className="btn btn-primary" onClick={() => setEdit("new")}>
          新增活動
        </button>
      </div>
      {list.length === 0 ? (
        <Empty>還沒有促銷活動。按「新增活動」設定第二件幾折、任選幾件特價、加價購，或清掉滯銷品。</Empty>
      ) : (
        <div className="cards">
          {list.map((p) => (
            <div key={p.id} className="card">
              <div className="row-between">
                <strong>{p.name}</strong>
                {status(p)}
              </div>
              <div className="promo-desc">{describePromo(p)}</div>
              <div className="muted small">
                {scopeText(p.scope)}
                {p.type === "addon" && ` → 加購：${scopeText(p.addonScope)}`}
              </div>
              <div className="muted small">
                {p.startDate || "即日起"} ～ {p.endDate || "不限"}
              </div>
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => setEdit(p)}>
                  編輯
                </button>
                <button className="btn btn-sm" onClick={() => run(() => setDoc(doc(db, "promotions", p.id), { active: !p.active, updatedAt: serverTimestamp() }, { merge: true }), p.active ? "已停用" : "已啟用")}>
                  {p.active ? "停用" : "啟用"}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => confirm(`刪除「${p.name}」？過去的訂單紀錄不受影響。`) && run(() => deleteDoc(doc(db, "promotions", p.id)), "已刪除")}>
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {edit && <PromoEditor promo={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function scopeText(s?: PromoScope) {
  if (!s || s.kind === "all") return "全部商品";
  if (s.kind === "categories") return `分類：${s.categories.join("、") || "（未選）"}`;
  return `指定 ${s.productIds.length} 款商品`;
}

const TYPE_HINT: Record<PromoType, string> = {
  percent_off: "例：滯銷品 7 折 → 折扣 30%",
  nth_discount: "例：第二件 6 折 → 第 2 件、折扣 40%（每 2 件中較便宜的那件打折）",
  bundle_price: "例：任選 3 件 1000 元（優先把貴的湊成一組）",
  addon: "例：買上衣，配件加 99 元購（每買 1 件適用商品可加購 1 件）",
};

function PromoEditor({ promo, onClose }: { promo: PromoDoc | null; onClose: () => void }) {
  const { profile } = useAuth();
  const [p, setP] = useState<Omit<PromoDoc, "id">>(
    promo ?? { name: "", active: true, type: "nth_discount", n: 2, percentOff: 40, scope: { kind: "all" }, startDate: todayStr(), endDate: "" }
  );
  const [picking, setPicking] = useState<"scope" | "addonScope" | null>(null);
  const { busy, run } = useAction();
  const set = (patch: Partial<Promotion>) => setP((x) => ({ ...x, ...patch }));

  const save = () =>
    run(async () => {
      if (!p.name.trim()) throw new Error("請填活動名稱");
      if (p.endDate && p.startDate && p.endDate < p.startDate) throw new Error("結束日早於開始日");
      const data: Record<string, unknown> = {
        name: p.name.trim(),
        active: p.active,
        type: p.type,
        startDate: p.startDate || null,
        endDate: p.endDate || null,
        scope: p.scope,
        note: p.note ?? null,
        updatedBy: profile?.name ?? "",
        updatedAt: serverTimestamp(),
      };
      if (p.type === "percent_off" || p.type === "nth_discount") data.percentOff = Number(p.percentOff) || 0;
      if (p.type === "nth_discount" || p.type === "bundle_price") data.n = Number(p.n) || 2;
      if (p.type === "bundle_price") data.bundlePrice = Number(p.bundlePrice) || 0;
      if (p.type === "addon") {
        data.addonScope = p.addonScope ?? { kind: "all" };
        data.addonPrice = Number(p.addonPrice) || 0;
      }
      if (promo) await setDoc(doc(db, "promotions", promo.id), data, { merge: true }); // merge keeps createdAt
      else await addDoc(collection(db, "promotions"), { ...data, createdAt: serverTimestamp() });
      onClose();
    }, "已儲存");

  const scopeEditor = (key: "scope" | "addonScope", label: string) => {
    const s = (p[key] ?? { kind: "all" }) as PromoScope;
    return (
      <Field label={label}>
        <div className="segmented">
          {(
            [
              ["all", "全部商品"],
              ["categories", "依分類"],
              ["products", "指定商品"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={s.kind === k ? "active" : ""}
              onClick={() => set({ [key]: k === "all" ? { kind: "all" } : k === "categories" ? { kind: "categories", categories: [] } : { kind: "products", productIds: [] } } as Partial<Promotion>)}
            >
              {l}
            </button>
          ))}
        </div>
        {s.kind === "categories" && <CategoryPicker value={s.categories} onChange={(categories) => set({ [key]: { kind: "categories", categories } } as Partial<Promotion>)} />}
        {s.kind === "products" && (
          <div className="row-between">
            <span>已選 {s.productIds.length} 款</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setPicking(key)}>
              選擇商品
            </button>
          </div>
        )}
      </Field>
    );
  };

  const off = Number(p.percentOff) || 0;
  return (
    <Modal
      title={promo ? "編輯促銷活動" : "新增促銷活動"}
      onClose={onClose}
      wide
      footer={
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          儲存
        </button>
      }
    >
      <div className="grid-fields">
        <Field label="活動名稱（會印在收據上）">
          <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="例：秋季出清 第二件6折" />
        </Field>
        <Field label="開始日">
          <input type="date" value={p.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value })} />
        </Field>
        <Field label="結束日（留空 = 不限）">
          <input type="date" value={p.endDate ?? ""} onChange={(e) => set({ endDate: e.target.value })} />
        </Field>
      </div>

      <Field label="活動類型" hint={TYPE_HINT[p.type]}>
        <div className="segmented">
          {(Object.keys(PROMO_TYPE_LABEL) as PromoType[]).map((t) => (
            <button key={t} type="button" className={p.type === t ? "active" : ""} onClick={() => set({ type: t })}>
              {PROMO_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid-fields">
        {(p.type === "nth_discount" || p.type === "bundle_price") && (
          <Field label={p.type === "nth_discount" ? "第幾件" : "任選幾件"}>
            <input type="number" min={p.type === "nth_discount" ? 2 : 1} value={p.n ?? ""} onChange={(e) => set({ n: Number(e.target.value) })} />
          </Field>
        )}
        {(p.type === "percent_off" || p.type === "nth_discount") && (
          <Field label="折扣 %" hint={off > 0 && off < 100 ? `= ${(100 - off) / 10} 折` : undefined}>
            <input type="number" min={1} max={100} value={p.percentOff ?? ""} onChange={(e) => set({ percentOff: Number(e.target.value) })} />
          </Field>
        )}
        {p.type === "bundle_price" && (
          <Field label="特價（元）">
            <input type="number" min={0} value={p.bundlePrice ?? ""} onChange={(e) => set({ bundlePrice: Number(e.target.value) })} />
          </Field>
        )}
        {p.type === "addon" && (
          <Field label="加購價（元）">
            <input type="number" min={0} value={p.addonPrice ?? ""} onChange={(e) => set({ addonPrice: Number(e.target.value) })} />
          </Field>
        )}
      </div>

      {scopeEditor("scope", p.type === "addon" ? "要買的商品（觸發加購）" : "適用商品")}
      {p.type === "addon" && scopeEditor("addonScope", "可加價購的商品")}

      <label className="check">
        <input type="checkbox" checked={p.active} onChange={(e) => set({ active: e.target.checked })} /> 啟用
      </label>
      {promoIsLive({ ...(p as Promotion), id: "x" }, todayStr()) && <p className="muted small">儲存後收銀畫面立即生效：{describePromo(p as Promotion)}</p>}

      {picking && (
        <ProductPicker
          value={(p[picking] as PromoScope | undefined)?.kind === "products" ? ((p[picking] as { productIds: string[] }).productIds) : []}
          onClose={() => setPicking(null)}
          onChange={(productIds) => set({ [picking]: { kind: "products", productIds } } as Partial<Promotion>)}
        />
      )}
    </Modal>
  );
}

function CategoryPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { variants } = useData();
  const all = useMemo(() => [...new Set(variants.flatMap((v) => [v.posCategory, ...(v.tags ?? [])]).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "zh-Hant")), [variants]);
  return (
    <div className="chips">
      {all.map((c) => (
        <button key={c} type="button" className={`chip ${value.includes(c) ? "active" : ""}`} onClick={() => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c])}>
          {c}
        </button>
      ))}
      {!all.length && <span className="muted">meepShop 商品還沒有標籤</span>}
    </div>
  );
}

interface ProductRow {
  productId: string;
  title: string;
  imageUrl: string | null;
  price: number;
  stock: number;
  sales30: number;
  lastSoldDays: number | null;
  hasStats: boolean;
}

type PickSort = "least" | "unsold" | "stock" | "name";

/** 選商品：可依「近 30 天賣最少」「最久沒賣」排序，一鍵選出最慢的 N 款。 */
function ProductPicker({ value, onChange, onClose }: { value: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const { variants } = useData();
  const [sel, setSel] = useState<Set<string>>(new Set(value));
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<PickSort>("least");
  const [onlyStock, setOnlyStock] = useState(true);
  const [topN, setTopN] = useState(20);

  const products = useMemo(() => {
    const map = new Map<string, ProductRow>();
    const vs: Variant[] = q.trim() ? searchVariants(variants, q) : variants;
    for (const v of vs) {
      const r = map.get(v.productId) ?? { productId: v.productId, title: v.productTitle, imageUrl: v.imageUrl, price: v.price, stock: 0, sales30: 0, lastSoldDays: null, hasStats: false };
      r.stock += Math.max(0, v.shopStock ?? 0);
      r.sales30 += v.sales30 ?? 0;
      r.hasStats ||= !!v.statsAt;
      const d = daysSince(v.lastSoldAt);
      if (d !== null) r.lastSoldDays = r.lastSoldDays === null ? d : Math.min(r.lastSoldDays, d);
      map.set(v.productId, r);
    }
    let list = [...map.values()];
    if (onlyStock) list = list.filter((r) => r.stock > 0);
    const unsold = (r: ProductRow) => r.lastSoldDays ?? 9999;
    const cmp: Record<PickSort, (a: ProductRow, b: ProductRow) => number> = {
      least: (a, b) => a.sales30 - b.sales30 || unsold(b) - unsold(a) || b.stock - a.stock,
      unsold: (a, b) => unsold(b) - unsold(a) || b.stock - a.stock,
      stock: (a, b) => b.stock - a.stock,
      name: (a, b) => a.title.localeCompare(b.title, "zh-Hant"),
    };
    return list.sort(cmp[sort]);
  }, [variants, q, sort, onlyStock]);

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Modal
      title={`選擇商品（已選 ${sel.size} 款）`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => setSel(new Set())}>
            全部取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              onChange([...sel]);
              onClose();
            }}
          >
            確定
          </button>
        </>
      }
    >
      <div className="filters">
        <input placeholder="搜尋商品" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 200px" }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as PickSort)}>
          <option value="least">近 30 天賣最少</option>
          <option value="unsold">最久沒賣出</option>
          <option value="stock">庫存最多</option>
          <option value="name">名稱</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> 只看有庫存
        </label>
      </div>
      <div className="inline-form">
        <span>一鍵選取目前排序的前</span>
        <input type="number" min={1} value={topN} onChange={(e) => setTopN(Math.max(1, Number(e.target.value) || 1))} style={{ flex: "0 0 80px" }} />
        <span>款</span>
        <button className="btn btn-primary btn-sm" onClick={() => setSel(new Set([...sel, ...products.slice(0, topN).map((r) => r.productId)]))}>
          加入選取
        </button>
      </div>
      {!products.some((r) => r.hasStats) && <p className="notice notice-warn">還沒有銷售統計，請先到「庫存查詢」按「更新銷售統計」。</p>}
      <div className="table-wrap">
        <table className="table table-compact table-click">
          <thead>
            <tr>
              <th />
              <th>商品</th>
              <th className="num">價格</th>
              <th className="num">庫存</th>
              <th className="num">近 30 天銷量</th>
              <th>最後賣出</th>
            </tr>
          </thead>
          <tbody>
            {products.slice(0, 300).map((r) => (
              <tr key={r.productId} onClick={() => toggle(r.productId)}>
                <td>
                  <input type="checkbox" readOnly checked={sel.has(r.productId)} />
                </td>
                <td>
                  <div className="row-inline">
                    {r.imageUrl && <img src={r.imageUrl} alt="" className="thumb-sm" />}
                    {r.title}
                  </div>
                </td>
                <td className="num">{money(r.price)}</td>
                <td className="num">{r.stock}</td>
                <td className="num">{r.hasStats ? r.sales30 : "—"}</td>
                <td>{!r.hasStats ? "—" : r.lastSoldDays === null ? <span className="error">120 天以上</span> : `${r.lastSoldDays} 天前`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
