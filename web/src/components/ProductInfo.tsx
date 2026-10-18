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
 * 在 App 裡看官網商品：圖片、說明（來自 Google Merchant Center 的商品資料）、各規格價格與庫存。
 * 官網本身有 Cloudflare 驗證、也禁止被嵌入，所以不直接開官網頁面。
 */
export function ProductInfo({ productId, onClose, stockOf }: { productId: string; onClose: () => void; stockOf?: (variantId: string) => number }) {
  const { variants } = useData();
  const vs = variants.filter((v) => v.productId === productId).sort((a, b) => a.variantIndex - b.variantIndex);
  const v0 = vs[0];
  const [info, setInfo] = useState<Info | null>(null);
  const [img, setImg] = useState(0);
  useEffect(() => {
    getDoc(doc(db, "productInfo", productId))
      .then((d) => setInfo((d.data() as Info) ?? {}))
      .catch(() => setInfo({}));
  }, [productId]);
  if (!v0) return null;
  const images = info?.images?.length ? info.images : [v0.imageUrl].filter(Boolean) as string[];
  const prices = vs.map((v) => v.price ?? 0);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const stock = (id: string) => (stockOf ? stockOf(id) : vs.find((v) => v.id === id)?.shopStock ?? 0);
  return (
    <Modal title={v0.productTitle} onClose={onClose} wide>
      <div className="pinfo">
        <div className="pinfo-gallery">
          {images.length ? (
            <>
              <img src={images[Math.min(img, images.length - 1)]} alt="" className="pinfo-main" />
              {images.length > 1 && (
                <div className="pinfo-thumbs">
                  {images.map((u, i) => (
                    <button key={u} className={i === img ? "on" : ""} onClick={() => setImg(i)}>
                      <img src={u} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="pinfo-main empty">沒有圖片</div>
          )}
        </div>
        <div className="pinfo-body">
          <div className="pinfo-price">{lo === hi ? money(lo) : `${money(lo)} ～ ${money(hi)}`}</div>
          <table className="table table-compact">
            <thead>
              <tr>
                <th>規格</th>
                <th className="num">售價</th>
                <th className="num">庫存</th>
                <th className="num">近 30 天賣出</th>
              </tr>
            </thead>
            <tbody>
              {vs.map((v) => (
                <tr key={v.id}>
                  <td>{v.options || "單一規格"}</td>
                  <td className="num">{money(v.price ?? 0)}</td>
                  <td className={`num ${stock(v.id) <= 0 ? "error" : ""}`}>{stock(v.id)}</td>
                  <td className="num">{v.sales30 ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {info === null ? (
            <p className="muted">讀取商品說明…</p>
          ) : info.description ? (
            <div className="pinfo-desc">{info.description}</div>
          ) : (
            <p className="muted small">還沒有商品說明（每天 08:00 從 Google Merchant Center 同步）</p>
          )}
          {info?.link && (
            <a className="btn btn-sm" href={info.link} target="_blank" rel="noreferrer">
              在官網開啟 ↗
            </a>
          )}
        </div>
      </div>
    </Modal>
  );
}
