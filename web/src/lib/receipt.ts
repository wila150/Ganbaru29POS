import type { PosOrder, ShopSettings } from "../types";
import { fmtTime, money, PAY_NAME } from "./util";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Prints a 58/80 mm receipt through the browser print dialog. Bluetooth / USB receipt printers
 * that install as a system printer work this way; the cash drawer opens from the printer's kick port
 * if the printer driver is set to "open drawer after print".
 */
export function printReceipt(o: PosOrder, s: ShopSettings, opts: { copy?: boolean; widthMm?: number } = {}) {
  const w = window.open("", "_blank", "width=420,height=640");
  if (!w) {
    alert("瀏覽器擋住了列印視窗，請允許此網站開啟彈出式視窗");
    return;
  }
  const width = opts.widthMm ?? 72;
  const rows = o.lines
    .map(
      (l) => `<tr><td colspan="3">${esc(l.productTitle)}${l.options ? ` ${esc(l.options)}` : ""}${l.note ? `<br><small>※ ${esc(l.note)}</small>` : ""}</td></tr>
      <tr><td class="m">${l.qty} × ${money(l.unitPrice)}${l.discountPct ? ` (-${l.discountPct}%)` : ""}</td><td></td><td class="r">${money(l.total + (l.promoDiscount ?? 0))}</td></tr>`
    )
    .join("");
  const line = (label: string, v: string) => `<tr><td>${label}</td><td></td><td class="r">${v}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.orderNo)}</title>
<style>
@page { size: ${width + 6}mm auto; margin: 3mm; }
body { font-family: "PingFang TC","Noto Sans TC",sans-serif; width: ${width}mm; margin: 0; font-size: 12px; color: #000; }
h1 { font-size: 16px; text-align: center; margin: 0 0 2px; }
.c { text-align: center; } .r { text-align: right; white-space: nowrap; } .m { color: #333; padding-left: 8px; }
table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; }
hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; } .big td { font-size: 15px; font-weight: 700; }
pre { font-family: inherit; white-space: pre-wrap; margin: 0; }
</style></head><body>
<h1>${esc(s.shopName || "ganbaru29")}</h1>
${s.receiptHeader ? `<pre class="c">${esc(s.receiptHeader)}</pre>` : ""}
${opts.copy ? `<div class="c">（補印）</div>` : ""}
<hr>
<div>單號：${esc(o.orderNo)}</div>
<div>時間：${esc(fmtTime(o.createdAt))}　收銀：${esc(o.cashierName)}</div>
${o.shopper ? `<div>會員：${esc(o.shopper.name || o.shopper.mobile || o.shopper.email)}</div>` : ""}
<hr><table>${rows}</table><hr>
<table>
${(o.promotions ?? []).map((p) => line(esc(p.name), `-${money(p.discount)}`)).join("")}
${line("小計", money(o.subtotal))}
${o.memberDiscount ? line(`會員折扣 ${esc(o.memberTier ?? "")} ${o.memberDiscountPct}%`, `-${money(o.memberDiscount)}`) : ""}
${o.orderDiscount ? line(`整單折扣 ${o.orderDiscountPct}%`, `-${money(o.orderDiscount)}`) : ""}
${o.serviceFee ? line(`服務費 ${o.serviceFeePct}%`, money(o.serviceFee)) : ""}
${o.allowance ? line("折讓", `-${money(o.allowance)}`) : ""}
${o.rewardDiscount ? line(`購物金折抵 ${o.rewardPoints} 點`, `-${money(o.rewardDiscount)}`) : ""}
</table>
<table class="big">${line("合計", money(o.total))}</table>
<table>
${o.payments.map((p) => line(PAY_NAME[p.method] ?? p.method, money(p.amount))).join("")}
${o.change ? line("找零", money(o.change)) : ""}
${o.rewardEarned ? line("本次回饋購物金", `${o.rewardEarned} 點`) : ""}
</table>
<hr>
<div class="c">共 ${o.itemCount} 件</div>
${s.receiptFooter ? `<pre class="c">${esc(s.receiptFooter)}</pre>` : `<div class="c">謝謝光臨</div>`}
<div class="c" style="margin-top:4px;font-size:10px">此為交易明細，非統一發票</div>
<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)}</script>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
