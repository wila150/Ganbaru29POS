import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { useAuth } from "../auth";
import { atLeast } from "../lib/util";
import { useEffect, useState } from "react";
import { useData } from "../data";
import { db, storage } from "../firebase";
import { money } from "../lib/util";
import { Modal, useAction } from "./ui";

interface Info {
  images?: string[];
  /** 店長上傳的其他角度／細節圖 */
  extraImages?: { url: string; path: string }[];
  title?: string | null;
  description?: string | null;
  link?: string | null;
}

/**
 * 官網「商品細節」：Google 商品資料把換行變成空白了，這裡依標籤把行切回來（材質、製造地、尺寸、平量尺寸、麻豆…），
 * 「顧客購物須知」之後的店家規範不顯示。
 */
export function detailLines(raw: string): string[] {
  let t = raw.split(/顧客購物須知/)[0].replace(/\s+/g, " ").trim();
  const KEYS = "衣長|肩寬|衣寬|胸寬|胸圍|袖長|袖寬|袖口|下擺|腰圍|腰寬|臀圍|臀寬|褲長|前襠|後襠|大腿|小腿|褲管|褲口|裙長|領寬|領高|帽高|總長";
  t = t
    .replace(/\s*--+\s*/g, "\n")
    .replace(/\s+(材質\s*[:：])/, "\n$1")
    .replace(/\s*(製造地|產地)\s*[:：]\s*(\S+)\s*/, "\n$1：$2\n")
    .replace(/\s*(尺寸\s*[:：])\s*/, "\n$1 ")
    .replace(/\s*(平量尺寸為?\s*cm\s*[:：]?)\s*/i, "\n$1\n")
    .replace(/\s*((?:麻豆|模特兒?)[^\s_]*[:：]?)\s*/, "\n$1\n")
    .replace(/\s*([^\s_]{1,6}_\s*\d{3}\s*CM)/gi, "\n$1");
  // 套裝：每件（襯衫_、長褲_…）各自一行；上衣尺寸後面接褲子尺寸時分行
  t = t.replace(new RegExp(`\\s*([^\\s_]{1,6}_)\\s*(?=(?:${KEYS})\\s*[:：])`, "g"), "\n$1 ");
  t = t.replace(/(衣長[^\n]*?)\s+(腰圍\s*[:：])/, "$1\n$2");
  // 尺寸數字後面接說明文字（例：寬褲褲頭為…）時分行
  t = t.replace(new RegExp(`((?:${KEYS})\\s*[:：]\\s*[^\\s]+)\\s+(?!(?:${KEYS})\\s*[:：])([^\\s\\n_]{4,}[^\\n]*)`, "g"), (m, a, b) => (/^[\d(（~-]/.test(b) ? m : `${a}\n${b}`));
  // 沒有「平量尺寸」這行時，尺寸數字自己一行
  if (!/平量尺寸/.test(t)) t = t.replace(new RegExp(`\\s+((?:${KEYS})\\s*[:：])`), "\n$1");
  return t
    .split("\n")
    .map((l) => l.trim().replace(/_\s*/, "_ "))
    .filter(Boolean);
}

/**
 * 商品資訊（給客人看）：圖、價格、各尺寸／顏色有沒有貨、材質與尺寸表。
 * 官網本身有 Cloudflare 驗證、也禁止被嵌入，所以不直接開官網頁面。
 */
export function ProductInfo({ productId, onClose, stockOf }: { productId: string; onClose: () => void; stockOf?: (variantId: string) => number }) {
  const { variants } = useData();
  const vs = variants.filter((v) => v.productId === productId).sort((a, b) => a.variantIndex - b.variantIndex);
  const v0 = vs[0];
  const [info, setInfo] = useState<Info | null>(null);
  const [img, setImg] = useState(0);
  const [editing, setEditing] = useState(false);
  const { profile } = useAuth();
  const canEdit = atLeast(profile?.role, "manager");
  const { busy, run } = useAction();
  useEffect(
    () =>
      onSnapshot(
        doc(db, "productInfo", productId),
        (d) => setInfo((d.data() as Info) ?? {}),
        () => setInfo({})
      ),
    [productId]
  );
  if (!v0) return null;
  const main = info?.images?.[0] || v0.imageUrl;
  const gallery = [...(main ? [main] : []), ...(info?.extraImages ?? []).map((x) => x.url)];
  const shown = gallery[Math.min(img, Math.max(0, gallery.length - 1))];
  const upload = (files: FileList) =>
    run(async () => {
      const list = [...files].filter((f) => f.type.startsWith("image/"));
      if (!list.length) throw new Error("請選擇圖片");
      const added: { url: string; path: string }[] = [];
      for (const f of list) {
        if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} 超過 5MB`);
        const path = `manual/${productId}/gallery-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${(f.name.split(".").pop() || "jpg").toLowerCase()}`;
        await uploadBytes(ref(storage, path), f, { contentType: f.type });
        added.push({ url: await getDownloadURL(ref(storage, path)), path });
      }
      await setDoc(doc(db, "productInfo", productId), { extraImages: [...(info?.extraImages ?? []), ...added] }, { merge: true });
    }, "已新增圖片");
  const remove = (path: string) =>
    run(async () => {
      await setDoc(doc(db, "productInfo", productId), { extraImages: (info?.extraImages ?? []).filter((x) => x.path !== path) }, { merge: true });
      await deleteObject(ref(storage, path)).catch(() => undefined);
      setImg(0);
    }, "已刪除");
  const move = (i: number, d: number) => {
    const arr = [...(info?.extraImages ?? [])];
    [arr[i], arr[i + d]] = [arr[i + d], arr[i]];
    run(() => setDoc(doc(db, "productInfo", productId), { extraImages: arr }, { merge: true }));
  };
  const prices = vs.map((v) => v.price ?? 0);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const stock = (id: string) => (stockOf ? stockOf(id) : vs.find((v) => v.id === id)?.shopStock ?? 0);
  return (
    <Modal title={v0.productTitle} onClose={onClose} wide>
      <div className="pinfo">
        <div className="pinfo-gallery">
          {shown ? <img src={shown} alt="" className="pinfo-main" /> : <div className="pinfo-main empty">沒有圖片</div>}
          {(gallery.length > 1 || canEdit) && (
            <div className="pinfo-thumbs">
              {gallery.map((u, i) => (
                <button key={u} className={u === shown ? "on" : ""} onClick={() => setImg(i)}>
                  <img src={u} alt="" loading="lazy" />
                </button>
              ))}
              {canEdit && (
                <label className="pinfo-add" title="新增圖片（可一次選多張）">
                  {busy ? "…" : "＋"}
                  <input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => e.target.files?.length && upload(e.target.files)} />
                </label>
              )}
            </div>
          )}
          {canEdit && (info?.extraImages?.length ?? 0) > 0 && (
            <button className="link-btn small" onClick={() => setEditing(!editing)}>
              {editing ? "完成" : "整理圖片（排序、刪除）"}
            </button>
          )}
          {editing && (
            <div className="pinfo-edit">
              {(info?.extraImages ?? []).map((x, i, arr) => (
                <div key={x.path} className="pinfo-edit-row">
                  <img src={x.url} alt="" />
                  <button className="btn-icon" disabled={i === 0} onClick={() => move(i, -1)}>
                    ←
                  </button>
                  <button className="btn-icon" disabled={i === arr.length - 1} onClick={() => move(i, 1)}>
                    →
                  </button>
                  <button className="btn-icon danger" onClick={() => confirm("刪除這張圖？") && remove(x.path)}>
                    ✕
                  </button>
                </div>
              ))}
              <p className="muted small">第一張是官網主圖（每天自動同步，不能刪）；這裡是你上傳的其他角度、細節圖。</p>
            </div>
          )}
        </div>
        <div className="pinfo-body">
          <div className="pinfo-price">{lo === hi ? money(lo) : `${money(lo)} ～ ${money(hi)}`}</div>
          <div className="pinfo-variants">
            {vs.map((v) => {
              const n = stock(v.id);
              return (
                <span key={v.id} className={`pinfo-chip ${n <= 0 ? "out" : ""}`}>
                  {v.options || "單一規格"}
                  <b>{n <= 0 ? "缺貨" : `${n} 件`}</b>
                </span>
              );
            })}
          </div>
          {info === null ? (
            <p className="muted small">讀取中…</p>
          ) : info.description ? (
            <div className="pinfo-detail">
              <h3>商品細節</h3>
              {detailLines(info.description).map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          ) : null}
          {info?.link && (
            <a className="link-btn small" href={info.link} target="_blank" rel="noreferrer">
              官網頁面 ↗
            </a>
          )}
        </div>
      </div>
    </Modal>
  );
}
