import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../auth";
import { useData } from "../../data";
import { db } from "../../firebase";
import { LocationSelect } from "../../components/LocationSelect";
import { useDeviceLocation } from "../../lib/location";
import { ROLE_LABEL, todayStr } from "../../lib/util";

const MENU = [
  { to: "/pos", label: "收銀", icon: "¤", end: true },
  { to: "/pos/holds", label: "訂單", icon: "▣" },
  { to: "/pos/online", label: "線上訂單", icon: "⇅" },
  { to: "/pos/drawer", label: "錢櫃", icon: "▭" },
  { to: "/pos/close", label: "日結", icon: "✓" },
  { to: "/pos/transactions", label: "交易瀏覽", icon: "≡" },
  { to: "/pos/members", label: "會員", icon: "☺" },
  { to: "/admin/scan", label: "庫存", icon: "▤" },
  { to: "/admin/attendance", label: "打卡", icon: "◷" },
];

export interface Shift {
  id: string;
  name: string;
  businessDate: string;
  status: "open" | "closed";
  float: number;
  openedByName: string;
}

export function useCurrentShift(): Shift | null | undefined {
  const { settings } = useData();
  const [shift, setShift] = useState<Shift | null | undefined>(undefined);
  const { locationId } = useDeviceLocation();
  const key = locationId ?? "main";
  // 多店：每家門市各自的班；單店沿用 currentShiftId
  const id = settings.currentShifts?.[key] ?? (key === "main" ? settings.currentShiftId : null);
  useEffect(() => {
    if (!id) {
      setShift(null);
      return;
    }
    return onSnapshot(doc(db, "shifts", id), (s) => setShift(s.exists() ? ({ id: s.id, ...s.data() } as Shift) : null));
  }, [id]);
  return shift;
}

export function PosLayout() {
  const { profile, logout } = useAuth();
  const { ready, settings } = useData();
  const shift = useCurrentShift();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="pos">
      <header className="pos-top">
        <span className="brand-mark sm">29</span>
        <span>{settings.shopName || "ganbaru29"}</span>
        <span className="pos-top-item">營業日 {shift?.businessDate ?? todayStr()}</span>
        <span className="pos-top-item">{shift ? `${shift.name}（${shift.openedByName} 開班）` : <NavLink to="/pos/drawer" className="warn-link">尚未開班</NavLink>}</span>
        <span className="grow" />
        <LocationSelect compact />
        <span className="pos-top-item">
          {profile?.name} · {profile && ROLE_LABEL[profile.role]}
        </span>
        <span className="pos-top-item">{now.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
      </header>
      <nav className="pos-menu">
        {MENU.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end} className="pos-menu-item">
            <span aria-hidden>{m.icon}</span>
            {m.label}
          </NavLink>
        ))}
        <button className="pos-menu-item" onClick={logout}>
          <span aria-hidden>⎋</span>登出
        </button>
      </nav>
      <main className="pos-main">{ready ? <Outlet /> : <div className="loading">載入商品資料…</div>}</main>
    </div>
  );
}
