import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Modal } from "./ui";

const FORMATS = [
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.ITF,
];

const FACE_KEY = "g29.cameraFace";
const readFace = (fallback: "environment" | "user"): "environment" | "user" => {
  try {
    const v = localStorage.getItem(FACE_KEY);
    return v === "user" || v === "environment" ? v : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Camera scanner. Keeps scanning until closed; the same code is ignored for 1.5 s so one scan = one count.
 * 可切換前／後鏡頭（例：LINE Pay 讓客人把手機付款碼對著平板前鏡頭），每台裝置記住上次的選擇。
 */
export function CameraScanner({ onCode, onClose, continuous = false, face: defaultFace = "environment", rememberKey = FACE_KEY }: { onCode: (code: string) => void; onClose: () => void; continuous?: boolean; face?: "environment" | "user"; rememberKey?: string }) {
  const [face, setFace] = useState<"environment" | "user">(() => (rememberKey === FACE_KEY ? readFace(defaultFace) : (() => {
    try {
      const v = localStorage.getItem(rememberKey);
      return v === "user" || v === "environment" ? v : defaultFace;
    } catch {
      return defaultFace;
    }
  })()));
  const flip = () => {
    const n = face === "user" ? "environment" : "user";
    try {
      localStorage.setItem(rememberKey, n);
    } catch {
      /* ignore */
    }
    setFace(n);
  };
  const regionId = useRef(`cam-${Math.random().toString(36).slice(2)}`).current;
  const [error, setError] = useState("");
  const last = useRef({ code: "", at: 0 });
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    const scanner = new Html5Qrcode(`${regionId}-${face}`, { formatsToSupport: FORMATS, verbose: false });
    let stopped = false;
    scanner
      .start(
        { facingMode: face },
        { fps: 10, qrbox: (w, h) => ({ width: Math.min(w, h, 320) * 0.9, height: Math.min(w, h, 320) * 0.9 }) },
        (text) => {
          const now = Date.now();
          if (text === last.current.code && now - last.current.at < 1500) return;
          last.current = { code: text, at: now };
          cb.current(text);
          if (!continuous) onClose();
        },
        () => undefined
      )
      .catch((e) => setError(`無法開啟相機：${e?.message ?? e}（需 HTTPS 並允許相機權限）`));
    return () => {
      if (stopped) return;
      stopped = true;
      if (scanner.isScanning) scanner.stop().then(() => scanner.clear()).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face]);

  return (
    <Modal title={continuous ? "相機掃描（連續）" : "相機掃描"} onClose={onClose}>
      <div key={face} id={`${regionId}-${face}`} className={`camera-region ${face === "user" ? "mirror" : ""}`} />
      <button className="btn btn-sm" onClick={flip}>
        🔄 切換成{face === "user" ? "後" : "前"}鏡頭
      </button>
      {error ? <p className="error">{error}</p> : <p className="muted center">把 QR code 或條碼放進框內{continuous ? "，可連續掃" : ""}</p>}
    </Modal>
  );
}

export interface ScanInputHandle {
  focus: () => void;
}

/**
 * Text box that takes a barcode-gun scan (types the code + Enter), manual typing, or the camera.
 */
export const ScanInput = forwardRef<ScanInputHandle, { onCode: (code: string) => void; placeholder?: string; continuousCamera?: boolean; autoFocus?: boolean; disabled?: boolean }>(
  function ScanInput({ onCode, placeholder = "掃描或輸入條碼 / 商品編號", continuousCamera = false, autoFocus = true, disabled }, ref) {
    const [text, setText] = useState("");
    const [camera, setCamera] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

    const submit = () => {
      const code = text.trim();
      if (!code) return;
      setText("");
      onCode(code);
    };
    return (
      <div className="scan-input">
        <input
          ref={input}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          inputMode="text"
          autoComplete="off"
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="btn" onClick={submit} disabled={disabled || !text.trim()}>
          確定
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setCamera(true)} disabled={disabled}>
          📷 相機
        </button>
        {camera && (
          <CameraScanner
            continuous={continuousCamera}
            onCode={onCode}
            onClose={() => {
              setCamera(false);
              setTimeout(() => input.current?.focus(), 50);
            }}
          />
        )}
      </div>
    );
  }
);
