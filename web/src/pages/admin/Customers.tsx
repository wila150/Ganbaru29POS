import { Members } from "../pos/Transactions";
import { MemberSettings, RewardSettings } from "./Settings";

/** 顧客管理 → 顧客名單 */
export function Customers() {
  return <Members />;
}

/** 顧客管理 → 會員等級（老闆／工程師） */
export function MemberRules() {
  return (
    <div className="page">
      <MemberSettings />
    </div>
  );
}

/** 行銷 → 購物金回饋（老闆／工程師） */
export function Rewards() {
  return (
    <div className="page">
      <RewardSettings />
    </div>
  );
}
