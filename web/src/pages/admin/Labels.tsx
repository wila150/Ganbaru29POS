import JsBarcode from "jsbarcode";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { QrImg } from "../../components/QrImg";
import { useData } from "../../data";
import { call } from "../../firebase";
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
  const state = useLocation().state as { ids?: string[]; markPrinted?: boolean; mode?: Mode } | null;
  const allIds = (state?.ids ?? []).filter((id) => byId.has(id));
  // 可勾選：預設全勾；也可以個別設定張數（空白 = 用上方的「每款幾張」）
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [perCopies, setPerCopies] = useState<Record<string, number>>({});
  const [showPick, setShowPick] = useState(allIds.length <= 60);
  const ids = allIds.filter((id) => !unchecked.has(id));
  const [marked, setMarked] = useState(false);
  // 列印後詢問是否標記為「已印」，從「未印 QR」清單移除
  useEffect(() => {
    if (!state?.markPrinted || !ids.length) return;
    const after = () => {
      if (marked) return;
      setTimeout(() => {
        if (confirm(`標籤都印好了嗎？按「確定」把這 ${ids.length} 款從「未印 QR」清單移除。`))
          call("markLabelsPrinted", { variantIds: ids }).then(() => setMarked(true)).catch((e) => alert(e.message));
      }, 300);
    };
    window.addEventListener("afterprint", after);
    return () => window.removeEventListener("afterprint", after);
  }, [ids.join(","), marked]); // eslint-disable-line react-hooks/exhaustive-deps
  const [p, setP] = useState<Prefs>(() => {
    try {
      return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}"), ...(state?.mode ? { mode: state.mode } : {}) };
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
  const list = ids.flatMap((id) => Array.from({ length: perCopies[id] ?? p.copies }, () => byId.get(id)!));
  const toggle = (id: string) =>
    setUnchecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
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
        <div className="btn-row">
          {marked && <span className="ok small">已標記為已印</span>}
          <button
            className="btn"
            disabled={!list.length}
            title="精臣 B1 等藍牙標籤機：在精臣 App 用「Excel 批量列印」匯入"
            onClick={async () => {
              const { makeXlsx, downloadBlob } = await import("../../lib/xlsx");
              // 一張標籤一列（每款印幾張就幾列）；QR 內容 = 吊牌條碼（掃描器嗶了就認得）
              // 欄位給精臣 App 綁定：要印哪幾項、怎麼排，在 App 的範本裡決定
              const split = (o: string) => {
                const parts = (o || "").split("/").map((x) => x.trim()).filter(Boolean);
                const size = parts.find((x) => /^(XXS|XS|S|M|L|XL|XXL|XXXL|\d?XL|F|FREE|ONE ?SIZE|\d{2,3})$/i.test(x)) ?? "";
                return { color: parts.filter((x) => x !== size).join(" "), size };
              };
              const rows = [
                ["QR內容", "品名", "規格", "顏色", "尺寸", "價格", "價格數字", "商品編號", "材質", "洗滌"],
                ...list.map((v) => {
                  const o = split(v.options);
                  return [tagCode(v) || v.id, v.productTitle, v.options || "", o.color, o.size, v.price != null ? `NT$${v.price.toLocaleString("zh-TW")}` : "", v.price ?? "", v.sku ?? "", v.material ?? "", v.careText ?? ""];
                }),
              ];
              downloadBlob(await makeXlsx(rows, "標籤"), `精臣標籤_${new Date().toISOString().slice(0, 10)}_${list.length}張.xlsx`);
            }}
          >
            匯出精臣 B1 Excel
          </button>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!list.length}>
            列印
          </button>
        </div>
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
        {allIds.length > 0 && (
          <div className="label-pick">
            <div className="row-between">
              <button className="link-btn" onClick={() => setShowPick((x) => !x)}>
                {showPick ? "▾" : "▸"} 選擇要印的款式（已勾 {ids.length}／{allIds.length}）
              </button>
              {showPick && (
                <div className="btn-row">
                  <button className="btn btn-sm btn-ghost" onClick={() => setUnchecked(new Set())}>
                    全選
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setUnchecked(new Set(allIds))}>
                    全不選
                  </button>
                </div>
              )}
            </div>
            {showPick && (
              <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
                <table className="table table-compact table-click">
                  <tbody>
                    {allIds.map((id) => {
                      const v = byId.get(id)!;
                      return (
                        <tr key={id} onClick={() => toggle(id)}>
                          <td>
                            <input type="checkbox" readOnly checked={!unchecked.has(id)} />
                          </td>
                          <td>
                            {v.productTitle} <span className="muted">{v.options}</span>
                          </td>
                          <td className="muted small">{v.sku}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <input
                              type="number"
                              min={0}
                              max={100}
                              placeholder={String(p.copies)}
                              value={perCopies[id] ?? ""}
                              onChange={(e) => setPerCopies((c) => {
                                const n = { ...c };
                                if (e.target.value === "") delete n[id];
                                else n[id] = Math.max(0, Number(e.target.value) || 0);
                                return n;
                              })}
                              style={{ width: 70 }}
                              title="這款印幾張（空白 = 用上方設定）"
                            />{" "}
                            張
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
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
