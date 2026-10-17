import { useEffect, useState } from "react";

const DRAFT_KEY = "g29.posDraft";

/** 收銀台上還有沒結帳的購物車時，不自動重新整理（避免中斷結帳）。 */
function cartBusy(): boolean {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
    return Array.isArray(d.cart) && d.cart.length > 0;
  } catch {
    return false;
  }
}

/**
 * 新版本偵測：加入主畫面的 iPad App 不必重新加入。每次回到 App、以及每 5 分鐘，
 * 比對伺服器上的 version.json；有新版且收銀台沒有進行中的購物車就自動重新整理，否則顯示提示。
 */
export function UpdateChecker() {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        const { build } = await r.json();
        if (stop || !build || build === __BUILD_ID__) return;
        if (!cartBusy() && !document.querySelector(".modal")) location.reload();
        else setNewer(true);
      } catch {
        /* offline */
      }
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    const t = setInterval(check, 5 * 60_000);
    check();
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(t);
    };
  }, []);
  if (!newer) return null;
  return (
    <div className="update-bar">
      有新版本
      <button className="btn btn-sm" onClick={() => location.reload()}>
        立即更新
      </button>
      <span className="small">（結帳完成後也會自動更新）</span>
    </div>
  );
}
