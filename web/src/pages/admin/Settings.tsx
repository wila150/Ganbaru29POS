import { collection, doc, onSnapshot, orderBy, query, setDoc, type Timestamp } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { Badge, Field, useAction, useToast } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { fmtTime, ROLE_LABEL, type Role } from "../../lib/util";
import type { ShopSettings } from "../../types";

export function Settings() {
  return (
    <div className="page">
      <h1>設定</h1>
      <Staff />
      <ApiKey />
      <Alerts />
      <PosSettings />
    </div>
  );
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
}
interface Invite {
  id: string;
  email: string;
  role: Role;
  name: string | null;
  expiresAt: Timestamp;
  usedBy: string | null;
}

function Staff() {
  const { user, profile } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [link, setLink] = useState("");
  const { busy, run } = useAction();
  const toast = useToast();

  useEffect(() => {
    const u1 = onSnapshot(collection(db, "users"), (s) => setUsers(s.docs.map((d) => ({ id: d.id, ...d.data() }) as UserRow)));
    const u2 = onSnapshot(query(collection(db, "invites"), orderBy("createdAt", "desc")), (s) => setInvites(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Invite)));
    return () => {
      u1();
      u2();
    };
  }, []);

  const invite = () =>
    run(async () => {
      const r = await call<{ id: string }>("inviteStaff", { email, name, role });
      const url = `${location.origin}/invite/${r.id}`;
      setLink(url);
      setEmail("");
      setName("");
      try {
        await navigator.clipboard.writeText(url);
        toast("邀請連結已複製，傳給員工即可", "ok");
      } catch {
        /* show the link instead */
      }
    });

  const pending = invites.filter((i) => !i.usedBy && i.expiresAt.toMillis() > Date.now());

  return (
    <section className="card">
      <h2>員工管理</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>姓名</th>
              <th>Email</th>
              <th>角色</th>
              <th>狀態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...users]
              .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
              .map((u) => (
                <tr key={u.id} className={u.active ? "" : "row-muted"}>
                  <td>
                    <button className="link-btn" disabled={busy} onClick={() => {
                      const n = prompt("員工姓名", u.name);
                      if (n) run(() => call("renameStaff", { uid: u.id, name: n }), "已更新");
                    }}>
                      {u.name}
                    </button>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    {u.role === "owner" || u.role === "engineer" || u.id === user?.uid ? (
                      ROLE_LABEL[u.role]
                    ) : (
                      <select value={u.role} disabled={busy} onChange={(e) => run(() => call("setRole", { uid: u.id, role: e.target.value }), "角色已更新")}>
                        <option value="manager">店長</option>
                        <option value="staff">員工</option>
                      </select>
                    )}
                  </td>
                  <td>{u.active ? <Badge tone="ok">啟用</Badge> : <Badge>已停用</Badge>}</td>
                  <td>
                    {u.role !== "owner" && u.id !== user?.uid && (u.role !== "engineer" || profile?.role === "owner") && (
                      <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => (u.active ? confirm(`停用 ${u.name}？停用後立即無法操作，過去紀錄保留。`) : true) && run(() => call("setActive", { uid: u.id, active: !u.active }), u.active ? "已停用" : "已啟用")}>
                        {u.active ? "停用" : "重新啟用"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <p className="muted small">工程師帳號由 functions/.env 的 ENGINEER_EMAILS 設定，第一次登入自動建立；老闆可以在這裡停用。</p>

      <h3>邀請員工</h3>
      <div className="inline-form">
        <input type="email" placeholder="員工的 Google 帳號 Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="姓名（選填）" value={name} onChange={(e) => setName(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="staff">員工</option>
          <option value="manager">店長</option>
        </select>
        <button className="btn btn-primary" disabled={busy || !email} onClick={invite}>
          產生邀請連結
        </button>
      </div>
      {link && (
        <p className="notice">
          邀請連結（7 天內有效）：<code className="break">{link}</code>
        </p>
      )}
      {pending.length > 0 && (
        <p className="muted small">
          等待接受：{pending.map((i) => `${i.email}（${ROLE_LABEL[i.role]}，${fmtTime(i.expiresAt)} 到期）`).join("、")}
        </p>
      )}
    </section>
  );
}

function ApiKey() {
  const { settings } = useData();
  const [status, setStatus] = useState<{ meepshop: boolean; line: boolean } | null>(null);
  const [key, setKey] = useState("");
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    call<{ meepshop: boolean; line: boolean }>("secretStatus").then(setStatus).catch(() => setStatus(null));
  }, []);
  return (
    <section className="card">
      <h2>meepShop API 金鑰</h2>
      <p>
        狀態：{status?.meepshop ? <Badge tone="ok">已設定</Badge> : <Badge tone="bad">未設定</Badge>}
        {settings.apiKeySetAt && (
          <span className="muted small">
            {" "}
            · {settings.apiKeySetBy} 於 {fmtTime(settings.apiKeySetAt)} 更新
          </span>
        )}
      </p>
      <p className="muted small">金鑰只存在伺服器（Google Secret Manager），這裡永遠不會顯示。更換時系統會先用新金鑰試查一次，成功才存。</p>
      <div className="inline-form">
        <input type="password" autoComplete="off" placeholder="貼上新的 API 金鑰" value={key} onChange={(e) => setKey(e.target.value)} />
        <button
          className="btn btn-primary"
          disabled={busy || !key}
          onClick={() =>
            run(async () => {
              const r = await call<{ products: number }>("setApiKey", { key });
              setKey("");
              setStatus((s) => ({ line: !!s?.line, meepshop: true }));
              toast(`金鑰已更新，meepShop 共 ${r.products} 個商品`, "ok");
            })
          }
        >
          儲存金鑰
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await call<{ ok: boolean; products?: number; error?: string }>("testConnection");
              if (!r.ok) throw new Error(`連線失敗：${r.error}`);
              toast(`連線正常，meepShop 共 ${r.products} 個商品`, "ok");
            })
          }
        >
          測試連線
        </button>
      </div>
    </section>
  );
}

