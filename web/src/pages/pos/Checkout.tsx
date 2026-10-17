import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import { Keypad } from "../../components/Keypad";
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
export function Checkout({ total, itemName, onClose, submit }: { total: number; itemName: string; onClose: () => void; submit: (p: Pay[], invoice: InvoiceInput | null) => Promise<void> }) {
  const { settings } = useData();
  const provider = settings.payment?.provider ?? null;
  const invoiceOn = !!settings.invoice?.enabled;
  const [method, setMethod] = useState<string>("cash");
  const [cash, setCash] = useState("");
  const [mixed, setMixed] = useState<Pay[]>([]);
  const [mixMethod, setMixMethod] = useState("card");
  const [mixAmt, setMixAmt] = useState("");
  const [inv, setInv] = useState<InvoiceInput>({ type: "print" });
  const [online, setOnline] = useState<{ id: string; url: string } | null>(null);
  const { busy, run } = useAction();

  const payments: Pay[] =
    method === "mixed" ? mixed : method === "cash" ? [{ method: "cash", amount: cash === "" ? total : Number(cash) }] : method === "online" ? [] : [{ method, amount: total }];
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const change = paid - total;
  const mixedLeft = total - mixed.reduce((s, p) => s + p.amount, 0);
  const ok = method !== "online" && paid >= total && payments.filter((p) => p.method !== "cash").reduce((s, p) => s + p.amount, 0) <= total;
  const invoiceOk = !invoiceOn || inv.type === "print" || (inv.type === "mobile" && /^\/[0-9A-Z+\-.]{7}$/.test(inv.mobileBarcode ?? "")) || (inv.type === "taxId" && /^\d{8}$/.test(inv.taxId ?? "")) || (inv.type === "donate" && /^\d{3,7}$/.test(inv.loveCode ?? ""));
  const invoicePayload = invoiceOn ? inv : null;

  const methods: [string, string][] = [...Object.entries(PAY_LABEL), ...(provider && total > 0 ? [["online", `掃碼付款（${PROVIDER_LABEL[provider]}）`] as [string, string]] : []), ["mixed", "混合付款"]];

  return (
    <Modal
      title={`結帳 ${money(total)}`}
      onClose={() => !busy && !online && onClose()}
      wide
      footer={
        method === "online" ? null : (
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
            <div className={`change ${change < 0 ? "error" : ""}`}>{change >= 0 ? `找零 ${money(change)}` : `還差 ${money(-change)}`}</div>
          </div>
          <Keypad value={cash} onChange={setCash} />
        </div>
      )}
      {PAY_LABEL[method] && method !== "cash" && <p className="center big">請以 {PAY_LABEL[method]} 收款 {money(total)}（刷卡機另外操作）</p>}
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
        <div>
          <ul className="pick-list">
            {mixed.map((p, i) => (
              <li key={i} className="row-between">
                {PAY_LABEL[p.method]} {money(p.amount)}
                <button className="btn btn-sm btn-ghost" onClick={() => setMixed((m) => m.filter((_, j) => j !== i))}>
                  移除
                </button>
              </li>
            ))}
          </ul>
          <p>{mixedLeft > 0 ? `尚餘 ${money(mixedLeft)}` : mixedLeft < 0 ? `找零 ${money(-mixedLeft)}` : "金額已足"}</p>
          <div className="inline-form">
            <select value={mixMethod} onChange={(e) => setMixMethod(e.target.value)}>
              {Object.entries(PAY_LABEL).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <input type="number" placeholder={String(Math.max(0, mixedLeft))} value={mixAmt} onChange={(e) => setMixAmt(e.target.value)} />
            <button
              className="btn"
              onClick={() => {
                const a = mixAmt === "" ? Math.max(0, mixedLeft) : Number(mixAmt);
                if (a > 0) setMixed((m) => [...m, { method: mixMethod, amount: a }]);
                setMixAmt("");
              }}
            >
              加入
            </button>
          </div>
        </div>
      )}
    </Modal>
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
