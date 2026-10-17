import { useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth";
import { call } from "../firebase";
import { ROLE_LABEL, type Role } from "../lib/util";

export function Login() {
  const { user, profile, login, logout, loading } = useAuth();
  const loc = useLocation();
  const [err, setErr] = useState("");
  if (loading) return <div className="loading">載入中…</div>;
  if (profile?.active) return <Navigate to={(loc.state as { from?: string })?.from || "/admin/scan"} replace />;
  return (
    <div className="login">
      <div className="login-card">
        <div className="brand brand-lg">
          <span className="brand-mark">29</span>
          <div>
            <strong>ganbaru29</strong>
            <small>庫存＋POS 系統</small>
          </div>
        </div>
        {user ? (
          <>
            <p>
              {user.email} {profile && !profile.active ? "已被停用。" : "還沒有被加入系統。"}
            </p>
            <p className="muted">請老闆在「設定 → 員工管理」寄邀請連結給你，打開連結後再登入。</p>
            <button className="btn" onClick={logout}>
              換一個帳號
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => login().catch((e) => setErr(e.message))}
            >
              用 Google 帳號登入
            </button>
            {err && <p className="error">{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** /invite/:id — open the link, sign in with Google, done. */
export function AcceptInvite() {
  const { id } = useParams();
  const { user, profile, login, logout } = useAuth();
  const nav = useNavigate();
  const [state, setState] = useState<{ busy?: boolean; err?: string; role?: Role }>({});

  const accept = async () => {
    setState({ busy: true });
    try {
      const r = await call<{ role: Role }>("acceptInvite", { id });
      await user?.getIdToken(true);
      setState({ role: r.role });
      setTimeout(() => nav("/admin/scan", { replace: true }), 1200);
    } catch (e) {
      setState({ err: (e as Error).message });
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <h1>加入 ganbaru29</h1>
        {state.role ? (
          <p className="ok">已加入，你的角色是「{ROLE_LABEL[state.role]}」。</p>
        ) : !user ? (
          <>
            <p>請用收到邀請的 Google 帳號登入。</p>
            <button className="btn btn-primary btn-lg" onClick={() => login().catch((e) => setState({ err: e.message }))}>
              用 Google 帳號登入
            </button>
          </>
        ) : profile?.active ? (
          <>
            <p>{user.email} 已經是系統成員。</p>
            <button className="btn btn-primary" onClick={() => nav("/admin/scan")}>
              進入系統
            </button>
          </>
        ) : (
          <>
            <p>
              以 <strong>{user.email}</strong> 接受邀請
            </p>
            <button className="btn btn-primary btn-lg" disabled={state.busy} onClick={accept}>
              {state.busy ? "處理中…" : "接受邀請"}
            </button>
            <button className="btn btn-ghost" onClick={logout}>
              換一個帳號
            </button>
          </>
        )}
        {state.err && <p className="error">{state.err}</p>}
      </div>
    </div>
  );
}
