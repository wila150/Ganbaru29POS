import { collection, onSnapshot, orderBy, query, where, type Timestamp } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../../auth";
import { Badge, Empty, Field, Modal, useAction, useToast } from "../../components/ui";
import { Keypad } from "../../components/Keypad";
import { call, db } from "../../firebase";
import { getDeviceLocationId } from "../../lib/location";
import { atLeast, deviceId, downloadCsv, fmtTime, todayStr } from "../../lib/util";

interface Rec {
  id: string;
  uid: string;
  name: string;
  date: string;
  inAt: Timestamp | null;
  outAt: Timestamp | null;
  minutes: number | null;
  open: boolean;
  editedBy?: string;
  editNote?: string;
}

const hm = (m: number | null | undefined) => (m == null ? "—" : `${Math.floor(m / 60)} 小時 ${m % 60} 分`);

/** 打卡：每個人上下班打卡；店長以上看全員月報、補登修正。 */
export function Attendance() {
  const { user, profile } = useAuth();
  const isManager = atLeast(profile?.role, "manager");
  const [mine, setMine] = useState<Rec[]>([]);
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [all, setAll] = useState<Rec[]>([]);
  const [fix, setFix] = useState<Rec | "new" | null>(null);
  const [now, setNow] = useState(Date.now());
  const { busy, run } = useAction();

  useEffect(() => {
    if (!user) return;
    return onSnapshot(query(collection(db, "attendance"), where("uid", "==", user.uid), orderBy("inAt", "desc")), (s) => setMine(s.docs.slice(0, 40).map((d) => ({ id: d.id, ...d.data() }) as Rec)));
  }, [user]);
  useEffect(() => {
    if (!isManager) return;
    const start = new Date(`${month}-01T00:00:00+08:00`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return onSnapshot(query(collection(db, "attendance"), where("inAt", ">=", start), where("inAt", "<", end), orderBy("inAt", "desc")), (s) => setAll(s.docs.map((d) => ({ id: d.id, ...d.data() }) as Rec)));
  }, [isManager, month]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const open = mine.find((r) => r.open);
  const summary = useMemo(() => {
    const m = new Map<string, { uid: string; name: string; days: Set<string>; minutes: number; open: number }>();
    for (const r of all) {
      const s = m.get(r.uid) ?? m.set(r.uid, { uid: r.uid, name: r.name, days: new Set(), minutes: 0, open: 0 }).get(r.uid)!;
      s.days.add(r.date);
      s.minutes += r.minutes ?? 0;
      if (r.open) s.open++;
    }
    return [...m.values()].sort((a, b) => b.minutes - a.minutes);
  }, [all]);

  return (
    <div className="page">
      <h1>打卡</h1>
      <div className="card clock-card">
        <div>
          <div className="muted">{profile?.name}</div>
          {open ? (
            <>
              <div className="clock-status ok">上班中</div>
              <div className="muted small">
                {fmtTime(open.inAt)} 上班，已 {hm(Math.round((now - (open.inAt?.toMillis() ?? now)) / 60_000))}
              </div>
            </>
          ) : (
            <div className="clock-status">未上班</div>
          )}
        </div>
        {open ? (
          <button className="btn btn-lg btn-danger" disabled={busy} onClick={() => run(async () => {
            const r = await call<{ minutes: number }>("clockOut");
            return r;
          }, "已打下班卡")}>
            下班打卡
          </button>
        ) : (
          <button className="btn btn-lg btn-pay" disabled={busy} onClick={() => run(() => call("clockIn", { locationId: getDeviceLocationId(), device: deviceId() }), "已打上班卡")}>
            上班打卡
          </button>
        )}
      </div>

      <StaffClock />
      <MyPin />

      <h2>我的紀錄</h2>
      {mine.length === 0 ? (
        <Empty>還沒有打卡紀錄</Empty>
      ) : (
        <table className="table table-compact">
          <tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td>{r.date}</td>
                <td>{fmtTime(r.inAt, false)}</td>
                <td>{r.outAt ? fmtTime(r.outAt, false) : <Badge tone="ok">上班中</Badge>}</td>
                <td className="num">{hm(r.minutes)}</td>
                <td className="muted small">{r.editedBy && `${r.editedBy} 修正：${r.editNote}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isManager && (
        <>
          <div className="row-between">
            <h2>全員出勤</h2>
            <div className="btn-row">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
              <button className="btn btn-sm" onClick={() => setFix("new")}>
                補登
              </button>
              <button
                className="btn btn-sm"
                disabled={!all.length}
                onClick={() => downloadCsv(`出勤_${month}.csv`, [["員工", "日期", "上班", "下班", "分鐘", "備註"], ...all.map((r) => [r.name, r.date, fmtTime(r.inAt), r.outAt ? fmtTime(r.outAt) : "未打下班", r.minutes ?? "", r.editNote ?? ""])])}
              >
                匯出 Excel
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>員工</th>
                  <th className="num">出勤天數</th>
                  <th className="num">總工時</th>
                  <th>未打下班</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.uid}>
                    <td>{s.name}</td>
                    <td className="num">{s.days.size}</td>
                    <td className="num strong">{hm(s.minutes)}</td>
                    <td>{s.open ? <Badge tone="warn">{s.open} 筆</Badge> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>明細</h3>
          <div className="table-wrap">
            <table className="table table-compact table-click">
              <tbody>
                {all.map((r) => (
                  <tr key={r.id} onClick={() => setFix(r)}>
                    <td>{r.name}</td>
                    <td>{r.date}</td>
                    <td>{fmtTime(r.inAt, false)}</td>
                    <td>{r.outAt ? fmtTime(r.outAt, false) : <Badge tone="warn">未打下班</Badge>}</td>
                    <td className="num">{hm(r.minutes)}</td>
                    <td className="muted small">{r.editedBy && `修正：${r.editNote}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {fix && <FixDialog rec={fix === "new" ? null : fix} onClose={() => setFix(null)} />}
    </div>
  );
}

const toLocal = (t: Timestamp | null | undefined) => {
  if (!t) return "";
  const d = new Date(t.toMillis() + 8 * 3600_000);
  return d.toISOString().slice(0, 16);
};
const fromLocal = (s: string) => (s ? new Date(`${s}:00+08:00`).toISOString() : null);

function FixDialog({ rec, onClose }: { rec: Rec | null; onClose: () => void }) {
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [uid, setUid] = useState(rec?.uid ?? "");
  const [inAt, setIn] = useState(toLocal(rec?.inAt) || `${todayStr()}T09:00`);
  const [outAt, setOut] = useState(toLocal(rec?.outAt));
  const [note, setNote] = useState("");
  const { busy, run } = useAction();
  useEffect(() => {
    if (rec) return;
    return onSnapshot(collection(db, "users"), (s) => setUsers(s.docs.filter((d) => d.data().active).map((d) => ({ id: d.id, name: d.data().name }))));
  }, [rec]);
  return (
    <Modal
      title={rec ? `修正：${rec.name} ${rec.date}` : "補登打卡"}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" disabled={busy || !note.trim() || (!rec && !uid)} onClick={() => run(() => call("fixAttendance", { id: rec?.id, uid, inAt: fromLocal(inAt), outAt: fromLocal(outAt), note }), "已儲存").then(onClose)}>
          儲存
        </button>
      }
    >
      {!rec && (
        <Field label="員工">
          <select value={uid} onChange={(e) => setUid(e.target.value)}>
            <option value="">選擇員工</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="上班時間">
        <input type="datetime-local" value={inAt} onChange={(e) => setIn(e.target.value)} />
      </Field>
      <Field label="下班時間（留空 = 還在上班）">
        <input type="datetime-local" value={outAt} onChange={(e) => setOut(e.target.value)} />
      </Field>
      <Field label="原因（必填，會留下操作紀錄）">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例：忘記打下班卡" />
      </Field>
    </Modal>
  );
}

interface RosterItem {
  uid: string;
  name: string;
  hasPin: boolean;
  onDuty: boolean;
  inAt: number | null;
}

/** 員工打卡（共用裝置）：選名字 → 輸入打卡密碼 → 上班／下班；不用登入自己的帳號 */
function StaffClock() {
  const { profile } = useAuth();
  const isManager = atLeast(profile?.role, "manager");
  const [roster, setRoster] = useState<RosterItem[] | null>(null);
  const [who, setWho] = useState<RosterItem | null>(null);
  const [pin, setPin] = useState("");
  const [resetFor, setResetFor] = useState<RosterItem | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const load = () => call<{ staff: RosterItem[] }>("clockRoster").then((r) => setRoster(r.staff)).catch(() => setRoster([]));
  useEffect(() => {
    load();
  }, []);
  const punch = (action: "in" | "out") =>
    run(async () => {
      const r = await call<{ action: string; minutes: number | null }>("clockByPin", { uid: who!.uid, pin, action, locationId: getDeviceLocationId(), device: deviceId() });
      toast(action === "in" ? `${who!.name} 上班打卡成功` : `${who!.name} 下班打卡成功（${hm(r.minutes)}）`, "ok");
      setWho(null);
      setPin("");
      load();
    }).catch(() => setPin(""));
  return (
    <section className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>員工打卡</h2>
        <span className="muted small">共用電腦／平板：選自己的名字，輸入打卡密碼</span>
      </div>
      {roster === null ? (
        <p className="muted">讀取中…</p>
      ) : (
        <div className="staff-grid">
          {roster.map((s) => (
            <button key={s.uid} className={`staff-btn ${s.onDuty ? "on" : ""}`} onClick={() => (s.hasPin ? (setWho(s), setPin("")) : isManager ? setResetFor(s) : toast(`${s.name} 還沒設定打卡密碼，請先登入自己的帳號，在「我的打卡密碼」設定`, "bad"))}>
              <b>{s.name}</b>
              <small>{s.onDuty ? `上班中${s.inAt ? `（${new Date(s.inAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}）` : ""}` : s.hasPin ? "未上班" : "未設密碼"}</small>
              {isManager && (
                <span
                  className="link-btn small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setResetFor(s);
                  }}
                >
                  {s.hasPin ? "重設密碼" : "設定密碼"}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {who && (
        <Modal title={`${who.name}　${who.onDuty ? "下班打卡" : "上班打卡"}`} onClose={() => (setWho(null), setPin(""))}>
          <div className="pin-dots">{Array.from({ length: Math.max(4, pin.length) }, (_, i) => (i < pin.length ? "●" : "○")).join(" ")}</div>
          <Keypad digits value={pin} onChange={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))} />
          <button className={`btn btn-lg block ${who.onDuty ? "btn-danger" : "btn-pay"}`} disabled={busy || pin.length < 4} onClick={() => punch(who.onDuty ? "out" : "in")}>
            {busy ? "打卡中…" : who.onDuty ? "下班打卡" : "上班打卡"}
          </button>
        </Modal>
      )}
      {resetFor && <PinDialog uid={resetFor.uid} name={resetFor.name} onClose={() => (setResetFor(null), load())} />}
    </section>
  );
}

/** 自己設定打卡密碼 */
function MyPin() {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <p className="muted small">
      {profile?.name}：
      <button className="link-btn small" onClick={() => setOpen(true)}>
        設定我的打卡密碼
      </button>
      （設好後，在共用的收銀電腦也能用名字＋密碼打卡）
      {open && <PinDialog name={profile?.name ?? "我"} onClose={() => setOpen(false)} />}
    </p>
  );
}

function PinDialog({ uid, name, onClose }: { uid?: string; name: string; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState<string | null>(null);
  const { busy, run } = useAction();
  const confirming = pin2 !== null;
  const cur = confirming ? pin2 : pin;
  return (
    <Modal title={`${name} 的打卡密碼`} onClose={onClose}>
      <p className="center">{confirming ? "再輸入一次確認" : "請輸入 4～6 位數字"}</p>
      <div className="pin-dots">{Array.from({ length: Math.max(4, cur.length) }, (_, i) => (i < cur.length ? "●" : "○")).join(" ")}</div>
      <Keypad digits value={cur} onChange={(v) => (confirming ? setPin2 : setPin)(v.replace(/\D/g, "").slice(0, 6))} />
      {!confirming ? (
        <button className="btn btn-primary btn-lg block" disabled={pin.length < 4} onClick={() => setPin2("")}>
          下一步
        </button>
      ) : (
        <button
          className="btn btn-pay btn-lg block"
          disabled={busy || pin2!.length < 4}
          onClick={() =>
            pin2 !== pin
              ? (setPin(""), setPin2(null), alert("兩次輸入不一樣，請重新設定"))
              : run(() => call("setClockPin", { pin, ...(uid ? { uid } : {}) }), "打卡密碼已設定").then(onClose)
          }
        >
          儲存
        </button>
      )}
    </Modal>
  );
}
