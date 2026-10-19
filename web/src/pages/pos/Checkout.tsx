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
export function Checkout({ total, itemName, onClose, submit, onPayShow }: { total: number; itemName: string; onClose: () => void; submit: (p: Pay[], invoice: InvoiceInput | null) => Promise<void>; onPayShow?: (p: { method: string; amount: number; parts?: Pay[] } | null) => void }) {
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
  const showPay =
    method === "cash" ? (rest > 0 ? { method: restMethod!, amount: rest, parts: [...(cashIn > 0 ? [{ method: "cash", amount: cashIn }] : []), { method: restMethod!, amount: rest }] } : null) : method === "mixed" ? (mixShow ? { method: mixShow.method, amount: mixShow.amount, parts: mixed } : null) : method === "online" ? null : { method, amount: total };
  const showKey = JSON.stringify(showPay);
  useEffect(() => {
    onPayShow?.(showPay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showKey]);
  useEffect(() => () => onPayShow?.(null), [onPayShow]);
  const ok = method !== "online" && !scanLinePay && !restScan && paid >= total && payments.filter((p) => p.method !== "cash").reduce((s, p) => s + p.amount, 0) <= total;
  const invoiceOk = !invoiceOn || inv.type === "print" || (inv.type === "mobile" && /^\/[0-9A-Z+\-.]{7}$/.test(inv.mobileBarcode ?? "")) || (inv.type === "taxId" && /^\d{8}$/.test(inv.taxId ?? "")) || (inv.type === "donate" && /^\d{3,7}$/.test(inv.loveCode ?? ""));
  const invoicePayload = invoiceOn ? inv : null;

  const methods: [string, string][] = [...Object.entries(PAY_LABEL), ...(provider && total > 0 ? [["online", `掃碼付款（${PROVIDER_LABEL[provider]}）`] as [string, string]] : []), ["mixed", "混合付款"]];

  return (
    <Modal
      title={`結帳 ${money(total)}`}
      onClose={() => !busy && !online && onClose()}
      wide
      footer={
        method === "online" || scanLinePay || restScan ? null : (
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
      {PAY_LABEL[method] && method !== "cash" && !scanLinePay && <p className="center big">請以 {PAY_LABEL[method]} 收款 {money(total)}{method === "card" ? "（刷卡機另外操作）" : ""}</p>}
      {method === "online" && provider && (
        <OnlinePay
          provider={provider}
          amount={total}
          itemName={itemName}
          invoiceOk={invoiceOk}
          session={online}
          setSession={setOnline}
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

  return (
    <div className="linepay-box">
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
}: {
  provider: string;
  amount: number;
  itemName: string;
  invoiceOk: boolean;
  session: { id: string; url: string } | null;
  setSession: (s: { id: string; url: string } | null) => void;
  onPaid: (id: string) => void;
}) {
  const [status, setStatus] = useState("waiting");
  const [lastError, setLastError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const fired = useRef(false);
  const paidCb = useRef(onPaid);
  paidCb.current = onPaid;

  useEffect(() => {
    if (!session) return;
    return onSnapshot(doc(db, "posPayments", session.id), (s) => {
      const d = s.data();
      setStatus(d?.status ?? "waiting");
      setLastError(d?.lastError ?? null);
      if (d?.status === "paid" && !fired.current) {
        fired.current = true;
        toast("客人已付款", "ok");
        paidCb.current(session.id);
      }
    });
  }, [session, toast]);

  if (!session)
    return (
      <div className="center">
        <p>產生付款 QR code，客人用手機掃描後可刷卡、Apple Pay、LINE Pay、台灣 Pay 等付款。</p>
        <button
          className="btn btn-primary btn-lg"
          disabled={busy || !invoiceOk}
          onClick={() => run(async () => setSession(await call<{ id: string; url: string }>("createOnlinePayment", { amount, itemName, orderId: "pos" })))}
        >
          產生付款 QR（{money(amount)}）
        </button>
        {!invoiceOk && <p className="error small">請先填好發票資料</p>}
      </div>
    );

  return (
    <div className="online-pay">
      <QrImg value={session.url} size={220} />
      <div>
        <div className="big strong">{money(amount)}</div>
        <p>
          {status === "paid" ? (
            <span className="ok">✅ 已付款，正在完成結帳…</span>
          ) : status === "waiting" ? (
            <>請客人用手機相機掃描 QR code 付款（{PROVIDER_LABEL[provider]}）。付款後這裡會自動完成。</>
          ) : (
            <span className="error">付款已取消或失效</span>
          )}
        </p>
        {lastError && <p className="error small">上次付款失敗：{lastError}</p>}
        <div className="btn-row">
          <button className="btn" disabled={busy || status !== "waiting"} onClick={() => run(async () => {
            const r = await call<{ status: string }>("checkOnlinePayment", { id: session.id });
            if (r.status !== "paid") toast("還沒有收到付款", "info");
          })}>
            查詢付款狀態
          </button>
          <button className="btn btn-ghost" disabled={busy || status === "paid"} onClick={() => run(async () => {
            await call("cancelOnlinePayment", { id: session.id });
            setSession(null);
          })}>
            取消，改用其他方式
          </button>
        </div>
        <p className="muted small">QR 30 分鐘內有效。付款完成但這裡沒反應時，按「查詢付款狀態」。</p>
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

export function Done({ order, issues, onClose }: { order: PosOrder; issues: { title: string; status: string; error: string | null }[]; onClose: () => void }) {
  const { settings } = useData();
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
