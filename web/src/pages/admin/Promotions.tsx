import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth";
import { Badge, Empty, Field, Modal, useAction } from "../../components/ui";
import { daysSince, useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { Barcode } from "../../components/Barcode";
import { QrImg } from "../../components/QrImg";
import { searchVariants } from "../../lib/lookup";
import { applyPromotions, describePromo, inScope, PROMO_TYPE_LABEL, taipeiClock, type PromoScope, type PromoType, type Promotion } from "../../lib/promo";
import { downloadCsv, money, todayStr } from "../../lib/util";
import type { Variant } from "../../types";

type PromoDoc = Promotion & { note?: string };

export function Promotions() {
  const [list, setList] = useState<PromoDoc[]>([]);
  const [edit, setEdit] = useState<PromoDoc | "new" | null>(null);
  const [couponFor, setCouponFor] = useState<PromoDoc | null>(null);
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
                {p.couponOnly && (
                  <button className="btn btn-sm btn-primary" onClick={() => setCouponFor(p)}>
                    優惠碼
                  </button>
                )}
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
      {couponFor && <CouponManager promo={couponFor} onClose={() => setCouponFor(null)} />}
    </div>
  );
}

function scopeText(s?: PromoScope) {
  if (!s || s.kind === "all") return "全部商品";
  if (s.kind === "categories") return `分類：${s.categories.join("、") || "（未選）"}`;
  return `指定 ${s.productIds.length} 款商品`;
}

const TYPE_HINT: Record<PromoType, string> = {
  percent_off: "適用商品直接打折。例：滯銷品 7 折、全館 85 折",
  amount_off: "適用商品每件折抵固定金額。例：每件折 $100",
  nth_discount: "每 N 件中最便宜的那件打折。例：第二件 6 折",
  bundle_price: "任選 N 件組成特價（優先把貴的湊成一組）。例：任選 3 件 $1000",
  threshold: "適用商品合計滿額或滿件數就折。例：滿 $2000 折 $200、每滿 $1000 折 $100、買 3 件以上 85 折",
  addon: "買適用商品，可用加購價買另一件指定商品。例：買上衣，配件加 $99 購",
};
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** 幾折 ↔ 折扣 %：7 折 = 30% off；75 折 = 25% off */
const zheToPct = (z: number) => (z <= 0 ? 0 : z < 10 ? 100 - z * 10 : 100 - z);
const pctToZhe = (p: number | undefined) => {
  const z = 100 - (p ?? 0);
  return z % 10 === 0 ? z / 10 : z;
};

