import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useData } from "../data";
import { db } from "../firebase";
import { displayChannel, setSignup, type DisplayState, type SignupState } from "../lib/display";
import { useDeviceLocation } from "../lib/location";
import { money, PAY_LABEL } from "../lib/util";

/** 顧客螢幕（平板放在櫃台面向客人）：跟著收銀電腦即時顯示 */
export function Display() {
  return (
    <>
      <Screen />
      <Signup />
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
              <div className="cd-amt">
                {l.orig != null && <s className="muted">{money(l.orig)}</s>}
                <b>{money(l.amount)}</b>
                {l.promo && <div className="cd-promo">{l.promo}</div>}
              </div>
            </li>
          ))}
        </ul>
        <div className="cd-total">
          {s.summary && <Breakdown x={s.summary} totalOff={s.discount ?? 0} />}
          <div>
            {(s.discount ?? 0) > 0 ? "折抵後" : "應付"} <b>{money(s.total ?? 0)}</b>
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

function Breakdown({ x, totalOff }: { x: NonNullable<DisplayState["summary"]>; totalOff: number }) {
  if (!x.rows?.length) return null;
  return (
    <div className="cd-break">
      <div>
        <span>商品原價</span>
        <span>{money(x.gross)}</span>
      </div>
      {x.rows.map((r, i) => (
        <div key={i}>
          <span>{r.label}</span>
          <span className={r.amount < 0 ? "cd-minus" : ""}>{r.amount < 0 ? `−${money(-r.amount)}` : `＋${money(r.amount)}`}</span>
        </div>
      ))}
      {totalOff > 0 && (
        <div className="cd-off">
          <span>總折扣</span>
          <span>−{money(totalOff)}</span>
        </div>
      )}
    </div>
  );
}

/** 收銀電腦按「請客人在顧客螢幕填寫」→ 這裡跳出加入會員表單；送出後由收銀電腦建立會員，成功後表單自動消失 */
function Signup() {
  const { locationId } = useDeviceLocation();
  const ch = displayChannel(locationId);
  const [s, setS] = useState<SignupState | null>(null);
  const [f, setF] = useState({ email: "", name: "", mobile: "", birthDate: "" });
  const [err, setErr] = useState("");
  useEffect(
    () =>
      onSnapshot(doc(db, "customerSignup", ch), (d) => {
        const x = (d.data() as SignupState) ?? null;
        setS(x);
        // 店員先填了一部分、或建立失敗退回來：帶入目前的資料
        if (x?.status === "open") setF({ email: x.email ?? "", name: x.name ?? "", mobile: x.mobile ?? "", birthDate: x.birthDate ?? "" });
      }),
    [ch]
  );
  // 成功畫面 4 秒後自己關掉
  useEffect(() => {
    if (s?.status !== "done") return;
    const id = setTimeout(() => setSignup(ch, { status: "closed" }).catch(() => undefined), 4000);
    return () => clearTimeout(id);
  }, [s?.status, ch]);
  if (!s || s.status === "closed") return null;
  if (s.status === "done")
    return (
      <div className="cd cd-center cd-over">
        <div className="cd-big">🎉 加入成功</div>
        <div className="cd-sub">{s.name ? `${s.name}，` : ""}歡迎成為會員！</div>
      </div>
    );
  if (s.status === "filled")
    return (
      <div className="cd cd-center cd-over">
        <div className="cd-sub">資料已送出，請稍候…</div>
      </div>
    );
  const send = () => {
    const email = f.email.trim();
    const mobile = f.mobile.replace(/\D/g, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr("請填正確的 Email");
    if (!f.name.trim()) return setErr("請填姓名");
    if (!/^09\d{8}$/.test(mobile)) return setErr("手機請填 09 開頭 10 碼");
    if (!f.birthDate) return setErr("請選生日");
    setErr("");
    setSignup(ch, { status: "filled", email, name: f.name.trim(), mobile, birthDate: f.birthDate }).catch(() => setErr("送出失敗，請再按一次"));
  };
  return (
    <div className="cd cd-over cd-signup">
      <h1>加入會員</h1>
      <p className="muted">填寫後即可累積購物金、享會員優惠</p>
      <label>
        Email
        <input type="email" inputMode="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </label>
      <label>
        姓名
        <input autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <label>
        手機
        <input inputMode="tel" autoComplete="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
      </label>
      <label>
        生日
        <input type="date" max={new Date().toISOString().slice(0, 10)} value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
      </label>
      {(err || s.error) && <p className="cd-err">{err || s.error}</p>}
      <button className="cd-send" onClick={send}>
        送出
      </button>
    </div>
  );
}
