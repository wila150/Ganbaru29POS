import { useEffect, useState } from "react";
import { Modal } from "./ui";

export function Keypad({ value, onChange, allowDot = false }: { value: string; onChange: (v: string) => void; allowDot?: boolean }) {
  const press = (k: string) => {
    if (k === "C") return onChange("");
    if (k === "⌫") return onChange(value.slice(0, -1));
    if (k === "." && (!allowDot || value.includes("."))) return;
    if (k === "00" && !value) return;
    onChange((value === "0" && k !== "." ? "" : value) + k);
  };
  const keys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", allowDot ? "." : "00", "0", "⌫"];
  return (
    <div className="keypad">
      {keys.map((k) => (
        <button key={k} type="button" onClick={() => press(k)}>
          {k}
        </button>
      ))}
      <button type="button" className="keypad-clear" onClick={() => press("C")}>
        清除
      </button>
    </div>
  );
}

/** A small dialog: a label, the number being typed, the keypad. Physical keyboard works too. */
export function KeypadDialog({ title, initial = "", suffix, allowDot, hint, onClose, onOk }: { title: string; initial?: string; suffix?: string; allowDot?: boolean; hint?: string; onClose: () => void; onOk: (n: number) => void }) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key) || (allowDot && e.key === ".")) setV((x) => x + e.key);
      else if (e.key === "Backspace") setV((x) => x.slice(0, -1));
      else if (e.key === "Enter") ok();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const ok = () => {
    onOk(Number(v) || 0);
    onClose();
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button className="btn btn-primary btn-lg block" onClick={ok}>
          確定
        </button>
      }
    >
      <div className="keypad-display">
        {v || "0"}
        {suffix && <small>{suffix}</small>}
      </div>
      {hint && <p className="muted small center">{hint}</p>}
      <Keypad value={v} onChange={setV} allowDot={allowDot} />
    </Modal>
  );
}
