import JsBarcode from "jsbarcode";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { QrImg } from "../../components/QrImg";
import { useData } from "../../data";
import { money } from "../../lib/util";
import type { Variant } from "../../types";

/** Code 128 barcode (what ordinary barcode guns read). */
function Barcode({ value, height }: { value: string; height: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, { format: "CODE128", height, width: 1.4, margin: 0, fontSize: 10, textMargin: 1 });
    } catch {
      /* invalid characters */
    }
  }, [value, height]);
  return <svg ref={ref} className="tag-barcode" />;
}

/** The code printed on a tag: meepShop barcode, else our store code, else SKU. */
const tagCode = (v: Variant) => v.barcode || v.storeCode || v.sku || "";

type Mode = "tag" | "qr";
type Layout = "roll" | "a4";
interface Prefs {
  mode: Mode;
  layout: Layout;
  w: number;
  h: number;
  copies: number;
  price: boolean;
  care: boolean;
}
const DEFAULT: Prefs = { mode: "tag", layout: "roll", w: 40, h: 60, copies: 1, price: true, care: true };
const KEY = "g29.labelPrefs";

/**
 * 吊牌與標籤列印。「標籤機」版面每張一頁、紙張大小 = 吊牌大小（TSC / Brother / Zebra 等裝成印表機即可）；
 * 「A4」版面整張排滿，可用一般印表機印貼紙。
 */
export function Labels() {
  const { byId, settings } = useData();
  const ids = ((useLocation().state as { ids?: string[] })?.ids ?? []).filter((id) => byId.has(id));
  const [p, setP] = useState<Prefs>(() => {
    try {
      return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
    } catch {
      return DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  }, [p]);
  const set = (patch: Partial<Prefs>) => setP((x) => ({ ...x, ...patch }));
  const list = ids.flatMap((id) => Array.from({ length: p.copies }, () => byId.get(id)!));
  const noCode = p.mode === "tag" ? [...new Set(ids)].map((id) => byId.get(id)!).filter((v) => !tagCode(v)) : [];

  const w = p.mode === "qr" ? 40 : p.w;
  const h = p.mode === "qr" ? 30 : p.h;
  const pageCss = p.layout === "roll" ? `@page { size: ${w}mm ${h}mm; margin: 0; } .labels { gap: 0 !important; } .tag, .label { break-after: page; border: 0 !important; }` : `@page { size: A4; margin: 8mm; }`;

  return (
    <div className="page">
      <style>{`@media print { ${pageCss} }`}</style>
      <div className="page-head no-print">
        <div>
          <Link to="/admin/products" className="muted small">
            ← 商品與條碼
          </Link>
          <h1>列印標籤（{list.length} 張）</h1>
        </div>
        <button className="btn btn-primary" onClick={() => window.print()} disabled={!list.length}>
          列印
        </button>
      </div>

      <div className="card no-print">
        <div className="segmented">
          <button className={p.mode === "tag" ? "active" : ""} onClick={() => set({ mode: "tag" })}>
            服飾吊牌<small>條碼＋價格＋洗滌標示</small>
          </button>
          <button className={p.mode === "qr" ? "active" : ""} onClick={() => set({ mode: "qr" })}>
            進貨 QR 標籤<small>40×30mm</small>
          </button>
        </div>
        <div className="filters">
          <select value={p.layout} onChange={(e) => set({ layout: e.target.value as Layout })}>
            <option value="roll">標籤機（一張一頁）</option>
            <option value="a4">A4 整張排列</option>
          </select>
          {p.mode === "tag" && (
            <>
              <label className="check">
                寬 <input type="number" min={20} max={100} value={p.w} onChange={(e) => set({ w: Number(e.target.value) || 40 })} style={{ width: 70 }} /> mm
              </label>
              <label className="check">
                高 <input type="number" min={20} max={150} value={p.h} onChange={(e) => set({ h: Number(e.target.value) || 60 })} style={{ width: 70 }} /> mm
              </label>
              <label className="check">
                <input type="checkbox" checked={p.care} onChange={(e) => set({ care: e.target.checked })} /> 材質／洗滌標示
              </label>
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={p.price} onChange={(e) => set({ price: e.target.checked })} /> 價格
          </label>
          <label className="check">
            每款 <input type="number" min={1} max={100} value={p.copies} onChange={(e) => set({ copies: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 64 }} /> 張
          </label>
        </div>
        {noCode.length > 0 && <p className="notice notice-warn">{noCode.length} 款沒有條碼或商品編號，吊牌會改印 QR code。可在「商品與條碼」按「產生店內條碼」。</p>}
        {!list.length && <p className="muted">請先在「商品與條碼」勾選要印的款式。</p>}
      </div>

      <div className={`labels ${p.mode === "qr" ? "labels-m" : ""}`}>
        {list.map((v, i) =>
          p.mode === "qr" ? (
            <div key={`${v.id}-${i}`} className="label">
              <QrImg value={v.id} size={88} />
              <div className="label-text">
                <div className="label-title">{v.productTitle}</div>
                {v.options && <div>{v.options}</div>}
                {v.sku && <div className="label-sku">{v.sku}</div>}
                {p.price && <div className="label-price">{money(v.price)}</div>}
              </div>
            </div>
          ) : (
            <div key={`${v.id}-${i}`} className="tag" style={{ width: `${w}mm`, height: `${h}mm` }}>
              <div className="tag-shop">{settings.shopName || "ganbaru29"}</div>
              <div className="tag-title">{v.productTitle}</div>
              <div className="tag-opts">
                {(v.optionList ?? []).map((o) => (
                  <span key={o.name}>
                    {o.name}：{o.value}
                  </span>
                ))}
              </div>
              {p.price && <div className="tag-price">{money(v.price)}</div>}
              <div className="tag-code">{tagCode(v) ? <Barcode value={tagCode(v)} height={Math.max(20, Math.min(40, h * 0.5))} /> : <QrImg value={v.id} size={56} />}</div>
              {tagCode(v) !== v.sku && v.sku && <div className="tag-sku">{v.sku}</div>}
              {p.care && (v.material || v.careText) && (
                <div className="tag-care">
                  {v.material && <div>材質：{v.material}</div>}
                  {v.careText && <div>{v.careText}</div>}
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
