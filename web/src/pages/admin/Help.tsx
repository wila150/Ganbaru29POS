import { useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../../auth";
import { atLeast, type Role } from "../../lib/util";

/**
 * 使用說明書：每一章是一組步驟，每一步配一張「示意畫面」（照實際畫面縮小重畫），
 * 要按的地方用橘色框＋手指標出來。內容寫在這裡，系統改版時一起更新。
 */

// ---------------- 示意畫面零件 ----------------

/** 要按的地方：橘色閃爍外框＋手指 */
function Hl({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <span className="hm-hl">
      {children}
      <span className="hm-finger" aria-hidden>
        👆
      </span>
      {tip && <span className="hm-tip">{tip}</span>}
    </span>
  );
}

/** 平板外框 */
function Tablet({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <figure className="hm-figure">
      <div className="hm-tablet">{children}</div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

const POS_MENU = ["收銀", "訂單", "線上訂單", "錢櫃", "日結", "交易瀏覽", "會員", "庫存", "打卡"];
const ADMIN_MENU = ["進貨掃碼", "庫存查詢", "盤點", "調貨", "商品與條碼", "顧客管理", "行銷", "異動紀錄", "報表", "打卡", "設定"];

/** POS 畫面：左選單、中商品、右購物車；hl 指定要標出的地方 */
function PosMock({ menu = "收銀", hl, cart = true, overlay }: { menu?: string; hl?: string; cart?: boolean; overlay?: ReactNode }) {
  const m = (label: string) => (hl === `menu:${label}` ? <Hl key={label}>{<span className={`hm-pos-item ${menu === label ? "on" : ""}`}>{label}</span>}</Hl> : <span key={label} className={`hm-pos-item ${menu === label ? "on" : ""}`}>{label}</span>);
  const box = (key: string, node: ReactNode) => (hl === key ? <Hl>{node}</Hl> : node);
  return (
    <div className="hm-pos">
      <div className="hm-pos-top">
        <b>29</b> ganbaru29　營業日 2026-10-18　早班<span className="grow" />店員 13:45
      </div>
      <div className="hm-pos-body">
        <div className="hm-pos-menu">{POS_MENU.map(m)}</div>
        <div className="hm-pos-main">
          <div className="hm-row">
            {box("scan", <span className="hm-input">掃條碼或輸入編號</span>)}
            {box("camera", <span className="hm-btn dark">📷 相機</span>)}
            <span className="hm-input grow">搜尋商品</span>
          </div>
          <div className="hm-row">
            {["全部", "外套", "長袖", "長褲", "套裝"].map((c, i) => (
              <span key={c} className={`hm-chip ${i === 0 ? "on" : ""}`}>
                {c}
              </span>
            ))}
          </div>
          <div className="hm-grid">
            {["機能外套", "寬褲", "襯衫", "大學T", "背心", "風衣"].map((n, i) =>
              box(
                i === 0 ? "product" : `p${i}`,
                <span key={n} className="hm-card">
                  <span className="hm-img" />
                  {n}
                  <small>$1,900</small>
                  <span className="hm-stock">{5 + i}</span>
                </span>
              )
            )}
          </div>
        </div>
        {cart && (
          <div className="hm-cart">
            <div className="hm-row between">
              <b>購物車</b>
              {box("member", <span className="hm-btn">＋會員</span>)}
            </div>
            {box("coupon", <span className="hm-link">＋優惠碼</span>)}
            {box(
              "line",
              <div className="hm-line">
                機能外套 <span className="grow" />× 1　$1,900
              </div>
            )}
            <div className="grow" />
            <div className="hm-disc">
              <span>服務費<b>0%</b></span>
              {box("zhe", <span>整單打折<b>85 折</b></span>)}
              <span>折讓<b>$0</b></span>
              {box("points", <span>購物金<b>0</b></span>)}
            </div>
            <div className="hm-row">
              <span className="hm-btn">清空</span>
              {box("hold", <span className="hm-btn">掛單</span>)}
              {box("pay", <span className="hm-btn pay grow">結帳 · 1 件　$1,615</span>)}
            </div>
          </div>
        )}
      </div>
      {overlay && <div className="hm-overlay">{overlay}</div>}
    </div>
  );
}

/** 後台畫面：左側選單＋內容 */
function AdminMock({ menu, hl, children }: { menu: string; hl?: string; children: ReactNode }) {
  return (
    <div className="hm-admin">
      <div className="hm-side">
        <div className="hm-brand">
          <b>29</b> ganbaru29
        </div>
        {ADMIN_MENU.map((l) =>
          hl === `menu:${l}` ? (
            <Hl key={l}>
              <span className={`hm-side-item ${menu === l ? "on" : ""}`}>{l}</span>
            </Hl>
          ) : (
            <span key={l} className={`hm-side-item ${menu === l ? "on" : ""}`}>
              {l}
            </span>
          )
        )}
        <span className="grow" />
        {hl === "pos" ? (
          <Hl>
            <span className="hm-side-item pos">¤ POS 收銀</span>
          </Hl>
        ) : (
          <span className="hm-side-item pos">¤ POS 收銀</span>
        )}
        {hl === "update" ? (
          <Hl>
            <span className="hm-link">檢查更新</span>
          </Hl>
        ) : (
          <span className="hm-link">檢查更新</span>
        )}
      </div>
      <div className="hm-admin-main">{children}</div>
    </div>
  );
}

/** 對話框 */
function Dialog({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="hm-dialog">
      <div className="hm-dialog-head">
        <b>{title}</b>
        <span>✕</span>
      </div>
      {children}
    </div>
  );
}

function Keys({ value, unit }: { value: string; unit?: string }) {
  return (
    <>
      <div className="hm-display">
        {value}
        {unit && <small> {unit}</small>}
      </div>
      <div className="hm-keys">
        {["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "⌫"].map((k) => (
          <span key={k}>{k}</span>
        ))}
      </div>
    </>
  );
}

// ---------------- 章節內容 ----------------

interface Step {
  text: ReactNode;
  figure?: ReactNode;
}
interface Chapter {
  id: string;
  title: string;
  icon: string;
  who: Role;
  intro?: string;
  steps: Step[];
  tips?: string[];
}

const CHAPTERS: Chapter[] = [
  {
    id: "start",
    title: "開始使用",
    icon: "🚀",
    who: "staff",
    intro: "用自己的 Google 帳號登入；帳號要先由老闆在「設定 → 員工管理」邀請。",
    steps: [
      {
        text: (
          <>
            iPad 用 Safari 打開 <b>ganbaru29.web.app</b>，按「用 Google 帳號登入」。
          </>
        ),
      },
      {
        text: (
          <>
            加到主畫面：Safari 下方「分享 <b>⬆︎</b>」→「<b>加入主畫面</b>」。之後從主畫面的 29 圖示開啟，就像一般 App。
          </>
        ),
      },
      {
        text: (
          <>
            系統更新會自動套用（每 5 分鐘或切回 App 時）。想馬上更新：按左下角「<b>檢查更新</b>」。
          </>
        ),
        figure: (
          <Tablet caption="後台左下角的「檢查更新」">
            <AdminMock menu="進貨掃碼" hl="update">
              <div className="hm-h">進貨掃碼</div>
            </AdminMock>
          </Tablet>
        ),
      },
      {
        text: (
          <>
            從後台進收銀：按左邊選單最下方固定的「<b>POS 收銀</b>」。
          </>
        ),
        figure: (
          <Tablet>
            <AdminMock menu="進貨掃碼" hl="pos">
              <div className="hm-h">進貨掃碼</div>
            </AdminMock>
          </Tablet>
        ),
      },
    ],
  },
  {
    id: "open",
    title: "開班",
    icon: "🔓",
    who: "staff",
    intro: "每天第一位店員先開班，才能結帳。",
    steps: [
      {
        text: (
          <>
            POS 左邊選「<b>錢櫃</b>」→ 選班別、輸入錢櫃裡的零用金 →「開班」。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock menu="錢櫃" hl="menu:錢櫃" cart={false} overlay={<Dialog title="開班"><div className="hm-row"><span className="hm-chip on">早班</span><span className="hm-chip">晚班</span></div><Keys value="$3,000" /><span className="hm-btn dark block">開班</span></Dialog>} />
          </Tablet>
        ),
      },
      { text: "中途放錢、拿錢（例：找零不夠去換錢、付廠商）也在「錢櫃」記一筆，日結才對得起來。" },
    ],
  },
  {
    id: "sell",
    title: "收銀結帳",
    icon: "🧾",
    who: "staff",
    steps: [
      {
        text: (
          <>
            加商品：用<b>掃描槍</b>掃吊牌 QR／條碼（游標在哪都可以掃），或按「<b>📷 相機</b>」用 iPad 鏡頭掃，或直接點商品圖卡。有尺寸顏色會跳出規格表。
          </>
        ),
        figure: (
          <Tablet caption="掃描槍直接掃；沒有掃描槍就按相機">
            <PosMock hl="camera" />
          </Tablet>
        ),
      },
      {
        text: (
          <>
            帶會員：按「<b>＋會員</b>」輸入手機號碼（0 開頭可以直接打），或掃客人的<b>會員條碼</b>（M 開頭）。帶入後會自動套用會員折扣、顯示可用購物金。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock hl="member" overlay={<Dialog title="會員"><span className="hm-input block">0952977768</span><Keys value="0952977768" /></Dialog>} />
          </Tablet>
        ),
      },
      {
        text: (
          <>
            打折：整張單按「<b>整單打折</b>」，直接輸入幾折——<b>85 = 85 折</b>、9 = 9 折。單一件商品：點購物車那一行 →「單品打折（折）」。折扣活動（例：甘爹 85 折）會<b>自動</b>套用，不用手動打。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock hl="zhe" overlay={<Dialog title="整單打折"><Keys value="85" unit="折" /></Dialog>} />
          </Tablet>
        ),
      },
      {
        text: (
          <>
            用購物金：帶會員後按「<b>購物金</b>」輸入要折抵幾點（1 點 = 1 元，最多到他的餘額）。結帳時系統會從他的 meepShop 帳戶扣掉。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock hl="points" />
          </Tablet>
        ),
      },
      {
        text: (
          <>
            按「<b>結帳</b>」→ 選付款方式。現金會自動算找零；信用卡請在刷卡機另外刷；一張單分兩種付款選「混合付款」。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock hl="pay" overlay={<Dialog title="結帳 $1,615"><div className="hm-row"><span className="hm-chip on">現金</span><span className="hm-chip">信用卡</span><span className="hm-chip">LINE Pay</span><span className="hm-chip">轉帳</span><span className="hm-chip">混合付款</span></div><div className="hm-row"><span className="hm-btn">$1,615</span><span className="hm-btn">$1,700</span><span className="hm-btn">$2,000</span></div><span className="hm-btn pay block">完成結帳（找零 $385）</span></Dialog>} />
          </Tablet>
        ),
      },
      { text: "結帳完成會播放音效、印收據；有帶會員會自動送回饋購物金（依「購物金回饋」規則）。" },
    ],
    tips: ["客人還沒決定：按「掛單」先存起來，之後在「訂單」取回。", "跳出「網店庫存不足」：代表網店剛賣掉。確認店裡真的有這件才按「仍要結帳」。"],
  },
  {
    id: "refund",
    title: "退貨、換貨、作廢",
    icon: "↩️",
    who: "staff",
    intro: "退貨限店長以上（老闆可在設定開放給員工）。",
    steps: [
      {
        text: (
          <>
            POS 左邊「<b>交易瀏覽</b>」→ 找到那張單（可搜單號、會員）→ 點開。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock menu="交易瀏覽" hl="menu:交易瀏覽" cart={false} />
          </Tablet>
        ),
      },
      { text: "「退貨」：勾要退的商品和數量 → 選退款方式。庫存自動加回、用掉的購物金自動退回、送出的回饋購物金依比例收回。" },
      { text: "「換貨」：選要換回來的商品，系統把金額當作抵用，再到收銀台結新的商品，差額多退少補。" },
      { text: "「作廢」：整張單取消（例：結錯單），全部退回。" },
    ],
  },
  {
    id: "close",
    title: "日結交班",
    icon: "✅",
    who: "staff",
    steps: [
      {
        text: (
          <>
            POS 左邊「<b>日結</b>」：看各付款方式小計，點算錢櫃現金後輸入「實點現金」。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock menu="日結" hl="menu:日結" cart={false} overlay={<Dialog title="日結"><div className="hm-line">現金 <span className="grow" />$12,300</div><div className="hm-line">信用卡 <span className="grow" />$8,400</div><div className="hm-line">LINE Pay <span className="grow" />$1,900</div><span className="hm-input block">實點現金 $15,300</span><span className="hm-btn dark block">結班</span></Dialog>} />
          </Tablet>
        ),
      },
      { text: "有差額會顯示出來並記錄；信用卡小計請跟刷卡機的結帳單對一下。" },
      { text: "還沒結班的員工不能登出（店長、老闆可以強制登出）。" },
    ],
  },
  {
    id: "member",
    title: "會員",
    icon: "🙂",
    who: "staff",
    steps: [
      {
        text: (
          <>
            現場新增會員：「＋會員」→ 查不到時按「<b>＋ 現場新增會員</b>」→ 填 <b>Email、手機、生日</b>（meepShop 規定 Email、生日必填）→「新增並帶入」。會員直接建在 meepShop，網店也能用。
          </>
        ),
        figure: (
          <Tablet>
            <PosMock hl="member" overlay={<Dialog title="會員"><span className="hm-input block">Email（必填）</span><span className="hm-input block">姓名</span><span className="hm-input block">手機</span><span className="hm-input block">生日（必填）1995/08/20</span><span className="hm-btn dark">新增並帶入</span></Dialog>} />
          </Tablet>
        ),
      },
      { text: "新會員的入會禮購物金、預設群組由 meepShop 補上，幾秒後畫面會自動更新。" },
      { text: "會員條碼：會員頁按「會員卡」可顯示條碼，客人也能在 LINE 官方帳號的會員卡出示，結帳時直接掃。" },
      { text: "後台「顧客管理 → 顧客名單」可以看每位會員的購物金、已使用購物金、消費，並匯出 Excel。" },
    ],
  },
  {
    id: "stock-in",
    title: "進貨掃碼",
    icon: "📦",
    who: "staff",
    steps: [
      {
        text: (
          <>
            後台「<b>進貨掃碼</b>」→ 上方選「進貨」→ 掃商品 QR → 確認數量。網店（meepShop）庫存幾秒內自動加上去。
          </>
        ),
        figure: (
          <Tablet>
            <AdminMock menu="進貨掃碼" hl="menu:進貨掃碼">
              <div className="hm-row">
                <span className="hm-chip on">進貨</span>
                <span className="hm-chip">退貨</span>
                <span className="hm-chip">報廢</span>
              </div>
              <span className="hm-input block">掃描或輸入條碼 / 商品編號</span>
              <div className="hm-line ok">✓ 機能外套（黑 / L）+3　網店現在 8 件</div>
            </AdminMock>
          </Tablet>
        ),
      },
      { text: "掃錯了：10 分鐘內可以按「撤銷這筆」。" },
      { text: "顯示黃色「待同步」：網路或 meepShop 暫時連不上，系統會自動重送，不用重掃。" },
      { text: "掃到不認得的條碼：請店長在「商品與條碼」綁定。" },
    ],
  },
  {
    id: "stocktake",
    title: "盤點",
    icon: "🔢",
    who: "staff",
    steps: [
      { text: "店長在後台「盤點」開一張盤點單（全部或某區），系統先拿 meepShop 最新庫存當帳面。" },
      {
        text: "每個人用手機或平板開同一張盤點單，掃一下 = 實盤 +1，可以多人同時掃。",
        figure: (
          <Tablet>
            <AdminMock menu="盤點" hl="menu:盤點">
              <div className="hm-h">盤點單 10/18 全店</div>
              <div className="hm-line">機能外套 黑/L <span className="grow" />帳面 5　實盤 4　<b className="bad">−1</b></div>
              <div className="hm-line">寬褲 卡其/M <span className="grow" />帳面 3　實盤 3</div>
            </AdminMock>
          </Tablet>
        ),
      },
      { text: "掃完看差異表，店長按「套用」，一次更新網店庫存。" },
    ],
  },
  {
    id: "labels",
    title: "商品標籤、QR Code",
    icon: "🏷",
    who: "manager",
    steps: [
      { text: "meepShop 新增商品後 15 分鐘內會自動出現在系統，圖片隔天自動補上。" },
      { text: "「商品與條碼」→ 勾選商品（可全選、只選未印過的）→ 列印吊牌或下載 QR Code 圖檔。" },
      { text: "有原廠條碼的商品可以綁定，一個規格可綁多個條碼。" },
    ],
  },
  {
    id: "discount",
    title: "折扣活動",
    icon: "％",
    who: "manager",
    steps: [
      {
        text: (
          <>
            後台「行銷 → <b>折扣</b>」→「新增折扣」→ 選類型：商品折扣、滿額折扣、選選樂、優惠碼、滿額贈…
          </>
        ),
        figure: (
          <Tablet>
            <AdminMock menu="行銷" hl="menu:行銷">
              <Dialog title="新增折扣">
                <div className="hm-grid small">
                  {["商品折扣", "滿額折扣", "選選樂", "優惠碼", "滿額贈", "購物金"].map((n, i) =>
                    i === 0 ? (
                      <Hl key={n}>
                        <span className="hm-card">🏷 {n}</span>
                      </Hl>
                    ) : (
                      <span key={n} className="hm-card">
                        {n}
                      </span>
                    )
                  )}
                </div>
              </Dialog>
            </AdminMock>
          </Tablet>
        ),
      },
      { text: "設定活動名稱、期間（或永久開放）、適用顧客群組（例：甘爹）、適用商品（選擇商品）、折扣（輸入 85 = 85 折）。" },
      { text: "多個活動重疊時，系統自動選對客人最優惠的組合；在列表用開關隨時啟用／停用。" },
    ],
  },
  {
    id: "reward",
    title: "購物金回饋",
    icon: "🪙",
    who: "owner",
    steps: [
      { text: "「行銷 → 購物金回饋」設定規則：適用群組、每消費多少送多少（例：尊貴的客人 每 $10 送 $1）、使用期限。" },
      { text: "門市結帳完成後自動送到客人的 meepShop 帳戶，網店也能用；退貨時依比例收回。" },
      { text: "會員生日禮、入會禮由 meepShop 自動寄送，系統只記錄不重複送。" },
    ],
  },
  {
    id: "sound",
    title: "結帳音效",
    icon: "🔔",
    who: "owner",
    steps: [
      { text: "「設定 → 結帳音效」選內建音效，或「上傳音樂／影片」（mp4、mov 會自動轉成 mp3，可設定取第幾秒起幾秒）。" },
      { text: "「新增條件」：例如「今天是會員生日 → 播生日歌」「群組是甘爹 → 播鈴聲」，由上到下第一個符合的生效。" },
      { text: "iPad 要打開音量、關閉靜音。" },
    ],
  },
  {
    id: "faq",
    title: "常見問題",
    icon: "❓",
    who: "staff",
    steps: [
      { text: "畫面卡卡或少了東西：按「檢查更新」，或把 App 關掉重開。" },
      { text: "購物金扣抵失敗、單被取消：到 meepShop 後台查這位會員的購物金，確認後重新結帳。" },
      { text: "異動紀錄有紅色「失敗／待確認」：店長到「異動紀錄」看原因，確認後按重送或已處理。" },
      { text: "新增會員失敗：Email 已經是會員就用「搜尋」帶入；生日一定要填。" },
      { text: "還有問題：截圖畫面給工程師。" },
    ],
  },
];

// ---------------- 頁面 ----------------

export function Help() {
  const { profile } = useAuth();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const visible = CHAPTERS.filter((c) => atLeast(profile?.role, c.who));
    const t = q.trim();
    if (!t) return visible;
    const text = (n: ReactNode): string => (typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" && "props" in n ? text((n as { props: { children?: ReactNode } }).props.children) : "");
    return visible.filter((c) => c.title.includes(t) || (c.intro ?? "").includes(t) || c.steps.some((s) => text(s.text).includes(t)) || (c.tips ?? []).some((x) => x.includes(t)));
  }, [profile?.role, q]);

  return (
    <div className="page help">
      <div className="page-head">
        <div>
          <h1>使用說明書</h1>
          <div className="muted small">照步驟做就好；橘色框 👆 是要按的地方。</div>
        </div>
        <button className="btn no-print" onClick={() => window.print()}>
          列印
        </button>
      </div>
      <input className="no-print" placeholder="搜尋，例如：退貨、購物金、盤點" value={q} onChange={(e) => setQ(e.target.value)} />
      <nav className="help-toc no-print">
        {list.map((c) => (
          <a key={c.id} href={`#${c.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(c.id)?.scrollIntoView({ behavior: "smooth" }))}>
            <span>{c.icon}</span>
            {c.title}
          </a>
        ))}
      </nav>
      {list.length === 0 && <p className="muted">找不到相關說明</p>}
      {list.map((c) => (
        <section key={c.id} id={c.id} className="card help-chapter">
          <h2>
            <span className="help-icon">{c.icon}</span>
            {c.title}
            {c.who !== "staff" && <span className="badge badge-info">{c.who === "owner" ? "老闆" : "店長以上"}</span>}
          </h2>
          {c.intro && <p className="muted">{c.intro}</p>}
          <ol className="help-steps">
            {c.steps.map((s, i) => (
              <li key={i}>
                <span className="help-num">{i + 1}</span>
                <div className="help-step">
                  <p>{s.text}</p>
                  {s.figure}
                </div>
              </li>
            ))}
          </ol>
          {c.tips && (
            <div className="help-tips">
              {c.tips.map((t) => (
                <p key={t}>💡 {t}</p>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
