import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, serverTimestamp, setDoc, where } from "firebase/firestore";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth";
import { Badge, Empty, Field, Modal, useAction } from "../../components/ui";
import { daysSince, useData, variantName } from "../../data";
import { call, db } from "../../firebase";
import { Barcode } from "../../components/Barcode";
import { QrImg } from "../../components/QrImg";
import { searchVariants } from "../../lib/lookup";
import { applyPromotions, describePromo, inScope, levelText, taipeiClock, type PromoLevel, type PromoScope, type Promotion } from "../../lib/promo";
import { downloadCsv, money, todayStr } from "../../lib/util";
import type { PointGift, Variant } from "../../types";

type PromoDoc = Promotion & { note?: string };

/* ---------------- 折扣分類（同 meepShop 新增折扣） ---------------- */

type Kind = "product_discount" | "product_threshold" | "bundle" | "product_coupon" | "addon" | "order_threshold" | "shipping" | "order_gift" | "order_coupon" | "points";

const ICON: Record<string, ReactNode> = {
  tag: <path d="M3 12V4h8l10 10-8 8L3 12zm5-5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />,
  bag: <path d="M6 7h12l1 14H5L6 7zm3 0a3 3 0 016 0M9.5 17l5-6M10 11.5h.01M14 16.5h.01" />,
  shapes: <path d="M12 3l3.5 6h-7L12 3zM4 14h6v6H4v-6zm13 0a3 3 0 110 6 3 3 0 010-6z" />,
  barcode: <path d="M4 5v14M7 5v14M10 5v14M12 5v14M15 5v14M17 5v14M20 5v14" />,
  plus: <path d="M12 5v14M5 12h14M4 4h16v16H4z" />,
  clipboard: <path d="M8 4h8v3H8zM6 5H5v16h14V5h-1M12 10v7m2-5.5c0-.8-.9-1.5-2-1.5s-2 .7-2 1.5 1 1.3 2 1.5 2 .7 2 1.5-.9 1.5-2 1.5-2-.7-2-1.5" />,
  truck: <path d="M2 6h12v10H2zM14 10h4l3 3v3h-7M6 19a2 2 0 100-4 2 2 0 000 4zm11 0a2 2 0 100-4 2 2 0 000 4z" />,
  gift: <path d="M4 10h16v4H4zM5 14h14v7H5zM12 10v11M12 10c-2-4-6-4-6-1.5S10 10 12 10zm0 0c2-4 6-4 6-1.5S14 10 12 10z" />,
  dollar: <path d="M12 3a9 9 0 110 18 9 9 0 010-18zm0 3v12m3-9.5c0-1-1.3-1.8-3-1.8s-3 .8-3 1.8 1.3 1.6 3 2 3 1 3 2-1.3 1.8-3 1.8-3-.8-3-1.8" />,
  edit: <path d="M4 20h16M6 16l10-10 2 2-10 10H6v-2z" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  ticket: <path d="M3 8a2 2 0 002-2h14a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 00-2 2H5a2 2 0 00-2-2v-2a2 2 0 000-4V8zM14 7v10" />,
  back: <path d="M19 12H5m6-6l-6 6 6 6" />,
  chev: <path d="M9 6l6 6-6 6" />,
};
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICON[name]}
    </svg>
  );
}

interface KindDef {
  kind: Kind;
  section: "product" | "order";
  title: string;
  /** 編輯頁標題 */
  editorTitle: string;
  desc: string;
  icon: string;
  preset?: Partial<Promotion>;
  disabled?: string;
}
const KINDS: KindDef[] = [
  { kind: "product_discount", section: "product", title: "商品折扣", editorTitle: "商品折扣", desc: "適用商品享 X 元/折", icon: "tag", preset: { type: "percent_off", percentOff: 15 } },
  { kind: "product_threshold", section: "product", title: "滿額折扣", editorTitle: "商品滿額折扣", desc: "滿額滿件享 X 元/折", icon: "bag", preset: { type: "threshold", thresholdType: "amount", thresholdReward: "amount", levels: [{ threshold: 2000, value: 200 }] } },
  { kind: "bundle", section: "product", title: "選選樂", editorTitle: "選選樂", desc: "商品搭配享 X 元/折", icon: "shapes", preset: { type: "bundle_price", n: 3, bundlePrice: 1000 } },
  { kind: "product_coupon", section: "product", title: "優惠碼", editorTitle: "商品優惠碼", desc: "商品符合條件可使用", icon: "barcode", preset: { type: "percent_off", percentOff: 10, couponOnly: true } },
  { kind: "addon", section: "product", title: "加價購", editorTitle: "加價購", desc: "買 A 可加價購 B", icon: "plus", preset: { type: "addon", addonPrice: 99 } },
  { kind: "order_threshold", section: "order", title: "滿額折扣", editorTitle: "訂單滿額折扣", desc: "滿額滿件享 X 元/折", icon: "clipboard", preset: { type: "threshold", orderLevel: true, thresholdType: "amount", thresholdReward: "amount", levels: [{ threshold: 2000, value: 200 }] } },
  { kind: "shipping", section: "order", title: "滿額免運", editorTitle: "滿額免運", desc: "訂單符合條件享免運", icon: "truck", disabled: "門市結帳沒有運費；網店免運請在 meepShop 設定" },
  { kind: "order_gift", section: "order", title: "滿額贈", editorTitle: "滿額贈", desc: "滿額滿件送贈品", icon: "gift", preset: { type: "gift", orderLevel: true, thresholdType: "amount", levels: [{ threshold: 3000, value: 1 }], addonScope: { kind: "products", productIds: [] } } },
  { kind: "order_coupon", section: "order", title: "優惠碼", editorTitle: "訂單優惠碼", desc: "訂單符合條件可使用", icon: "barcode", preset: { type: "threshold", orderLevel: true, couponOnly: true, thresholdType: "amount", thresholdReward: "amount", levels: [{ threshold: 1, value: 100 }] } },
  { kind: "points", section: "order", title: "購物金", editorTitle: "購物金", desc: "註冊/生日/滿額贈", icon: "dollar" },
];
const kindDef = (k: Kind) => KINDS.find((x) => x.kind === k)!;

