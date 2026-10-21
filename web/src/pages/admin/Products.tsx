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
  thumbUrl?: string | null;
  status: string;
  variants: Variant[];
}

export function Products() {
  const { variants, settings } = useData();
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState<"" | "image" | "code" | "location" | "unprinted">("");
  // 分類（跟 POS 收銀的頁籤一樣：meepShop 標籤，例如長褲、特價專區）
  const [cat, setCat] = useState("全部");
  const catsOf = (v: Variant) => [...new Set([v.posCategory, ...(v.tags ?? [])].filter(Boolean) as string[])];
  const categories = useMemo(() => {
    const count = new Map<string, Set<string>>();
    for (const v of variants) for (const c of catsOf(v)) (count.get(c) ?? count.set(c, new Set()).get(c)!).add(v.productId);
    return [["全部", new Set(variants.map((v) => v.productId)).size] as const, ...[...count.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0], "zh-Hant")).map(([c, s]) => [c, s.size] as const)];
  }, [variants]);
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
    if (cat !== "全部") list = list.filter((v) => catsOf(v).includes(cat));
    if (onlyMissing === "image") list = list.filter((v) => !v.imageUrl || missingImg.has(v.productId));
    if (onlyMissing === "code") list = list.filter((v) => !v.barcode && !v.storeCode && !(v.extraCodes ?? []).length);
    if (onlyMissing === "location") list = list.filter((v) => !v.location);
    if (onlyMissing === "unprinted") list = list.filter((v) => v.labelPrinted !== true);
    const map = new Map<string, Group>();
    for (const v of list) {
      const g = map.get(v.productId) ?? { productId: v.productId, title: v.productTitle, imageUrl: v.imageUrl, thumbUrl: v.thumbUrl, status: v.productStatus, variants: [] };
      g.variants.push(v);
      map.set(v.productId, g);
    }
    const out = [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));
    out.forEach((g) => g.variants.sort((a, b) => a.variantIndex - b.variantIndex));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, q, onlyMissing, missingImg, cat]);

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
        <div className="btn-row">
        <FeedImport />
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
      </div>

      <input className="search" placeholder="搜尋名稱、編號、條碼、儲位" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cat-tabs">
        {categories.map(([c, n]) => (
          <button key={c} className={`chip ${cat === c ? "active" : ""}`} onClick={() => setCat(c)}>
            {c} <small>{n}</small>
          </button>
        ))}
      </div>
      <div className="chips">
        {(
          [
            ["", "全部"],
            ["image", `缺圖片 ${missingImg.size || ""}`],
            ["code", "沒有條碼"],
            ["location", "沒有儲位"],
            ["unprinted", `未印 QR ${variants.filter((v) => v.labelPrinted !== true).length || ""}`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={`chip ${onlyMissing === k ? "active" : ""}`} onClick={() => setOnlyMissing(k)}>
            {l}
          </button>
        ))}
      </div>

      {(() => {
        // 全選：目前搜尋／篩選結果裡的所有款式（不限畫面上顯示的前 200 個商品）
        const visibleIds = groups.flatMap((g) => g.variants.map((v) => v.id));
        const allOn = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
        return (
          <label className="check select-all">
            <input
              type="checkbox"
              checked={allOn}
              ref={(el) => {
                if (el) el.indeterminate = !allOn && visibleIds.some((id) => selected.has(id));
              }}
              onChange={(e) => toggle(visibleIds, e.target.checked)}
            />
            全選{q || onlyMissing || cat !== "全部" ? `目前篩選的${cat !== "全部" ? `「${cat}」` : ""}` : "全部"} {visibleIds.length} 款（{groups.length} 個商品）
          </label>
        );
      })()}
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button
          className="btn btn-sm"
          disabled={!variants.some((v) => v.labelPrinted !== true)}
          onClick={() => nav("/admin/labels", { state: { ids: variants.filter((v) => v.labelPrinted !== true).map((v) => v.id), markPrinted: true, mode: "qr" } })}
        >
          列印全部未印的 QR（{variants.filter((v) => v.labelPrinted !== true).length} 款）
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => downloadQrZip(selected.size ? variants.filter((v) => selected.has(v.id)) : variants), "已下載")}>
          下載{selected.size ? `已選 ${selected.size} 款` : "全部"} QR 圖檔（ZIP）
        </button>
      </div>
      {selected.size > 0 && (
        <div className="sticky-bar">
          已選 {selected.size} 款
          <button className="btn btn-sm" onClick={() => setBulk(true)}>
            批次設定
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => nav("/admin/labels", { state: { ids: [...selected], markPrinted: true } })}>
            列印吊牌／標籤
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
                    {g.imageUrl ? <img src={g.thumbUrl || g.imageUrl} alt="" loading="lazy" decoding="async" /> : <span>無圖</span>}
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
  const [material, setMaterial] = useState(v.material ?? "");
  const [careText, setCareText] = useState(v.careText ?? "");
  const siblings = useMemo(() => variants.filter((x) => x.productId === v.productId).map((x) => x.id), [variants, v.productId]);
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
            run(async () => {
              await call("updateVariantMeta", { variantId: v.id, patch: { location, safety: Number(safety) || 0, posCategory, posSort: Number(posSort) || 0, posHidden } });
              // 材質、洗滌標示是整個款式共用的，套用到同款所有規格
              await call("updateVariantMeta", { variantIds: siblings, patch: { material, careText } });
            }, "已儲存").then(onClose)
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
          <Field label="材質（吊牌用，同款共用）">
            <input value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="例：棉 100%" />
          </Field>
          <Field label="洗滌標示（吊牌用，同款共用）">
            <textarea rows={2} value={careText} onChange={(e) => setCareText(e.target.value)} placeholder="例：手洗、不可漂白、低溫熨燙、陰乾" />
          </Field>
        </div>
        <div className="center">
          <QrImg value={v.id} size={120} />
          <small className="muted d-block">進貨 QR（款式編號）</small>
          <button className="btn btn-sm btn-ghost" onClick={() => downloadQrZip([v])}>
            下載 QR 圖
          </button>
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

/**
 * 匯入 meepShop 的 Google 商品 Feed（.tsv / .txt）補商品圖。
 * Feed 網址有 Cloudflare 驗證，系統抓不到，所以由老闆用瀏覽器下載後在這裡上傳。
 */
function FeedImport() {
  const { busy, run } = useAction();
  const parse = (text: string) => {
    const lines = text.replace(/^\ufeff/, "").split(/\r?\n/).filter((l) => l.trim());
    const head = lines[0]?.split("\t").map((h) => h.trim().toLowerCase()) ?? [];
    const iId = head.indexOf("id");
    const iImg = head.indexOf("image_link");
    if (iId < 0 || iImg < 0) throw new Error("檔案格式不對：找不到 id 或 image_link 欄位。請下載 meepShop「第三方設定 → Google Ads → 動態檔案網址」的檔案。");
    return lines.slice(1).map((l) => {
      const c = l.split("\t");
      return { id: (c[iId] ?? "").trim(), image: (c[iImg] ?? "").trim() };
    }).filter((r) => r.id && r.image);
  };
  return (
    <label className={`btn ${busy ? "disabled" : ""}`} title="用瀏覽器下載 meepShop 的 Google 商品 Feed 後上傳，補齊商品圖">
      {busy ? "匯入圖片中（約 1～3 分鐘）…" : "匯入商品 Feed 補圖片"}
      <input
        type="file"
        accept=".tsv,.txt,text/tab-separated-values,text/plain"
        hidden
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          run(async () => {
            const rows = parse(await file.text());
            const r = await call<{ done: number; skipped: number; failedCount: number; failed: string[] }>("importImageFeed", { rows });
            alert(`已補上 ${r.done} 個商品的圖片${r.skipped ? `，略過 ${r.skipped} 個（已有圖片、手動上傳過或不在系統中）` : ""}${r.failedCount ? `\n失敗 ${r.failedCount} 個：\n${r.failed.join("\n")}` : ""}`);
          });
        }}
      />
    </label>
  );
}

/** 每個款式一張 QR code PNG（內容 = meepShop 款式編號），打包成 ZIP 下載。 */
async function downloadQrZip(list: Variant[]) {
  const [{ default: JSZip }, QR] = await Promise.all([import("jszip"), import("qrcode")]);
  const zip = new JSZip();
  const used = new Set<string>();
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  for (const v of list) {
    let name = safe([v.productTitle, v.options.replace(/ \/ /g, "-"), v.sku].filter(Boolean).join("_"));
    while (used.has(name)) name += "_";
    used.add(name);
    const url = await QR.toDataURL(v.id, { margin: 2, width: 600, errorCorrectionLevel: "M" });
    zip.file(`${name}.png`, url.split(",")[1], { base64: true });
  }
  zip.file("說明.txt", "每張 QR code 的內容是 meepShop 款式編號，用 ganbaru29 系統掃描即可對應到商品（進貨、盤點、POS 結帳）。\n");
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ganbaru29_QR_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
