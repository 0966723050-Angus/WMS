"""WMS.xlsx「待簽核清單」工作表:同事在網站「待簽核表單」頁按下「確認」的表單,供 ERP 執行表單簽核時讀取。

欄位:日期(按下確認的時間)、表單名稱、程式代碼、單別、單號、廠商、來源、上傳者、狀態、ID
- 只有在網站按「確認」時才寫入(apply_edits 約每分鐘取一次請求):勾選的表單依序接在工作表最後,
  寫入成功後網站才把這幾張從待簽核清單移除。
- 同一張(程式代碼+單別+單號)已經在工作表裡就不重複寫入,但網站清單照樣移除。
- 簽核完成的列由執行端清除;簽核失敗的列留著,「狀態」寫失敗原因。
- 「ID」是網站表單的識別碼,請不要改動。
"""
import datetime
import os
import shutil
import time

import openpyxl
from openpyxl.styles import Alignment, Font

SHEET = "待簽核清單"
HEADERS = ["日期", "表單名稱", "程式代碼", "單別", "單號", "廠商", "來源", "上傳者", "狀態", "ID"]
WIDTHS = {"A": 17.5, "B": 20, "C": 11, "D": 8, "E": 18, "F": 22, "G": 8, "H": 28, "I": 34, "J": 24}
TEXT_COLS = (4, 5)   # 單別 / 單號一律存成文字,避免前導 0 或長數字被轉成數值


def _fmt_ts(ts):
    try:
        return datetime.datetime.fromtimestamp(int(ts) / 1000).strftime("%Y/%m/%d %H:%M")
    except Exception:
        return ""


def _status(f):
    return str(f.get("f") or "")


def _row_values(f):
    return [
        _fmt_ts(f.get("ts")),
        str(f.get("name") or ""),
        str(f.get("prog") or ""),
        str(f.get("docType") or ""),
        str(f.get("docNo") or ""),
        str(f.get("vendor") or ""),
        str(f.get("src") or ""),
        str(f.get("by") or ""),
        _status(f),
        str(f.get("id") or ""),
    ]


def ensure_sheet(wb):
    """沒有「待簽核清單」就建立(標題列、欄寬、格式比照「收料」)。回傳 (ws, 是否新建)。"""
    if SHEET in wb.sheetnames:
        ws = wb[SHEET]
        # 標題列被改過/缺欄時補齊(只補在最後面,不動使用者已有的內容)
        have = [str(ws.cell(1, c).value or "").strip() for c in range(1, len(HEADERS) + 1)]
        if have != HEADERS:
            for i, h in enumerate(HEADERS, start=1):
                ws.cell(1, i).value = h
        return ws, False
    ws = wb.create_sheet(SHEET)
    ref = wb["收料"]["A1"] if "收料" in wb.sheetnames else None
    for i, h in enumerate(HEADERS, start=1):
        c = ws.cell(1, i, h)
        if ref is not None:
            c.font = Font(name=ref.font.name, size=ref.font.sz, bold=True)
        else:
            c.font = Font(bold=True)
        c.alignment = Alignment(horizontal="center")
    for col, w in WIDTHS.items():
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A2"
    return ws, True


def _set(ws, r, values):
    ref = ws.parent["收料"]["A2"] if "收料" in ws.parent.sheetnames else None
    for c, v in enumerate(values, start=1):
        cell = ws.cell(r, c)
        cell.value = v if v != "" else None
        if c in TEXT_COLS:
            cell.number_format = "@"
        if ref is not None and cell.font.name != ref.font.name:
            cell.font = Font(name=ref.font.name, size=ref.font.sz)


def _existing_keys(ws):
    keys = set()
    for r in range(2, ws.max_row + 1):
        k = (str(ws.cell(r, 3).value or "").strip(), str(ws.cell(r, 4).value or "").strip(), str(ws.cell(r, 5).value or "").strip())
        if k[2]:
            keys.add(k)
    return keys


def append_workbook(wb, items, ts):
    """把 items 接在工作表最後(已存在的略過)。回傳 (寫入, 略過) 筆數。"""
    ws, _ = ensure_sheet(wb)
    have = _existing_keys(ws)
    added = skipped = 0
    for f in items:
        key = (str(f.get("prog") or "").strip(), str(f.get("docType") or "").strip(), str(f.get("docNo") or "").strip())
        if key in have:
            skipped += 1
            continue
        r = ws.max_row + 1
        while r > 2 and all(ws.cell(r - 1, c).value is None for c in range(1, len(HEADERS) + 1)):
            r -= 1   # 避免被格式撐大的空白列
        row = dict(f)
        row["ts"] = ts
        _set(ws, r, _row_values(row))
        have.add(key)
        added += 1
    return added, skipped


def append(master, drive_copy, items, ts, log=print):
    """寫入 WMS.xlsx 並複製到雲端硬碟。成功回傳 (寫入, 略過);檔案被 Excel 開著/鎖住回傳 None(留待下次)。"""
    master_dir, master_name = os.path.split(master)
    if os.path.exists(os.path.join(master_dir, "~$" + master_name)):
        log("待簽核清單:主檔目前被 Excel 開啟,留待下次")
        return None
    try:
        wb = openpyxl.load_workbook(master)
        added, skipped = append_workbook(wb, items, ts)
        tmp = master + ".signtmp"
        wb.save(tmp)
        for attempt in range(6):   # 防毒 / 雲端硬碟剛好在讀檔時會短暫拒絕取代,等一下再試
            try:
                os.replace(tmp, master)   # 先存暫存檔再換掉,寫到一半中斷也不會弄壞主檔
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(1.5)
    except PermissionError as ex:
        log("待簽核清單:主檔無法寫入(可能被開啟),留待下次: %s" % ex)
        return None
    try:
        shutil.copy2(master, drive_copy)
    except Exception as ex:
        log("警告: 待簽核清單已寫入主檔,但複製到雲端硬碟失敗(下次 WMS 更新時會一併複製): %s" % ex)
    log("待簽核清單:寫入 %d 張,已在清單中略過 %d 張" % (added, skipped))
    return added, skipped
