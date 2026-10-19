import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db } from "../firebase";

/**
 * 顧客螢幕：收銀電腦把購物車、要付的金額、付款方式寫到 customerDisplay/{門市}，
 * 平板開「顧客螢幕」即時顯示（轉帳帳號／QR、LINE Pay QR），付款確認後顯示謝謝光臨再回歡迎畫面。
 */
export interface DisplayLine {
  title: string;
  options: string;
  qty: number;
  amount: number;
}
export interface DisplayState {
  mode: "idle" | "cart" | "pay" | "done";
  lines?: DisplayLine[];
  total?: number;
  discount?: number;
  member?: string | null;
  /** 付款畫面：要客人付的方式和金額（現金＋轉帳時只顯示轉帳那部分） */
  pay?: { method: string; amount: number } | null;
  change?: number;
}

export const displayChannel = (locationId: string | null) => locationId || "main";

let timer: ReturnType<typeof setTimeout> | null = null;
let last = "";
/** 寫入顧客螢幕（連續變動時 300ms 合併一次；內容沒變不寫） */
export function pushDisplay(channel: string, s: DisplayState, now = false) {
  const json = JSON.stringify(s);
  if (json === last) return;
  if (timer) clearTimeout(timer);
  const write = () => {
    last = json;
    setDoc(doc(db, "customerDisplay", channel), { lines: [], total: 0, discount: 0, member: null, pay: null, change: 0, ...s, at: serverTimestamp() }).catch(() => undefined);
  };
  if (now) write();
  else timer = setTimeout(write, 300);
}
