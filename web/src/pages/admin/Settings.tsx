import { collection, doc, onSnapshot, orderBy, query, setDoc, updateDoc, type Timestamp } from "firebase/firestore";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth";
import { Badge, Field, useAction, useToast } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { BUILTIN_PAY, fmtTime, payMethodList, ROLE_LABEL, type PayMethodDef, type Role } from "../../lib/util";
import type { AlertPrefs, RewardRule, ShopSettings, TierCond, TierDef } from "../../types";
import { DEFAULT_EXPENSE_CATEGORIES } from "./Expenses";
import { ADMIN_NAV, applyNavConfig, NAV_LOCKED } from "../../components/Layout";
import { QrImg } from "../../components/QrImg";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { storage } from "../../firebase";
import { DEFAULT_SOUND, playCheckoutSound, SOUND_PRESETS, SOUND_WHEN_LABEL, type CheckoutSound, type SoundChoice, type SoundPreset, type SoundRule, type SoundWhen } from "../../lib/sound";

/** 設定分類（同 meepShop 設定頁：先選分類，再進去設定） */
const SECTIONS: { id: string; icon: string; title: string; desc: string; render: () => ReactNode }[] = [
  { id: "staff", icon: "👥", title: "員工管理", desc: "邀請員工、改角色、停用帳號", render: () => <Staff /> },
  {
    id: "shop",
    icon: "🏪",
    title: "商店設定",
    desc: "店名、收據表頭表尾、班別、服務費、門市（多店）",
    render: () => (
      <>
        <PosSettings />
        <LocationSettings />
      </>
    ),
  },
  {
    id: "payment",
    icon: "💲",
    title: "金流管理",
    desc: "付款方式、綠界／藍新掃碼付款、LINE Pay、電子發票",
    render: () => (
      <>
        <PayMethodSettings />
        <PayDisplaySettings />
        <PaymentSettings />
      </>
    ),
  },
  { id: "sound", icon: "🔔", title: "結帳音效", desc: "結帳完成的聲音、上傳音樂、依會員生日／群組換聲音", render: () => <SoundSettings /> },
  { id: "lineoa", icon: "💬", title: "LINE 官方帳號", desc: "圖文選單、會員卡、消費紀錄、新品、本月活動、門市資訊", render: () => <LineOaSettings /> },
  { id: "notify", icon: "📣", title: "通知設定", desc: "每天 9:00 LINE 提醒：營業額、低庫存、滯銷、壽星", render: () => <Alerts /> },
  {
    id: "integrations",
    icon: "🔌",
    title: "第三方設定",
    desc: "meepShop API 金鑰、Google Merchant Center 商品圖、LINE 會員卡",
    render: () => (
      <>
        <ApiKey />
        <MerchantSettings />
        <LineLoginSettings />
      </>
    ),
  },
  { id: "money", icon: "🧮", title: "抽成與開支", desc: "員工業績抽成、開支分類", render: () => <StaffMoneySettings /> },
  { id: "menu", icon: "☰", title: "側邊選單", desc: "調整後台選單順序、隱藏不用的項目", render: () => <NavSettings /> },
];

