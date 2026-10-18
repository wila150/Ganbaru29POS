import { doc, getDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useData } from "../data";
import { db } from "../firebase";
import { money } from "../lib/util";
import { Modal } from "./ui";

interface Info {
  images?: string[];
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
  useEffect(() => {
    getDoc(doc(db, "productInfo", productId))
      .then((d) => setInfo((d.data() as Info) ?? {}))
      .catch(() => setInfo({}));
  }, [productId]);
  if (!v0) return null;
  const image = info?.images?.[0] || v0.imageUrl;
  const prices = vs.map((v) => v.price ?? 0);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const stock = (id: string) => (stockOf ? stockOf(id) : vs.find((v) => v.id === id)?.shopStock ?? 0);
  return (
    <Modal title={v0.productTitle} onClose={onClose} wide>
      <div className="pinfo">
        {image ? <img src={image} alt="" className="pinfo-main" /> : <div className="pinfo-main empty">沒有圖片</div>}
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
