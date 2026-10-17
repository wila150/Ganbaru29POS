import JsBarcode from "jsbarcode";
import { useEffect, useRef } from "react";

/** Code 128 條碼（一般掃描槍都讀得到） */
export function Barcode({ value, height = 50, width = 1.6, fontSize = 12 }: { value: string; height?: number; width?: number; fontSize?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, value, { format: "CODE128", height, width, margin: 0, fontSize, textMargin: 2 });
    } catch {
      /* invalid characters */
    }
  }, [value, height, width, fontSize]);
  return <svg ref={ref} className="barcode-svg" />;
}
