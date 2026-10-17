import { useState } from "react";
import { useData, variantName } from "../data";
import { call } from "../firebase";
import { useDeviceLocation } from "../lib/location";
import type { Variant } from "../types";
import { useAction } from "./ui";

/** 跨店即時庫存：每個規格在各門市／倉庫的數量，缺貨時直接申請調貨到本店。 */
export function OtherLocations({ variants }: { variants: Variant[] }) {
  const { locStock } = useData();
  const { locations, locationId } = useDeviceLocation();
  const [req, setReq] = useState<{ variant: Variant; from: string; qty: number } | null>(null);
  const { busy, run } = useAction();
  const others = locations.filter((l) => l.id !== locationId);
  if (!others.length) return null;
  return (
    <div className="other-locs">
      <h3>其他門市／倉庫</h3>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>規格</th>
              {others.map((l) => (
                <th key={l.id} className="num">
                  {l.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...variants]
              .sort((a, b) => a.variantIndex - b.variantIndex)
              .map((v) => (
                <tr key={v.id}>
                  <td>{v.options || "單一規格"}</td>
                  {others.map((l) => {
                    const q = locStock.get(v.id)?.[l.id] ?? 0;
                    return (
                      <td key={l.id} className="num">
                        {q > 0 ? (
                          <button className="link-btn" onClick={() => setReq({ variant: v, from: l.id, qty: 1 })} title="申請調貨到本店">
                            {q}
                          </button>
                        ) : (
                          <span className="muted">0</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {req && (
        <div className="notice">
          從「{locations.find((l) => l.id === req.from)?.name}」調 {variantName(req.variant)}
          <input type="number" min={1} value={req.qty} onChange={(e) => setReq({ ...req, qty: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 70 }} /> 件到本店
          <button
            className="btn btn-sm btn-primary"
            disabled={busy || !locationId}
            onClick={() => run(() => call("requestTransfer", { from: req.from, to: locationId, items: [{ variantId: req.variant.id, qty: req.qty }], note: "POS 現場調貨" }), "已送出調貨申請").then(() => setReq(null))}
          >
            申請調貨
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setReq(null)}>
            取消
          </button>
        </div>
      )}
      <p className="muted small">點數字可以申請調貨到本店；對方在「調貨」頁出貨後，你收到時按「收貨」。</p>
    </div>
  );
}
