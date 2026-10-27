import { useEffect, useState } from "react";
import { CHANGELOG, LATEST, type ChangeEntry } from "../lib/changelog";
import { Modal } from "./ui";

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
/** 手動「檢查更新」：有新版就重新整理，沒有就告訴使用者已是最新 */
export async function checkForUpdate(): Promise<boolean> {
  if (import.meta.env.DEV) return false;
  const r = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
  const { build } = await r.json();
  if (build && build !== __BUILD_ID__) {
    location.reload();
    return true;
  }
  return false;
}

export function UpdateButton({ className = "link-btn small" }: { className?: string }) {
  const [state, setState] = useState<"idle" | "checking" | "latest" | "error">("idle");
  const [notes, setNotes] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={state === "checking"}
        onClick={async () => {
          setState("checking");
          try {
            if (!(await checkForUpdate())) {
              setState("latest");
              setNotes(true);
            }
          } catch {
            setState("error");
          }
          setTimeout(() => setState("idle"), 3000);
        }}
      >
        {state === "checking" ? "檢查中…" : state === "latest" ? "已是最新版本 ✓" : state === "error" ? "無法連線，稍後再試" : "檢查更新"}
      </button>
      {notes && <ChangelogDialog onClose={() => setNotes(false)} />}
    </>
  );
}

/** 更新紀錄（最新的在最上面） */
export function ChangelogDialog({ onClose, onlyLatest = false }: { onClose: () => void; onlyLatest?: boolean }) {
  const list: ChangeEntry[] = onlyLatest ? [LATEST] : CHANGELOG;
  return (
    <Modal
      title={onlyLatest ? "🎉 這次更新了什麼" : "更新內容（已是最新版本）"}
      onClose={onClose}
      footer={
        <button className="btn btn-primary block" onClick={onClose}>
          知道了
        </button>
      }
    >
      {list.map((c) => (
        <div key={c.id} className="changelog">
          <div className="changelog-head">
            <strong>{c.title}</strong>
            <span className="muted small">{c.date}</span>
          </div>
          <ul>
            {c.items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ))}
    </Modal>
  );
}

const SEEN_KEY = "g29.seenChangelog";

/**
 * 新版本偵測（電腦、平板主畫面 App 都一樣）：每 2 分鐘、以及每次切回 App 時比對 version.json。
 * 有新版就跳出視窗（含這次更新內容），按「立即更新」才重新整理；收銀台有進行中的單時改成上方提示列，不打斷結帳。
 */
/** 客人看的頁面（會員卡、LINE 頁、顧客螢幕）不跳「有新版本／這次更新了什麼」——那是給店員看的 */
const isCustomerPage = () => /^\/(card|line|display)(\/|$)/.test(window.location.pathname);

export function UpdateChecker() {
  if (isCustomerPage()) return null;
  return <StaffUpdateChecker />;
}

function StaffUpdateChecker() {
  const [upcoming, setUpcoming] = useState<ChangeEntry | null>(null);
  const [found, setFound] = useState(false);
  const [later, setLater] = useState(false);
  // 正在結帳（有視窗開著，例如付款、選規格）時先不跳，視窗關掉後再跳；購物車內容會保留，更新不會不見
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    if (!found) return;
    const t = setInterval(() => setModalOpen(!!document.querySelector('.modal:not([aria-label="🔔 有新版本"])')), 3000);
    setModalOpen(!!document.querySelector('.modal:not([aria-label="🔔 有新版本"])'));
    return () => clearInterval(t);
  }, [found]);
  // 更新完打開：跳出這次的更新內容（每個版本只跳一次）
  const [whatsNew, setWhatsNew] = useState(() => {
    try {
      const seen = localStorage.getItem(SEEN_KEY);
      localStorage.setItem(SEEN_KEY, LATEST.id);
      return seen !== LATEST.id;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        const { build, notes } = await r.json();
        if (stop || !build || build === __BUILD_ID__) return;
        if (notes) setUpcoming(notes);
        setFound(true);
      } catch {
        /* offline */
      }
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    const t = setInterval(check, 2 * 60_000);
    check();
    return () => {
      stop = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
      clearInterval(t);
    };
  }, []);

  if (!found) return whatsNew ? <ChangelogDialog onlyLatest onClose={() => setWhatsNew(false)} /> : null;
  return <UpdatePrompt upcoming={upcoming} modalOpen={modalOpen} later={later} setLater={setLater} />;
}

const AUTO_SECONDS = 60;

/** 有新版本：跳出視窗並倒數，沒人操作就自動更新（購物車會保留）；正在付款等視窗開著時不倒數 */
function UpdatePrompt({ upcoming, modalOpen, later, setLater }: { upcoming: ChangeEntry | null; modalOpen: boolean; later: boolean; setLater: (v: boolean) => void }) {
  const [left, setLeft] = useState(AUTO_SECONDS);
  const waiting = modalOpen || later;
  useEffect(() => {
    if (modalOpen) return;
    setLeft(AUTO_SECONDS);
    const t = setInterval(() => setLeft((x) => x - 1), 1000);
    // 有人在操作（點畫面、打字）就重新倒數
    const reset = () => setLeft(AUTO_SECONDS);
    window.addEventListener("pointerdown", reset, true);
    window.addEventListener("keydown", reset, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("pointerdown", reset, true);
      window.removeEventListener("keydown", reset, true);
    };
  }, [modalOpen, later]);
  useEffect(() => {
    if (left <= 0 && !modalOpen) location.reload();
  }, [left, modalOpen]);
  if (waiting)
    return (
      <div className="update-bar">
        🔔 有新版本{upcoming ? `：${upcoming.title}` : ""}
        {!modalOpen && <span className="small">（{left} 秒沒操作會自動更新）</span>}
        <button className="btn btn-sm" onClick={() => location.reload()}>
          立即更新
        </button>
      </div>
    );
  return (
    <Modal
      title="🔔 有新版本"
      onClose={() => setLater(true)}
      footer={
        <>
          <button className="btn" onClick={() => setLater(true)}>
            稍後
          </button>
          <button className="btn btn-primary" onClick={() => location.reload()}>
            立即更新（{left}）
          </button>
        </>
      }
    >
      {upcoming ? (
        <div className="changelog">
          <div className="changelog-head">
            <strong>{upcoming.title}</strong>
            <span className="muted small">{upcoming.date}</span>
          </div>
          <ul>
            {upcoming.items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>系統有新版本。</p>
      )}
      <p className="muted small">{left} 秒後自動更新{cartBusy() ? "，購物車裡的商品會保留" : ""}。</p>
    </Modal>
  );
}