function kindOf(p: Promotion): Kind {
  if (p.couponOnly) return p.orderLevel ? "order_coupon" : "product_coupon";
  if (p.type === "gift") return "order_gift";
  if (p.type === "threshold") return p.orderLevel ? "order_threshold" : "product_threshold";
  if (p.type === "bundle_price") return "bundle";
  if (p.type === "addon") return "addon";
  return "product_discount";
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];
/** 幾折 ↔ 折扣 %：7 折 = 30% off；85 折 = 15% off */
const zheToPct = (z: number) => (z <= 0 ? 0 : z < 10 ? Math.round(100 - z * 10) : 100 - z);
const pctToZhe = (p: number | undefined) => {
  const z = 100 - (p ?? 0);
  return z % 10 === 0 ? z / 10 : z;
};
/** 15 → 8.5 折（meepShop 的寫法） */
const zheDot = (pct: number | undefined) => `${(100 - (pct ?? 0)) / 10} 折`;

/** 折扣方式，例：享優惠 8.5 折 */
function discountText(p: Promotion) {
  switch (p.type) {
    case "percent_off":
      return `享優惠 ${zheDot(p.percentOff)}`;
    case "amount_off":
      return `每件折 $${p.amountOff ?? 0}`;
    case "nth_discount":
      return `第 ${p.n ?? 2} 件 ${zheDot(p.percentOff)}`;
    case "bundle_price":
      return `任選 ${p.n ?? 1} 件 $${p.bundlePrice ?? 0}`;
    case "addon":
      return `加價 $${p.addonPrice ?? 0} 購`;
    default:
      return levelText(p).replace(/(\d+) 折/g, (_, z) => zheDot(zheToPct(Number(z))));
  }
}

function groupText(groups?: string[] | null, rule?: Promotion["memberRule"], tiers?: string[]) {
  if (rule === "groups") return (groups ?? []).join("、") || "（未選群組）";
  if (rule === "tiers") return `本系統等級：${(tiers ?? []).join("、")}`;
  if (rule === "members") return "所有會員";
  return "所有顧客";
}

function periodText(p: Promotion) {
  const range = !p.startDate && !p.endDate ? "永久開啟" : `${p.startDate || "即日起"} ～ ${p.endDate || "不限"}`;
  const extra = [p.days?.length && p.days.length < 7 ? `每週${p.days.map((d) => WEEK_ZH[d]).join("、")}` : "", p.timeFrom || p.timeTo ? `${p.timeFrom || "開店"}～${p.timeTo || "打烊"}` : ""].filter(Boolean);
  return extra.length ? `${range}（${extra.join("，")}）` : range;
}

/** 折扣搭配（可收合），同 meepShop */
function StackBox({ text, children }: { text: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`stack-box ${open ? "open" : ""}`}>
      <button type="button" onClick={() => setOpen(!open)}>
        <Icon name="chev" size={16} /> 折扣搭配（{text}）
      </button>
      {open && <div className="stack-body">{children}</div>}
    </div>
  );
}

const STACK_HELP = "同一件商品只會套一個折扣活動；多個活動重疊時，系統自動選對客人最優惠的組合。店員手動打折的品項不再套活動。";

