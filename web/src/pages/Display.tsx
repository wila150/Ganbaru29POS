import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useData } from "../data";
import { db } from "../firebase";
import { displayChannel, type DisplayState } from "../lib/display";
import { useDeviceLocation } from "../lib/location";
import { money, PAY_LABEL } from "../lib/util";

/** 顧客螢幕（平板放在櫃台面向客人）：跟著收銀電腦即時顯示 */
export function Display() {
  return (
    <>
      <Screen />
      <Link to="/pos" className="cd-exit">
        返回 POS
      </Link>
    </>
  );
}

function Screen() {
  const { settings } = useData();
  const { locationId: loc } = useDeviceLocation();
  const [s, setS] = useState<DisplayState>({ mode: "idle" });
  useEffect(() => onSnapshot(doc(db, "customerDisplay", displayChannel(loc)), (d) => setS((d.data() as DisplayState) ?? { mode: "idle" })), [loc]);
  // 螢幕不要自動變暗
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, []);
  const pd = settings.payDisplay ?? {};
  const shop = settings.shopName || "ganbaru29";
  const full = () => document.documentElement.requestFullscreen?.().catch(() => undefined);

  if (s.mode === "done")
    return (
      <div className="cd cd-center" onClick={full}>
        <div className="cd-big">謝謝光臨 🙏</div>
        {(s.change ?? 0) > 0 && <div className="cd-sub">找零 {money(s.change!)}</div>}
        <div className="cd-shop">{shop}</div>
      </div>
    );
  if (s.mode === "pay" && s.pay) {
    const m = s.pay.method;
    const qr = m === "transfer" ? pd.transferQrUrl : m === "linepay" ? pd.linepayQrUrl : null;
    return (
      <div className="cd cd-center" onClick={full}>
        <div className="cd-sub">請以 {PAY_LABEL[m] ?? m} 付款</div>
        <div className="cd-amount">{money(s.pay.amount)}</div>
        {qr && <img className="cd-qr" src={qr} alt="" />}
        {m === "transfer" && (pd.transferBank || pd.transferAccount) && (
          <div className="cd-bank">
            {pd.transferBank && <div>銀行　<b>{pd.transferBank}</b></div>}
            {pd.transferAccount && <div>帳號　<b className="mono">{pd.transferAccount}</b></div>}
            {pd.transferName && <div>戶名　<b>{pd.transferName}</b></div>}
          </div>
        )}
        {m === "linepay" && <div className="cd-hint">請用 LINE 掃描上方 QR code，輸入金額 {money(s.pay.amount)}</div>}
        {m === "transfer" && <div className="cd-hint">轉帳完成後請把畫面給店員確認</div>}
        {(s.total ?? 0) !== s.pay.amount && <div className="cd-hint muted">本次消費 {money(s.total ?? 0)}，其餘以其他方式付款</div>}
      </div>
    );
  }
  if (s.mode === "cart" && s.lines?.length)
    return (
      <div className="cd cd-cart" onClick={full}>
        <div className="cd-head">
          <span>{shop}</span>
          {s.member && <span>會員：{s.member}</span>}
        </div>
        <ul className="cd-lines">
          {s.lines.map((l, i) => (
            <li key={i}>
              <div>
                <div className="cd-title">{l.title}</div>
                <div className="muted">{l.options} × {l.qty}</div>
              </div>
              <b>{money(l.amount)}</b>
            </li>
          ))}
        </ul>
        <div className="cd-total">
          {(s.discount ?? 0) > 0 && <div className="cd-disc">已折 {money(s.discount!)}</div>}
          <div>
            合計 <b>{money(s.total ?? 0)}</b>
          </div>
        </div>
      </div>
    );
  return (
    <div className="cd cd-center" onClick={full}>
      <div className="cd-big">歡迎光臨</div>
      <div className="cd-shop">{shop}</div>
      <div className="cd-hint muted">（點一下畫面可全螢幕）</div>
    </div>
  );
}
