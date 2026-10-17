import { money } from "../lib/util";
import type { Variant } from "../types";

/**
 * 商品矩陣：顏色 × 尺碼一眼看完。兩個規格維度時畫成表格（列 = 第一個規格，欄 = 第二個），
 * 其他情況（單一規格、三個以上維度）退回成按鈕清單。
 */
export function VariantMatrix({ variants, onPick, currentId, stockOf }: { variants: Variant[]; onPick?: (v: Variant) => void; currentId?: string; stockOf?: (v: Variant) => number }) {
  const sorted = [...variants].sort((a, b) => a.variantIndex - b.variantIndex);
  const dims = sorted[0]?.optionList?.map((o) => o.name) ?? [];
  const prices = new Set(sorted.map((v) => v.price));
  const showPrice = prices.size > 1;
  const stock = (v: Variant) => (stockOf ? stockOf(v) : v.shopStock ?? 0);

  const cell = (v: Variant | undefined, label?: string) => {
    if (!v) return <td className="matrix-none">—</td>;
    const s = stock(v);
    const cls = `matrix-cell ${s <= 0 ? "out" : s <= Math.max(1, v.safety) ? "low" : ""} ${v.id === currentId ? "current" : ""}`;
    const body = (
      <>
        {label && <span className="matrix-label">{label}</span>}
        <strong>{s}</strong>
        {showPrice && <small>{money(v.price)}</small>}
      </>
    );
    return <td>{onPick ? <button className={cls} onClick={() => onPick(v)}>{body}</button> : <div className={cls}>{body}</div>}</td>;
  };

  if (dims.length === 2) {
    const uniq = (k: number) => [...new Set(sorted.map((v) => v.optionList[k]?.value))];
    const rows = uniq(0);
    const cols = uniq(1);
    const find = (r: string, c: string) => sorted.find((v) => v.optionList[0]?.value === r && v.optionList[1]?.value === c);
    return (
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th>
                {dims[0]} \ {dims[1]}
              </th>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th>合計</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <th>{r}</th>
                {cols.map((c) => (
                  <Cell key={c}>{cell(find(r, c))}</Cell>
                ))}
                <td className="matrix-sum">{sorted.filter((v) => v.optionList[0]?.value === r).reduce((s, v) => s + Math.max(0, stock(v)), 0)}</td>
              </tr>
            ))}
            <tr>
              <th>合計</th>
              {cols.map((c) => (
                <td key={c} className="matrix-sum">
                  {sorted.filter((v) => v.optionList[1]?.value === c).reduce((s, v) => s + Math.max(0, stock(v)), 0)}
                </td>
              ))}
              <td className="matrix-sum strong">{sorted.reduce((s, v) => s + Math.max(0, stock(v)), 0)}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">數字 = meepShop 庫存；紅色缺貨、黃色低於安全庫存</p>
      </div>
    );
  }

  return (
    <div className="variant-pick">
      {sorted.map((v) =>
        onPick ? (
          <button key={v.id} onClick={() => onPick(v)} className={`${stock(v) <= 0 ? "out" : ""} ${v.id === currentId ? "current" : ""}`}>
            <span>{v.options || "單一規格"}</span>
            <small>
              {money(v.price)} · 剩 {stock(v)}
            </small>
          </button>
        ) : (
          <div key={v.id} className={`variant-chip ${stock(v) <= 0 ? "out" : ""} ${v.id === currentId ? "current" : ""}`}>
            <span>{v.options || "單一規格"}</span>
            <small>剩 {stock(v)}</small>
          </div>
        )
      )}
    </div>
  );
}

// cell() already returns a <td>; this keeps keys on the mapped element.
function Cell({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
