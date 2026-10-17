import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { call, db } from "../firebase";
import { Barcode } from "./Barcode";
import { QrImg } from "./QrImg";
import { Modal, useAction, useToast } from "./ui";

/** 店員端：看會員的會員條碼、複製會員卡網址（傳給客人）、列印、重設連結 */
export function MemberCardDialog({ shopperId, name, onClose }: { shopperId: string; name: string; onClose: () => void }) {
  const [card, setCard] = useState<{ memberCode?: string; cardToken?: string } | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => onSnapshot(doc(db, "shoppers", shopperId), (s) => setCard((s.data() as { memberCode?: string; cardToken?: string }) ?? {})), [shopperId]);
  const url = card?.cardToken ? `${location.origin}/card/${card.cardToken}` : "";
  return (
    <Modal title={`會員卡：${name}`} onClose={onClose}>
      {!card ? (
        <p className="muted">載入中…</p>
      ) : !card.memberCode ? (
        <div className="center">
          <p>這位會員還沒有會員編號。</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => call("ensureAllMemberCodes"), "已產生")}>
            產生會員編號
          </button>
        </div>
      ) : (
        <div className="center member-card-admin">
          <QrImg value={card.memberCode} size={160} />
          <Barcode value={card.memberCode} height={50} />
          <p className="muted small">結帳時掃這個條碼就會帶入會員</p>
          <div className="inline-form">
            <input readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="btn" onClick={() => navigator.clipboard.writeText(url).then(() => toast("已複製會員卡網址", "ok"))}>
              複製網址
            </button>
          </div>
          <p className="muted small">把網址用 LINE 傳給客人，客人手機打開就是會員卡（可加入主畫面）。</p>
          <div className="card-handoff">
            <QrImg value={url} size={150} />
            <div className="small">
              <strong>或請客人當場掃這個 QR</strong>
              <br />
              用手機相機掃描，就會打開他自己的會員卡。
            </div>
          </div>
          <div className="btn-row" style={{ justifyContent: "center" }}>
            <button className="btn" onClick={() => window.open(url, "_blank")}>
              開啟會員卡
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => confirm("重設後舊的會員卡網址會失效，確定？") && run(() => call("resetMemberCard", { shopperId }), "已重設，請把新網址傳給客人")}>
              重設網址
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
