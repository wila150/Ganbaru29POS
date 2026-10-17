import { collection, onSnapshot, query, where } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { QrImg } from "../../components/QrImg";
import { Badge, Empty, Field, Modal, useAction } from "../../components/ui";
import { useData, variantName } from "../../data";
import { call, db, storage } from "../../firebase";
import { searchVariants } from "../../lib/lookup";
import { fmtTime, money } from "../../lib/util";
import type { Variant } from "../../types";

interface Group {
  productId: string;
  title: string;
  imageUrl: string | null;
  status: string;
  variants: Variant[];
}

export function Products() {
  const { variants, settings } = useData();
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState<"" | "image" | "code" | "location">("");
  const [missingImg, setMissingImg] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<Variant | null>(null);
  const [imgFor, setImgFor] = useState<Group | null>(null);
  const [bulk, setBulk] = useState(false);
  const { busy, run } = useAction();
  const nav = useNavigate();

  useEffect(() => onSnapshot(query(collection(db, "productImages"), where("status", "in", ["missing", "pending"])), (s) => setMissingImg(new Set(s.docs.map((d) => d.id)))), []);

  const groups = useMemo(() => {
    let list = searchVariants(variants, q);
    if (onlyMissing === "image") list = list.filter((v) => !v.imageUrl || missingImg.has(v.productId));
    if (onlyMissing === "code") list = list.filter((v) => !v.barcode && !(v.extraCodes ?? []).length);
    if (onlyMissing === "location") list = list.filter((v) => !v.location);
    const map = new Map<string, Group>();
    for (const v of list) {
      const g = map.get(v.productId) ?? { productId: v.productId, title: v.productTitle, imageUrl: v.imageUrl, status: v.productStatus, variants: [] };
      g.variants.push(v);
      map.set(v.productId, g);
    }
    const out = [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));
    out.forEach((g) => g.variants.sort((a, b) => a.variantIndex - b.variantIndex));
    return out;
  }, [variants, q, onlyMissing, missingImg]);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>商品與條碼</h1>
          <div className="muted small">
            商品從 meepShop 同步而來（新增商品請到 meepShop 後台）。上次完整同步：{fmtTime(settings.lastCatalogSyncAt)}
          </div>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await call<{ count: number; errors: string[]; images: number }>("syncCatalog");
              if (r.errors.length) throw new Error(r.errors.join("; "));
              return r;
            }, "同步完成")
          }
        >
          {busy ? "同步中（可能要幾分鐘）…" : "立即同步 meepShop 商品"}
        </button>
      </div>

      <input className="search" placeholder="搜尋名稱、編號、條碼、儲位" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        {(
          [
            ["", "全部"],
            ["image", `缺圖片 ${missingImg.size || ""}`],
            ["code", "沒有條碼"],
            ["location", "沒有儲位"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`chip ${onlyMissing === k ? "active" : ""}`} onClick={() => setOnlyMissing(k)}>
            {l}
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="sticky-bar">
          已選 {selected.size} 款
          <button className="btn btn-sm" onClick={() => setBulk(true)}>
            批次設定
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => nav("/admin/labels", { state: { ids: [...selected] } })}>
            列印 QR 標籤
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
            清除
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <Empty>沒有符合的商品</Empty>
      ) : (
        <div className="product-groups">
          {groups.slice(0, 200).map((g) => {
            const ids = g.variants.map((v) => v.id);
            const all = ids.every((id) => selected.has(id));
            return (
              <div key={g.productId} className="card product-group">
                <div className="product-head">
                  <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} aria-label="全選此商品" />
                  <button className="thumb" onClick={() => setImgFor(g)} title="更換圖片">
                    {g.imageUrl ? <img src={g.imageUrl} alt="" /> : <span>無圖</span>}
                  </button>
                  <div className="grow">
                    <strong>{g.title}</strong> {g.status !== "LISTED" && <Badge>未上架</Badge>} {missingImg.has(g.productId) && <Badge tone="warn">缺圖片</Badge>}
                  </div>
                </div>
                <table className="table table-compact table-click">
                  <tbody>
                    {g.variants.map((v) => (
                      <tr key={v.id} onClick={() => setEdit(v)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(v.id)} onChange={(e) => toggle([v.id], e.target.checked)} />
                        </td>
                        <td>{v.options || "單一規格"}</td>
                        <td className="muted">{v.sku || "—"}</td>
                        <td>{[v.barcode, ...(v.extraCodes ?? [])].filter(Boolean).length ? [v.barcode, ...(v.extraCodes ?? [])].filter(Boolean).join("、") : <Badge tone="warn">無條碼</Badge>}</td>
                        <td>{v.location || <span className="muted">無儲位</span>}</td>
                        <td className="num">安全 {v.safety || 0}</td>
                        <td className="num">{money(v.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {groups.length > 200 && <p className="muted center">只顯示前 200 個商品，請用搜尋縮小範圍</p>}
        </div>
      )}

      {edit && <EditVariant variant={edit} onClose={() => setEdit(null)} />}
      {imgFor && <ImageDialog group={imgFor} onClose={() => setImgFor(null)} />}
      {bulk && <BulkEdit ids={[...selected]} onClose={() => setBulk(false)} />}
    </div>
  );
}

function EditVariant({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const { byId, variants } = useData();
  const v = byId.get(variant.id) ?? variant;
  const [location, setLocation] = useState(v.location ?? "");
  const [safety, setSafety] = useState(String(v.safety ?? 0));
  const [posCategory, setPosCategory] = useState(v.posCategory ?? "");
  const [posSort, setPosSort] = useState(String(v.posSort ?? 0));
  const [posHidden, setPosHidden] = useState(!!v.posHidden);
  const [newCode, setNewCode] = useState("");
  const { busy, run } = useAction();
  const categories = useMemo(() => [...new Set(variants.flatMap((x) => [x.posCategory, ...(x.tags ?? [])]).filter(Boolean) as string[])].sort(), [variants]);

  const bind = async (force = false): Promise<void> => {
    const r = await call<{ conflict: boolean; boundTo?: { title: string } }>("bindCode", { code: newCode, variantId: v.id, force });
    if (r.conflict) {
      if (confirm(`這個條碼已綁定「${r.boundTo?.title}」，要改綁到這個款式嗎？`)) return bind(true);
      return;
    }
    setNewCode("");
  };

  return (
    <Modal
      title={variantName(v)}
      onClose={onClose}
      wide
      footer={
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(() => call("updateVariantMeta", { variantId: v.id, patch: { location, safety: Number(safety) || 0, posCategory, posSort: Number(posSort) || 0, posHidden } }), "已儲存").then(onClose)
          }
        >
          儲存設定
        </button>
      }
    >
      <div className="detail-head">
        <div className="grid-fields grow">
          <Field label="儲位">
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="例如 A1-03" />
          </Field>
          <Field label="安全庫存">
            <input type="number" min={0} value={safety} onChange={(e) => setSafety(e.target.value)} />
          </Field>
          <Field label="POS 分類" hint="預設用 meepShop 商品標籤">
            <input list="cats" value={posCategory} onChange={(e) => setPosCategory(e.target.value)} />
            <datalist id="cats">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="POS 排序" hint="數字小的排前面">
            <input type="number" value={posSort} onChange={(e) => setPosSort(e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={posHidden} onChange={(e) => setPosHidden(e.target.checked)} /> 不在 POS 商品區顯示
          </label>
        </div>
        <div className="center">
          <QrImg value={v.id} size={120} />
          <small className="muted d-block">進貨 QR（款式編號）</small>
        </div>
      </div>

      <h3>條碼</h3>
      <ul className="code-list">
        {v.barcode && (
          <li>
            <code>{v.barcode}</code> <Badge>meepShop 條碼</Badge>
          </li>
        )}
        {(v.extraCodes ?? []).map((c) => (
          <li key={c}>
            <code>{c}</code> {c === v.storeCode && <Badge tone="info">店內條碼</Badge>}
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => confirm(`解除綁定 ${c}？`) && run(() => call("unbindCode", { code: c }), "已解除")}>
              解除
            </button>
          </li>
        ))}
        {!v.barcode && !(v.extraCodes ?? []).length && <li className="muted">還沒有任何條碼</li>}
      </ul>
      <div className="inline-form">
        <input placeholder="掃描或輸入要綁定的條碼" value={newCode} onChange={(e) => setNewCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newCode.trim() && run(() => bind(), "已綁定")} />
        <button className="btn" disabled={busy || !newCode.trim()} onClick={() => run(() => bind(), "已綁定")}>
          綁定
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => call("generateStoreCode", { variantId: v.id }), "已產生店內條碼")}>
          產生店內條碼
        </button>
      </div>
    </Modal>
  );
}

function BulkEdit({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [location, setLocation] = useState("");
  const [safety, setSafety] = useState("");
  const [posCategory, setPosCategory] = useState("");
  const { busy, run } = useAction();
  const patch: Record<string, unknown> = {};
  if (location) patch.location = location;
  if (safety !== "") patch.safety = Number(safety);
  if (posCategory) patch.posCategory = posCategory;
  return (
    <Modal
      title={`批次設定 ${ids.length} 款`}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" disabled={busy || !Object.keys(patch).length} onClick={() => run(() => call("updateVariantMeta", { variantIds: ids, patch }), "已更新").then(onClose)}>
          套用
        </button>
      }
    >
      <p className="muted small">留空的欄位不會變更。</p>
      <Field label="儲位">
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label="安全庫存">
        <input type="number" min={0} value={safety} onChange={(e) => setSafety(e.target.value)} />
      </Field>
      <Field label="POS 分類">
        <input value={posCategory} onChange={(e) => setPosCategory(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ImageDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const { busy, run } = useAction();
  const manual = group.variants.some((v) => v.imageSource === "manual");
  const upload = (file: File) =>
    run(async () => {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `manual/${group.productId}/${Date.now()}.${ext}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      await call("setProductImage", { productId: group.productId, path });
    }, "已更換圖片").then(onClose);
  return (
    <Modal title={`商品圖片：${group.title}`} onClose={onClose}>
      <div className="center">{group.imageUrl ? <img src={group.imageUrl} alt="" className="preview-img" /> : <p className="muted">目前沒有圖片</p>}</div>
      <p className="muted small">{manual ? "目前是手動上傳的圖片（官網換圖不會覆蓋）。" : "目前是自動從官網商品頁抓的主圖。"}</p>
      <div className="btn-row">
        <label className="btn btn-primary">
          {busy ? "上傳中…" : "上傳圖片"}
          <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {manual && (
          <button className="btn" disabled={busy} onClick={() => run(() => call("setProductImage", { productId: group.productId, path: null }), "已改回官網圖片，下次同步重抓").then(onClose)}>
            改回官網圖片
          </button>
        )}
      </div>
    </Modal>
  );
}