function useSettingsForm<K extends keyof ShopSettings>(keys: K[]) {
  const { settings } = useData();
  const [form, setForm] = useState<Pick<ShopSettings, K>>(() => Object.fromEntries(keys.map((k) => [k, settings[k]])) as Pick<ShopSettings, K>);
  const { busy, run } = useAction();
  const save = () =>
    run(async () => {
      const data = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined));
      await setDoc(doc(db, "settings", "shop"), data, { merge: true });
    }, "已儲存");
  const set = <T extends K>(k: T, v: ShopSettings[T]) => setForm((f) => ({ ...f, [k]: v }));
  return { form, set, save, busy };
}

function Alerts() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["lineTargets", "leadDays", "expiryDays"]);
  const [token, setToken] = useState("");
  const { busy: b2, run } = useAction();
  return (
    <section className="card">
      <h2>提醒</h2>
      <p className="muted small">
        每天 9:00 用 LINE 推播低庫存、快到期、同步失敗。需要一個 LINE 官方帳號的 Messaging API channel（LINE Notify 已停止服務）。
      </p>
      <div className="grid-fields">
        <Field label="LINE 推播對象（userId / groupId，一行一個）" hint="把官方帳號加為好友後，可從 webhook 或 LINE Developers 取得 userId">
          <textarea rows={3} value={(form.lineTargets ?? []).join("\n")} onChange={(e) => set("lineTargets", e.target.value.split(/\s+/).filter(Boolean))} />
        </Field>
        <Field label="即將到期提醒（天）">
          <input type="number" min={1} value={form.expiryDays ?? 30} onChange={(e) => set("expiryDays", Number(e.target.value))} />
        </Field>
        <Field label="補貨到貨天數" hint="用來算建議補貨量">
          <input type="number" min={0} value={form.leadDays ?? 7} onChange={(e) => set("leadDays", Number(e.target.value))} />
        </Field>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存提醒設定
      </button>
      <h3>LINE Channel access token {settings.lineTokenSetAt ? <Badge tone="ok">已設定</Badge> : <Badge>未設定</Badge>}</h3>
      <div className="inline-form">
        <input type="password" autoComplete="off" placeholder="貼上 Channel access token（long-lived）" value={token} onChange={(e) => setToken(e.target.value)} />
        <button className="btn" disabled={b2 || !token} onClick={() => run(() => call("setLineToken", { token }), "已儲存").then(() => setToken(""))}>
          儲存
        </button>
        <button className="btn btn-ghost" disabled={b2} onClick={() => run(() => call("testLine"), "已送出測試訊息")}>
          傳測試訊息
        </button>
      </div>
    </section>
  );
}

function PosSettings() {
  const { form, set, save, busy } = useSettingsForm(["shopName", "rewardPercent", "pointValue", "staffCanRefund", "serviceFeeDefault", "receiptHeader", "receiptFooter", "shiftNames", "siteBaseUrl"]);
  return (
    <section className="card">
      <h2>POS 與門市</h2>
      <div className="grid-fields">
        <Field label="店名（收據抬頭）">
          <input value={form.shopName ?? ""} onChange={(e) => set("shopName", e.target.value)} placeholder="ganbaru29" />
        </Field>
        <Field label="消費回饋購物金（%）" hint="0 = 不回饋；例如 1 表示消費 $100 回饋 1 點">
          <input type="number" min={0} max={100} step={0.1} value={form.rewardPercent ?? 0} onChange={(e) => set("rewardPercent", Number(e.target.value))} />
        </Field>
        <Field label="1 點購物金折抵（元）">
          <input type="number" min={0.01} step={0.01} value={form.pointValue ?? 1} onChange={(e) => set("pointValue", Number(e.target.value))} />
        </Field>
        <Field label="預設服務費（%）">
          <input type="number" min={0} max={100} value={form.serviceFeeDefault ?? 0} onChange={(e) => set("serviceFeeDefault", Number(e.target.value))} />
        </Field>
        <Field label="班別名稱（逗號分隔）">
          <input value={(form.shiftNames ?? ["早班", "晚班"]).join(",")} onChange={(e) => set("shiftNames", e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))} />
        </Field>
        <Field label="官網網址（抓商品圖用）">
          <input value={form.siteBaseUrl ?? "https://www.ganbaru29.com"} onChange={(e) => set("siteBaseUrl", e.target.value)} />
        </Field>
        <Field label="收據表頭（地址、電話…）">
          <textarea rows={2} value={form.receiptHeader ?? ""} onChange={(e) => set("receiptHeader", e.target.value)} />
        </Field>
        <Field label="收據頁尾">
          <textarea rows={2} value={form.receiptFooter ?? ""} onChange={(e) => set("receiptFooter", e.target.value)} placeholder="謝謝光臨" />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!form.staffCanRefund} onChange={(e) => set("staffCanRefund", e.target.checked)} /> 員工也可以退貨、作廢（預設限店長以上）
      </label>
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存 POS 設定
      </button>
    </section>
  );
}