function PromoEditor({ promo, onClose }: { promo: PromoDoc | null; onClose: () => void }) {
  const { profile } = useAuth();
  const { settings, variants } = useData();
  const [p, setP] = useState<Omit<PromoDoc, "id">>(
    promo ?? { name: "", active: true, type: "nth_discount", n: 2, percentOff: 40, scope: { kind: "all" }, startDate: todayStr(), endDate: "", memberRule: "none", thresholdType: "amount", thresholdReward: "amount" }
  );
  const [picking, setPicking] = useState<"scope" | "addonScope" | "excludeScope" | null>(null);
  const { busy, run } = useAction();
  const set = (patch: Partial<Promotion>) => setP((x) => ({ ...x, ...patch }));
  const tiers = (settings.memberTiers ?? []).map((t) => t.name);
  const groups = settings.memberGroups ?? [];

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
        excludeScope: p.excludeScope && p.excludeScope.kind !== "all" ? p.excludeScope : null,
        memberRule: p.memberRule ?? "none",
        memberTiers: p.memberRule === "tiers" ? p.memberTiers ?? [] : [],
        memberGroups: p.memberRule === "groups" ? p.memberGroups ?? [] : [],
        days: p.days?.length && p.days.length < 7 ? p.days : [],
        timeFrom: p.timeFrom || null,
        timeTo: p.timeTo || null,
        minSpend: Number(p.minSpend) || 0,
        maxUses: Number(p.maxUses) || 0,
        noMemberStack: !!p.noMemberStack,
        couponOnly: !!p.couponOnly,
        note: p.note ?? null,
        updatedBy: profile?.name ?? "",
        updatedAt: serverTimestamp(),
      };
      const needsPct = p.type === "percent_off" || p.type === "nth_discount" || (p.type === "threshold" && p.thresholdReward === "percent");
      const needsAmt = p.type === "amount_off" || (p.type === "threshold" && p.thresholdReward === "amount");
      if (needsPct) {
        if (!(Number(p.percentOff) > 0 && Number(p.percentOff) < 100)) throw new Error("請輸入幾折（例：7 或 75）");
        data.percentOff = Number(p.percentOff);
      }
      if (needsAmt) {
        if (!(Number(p.amountOff) > 0)) throw new Error("請輸入折抵金額");
        data.amountOff = Number(p.amountOff);
      }
      if (p.type === "nth_discount" || p.type === "bundle_price") data.n = Number(p.n) || 2;
      if (p.type === "bundle_price") data.bundlePrice = Number(p.bundlePrice) || 0;
      if (p.type === "threshold") {
        if (!(Number(p.threshold) > 0)) throw new Error("請輸入門檻");
        Object.assign(data, { thresholdType: p.thresholdType ?? "amount", threshold: Number(p.threshold), thresholdReward: p.thresholdReward ?? "amount", repeat: !!p.repeat });
      }
      if (p.type === "addon") {
        data.addonScope = p.addonScope ?? { kind: "all" };
        data.addonPrice = Number(p.addonPrice) || 0;
      }
      if (promo) await setDoc(doc(db, "promotions", promo.id), data, { merge: true }); // merge keeps createdAt
      else await addDoc(collection(db, "promotions"), { ...data, createdAt: serverTimestamp() });
      onClose();
    }, "已儲存");

  const scopeEditor = (key: "scope" | "addonScope" | "excludeScope", label: string, allowAll = true) => {
    const s = (p[key] ?? { kind: "all" }) as PromoScope;
    const choices = [...(allowAll ? [["all", key === "excludeScope" ? "不排除" : "全部商品"]] : []), ["categories", "依分類"], ["products", "指定商品"]] as [PromoScope["kind"], string][];
    return (
      <Field label={label}>
        <div className="segmented">
          {choices.map(([k, l]) => (
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

  const zheField = (
    <Field label="打幾折" hint={Number(p.percentOff) > 0 ? `= 折扣 ${p.percentOff}%（例：$1000 → $${1000 - Math.round((1000 * Number(p.percentOff)) / 100)}）` : "輸入 7 = 7 折、75 = 75 折、9 = 9 折"}>
      <input type="number" min={1} max={99} step={1} value={p.percentOff ? pctToZhe(p.percentOff) : ""} onChange={(e) => set({ percentOff: zheToPct(Number(e.target.value)) })} placeholder="例：7" />
    </Field>
  );

  // 試算：適用範圍內最貴的 4 件、各 1 件
  const sample = useMemo(() => {
    const live = { ...(p as Promotion), id: "preview", active: true, startDate: null, endDate: null, days: [], timeFrom: null, timeTo: null, memberRule: "none" as const };
    const info = (v: (typeof variants)[number]) => ({ productId: v.productId, category: v.posCategory, tags: v.tags ?? [] });
    const pool = variants.filter((v) => (v.price ?? 0) > 0 && inScope(live.scope, info(v)) && !(live.excludeScope && live.excludeScope.kind !== "all" && inScope(live.excludeScope, info(v))));
    const seen = new Set<string>();
    const picks = pool.filter((v) => !seen.has(v.productId) && seen.add(v.productId)).slice(0, 3);
    if (live.type === "addon") {
      const add = variants.find((v) => inScope(live.addonScope, info(v)) && !picks.some((x) => x.id === v.id));
      if (add) picks.push(add);
    }
    const lines = picks.map((v, i) => ({ key: String(i), variantId: v.id, qty: live.type === "nth_discount" || live.type === "bundle_price" ? 1 : 1, unitPrice: v.price, discountPct: 0 }));
    const r = applyPromotions(lines, (vid) => {
      const v = variants.find((x) => x.id === vid);
      return v ? info(v) : undefined;
    }, [live], { ...taipeiClock(), isMember: true, tier: null, group: null });
    return { picks, r };
  }, [p, variants]);

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
      <h3 className="form-section">1. 基本設定</h3>
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

      <h3 className="form-section">2. 優惠方式</h3>
      <div className="type-grid">
        {(Object.keys(PROMO_TYPE_LABEL) as PromoType[]).map((t) => (
          <button key={t} type="button" className={`type-card ${p.type === t ? "active" : ""}`} onClick={() => set({ type: t })}>
            <strong>{PROMO_TYPE_LABEL[t]}</strong>
            <small>{TYPE_HINT[t].split("。")[0]}</small>
          </button>
        ))}
      </div>
      <p className="muted small">{TYPE_HINT[p.type]}</p>
      <div className="grid-fields">
        {(p.type === "percent_off" || p.type === "nth_discount") && zheField}
        {p.type === "amount_off" && (
          <Field label="每件折抵（元）">
            <input type="number" min={1} value={p.amountOff ?? ""} onChange={(e) => set({ amountOff: Number(e.target.value) })} />
          </Field>
        )}
        {(p.type === "nth_discount" || p.type === "bundle_price") && (
          <Field label={p.type === "nth_discount" ? "第幾件" : "任選幾件"}>
            <input type="number" min={p.type === "nth_discount" ? 2 : 1} value={p.n ?? ""} onChange={(e) => set({ n: Number(e.target.value) })} />
          </Field>
        )}
        {p.type === "bundle_price" && (
          <Field label="組合特價（元）">
            <input type="number" min={0} value={p.bundlePrice ?? ""} onChange={(e) => set({ bundlePrice: Number(e.target.value) })} />
          </Field>
        )}
        {p.type === "addon" && (
          <Field label="加購價（元）">
            <input type="number" min={0} value={p.addonPrice ?? ""} onChange={(e) => set({ addonPrice: Number(e.target.value) })} />
          </Field>
        )}
        {p.type === "threshold" && (
          <>
            <Field label="門檻">
              <div className="inline-form" style={{ margin: 0 }}>
                <select value={p.thresholdType ?? "amount"} onChange={(e) => set({ thresholdType: e.target.value as "amount" | "qty" })}>
                  <option value="amount">滿金額（元）</option>
                  <option value="qty">滿件數（件）</option>
                </select>
                <input type="number" min={1} value={p.threshold ?? ""} onChange={(e) => set({ threshold: Number(e.target.value) })} placeholder={p.thresholdType === "qty" ? "例：3" : "例：2000"} />
              </div>
            </Field>
            <Field label="達到後">
              <select value={p.thresholdReward ?? "amount"} onChange={(e) => set({ thresholdReward: e.target.value as "amount" | "percent" })}>
                <option value="amount">折抵金額</option>
                <option value="percent">打折</option>
              </select>
            </Field>
            {p.thresholdReward === "percent" ? (
              zheField
            ) : (
              <Field label="折抵（元）">
                <input type="number" min={1} value={p.amountOff ?? ""} onChange={(e) => set({ amountOff: Number(e.target.value) })} />
              </Field>
            )}
            {p.thresholdReward !== "percent" && (
              <label className="check">
                <input type="checkbox" checked={!!p.repeat} onChange={(e) => set({ repeat: e.target.checked })} /> 每滿一次再折一次（例：每滿 $1000 折 $100）
              </label>
            )}
          </>
        )}
      </div>

      <h3 className="form-section">3. 適用商品</h3>
      {scopeEditor("scope", p.type === "addon" ? "要買的商品（觸發加購）" : "適用商品")}
      {p.type === "addon" && scopeEditor("addonScope", "可加價購的商品")}
      {scopeEditor("excludeScope", "排除（不參加活動的商品，例：新品、特價品）")}

      <h3 className="form-section">4. 條件</h3>
      <div className="grid-fields">
        <Field label="適用對象">
          <select value={p.memberRule ?? "none"} onChange={(e) => set({ memberRule: e.target.value as Promotion["memberRule"] })}>
            <option value="none">所有客人</option>
            <option value="members">會員限定</option>
            {groups.length > 0 && <option value="groups">指定 meepShop 會員群組</option>}
            {tiers.length > 0 && <option value="tiers">指定本系統會員等級</option>}
          </select>
        </Field>
        <Field label="最低消費（適用商品合計，元）" hint="0 = 不限">
          <input type="number" min={0} value={p.minSpend ?? 0} onChange={(e) => set({ minSpend: Number(e.target.value) })} />
        </Field>
        <Field label="每單最多套用（件／組／次）" hint="0 = 不限">
          <input type="number" min={0} value={p.maxUses ?? 0} onChange={(e) => set({ maxUses: Number(e.target.value) })} />
        </Field>
      </div>
      {p.memberRule === "groups" && (
        <div className="chips">
          {groups.map((g) => {
            const on = (p.memberGroups ?? []).includes(g);
            return (
              <button key={g} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => set({ memberGroups: on ? (p.memberGroups ?? []).filter((x) => x !== g) : [...(p.memberGroups ?? []), g] })}>
                {g}
              </button>
            );
          })}
        </div>
      )}
      {p.memberRule === "tiers" && (
        <div className="chips">
          {tiers.map((g) => {
            const on = (p.memberTiers ?? []).includes(g);
            return (
              <button key={g} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => set({ memberTiers: on ? (p.memberTiers ?? []).filter((x) => x !== g) : [...(p.memberTiers ?? []), g] })}>
                {g}
              </button>
            );
          })}
        </div>
      )}
      <Field label="星期（都不選 = 每天）">
        <div className="chips">
          {WEEK.map((w, i) => {
            const on = (p.days ?? []).includes(i);
            return (
              <button key={i} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => set({ days: on ? (p.days ?? []).filter((x) => x !== i) : [...(p.days ?? []), i].sort() })}>
                週{w}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="grid-fields">
        <Field label="時段開始（留空 = 開店）">
          <input type="time" value={p.timeFrom ?? ""} onChange={(e) => set({ timeFrom: e.target.value })} />
        </Field>
        <Field label="時段結束（留空 = 打烊）">
          <input type="time" value={p.timeTo ?? ""} onChange={(e) => set({ timeTo: e.target.value })} />
        </Field>
      </div>

      <h3 className="form-section">5. 搭配與優惠碼</h3>
      <label className="check">
        <input type="checkbox" checked={!!p.couponOnly} onChange={(e) => set({ couponOnly: e.target.checked })} /> 需要優惠碼才能使用（儲存後在活動卡片按「優惠碼」產生）
      </label>
      <label className="check">
        <input type="checkbox" checked={!p.noMemberStack} onChange={(e) => set({ noMemberStack: !e.target.checked })} /> 可以和會員等級折扣併用
      </label>
      <p className="muted small">同一件商品只會套一個促銷活動；多個活動重疊時，系統自動選對客人最優惠的組合。店員手動打折的品項不再套活動。</p>
      <label className="check">
        <input type="checkbox" checked={p.active} onChange={(e) => set({ active: e.target.checked })} /> 啟用
      </label>

      <div className="preview-box">
        <strong>活動摘要：</strong>
        {describePromo(p as Promotion)}
        {sample.picks.length > 0 ? (
          <div className="small">
            試算：{sample.picks.map((v) => `${variantName(v)} ${money(v.price)}`).join(" ＋ ")}
            <br />→ 合計 {money(sample.picks.reduce((s2, v) => s2 + v.price, 0))}，折 <strong>{money(sample.r.total)}</strong>
            {sample.r.total === 0 && "（這個組合還沒達到條件）"}
          </div>
        ) : (
          <div className="small muted">適用範圍內沒有商品可以試算</div>
        )}
      </div>

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

interface Coupon {
  code: string;
  kind: "shared" | "single";
  used: number;
  maxUses: number;
  active: boolean;
  expiresAt: { toMillis(): number; toDate(): Date } | null;
}

/** 優惠碼：共用碼（例 VIP2026）或 N 張單次碼；可列印 QR／條碼、匯出 Excel */
function CouponManager({ promo, onClose }: { promo: PromoDoc; onClose: () => void }) {
  const [list, setList] = useState<Coupon[]>([]);
  const [kind, setKind] = useState<"shared" | "single">("shared");
  const [code, setCode] = useState("");
  const [count, setCount] = useState(20);
  const [maxUses, setMaxUses] = useState(0);
  const [expires, setExpires] = useState(promo.endDate ?? "");
  const [printing, setPrinting] = useState<Coupon[] | null>(null);
  const { busy, run } = useAction();
  useEffect(
    () => onSnapshot(query(collection(db, "coupons"), where("promoId", "==", promo.id)), (s) => setList(s.docs.map((d) => d.data() as Coupon).sort((a, b) => a.code.localeCompare(b.code)))),
    [promo.id]
  );
  const left = (c: Coupon) => (c.maxUses ? Math.max(0, c.maxUses - c.used) : Infinity);
  const unused = list.filter((c) => c.active && left(c) > 0);
  return (
    <Modal
      title={`優惠碼：${promo.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" disabled={!list.length} onClick={() => downloadCsv(`優惠碼_${promo.name}.csv`, [["優惠碼", "類型", "已使用", "上限", "狀態", "到期"], ...list.map((c) => [c.code, c.kind === "shared" ? "共用" : "單次", c.used, c.maxUses || "不限", c.active ? "啟用" : "停用", c.expiresAt ? c.expiresAt.toDate().toISOString().slice(0, 10) : ""])])}>
            匯出 Excel
          </button>
          <button className="btn btn-primary" disabled={!unused.length} onClick={() => setPrinting(unused)}>
            列印未使用的優惠碼（{unused.length}）
          </button>
        </>
      }
    >
      <p className="muted small">{describePromo(promo)}。收銀時掃描或輸入優惠碼就會套用。</p>
      <div className="segmented">
        <button className={kind === "shared" ? "active" : ""} onClick={() => setKind("shared")}>
          共用碼<small>一組碼大家都能用</small>
        </button>
        <button className={kind === "single" ? "active" : ""} onClick={() => setKind("single")}>
          單次碼<small>每張只能用一次</small>
        </button>
      </div>
      <div className="inline-form">
        {kind === "shared" ? (
          <>
            <input placeholder="優惠碼，例：VIP2026" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <label className="check">
              總次數上限
              <input type="number" min={0} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))} style={{ width: 90 }} />
              <span className="muted small">（0 = 不限）</span>
            </label>
          </>
        ) : (
          <label className="check">
            產生
            <input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 90 }} />
            張
          </label>
        )}
        <label className="check">
          到期日
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <button
          className="btn btn-primary"
          disabled={busy || (kind === "shared" && !code.trim())}
          onClick={() =>
            run(async () => {
              const r = await call<{ codes: string[] }>("createCoupons", { promoId: promo.id, kind, code, count, maxUses, expiresAt: expires || null });
              setCode("");
              return r;
            }, "已產生優惠碼")
          }
        >
          產生
        </button>
      </div>
      {list.length === 0 ? (
        <Empty>還沒有優惠碼</Empty>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}>
          <table className="table table-compact">
            <tbody>
              {list.map((c) => (
                <tr key={c.code} className={c.active ? "" : "row-muted"}>
                  <td>
                    <code>{c.code}</code>
                  </td>
                  <td>{c.kind === "shared" ? "共用" : "單次"}</td>
                  <td className="num">
                    已用 {c.used}
                    {c.maxUses ? ` / ${c.maxUses}` : ""}
                  </td>
                  <td>{c.expiresAt ? `${c.expiresAt.toDate().toISOString().slice(0, 10)} 到期` : "不限期"}</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => run(() => call("setCouponActive", { code: c.code, active: !c.active }), c.active ? "已停用" : "已啟用")}>
                      {c.active ? "停用" : "啟用"}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setPrinting([c])}>
                      列印
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {printing && <CouponPrint promo={promo} coupons={printing} onClose={() => setPrinting(null)} />}
    </Modal>
  );
}

/** 優惠券列印：QR＋條碼＋活動說明，A4 排版或標籤機一張一頁 */
function CouponPrint({ promo, coupons, onClose }: { promo: PromoDoc; coupons: Coupon[]; onClose: () => void }) {
  const { settings } = useData();
  return (
    <div className="coupon-print-overlay">
      <div className="no-print btn-row coupon-print-bar">
        <strong>列印 {coupons.length} 張優惠券</strong>
        <button className="btn btn-primary" onClick={() => window.print()}>
          列印
        </button>
        <button className="btn" onClick={onClose}>
          關閉
        </button>
      </div>
      <div className="coupon-sheet">
        {coupons.map((c) => (
          <div key={c.code} className="coupon">
            <div className="coupon-shop">{settings.shopName || "ganbaru29"}</div>
            <div className="coupon-title">{promo.name}</div>
            <div className="coupon-desc">{describePromo(promo)}</div>
            <QrImg value={c.code} size={96} />
            <Barcode value={c.code} height={34} width={1.4} fontSize={11} />
            <div className="coupon-foot">
              {c.expiresAt ? `${c.expiresAt.toDate().toISOString().slice(0, 10)} 前有效` : promo.endDate ? `${promo.endDate} 前有效` : ""}
              {c.kind === "single" ? "・限用一次" : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
