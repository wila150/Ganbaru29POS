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
  /** 有促銷時的原價（畫刪除線） */
  orig?: number;
  promo?: string;
}
export interface DisplayState {
  mode: "idle" | "cart" | "pay" | "done";
  lines?: DisplayLine[];
  total?: number;
  discount?: number;
  member?: string | null;
  /** 金額明細：原價、各種折扣、購物金折抵、服務費 */
  summary?: { gross: number; rows: { label: string; amount: number }[] } | null;
  /** 付款畫面：要客人付的方式和金額（現金＋轉帳時只顯示轉帳那部分） */
  pay?: { method: string; amount: number; parts?: { method: string; amount: number }[]; url?: string } | null;
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
    setDoc(doc(db, "customerDisplay", channel), { lines: [], total: 0, discount: 0, member: null, summary: null, pay: null, change: 0, ...s, at: serverTimestamp() }).catch(() => undefined);
  };
  if (now) write();
  else timer = setTimeout(write, 300);
}

/**
 * 顧客螢幕上請客人自己填會員資料：customerSignup/{門市}
 * open（等客人填）→ filled（客人送出，收銀電腦去 meepShop 建會員）→ done（成功）／open＋error（失敗，請客人修改）→ closed
 */
export interface SignupForm {
  email: string;
  name: string;
  mobile: string;
  birthDate: string;
}
export interface SignupState extends Partial<SignupForm> {
  /** phone = 請客人輸入手機查會員；phoneSent = 客人送出手機 */
  status: "open" | "filled" | "done" | "closed" | "phone" | "phoneSent";
  error?: string | null;
}
export const setSignup = (channel: string, s: SignupState) =>
  setDoc(doc(db, "customerSignup", channel), { email: "", name: "", mobile: "", birthDate: "", error: null, ...s, at: serverTimestamp() });
