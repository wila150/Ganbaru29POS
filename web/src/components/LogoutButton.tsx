import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { atLeast } from "../lib/util";
import { useCurrentShift } from "../pages/pos/PosLayout";
import { Modal } from "./ui";

/**
 * 登出：這台裝置所在門市還有開著的班（還沒日結交班）時不能登出，
 * 避免現金沒點收、交易歸不到人。
 */
export function LogoutButton({ className, children }: { className: string; children: React.ReactNode }) {
  const { logout, profile } = useAuth();
  const canForce = atLeast(profile?.role, "manager");
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
          title={canForce ? "還沒日結" : "還沒日結，不能登出"}
          onClose={() => setBlocked(false)}
          footer={
            <>
              <button className="btn" onClick={() => setBlocked(false)}>
                取消
              </button>
              {canForce && (
                <button className="btn btn-danger" onClick={() => confirm("班還開著，確定仍要登出？（班不會被關掉，之後要有人日結）") && logout()}>
                  仍要登出
                </button>
              )}
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
          {canForce && <p className="muted small">你是店長以上，可以「仍要登出」；班會繼續開著，下一位登入的人仍可在這個班結帳、日結。</p>}
        </Modal>
      )}
    </>
  );
}
