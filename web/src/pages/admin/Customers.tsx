import { Members } from "../pos/Transactions";
import { MemberSettings } from "./Settings";

/** 顧客管理 → 顧客名單 */
export function Customers() {
  return <Members />;
}

/** 顧客管理 → 會員等級與購物金（老闆／工程師） */
export function MemberRules() {
  return (
    <div className="page">
      <MemberSettings />
    </div>
  );
}
