import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { AdminLayout, MoreMenu } from "./components/Layout";
import { ToastProvider } from "./components/ui";
import { UpdateChecker } from "./components/UpdateChecker";
import { DataProvider } from "./data";
import { atLeast, type Role } from "./lib/util";
import { AcceptInvite, Login } from "./pages/Login";
import { Inventory } from "./pages/admin/Inventory";
import { Labels } from "./pages/admin/Labels";
import { Movements } from "./pages/admin/Movements";
import { Products } from "./pages/admin/Products";
import { Promotions } from "./pages/admin/Promotions";
import { Reports } from "./pages/admin/Reports";
import { Scan } from "./pages/admin/Scan";
import { Settings } from "./pages/admin/Settings";
import { Transfers } from "./pages/admin/Transfers";
import { Expenses } from "./pages/admin/Expenses";
import { Attendance } from "./pages/admin/Attendance";
import { Customers, MemberRules, Rewards } from "./pages/admin/Customers";
import { StocktakeDetail, StocktakeList } from "./pages/admin/Stocktake";
import { PosLayout } from "./pages/pos/PosLayout";
import { Register } from "./pages/pos/Register";
import { DayClose, Drawer, Holds, OnlineOrders } from "./pages/pos/Shift";
import { Members, Transactions } from "./pages/pos/Transactions";

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
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/invite/:id" element={<AcceptInvite />} />
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
                <Route path="rewards" element={<Guard min="owner"><Rewards /></Guard>} />
                <Route path="expenses" element={<Guard min="manager"><Expenses /></Guard>} />
                <Route path="products" element={<Guard min="manager"><Products /></Guard>} />
                <Route path="labels" element={<Guard min="manager"><Labels /></Guard>} />
                <Route path="promotions" element={<Guard min="manager"><Promotions /></Guard>} />
                <Route path="movements" element={<Guard min="manager"><Movements /></Guard>} />
                <Route path="reports" element={<Guard min="manager"><Reports /></Guard>} />
                <Route path="settings" element={<Guard min="owner"><Settings /></Guard>} />
                <Route path="more" element={<MoreMenu />} />
              </Route>
              <Route path="/pos" element={<Guard><PosLayout /></Guard>}>
                <Route index element={<Register />} />
                <Route path="holds" element={<Holds />} />
                <Route path="online" element={<OnlineOrders />} />
                <Route path="drawer" element={<Drawer />} />
                <Route path="close" element={<DayClose />} />
                <Route path="transactions" element={<Transactions />} />
                <Route path="members" element={<Members />} />
                <Route path="attendance" element={<Attendance />} />
              </Route>
              <Route path="*" element={<Navigate to="/admin/scan" replace />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </DataProvider>
    </AuthProvider>
  );
}