export function Promotions() {
  const { settings, variants } = useData();
  const { profile } = useAuth();
  const [list, setList] = useState<PromoDoc[]>([]);
  const [edit, setEdit] = useState<{ promo: PromoDoc | null; kind: Kind } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [couponFor, setCouponFor] = useState<PromoDoc | null>(null);
  const [viewing, setViewing] = useState<{ title: string; scope: PromoScope } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [giftEdit, setGiftEdit] = useState<{ index: number | null; gift: PointGift } | null>(null);
  const { run } = useAction();
  const nav = useNavigate();
  useEffect(() => onSnapshot(query(collection(db, "promotions"), orderBy("createdAt", "desc")), (s) => setList(s.docs.map((d) => ({ id: d.id, ...d.data() }) as PromoDoc))), []);
  const today = todayStr();
  const isOwner = profile?.role === "owner" || profile?.role === "engineer";
  const toggleCollapse = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const productCount = (s: PromoScope) => (s.kind === "products" ? new Set(variants.filter((v) => s.productIds.includes(v.productId)).map((v) => v.productId)).size : 0);
  const scopeCell = (title: string, s?: PromoScope | null, emptyAll = "全部商品") => {
    if (!s || s.kind === "all") return emptyAll;
    if (s.kind === "categories") return `分類：${s.categories.join("、") || "（未選）"}`;
    const n = productCount(s);
    if (!n) return <span className="error">尚未選擇商品（目前不會套用）</span>;
    return (
      <>
        已選擇 {n} 項商品{" "}
        <button className="link-btn" onClick={() => setViewing({ title, scope: s })}>
          查看
        </button>
      </>
    );
  };

  const card = (p: PromoDoc) => {
    const ended = !!p.endDate && today > p.endDate;
    const k = kindOf(p);
    const open = !collapsed.has(p.id);
    return (
      <div key={p.id} className={`disc-card ${p.active && !ended ? "" : "off"} ${open ? "open" : ""}`}>
        <div className="disc-head">
          <button
            className={`tier-switch ${p.active ? "on" : ""}`}
            aria-label={p.active ? "停用" : "啟用"}
            onClick={() => run(() => setDoc(doc(db, "promotions", p.id), { active: !p.active, updatedAt: serverTimestamp() }, { merge: true }), p.active ? "已停用" : "已啟用")}
          />
          <button className="disc-name" onClick={() => toggleCollapse(p.id)}>
            {p.name}
          </button>
          {ended && <Badge>已結束</Badge>}
          {p.startDate && today < p.startDate && <Badge tone="info">{p.startDate} 開始</Badge>}
          <span className="grow" />
          {p.couponOnly && (
            <button className="btn-icon" title="優惠碼" onClick={() => setCouponFor(p)}>
              <Icon name="ticket" />
            </button>
          )}
          <button className="btn-icon" title="編輯" onClick={() => setEdit({ promo: p, kind: k })}>
            <Icon name="edit" />
          </button>
          <button className="btn-icon danger" title="刪除" onClick={() => confirm(`刪除「${p.name}」？過去的訂單紀錄不受影響。`) && run(() => deleteDoc(doc(db, "promotions", p.id)), "已刪除")}>
            <Icon name="trash" />
          </button>
        </div>
        {open && (
          <>
            <dl className="disc-rows">
              <dt>適用群組</dt>
              <dd>{groupText(p.memberGroups, p.memberRule, p.memberTiers)}</dd>
              <dt>活動期間</dt>
              <dd>{periodText(p)}</dd>
              {!p.orderLevel && (
                <>
                  <dt>{p.type === "addon" ? "主商品" : "適用商品"}</dt>
                  <dd>{scopeCell(p.name, p.scope)}</dd>
                </>
              )}
              {(p.type === "addon" || p.type === "gift") && (
                <>
                  <dt>{p.type === "gift" ? "贈品" : "加購商品"}</dt>
                  <dd>{scopeCell(p.name, p.addonScope)}</dd>
                </>
              )}
              {p.excludeScope && p.excludeScope.kind !== "all" && (
                <>
                  <dt>排除商品</dt>
                  <dd>{scopeCell(p.name, p.excludeScope)}</dd>
                </>
              )}
              <dt>折扣方式</dt>
              <dd>{discountText(p)}</dd>
              {p.minSpend || p.maxUses ? (
                <>
                  <dt>條件</dt>
                  <dd>{[p.minSpend ? `適用商品滿 $${p.minSpend}` : "", p.maxUses ? `每單限 ${p.maxUses} 次` : ""].filter(Boolean).join("，")}</dd>
                </>
              ) : null}
            </dl>
            <StackBox text={p.noMemberStack ? "不與會員等級折扣併用" : "可與會員等級折扣併用"}>{STACK_HELP}</StackBox>
          </>
        )}
      </div>
    );
  };

  const groupBox = (section: "product" | "order") => {
    const defs = KINDS.filter((d) => d.section === section);
    const boxes = defs.map((d) => ({ d, items: list.filter((p) => kindOf(p) === d.kind) })).filter((x) => x.items.length);
    if (!boxes.length) return <Empty>{section === "product" ? "還沒有商品折扣" : "還沒有訂單折扣"}</Empty>;
    return boxes.map(({ d, items }) => (
      <div key={d.kind} className={`disc-group ${section}`}>
        <h3>{d.editorTitle}</h3>
        {items.map(card)}
      </div>
    ));
  };

  const rules = settings.rewardRules ?? [];
  const gifts = settings.pointGifts ?? [];
  const saveGifts = (next: PointGift[], msg: string) => run(() => setDoc(doc(db, "settings", "shop"), { pointGifts: next }, { merge: true }), msg);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>折扣</h1>
          <div className="muted small">門市結帳時自動套用；多個活動重疊時自動選最優惠的組合。</div>
        </div>
        <button className="btn btn-primary" onClick={() => setChoosing(true)}>
          新增折扣
        </button>
      </div>

      <section className="disc-section">
        <h2>商品</h2>
        {groupBox("product")}
      </section>
      <section className="disc-section">
        <h2>訂單</h2>
        {groupBox("order")}
      </section>
      <section className="disc-section">
        <div className="row-between">
          <h2>購物金</h2>
          <div className="link-row">
            <button className="link-btn" onClick={() => nav("/admin/rewards")}>
              滿額贈送設定
            </button>
            {isOwner && (
              <>
                <span className="muted">|</span>
                <button className="link-btn" onClick={() => setGiftEdit({ index: null, gift: { kind: "birthday", name: "", active: true, groups: [], daysBefore: 7, points: 200, expiryDays: 365 } })}>
                  新增生日／入會禮
                </button>
              </>
            )}
          </div>
        </div>
        {rules.length === 0 && gifts.length === 0 && <Empty>還沒有購物金活動</Empty>}
        {rules.map((r, i) => (
          <div key={`r${i}`} className={`disc-card open ${r.active ? "" : "off"}`}>
            <div className="disc-head">
              <span className={`tier-switch ${r.active ? "on" : ""}`} />
              <span className="muted">滿額贈送</span>
              <strong>{r.name}</strong>
              <span className="grow" />
              <button className="btn-icon" title="編輯" onClick={() => nav("/admin/rewards")}>
                <Icon name="edit" />
              </button>
            </div>
            <dl className="disc-rows">
              <dt>適用群組</dt>
              <dd>{r.groups?.length ? r.groups.join("、") : "所有會員"}</dd>
              <dt>折扣方式</dt>
              <dd>
                消費 ${(r.minSpend ?? 1).toLocaleString()} ～ ${r.maxSpend ? r.maxSpend.toLocaleString() : "不限"} 每 ${r.every} 元贈送購物金 ${r.points}
              </dd>
              <dt>使用期限</dt>
              <dd>{r.expiryDays ? `寄送後 ${r.expiryDays} 天` : "永久"}</dd>
            </dl>
            <StackBox text="未與任何折扣搭配">門市結帳完成後自動送到顧客的 meepShop 帳戶，網店也能用。</StackBox>
          </div>
        ))}
        {gifts.map((g, i) => (
          <div key={`g${i}`} className={`disc-card open ${g.active ? "" : "off"}`}>
            <div className="disc-head">
              {isOwner ? (
                <button className={`tier-switch ${g.active ? "on" : ""}`} onClick={() => saveGifts(gifts.map((x, j) => (j === i ? { ...x, active: !x.active } : x)), g.active ? "已停用" : "已啟用")} />
              ) : (
                <span className={`tier-switch ${g.active ? "on" : ""}`} />
              )}
              <span className="muted">{g.kind === "birthday" ? "會員生日" : "會員加入"}</span>
              <strong>{g.name}</strong>
              <Badge tone="info">meepShop 寄送</Badge>
              <span className="grow" />
              {isOwner && (
                <>
                  <button className="btn-icon" title="編輯" onClick={() => setGiftEdit({ index: i, gift: g })}>
                    <Icon name="edit" />
                  </button>
                  <button className="btn-icon danger" title="刪除" onClick={() => confirm(`刪除「${g.name}」？`) && saveGifts(gifts.filter((_, j) => j !== i), "已刪除")}>
                    <Icon name="trash" />
                  </button>
                </>
              )}
            </div>
            <dl className="disc-rows">
              <dt>適用群組</dt>
              <dd>{g.groups?.length ? g.groups.join("、") : <span className="muted">未加入群組的顧客</span>}</dd>
              <dt>寄送時間</dt>
              <dd>{g.kind === "birthday" ? `會員生日日期前 ${g.daysBefore ?? 0} 天` : "會員加入"}</dd>
              <dt>折扣方式</dt>
              <dd>贈送購物金 ${g.points} 元</dd>
              <dt>使用期限</dt>
              <dd>{g.expiryDays ? `寄送後 ${g.expiryDays} 天` : "永久"}</dd>
            </dl>
            <StackBox text="未與任何折扣搭配">這個活動由 meepShop 自動寄送購物金（網店、門市都能用）。本系統只記錄設定、不會重複寄送；要修改金額請同時到 meepShop 後台改。</StackBox>
          </div>
        ))}
      </section>

      {choosing && (
        <TypeChooser
          onClose={() => setChoosing(false)}
          onPick={(k) => {
            setChoosing(false);
            if (k === "points") return nav("/admin/rewards");
            setEdit({ promo: null, kind: k });
          }}
        />
      )}
      {edit && <PromoEditor promo={edit.promo} kind={edit.kind} onClose={() => setEdit(null)} />}
      {couponFor && <CouponManager promo={couponFor} onClose={() => setCouponFor(null)} />}
      {giftEdit && (
        <PointGiftEditor
          gift={giftEdit.gift}
          groups={settings.memberGroups ?? []}
          onClose={() => setGiftEdit(null)}
          onSave={(g) => {
            const next = giftEdit.index === null ? [...gifts, g] : gifts.map((x, j) => (j === giftEdit.index ? g : x));
            saveGifts(next, "已儲存");
            setGiftEdit(null);
          }}
        />
      )}
      {viewing && (
        <Modal title={`${viewing.title}：已選商品`} onClose={() => setViewing(null)}>
          <ul className="pick-list">
            {[...new Map(variants.filter((v) => viewing.scope.kind === "products" && viewing.scope.productIds.includes(v.productId)).map((v) => [v.productId, v])).values()].map((v) => (
              <li key={v.productId} className="row-inline">
                {v.imageUrl && <img src={v.thumbUrl || v.imageUrl} alt="" className="thumb-sm" loading="lazy" />}
                {v.productTitle}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

/** 新增折扣：先選類型（同 meepShop） */
function TypeChooser({ onClose, onPick }: { onClose: () => void; onPick: (k: Kind) => void }) {
  return (
    <Modal title="新增折扣" onClose={onClose} wide>
      {(["product", "order"] as const).map((sec) => (
        <div key={sec}>
          <div className="chooser-title">{sec === "product" ? "商品" : "訂單"}</div>
          <div className={`chooser-grid ${sec}`}>
            {KINDS.filter((d) => d.section === sec).map((d) => (
              <button key={d.kind} className="chooser-card" disabled={!!d.disabled} title={d.disabled} onClick={() => onPick(d.kind)}>
                <span className="chooser-icon">
                  <Icon name={d.icon} size={26} />
                </span>
                <strong>{d.title}</strong>
                <small>{d.disabled ? "門市不適用" : d.desc}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

/** 會員生日／會員加入購物金（記錄 meepShop 的設定） */
function PointGiftEditor({ gift, groups, onClose, onSave }: { gift: PointGift; groups: string[]; onClose: () => void; onSave: (g: PointGift) => void }) {
  const [g, setG] = useState<PointGift>(gift);
  const set = (patch: Partial<PointGift>) => setG((x) => ({ ...x, ...patch }));
  return (
    <Modal
      title={gift.name ? `編輯「${gift.name}」` : "新增購物金活動"}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={() => (g.name.trim() && g.points > 0 ? onSave({ ...g, name: g.name.trim() }) : alert("請填名稱和購物金金額"))}>
          儲存
        </button>
      }
    >
      <div className="segmented">
        <button type="button" className={g.kind === "birthday" ? "active" : ""} onClick={() => set({ kind: "birthday" })}>
          會員生日
        </button>
        <button type="button" className={g.kind === "join" ? "active" : ""} onClick={() => set({ kind: "join" })}>
          會員加入
        </button>
      </div>
      <Field label="活動名稱">
        <input value={g.name} onChange={(e) => set({ name: e.target.value })} placeholder={g.kind === "birthday" ? "例：生日快樂" : "例：入會禮"} />
      </Field>
      <Field label="適用群組（都不選 = 未加入群組的顧客）">
        <div className="chips">
          {groups.map((x) => {
            const on = (g.groups ?? []).includes(x);
            return (
              <button key={x} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => set({ groups: on ? (g.groups ?? []).filter((y) => y !== x) : [...(g.groups ?? []), x] })}>
                {x}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="grid-fields">
        {g.kind === "birthday" && (
          <Field label="生日前幾天寄送">
            <input type="number" min={0} value={g.daysBefore ?? 0} onChange={(e) => set({ daysBefore: Number(e.target.value) })} />
          </Field>
        )}
        <Field label="贈送購物金（元）">
          <input type="number" min={1} value={g.points || ""} onChange={(e) => set({ points: Number(e.target.value) })} />
        </Field>
        <Field label="寄送後幾天到期（0 = 永久）">
          <input type="number" min={0} value={g.expiryDays ?? 0} onChange={(e) => set({ expiryDays: Number(e.target.value) })} />
        </Field>
      </div>
      <p className="muted small">由 meepShop 自動寄送；這裡記錄設定方便對照，改了這裡請同時到 meepShop 後台改。</p>
    </Modal>
  );
}

/* ---------------- 編輯頁（同 meepShop 兩欄版面） ---------------- */

function PromoEditor({ promo, kind, onClose }: { promo: PromoDoc | null; kind: Kind; onClose: () => void }) {
  const { profile } = useAuth();
  const { settings, variants } = useData();
  const def = kindDef(kind);
  const [p, setP] = useState<Omit<PromoDoc, "id">>(() => {
    const base = promo ?? { name: "", active: true, type: "percent_off", scope: { kind: "all" }, startDate: todayStr(), endDate: "", memberRule: "none", ...(def.preset ?? {}) };
    // 舊的單一門檻 → 條件列
    if ((base.type === "threshold" || base.type === "gift") && !base.levels?.length)
      return { ...base, levels: [{ threshold: base.threshold ?? 0, value: base.type === "gift" ? 1 : base.thresholdReward === "percent" ? base.percentOff ?? 0 : base.amountOff ?? 0 }] };
    return base as Omit<PromoDoc, "id">;
  });
  const [forever, setForever] = useState(!!promo && !promo.startDate && !promo.endDate);
  const [picking, setPicking] = useState<"scope" | "addonScope" | "excludeScope" | null>(null);
  const { busy, run } = useAction();
  const set = (patch: Partial<Promotion>) => setP((x) => ({ ...x, ...patch }));
  const tiers = (settings.memberTiers ?? []).map((t) => t.name);
  const groups = settings.memberGroups ?? [];
  const isLevels = p.type === "threshold" || p.type === "gift";
  const levels = p.levels ?? [];
  const setLevel = (i: number, patch: Partial<PromoLevel>) => set({ levels: levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () =>
    run(async () => {
      if (!p.name.trim()) throw new Error("請填活動名稱");
      if (!forever && p.endDate && p.startDate && p.endDate < p.startDate) throw new Error("結束日早於開始日");
      if (p.memberRule === "groups" && !(p.memberGroups ?? []).length) throw new Error("請選擇適用的顧客群組");
      const data: Record<string, unknown> = {
        name: p.name.trim(),
        active: p.active,
        type: p.type,
        startDate: forever ? null : p.startDate || null,
        endDate: forever ? null : p.endDate || null,
        scope: p.orderLevel ? { kind: "all" } : p.scope,
        excludeScope: p.excludeScope && p.excludeScope.kind !== "all" ? p.excludeScope : null,
        memberRule: p.memberRule ?? "none",
        memberTiers: p.memberRule === "tiers" ? p.memberTiers ?? [] : [],
        memberGroups: p.memberRule === "groups" ? p.memberGroups ?? [] : [],
        days: p.days?.length && p.days.length < 7 ? p.days : [],
        timeFrom: p.timeFrom || null,
        timeTo: p.timeTo || null,
        minSpend: isLevels ? 0 : Number(p.minSpend) || 0,
        maxUses: Number(p.maxUses) || 0,
        noMemberStack: !!p.noMemberStack,
        couponOnly: !!p.couponOnly,
        orderLevel: !!p.orderLevel,
        note: p.note ?? null,
        updatedBy: profile?.name ?? "",
        updatedAt: serverTimestamp(),
      };
      if (p.scope.kind === "products" && !p.orderLevel && !p.scope.productIds.length) throw new Error("請選擇適用商品，或改成「全部商品」");
      if (p.type === "percent_off" || p.type === "nth_discount") {
        if (!(Number(p.percentOff) > 0 && Number(p.percentOff) < 100)) throw new Error("請輸入幾折（例：85 或 8.5）");
        data.percentOff = Number(p.percentOff);
      }
      if (p.type === "amount_off") {
        if (!(Number(p.amountOff) > 0)) throw new Error("請輸入折抵金額");
        data.amountOff = Number(p.amountOff);
      }
      if (p.type === "nth_discount") data.n = Math.max(2, Number(p.n) || 2);
      if (p.type === "bundle_price") {
        if (!(Number(p.n) >= 1 && Number(p.bundlePrice) >= 0)) throw new Error("請輸入件數和價格");
        data.n = Number(p.n);
        data.bundlePrice = Number(p.bundlePrice);
      }
      if (p.type === "addon") {
        data.addonScope = p.addonScope ?? { kind: "all" };
        data.addonPrice = Number(p.addonPrice) || 0;
      }
      if (isLevels) {
        const clean = levels.map((l) => ({ threshold: Number(l.threshold) || 0, value: Number(l.value) || 0 })).filter((l) => l.threshold > 0 && l.value > 0);
        if (!clean.length) throw new Error("請輸入條件：消費滿多少、優惠多少");
        if (p.type === "threshold" && p.thresholdReward === "percent" && clean.some((l) => l.value >= 100)) throw new Error("折數輸入錯誤");
        clean.sort((a, b) => a.threshold - b.threshold);
        Object.assign(data, { levels: clean, thresholdType: p.thresholdType ?? "amount", threshold: clean[0].threshold, repeat: false });
        if (p.type === "threshold") data.thresholdReward = p.thresholdReward ?? "amount";
        if (p.type === "gift") {
          const g = p.addonScope;
          if (!g || g.kind === "all" || (g.kind === "products" && !g.productIds.length)) throw new Error("請選擇贈品");
          data.addonScope = g;
          data.addonPrice = 0;
        }
      }
      if (promo) await setDoc(doc(db, "promotions", promo.id), data, { merge: true }); // merge keeps createdAt
      else await addDoc(collection(db, "promotions"), { ...data, createdAt: serverTimestamp() });
      onClose();
    }, "已儲存");

  const scopeEditor = (key: "scope" | "addonScope" | "excludeScope", allowAll = true) => {
    const s = (p[key] ?? { kind: "all" }) as PromoScope;
    const choices = [...(allowAll ? [["all", key === "excludeScope" ? "不排除" : "全部商品"]] : []), ["products", "指定商品"], ["categories", "依分類"]] as [PromoScope["kind"], string][];
    return (
      <>
        <div className="radio-row">
          {choices.map(([k, l]) => (
            <label key={k}>
              <input
                type="radio"
                checked={s.kind === k}
                onChange={() => set({ [key]: k === "all" ? { kind: "all" } : k === "categories" ? { kind: "categories", categories: [] } : { kind: "products", productIds: s.kind === "products" ? s.productIds : [] } } as Partial<Promotion>)}
              />{" "}
              {l}
            </label>
          ))}
        </div>
        {s.kind === "categories" && <CategoryPicker value={s.categories} onChange={(categories) => set({ [key]: { kind: "categories", categories } } as Partial<Promotion>)} />}
        {s.kind === "products" && (
          <button type="button" className="btn btn-block pick-btn" onClick={() => setPicking(key)}>
            <Icon name="bag" size={18} /> {s.productIds.length ? `已選擇 ${new Set(variants.filter((v) => s.productIds.includes(v.productId)).map((v) => v.productId)).size} 項商品，點這裡修改` : "選擇商品"}
          </button>
        )}
      </>
    );
  };

  const zheInput = (value: number | undefined, onChange: (pct: number) => void) => (
    <input type="number" min={1} max={99} step="any" value={value ? pctToZhe(value) : ""} onChange={(e) => onChange(zheToPct(Number(e.target.value)))} placeholder="例：85" />
  );

  // 試算：適用範圍內最貴的 3 件（各 1 件）＋贈品／加購品
  const sample = useMemo(() => {
    const live = { ...(p as Promotion), id: "preview", active: true, couponOnly: false, startDate: null, endDate: null, days: [], timeFrom: null, timeTo: null, memberRule: "none" as const, scope: p.orderLevel ? ({ kind: "all" } as PromoScope) : p.scope };
    const info = (v: (typeof variants)[number]) => ({ productId: v.productId, category: v.posCategory, tags: v.tags ?? [] });
    const pool = variants.filter((v) => (v.price ?? 0) > 0 && inScope(live.scope, info(v)) && !(live.excludeScope && live.excludeScope.kind !== "all" && inScope(live.excludeScope, info(v))));
    const seen = new Set<string>();
    const want = live.type === "bundle_price" ? Math.max(1, live.n ?? 1) : live.type === "nth_discount" ? Math.max(2, live.n ?? 2) : 3;
    const picks = [...pool].sort((a, b) => b.price - a.price).filter((v) => !seen.has(v.productId) && seen.add(v.productId)).slice(0, want);
    if (live.type === "addon" || live.type === "gift") {
      const add = variants.find((v) => (v.price ?? 0) > 0 && inScope(live.addonScope, info(v)) && !picks.some((x) => x.id === v.id));
      if (add) picks.push(add);
    }
    const lines = picks.map((v, i) => ({ key: String(i), variantId: v.id, qty: 1, unitPrice: v.price, discountPct: 0 }));
    const r = applyPromotions(lines, (vid) => {
      const v = variants.find((x) => x.id === vid);
      return v ? info(v) : undefined;
    }, [live], { ...taipeiClock(), isMember: true, tier: null, group: null });
    return { picks, r };
  }, [p, variants]);

  const productMode = p.type === "amount_off" ? "amount" : p.type === "nth_discount" ? "nth" : "percent";
  const unitSel = (
    <select value={p.thresholdType ?? "amount"} onChange={(e) => set({ thresholdType: e.target.value as "amount" | "qty" })}>
      <option value="amount">元</option>
      <option value="qty">件</option>
    </select>
  );

  return (
    <div className="disc-editor" role="dialog" aria-label={def.editorTitle}>
      <header className="disc-editor-bar">
        <button className="btn-icon" onClick={onClose} aria-label="返回">
          <Icon name="back" />
        </button>
        <h1>{def.editorTitle}</h1>
        <span className="grow" />
        <button className="btn" onClick={onClose}>
          捨棄
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          儲存
        </button>
      </header>
      <div className="disc-editor-grid">
        <div className="disc-col">
          <div className="disc-panel">
            <h3>基本資訊</h3>
            <div className="ed-label req">折扣狀態</div>
            <div className="seg2">
              <button type="button" className={!p.active ? "active" : ""} onClick={() => set({ active: false })}>
                關閉
              </button>
              <button type="button" className={p.active ? "active" : ""} onClick={() => set({ active: true })}>
                啟用
              </button>
            </div>

            <div className="ed-label req">活動期間</div>
            <div className="radio-row">
              <label>
                <input type="radio" checked={!forever} onChange={() => setForever(false)} /> 自訂期間
              </label>
              <label>
                <input type="radio" checked={forever} onChange={() => setForever(true)} /> 永久開放
              </label>
            </div>
            {!forever && (
              <div className="date-range">
                <input type="date" value={p.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value })} />
                <span>→</span>
                <input type="date" value={p.endDate ?? ""} onChange={(e) => set({ endDate: e.target.value })} />
              </div>
            )}

            <div className="ed-label req">適用顧客群組</div>
            <div className="radio-row">
              <label>
                <input type="radio" checked={(p.memberRule ?? "none") === "none"} onChange={() => set({ memberRule: "none" })} /> 所有顧客
              </label>
              <label>
                <input type="radio" checked={p.memberRule === "members"} onChange={() => set({ memberRule: "members" })} /> 所有會員
              </label>
              {groups.length > 0 && (
                <label>
                  <input type="radio" checked={p.memberRule === "groups"} onChange={() => set({ memberRule: "groups" })} /> 指定群組
                </label>
              )}
              {tiers.length > 0 && (
                <label>
                  <input type="radio" checked={p.memberRule === "tiers"} onChange={() => set({ memberRule: "tiers" })} /> 本系統等級
                </label>
              )}
            </div>
            {(p.memberRule === "groups" || p.memberRule === "tiers") && (
              <div className="chips">
                {(p.memberRule === "groups" ? groups : tiers).map((g) => {
                  const key = p.memberRule === "groups" ? "memberGroups" : "memberTiers";
                  const cur = (p[key] ?? []) as string[];
                  const on = cur.includes(g);
                  return (
                    <button key={g} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => set({ [key]: on ? cur.filter((x) => x !== g) : [...cur, g] } as Partial<Promotion>)}>
                      {g}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="ed-label">限定星期（都不選 = 每天）</div>
            <div className="chips">
              {WEEK_ZH.map((w, i) => {
                const on = (p.days ?? []).includes(i);
                return (
                  <button key={i} type="button" className={`chip ${on ? "active" : ""}`} onClick={() => set({ days: on ? (p.days ?? []).filter((x) => x !== i) : [...(p.days ?? []), i].sort() })}>
                    週{w}
                  </button>
                );
              })}
            </div>
            <div className="ed-label">限定時段（留空 = 全天）</div>
            <div className="date-range">
              <input type="time" value={p.timeFrom ?? ""} onChange={(e) => set({ timeFrom: e.target.value })} />
              <span>→</span>
              <input type="time" value={p.timeTo ?? ""} onChange={(e) => set({ timeTo: e.target.value })} />
            </div>
          </div>
        </div>

        <div className="disc-col">
          <div className="disc-panel">
            <h3>活動名稱</h3>
            <input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="請輸入活動名稱（會印在收據上）" />
          </div>

          {!p.orderLevel && (
            <div className="disc-panel">
              <h3>{p.type === "addon" ? "主商品（買了才能加購）" : "適用商品"}</h3>
              {scopeEditor("scope")}
            </div>
          )}
          {p.type === "addon" && (
            <div className="disc-panel">
              <h3>加購商品</h3>
              {scopeEditor("addonScope")}
            </div>
          )}
          {p.type === "gift" && (
            <div className="disc-panel">
              <h3>贈品</h3>
              {scopeEditor("addonScope", false)}
              <p className="muted small">結帳時把贈品掃進購物車，達到條件就自動變 $0。</p>
            </div>
          )}

          <div className="disc-panel">
            <h3>折扣設定</h3>
            {(kind === "product_discount" || kind === "product_coupon") && (
              <>
                <div className="radio-row">
                  <label>
                    <input type="radio" checked={productMode === "percent"} onChange={() => set({ type: "percent_off", percentOff: p.percentOff || 15 })} /> 打折
                  </label>
                  <label>
                    <input type="radio" checked={productMode === "amount"} onChange={() => set({ type: "amount_off", amountOff: p.amountOff || 100 })} /> 每件折抵
                  </label>
                  <label>
                    <input type="radio" checked={productMode === "nth"} onChange={() => set({ type: "nth_discount", n: p.n || 2, percentOff: p.percentOff || 40 })} /> 第 N 件折扣
                  </label>
                </div>
                <div className="cond-line">
                  {productMode === "nth" && (
                    <div className="addon-input">
                      <span>第</span>
                      <input type="number" min={2} value={p.n ?? ""} onChange={(e) => set({ n: Number(e.target.value) })} />
                      <span>件</span>
                    </div>
                  )}
                  <div className="addon-input">
                    <span>優惠</span>
                    {productMode === "amount" ? (
                      <input type="number" min={1} value={p.amountOff ?? ""} onChange={(e) => set({ amountOff: Number(e.target.value) })} placeholder="請輸入純數字" />
                    ) : (
                      zheInput(p.percentOff, (percentOff) => set({ percentOff }))
                    )}
                    <span>{productMode === "amount" ? "元" : "折"}</span>
                  </div>
                </div>
                <div className="cond-line">
                  <div className="addon-input">
                    <span>適用商品滿</span>
                    <input type="number" min={0} value={p.minSpend || ""} onChange={(e) => set({ minSpend: Number(e.target.value) })} placeholder="不限" />
                    <span>元才享</span>
                  </div>
                  <div className="addon-input">
                    <span>每單最多</span>
                    <input type="number" min={0} value={p.maxUses || ""} onChange={(e) => set({ maxUses: Number(e.target.value) })} placeholder="不限" />
                    <span>{productMode === "nth" ? "組" : "件"}</span>
                  </div>
                </div>
              </>
            )}
            {p.type === "bundle_price" && (
              <div className="cond-line">
                <div className="addon-input">
                  <span>任選</span>
                  <input type="number" min={1} value={p.n ?? ""} onChange={(e) => set({ n: Number(e.target.value) })} />
                  <span>件</span>
                </div>
                <div className="addon-input">
                  <span>特價</span>
                  <input type="number" min={0} value={p.bundlePrice ?? ""} onChange={(e) => set({ bundlePrice: Number(e.target.value) })} />
                  <span>元</span>
                </div>
                <div className="addon-input">
                  <span>每單最多</span>
                  <input type="number" min={0} value={p.maxUses || ""} onChange={(e) => set({ maxUses: Number(e.target.value) })} placeholder="不限" />
                  <span>組</span>
                </div>
              </div>
            )}
            {p.type === "addon" && (
              <div className="cond-line">
                <div className="addon-input">
                  <span>加購價</span>
                  <input type="number" min={0} value={p.addonPrice ?? ""} onChange={(e) => set({ addonPrice: Number(e.target.value) })} />
                  <span>元</span>
                </div>
                <div className="addon-input">
                  <span>每單最多</span>
                  <input type="number" min={0} value={p.maxUses || ""} onChange={(e) => set({ maxUses: Number(e.target.value) })} placeholder="不限" />
                  <span>件</span>
                </div>
              </div>
            )}
            {isLevels && (
              <>
                {levels.map((l, i) => (
                  <div key={i} className="cond-line">
                    <div className="addon-input">
                      <span>{p.thresholdType === "qty" ? "購買滿" : "消費滿"}</span>
                      <input type="number" min={1} value={l.threshold || ""} onChange={(e) => setLevel(i, { threshold: Number(e.target.value) })} placeholder="請輸入純數字" />
                      {unitSel}
                    </div>
                    <div className="addon-input">
                      <span>{p.type === "gift" ? "贈送" : "優惠"}</span>
                      {p.type === "gift" ? (
                        <input type="number" min={1} value={l.value || ""} onChange={(e) => setLevel(i, { value: Number(e.target.value) })} />
                      ) : p.thresholdReward === "percent" ? (
                        zheInput(l.value, (value) => setLevel(i, { value }))
                      ) : (
                        <input type="number" min={1} value={l.value || ""} onChange={(e) => setLevel(i, { value: Number(e.target.value) })} placeholder="請輸入純數字" />
                      )}
                      {p.type === "gift" ? (
                        <span>件</span>
                      ) : (
                        <select value={p.thresholdReward ?? "amount"} onChange={(e) => set({ thresholdReward: e.target.value as "amount" | "percent", levels: levels.map((x) => ({ ...x, value: 0 })) })}>
                          <option value="amount">元</option>
                          <option value="percent">折</option>
                        </select>
                      )}
                    </div>
                    {levels.length > 1 && (
                      <button type="button" className="btn-icon danger" title="刪除條件" onClick={() => set({ levels: levels.filter((_, j) => j !== i) })}>
                        <Icon name="trash" size={18} />
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" className="link-btn add-cond" onClick={() => set({ levels: [...levels, { threshold: 0, value: 0 }] })}>
                  ⊕ 新增條件
                </button>
                <p className="muted small">有多個條件時，達到的最高一層生效（例：滿 $2000 折 $200、滿 $3000 折 $400）。</p>
              </>
            )}
          </div>

          {!p.orderLevel && p.type !== "gift" && (
            <div className="disc-panel">
              <h3>排除商品</h3>
              {scopeEditor("excludeScope")}
            </div>
          )}

          <div className="disc-panel">
            <h3>折扣搭配</h3>
            <div className="info-box">ⓘ {STACK_HELP}</div>
            <label className="check">
              <input type="checkbox" checked={!p.noMemberStack} onChange={(e) => set({ noMemberStack: !e.target.checked })} /> 可以和會員等級折扣併用
            </label>
            <label className="check">
              <input type="checkbox" checked={!!p.couponOnly} onChange={(e) => set({ couponOnly: e.target.checked })} /> 需要優惠碼才能使用（儲存後在卡片上按優惠碼圖示產生）
            </label>
          </div>

          <div className="disc-panel">
            <h3>試算</h3>
            <div className="small">
              <strong>{p.name || def.editorTitle}：</strong>
              {discountText(p as Promotion)}
            </div>
            {sample.picks.length > 0 ? (
              <div className="small">
                {sample.picks.map((v) => `${variantName(v)} ${money(v.price)}`).join(" ＋ ")}
                <br />→ 合計 {money(sample.picks.reduce((s2, v) => s2 + v.price, 0))}，折 <strong>{money(sample.r.total)}</strong>
                {sample.r.total === 0 && "（這個組合還沒達到條件）"}
              </div>
            ) : (
              <div className="small muted">適用範圍內沒有商品可以試算</div>
            )}
          </div>
        </div>
      </div>

      {picking && (
        <ProductPicker
          value={(p[picking] as PromoScope | undefined)?.kind === "products" ? (p[picking] as { productIds: string[] }).productIds : []}
          onClose={() => setPicking(null)}
          onChange={(productIds) => set({ [picking]: { kind: "products", productIds } } as Partial<Promotion>)}
        />
      )}
    </div>
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
      const r = map.get(v.productId) ?? { productId: v.productId, title: v.productTitle, imageUrl: v.thumbUrl || v.imageUrl, price: v.price, stock: 0, sales30: 0, lastSoldDays: null, hasStats: false };
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
                    {r.imageUrl && <img src={r.imageUrl} alt="" className="thumb-sm" loading="lazy" />}
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
