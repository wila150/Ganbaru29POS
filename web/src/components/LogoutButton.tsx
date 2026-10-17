import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { useCurrentShift } from "../pages/pos/PosLayout";
import { Modal } from "./ui";

/**
 * 登出：這台裝置所在門市還有開著的班（還沒日結交班）時不能登出，
 * 避免現金沒點收、交易歸不到人。
 */
export function LogoutButton({ className, children }: { className: string; children: React.ReactNode }) {
  const { logout } = useAuth();
  const shift = useCurrentShift();
  const nav = useNavigate();
  const [blocked, setBlocked] = useState(false);
  return (
    <>
      <button className={className} onClick={() => (shift ? setBlocked(true) : logout())}>
        {children}
      </button>
      {blocked && shift && (
        <Modal
          title="還沒日結，不能登出"
          onClose={() => setBlocked(false)}
          footer={
            <>
              <button className="btn" onClick={() => setBlocked(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setBlocked(false);
                  nav("/pos/close");
                }}
              >
                前往日結交班
              </button>
            </>
          }
        >
          <p>
            目前「{shift.name}」還開著（{shift.openedByName} 開班，營業日 {shift.businessDate}）。
          </p>
          <p>請先到「日結」點收現金、按「日結交班」，之後就可以登出。</p>
        </Modal>
      )}
    </>
  );
}