export function Settings() {
  const { section } = useParams();
  const nav = useNavigate();
  const cur = SECTIONS.find((x) => x.id === section);
  if (cur)
    return (
      <div className="page">
        <div className="settings-back">
          <button className="link-btn" onClick={() => nav("/admin/settings")}>
            ‹ 設定
          </button>
        </div>
        <h1>{cur.title}</h1>
        {cur.render()}
      </div>
    );
  return (
    <div className="page">
      <h1>設定</h1>
      <div className="settings-grid">
        {SECTIONS.map((x) => (
          <Link key={x.id} to={`/admin/settings/${x.id}`} className="settings-tile">
            <span className="settings-icon">{x.icon}</span>
            <span>
              <strong>{x.title}</strong>
              <small>{x.desc}</small>
            </span>
          </Link>
        ))}
        <Link to="/admin/help" className="settings-tile">
          <span className="settings-icon">📖</span>
          <span>
            <strong>使用說明書</strong>
            <small>開班、收銀、退貨、日結、會員、進貨、盤點…每一步都有圖解</small>
          </span>
        </Link>
      </div>
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

const ALERT_ITEMS: { key: keyof Omit<AlertPrefs, "slowDays">; label: string; desc: string }[] = [
  { key: "dailySales", label: "昨天營業額", desc: "門市筆數與金額（扣退款）＋網店筆數與金額" },
  { key: "lowStock", label: "低庫存", desc: "庫存低於「安全庫存」的款式（安全庫存在庫存查詢設定，0 = 不提醒）" },
  { key: "slowMoving", label: "滯銷商品", desc: "有庫存、但超過指定天數門市和網店都沒賣出的款式" },
  { key: "birthdays", label: "今天生日的會員", desc: "方便店員打招呼、傳祝福" },
  { key: "sync", label: "庫存同步失敗", desc: "有異動沒同步到網店、或結果不明需要確認時" },
  { key: "labels", label: "新商品還沒印 QR 標籤", desc: "meepShop 新上架、還沒印吊牌的款式" },
  { key: "expiry", label: "批號快到期", desc: "進貨時有填「有效期限」的批次快到期（服飾通常不用，保養品、食品才需要）" },
];
const DEFAULT_ALERTS: AlertPrefs = { lowStock: true, expiry: false, sync: true, labels: true, dailySales: true, slowMoving: false, slowDays: 60, birthdays: false };

function Alerts() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["lineTargets", "leadDays", "expiryDays", "alerts"]);
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const { busy: b2, run } = useAction();
  const a = { ...DEFAULT_ALERTS, ...(form.alerts ?? {}) };
  const upd = (patch: Partial<AlertPrefs>) => set("alerts", { ...a, ...patch });
  return (
    <section className="card">
      <h2>提醒</h2>
      <p className="muted small">每天早上 9:00 用 LINE 推播給老闆。勾選要提醒的項目；沒有東西要提醒的項目不會出現。需要 LINE 官方帳號的 Messaging API channel（下方 token）。</p>
      <div className="alert-items">
        {ALERT_ITEMS.map((it) => (
          <label key={it.key} className="check alert-item">
            <input type="checkbox" checked={!!a[it.key]} onChange={(e) => upd({ [it.key]: e.target.checked })} />
            <span>
              <strong>{it.label}</strong>
              <small className="muted">{it.desc}</small>
              {it.key === "slowMoving" && a.slowMoving && (
                <small>
                  目前條件：{settings.slowRule?.days ?? 60} 天沒賣出、上架未滿 {settings.slowRule?.newDays ?? 60} 天不算（在「庫存查詢 → 滯銷條件」修改）
                </small>
              )}
              {it.key === "expiry" && a.expiry && (
                <span className="inline-num">
                  到期前 <input inputMode="numeric" value={String(form.expiryDays ?? 30)} onChange={(e) => set("expiryDays", Number(e.target.value.replace(/\D/g, "")) || 0)} /> 天提醒
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      <div className="grid-fields">
        <Field label="LINE 推播對象（userId / groupId，一行一個）" hint="把官方帳號加為好友後，可從 webhook 或 LINE Developers 取得 userId">
          <textarea rows={3} value={(form.lineTargets ?? []).join("\n")} onChange={(e) => set("lineTargets", e.target.value.split(/\s+/).filter(Boolean))} />
        </Field>
        <Field label="補貨到貨天數" hint="廠商下單到貨要幾天，用來算「建議補貨量」">
          <input inputMode="numeric" value={String(form.leadDays ?? 7)} onChange={(e) => set("leadDays", Number(e.target.value.replace(/\D/g, "")) || 0)} />
        </Field>
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          儲存提醒設定
        </button>
        <button className="btn" disabled={b2} onClick={() => run(async () => setPreview((await call<{ text: string }>("previewDailyAlert")).text))}>
          {b2 ? "產生中…" : "預覽今天的提醒"}
        </button>
      </div>
      {preview && <pre className="alert-preview">{preview}</pre>}
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

/** 側邊選單：調整順序、隱藏不用的項目（全店員工一起套用） */
function NavSettings() {
  const { form, set, save, busy } = useSettingsForm(["navConfig"]);
  const cfg = form.navConfig ?? {};
  const hidden = new Set(cfg.hidden ?? []);
  const ordered = applyNavConfig(ADMIN_NAV, { order: cfg.order }); // 只排序、不隱藏，才能在這裡全部列出
  const order = ordered.map((n) => n.to);
  const move = (i: number, d: number) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set("navConfig", { ...cfg, order: next });
  };
  const toggle = (to: string) => {
    const h = new Set(hidden);
    if (h.has(to)) h.delete(to);
    else h.add(to);
    set("navConfig", { ...cfg, order, hidden: [...h] });
  };
  const roleText = (r: Role) => (r === "owner" ? "老闆" : r === "manager" ? "店長以上" : "所有人");
  return (
    <section className="card">
      <h2>側邊選單</h2>
      <p className="muted small">調整後台左邊選單的順序（↑↓），取消勾選就不顯示（例：沒在用調貨就隱藏）。全店一起套用；每個人還是只看得到自己權限內的項目。「設定」「使用說明」一定會顯示。</p>
      <div className="nav-cfg">
        {ordered.map((n, i) => (
          <div key={n.to} className="nav-cfg-item">
            <div className="nav-cfg-row">
              <label className="check">
                <input type="checkbox" checked={!hidden.has(n.to) || NAV_LOCKED.includes(n.to)} disabled={NAV_LOCKED.includes(n.to) || !!n.children} onChange={() => toggle(n.to)} />
                <span className="nav-icon">{n.icon}</span> {n.label}
              </label>
              <span className="muted small">{roleText(n.min)}</span>
              <span className="grow" />
              <button type="button" className="btn-icon" disabled={i === 0} onClick={() => move(i, -1)} title="上移">
                ↑
              </button>
              <button type="button" className="btn-icon" disabled={i === ordered.length - 1} onClick={() => move(i, 1)} title="下移">
                ↓
              </button>
            </div>
            {n.children?.map((c) => (
              <label key={c.to} className="check nav-cfg-sub">
                <input type="checkbox" checked={!hidden.has(c.to) || NAV_LOCKED.includes(c.to)} disabled={NAV_LOCKED.includes(c.to)} onChange={() => toggle(c.to)} /> {c.label}
                <span className="muted small">　{roleText(c.min)}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          儲存側邊選單
        </button>
        <button className="btn btn-ghost" onClick={() => set("navConfig", { order: [], hidden: [] })}>
          恢復預設
        </button>
      </div>
    </section>
  );
}

/** 選一種聲音：內建或上傳音樂／影片（自動轉 mp3、剪成短音效），可試聽 */
function SoundPicker({ value, volume, onChange }: { value: SoundChoice; volume: number; onChange: (v: SoundChoice) => void }) {
  const { busy, run } = useAction();
  const [clip, setClip] = useState({ start: 0, duration: 5 });
  const [step, setStep] = useState("");
  const upload = (file: File) =>
    run(async () => {
      if (!/^(audio|video)\//.test(file.type)) throw new Error("請選擇音檔或影片（mp3、m4a、wav、mp4、mov）");
      if (file.size > 100 * 1024 * 1024) throw new Error("檔案請小於 100MB");
      try {
        setStep("上傳中…");
        const path = `soundsrc/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${(file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
        await uploadBytes(ref(storage, path), file, { contentType: file.type });
        setStep("轉成 mp3…");
        const r = await call<{ url: string }>("convertSound", { path, start: clip.start, duration: clip.duration });
        const name = `${file.name.replace(/\.[^.]+$/, "")}（${clip.start}～${clip.start + clip.duration} 秒）.mp3`;
        onChange({ preset: "custom", customUrl: r.url, customName: name });
        playCheckoutSound({ preset: "custom", customUrl: r.url, enabled: true, volume }, true);
      } finally {
        setStep("");
      }
    }, "已轉成 mp3，記得按儲存");
  return (
    <div className="sound-picker">
      <select value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value as SoundPreset })}>
        {SOUND_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom" disabled={!value.customUrl}>
          自訂音樂{value.customName ? `：${value.customName}` : "（先上傳）"}
        </option>
      </select>
      <button type="button" className="btn btn-sm" onClick={() => playCheckoutSound({ ...value, enabled: true, volume }, true)}>
        ▶ 試聽
      </button>
      <span className="clip-range small muted">
        取第
        <input type="number" min={0} max={600} value={clip.start} onChange={(e) => setClip({ ...clip, start: Math.max(0, Number(e.target.value)) })} />
        秒起
        <input type="number" min={1} max={30} value={clip.duration} onChange={(e) => setClip({ ...clip, duration: Math.min(30, Math.max(1, Number(e.target.value))) })} />
        秒
      </span>
      <label className="btn btn-sm">
        {busy ? step || "處理中…" : "上傳音樂／影片"}
        <input type="file" accept="audio/*,video/*" hidden disabled={busy} onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) upload(f);
        }} />
      </label>
    </div>
  );
}

/** 結帳音效：預設聲音＋條件音效（例：會員生日播生日歌） */
function SoundSettings() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["checkoutSound"]);
  const snd = form.checkoutSound ?? DEFAULT_SOUND;
  const vol = snd.volume ?? 0.6;
  const upd = (patch: Partial<CheckoutSound>) => set("checkoutSound", { ...snd, ...patch });
  const rules = snd.rules ?? [];
  const setRule = (i: number, patch: Partial<SoundRule>) => upd({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const groups = settings.memberGroups ?? [];
  return (
    <section className="card">
      <h2>結帳音效</h2>
      <p className="muted small">可以上傳音樂或影片（mp4、mov 等），系統會自動取出聲音轉成 mp3，並剪成你設定的片段（例：取第 0 秒起 5 秒）。結帳完成時播放。可以依條件換聲音（例：會員生日播生日歌），由上到下第一個符合的條件生效，都不符合就播預設音效。iPad 請打開音量、關閉靜音。</p>
      <label className="check">
        <input type="checkbox" checked={snd.enabled} onChange={(e) => upd({ enabled: e.target.checked })} /> 結帳完成時播放音效
      </label>
      <div className="tier-body">
        <div className="tier-label">預設音效</div>
        <SoundPicker value={snd} volume={vol} onChange={(v) => upd(v)} />
        <div className="tier-label">條件音效</div>
        <div>
          {rules.map((r, i) => (
            <div key={i} className="cond-row sound-rule">
              <span>如果</span>
              <select value={r.when} onChange={(e) => setRule(i, { when: e.target.value as SoundWhen, value: e.target.value === "min_total" ? 5000 : e.target.value === "group" ? groups[0] ?? "" : null })}>
                {(Object.keys(SOUND_WHEN_LABEL) as SoundWhen[]).map((k) => (
                  <option key={k} value={k}>
                    {SOUND_WHEN_LABEL[k]}
                  </option>
                ))}
              </select>
              {r.when === "group" && (
                <select value={String(r.value ?? "")} onChange={(e) => setRule(i, { value: e.target.value })}>
                  {groups.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              )}
              {r.when === "min_total" && <input type="number" min={1} style={{ width: 110 }} value={Number(r.value ?? 0)} onChange={(e) => setRule(i, { value: Number(e.target.value) })} />}
              <span>就播</span>
              <SoundPicker value={r} volume={vol} onChange={(v) => setRule(i, v)} />
              <button type="button" className="btn-icon" title="上移" disabled={i === 0} onClick={() => upd({ rules: rules.map((x, j) => (j === i - 1 ? rules[i] : j === i ? rules[i - 1] : x)) })}>
                ↑
              </button>
              <button type="button" className="btn-icon danger" title="刪除" onClick={() => upd({ rules: rules.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => upd({ rules: [...rules, { when: "birthday_today", preset: "success" }] })}>
            ⊕ 新增條件
          </button>
        </div>
        <div className="tier-label">音量</div>
        <div className="cond-row">
          <input type="range" min={0.1} max={1} step={0.1} value={vol} onChange={(e) => upd({ volume: Number(e.target.value) })} style={{ width: 200 }} /> {Math.round(vol * 100)}%
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存音效設定
      </button>
    </section>
  );
}

function PosSettings() {
  const { form, set, save, busy } = useSettingsForm(["shopName", "rewardPercent", "pointValue", "staffCanRefund", "serviceFeeDefault", "receiptHeader", "receiptFooter", "shiftNames", "siteBaseUrl", "openHours", "noDiscountTags", "autoReceiptMail"]);
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
        <Field label="營業時間" hint="報表「時段」只顯示營業時間">
          <div className="inline-form" style={{ margin: 0 }}>
            <select value={form.openHours?.from ?? 15} onChange={(e) => set("openHours", { from: Number(e.target.value), to: form.openHours?.to ?? 22 })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
            ～
            <select value={form.openHours?.to ?? 22} onChange={(e) => set("openHours", { from: form.openHours?.from ?? 15, to: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </div>
        </Field>
        <label className="check">
          <input type="checkbox" checked={form.autoReceiptMail !== false} onChange={(e) => set("autoReceiptMail", e.target.checked)} /> 結帳完自動寄消費明細給客人（有會員 Email 或線上刷卡 Email 時）
        </label>
        <Field label="不再折扣的標籤（逗號分隔）" hint="有這些 meepShop 標籤的商品，在 POS 不參加優惠活動、會員折扣、整單打折（店員手動單品打折仍可）">
          <input value={(form.noDiscountTags ?? ["特價專區"]).join(",")} onChange={(e) => set("noDiscountTags", e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))} />
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



/** 舊版設定（累計滿／單次滿）轉成新格式 */
function normalizeTier(t: TierDef): TierDef {
  if (t.upgrade) return { enabled: true, ...t };
  const conds: TierCond[] = [];
  if (t.minSingle) conds.push({ kind: "single", amount: t.minSingle, months: 12 });
  if (t.minSpend) conds.push({ kind: "cumulative", amount: t.minSpend, months: 12 });
  return { ...t, enabled: true, validityMonths: conds.length ? 12 : null, upgrade: conds, renew: conds.map((c) => ({ kind: c.kind, amount: c.amount })) };
}

/** 一列條件：（在 N 年／月 內）[單次購物｜累計購物] 消費金額 X 元 */
function CondRow({ c, withPeriod, onChange, onRemove, onAdd }: { c: TierCond; withPeriod: boolean; onChange: (c: TierCond) => void; onRemove: () => void; onAdd?: () => void }) {
  const months = c.months ?? 12;
  const unit = months % 12 === 0 ? "year" : "month";
  return (
    <div className="cond-row">
      {withPeriod && (
        <>
          <span className="muted">在</span>
          <input type="number" min={1} value={unit === "year" ? months / 12 : months} onChange={(e) => onChange({ ...c, months: (Number(e.target.value) || 1) * (unit === "year" ? 12 : 1) })} style={{ width: 64 }} />
          <select value={unit} onChange={(e) => onChange({ ...c, months: e.target.value === "year" ? Math.max(1, Math.round(months / 12)) * 12 : months })}>
            <option value="year">年</option>
            <option value="month">個月</option>
          </select>
          <span className="muted">內</span>
        </>
      )}
      <select value={c.kind} onChange={(e) => onChange({ ...c, kind: e.target.value as TierCond["kind"] })}>
        <option value="single">單次購物</option>
        <option value="cumulative">累計購物</option>
      </select>
      <span className="muted">消費金額</span>
      <input type="number" min={0} value={c.amount} onChange={(e) => onChange({ ...c, amount: Number(e.target.value) })} style={{ width: 130 }} />
      <span className="muted">元</span>
      <select value={c.basis ?? "paid"} onChange={(e) => onChange({ ...c, basis: e.target.value as TierCond["basis"] })} title="有打折時金額怎麼算">
        <option value="paid">實付（折扣後）</option>
        <option value="list">原價（折扣前，有打折也算）</option>
      </select>
      <button type="button" className="btn-icon" onClick={onRemove} title="刪除條件">
        ⊗
      </button>
      {onAdd && (
        <button type="button" className="btn-icon add" onClick={onAdd} title="新增條件（任一達成即可）">
          ⊕
        </button>
      )}
    </div>
  );
}

/** 會員等級：與 meepShop「顧客群組」相同的設定方式 */
export function MemberSettings() {
  const { settings } = useData();
  const { form, set, save, busy } = useSettingsForm(["memberTiers"]);
  const { busy: b2, run } = useAction();
  const tiers = (form.memberTiers ?? []).map(normalizeTier);
  const setTier = (i: number, patch: Partial<TierDef>) => set("memberTiers", tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const baseIdx = tiers.findIndex((t) => !t.upgrade?.length);
  const conds = (i: number, key: "upgrade" | "renew") => tiers[i][key] ?? [];
  const setConds = (i: number, key: "upgrade" | "renew", list: TierCond[]) => setTier(i, { [key]: list } as Partial<TierDef>);

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>會員等級</h1>
          <div className="muted small">
            規則與 meepShop「顧客群組」相同，但同時計算門市＋網店（已結案）消費；每天凌晨自動升級、到期判斷續會。meepShop 的群組不會被改動。
            {settings.tiersAt && ` 上次計算：${fmtTime(settings.tiersAt)}`}
            {settings.tiersError && <span className="error"> 計算失敗：{settings.tiersError}</span>}
          </div>
        </div>
      </div>

      {tiers.map((t, i) =>
        i === baseIdx ? (
          <div key={i} className="card tier-card">
            <div className="tier-head">
              <span className="tier-switch on" title="基本等級：所有會員預設" />
              <label className="tier-name">
                <small>群組名稱（基本等級）</small>
                <input value={t.name} onChange={(e) => setTier(i, { name: e.target.value })} />
              </label>
              <span className="muted small">所有會員預設在這個等級；高等級到期沒續會也會回到這裡。</span>
            </div>
          </div>
        ) : (
          <div key={i} className={`card tier-card ${t.enabled === false ? "off" : ""}`}>
            <div className="tier-head">
              <button type="button" className={`tier-switch ${t.enabled === false ? "" : "on"}`} onClick={() => setTier(i, { enabled: t.enabled === false })} aria-label="啟用" />
              <label className="tier-name">
                <small>群組名稱</small>
                <input value={t.name} onChange={(e) => setTier(i, { name: e.target.value })} />
              </label>
              <label className="tier-validity">
                <small>使用期限</small>
                <select value={t.validityMonths ? String(t.validityMonths) : "0"} onChange={(e) => setTier(i, { validityMonths: Number(e.target.value) || null })}>
                  <option value="0">永久</option>
                  <option value="3">3 個月</option>
                  <option value="6">6 個月</option>
                  <option value="12">1 年</option>
                  <option value="24">2 年</option>
                </select>
              </label>
              <button className="btn btn-sm btn-ghost" onClick={() => confirm(`刪除「${t.name}」？`) && set("memberTiers", tiers.filter((_, j) => j !== i))}>
                刪除
              </button>
            </div>
            <div className="tier-body">
              <div className="tier-label">升級資格</div>
              <div>
                {conds(i, "upgrade").map((c, k, arr) => (
                  <CondRow
                    key={k}
                    c={c}
                    withPeriod
                    onChange={(n) => setConds(i, "upgrade", arr.map((x, j) => (j === k ? n : x)))}
                    onRemove={() => setConds(i, "upgrade", arr.filter((_, j) => j !== k))}
                    onAdd={k === 0 ? () => setConds(i, "upgrade", [...arr, { kind: "cumulative", amount: 0, months: 12 }]) : undefined}
                  />
                ))}
                {!conds(i, "upgrade").length && (
                  <button className="btn btn-sm" onClick={() => setConds(i, "upgrade", [{ kind: "single", amount: 0, months: 12 }])}>
                    ＋ 新增升級條件
                  </button>
                )}
              </div>
              {t.validityMonths ? (
                <>
                  <div className="tier-label">續會資格</div>
                  <div>
                    {conds(i, "renew").map((c, k, arr) => (
                      <CondRow
                        key={k}
                        c={c}
                        withPeriod={false}
                        onChange={(n) => setConds(i, "renew", arr.map((x, j) => (j === k ? n : x)))}
                        onRemove={() => setConds(i, "renew", arr.filter((_, j) => j !== k))}
                        onAdd={k === 0 ? () => setConds(i, "renew", [...arr, { kind: "cumulative", amount: 0 }]) : undefined}
                      />
                    ))}
                    {!conds(i, "renew").length && (
                      <button className="btn btn-sm" onClick={() => setConds(i, "renew", [{ kind: "single", amount: 0 }])}>
                        ＋ 新增續會條件
                      </button>
                    )}
                    <div className="muted small">使用期限內達成任一條件，到期就自動續一期；沒達成就回到基本等級。</div>
                  </div>
                </>
              ) : null}
            </div>
            <div className="muted small">升級資格任一達成即升級。</div>
          </div>
        )
      )}

      <div className="btn-row">
        {baseIdx < 0 && (
          <button className="btn btn-sm" onClick={() => set("memberTiers", [{ name: "尊貴的客人", enabled: true, upgrade: [] }, ...tiers])}>
            ＋ 新增基本等級
          </button>
        )}
        <button className="btn btn-sm" onClick={() => set("memberTiers", [...tiers, { name: "", enabled: true, validityMonths: 12, upgrade: [{ kind: "single", amount: 0, months: 12 }], renew: [{ kind: "single", amount: 0 }] }])}>
          ＋ 新增等級
        </button>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            if (tiers.some((t) => !t.name.trim())) return alert("等級名稱不能空白");
            set("memberTiers", tiers);
            save();
          }}
        >
          儲存會員等級
        </button>
        <button
          className="btn"
          disabled={b2}
          onClick={() =>
            run(async () => {
              const r = await call<{ updated: number; error: string | null }>("recomputeMemberTiers");
              if (r.error) throw new Error(r.error);
              return r;
            }, "會員等級已重新計算")
          }
        >
          {b2 ? "計算中…" : "立即重算等級"}
        </button>
      </div>
      <p className="muted small">會員的結帳折扣（例：甘爹 85 折）請在「行銷 → 促銷活動」設定，可以指定 meepShop 群組或本系統等級。</p>
    </section>
  );
}

const CRED_LABEL: Record<string, string> = { ecpay_payment: "綠界金流", newebpay_payment: "藍新金流", ecpay_invoice: "綠界電子發票" };

/** 寄付款連結用的信箱：Gmail／Google Workspace 用「應用程式密碼」；其他官方信箱填寄信伺服器（SMTP） */
function MailCredForm({ current, onSaved }: { current: string | null | undefined; onSaved: () => void }) {
  const [f, setF] = useState({ user: "", pass: "", host: "smtp.gmail.com", port: "465" });
  const { busy, run } = useAction();
  const google = f.host === "smtp.gmail.com";
  return (
    <div className="cred-form">
      <div className="row-between">
        <strong>寄付款連結的信箱</strong>
        {current ? <Badge tone="ok">已設定：{current}</Badge> : <Badge>未設定</Badge>}
      </div>
      <p className="muted small">
        信用卡「傳付款連結」由這個信箱寄給客人，寄件人名稱是店名。
        <br />・Gmail 或 Google Workspace（官方網域信箱用 Google 的）：伺服器選 Google，密碼用「應用程式密碼」——Google 帳戶 → 安全性 → 兩步驟驗證（先開啟）→ 應用程式密碼 → 建立一組（16 個英文字母）。
        <br />・其他官方信箱（主機商、Outlook 等）：選「其他」，填信箱商提供的 SMTP 伺服器、連接埠和信箱密碼。
      </p>
      <div className="inline-form">
        <select value={google ? "google" : "other"} onChange={(e) => setF({ ...f, host: e.target.value === "google" ? "smtp.gmail.com" : "", port: "465" })}>
          <option value="google">Google（Gmail／Workspace）</option>
          <option value="other">其他（自己填 SMTP）</option>
        </select>
        {!google && (
          <>
            <input placeholder="SMTP 伺服器（例：smtp.office365.com）" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value.trim() })} />
            <select value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })}>
              <option value="465">465（SSL）</option>
              <option value="587">587（STARTTLS）</option>
            </select>
          </>
        )}
      </div>
      <div className="inline-form">
        <input type="email" placeholder="寄件信箱（例：service@ganbaru29.com）" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value.trim() })} />
        <input type="password" autoComplete="off" placeholder={google ? "應用程式密碼（16 碼）" : "信箱密碼"} value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} />
        <button className="btn" disabled={busy || !f.user || !f.pass || !f.host} onClick={() => run(async () => {
          await call("setMailCreds", { ...f, port: Number(f.port) });
          setF({ user: "", pass: "", host: "smtp.gmail.com", port: "465" });
          onSaved();
        }, "已儲存（已測試登入成功）")}>
          儲存
        </button>
      </div>
    </div>
  );
}

function CredForm({ kind, current, mask, onSaved }: { kind: string; current: string | null | undefined; mask?: string | null; onSaved: () => void }) {
  const [f, setF] = useState({ merchantId: "", hashKey: "", hashIv: "" });
  const { busy, run } = useAction();
  return (
    <div className="cred-form">
      <div className="row-between">
        <strong>{CRED_LABEL[kind]}</strong>
        {current ? (
          <span className="cred-set">
            <Badge tone="ok">已設定：商店代號 {current}</Badge>
            {mask && <small className="muted mono">{mask}</small>}
          </span>
        ) : <Badge>未設定{kind.startsWith("ecpay") ? "（測試環境會用綠界公用測試帳號）" : ""}</Badge>}
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

/** 付款方式（同 meepShop「物流管理」的樣子）：開關、改名、排序、新增自訂方式 */
/** 顧客螢幕：客人選轉帳／LINE Pay 時，平板顯示的帳號與 QR code */
function PayDisplaySettings() {
  const { settings } = useData();
  const [v, setV] = useState(settings.payDisplay ?? {});
  const { busy, run } = useAction();
  const dirty = JSON.stringify(v) !== JSON.stringify(settings.payDisplay ?? {});
  const upload = (key: "transferQrUrl" | "linepayQrUrl", file: File) =>
    run(async () => {
      if (!file.type.startsWith("image/")) throw new Error("請選擇圖片（QR code 截圖）");
      const path = `paydisplay/${key}-${Date.now()}.${(file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      setV((x) => ({ ...x, [key]: "" }));
      const url = await getDownloadURL(ref(storage, path));
      setV((x) => ({ ...x, [key]: url }));
    }, "已上傳，記得按儲存");
  const qr = (key: "transferQrUrl" | "linepayQrUrl", label: string) => (
    <div className="paydisp-qr">
      <div className="muted small">{label}</div>
      {v[key] ? <img src={v[key]} alt="" /> : <div className="paydisp-empty">未上傳</div>}
      <label className="btn btn-sm">
        {v[key] ? "更換" : "上傳 QR 圖片"}
        <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && upload(key, e.target.files[0])} />
      </label>
      {v[key] && (
        <button className="btn btn-sm btn-ghost" onClick={() => setV((x) => ({ ...x, [key]: "" }))}>
          移除
        </button>
      )}
    </div>
  );
  return (
    <section className="card">
      <h2>顧客螢幕（平板給客人看）</h2>
      <p className="muted small">
        平板登入後按 POS 選單的「顧客螢幕」，放在櫃台面向客人。收銀電腦加商品，平板會跟著顯示品項和金額；結帳選「轉帳」或「LINE Pay」時，平板顯示下面的帳號和 QR code，按完成結帳後自動換成「謝謝光臨」。
      </p>
      <div className="paydisp-fields">
        <Field label="轉帳銀行（例：822 中國信託）">
          <input value={v.transferBank ?? ""} onChange={(e) => setV({ ...v, transferBank: e.target.value })} />
        </Field>
        <Field label="帳號">
          <input value={v.transferAccount ?? ""} inputMode="numeric" onChange={(e) => setV({ ...v, transferAccount: e.target.value.replace(/[^\d-]/g, "") })} />
        </Field>
        <Field label="戶名">
          <input value={v.transferName ?? ""} onChange={(e) => setV({ ...v, transferName: e.target.value })} />
        </Field>
      </div>
      <div className="paydisp-qrs">
        {qr("transferQrUrl", "轉帳 QR（銀行 App「收款碼」截圖）")}
        {qr("linepayQrUrl", "LINE Pay 收款 QR（店家 QR code）")}
      </div>
      <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => run(() => setDoc(doc(db, "settings", "shop"), { payDisplay: v }, { merge: true }), "已儲存")}>
        儲存
      </button>
    </section>
  );
}

/** LINE 官方帳號（29_STUDIO_TC）：狀態、門市資訊、本月活動、圖文選單開關 */
function LineOaSettings() {
  const { settings } = useData();
  const [v, setV] = useState(settings.lineBot ?? {});
  const [st, setSt] = useState<{ ok: boolean; name?: string; basicId?: string; quota?: number | null; used?: number; bound?: number; error?: string } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    call<typeof st>("lineBotStatus").then(setSt).catch((e) => setSt({ ok: false, error: (e as Error).message }));
  }, []);
  const dirty = JSON.stringify(v) !== JSON.stringify(settings.lineBot ?? {});
  const uploadImg = (file: File) =>
    run(async () => {
      if (!file.type.startsWith("image/")) throw new Error("請選擇圖片");
      const path = `paydisplay/line-monthly-${Date.now()}.${(file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      await uploadBytes(ref(storage, path), file, { contentType: file.type });
      const url = await getDownloadURL(ref(storage, path));
      setV((x) => ({ ...x, monthlyImageUrl: url }));
    }, "已上傳，記得按儲存");
  const f = (k: keyof NonNullable<ShopSettings["lineBot"]>, label: string, ph = "") => (
    <Field label={label}>
      <input value={(v[k] as string) ?? ""} placeholder={ph} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </Field>
  );
  return (
    <section className="card">
      <h2>LINE 官方帳號</h2>
      {st === null ? (
        <p className="muted">讀取中…</p>
      ) : st.ok ? (
        <p>
          <Badge tone="ok">已連線</Badge> {st.name}（{st.basicId}）・已綁定會員 <b>{st.bound}</b> 人・本月推播已用 {st.used}／{st.quota ?? "不限"} 則
          <br />
          <span className="muted small">客人點圖文選單得到的回覆不算則數；只有主動推播（例如新品通知）才會用掉。</span>
        </p>
      ) : (
        <p className="notice notice-bad">連線失敗：{st.error}</p>
      )}

      <h3>圖文選單</h3>
      <p className="muted small">6 個按鈕：會員卡、消費紀錄、新品、本月活動、門市資訊、逛官網。打開後所有好友都會看到。</p>
      <label className="check">
        <input
          type="checkbox"
          checked={!!settings.lineBot?.richMenuOn}
          disabled={busy || !settings.lineBot?.richMenuId}
          onChange={(e) => run(() => call("setLineRichMenu", { on: e.target.checked }), e.target.checked ? "圖文選單已上線" : "已關閉圖文選單")}
        />{" "}
        顯示 ganbaru29 圖文選單
      </label>

      <h3>門市資訊（「門市資訊」按鈕回覆的內容）</h3>
      <div className="paydisp-fields">
        {f("mapUrl", "Google 地圖連結", "https://maps.app.goo.gl/…")}
        {f("address", "地址", "台中市…")}
        {f("hours", "營業時間", "每天 15:00～22:00")}
        {f("phone", "電話")}
      </div>

      <h3>本月活動（「本月活動」按鈕回覆的內容）</h3>
      <Field label="活動說明" hint="會和 POS 正在進行的折扣活動一起顯示">
        <textarea rows={4} value={v.monthlyText ?? ""} onChange={(e) => setV({ ...v, monthlyText: e.target.value })} placeholder="例：10 月全館滿 3000 送 300 購物金！" />
      </Field>
      <div className="paydisp-qr">
        <div className="muted small">活動圖片（選填）</div>
        {v.monthlyImageUrl ? <img src={v.monthlyImageUrl} alt="" /> : <div className="paydisp-empty">未上傳</div>}
        <label className="btn btn-sm">
          {v.monthlyImageUrl ? "更換" : "上傳圖片"}
          <input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => e.target.files?.[0] && uploadImg(e.target.files[0])} />
        </label>
        {v.monthlyImageUrl && (
          <button className="btn btn-sm btn-ghost" onClick={() => setV({ ...v, monthlyImageUrl: "" })}>
            移除
          </button>
        )}
      </div>
      <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => run(() => setDoc(doc(db, "settings", "shop"), { lineBot: v }, { merge: true }), "已儲存")}>
        儲存
      </button>
      <LinePushPanel />
      <AiLearnPanel />
    </section>
  );
}

/** LINE 推播：選對象（客人勾的喜好）→ 寫訊息、挑商品 → 預覽人數與額度 → 發送 */
const PUSH_KINDS: [string, string, string][] = [
  ["新品通知", "勾了「新品通知」的人", "✨ 新品上架！上架一週內每件現折 $100，快來看看 👇"],
  ["特價活動", "勾了「特價活動」的人", "🔥 特價活動開跑！特價專區／直播／福袋，數量有限 👇"],
  ["長褲", "喜歡長褲的人", "👖 長褲新品上架 👇"],
  ["短褲", "喜歡短褲的人", "🩳 短褲新品上架 👇"],
  ["長袖", "喜歡長袖的人", "🧥 長袖新品上架 👇"],
  ["短袖", "喜歡短袖的人", "👕 短袖新品上架 👇"],
  ["外套", "喜歡外套的人", "🧥 外套新品上架 👇"],
  ["all", "所有綁定 LINE 的會員", "ganbaru29 最新消息 👇"],
];
function LinePushPanel() {
  const { variants } = useData();
  const [kind, setKind] = useState("新品通知");
  const [msg, setMsg] = useState(PUSH_KINDS[0][2]);
  const [pv, setPv] = useState<{ count: number; limit: number | null; used: number; left: number | null } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [logs, setLogs] = useState<{ kind: string; text: string; count: number; by: string; at: number }[]>([]);
  const { busy, run } = useAction();
  // 上架中、有照片的商品；同一款不同顏色合成一列（發送時卡片會自動帶入所有顏色），新的排前面
  const [cat, setCat] = useState("全部");
  const products = useMemo(() => {
    const split = (t: string) => {
      const m = t.match(/^(.*?)\s+(\S+?)\s*共[一二兩三四五六七八九十\d]+色\s*$/);
      return m ? { style: m[1].trim(), color: m[2] } : { style: t.trim(), color: null as string | null };
    };
    const m = new Map<string, { id: string; title: string; colors: string[]; at: number; sale: boolean; price: number; listPrice: number | null; img: string | null; cats: string[] }>();
    for (const v of variants) {
      if (v.productStatus !== "LISTED" || !(v.thumbUrl || v.imageUrl)) continue;
      const { style, color } = split(v.productTitle);
      const at = (v as unknown as { shopCreatedAt?: { toMillis?: () => number } }).shopCreatedAt?.toMillis?.() ?? 0;
      const cur = m.get(style);
      const cats = [v.posCategory, ...(v.tags ?? [])].filter(Boolean) as string[];
      if (cur) {
        if (color && !cur.colors.includes(color)) cur.colors.push(color);
        cur.at = Math.max(cur.at, at);
        cur.cats = [...new Set([...cur.cats, ...cats])];
      } else m.set(style, { id: v.productId, title: style, colors: color ? [color] : [], at, sale: (v.listPrice ?? 0) > v.price, price: v.price, listPrice: v.listPrice ?? null, img: v.thumbUrl || v.imageUrl || null, cats });
    }
    return [...m.values()].sort((a, b) => b.at - a.at);
  }, [variants]);
  const loadLogs = () => call<{ logs: typeof logs }>("linePushLogs").then((r) => setLogs(r.logs)).catch(() => undefined);
  useEffect(() => {
    setPv(null);
    call<NonNullable<typeof pv>>("linePushPreview", { kind }).then(setPv).catch(() => setPv(null));
  }, [kind]);
  useEffect(() => {
    loadLogs();
  }, []);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 10 ? p : [...p, id]));
  const list = products.filter((p) => (!q || p.title.includes(q) || p.colors.some((c) => c.includes(q))) && (cat === "全部" || (cat === "特價" ? p.sale : p.cats.includes(cat))));
  const over = !!pv && pv.left != null && pv.count > pv.left;
  return (
    <>
      <h3>LINE 推播</h3>
      <p className="muted small">只會發給「有綁定 LINE、而且勾了這一項」的客人。推播會用掉官方帳號每月額度（一人一則）；客人點選單得到的回覆不算。</p>
      <div className="paydisp-fields">
        <Field label="發給誰">
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setMsg(PUSH_KINDS.find((k) => k[0] === e.target.value)?.[2] ?? "");
            }}
          >
            {PUSH_KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className={`small ${over ? "error" : ""}`}>
        {pv ? `會發給 ${pv.count} 人・本月已用 ${pv.used}／${pv.limit ?? "不限"} 則${pv.left != null ? `，還剩 ${pv.left} 則` : ""}${over ? "（額度不夠）" : ""}` : "計算人數中…"}
      </p>
      <Field label="訊息">
        <textarea rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} />
      </Field>
      <div className="row-between">
        <b className="small">附上商品卡片（最多 10 款，已選 {picked.length}）</b>
        <span className="btn-row">
          <button className="btn btn-sm" onClick={() => setPicked(products.slice(0, 8).map((p) => p.id))}>
            最新 8 款
          </button>
          <button className="btn btn-sm" onClick={() => setPicked(products.filter((p) => p.sale).slice(0, 10).map((p) => p.id))}>
            特價商品
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicked([])}>
            清除
          </button>
        </span>
      </div>
      <input className="search" placeholder="搜尋商品名稱或顏色" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        {["全部", "長褲", "短褲", "長袖", "短袖", "外套", "特價"].map((c) => (
          <button key={c} className={`chip ${cat === c ? "active" : ""}`} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
        <span className="muted small">共 {list.length} 款</span>
      </div>
      <div className="push-list">
        {list.map((p) => (
          <label key={p.id} className={`push-item ${picked.includes(p.id) ? "on" : ""}`}>
            <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
            {p.img ? <img src={p.img} alt="" loading="lazy" /> : <span className="push-noimg" />}
            <span className="push-text">
              {p.title}
              {p.colors.length > 0 && <small className="muted">　{p.colors.join("・")}</small>}
            </span>
            <span className={`push-price ${p.sale ? "sale" : ""}`}>
              {p.sale && p.listPrice ? <s className="muted">${p.listPrice}</s> : null} ${p.price}
            </span>
          </label>
        ))}
        {!list.length && <p className="muted small">沒有符合的商品</p>}
      </div>
      <button
        className="btn btn-primary"
        disabled={busy || !pv?.count || over || !msg.trim()}
        onClick={() =>
          confirm(`確定發送給 ${pv?.count} 人？會用掉 ${pv?.count} 則額度。`) &&
          run(async () => {
            await call("linePushSend", { kind, text: msg, productIds: picked });
            setPicked([]);
            loadLogs();
            const r = await call<NonNullable<typeof pv>>("linePushPreview", { kind });
            setPv(r);
          }, "已發送")
        }
      >
        {busy ? "發送中…" : `發送推播（${pv?.count ?? 0} 人）`}
      </button>
      {logs.length > 0 && (
        <>
          <h4>推播紀錄</h4>
          <ul className="small">
            {logs.map((l, i) => (
              <li key={i}>
                {new Date(l.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}　{l.kind === "all" ? "全部會員" : l.kind}　{l.count} 人　{l.by}：{l.text.slice(0, 30)}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** AI 找商品：學習進度、客人找不到的字、同義詞 */
function AiLearnPanel() {
  const { settings } = useData();
  const [st, setSt] = useState<{ indexed: number; products: number; learned: number; confirmed: number; misses: { q: string; kind: string; at: number }[]; help?: { id: string; photoUrl: string | null; seen: string | null; customer: string | null; at: number; done: boolean }[] } | null>(null);
  const [syn, setSyn] = useState<[string, string][]>(() => Object.entries(settings.lineBot?.synonyms ?? {}));
  const [k, setK] = useState("");
  const [val, setVal] = useState("");
  const { busy, run } = useAction();
  const load = () => call<NonNullable<typeof st>>("aiLearnStatus").then(setSt).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  // 用 updateDoc 指定欄位路徑：整份同義詞換掉（merge 的話刪掉的字不會真的消失）
  const saveSyn = (list: [string, string][]) => run(() => updateDoc(doc(db, "settings", "shop"), { "lineBot.synonyms": Object.fromEntries(list) }), "已儲存同義詞");
  return (
    <>
      <h3>AI 找商品</h3>
      {st ? (
        <p className="small">
          以圖搜圖：已建立 <b>{st.indexed}</b> 張照片特徵（{st.products} 款商品）・客人確認「就是這件」<b>{st.confirmed}</b> 次，學到 <b>{st.learned}</b> 張照片
          <br />
          <span className="muted">特徵每 20 分鐘自動補一批；在「商品與條碼」幫商品多上傳穿搭照，找得更準。</span>{" "}
          <button className="link-btn small" disabled={busy} onClick={() => run(async () => (await call("buildImageIndex"), load()), "已補建")}>
            立即補建
          </button>
        </p>
      ) : (
        <p className="muted small">讀取中…</p>
      )}
      <h4>同義詞（客人打左邊的字，就當成右邊的字找）</h4>
      <div className="chip-row">
        {syn.map(([a, b]) => (
          <span key={a} className="member-tag">
            {a} → {b}{" "}
            <button
              className="link-btn small"
              onClick={() => {
                const n = syn.filter((x) => x[0] !== a);
                setSyn(n);
                saveSyn(n);
              }}
            >
              ✕
            </button>
          </span>
        ))}
        {!syn.length && <span className="muted small">還沒有（系統已內建：丹寧＝牛仔、襯＝襯衫）</span>}
      </div>
      <div className="inline-form">
        <input placeholder="客人會打的字（例：大學T）" value={k} onChange={(e) => setK(e.target.value.trim())} />
        <input placeholder="店裡的說法（例：衛衣）" value={val} onChange={(e) => setVal(e.target.value.trim())} />
        <button
          className="btn"
          disabled={!k || !val}
          onClick={() => {
            const n: [string, string][] = [...syn.filter((x) => x[0] !== k), [k, val]];
            setSyn(n);
            setK("");
            setVal("");
            saveSyn(n);
          }}
        >
          新增
        </button>
      </div>
      <h4>客人找不到的照片（按了「請店員幫我找」）</h4>
      {st?.help?.length ? (
        <div className="ai-help">
          {st.help.map((h) => (
            <div key={h.id} className="ai-help-item">
              {h.photoUrl ? <img src={h.photoUrl} alt="" /> : <div className="paydisp-empty">無照片</div>}
              <div className="small">
                <b>{h.customer || "客人"}</b>・{new Date(h.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                <br />
                <span className="muted">AI 看到：{h.seen || "—"}</span>
              </div>
              <button className="btn btn-sm" disabled={busy} onClick={() => run(async () => (await call("aiHelpDone", { id: h.id }), load()), "已標記處理完")}>
                處理完
              </button>
            </div>
          ))}
          <p className="muted small">請到 LINE 官方帳號後台的聊天室回覆客人；如果是店裡沒有的款，可以考慮進貨。</p>
        </div>
      ) : (
        <p className="muted small">目前沒有。</p>
      )}
      <h4>客人找不到的字（最近 40 筆）</h4>
      {st?.misses.length ? (
        <div className="chip-row">
          {st.misses.map((m, i) => (
            <span key={i} className="member-tag" title={new Date(m.at).toLocaleString("zh-TW")}>
              {m.q}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small">目前沒有。常出現的字可以加成同義詞；也可能是客人想買、店裡還沒進的商品。</p>
      )}
    </>
  );
}

function PayMethodSettings() {
  const { settings } = useData();
  const [list, setList] = useState<PayMethodDef[]>(() => payMethodList(settings.payMethods));
  const [adding, setAdding] = useState("");
  const [onlineFee, setOnlineFee] = useState(String(settings.onlineFeePct ?? ""));
  const { busy, run } = useAction();
  const dirty = JSON.stringify(list) !== JSON.stringify(payMethodList(settings.payMethods)) || onlineFee !== String(settings.onlineFeePct ?? "");
  const upd = (i: number, patch: Partial<PayMethodDef>) => setList((l) => l.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const move = (i: number, d: number) =>
    setList((l) => {
      const n = [...l];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const builtin = (k: string) => BUILTIN_PAY.some((b) => b.key === k);
  return (
    <section className="card">
      <div className="row-between">
        <h2>付款方式</h2>
      </div>
      <p className="muted small">POS 結帳畫面的付款按鈕。可以開關、改名稱、調整順序，也可以新增自訂方式（例：街口支付、悠遊付、全支付、禮券），自訂方式都是另外收款後在 POS 記帳。日結、報表會分開統計。</p>
      <div className="paym-list">
        <div className="paym-row paym-head">
          <span />
          <span>名稱</span>
          <span>手續費</span>
          <span>排序</span>
          <span />
        </div>
        {list.map((m, i) => (
          <div key={m.key} className={`paym-row ${m.enabled ? "" : "off"}`}>
            <button type="button" className={`tier-switch ${m.enabled ? "on" : ""}`} disabled={m.key === "cash"} title={m.key === "cash" ? "現金不能關閉（找零、錢櫃要用）" : m.enabled ? "關閉" : "開啟"} onClick={() => upd(i, { enabled: !m.enabled })} />
            <input value={m.label} maxLength={12} onChange={(e) => upd(i, { label: e.target.value })} />
            <span className="fee-cell">
              {m.key === "cash" ? (
                <span className="muted small">—</span>
              ) : (
                <>
                  <input inputMode="decimal" value={m.feePct ?? ""} placeholder="0" onChange={(e) => upd(i, { feePct: e.target.value === "" ? undefined : Number(e.target.value.replace(/[^\d.]/g, "")) })} />%
                </>
              )}
            </span>
            <span>
              <button type="button" className="btn-icon" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="btn-icon" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
            </span>
            <span>
              {!builtin(m.key) && (
                <button type="button" className="btn-icon danger" title="刪除（過去的交易紀錄不受影響）" onClick={() => confirm(`刪除「${m.label}」？過去用這個方式的交易紀錄不受影響。`) && setList((l) => l.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="inline-form">
        <input placeholder="新增付款方式，例：街口支付" maxLength={12} value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={!adding.trim() || list.some((m) => m.label === adding.trim())}
          onClick={() => {
            setList((l) => [...l, { key: `c_${Date.now().toString(36)}`, label: adding.trim(), enabled: true }]);
            setAdding("");
          }}
        >
          ＋ 新增
        </button>
      </div>
      <div className="inline-form">
        <span>網店（meepShop）金流手續費</span>
        <span className="addon-input">
          <input inputMode="decimal" value={onlineFee} placeholder="0" onChange={(e) => setOnlineFee(e.target.value.replace(/[^\d.]/g, ""))} />
          <span>%</span>
        </span>
        <span className="muted small">報表「實際總收入」會扣掉；不確定就填 0</span>
      </div>
      <p className="muted small">手續費 % 用在報表中心的三階損益（例：LINE Pay 5% → 交易總額 × 5%）。「掃碼付款（綠界／藍新）」「LINE Pay 串接」在下方金流設定開啟。</p>
      <button className="btn btn-primary" disabled={busy || !dirty || list.some((m) => !m.label.trim())} onClick={() =>
          run(
            () =>
              setDoc(
                doc(db, "settings", "shop"),
                { payMethods: list.map((m) => ({ ...m, label: m.label.trim(), feePct: Number(m.feePct) || 0 })), onlineFeePct: Number(onlineFee) || 0 },
                { merge: true }
              ),
            "已儲存付款方式"
          )
        }>
        儲存付款方式
      </button>
    </section>
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
        <Field label="線上刷卡手續費 %" hint="例：藍新信用卡一次付清依你的合約費率；結帳畫面顯示手續費用">
          <input type="number" step="0.01" min={0} max={20} value={pay.feePct ?? ""} onChange={(e) => set("payment", { ...pay, feePct: e.target.value === "" ? null : Number(e.target.value) })} />
        </Field>
        <Field label="金流環境">
          <select value={pay.stage ? "stage" : "prod"} onChange={(e) => set("payment", { ...pay, stage: e.target.value === "stage" })}>
            <option value="stage">測試（不會真的扣款）</option>
            <option value="prod">正式</option>
          </select>
        </Field>
      </div>
      {pay.provider === "newebpay" && (
        <div className="field">
          <div className="muted small">藍新付款頁除了信用卡，另外開放（要先向藍新申請啟用，沒啟用就勾會讓付款頁打不開）：</div>
          <div className="chip-row">
            {[
              ["APPLEPAY", "Apple Pay"],
              ["ANDROIDPAY", "Google Pay"],
              ["SAMSUNGPAY", "Samsung Pay"],
              ["LINEPAY", "LINE Pay"],
              ["TAIWANPAY", "台灣 Pay"],
            ].map(([k, l]) => (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={(pay.newebExtra ?? []).includes(k)}
                  onChange={(e) => set("payment", { ...pay, newebExtra: e.target.checked ? [...(pay.newebExtra ?? []), k] : (pay.newebExtra ?? []).filter((x) => x !== k) })}
                />{" "}
                {l}
              </label>
            ))}
          </div>
          <div className="muted small">信用卡分期（要先向藍新申請開通分期，沒開通就勾會讓付款頁打不開）：</div>
          <div className="chip-row">
            {[3, 6, 12, 18, 24, 30].map((n) => (
              <label key={n} className="check">
                <input
                  type="checkbox"
                  checked={(pay.newebInst ?? []).includes(n)}
                  onChange={(e) => set("payment", { ...pay, newebInst: (e.target.checked ? [...(pay.newebInst ?? []), n] : (pay.newebInst ?? []).filter((x) => x !== n)).sort((a, b) => a - b) })}
                />{" "}
                {n} 期
              </label>
            ))}
          </div>
        </div>
      )}
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
      <LinePaySettings />
      <MailCredForm current={creds.mail} onSaved={load} />
      <h3>商店代號與金鑰</h3>
      {(["ecpay_payment", "newebpay_payment", "ecpay_invoice"] as const).map((k) => (
        <CredForm key={k} kind={k} current={creds[k]} mask={creds[`${k}_mask`]} onSaved={load} />
      ))}
    </section>
  );
}

/** LINE Pay 線下支付：掃客人付款碼直接扣款；金鑰只存在伺服器 */
function LinePaySettings() {
  const { form, set, save, busy } = useSettingsForm(["linePay"]);
  const lp = form.linePay ?? { enabled: false, stage: true };
  const [cur, setCur] = useState<string | null | undefined>(undefined);
  const [f, setF] = useState({ channelId: "", channelSecret: "" });
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const { busy: b2, run } = useAction();
  const load = () => call<{ channelId: string | null }>("linePayStatus").then((r) => setCur(r.channelId)).catch(() => setCur(null));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="cred-form">
      <div className="row-between">
        <strong>LINE Pay 串接（掃客人付款碼）</strong>
        {cur ? <Badge tone="ok">已設定：Channel ID {cur}</Badge> : <Badge>未設定</Badge>}
      </div>
      <p className="muted small">
        啟用後，POS 選「LINE Pay」會改成掃客人 LINE Pay 的付款碼直接扣款，退貨也會自動退回。需先向 LINE Pay 申請「線下支付」特約商店，
        在 LINE Pay 商家中心「開發工具 → 管理連結金鑰」取得 Channel ID 與 Channel Secret。測試請先用 Sandbox 帳號。
      </p>
      <div className="inline-form">
        <input placeholder="Channel ID" inputMode="numeric" value={f.channelId} onChange={(e) => setF({ ...f, channelId: e.target.value.trim() })} />
        <input type="password" autoComplete="off" placeholder="Channel Secret Key" value={f.channelSecret} onChange={(e) => setF({ ...f, channelSecret: e.target.value.trim() })} />
        <button className="btn" disabled={b2 || !f.channelId || !f.channelSecret} onClick={() => run(async () => {
          await call("setLinePayCreds", f);
          setF({ channelId: "", channelSecret: "" });
          load();
        }, "已儲存")}>
          儲存金鑰
        </button>
        <button className="btn" disabled={b2 || !cur} onClick={() => run(async () => setTest(await call<{ ok: boolean; message: string }>("testLinePay")))}>
          測試連線
        </button>
      </div>
      {test && <p className={test.ok ? "ok" : "error"}>{test.message}</p>}
      <div className="grid-fields">
        <Field label="LINE Pay 環境" hint="Sandbox 金鑰配測試環境；正式金鑰配正式環境">
          <select value={lp.stage ? "stage" : "prod"} onChange={(e) => set("linePay", { ...lp, stage: e.target.value === "stage" })}>
            <option value="stage">測試（Sandbox，不會真的扣款）</option>
            <option value="prod">正式</option>
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!lp.enabled} disabled={!cur} onChange={(e) => set("linePay", { ...lp, enabled: e.target.checked })} /> 啟用 LINE Pay 串接（POS 選 LINE Pay 時掃付款碼扣款）
      </label>
      <button className="btn btn-primary" disabled={busy} onClick={save}>
        儲存 LINE Pay 設定
      </button>
    </div>
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
        <input placeholder="Merchant Center ID（網址 a= 後面的數字）" inputMode="numeric" value={form.merchantId ?? ""} onChange={(e) => set("merchantId", e.target.value.trim())} />
        <button className="btn" disabled={busy || !/^\d{6,20}$/.test(form.merchantId ?? "")} title="Merchant Center ID 只有數字" onClick={save}>
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
      {form.merchantId && !/^\d{6,20}$/.test(form.merchantId) && <p className="error small">Merchant Center ID 只有數字（例：5876463536），在 Merchant Center 網址 a= 後面或右上角帳戶名稱下方。</p>}
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
  const { form, set, save, busy } = useSettingsForm(["commissionPct", "commissionByUser", "expenseCategories", "payrollCategories"]);
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
      <Field label="哪些開支分類算「人事薪資與老闆提款」" hint="報表中心三階損益分開列；其他分類算「營業雜支」，「進貨」不扣（已算在商品成本）">
        <div className="chips">
          {(form.expenseCategories?.length ? form.expenseCategories : DEFAULT_EXPENSE_CATEGORIES).map((c) => {
            const cur = form.payrollCategories ?? (form.expenseCategories?.length ? form.expenseCategories : DEFAULT_EXPENSE_CATEGORIES).filter((x) => /薪|人事|獎金|勞健保|提款|老闆|股東/.test(x));
            const on = cur.includes(c);
            return (
              <button key={c} type="button" className={`chip ${on ? "active" : ""}`} disabled={/^進貨/.test(c)} onClick={() => set("payrollCategories", on ? cur.filter((x) => x !== c) : [...cur, c])}>
                {c}
              </button>
            );
          })}
        </div>
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
