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

/** 官網說明整理成重點：材質、產地、尺寸、模特兒；「顧客購物須知」之後的店家規範不顯示 */
export function parseDescription(raw: string) {
  const text = raw.split(/顧客購物須知/)[0].replace(/\s+/g, " ").trim();
  const pick = (re: RegExp) => text.match(re)?.[1]?.trim() ?? null;
  const material = pick(/材質\s*[:：]\s*(\S+)/);
  const origin = pick(/(?:製造地|產地)\s*[:：]\s*(\S+)/);
  // 只認常見的平量部位，避免把其他文字當成尺寸
  const KEYS = "衣長|肩寬|衣寬|胸寬|胸圍|袖長|袖寬|袖口|下擺|腰圍|腰寬|臀圍|臀寬|褲長|前襠|後襠|大腿|大腿寬|褲管|褲口|裙長|領寬|領高|帽高|總長";
  const sizes = [...text.matchAll(new RegExp(`(${KEYS})\\s*[:：]\\s*([^\\s]+)`, "g"))].map((m) => ({ k: m[1], v: m[2] }));
  const sizeLabel = text.match(/尺寸\s*[:：]\s*([A-Z0-9\/]{1,10})\s/)?.[1] ?? null;
  const models = [...text.matchAll(/(\S+?)_\s*(\d{3}\s*CM\s*\/\s*\d{2,3}\s*KG(?:\s*\/\s*\d{2}\s*腰)?)/gi)].map((m) => ({ name: m[1], body: m[2].replace(/\s/g, "") }));
  const structured = !!(material || origin || sizes.length || models.length);
  return { material, origin, sizes, sizeLabel, models, text: structured ? null : text };
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
  const d = info?.description ? parseDescription(info.description) : null;
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
          ) : d ? (
            <dl className="pinfo-spec">
              {d.material && (
                <>
                  <dt>材質</dt>
                  <dd>{d.material.replace(/\//g, "、")}</dd>
                </>
              )}
              {d.origin && (
                <>
                  <dt>產地</dt>
                  <dd>{d.origin}</dd>
                </>
              )}
              {d.sizes.length > 0 && (
                <>
                  <dt>尺寸{d.sizeLabel ? `（${d.sizeLabel}）` : ""}</dt>
                  <dd>
                    {d.sizes.map((x) => (
                      <span key={x.k} className="pinfo-size">
                        {x.k} <b>{x.v}</b>
                      </span>
                    ))}
                    <div className="muted small">平量，單位 cm</div>
                  </dd>
                </>
              )}
              {d.models.length > 0 && (
                <>
                  <dt>模特兒</dt>
                  <dd>
                    {d.models.map((m) => (
                      <div key={m.name}>
                        {m.name}　{m.body.replace(/CM/i, " cm").replace(/KG/i, " kg").replace(/\//g, "・")}
                      </div>
                    ))}
                  </dd>
                </>
              )}
              {d.text && (
                <>
                  <dt>說明</dt>
                  <dd className="pinfo-desc">{d.text}</dd>
                </>
              )}
            </dl>
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
