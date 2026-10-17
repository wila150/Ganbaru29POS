import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { call } from "../firebase";
import { money } from "../lib/util";
import type { ExchangeQuote } from "../types";
import { Modal, useAction } from "./ui";

export interface ExchangeItem {
  key: string;
  title: string;
  max: number;
  /** price shown to the cashier for orientation; the credit itself comes from the server */
  unit: number;
}

/**
 * 換貨第一步：選要退回的商品 → 伺服器試算可抵金額 → 帶到收銀畫面挑新商品。
 * request() turns the chosen quantities into the exchange payload (POS order or online order).
 */
export function ExchangeDialog({ title, items, request, onClose }: { title: string; items: ExchangeItem[]; request: (qty: Record<string, number>) => Record<string, unknown>; onClose: () => void }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const { busy, run } = useAction();
  const nav = useNavigate();
  const any = Object.values(qty).some((n) => n > 0);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          disabled={busy || !any}
          onClick={() =>
            run(async () => {
              const quote = await call<ExchangeQuote>("exchangeQuote", { exchange: request(qty) });
              nav("/pos", { state: { exchange: quote, cart: [] } });
            })
          }
        >
          {busy ? "試算中…" : "下一步：選新商品"}
        </button>
      }
    >
      <p className="muted small">選要退回的商品與數量，退回的金額會變成這次換貨的抵用金。</p>
      <table className="table table-compact">
        <tbody>
          {items.map((it) => (
            <tr key={it.key}>
              <td>
                {it.title}
                <div className="muted small">{money(it.unit)} / 件</div>
              </td>
              <td className="num">可換 {it.max}</td>
              <td>
                <div className="stepper">
                  <button onClick={() => setQty((q) => ({ ...q, [it.key]: Math.max(0, (q[it.key] ?? 0) - 1) }))}>−</button>
                  <input value={qty[it.key] ?? 0} readOnly />
                  <button disabled={it.max <= 0} onClick={() => setQty((q) => ({ ...q, [it.key]: Math.min(it.max, (q[it.key] ?? 0) + 1) }))}>＋</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
