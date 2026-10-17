import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";
import { useData } from "../data";
import { atLeast, fmtTime, ROLE_LABEL, type Role } from "../lib/util";
import { LocationSelect } from "./LocationSelect";
import { LogoutButton } from "./LogoutButton";

const ADMIN_NAV: { to: string; label: string; icon: string; min: Role }[] = [
  { to: "/admin/scan", label: "進貨掃碼", icon: "⌁", min: "staff" },
  { to: "/admin/inventory", label: "庫存查詢", icon: "▤", min: "staff" },
  { to: "/admin/stocktake", label: "盤點", icon: "✓", min: "staff" },
  { to: "/admin/transfers", label: "調貨", icon: "⇄", min: "staff" },
  { to: "/admin/members", label: "顧客管理", icon: "☺", min: "staff" },
  { to: "/admin/products", label: "商品與條碼", icon: "▦", min: "manager" },
  { to: "/admin/promotions", label: "促銷活動", icon: "%", min: "manager" },
  { to: "/admin/movements", label: "異動紀錄", icon: "≡", min: "manager" },
  { to: "/admin/reports", label: "報表", icon: "◔", min: "manager" },
  { to: "/admin/expenses", label: "開支", icon: "$", min: "manager" },
  { to: "/admin/attendance", label: "打卡", icon: "◷", min: "staff" },
  { to: "/admin/settings", label: "設定", icon: "⚙", min: "owner" },
];

export function AdminLayout() {
  const { profile } = useAuth();
  const { settings, ready } = useData();
  const nav = ADMIN_NAV.filter((n) => atLeast(profile?.role, n.min));
  return (
    <div className="admin">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">29</span>
          <div>
            <strong>{settings.shopName || "ganbaru29"}</strong>
            <small>庫存後台</small>
          </div>
        </div>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className="nav-item">
              <span className="nav-icon" aria-hidden>
                {n.icon}
              </span>
              {n.label}
            </NavLink>
          ))}
          <NavLink to="/pos" className="nav-item nav-pos">
            <span className="nav-icon" aria-hidden>
              ¤
            </span>
            POS 收銀
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <LocationSelect />
          <div>
            {profile?.name} · {profile && ROLE_LABEL[profile.role]}
          </div>
          <small className="muted">商品同步：{fmtTime(settings.lastIncrementalSyncAt ?? settings.lastCatalogSyncAt)}</small>
          <LogoutButton className="btn btn-ghost btn-sm">登出</LogoutButton>
        </div>
      </aside>
      <main className="admin-main">{ready ? <Outlet /> : <div className="loading">載入商品資料…</div>}</main>
      <nav className="bottom-nav">
        {nav.slice(0, 4).map((n) => (
          <NavLink key={n.to} to={n.to} className="bottom-item">
            <span aria-hidden>{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
        <NavLink to="/admin/more" className="bottom-item">
          <span aria-hidden>⋯</span>更多
        </NavLink>
      </nav>
    </div>
  );
}

/** Phone "more" menu: everything that doesn't fit the bottom bar. */
export function MoreMenu() {
  const { profile } = useAuth();
  const nav = ADMIN_NAV.filter((n) => atLeast(profile?.role, n.min)).slice(4);
  return (
    <div className="page">
      <h1>更多</h1>
      <LocationSelect />
      <div className="list-menu">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} className="list-menu-item">
            {n.icon} {n.label}
          </NavLink>
        ))}
        <NavLink to="/pos" className="list-menu-item">
          ¤ POS 收銀
        </NavLink>
        <LogoutButton className="list-menu-item">⎋ 登出（{profile?.name}）</LogoutButton>
      </div>
    </div>
  );
}
