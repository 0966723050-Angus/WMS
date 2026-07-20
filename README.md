# WMS - Warehouse Management System

ATK 在線製令與物料明細查詢系統。行動裝置優先(RWD)的漸進式網頁應用程式(PWA),資料來源為 `WMS.xlsx`。

## 功能

- 首頁:在線專案一覽表(可展開查看各專案下的製令編號)
- 專案頁:該專案下所有製令列表
- 製令頁:物料明細,支援全文檢索、到料狀態篩選、匯出 Excel
- 可安裝為手機 PWA,離線可瀏覽已載入過的資料

## 開發

資料由 `scripts/build_data.py` 從來源 xlsx 轉換為 `data.json`,前端為純 HTML/CSS/JS,無需建置流程。

```
python scripts/build_data.py   # 重新產生 data.json
python scripts/make_icons.py   # 重新產生 PWA icons
```

本機預覽:於此資料夾執行 `python -m http.server 8000`,瀏覽 `http://localhost:8000`。
