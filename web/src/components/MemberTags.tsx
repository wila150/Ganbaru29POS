import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { call, db } from "../firebase";
import { atLeast } from "../lib/util";
import { useData } from "../data";
import { Modal, useAction } from "./ui";

/** 全店用過的會員標籤（meta/memberTags） */
export function useMemberTags(): string[] {
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => onSnapshot(doc(db, "meta", "memberTags"), (d) => setTags(((d.data()?.tags as string[]) ?? []).slice().sort((a, b) => a.localeCompare(b, "zh-Hant")))), []);
  return tags;
}

/** 這位會員目前的標籤（即時） */
export function useShopperTags(shopperId: string | null | undefined): string[] {
  return useShopperPrefs(shopperId).tags;
}

/** 標籤＋喜好備註（即時） */
export function useShopperPrefs(shopperId: string | null | undefined): { tags: string[]; pref: string; likes: string[] } {
  const [v, setV] = useState<{ tags: string[]; pref: string; likes: string[] }>({ tags: [], pref: "", likes: [] });
  useEffect(() => {
    if (!shopperId) return setV({ tags: [], pref: "", likes: [] });
    // likes = 客人自己在 LINE「我的喜好」勾選的
    return onSnapshot(doc(db, "shoppers", shopperId), (d) => setV({ tags: (d.data()?.tags as string[]) ?? [], pref: (d.data()?.prefNote as string) ?? "", likes: (d.data()?.likes as string[]) ?? [] }));
  }, [shopperId]);
  return v;
}

export function TagChips({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="tag-chips">
      {tags.map((t) => (
        <span key={t} className="member-tag">
          {t}
        </span>
      ))}
    </span>
  );
}

/** 編輯會員標籤（同 BV SHOP：勾選既有標籤、新增標籤） */
export function MemberTagEditor({ shopperId, name, onClose }: { shopperId: string; name: string; onClose: () => void }) {
  const all = useMemberTags();
  const prefs = useShopperPrefs(shopperId);
  const current = prefs.tags;
  const [sel, setSel] = useState<string[] | null>(null);
  const [pref, setPref] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const { profile } = useAuth();
  const { busy, run } = useAction();
  const chosen = sel ?? current;
  const list = [...new Set([...all, ...chosen])];
  const toggle = (t: string) => setSel(chosen.includes(t) ? chosen.filter((x) => x !== t) : [...chosen, t]);
  const add = () => {
    const t = adding.trim().slice(0, 12);
    if (!t) return;
    if (!chosen.includes(t)) setSel([...chosen, t]);
    setAdding("");
  };
  return (
    <Modal
      title={`會員標籤與喜好：${name}`}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" disabled={busy} onClick={() => run(() => call("setShopperTags", { id: shopperId, tags: chosen, prefNote: pref ?? prefs.pref }), "已儲存").then(onClose)}>
          儲存
        </button>
      }
    >
      <div className="tag-pick">
        {list.length === 0 && <p className="muted">還沒有標籤，在下面新增</p>}
        {list.map((t) => (
          <label key={t} className={`check tag-opt ${chosen.includes(t) ? "on" : ""}`}>
            <input type="checkbox" checked={chosen.includes(t)} onChange={() => toggle(t)} /> {t}
            {atLeast(profile?.role, "manager") && all.includes(t) && !chosen.includes(t) && (
              <button type="button" className="btn-icon" title="從標籤清單移除（不影響已貼標籤的會員）" onClick={(e) => (e.preventDefault(), confirm(`從清單移除「${t}」？`) && run(() => call("removeMemberTag", { tag: t })))}>
                ✕
              </button>
            )}
          </label>
        ))}
      </div>
      <div className="inline-form">
        <input placeholder="新增標籤，例：只買黑色" value={adding} maxLength={12} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button type="button" className="btn" disabled={!adding.trim()} onClick={add}>
          ＋ 新增
        </button>
      </div>
      <h3>喜好備註</h3>
      <textarea rows={3} maxLength={300} placeholder="例：穿 L、喜歡寬褲和落肩、只買黑灰色、不喜歡亮色；生日 8 月想送禮給男友" value={pref ?? prefs.pref} onChange={(e) => setPref(e.target.value)} />
      <p className="muted small">標籤、喜好存在本系統（meepShop 沒有這個功能）；結帳帶入會員時會顯示，顧客名單可以用標籤篩選。</p>
    </Modal>
  );
}

/**
 * 群組：meepShop 的群組（官網用，不能從這裡改）＋門市指定群組（店長以上可改，只影響門市結帳的折扣與購物金回饋）
 */
export function ShopperGroup({ shopperId }: { shopperId: string }) {
  const { settings } = useData();
  const { profile } = useAuth();
  const { busy, run } = useAction();
  const [g, setG] = useState<{ meep: string | null; pos: string | null }>({ meep: null, pos: null });
  useEffect(() => onSnapshot(doc(db, "shoppers", shopperId), (d) => setG({ meep: (d.data()?.memberGroup as string) ?? null, pos: (d.data()?.posGroup as string) ?? null })), [shopperId]);
  const groups = (settings.memberGroups ?? []) as string[];
  const canEdit = atLeast(profile?.role, "manager");
  const shown = g.pos ?? g.meep;
  return (
    <span className="member-group-ctl">
      <span className="member-group" title="官網（meepShop）的群組只能在 meepShop 後台改">{shown ?? "未加入群組"}</span>
      {g.pos && <span className="muted small">（門市指定；官網是「{g.meep ?? "未加入群組"}」）</span>}
      {canEdit && (
        <select
          className="small"
          value={g.pos ?? ""}
          disabled={busy}
          title="門市指定群組：只影響門市結帳的折扣與購物金回饋"
          onChange={(e) => run(() => call("setShopperGroup", { id: shopperId, group: e.target.value || null }), e.target.value ? `門市改為「${e.target.value}」` : "已改回官網群組")}
        >
          <option value="">門市指定：照官網</option>
          {groups.map((x) => (
            <option key={x} value={x}>
              門市指定：{x}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}
