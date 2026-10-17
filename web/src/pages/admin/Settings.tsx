import { collection, doc, onSnapshot, orderBy, query, setDoc, type Timestamp } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth";
import { Badge, Field, useAction, useToast } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { fmtTime, ROLE_LABEL, type Role } from "../../lib/util";
import type { RewardRule, ShopSettings, TierDef } from "../../types";
import { DEFAULT_EXPENSE_CATEGORIES } from "./Expenses";
import { QrImg } from "../../components/QrImg";

export function Settings() {
  return (
    <div className="page">
      <h1>設定</h1>
      <Staff />
      <ApiKey />
      <Alerts />
      <PosSettings />
      <PaymentSettings />
      <LocationSettings />
      <MerchantSettings />
      <LineLoginSettings />
      <StaffMoneySettings />
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

const TIER_EXAMPLE: TierDef[] = [
  { name: "一般會員", minSpend: 0, discountPct: 0, pointMultiplier: 1 },
  { name: "黃金會員", minSpend: 10000, discountPct: 5, pointMultiplier: 1.5 },
  { name: "鑽石會員", minSpend: 30000, discountPct: 10, pointMultiplier: 2 },
];

export function MemberSettings() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["memberTiers"]);
  const { busy: b2, run } = useAction();
  const tiers = form.memberTiers ?? [];
  const setTier = (i: number, patch: Partial<TierDef>) => set("memberTiers", tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <section className="card">
      <h2>會員等級</h2>
      <p className="muted small">
        依「近 12 個月消費（門市＋網店）」每天凌晨自動升降級，累計或單次任一達標即升級；結帳時自動套用等級折扣，回饋購物金乘上倍數。meepShop 不能改會員等級，等級只存在本系統。
        {settings.tiersAt && ` 上次計算：${fmtTime(settings.tiersAt)}`}
        {settings.tiersError && <span className="error"> 計算失敗：{settings.tiersError}</span>}
      </p>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>等級名稱</th>
              <th className="num">12 個月累計滿（元）</th>
              <th className="num">或單次購物滿（元）</th>
              <th className="num">結帳折扣 %</th>
              <th className="num">購物金回饋倍數</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td>
                  <input value={t.name} onChange={(e) => setTier(i, { name: e.target.value })} />
                </td>
                <td>
                  <input type="number" min={0} value={t.minSpend} onChange={(e) => setTier(i, { minSpend: Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" min={0} value={t.minSingle ?? ""} placeholder="不限" onChange={(e) => setTier(i, { minSingle: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" min={0} max={100} value={t.discountPct} onChange={(e) => setTier(i, { discountPct: Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" min={1} step={0.1} value={t.pointMultiplier} onChange={(e) => setTier(i, { pointMultiplier: Number(e.target.value) })} />
                </td>
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => set("memberTiers", tiers.filter((_, j) => j !== i))}>
                    刪除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="btn-row">
        <button className="btn btn-sm" onClick={() => set("memberTiers", [...tiers, { name: "", minSpend: 0, discountPct: 0, pointMultiplier: 1 }])}>
          ＋ 新增等級
        </button>
        {!tiers.length && (
          <button className="btn btn-sm btn-ghost" onClick={() => set("memberTiers", TIER_EXAMPLE)}>
            套用範例（一般／黃金／鑽石）
          </button>
        )}
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={() => {
          if (tiers.some((t) => !t.name.trim())) return alert("等級名稱不能空白");
          save();
        }}>
          儲存會員等級
        </button>
        <button className="btn" disabled={b2} onClick={() => run(async () => {
          const r = await call<{ updated: number; error: string | null }>("recomputeMemberTiers");
          if (r.error) throw new Error(r.error);
          return r;
        }, "會員等級已重新計算")}>
          {b2 ? "計算中…" : "立即重算等級"}
        </button>
      </div>
    </section>
  );
}

const CRED_LABEL: Record<string, string> = { ecpay_payment: "綠界金流", newebpay_payment: "藍新金流", ecpay_invoice: "綠界電子發票" };

function CredForm({ kind, current, onSaved }: { kind: string; current: string | null | undefined; onSaved: () => void }) {
  const [f, setF] = useState({ merchantId: "", hashKey: "", hashIv: "" });
  const { busy, run } = useAction();
  return (
    <div className="cred-form">
      <div className="row-between">
        <strong>{CRED_LABEL[kind]}</strong>
        {current ? <Badge tone="ok">已設定：商店代號 {current}</Badge> : <Badge>未設定{kind.startsWith("ecpay") ? "（測試環境會用綠界公用測試帳號）" : ""}</Badge>}
      </div>
      <div className="inline-form">
        <input placeholder="商店代號 MerchantID" value={f.merchantId} onChange={(e) => setF({ ...f, merchantId: e.target.value.trim() })} />
        <input type="password" autoComplete="off" placeholder="HashKey" value={f.hashKey} onChange={(e) => setF({ ...f, hashKey: e.target.value.trim() })} />
        <input type="password" autoComplete="off" placeholder="HashIV" value={f.hashIv} onChange={(e) => setF({ ...f, hashIv: e.target.value.trim() })} />
        <button className="btn" disabled={busy || !f.merchantId || !f.hashKey || !f.hashIv} onClick={() => run(async () => {
          await call("setPaymentCreds", { kind, ...f });
          setF({ merchantId: "", hashKey: "", hashIv: "" });
          onSaved();
        }, "已儲存")}>
          儲存
        </button>
      </div>
    </div>
  );
}

function PaymentSettings() {
  const { form, set, save, busy } = useSettingsForm(["payment", "invoice"]);
  const [creds, setCreds] = useState<Record<string, string | null>>({});
  const load = () => call<Record<string, string | null>>("paymentCredsStatus").then(setCreds).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  const pay = form.payment ?? { provider: null, stage: true };
  const inv = form.invoice ?? { enabled: false, stage: true };
  return (
    <section className="card">
      <h2>金流與電子發票</h2>
      <p className="muted small">
        「掃碼付款」：POS 產生 QR code，客人用手機在綠界／藍新的付款頁刷卡、Apple Pay、LINE Pay、台灣 Pay 付款，付款完成 POS 自動結帳。刷卡機目前仍是另外刷，再在 POS 選「信用卡」。
        金鑰只存在伺服器（Secret Manager），存了之後畫面上只顯示商店代號。
      </p>
      <div className="grid-fields">
        <Field label="掃碼付款服務">
          <select value={pay.provider ?? ""} onChange={(e) => set("payment", { ...pay, provider: (e.target.value || null) as "ecpay" | "newebpay" | null })}>
            <option value="">不使用</option>
            <option value="ecpay">綠界 ECPay</option>
            <option value="newebpay">藍新 NewebPay</option>
          </select>
        </Field>
        <Field label="金流環境">
          <select value={pay.stage ? "stage" : "prod"} onChange={(e) => set("payment", { ...pay, stage: e.target.value === "stage" })}>
            <option value="stage">測試（不會真的扣款）</option>
            <option value="prod">正式</option>
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!inv.enabled} onChange={(e) => set("invoice", { ...inv, enabled: e.target.checked })} /> 結帳時自動開立電子發票（綠界）
      </label>
      <div className="grid-fields">
        <Field label="發票環境">
          <select value={inv.stage ? "stage" : "prod"} onChange={(e) => set("invoice", { ...inv, stage: e.target.value === "stage" })}>
            <option value="stage">測試（發票不會上傳財政部）</option>
            <option value="prod">正式</option>
          </select>
        </Field>
        <Field label="發票通知 Email" hint="綠界規定買受人 Email 或手機須擇一；客人沒留時用這個">
          <input type="email" value={inv.notifyEmail ?? ""} onChange={(e) => set("invoice", { ...inv, notifyEmail: e.target.value })} />
        </Field>
        <Field label="門市地址" hint="打統編、列印發票時綠界要求填地址">
          <input value={inv.address ?? ""} onChange={(e) => set("invoice", { ...inv, address: e.target.value })} />
        </Field>
      </div>
      {!pay.stage && pay.provider && !creds[`${pay.provider}_payment`] && <p className="notice notice-bad">正式環境需要先填 {CRED_LABEL[`${pay.provider}_payment`]} 的商店代號與金鑰。</p>}
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存金流與發票設定
      </button>
      <h3>商店代號與金鑰</h3>
      {(["ecpay_payment", "newebpay_payment", "ecpay_invoice"] as const).map((k) => (
        <CredForm key={k} kind={k} current={creds[k]} onSaved={load} />
      ))}
    </section>
  );
}

function LocationSettings() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["locations", "onlineLocationId"]);
  const { busy: b2, run } = useAction();
  const list = form.locations ?? [];
  const setLoc = (i: number, patch: Partial<{ name: string; type: "store" | "warehouse" }>) => set("locations", list.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <section className="card">
      <h2>門市與倉庫（多店）</h2>
      <p className="muted small">
        只有一家店時不用設定。新增兩個以上地點後：每台裝置選自己所在的地點，掃碼、銷售、退貨都記在該地點；可以跨店查庫存、申請調貨；每家門市各自開班日結。
        meepShop 仍是一個總庫存，網店訂單的扣減會記到「網店出貨地點」。
      </p>
      <table className="table table-compact">
        <tbody>
          {list.map((l, i) => (
            <tr key={l.id}>
              <td>
                <input value={l.name} onChange={(e) => setLoc(i, { name: e.target.value })} placeholder="例：台北門市" />
              </td>
              <td>
                <select value={l.type} onChange={(e) => setLoc(i, { type: e.target.value as "store" | "warehouse" })}>
                  <option value="store">門市</option>
                  <option value="warehouse">倉庫</option>
                </select>
              </td>
              <td className="muted small">{l.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="btn-row">
        <button className="btn btn-sm" onClick={() => set("locations", [...list, { id: `L${Date.now().toString(36)}`, name: "", type: "store" }])}>
          ＋ 新增門市／倉庫
        </button>
      </div>
      {list.length > 0 && (
        <Field label="網店出貨地點" hint="網店訂單由 meepShop 扣總庫存，每天同步時把差額記到這個地點（通常是倉庫）">
          <select value={form.onlineLocationId ?? ""} onChange={(e) => set("onlineLocationId", e.target.value || null)}>
            <option value="">（未設定）</option>
            {list.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name || l.id}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={() => (list.some((l) => !l.name.trim()) ? alert("地點名稱不能空白") : save())}>
          儲存門市設定
        </button>
        {(settings.locations ?? []).length > 0 && (
          <select
            className="btn"
            value=""
            disabled={b2}
            onChange={(e) => {
              const id = e.target.value;
              const name = settings.locations?.find((l) => l.id === id)?.name;
              if (id && confirm(`把目前所有 meepShop 庫存都歸到「${name}」？其他地點的數量會清為 0（之後用盤點或調貨分配）。`))
                run(() => call("initLocationStock", { locationId: id }), "已設定各地點起始庫存");
            }}
          >
            <option value="">起始庫存：全部歸到…</option>
            {(settings.locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {settings.locationStockInitAt && <p className="muted small">起始庫存設定於 {fmtTime(settings.locationStockInitAt)}。各店實際數量請到該店用「盤點」（選該門市）校正。</p>}
    </section>
  );
}

/** 商品圖自動補齊：Google Merchant Center 每天抓 meepShop Feed，系統每天 08:00 從 Merchant Center 讀主圖。 */
function MerchantSettings() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["merchantId"]);
  const { busy: b2, run } = useAction();
  const m = settings.merchantSync;
  return (
    <section className="card">
      <h2>商品圖自動補齊（Google Merchant Center）</h2>
      <p className="muted small">
        官網有 Cloudflare 驗證，系統不能直接抓圖；改由 Google Merchant Center 每天讀 meepShop 的商品 Feed，系統每天 08:00 從 Merchant Center 取得主圖網址並下載。
        新商品隔天會自動有圖；手動上傳的圖不會被覆蓋。
      </p>
      <div className="inline-form">
        <input placeholder="Merchant Center ID（網址 a= 後面的數字）" value={form.merchantId ?? ""} onChange={(e) => set("merchantId", e.target.value.trim())} />
        <button className="btn" disabled={busy} onClick={save}>
          儲存
        </button>
        <button
          className="btn btn-primary"
          disabled={b2 || !settings.merchantId}
          onClick={() =>
            run(async () => {
              const r = await call<{ products: number; done: number; skipped: number; failedCount: number }>("syncImagesFromMerchant");
              alert(`Merchant Center 共 ${r.products} 個商品，補上 ${r.done} 張圖${r.failedCount ? `，${r.failedCount} 張失敗` : ""}`);
            })
          }
        >
          {b2 ? "補圖中（約 1～3 分鐘）…" : "立即補圖"}
        </button>
      </div>
      {m && (
        <p className={`small ${m.error ? "error" : "muted"}`}>
          上次執行：{fmtTime(m.at)}（{m.trigger === "daily" ? "每日自動" : "手動"}）
          {m.error ? `　失敗：${m.error}` : `　Merchant Center ${m.products ?? 0} 個商品，補上 ${m.done ?? 0} 張`}
        </p>
      )}
    </section>
  );
}

/** 員工抽成與開支分類 */
function StaffMoneySettings() {
  const { form, set, save, busy } = useSettingsForm(["commissionPct", "commissionByUser", "expenseCategories"]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => onSnapshot(collection(db, "users"), (s) => setUsers(s.docs.filter((d) => d.data().active).map((d) => ({ id: d.id, name: d.data().name })))), []);
  const byUser = form.commissionByUser ?? {};
  return (
    <section className="card">
      <h2>員工抽成與開支分類</h2>
      <div className="grid-fields">
        <Field label="預設抽成（淨銷售額 %）" hint="報表中心「員工業績」用；0 = 不抽成">
          <input type="number" min={0} max={100} step={0.1} value={form.commissionPct ?? 0} onChange={(e) => set("commissionPct", Number(e.target.value))} />
        </Field>
      </div>
      <h3>個別員工抽成（留空 = 用預設）</h3>
      <div className="grid-fields">
        {users.map((u) => (
          <Field key={u.id} label={u.name}>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={byUser[u.id] ?? ""}
              onChange={(e) => {
                const n = { ...byUser };
                if (e.target.value === "") delete n[u.id];
                else n[u.id] = Number(e.target.value);
                set("commissionByUser", n);
              }}
            />
          </Field>
        ))}
      </div>
      <Field label="開支分類（一行一個）" hint="直接在最後一行加上新分類；刪掉一行就移除。已經記錄的開支不受影響。">
        <textarea
          rows={8}
          defaultValue={(form.expenseCategories?.length ? form.expenseCategories : DEFAULT_EXPENSE_CATEGORIES).join("\n")}
          onChange={(e) => set("expenseCategories", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))}
        />
      </Field>
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存
      </button>
    </section>
  );
}

/** 購物金回饋規則（門市結帳用；網店的回饋由 meepShop 自己發） */
/** 行銷 → 購物金回饋：門市結帳的購物金回饋規則＋生日禮 */
export function RewardSettings() {
  const { form, set, save, busy } = useSettingsForm(["birthdayGiftPoints", "birthdayPointMultiplier"]);
  return (
    <section className="card">
      <h2>購物金回饋</h2>
      <RewardRules />
      <h3>生日禮</h3>
      <p className="muted small">meepShop 後台已設定「會員生日」寄送購物金時，這裡的生日禮請保持 0，避免重複送。</p>
      <div className="grid-fields">
        <Field label="生日禮購物金（點）" hint="每月 1 日送給當月壽星，一年一次；0 = 不送">
          <input type="number" min={0} value={form.birthdayGiftPoints ?? 0} onChange={(e) => set("birthdayGiftPoints", Number(e.target.value))} />
        </Field>
        <Field label="生日當月回饋倍數" hint="例：2 = 當月門市消費購物金加倍">
          <input type="number" min={1} step={0.5} value={form.birthdayPointMultiplier ?? 1} onChange={(e) => set("birthdayPointMultiplier", Number(e.target.value))} />
        </Field>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存生日禮設定
      </button>
    </section>
  );
}

function RewardRules() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["rewardRules"]);
  const rules = form.rewardRules ?? [];
  const groups = settings.memberGroups ?? [];
  const tiers = (settings.memberTiers ?? []).map((t) => t.name);
  const setRule = (i: number, patch: Partial<RewardRule>) => set("rewardRules", rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggle = (list: string[] | undefined, v: string) => ((list ?? []).includes(v) ? (list ?? []).filter((x) => x !== v) : [...(list ?? []), v]);
  return (
    <div className="reward-rules">
      <h3>回饋規則（門市結帳）</h3>
      <p className="muted small">
        門市結帳時依規則送購物金到客人的 meepShop 帳戶（網店訂單的回饋由 meepShop 自己發，不會重複）。符合多條時取送最多的一條，再乘上會員等級、生日月的倍數。
      </p>
      {rules.map((r, i) => (
        <div key={i} className="card rule-card">
          <div className="row-between">
            <input value={r.name} onChange={(e) => setRule(i, { name: e.target.value })} placeholder="規則名稱，例：回饋甘爹" style={{ maxWidth: 260 }} />
            <div className="btn-row">
              <label className="check">
                <input type="checkbox" checked={r.active} onChange={(e) => setRule(i, { active: e.target.checked })} /> 啟用
              </label>
              <button className="btn btn-sm btn-ghost" onClick={() => set("rewardRules", rules.filter((_, j) => j !== i))}>
                刪除
              </button>
            </div>
          </div>
          <div className="inline-form">
            <span>每消費 $</span>
            <input type="number" min={1} value={r.every} onChange={(e) => setRule(i, { every: Number(e.target.value) })} style={{ flex: "0 0 90px" }} />
            <span>送購物金 $</span>
            <input type="number" min={1} value={r.points} onChange={(e) => setRule(i, { points: Number(e.target.value) })} style={{ flex: "0 0 80px" }} />
            <span>，消費 $</span>
            <input type="number" min={0} value={r.minSpend ?? 1} onChange={(e) => setRule(i, { minSpend: Number(e.target.value) })} style={{ flex: "0 0 90px" }} />
            <span>～ $</span>
            <input type="number" min={0} value={r.maxSpend ?? ""} placeholder="不限" onChange={(e) => setRule(i, { maxSpend: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ flex: "0 0 120px" }} />
            <span>，使用期限</span>
            <input type="number" min={0} value={r.expiryDays ?? ""} placeholder="永久" onChange={(e) => setRule(i, { expiryDays: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ flex: "0 0 80px" }} />
            <span>天</span>
          </div>
          <div className="small">適用 meepShop 群組（都不選 = 所有會員）：</div>
          <div className="chips">
            {groups.length === 0 && <span className="muted small">尚未同步到群組（會員同步後會出現）</span>}
            {groups.map((g) => (
              <button key={g} type="button" className={`chip ${(r.groups ?? []).includes(g) ? "active" : ""}`} onClick={() => setRule(i, { groups: toggle(r.groups, g) })}>
                {g}
              </button>
            ))}
          </div>
          {tiers.length > 0 && (
            <>
              <div className="small">或限本系統等級（都不選 = 不限）：</div>
              <div className="chips">
                {tiers.map((g) => (
                  <button key={g} type="button" className={`chip ${(r.tiers ?? []).includes(g) ? "active" : ""}`} onClick={() => setRule(i, { tiers: toggle(r.tiers, g) })}>
                    {g}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ))}
      <div className="btn-row">
        <button className="btn btn-sm" onClick={() => set("rewardRules", [...rules, { name: "", active: true, every: 10, points: 1, minSpend: 1, expiryDays: 365 }])}>
          ＋ 新增回饋規則
        </button>
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={save}>
          儲存回饋規則
        </button>
      </div>
    </div>
  );
}

/** LINE 會員卡（LIFF）設定 */
function LineLoginSettings() {
  const { form, set, save, busy } = useSettingsForm(["lineLogin", "shopName"]);
  const v = form.lineLogin ?? {};
  return (
    <section className="card">
      <h2>LINE 會員卡</h2>
      <p className="muted small">
        客人在 LINE 官方帳號點「會員卡」→ LINE 自動登入 → 第一次用手機＋Email 綁定會員 → 之後直接出示會員條碼。需要在 LINE Developers 建「LINE Login」頻道與 LIFF（Endpoint URL 填 {location.origin}/line）。
      </p>
      <div className="grid-fields">
        <Field label="LINE Login Channel ID">
          <input value={v.channelId ?? ""} onChange={(e) => set("lineLogin", { ...v, channelId: e.target.value.trim() })} placeholder="例：2001234567" />
        </Field>
        <Field label="LIFF ID">
          <input value={v.liffId ?? ""} onChange={(e) => set("lineLogin", { ...v, liffId: e.target.value.trim() })} placeholder="例：2001234567-AbCdEfGh" />
        </Field>
      </div>
      {v.liffId && (
        <>
          <p className="small">
            圖文選單連結請設成：<code>https://liff.line.me/{v.liffId}</code>
          </p>
          <div className="card-handoff">
            <QrImg value={`https://liff.line.me/${v.liffId}`} size={140} />
            <div className="small">
              <strong>門市立牌用 QR</strong>：客人用手機相機掃描 → 在 LINE 打開 → 綁定會員卡。
              <br />
              <button className="btn btn-sm" onClick={() => printLinePoster(`https://liff.line.me/${v.liffId}`, form.shopName ?? "ganbaru29")}>
                列印立牌
              </button>
            </div>
          </div>
        </>
      )}
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存
      </button>
    </section>
  );
}

/** 門市立牌：掃 QR 用 LINE 綁定會員卡 */
async function printLinePoster(url: string, shop: string) {
  const QR = await import("qrcode");
  const img = await QR.toDataURL(url, { margin: 1, width: 900 });
  const w = window.open("", "_blank");
  if (!w) return alert("請允許彈出式視窗");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>LINE 會員卡</title><style>
  body{font-family:"PingFang TC","Noto Sans TC",sans-serif;text-align:center;margin:0;padding:20mm}
  h1{font-size:28pt;margin:0 0 4mm}h2{font-size:18pt;color:#06c755;margin:0 0 8mm}img{width:110mm}
  ol{display:inline-block;text-align:left;font-size:14pt;line-height:1.8}</style></head><body>
  <h1>${shop} 會員卡</h1><h2>用 LINE 掃描，加入／綁定會員</h2><img src="${img}"><ol>
  <li>打開手機相機或 LINE，掃描上方 QR code</li><li>第一次請輸入手機和 Email 綁定（沒有會員可直接註冊）</li>
  <li>結帳時出示會員條碼，累積購物金</li></ol><script>onload=()=>print()</script></body></html>`);
  w.document.close();
}
