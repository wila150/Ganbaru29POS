import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function QrImg({ value, size = 160, className }: { value: string; size?: number; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: size * 2, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(""));
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt={`QR ${value}`} className={className} /> : <div style={{ width: size, height: size }} />;
}
