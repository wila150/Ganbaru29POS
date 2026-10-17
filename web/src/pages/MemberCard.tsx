import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Barcode } from "../components/Barcode";
import { QrImg } from "../components/QrImg";
import { call } from "../firebase";

interface Card {
  name: string;
  code: string;
  points: number;
  group: string | null;
  tier: string | null;
  shopName: string;
}

/** 客人手機上的會員卡（不用登入）。結帳時給店員掃。 */
export function MemberCard() {
  const { token } = useParams();
  const [card, setCard] = useState<Card | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    call<Card>("memberCard", { token })
      .then(setCard)
      .catch((e) => setErr(e.message));
  }, [token]);
  return (
    <div className="member-card-page">
      {err ? (
        <p className="error center">{err}</p>
      ) : !card ? (
        <p className="muted center">載入中…</p>
      ) : (
        <div className="member-card">
          <div className="mc-shop">{card.shopName}</div>
          <div className="mc-name">{card.name}</div>
          <div className="mc-badges">
            {card.group && <span>{card.group}</span>}
            {card.tier && card.tier !== card.group && <span>{card.tier}</span>}
          </div>
          <div className="mc-qr">
            <QrImg value={card.code} size={200} />
          </div>
          <div className="mc-barcode">
            <Barcode value={card.code} height={60} width={2} fontSize={14} />
          </div>
          <div className="mc-points">
            購物金 <strong>{card.points.toLocaleString("zh-TW")}</strong>
          </div>
          <p className="mc-hint">結帳時請出示此畫面給店員掃描。可以按「分享 → 加入主畫面」，下次直接打開。</p>
        </div>
      )}
    </div>
  );
}
