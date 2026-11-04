# 登入驗證 + 儲位編輯中繼 - 部署步驟

網站(GitHub Pages)是公開的靜態網頁,所以保護方式是:

- 公開的只有**加密後的資料檔 `data.enc`**,沒有金鑰誰都看不懂。
- 使用者用 Google 帳號登入 → Apps Script 驗證身分並檢查**授權名單** → 名單內才拿得到解密金鑰。
- 名單由管理者(只有您)在網站「設定」頁管理,資料存在 Apps Script 的指令碼屬性。
- 儲位編輯也走登入身分(不再使用共用的儲存密碼),寫回 Excel 的流程不變。

## 1. Google Cloud:建立 OAuth 用戶端 ID(只需一次)
1. 用 `@atk.com.tw` 帳號開啟 https://console.cloud.google.com ,建立一個新專案(例如 `WMS Login`)。
2. 「API 和服務」→「OAuth 同意畫面」:
   - 使用者類型選 **內部**(只有公司網域帳號可登入;若日後要加入非 atk.com.tw 的帳號,要改選「外部」並發布)。
   - 填應用程式名稱(WMS)、使用者支援電子郵件、開發人員聯絡電子郵件,儲存。
3. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」:
   - 應用程式類型:**網頁應用程式**
   - 「已授權的 JavaScript 來源」新增:`https://0966723050-angus.github.io`
   - 建立後複製**用戶端 ID**(格式 `xxxxxxxx.apps.googleusercontent.com`)。這個 ID 不是機密。

## 2. Apps Script:更新程式與屬性
1. 開啟原本的 Apps Script 專案,把 `Code.gs` 全部換成本資料夾的新版 `Code.gs`,存檔。
2. 「專案設定」→「指令碼屬性」,確認/新增:
   - `GOOGLE_CLIENT_ID`:上一步的用戶端 ID
   - `ADMIN_EMAIL`:管理者帳號(`0966723050@atk.com.tw`)
   - `SYNC_KEY`:沿用原本的(不用改)
   - 舊的 `PIN` 已不再使用,可以刪除
   - `DATA_KEY`、`SESSION_SECRET` 不用手動設定(前者由 `setup_auth.py` 上傳,後者自動產生)
3. 「部署」→「管理部署作業」→ 編輯(鉛筆)→ 版本選「**新版本**」→ 部署。網址不變。
   首次會要求重新授權(新版需要「連線到外部服務」來向 Google 驗證登入權杖),請同意。

## 3. 本機:產生資料金鑰並啟用加密
```
python scripts\setup_auth.py
```
會產生金鑰、上傳到 Apps Script 的 `DATA_KEY`,並存成 `scripts\auth_config.json`(不進版控)。
之後 `build_data.py` 就只會輸出加密的 `data.enc`,不再輸出明文 `data.json`。

## 4. 管理名單
管理者登入後,標題列會出現齒輪圖示 → 「登入名單管理」:可批次新增(每行 `email 姓名`)、編輯、停用/啟用、刪除。

## 更換資料金鑰(例如有人離職、要立即讓舊登入失效)
```
python scripts\setup_auth.py --rotate
```
然後讓排程(或手動)重新產生資料並發布;所有人的舊金鑰會失效,需要重新登入。

## 注意
- 已登入的裝置會保存登入狀態最長 24 小時;被停用/刪除的帳號,編輯與管理功能會立即失效,但已經下載到該裝置的資料要等到金鑰更換或 24 小時後才失效。
- 舊版網站曾公開過明文資料,啟用加密後也一併清除了 GitHub 上的歷史版本,但已被下載過的資料無法收回。
