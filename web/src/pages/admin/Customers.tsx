import { useState } from "react";
import { useAuth } from "../../auth";
import { atLeast } from "../../lib/util";
import { Members } from "../pos/Transactions";
import { MemberSettings } from "./Settings";

/** 顧客管理：顧客名單＋會員等級、生日禮、購物金回饋規則（設定限老闆／工程師）。 */
export function Customers() {
  const { profile } = useAuth();
  const canEdit = atLeast(profile?.role, "owner");
  const [tab, setTab] = useState<"list" | "rules">("list");
  return (
    <div>
      {canEdit && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="segmented">
            <button className={tab === "list" ? "active" : ""} onClick={() => setTab("list")}>
              顧客名單
            </button>
            <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>
              會員等級與購物金
            </button>
          </div>
        </div>
      )}
      {tab === "list" || !canEdit ? (
        <Members />
      ) : (
        <div className="page" style={{ paddingTop: 0 }}>
          <MemberSettings />
        </div>
      )}
    </div>
  );
}
