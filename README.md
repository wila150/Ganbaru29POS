# ganbaru29 庫存＋POS 系統

依《ganbaru29 庫存＋POS 系統｜後台架構》實作。門市用 POS 結帳、進貨掃 QR code，meepShop 網店庫存在幾秒內跟著加減；網路訂單照舊由 meepShop 自己扣庫存（方案 B）。

```
手機 / 平板 / 老闆電腦 ──呼叫──▶ Cloud Functions ──加減庫存──▶ meepShop Open API
        │                      │  （金鑰只在 Secret Manager）
        └──即時讀取──▶ Firestore ◀┘                ──推播──▶ LINE
                          ▲
            Cloud Scheduler：每 5 分鐘重試、每 15 分鐘抓新商品、每天 04:00 完整同步、09:00 提醒
```

## 專案結構

| 路徑 | 內容 |
| --- | --- |
| `functions/src/lib/meepshop.ts` | meepShop GraphQL 客戶端（限流、錯誤分類：沒送到／結果不明／被拒） |
| `functions/src/lib/movements.ts` | 異動紀錄核心：先記紀錄再同步、防重複扣、批次先進先出、平均成本 |
| `functions/src/inventory.ts` | `scanMove` `undoMove` `lookupCode` `resolveMovement` 條碼綁定、商品設定、手動圖片 |
| `functions/src/sync.ts` | `syncCatalog`（手動）、每 15 分鐘增量、每日完整同步、官網 og:image 抓圖、會員快取 |
| `functions/src/stocktake.ts` | 開盤點單、多人計數、`applyStocktake`（bulkAdjustStockQuantity） |
| `functions/src/pos.ts` | `posCheckout` 退貨／作廢、開班／存提款／日結、線上訂單、會員查詢與新增 |
| `functions/src/jobs.ts` | `retryFailed`（每 5 分鐘）、`lowStockAlert`（每天 9:00）、`salesReport` |
| `functions/src/staff.ts` | 老闆首次登入、邀請員工、改角色、停用 |
| `functions/src/settings.ts` | 更換／測試 meepShop 金鑰、LINE token |
| `web/src/pages/admin/` | 後台 7 頁：進貨掃碼、庫存查詢、盤點、商品與條碼（含 QR 標籤列印）、異動紀錄、報表、設定 |
| `web/src/pages/pos/` | POS：收銀、訂單（掛單）、線上訂單、錢櫃、日結、交易瀏覽、會員 |
| `firestore.rules` `storage.rules` | 前端只能讀；寫入一律經過 Cloud Functions（例外：老闆改一般設定、收銀存掛單） |

