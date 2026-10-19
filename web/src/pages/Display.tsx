import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QrImg } from "../components/QrImg";
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
    const parts: { method: string; amount: number; url?: string }[] = s.pay.parts?.length ? s.pay.parts : [{ method: s.pay.method, amount: s.pay.amount, url: s.pay.url }];
    const cashIn = parts.filter((p) => p.method === "cash").reduce((a, p) => a + p.amount, 0);
    const others = parts.filter((p) => p.method !== "cash");
    const qrOf = (m: string) => (m === "transfer" ? pd.transferQrUrl : m === "linepay" ? pd.linepayQrUrl : null);
    const hintOf = (m: string, amt: number) =>
      m === "online" ? "用手機相機掃描 QR，刷卡或 Apple Pay 付款" : m === "linepay" ? `用 LINE 掃描 QR，輸入 ${money(amt)}` : m === "transfer" ? `用銀行 App 掃描 QR 轉帳 ${money(amt)}` : m === "card" ? "請將信用卡交給店員刷卡" : `請以 ${PAY_LABEL[m] ?? m} 付款`;
    return (
      <div className="cd cd-pay" onClick={full}>
        <header className="cd-bar">
          <b>{shop}</b>
          <span>本次消費 {money(s.total ?? 0)}</span>
        </header>
        {(cashIn > 0 || others.length > 1) && (
          <div className="cd-paysum">
            {cashIn > 0 && <span>現金已收 {money(cashIn)}</span>}
            <span>其他支付 {others.map((p) => `${PAY_LABEL[p.method] ?? p.method} ${money(p.amount)}`).join("＋")}</span>
          </div>
        )}
        <div className={`cd-paycards n${Math.min(others.length, 3)}`}>
          {others.map((p, i) => {
            const qr = qrOf(p.method);
            return (
              <section key={i} className="cd-card cd-paycard">
                <div className="cd-pay-m">{p.method === "online" ? "線上刷卡" : PAY_LABEL[p.method] ?? p.method}</div>
                <div className="cd-amount">{money(p.amount)}</div>
                {p.url ? <div className="cd-qr"><QrImg value={p.url} size={320} /></div> : qr ? <img className="cd-qr" src={qr} alt="" /> : p.method === "card" ? <div className="cd-cardicon">💳</div> : null}
                {p.method === "transfer" && !qr && (pd.transferBank || pd.transferAccount) && (
                  <div className="cd-bank">
                    {pd.transferBank && <div>銀行　<b>{pd.transferBank}</b></div>}
                    {pd.transferAccount && <div>帳號　<b className="mono">{pd.transferAccount}</b></div>}
                    {pd.transferName && <div>戶名　<b>{pd.transferName}</b></div>}
                  </div>
                )}
                <div className="cd-hint">{hintOf(p.method, p.amount)}</div>
              </section>
            );
          })}
        </div>
        <div className="cd-hint center">付款完成後請出示畫面給店員確認</div>
      </div>
    );
  }
  if (s.mode === "cart" && s.lines?.length) {
    const qty = s.lines.reduce((a, l) => a + l.qty, 0);
    return (
      <div className="cd cd-cart" onClick={full}>
        <header className="cd-bar">
          <b>{shop}</b>
          <span>{s.member ? `會員　${s.member}` : "非會員"}</span>
        </header>
        <div className="cd-cols">
          <section className="cd-card cd-list">
            <div className="cd-list-head">
              <span>品項</span>
              <span>共 {qty} 件</span>
            </div>
            <ul className="cd-lines">
              {s.lines.map((l, i) => (
                <li key={i}>
                  <div className="cd-item">
                    <div className="cd-title">{l.title}</div>
                    <div className="cd-opt">
                      {l.options || "單一規格"}　× {l.qty}
                    </div>
                    {l.promo && <span className="cd-chip">{l.promo}</span>}
                  </div>
                  <div className="cd-amt">
                    {l.orig != null && <s>{money(l.orig)}</s>}
                    <b>{money(l.amount)}</b>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="cd-card cd-sum">
            <Breakdown x={s.summary ?? { gross: s.total ?? 0, rows: [] }} totalOff={s.discount ?? 0} />
            <div className="cd-due">
              <span>{(s.discount ?? 0) > 0 ? "折抵後應付" : "應付金額"}</span>
              <b>{money(s.total ?? 0)}</b>
            </div>
          </section>
        </div>
      </div>
    );
  }
  return (
    <div className="cd cd-center" onClick={full}>
      <div className="cd-big">歡迎光臨</div>
      <div className="cd-shop">{shop}</div>
      <div className="cd-hint muted">（點一下畫面可全螢幕）</div>
    </div>
  );
}

function Breakdown({ x, totalOff }: { x: NonNullable<DisplayState["summary"]>; totalOff: number }) {
  return (
    <div className="cd-break">
      <div>
        <span>商品原價</span>
        <span>{money(x.gross)}</span>
      </div>
      {(x.rows ?? []).map((r, i) => (
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
  const [confirming, setConfirming] = useState(false);
  const [region, setRegion] = useState<Region>(REGIONS[0]);
  useEffect(
    () =>
      onSnapshot(doc(db, "customerSignup", ch), (d) => {
        const x = (d.data() as SignupState) ?? null;
        setS(x);
        // 店員先填了一部分、或建立失敗退回來：帶入目前的資料
        if (x?.status === "open") setConfirming(false);
        if (x?.status === "open") {
          const sm = splitMobile(x.mobile ?? "");
          if (x.mobile) setRegion(sm.region);
          setF({ email: x.email ?? "", name: x.name ?? "", mobile: x.mobile ? sm.local : "", birthDate: x.birthDate ?? "" });
        }
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
  if (s.status === "phone" || s.status === "phoneSent") return <PhoneEntry ch={ch} s={s} />;
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
    let mobile = f.mobile.replace(/\D/g, "");
    let rg = region;
    // 自動偵測：打了 852／853／886 開頭
    const cc = /^(852|853)(\d{8})$/.exec(mobile);
    if (cc) {
      rg = REGIONS.find((r) => r.cc === `+${cc[1]}`)!;
      mobile = cc[2];
      setRegion(rg);
    } else if (rg.id === "tw") mobile = mobile.replace(/^(886|0)?9(?=\d{8}$)/, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setErr("請填正確的 Email");
    if (!f.name.trim()) return setErr("請填姓名");
    if (!rg.re.test(mobile)) return setErr(rg.id === "tw" ? "請填 09 後面的 8 碼" : `${rg.label} 手機請填 8 碼`);
    if (!f.birthDate) return setErr("請選生日");
    setErr("");
    setF({ email, name: f.name.trim(), mobile, birthDate: f.birthDate });
    setConfirming(true);
  };
  const confirmSend = () => setSignup(ch, { status: "filled", ...f, mobile: region.cc + f.mobile }).catch(() => (setConfirming(false), setErr("送出失敗，請再按一次")));
  if (confirming)
    return (
      <div className="cd cd-over cd-signup">
        <h1>請確認資料</h1>
        <div className="cd-confirm">
          <div><span>Email</span><b>{f.email}</b></div>
          <div><span>姓名</span><b>{f.name}</b></div>
          <div><span>手機</span><b>{region.id === "tw" ? "09" : `${region.cc.replace("+", "")} `}{f.mobile}</b></div>
          <div><span>生日</span><b>{f.birthDate.replace(/-/g, " / ")}</b></div>
        </div>
        <div className="cd-confirm-btns">
          <button className="cd-back" onClick={() => setConfirming(false)}>
            修改
          </button>
          <button className="cd-send" onClick={confirmSend}>
            確認送出
          </button>
        </div>
      </div>
    );
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
        <RegionTabs value={region} onChange={setRegion} />
        <div className="cd-tel">
          <span>{region.cc.replace("+", "")}</span>
          <input inputMode="tel" autoComplete="tel" placeholder={region.hint} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
        </div>
      </label>
      <label>
        生日
        <input type="date" max={new Date().toISOString().slice(0, 10)} value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
      </label>
      {(err || s.error) && <p className="cd-err">{err || s.error}</p>}
      <button className="cd-send" onClick={send}>
        下一步
      </button>
    </div>
  );
}

/** 手機地區：台灣 09 開頭 10 碼；香港、澳門 8 碼，存成 +852／+853 開頭 */
const REGIONS = [
  // 台灣：09 固定，客人只打後面 8 碼
  { id: "tw", label: "🇹🇼 台灣", cc: "09", re: /^\d{8}$/, hint: "xx xxx xxx", max: 8 },
  { id: "hk", label: "🇭🇰 香港", cc: "+852", re: /^[4-9]\d{7}$/, hint: "xxxx xxxx", max: 8 },
  { id: "mo", label: "🇲🇴 澳門", cc: "+853", re: /^6\d{7}$/, hint: "6xxx xxxx", max: 8 },
] as const;
type Region = (typeof REGIONS)[number];
const splitMobile = (m: string): { region: Region; local: string } => {
  const d = m.replace(/[^\d+]/g, "");
  for (const r of REGIONS) if (r.cc !== "09" && d.startsWith(r.cc)) return { region: r, local: d.slice(r.cc.length) };
  return { region: REGIONS[0], local: d.replace(/\D/g, "").replace(/^09/, "") };
};

function RegionTabs({ value, onChange }: { value: Region; onChange: (r: Region) => void }) {
  return (
    <div className="cd-regions">
      {REGIONS.map((r) => (
        <button key={r.id} className={r.id === value.id ? "on" : ""} onClick={() => onChange(r)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** 客人自己輸入手機查會員（收銀電腦打開「會員」時出現） */
function PhoneEntry({ ch, s }: { ch: string; s: SignupState }) {
  const [v, setV] = useState("");
  const [region, setRegion] = useState<Region>(REGIONS[0]);
  useEffect(() => {
    if (s.status === "phone" && s.error && s.mobile) {
      const x = splitMobile(s.mobile);
      setRegion(x.region);
      setV(x.local);
    } else setV("");
  }, [s.status, s.error, s.mobile]);
  if (s.status === "phoneSent")
    return (
      <div className="cd cd-center cd-over">
        <div className="cd-sub">查詢中，請稍候…</div>
      </div>
    );
  const ok = region.re.test(v);
  const press = (k: string) => {
    if (k === "del") return setV((x) => x.slice(0, -1));
    if (k === "clr") return setV("");
    const next = v + k;
    // 自動偵測：台灣模式下打 852／853 → 切成香港／澳門；打 886 → 換成 0
    if (region.id === "tw" && (next === "852" || next === "853")) {
      setRegion(REGIONS.find((r) => r.cc === `+${next}`)!);
      return setV("");
    }
    if (next.length <= region.max) setV(next);
  };
  return (
    <div className="cd cd-over cd-phone">
      <h1>請輸入會員手機</h1>
      <RegionTabs value={region} onChange={(r) => (setRegion(r), setV(""))} />
      <div className="cd-phone-num">
        <span className={region.id === "tw" ? "" : "muted"}>{region.cc.replace("+", "")}</span>
        {region.id === "tw" ? "" : " "}
        {v ? (region.id === "tw" ? v.replace(/^(\d{2})(\d{0,3})(\d{0,3}).*/, (_, a, b, c) => [a, b, c].filter(Boolean).join(" ")) : v.replace(/^(\d{4})(\d{0,4}).*/, (_, a, b) => [a, b].filter(Boolean).join(" "))) : <span className="muted">{region.hint}</span>}
      </div>
      {s.error && <p className="cd-err">{s.error}</p>}
      <div className="cd-pad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "clr", "0", "del"].map((k) => (
          <button key={k} className={k.length > 1 ? "fn" : ""} onClick={() => press(k)}>
            {k === "del" ? "⌫" : k === "clr" ? "清除" : k}
          </button>
        ))}
      </div>
      <button className="cd-send" disabled={!ok} onClick={() => setSignup(ch, { status: "phoneSent", mobile: region.cc + v }).catch(() => undefined)}>
        確定
      </button>
    </div>
  );
}
