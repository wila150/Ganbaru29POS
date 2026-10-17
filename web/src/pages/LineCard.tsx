import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { call } from "../firebase";

/* LIFF SDK（LINE 官方提供） */
interface Liff {
  init(o: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(o?: { redirectUri?: string }): void;
  getIDToken(): string | null;
  isInClient(): boolean;
}
declare global {
  interface Window {
    liff?: Liff;
  }
}
function loadLiff(): Promise<Liff> {
  if (window.liff) return Promise.resolve(window.liff);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    s.onload = () => (window.liff ? resolve(window.liff) : reject(new Error("LINE SDK 載入失敗")));
    s.onerror = () => reject(new Error("LINE SDK 載入失敗，請檢查網路"));
    document.head.appendChild(s);
  });
}

/** /line：LINE 官方帳號圖文選單的「會員卡」。LINE 登入 → 已綁定直接顯示會員卡，否則綁定或註冊。 */
export function LineCard() {
  const nav = useNavigate();
  const [state, setState] = useState<"loading" | "bind" | "error">("loading");
  const [err, setErr] = useState("");
  const [idToken, setIdToken] = useState("");
  const [lineName, setLineName] = useState("");
  const [shopName, setShopName] = useState("ganbaru29");
  const [mode, setMode] = useState<"bind" | "register">("bind");
  const [f, setF] = useState({ mobile: "", email: "", name: "", birthDate: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await call<{ liffId: string | null; shopName: string }>("lineConfig");
        setShopName(cfg.shopName);
        if (!cfg.liffId) throw new Error("店家尚未設定 LINE 會員卡");
        const liff = await loadLiff();
        await liff.init({ liffId: cfg.liffId });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return;
        }
        const token = liff.getIDToken();
        if (!token) throw new Error("無法取得 LINE 登入資訊，請關閉後重新開啟");
        setIdToken(token);
        const r = await call<{ bound: boolean; token?: string; lineName?: string }>("lineMemberCard", { idToken: token });
        if (r.bound && r.token) nav(`/card/${r.token}`, { replace: true });
        else {
          setLineName(r.lineName ?? "");
          setF((x) => ({ ...x, name: r.lineName ?? "" }));
          setState("bind");
        }
      } catch (e) {
        setErr((e as Error).message);
        setState("error");
      }
    })();
  }, [nav]);

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await call<{ token: string }>(mode === "bind" ? "lineBindMember" : "lineRegisterMember", { idToken, ...f });
      nav(`/card/${r.token}`, { replace: true });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="member-card-page">
      <div className="member-card">
        <div className="mc-shop">{shopName}</div>
        {state === "loading" && <p className="muted">LINE 登入中…</p>}
        {state === "error" && <p className="error">{err}</p>}
        {state === "bind" && (
          <>
            <div className="mc-name">{lineName ? `${lineName}，歡迎！` : "歡迎！"}</div>
            <div className="segmented">
              <button className={mode === "bind" ? "active" : ""} onClick={() => setMode("bind")}>
                我已經是會員
              </button>
              <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
                註冊新會員
              </button>
            </div>
            <p className="mc-hint">{mode === "bind" ? "請輸入註冊網店時用的手機和 Email，兩個都正確才會綁定。" : "填寫後會建立網店會員，之後網店和門市共用購物金。"}</p>
            {mode === "register" && <input placeholder="姓名" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
            {mode === "register" && (
              <label className="small muted">
                生日
                <input type="date" max={new Date().toISOString().slice(0, 10)} value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
              </label>
            )}
            <input placeholder="手機號碼" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
            <input placeholder="Email" type="email" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            {err && <p className="error small">{err}</p>}
            <button className="btn btn-primary btn-lg block" disabled={busy || !f.mobile || !f.email || (mode === "register" && !f.birthDate)} onClick={submit}>
              {busy ? "處理中…" : mode === "bind" ? "綁定並顯示會員卡" : "註冊並顯示會員卡"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
