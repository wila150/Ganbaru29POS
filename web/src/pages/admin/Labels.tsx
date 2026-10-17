import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { QrImg } from "../../components/QrImg";
import { useData } from "../../data";
import { money } from "../../lib/util";

/** 每個款式產生進貨用 QR code 標籤，整批列印（瀏覽器列印 → 可存成 PDF）。QR 內容 = meepShop 款式編號。 */
export function Labels() {
  const { byId } = useData();
  const ids = ((useLocation().state as { ids?: string[] })?.ids ?? []).filter((id) => byId.has(id));
  const [copies, setCopies] = useState(1);
  const [size, setSize] = useState<"s" | "m">("m");
  const [showPrice, setShowPrice] = useState(true);
  const list = ids.flatMap((id) => Array.from({ length: copies }, () => byId.get(id)!));

  return (
    <div className="page">
      <div className="page-head no-print">
        <div>
          <Link to="/admin/products" className="muted small">
            ← 商品與條碼
          </Link>
          <h1>列印 QR 標籤（{list.length} 張）</h1>
        </div>
        <div className="btn-row">
          <label className="check">
            每款
            <input type="number" min={1} max={50} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))} style={{ width: 64 }} />張
          </label>
          <select value={size} onChange={(e) => setSize(e.target.value as "s" | "m")}>
            <option value="m">中（40×30mm）</option>
            <option value="s">小（30×20mm）</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> 印價格
          </label>
          <button className="btn btn-primary" onClick={() => window.print()} disabled={!list.length}>
            列印
          </button>
        </div>
      </div>
      {!list.length && <p className="muted">請先在「商品與條碼」勾選要印的款式。</p>}
      <div className={`labels labels-${size}`}>
        {list.map((v, i) => (
          <div key={`${v.id}-${i}`} className="label">
            <QrImg value={v.id} size={size === "m" ? 88 : 60} />
            <div className="label-text">
              <div className="label-title">{v.productTitle}</div>
              {v.options && <div>{v.options}</div>}
              {v.sku && <div className="label-sku">{v.sku}</div>}
              {showPrice && <div className="label-price">{money(v.price)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
