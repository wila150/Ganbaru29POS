import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { AdminLayout, MoreMenu } from "./components/Layout";
import { ToastProvider } from "./components/ui";
import { UpdateChecker } from "./components/UpdateChecker";
import { DataProvider } from "./data";
import { atLeast, type Role } from "./lib/util";
import { AcceptInvite, Login } from "./pages/Login";
import { PosLayout } from "./pages/pos/PosLayout";

/**
 * 每個頁面分開打包：開 App 時只載入目前這頁，其他頁在背景閒置時預先載好，切換頁面不用等。
 */
const loaders: (() => Promise<unknown>)[] = [];
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  loaders.push(load);
  return lazy(() =>
    load()
      .then((m) => {
        sessionStorage.removeItem("chunkReload");
        return { default: m[name] };
      })
      .catch((e) => {
        // 剛更新版本：舊版的頁面檔已不存在 → 重新整理一次拿新版
        if (!sessionStorage.getItem("chunkReload")) {
          sessionStorage.setItem("chunkReload", "1");
          location.reload();
        }
        throw e;
      })
  );
}
const adminInv = () => import("./pages/admin/Inventory");
const Inventory = page(adminInv, "Inventory");
const Labels = page(() => import("./pages/admin/Labels"), "Labels");
const Movements = page(() => import("./pages/admin/Movements"), "Movements");
const Products = page(() => import("./pages/admin/Products"), "Products");
const Promotions = page(() => import("./pages/admin/Promotions"), "Promotions");
const Reports = page(() => import("./pages/admin/Reports"), "Reports");
const Scan = page(() => import("./pages/admin/Scan"), "Scan");
const Settings = page(() => import("./pages/admin/Settings"), "Settings");
const Transfers = page(() => import("./pages/admin/Transfers"), "Transfers");
const Expenses = page(() => import("./pages/admin/Expenses"), "Expenses");
const Attendance = page(() => import("./pages/admin/Attendance"), "Attendance");
const Segments = page(() => import("./pages/admin/Segments"), "Segments");
const customers = () => import("./pages/admin/Customers");
const Customers = page(customers, "Customers");
const MemberRules = page(customers, "MemberRules");
const Rewards = page(customers, "Rewards");
const stocktake = () => import("./pages/admin/Stocktake");
const StocktakeList = page(stocktake, "StocktakeList");
const StocktakeDetail = page(stocktake, "StocktakeDetail");
const Register = page(() => import("./pages/pos/Register"), "Register");
const shift = () => import("./pages/pos/Shift");
const Holds = page(shift, "Holds");
const OnlineOrders = page(shift, "OnlineOrders");
const Drawer = page(shift, "Drawer");
const DayClose = page(shift, "DayClose");
const tx = () => import("./pages/pos/Transactions");
const Transactions = page(tx, "Transactions");
const Members = page(tx, "Members");
const Ship = page(() => import("./pages/pos/Ship"), "Ship");
const MemberCard = page(() => import("./pages/MemberCard"), "MemberCard");
const LineCard = page(() => import("./pages/LineCard"), "LineCard");
const Help = page(() => import("./pages/admin/Help"), "Help");

/** 登入後，閒置時把所有頁面預先載入 */
function Prefetch() {
  const { profile } = useAuth();
  useEffect(() => {
    if (!profile?.active) return;
    const run = () => loaders.forEach((l) => l().catch(() => undefined));
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1500);
  }, [profile?.active]);
  return null;
}

function Guard({ min = "staff", children }: { min?: Role; children: ReactNode }) {
  const { loading, profile } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="loading">載入中…</div>;
  if (!profile?.active) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!atLeast(profile.role, min)) return <div className="page"><p className="notice notice-warn">這個頁面限{min === "owner" ? "老闆／工程師" : "店長以上"}使用。</p></div>;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <DataProvider>
        <ToastProvider>
          <UpdateChecker />
          <BrowserRouter>
            <Prefetch />
            <Suspense fallback={<div className="loading">載入中…</div>}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/invite/:id" element={<AcceptInvite />} />
              <Route path="/card/:token" element={<MemberCard />} />
              <Route path="/line" element={<LineCard />} />
              <Route path="/admin" element={<Guard><AdminLayout /></Guard>}>
                <Route index element={<Navigate to="scan" replace />} />
                <Route path="scan" element={<Scan />} />
                <Route path="inventory" element={<Inventory />} />
                <Route path="stocktake" element={<StocktakeList />} />
                <Route path="stocktake/:id" element={<StocktakeDetail />} />
                <Route path="transfers" element={<Transfers />} />
                <Route path="attendance" element={<Attendance />} />
                <Route path="members" element={<Customers />} />
                <Route path="member-rules" element={<Guard min="owner"><MemberRules /></Guard>} />
                <Route path="segments" element={<Guard min="manager"><Segments /></Guard>} />
                <Route path="rewards" element={<Guard min="owner"><Rewards /></Guard>} />
                <Route path="expenses" element={<Guard min="manager"><Expenses /></Guard>} />
                <Route path="products" element={<Guard min="manager"><Products /></Guard>} />
                <Route path="labels" element={<Guard min="manager"><Labels /></Guard>} />
                <Route path="promotions" element={<Guard min="manager"><Promotions /></Guard>} />
                <Route path="movements" element={<Guard min="manager"><Movements /></Guard>} />
                <Route path="reports" element={<Guard min="manager"><Reports /></Guard>} />
                <Route path="settings" element={<Guard min="owner"><Settings /></Guard>} />
                <Route path="more" element={<MoreMenu />} />
                <Route path="help" element={<Help />} />
              </Route>
              <Route path="/pos" element={<Guard><PosLayout /></Guard>}>
                <Route index element={<Register />} />
                <Route path="holds" element={<Holds />} />
                <Route path="online" element={<OnlineOrders />} />
                <Route path="ship" element={<Ship />} />
                <Route path="drawer" element={<Drawer />} />
                <Route path="close" element={<DayClose />} />
                <Route path="transactions" element={<Transactions />} />
                <Route path="members" element={<Members />} />
                <Route path="attendance" element={<Attendance />} />
              </Route>
              <Route path="*" element={<Navigate to="/admin/scan" replace />} />
            </Routes>
            </Suspense>
          </BrowserRouter>
        </ToastProvider>
      </DataProvider>
    </AuthProvider>
  );
}