meepShop 的 GraphQL 查詢已逐一對照官方公開 schema（[Apollo Studio](https://studio.apollographql.com/public/open-api?variant=production)）驗證。

## 第一次部署

需要：Node 22、[Firebase CLI](https://firebase.google.com/docs/cli)（`npm i -g firebase-tools`）、[gcloud CLI](https://cloud.google.com/sdk/docs/install)。

1. **建立 Firebase 專案**（例如 `ganbaru29`），升級成 **Blaze 方案**（Cloud Functions 要連外部 meepShop、LINE，免費方案不行；門市用量的費用很低）。
   - Authentication → 登入方式 → 啟用 **Google**
   - Firestore → 建立資料庫，位置選 `asia-east1`（台灣）
   - Storage → 開始使用
   - 專案設定 → 新增「網頁應用程式」，記下 SDK 設定
2. 把 `.firebaserc` 裡的 `ganbaru29` 改成你的專案 ID。
3. **建立 Secret Manager 的兩個密鑰並給 Functions 權限**（金鑰本身之後在系統的「設定」頁貼上）：
   ```bash
   PROJECT=ganbaru29
   gcloud config set project $PROJECT
   gcloud services enable secretmanager.googleapis.com cloudscheduler.googleapis.com
   gcloud secrets create MEEPSHOP_API_KEY --replication-policy=automatic
   gcloud secrets create LINE_CHANNEL_TOKEN --replication-policy=automatic
   SA="$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
   for S in MEEPSHOP_API_KEY LINE_CHANNEL_TOKEN; do
     gcloud secrets add-iam-policy-binding $S --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
     gcloud secrets add-iam-policy-binding $S --member="serviceAccount:$SA" --role=roles/secretmanager.secretVersionManager
   done
   ```
4. **設定老闆與工程師帳號**：複製 `functions/.env.example` 成 `functions/.env`，填 `OWNER_EMAIL=老闆的 Google 帳號`、`ENGINEER_EMAILS=工程師的 Google 帳號`（多個用逗號分隔）。
5. **設定前端**：複製 `web/.env.example` 成 `web/.env`，填入第 1 步的 SDK 設定。
6. **安裝與部署**：
   ```bash
   npm --prefix functions install
   npm --prefix web install
   firebase deploy
   ```
7. 用老闆或工程師的 Google 帳號打開網站登入 → **設定 → meepShop API 金鑰** 貼上金鑰（系統會先試查一次才存）→ **商品與條碼 → 立即同步 meepShop 商品**。

## 上線前測試（PDF 第 1 階段）

meepShop 沒有測試環境，請在 meepShop 後台新開一個**不上架**的測試商品：

1. 「立即同步」後，在「商品與條碼」找到它，綁一個條碼或印它的 QR 標籤。
2. 「進貨掃碼」選進貨、數量 1 掃一下 → 畫面應顯示「已同步，網店現在 N 件」，到 meepShop 後台確認 +1。
3. 按「撤銷這筆」→ 確認 meepShop 回到原數字。
4. 開一個班（POS → 錢櫃），用 POS 賣這個測試商品 → 確認 meepShop −1；到「交易瀏覽」退貨 → 確認 +1。
5. 確認 API 的商品 ID 等於官網網址 `https://www.ganbaru29.com/products/{ID}` 的 ID：同步後到「商品與條碼」看圖片有沒有自動出現；「缺圖片」很多就代表 ID 不同，要回報調整。

## 角色

| 角色 | 可以做的事 |
| --- | --- |
| 老闆 | 全部；員工管理、金鑰、含成本報表；可停用工程師 |
| 工程師 | 與老闆相同（維護系統用）；由 `ENGINEER_EMAILS` 設定，不能用邀請連結產生 |
| 店長 | 報廢、條碼綁定、商品設定、開盤點單與套用、異動紀錄、不含成本的報表、退貨作廢 |
| 員工 | 進貨／退貨掃碼、盤點計數、撤銷自己 10 分鐘內的紀錄、POS 收銀 |

新增員工：設定 → 員工管理 → 輸入 Email 和角色 → 把邀請連結傳給員工 → 員工用那個 Google 帳號登入、按接受。停用後立即不能操作（每個函式都即時檢查），過去紀錄保留。

## 實作時做的決定（PDF 沒寫死的地方）

- **進貨頁的「退貨」= 退回廠商（扣庫存）**。客人退貨走 POS「交易瀏覽 → 退貨」（加回庫存）。
- **會員用手機查詢**：meepShop 的 `shoppers` 只能用 Email／ID 查，不能用手機，所以系統每 15 分鐘把會員同步到本地（`shoppers` 集合）用手機比對，查到後再向 meepShop 拿即時購物金。
- **現場新增會員一定要 Email**：meepShop `createShopper` 規定。
- **購物金**：1 點折抵金額、消費回饋 % 在「設定 → POS 與門市」設定（預設 1 點 = 1 元、不回饋）。
- **退貨／作廢預設限店長以上**，可在設定開放給員工。
- **盤點套用**的差異 = 實盤 − 「套用當下」的 meepShop 庫存（不是開單時的帳面），避免盤點期間網店賣出被算錯。預設只調整有盤到的款式；也可選「沒盤到的視為 0」。
- **批次效期**：出貨（門市或網店）一律先扣最早到期的批次；網店訂單由 meepShop 扣，系統在同步時把多出來的批次數量依先進先出扣掉。
- **成本**只存在 `costs` 集合，Firestore 規則只讓老闆讀；店長的報表由伺服器產生不含成本的版本。
- **匯出 Excel** 用 UTF-8 CSV（Excel 直接開）。
- **LINE 推播**用 Messaging API（LINE Notify 已在 2025 年停止服務）：需要 LINE 官方帳號的 Channel access token 與推播對象 userId。
- **離線**：進貨掃碼在斷網時會先存在手機，恢復後自動補送；異動 id 在手機產生，重送不會重複扣。

## 硬體與收據

- 收據用瀏覽器列印（58／80mm 熱感紙）。藍牙或 USB 出單機安裝成系統印表機即可；錢櫃接在出單機的錢櫃孔，在印表機驅動設定「列印後開錢櫃」。
- 掃描槍：任何「鍵盤模式」掃描槍都可用（收銀畫面任何地方直接掃）；手機／平板可用相機掃（需 HTTPS，部署後的網址就是）。
- 建議 12 吋平板橫向使用 POS。

## 尚未做（PDF 列為待決定）

- 電子發票（需申請加值中心並串接）
- POS 訂單不會出現在 meepShop 後台（API 不能建訂單），門市銷售請看本系統報表／交易瀏覽。

## 本機開發

```bash
npm --prefix web run dev          # 前端 http://localhost:5173（連正式 Firebase）
```
要用 Firebase Emulator 需安裝 Java，`web/.env` 設 `VITE_USE_EMULATORS=true`，並在 `functions/.env.local` 放 `MEEPSHOP_API_KEY=...` 後執行 `npm --prefix functions run serve`。
