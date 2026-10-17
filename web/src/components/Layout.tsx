import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { useData } from "../data";
import { atLeast, fmtTime, ROLE_LABEL, type Role } from "../lib/util";
import { LocationSelect } from "./LocationSelect";
import { LogoutButton } from "./LogoutButton";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  min: Role;
  /** 有子項目 = 側邊欄下拉選單 */
  children?: { to: string; label: string; min: Role }[];
}

const ADMIN_NAV: NavItem[] = [
  { to: "/admin/scan", label: "進貨掃碼", icon: "⌁", min: "staff" },
  { to: "/admin/inventory", label: "庫存查詢", icon: "▤", min: "staff" },
  { to: "/admin/stocktake", label: "盤點", icon: "✓", min: "staff" },
  { to: "/admin/transfers", label: "調貨", icon: "⇄", min: "staff" },
  { to: "/admin/products", label: "商品與條碼", icon: "▦", min: "manager" },
  {
    to: "/admin/members",
    label: "顧客管理",
    icon: "☺",
    min: "staff",
    children: [
      { to: "/admin/members", label: "顧客名單", min: "staff" },
      { to: "/admin/member-rules", label: "會員等級", min: "owner" },
    ],
  },
  {
    to: "/admin/promotions",
    label: "行銷",
    icon: "%",
    min: "manager",
    children: [
      { to: "/admin/promotions", label: "促銷活動", min: "manager" },
      { to: "/admin/rewards", label: "購物金回饋", min: "owner" },
    ],
  },
  { to: "/admin/movements", label: "異動紀錄", icon: "≡", min: "manager" },
  {
    to: "/admin/reports",
    label: "報表",
    icon: "◔",
    min: "manager",
    children: [
      { to: "/admin/reports", label: "報表中心", min: "manager" },
      { to: "/admin/expenses", label: "開支", min: "manager" },
    ],
  },
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
          {nav.map((n) => {
            const kids = n.children?.filter((c) => atLeast(profile?.role, c.min));
            return kids && kids.length > 1 ? (
              <NavGroup key={n.to} item={n} kids={kids} />
            ) : (
              <NavLink key={n.to} to={kids?.[0]?.to ?? n.to} className="nav-item">
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                {kids?.length === 1 && n.label === "行銷" ? kids[0].label : n.label}
              </NavLink>
            );
          })}
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
  const nav = ADMIN_NAV.filter((n) => atLeast(profile?.role, n.min))
    .flatMap((n) => (n.children ? n.children.filter((c) => atLeast(profile?.role, c.min)).map((c) => ({ ...n, to: c.to, label: c.label })) : [n]))
    .slice(4);
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

/** 側邊欄下拉：點標題展開／收合，所在頁面屬於這一組時自動展開 */
function NavGroup({ item, kids }: { item: NavItem; kids: { to: string; label: string }[] }) {
  const loc = useLocation();
  const inside = kids.some((k) => loc.pathname.startsWith(k.to));
  const [open, setOpen] = useState(inside);
  const expanded = open || inside;
  return (
    <div className={`nav-group ${expanded ? "open" : ""}`}>
      <button type="button" className={`nav-item nav-group-head ${inside ? "inside" : ""}`} onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span className="nav-icon" aria-hidden>
          {item.icon}
        </span>
        {item.label}
        <span className="nav-caret" aria-hidden>
          ▾
        </span>
      </button>
      {expanded &&
        kids.map((k) => (
          <NavLink key={k.to} to={k.to} end className="nav-item nav-sub">
            {k.label}
          </NavLink>
        ))}
    </div>
  );
}
