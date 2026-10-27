import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import { Keypad } from "../../components/Keypad";
import { CameraScanner } from "../../components/ScanInput";
import { QrImg } from "../../components/QrImg";
import { Modal, useAction, useToast } from "../../components/ui";
import { useData } from "../../data";
import { call, db } from "../../firebase";
import { printReceipt } from "../../lib/receipt";
import { money, PAY_LABEL } from "../../lib/util";
import { useDeviceLocation } from "../../lib/location";
import { displayChannel } from "../../lib/display";
import type { PosOrder } from "../../types";

export type Pay = { method: string; amount: number; ref?: string };
export interface InvoiceInput {
  type: "print" | "mobile" | "taxId" | "donate";
  mobileBarcode?: string;
  taxId?: string;
  companyName?: string;
  loveCode?: string;
  email?: string;
}

const PROVIDER_LABEL: Record<string, string> = { ecpay: "綠界", newebpay: "藍新" };

/** 結帳：付款方式（含掃碼線上付款）＋電子發票開立方式。 */
export function Checkout({ total, itemName, onClose, submit, onPayShow, customerEmail }: { customerEmail?: string | null; total: number; itemName: string; onClose: () => void; submit: (p: Pay[], invoice: InvoiceInput | null) => Promise<void>; onPayShow?: (p: { method: string; amount: number; parts?: Pay[]; url?: string; scan?: boolean } | null) => void }) {
  const { settings } = useData();
  const provider = settings.payment?.provider ?? null;
  const linePayApi = !!settings.linePay?.enabled && total > 0;
  const invoiceOn = !!settings.invoice?.enabled;
  const [method, setMethod] = useState<string>("cash");
  const [cash, setCash] = useState("");
  const [mixed, setMixed] = useState<Pay[]>([]);
  // 先收現金，不夠的部分改用 LINE Pay／信用卡…（null = 全部現金）
  const [restMethod, setRestMethod] = useState<string | null>(null);
  const [mixAmt, setMixAmt] = useState("");
  const [inv, setInv] = useState<InvoiceInput>({ type: "print" });
  const [online, setOnline] = useState<{ id: string; url: string } | null>(null);
  // 信用卡：有設定藍新／綠界時預設「傳付款連結」，也可以改用刷卡機
  // 信用卡：顯示 QR（客人掃平板）／傳連結（寄 Email）／刷卡機；有設定藍新時預設 QR
  const [cardMode, setCardMode] = useState<"qr" | "link" | "terminal">(provider ? "qr" : "terminal");
  const cardOnline = method === "card" && !!provider && cardMode !== "terminal" && total > 0;
  const cardLink = cardOnline && cardMode === "link";
  const { busy, run } = useAction();

  const cashIn = cash === "" ? total : Number(cash);
  const rest = method === "cash" && restMethod && cashIn < total ? total - cashIn : 0;
  const payments: Pay[] =
    method === "mixed"
      ? mixed
      : method === "cash"
        ? rest > 0
          ? [...(cashIn > 0 ? [{ method: "cash", amount: cashIn }] : []), { method: restMethod!, amount: rest }]
          : [{ method: "cash", amount: cashIn }]
        : method === "online"
          ? []
          : [{ method, amount: total }];
  const restScan = rest > 0 && restMethod === "linepay" && linePayApi;
  const restChoices = Object.keys(PAY_LABEL)
    .filter((k) => k !== "cash")
    .sort((a, b) => (a === "linepay" ? -1 : b === "linepay" ? 1 : a === "card" ? -1 : b === "card" ? 1 : 0));
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const change = paid - total;
  const mixedLeft = total - mixed.reduce((s, p) => s + p.amount, 0);
  const scanLinePay = method === "linepay" && linePayApi;
  // 顧客螢幕：非現金的部分顯示給客人（轉帳帳號／QR、LINE Pay QR）
  const mixShow = [...mixed].reverse().find((p) => p.method !== "cash");
  const lpScanShow = scanLinePay ? { method: "linepay", amount: total, scan: true } : restScan ? { method: "linepay", amount: rest, scan: true, parts: [...(cashIn > 0 ? [{ method: "cash", amount: cashIn }] : []), { method: "linepay", amount: rest }] } : null;
  const showPay = lpScanShow ?? (
    method === "cash" ? (rest > 0 ? { method: restMethod!, amount: rest, parts: [...(cashIn > 0 ? [{ method: "cash", amount: cashIn }] : []), { method: restMethod!, amount: rest }] } : null) : method === "mixed" ? (mixShow ? { method: mixShow.method, amount: mixShow.amount, parts: mixed } : null) : method === "online" || (cardOnline && !cardLink) ? (online?.url ? { method: "online", amount: total, url: online.url } : null) : cardLink ? null : { method, amount: total });
  const showKey = JSON.stringify(showPay);
  useEffect(() => {
    onPayShow?.(showPay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showKey]);
  useEffect(() => () => onPayShow?.(null), [onPayShow]);
  const ok = method !== "online" && !cardOnline && !scanLinePay && !restScan && paid >= total && payments.filter((p) => p.method !== "cash").reduce((s, p) => s + p.amount, 0) <= total;
  const invoiceOk = !invoiceOn || inv.type === "print" || (inv.type === "mobile" && /^\/[0-9A-Z+\-.]{7}$/.test(inv.mobileBarcode ?? "")) || (inv.type === "taxId" && /^\d{8}$/.test(inv.taxId ?? "")) || (inv.type === "donate" && /^\d{3,7}$/.test(inv.loveCode ?? ""));
  const invoicePayload = invoiceOn ? inv : null;

  const methods: [string, string][] = [...Object.entries(PAY_LABEL), ["mixed", "混合付款"]];

  return (
    <Modal
      title={`結帳 ${money(total)}`}
      onClose={() => !busy && !online && onClose()}
      wide
      footer={
        method === "online" || cardOnline || scanLinePay || restScan ? null : (
          <button className="btn btn-pay btn-lg block" disabled={!ok || !invoiceOk || busy} onClick={() => run(() => submit(payments, invoicePayload))}>
            {busy ? "結帳中…" : change > 0 ? `完成結帳（找零 ${money(change)}）` : "完成結帳"}
          </button>
        )
      }
    >
      {invoiceOn && <InvoicePicker value={inv} onChange={setInv} />}
      <div className="pay-methods">
        {methods.map(([k, l]) => (
          <button key={k} className={method === k ? "active" : ""} disabled={!!online} onClick={() => setMethod(k)}>
            {l}
          </button>
        ))}
      </div>
      {method === "cash" && (
        <div className="pay-cash">
          <div>
            <div className="keypad-display">
              {cash === "" ? money(total) : money(Number(cash))}
              <small>收款</small>
            </div>
            <div className="quick-cash">
              {[total, Math.ceil(total / 100) * 100, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000]
                .filter((v, i, a) => v >= total && a.indexOf(v) === i)
                .map((v) => (
                  <button key={v} onClick={() => setCash(String(v))}>
                    {money(v)}
                  </button>
                ))}
            </div>
            {rest > 0 ? (
              <div className="change">
                現金 {money(cashIn)} ＋ {PAY_LABEL[restMethod!]} {money(rest)}
              </div>
            ) : (
              <div className={`change ${change < 0 ? "error" : ""}`}>{change >= 0 ? `找零 ${money(change)}` : `還差 ${money(-change)}`}</div>
            )}
            {cashIn < total && (
              <div className="rest-pay">
                <span className="muted small">剩下 {money(total - cashIn)} 用：</span>
                {restChoices.map((k) => (
                  <button key={k} className={restMethod === k ? "active" : ""} onClick={() => setRestMethod(restMethod === k ? null : k)}>
                    {PAY_LABEL[k]}
                  </button>
                ))}
              </div>
            )}
            {rest > 0 && !restScan && <p className="muted small">請另外以 {PAY_LABEL[restMethod!]} 收 {money(rest)}{restMethod === "card" ? "（刷卡機另外操作）" : ""}，收到後按「完成結帳」</p>}
          </div>
          <Keypad value={cash} onChange={setCash} />
        </div>
      )}
      {restScan && (
        <LinePayScan
          amount={rest}
          itemName={itemName}
          invoiceOk={invoiceOk}
          stage={settings.linePay?.stage !== false}
          onBusy={(b) => setOnline(b ? { id: "linepay", url: "" } : null)}
          onPaid={(paymentId) => run(() => submit([...(cashIn > 0 ? [{ method: "cash", amount: cashIn }] : []), { method: "linepay", amount: rest, ref: paymentId }], invoicePayload))}
        />
      )}
      {scanLinePay && (
        <LinePayScan
          amount={total}
          itemName={itemName}
          invoiceOk={invoiceOk}
          stage={settings.linePay?.stage !== false}
          onBusy={(b) => setOnline(b ? { id: "linepay", url: "" } : null)}
          onPaid={(paymentId) => run(() => submit([{ method: "linepay", amount: total, ref: paymentId }], invoicePayload))}
        />
      )}
      {method === "card" && provider && total > 0 && (
        <div className="seg center-seg">
          <button className={cardMode === "qr" ? "on" : ""} disabled={!!online} onClick={() => setCardMode("qr")}>
            📱 產生 QR
          </button>
          <button className={cardMode === "link" ? "on" : ""} disabled={!!online} onClick={() => setCardMode("link")}>
            📧 傳付款連結
          </button>
          <button className={cardMode === "terminal" ? "on" : ""} disabled={!!online} onClick={() => setCardMode("terminal")}>
            刷卡機
          </button>
        </div>
      )}
      {PAY_LABEL[method] && method !== "cash" && !scanLinePay && !cardOnline && <p className="center big">請以 {PAY_LABEL[method]} 收款 {money(total)}{method === "card" ? "（刷卡機另外操作）" : ""}</p>}
      {(method === "online" || cardOnline) && provider && (
        <OnlinePay
          provider={provider}
          amount={total}
          itemName={itemName}
          invoiceOk={invoiceOk}
          session={online}
          setSession={setOnline}
          defaultEmail={customerEmail ?? ""}
          mode={cardLink ? "mail" : "qr"}
          onPaid={(paymentId) => run(() => submit([{ method: provider, amount: total, ref: paymentId }], invoicePayload))}
        />
      )}
      {method === "mixed" && (
        <div className="mix">
          <div className="mix-sum">
            <div>
              <span>應收</span>
              <b>{money(total)}</b>
            </div>
            <div>
              <span>已收</span>
              <b>{money(total - mixedLeft)}</b>
            </div>
            <div className="mix-detail">
              {(() => {
                const cashIn = mixed.filter((p) => p.method === "cash").reduce((a, p) => a + p.amount, 0);
                const others = mixed.filter((p) => p.method !== "cash");
                return (
                  <>
                    <span>現金 {money(cashIn)}</span>
                    <span>其他支付 {others.length ? others.map((p) => `${PAY_LABEL[p.method] ?? p.method} ${money(p.amount)}`).join("＋") : "$0"}</span>
                  </>
                );
              })()}
            </div>
          </div>
          {mixed.length > 0 && (
            <div className="mix-list">
              {mixed.map((p, i) => (
                <div key={i} className="mix-row">
                  <span>{PAY_LABEL[p.method] ?? p.method}</span>
                  <b>{money(p.amount)}</b>
                  <button className="btn-icon" title="移除" onClick={() => setMixed((m) => m.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className={`mix-left ${mixedLeft > 0 ? "due" : ""}`}>{mixedLeft > 0 ? `還差 ${money(mixedLeft)}` : mixedLeft < 0 ? `找零 ${money(-mixedLeft)}` : "金額已足 ✓"}</div>
          {mixedLeft > 0 && (
            <>
              <div className="mix-add">
                <input type="number" inputMode="numeric" placeholder={`金額（不填 = ${money(mixedLeft)}）`} value={mixAmt} onChange={(e) => setMixAmt(e.target.value)} />
              </div>
              <div className="mix-methods">
                {Object.entries(PAY_LABEL).map(([k, l]) => (
                  <button
                    key={k}
                    onClick={() => {
                      const a = mixAmt === "" ? mixedLeft : Number(mixAmt);
                      if (a > 0) setMixed((m) => [...m, { method: k, amount: a }]);
                      setMixAmt("");
                    }}
                  >
                    ＋ {l}
                  </button>
                ))}
              </div>
              <p className="muted small">先輸入金額，再點付款方式加入（例：輸入 1000 點「現金」，剩下的直接點「轉帳」）</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * LINE Pay 串接：掃描槍或相機掃客人 LINE Pay 的「付款碼」→ 伺服器向 LINE Pay 扣款 → 成功就完成結帳。
 * 客人如需在 LINE 上輸入密碼，伺服器會等最多約 45 秒；還不確定時可以按「查詢付款結果」。
 */
function LinePayScan({ amount, itemName, invoiceOk, stage, onBusy, onPaid }: { amount: number; itemName: string; invoiceOk: boolean; stage: boolean; onBusy: (b: boolean) => void; onPaid: (id: string) => void }) {
  const [code, setCode] = useState("");
  const [camera, setCamera] = useState(false);
  const [state, setState] = useState<{ id: string; status: string; message: string | null } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  const handle = (r: { id: string; status: string; message: string | null }) => {
    setState(r);
    if (r.status === "paid" && !done.current) {
      done.current = true;
      toast("LINE Pay 付款成功", "ok");
      onPaid(r.id);
    }
  };
  const charge = (key: string) => {
    const k = key.replace(/\s/g, "");
    if (!k) return;
    setCode("");
    setWaiting(true);
    onBusy(true);
    run(async () => {
      try {
        handle(await call<{ id: string; status: string; message: string | null }>("linePayCharge", { amount, itemName, oneTimeKey: k }));
      } finally {
        setWaiting(false);
      }
    }).finally(() => {
      onBusy(false);
      input.current?.focus();
    });
  };
  const pending = state?.status === "unknown" || state?.status === "processing";
  // 顧客螢幕（平板前鏡頭）掃到客人付款碼 → 這裡扣款
  const { locationId } = useDeviceLocation();
  const chargeRef = useRef(charge);
  chargeRef.current = charge;
  useEffect(() => {
    const since = Date.now() - 2000;
    let last = "";
    return onSnapshot(doc(db, "customerScan", displayChannel(locationId)), (d) => {
      const x = d.data();
      const at = x?.at?.toMillis?.() ?? 0;
      if (!x?.code || at < since || x.code === last || done.current) return;
      last = x.code;
      toast("顧客螢幕已讀到付款碼，扣款中…", "info");
      chargeRef.current(String(x.code));
    });
  }, [locationId, toast]);

  return (
    <div className="linepay-box">
      <p className="center muted small">📱 顧客螢幕已開前鏡頭，請客人把 LINE Pay 付款碼對著平板</p>
      <div className="big strong center">LINE Pay {money(amount)}{stage && <span className="badge badge-warn" style={{ marginLeft: 8 }}>測試環境</span>}</div>
      {state?.status === "paid" ? (
        <div className="center">
          <p className="ok">✅ LINE Pay 已扣款，正在完成結帳…</p>
          <p className="muted small">如果一直沒有完成（例如網路中斷），按「再試一次」，不會重複扣款；客人不買了請店長按「退款」。</p>
          <div className="btn-row" style={{ justifyContent: "center" }}>
            <button className="btn" disabled={busy} onClick={() => onPaid(state.id)}>
              再試一次完成結帳
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => confirm(`退回這筆 LINE Pay ${money(amount)}？`) && run(async () => {
              await call("linePayRefundUnused", { id: state.id });
              done.current = false;
              setState(null);
            }, "已退款")}>
              退款（店長以上）
            </button>
          </div>
        </div>
      ) : waiting ? (
        <p className="center">付款處理中…若客人的 LINE 要求輸入密碼，請客人在手機上完成（最多等約 45 秒）</p>
      ) : pending ? (
        <div className="center">
          <p className="error">{state?.message ?? "還不確定是否付款成功"}。請勿重新扣款，先查詢結果。</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => handle({ id: state!.id, ...(await call<{ status: string; message: string | null }>("linePayCheck", { id: state!.id })) }))}>
            查詢付款結果
          </button>
        </div>
      ) : (
        <>
          <p className="center">請客人打開 LINE Pay「付款」條碼，用掃描槍掃或按相機掃描。</p>
          {state?.status === "failed" && <p className="error center">付款失敗：{state.message}</p>}
          {!invoiceOk && <p className="error small center">請先填好發票資料</p>}
          <div className="inline-form">
            <input ref={input} autoFocus inputMode="none" placeholder="掃描 LINE Pay 付款碼" value={code} disabled={busy || !invoiceOk} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && charge(code)} />
            <button className="btn btn-primary" disabled={busy || !code || !invoiceOk} onClick={() => charge(code)}>
              扣款
            </button>
            <button className="btn" disabled={busy || !invoiceOk} onClick={() => setCamera(true)}>
              📷 相機
            </button>
          </div>
        </>
      )}
      {camera && <CameraScanner face="user" rememberKey="g29.cameraFace.linepay" onClose={() => setCamera(false)} onCode={(c) => charge(c)} />}
    </div>
  );
}

function InvoicePicker({ value, onChange }: { value: InvoiceInput; onChange: (v: InvoiceInput) => void }) {
  const set = (patch: Partial<InvoiceInput>) => onChange({ ...value, ...patch });
  return (
    <div className="invoice-box">
      <div className="segmented">
        {(
          [
            ["print", "紙本證明聯"],
            ["mobile", "手機條碼"],
            ["taxId", "統一編號"],
            ["donate", "捐贈"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" className={value.type === k ? "active" : ""} onClick={() => set({ type: k })}>
            {l}
          </button>
        ))}
      </div>
      {value.type === "mobile" && (
        <input autoFocus placeholder="掃描或輸入手機條碼 /ABC1234" value={value.mobileBarcode ?? ""} onChange={(e) => set({ mobileBarcode: e.target.value.toUpperCase().trim() })} />
      )}
      {value.type === "taxId" && (
        <div className="inline-form">
          <input autoFocus inputMode="numeric" placeholder="統一編號 8 碼" value={value.taxId ?? ""} onChange={(e) => set({ taxId: e.target.value.trim() })} />
          <input placeholder="公司名稱（選填）" value={value.companyName ?? ""} onChange={(e) => set({ companyName: e.target.value })} />
        </div>
      )}
      {value.type === "donate" && <input inputMode="numeric" placeholder="愛心碼（3～7 碼）" value={value.loveCode ?? ""} onChange={(e) => set({ loveCode: e.target.value.trim() })} />}
    </div>
  );
}

/** 掃碼付款：產生付款 QR → 客人手機付款 → 這裡即時看到「已付款」後自動完成結帳。 */
function OnlinePay({
  provider,
  amount,
  itemName,
  invoiceOk,
  session,
  setSession,
  onPaid,
  defaultEmail = "",
  mode = "qr",
}: {
  defaultEmail?: string;
  /** mail = 系統直接寄付款連結到客人 Email（不顯示 QR）；qr = 顯示 QR 給客人掃 */
  mode?: "qr" | "mail";
  provider: string;
  amount: number;
  itemName: string;
  invoiceOk: boolean;
  session: { id: string; url: string } | null;
  setSession: (s: { id: string; url: string } | null) => void;
  onPaid: (id: string) => void;
}) {
  const { settings } = useData();
  const [pay, setPay] = useState<{ status: string; lastError?: string | null; providerTradeNo?: string | null; card4?: string | null; inst?: number; paymentType?: string | null }>({ status: "waiting" });
  const [email, setEmail] = useState(defaultEmail);
  const { busy, run } = useAction();
  const toast = useToast();
  const fired = useRef(false);
  const paidCb = useRef(onPaid);
  paidCb.current = onPaid;
  const feePct = settings.payment?.feePct ?? null;
  const fee = feePct != null ? Math.round((amount * feePct) / 100) : null;

  useEffect(() => {
    if (!session) return;
    return onSnapshot(doc(db, "posPayments", session.id), (s) => {
      const d = s.data() ?? {};
      setPay({ status: d.status ?? "waiting", lastError: d.lastError ?? null, providerTradeNo: d.providerTradeNo ?? null, card4: d.card4 ?? null, inst: d.inst ?? 0, paymentType: d.paymentType ?? null });
      if (d.status === "paid" && !fired.current) {
        fired.current = true;
        toast("客人已付款", "ok");
        // 讓店員看到「已完成」再自動結帳
        setTimeout(() => paidCb.current(session.id), 1500);
      }
    });
  }, [session, toast]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const [sentTo, setSentTo] = useState<string | null>(null);
  // 這筆讓客人用什麼付：卡號一次付清一定有；分期、Apple Pay 等要設定頁有開才能選
  const enabledExtra = (settings.payment?.newebExtra ?? []) as string[];
  const instList = (settings.payment?.newebInst ?? []) as number[];
  const [useInst, setUseInst] = useState(instList.length > 0);
  const [extra, setExtra] = useState<string[]>([]); // 預設只開卡號；要 Apple Pay 再勾
  const EXTRA_LABEL: Record<string, string> = { APPLEPAY: "Apple Pay", ANDROIDPAY: "Google Pay", SAMSUNGPAY: "Samsung Pay", LINEPAY: "LINE Pay", TAIWANPAY: "台灣 Pay" };
  const payOpts = { inst: useInst, extra };
  const sendMail = (sess: { id: string; url: string }) =>
    run(async () => {
      await call("sendPayLink", { id: sess.id, email });
      setSentTo(email);
    }, `付款連結已寄到 ${email}`);
  // 付款中：每 10 秒主動向金流查一次（萬一金流通知沒送到，也會自動完成）
  useEffect(() => {
    if (!session || pay.status !== "waiting") return;
    const t = setInterval(() => call("checkOnlinePayment", { id: session.id }).catch(() => undefined), 10_000);
    return () => clearInterval(t);
  }, [session, pay.status]);
  if (!session && mode === "mail")
    return (
      <div className="op-mail">
        <p>輸入客人 Email，系統會把 {money(amount)} 的付款連結寄過去；客人付完款，這裡自動完成結帳。</p>
        <div className="op-opts">
          <span className="muted small">客人可以用：</span>
          <label className="check">
            <input type="checkbox" checked disabled /> 信用卡（輸入卡號）
          </label>
          {instList.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={useInst} onChange={(e) => setUseInst(e.target.checked)} /> 分期（{instList.join("／")} 期）
            </label>
          )}
          {enabledExtra.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={extra.includes(k)} onChange={(e) => setExtra(e.target.checked ? [...extra, k] : extra.filter((x) => x !== k))} /> {EXTRA_LABEL[k] ?? k}
            </label>
          ))}
        </div>
        <div className="inline-form">
          <input type="email" inputMode="email" placeholder="客人 Email" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
          <button
            className="btn btn-primary"
            disabled={busy || !emailOk || !invoiceOk}
            onClick={() =>
              run(async () => {
                const s = await call<{ id: string; url: string }>("createOnlinePayment", { amount, itemName, orderId: "pos", ...payOpts });
                setSession(s);
                await call("sendPayLink", { id: s.id, email });
                setSentTo(email);
              }, `付款連結已寄到 ${email}`)
            }
          >
            {busy ? "寄送中…" : "📧 寄出付款連結"}
          </button>
        </div>
        {!invoiceOk && <p className="error small">請先填好發票資料</p>}
      </div>
    );
  if (!session)
    return (
      <div className="center">
        <p>產生付款 QR：顧客螢幕會顯示 QR code，客人用手機相機掃描後輸入卡號付款，付款完成這裡自動結帳。</p>
        <button
          className="btn btn-primary btn-lg"
          disabled={busy || !invoiceOk}
          onClick={() => run(async () => setSession(await call<{ id: string; url: string }>("createOnlinePayment", { amount, itemName, orderId: "pos" })))}
        >
          📱 產生付款 QR（{money(amount)}）
        </button>
        {!invoiceOk && <p className="error small">請先填好發票資料</p>}
      </div>
    );

  const paid = pay.status === "paid";
  const waiting = pay.status === "waiting";
  const how = pay.card4 ? `信用卡 **** ${pay.card4}${pay.inst ? `（分 ${pay.inst} 期）` : ""}` : pay.paymentType ? pay.paymentType : "—";
  const subject = `${settings.shopName || "ganbaru29"} 付款連結 ${money(amount)}`;
  const body = `您好，這是本次消費 ${money(amount)} 的付款連結（30 分鐘內有效），點開即可用信用卡付款：\n${session.url}\n\n付款完成後門市會自動完成結帳，謝謝光臨！`;
  // Gmail 網頁版直接開好一封信（用這台電腦登入的 Gmail 寄出）
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const mail = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <div className="online-pay">
      {mode === "qr" && <QrImg value={session.url} size={200} />}
      <div className="op-body">
        <div className={`op-status ${paid ? "ok" : waiting ? "wait" : "bad"}`}>{paid ? "✅ 已完成" : waiting ? "⏳ 付款中…" : "已取消或失效"}</div>
        <table className="op-table">
          <tbody>
            <tr>
              <th>序號</th>
              <td className="mono">{pay.providerTradeNo || session.id.slice(-8).toUpperCase()}</td>
            </tr>
            <tr>
              <th>付款方式</th>
              <td>{paid ? how : `${PROVIDER_LABEL[provider]} 線上刷卡`}</td>
            </tr>
            <tr>
              <th>手續費</th>
              <td>{fee != null ? `${money(fee)}（${feePct}%）` : <span className="muted">未設定費率</span>}</td>
            </tr>
            <tr>
              <th>本次金額</th>
              <td className="strong">{money(amount)}</td>
            </tr>
            <tr>
              <th>狀態</th>
              <td>{paid ? "已完成" : waiting ? "付款中" : "已取消"}</td>
            </tr>
          </tbody>
        </table>
        {pay.lastError && <p className="error small">上次付款失敗：{pay.lastError}</p>}
        {mode === "mail" && sentTo && <p className="small">📧 付款連結已寄到 <b>{sentTo}</b>，等客人付款中…</p>}
        {waiting && mode === "mail" && (
          <div className="inline-form">
            <input type="email" placeholder="客人 Email" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
            <button className="btn" disabled={busy || !emailOk} onClick={() => sendMail(session)}>
              {sentTo === email ? "重寄" : "改寄到這個 Email"}
            </button>
          </div>
        )}
        {waiting && (
          <>
            {mode === "qr" && <div className="inline-form">
              <input type="email" placeholder="客人 Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <a className={`btn btn-primary ${emailOk ? "" : "disabled"}`} href={emailOk ? gmail : undefined} target="_blank" rel="noreferrer">
                📧 用 Gmail 寄
              </a>
              <a className={`btn ${emailOk ? "" : "disabled"}`} href={emailOk ? mail : undefined}>
                其他郵件 App
              </a>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(session.url).then(() => toast("已複製付款連結", "ok"))}>
                複製連結
              </button>
            </div>}
            <div className="btn-row">
              <button className="btn" disabled={busy} onClick={() => run(async () => {
                const r = await call<{ status: string }>("checkOnlinePayment", { id: session.id });
                if (r.status !== "paid") toast("還沒有收到付款", "info");
              })}>
                查詢付款狀態
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => run(async () => {
                await call("cancelOnlinePayment", { id: session.id });
                setSession(null);
              })}>
                取消，改用其他方式
              </button>
            </div>
            <p className="muted small">QR／連結 30 分鐘內有效。客人付款完成後會自動完成結帳。</p>
          </>
        )}
      </div>
    </div>
  );
}

export async function openInvoicePrint(orderId: string) {
  const w = window.open("about:blank", "_blank");
  try {
    const r = await call<{ url: string }>("invoicePrint", { orderId });
    if (w) w.location.href = r.url;
    else window.open(r.url, "_blank");
  } catch (e) {
    w?.close();
    alert((e as Error).message);
  }
}

export function InvoiceInfo({ order }: { order: PosOrder }) {
  const { busy, run } = useAction();
  if (!order.invoice && !order.invoiceError) return null;
  return (
    <div className={`notice ${order.invoiceError && !order.invoice ? "notice-warn" : ""}`}>
      {order.invoice ? (
        <span>
          電子發票 <strong>{order.invoice.no}</strong>（隨機碼 {order.invoice.random}）
          {order.invoice.voided && "　已作廢"}
          {order.invoice.stage && "　［測試環境］"}
          {order.invoice.type === "mobile" && "　已存手機載具"}
          {order.invoice.type === "donate" && "　已捐贈"}
        </span>
      ) : (
        <span>發票開立失敗：{order.invoiceError}</span>
      )}
      {order.invoice && order.invoice.print && !order.invoice.voided && (
        <button className="btn btn-sm" onClick={() => openInvoicePrint(order.id)}>
          列印發票證明聯
        </button>
      )}
      {!order.invoice && (
        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => call("reissueInvoice", { orderId: order.id }), "發票已開立")}>
          重新開立
        </button>
      )}
      {order.invoiceNote && <div className="small">{order.invoiceNote}</div>}
    </div>
  );
}

export function Done({ order, issues, onClose, autoMail = false }: { order: PosOrder; issues: { title: string; status: string; error: string | null }[]; onClose: () => void; autoMail?: boolean }) {
  const { settings } = useData();
  // 結帳完自動寄消費明細（有會員 Email，或線上刷卡寄過付款連結的 Email）
  const [mail, setMail] = useState<{ state: "idle" | "sending" | "sent" | "none" | "error"; email?: string; error?: string }>({ state: "idle" });
  const [mailTo, setMailTo] = useState("");
  const sendReceipt = (email?: string) => {
    setMail({ state: "sending" });
    call<{ sent: boolean; email?: string }>("sendReceipt", { orderId: order.id, ...(email ? { email } : {}) })
      .then((r) => setMail(r.sent ? { state: "sent", email: r.email } : { state: "none" }))
      .catch((e) => setMail({ state: "error", error: (e as Error).message }));
  };
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoMail || autoSent.current || settings.autoReceiptMail === false) return;
    autoSent.current = true;
    sendReceipt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMail]);
  return (
    <Modal
      title="結帳完成"
      onClose={onClose}
      footer={
        <>
          {order.invoice?.print && (
            <button className="btn" onClick={() => openInvoicePrint(order.id)}>
              列印發票
            </button>
          )}
          <button className="btn" onClick={() => printReceipt(order, settings)}>
            列印收據
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            下一位
          </button>
        </>
      }
    >
      <div className="center">
        <div className="muted">{order.orderNo}</div>
        <div className="done-total">{money(order.total)}</div>
        {order.change > 0 && <div className="done-change">找零 {money(order.change)}</div>}
        {order.rewardEarned > 0 && <div className="ok">回饋購物金 {order.rewardEarned} 點</div>}
        {order.tierUpgraded && <div className="done-upgrade">🎉 已升級為「{order.tierUpgraded}」！這一單不再另外打折，下次消費開始享 {order.tierUpgraded} 優惠</div>}
      </div>
      <div className="done-mail">
        {mail.state === "sending" && <span className="muted">📧 寄送消費明細中…</span>}
        {mail.state === "sent" && <span className="ok">📧 消費明細已寄到 {mail.email}</span>}
        {mail.state === "error" && <span className="error">明細沒寄出：{mail.error}</span>}
        {mail.state !== "sending" && mail.state !== "sent" && (
          <div className="inline-form">
            <input type="email" inputMode="email" placeholder={mail.state === "none" ? "沒有客人 Email，要寄明細請輸入" : "客人 Email"} value={mailTo} onChange={(e) => setMailTo(e.target.value.trim())} />
            <button className="btn" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailTo)} onClick={() => sendReceipt(mailTo)}>
              📧 寄明細
            </button>
          </div>
        )}
      </div>
      <InvoiceInfo order={order} />
      {issues.length > 0 && (
        <div className="notice notice-warn">
          以下商品網店庫存沒有扣成功（已記錄，店長可在異動紀錄處理）：
          <ul>
            {issues.map((i, k) => (
              <li key={k}>
                {i.title}：{i.error ?? i.status}
              </li>
            ))}
          </ul>
        </div>
      )}
      {order.exchange && <p className="muted small">換貨：退回 {order.exchange.lines.map((l) => l.title).join("、")}</p>}
    </Modal>
  );
}
