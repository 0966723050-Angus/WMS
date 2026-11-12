"""WMS.xlsx「待簽核清單」工作表:網站「待簽核表單」清單的鏡像,供 ERP 執行表單簽核時讀取。

欄位:日期(加入時間)、表單名稱、程式代碼、單別、單號、廠商、來源、上傳者、狀態、ID
- 網站清單是唯一來源:每次(排程約每分鐘)依 pull 回來的 signForms 同步 ——
  新的表單接在最後、改過的欄位更新、網站已刪除或簽核完成的就從工作表移除。
- 「ID」是網站表單的識別碼,簽核結果回報(sign_report)要靠它對應;請不要改動。
- 「狀態」空白 = 待簽核;簽核失敗時會顯示失敗原因。
- ID 欄是空的列(使用者自己手動加的)不會被動到。
"""
import datetime
import json
import os
import shutil

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


def sync_workbook(wb, forms):
    """把 forms(網站清單)同步到工作表。回傳 (新增, 更新, 移除) 筆數。"""
    ws, _ = ensure_sheet(wb)
    want = {}
    for f in sorted(forms, key=lambda x: x.get("ts", 0)):
        if f.get("id"):
            want[str(f["id"])] = f
    id_col = HEADERS.index("ID") + 1
    existing = {}          # id -> row
    drop = []
    for r in range(2, ws.max_row + 1):
        rid = ws.cell(r, id_col).value
        rid = str(rid).strip() if rid is not None else ""
        if not rid:
            continue   # 使用者手動加的列,不動
        if rid in want and rid not in existing:
            existing[rid] = r
        else:
            drop.append(r)   # 網站已經沒有這張(或重複列)
    added = updated = 0
    for rid, r in existing.items():
        vals = _row_values(want[rid])
        cur = [ws.cell(r, c).value for c in range(1, len(HEADERS) + 1)]
        cur = ["" if v is None else str(v) for v in cur]
        if cur != vals:
            _set(ws, r, vals)
            updated += 1
    for r in sorted(drop, reverse=True):
        ws.delete_rows(r)
    for rid, f in want.items():
        if rid in existing:
            continue
        r = ws.max_row + 1
        # 找最後一個有內容的列再接下去(避免被格式撐大的空白列)
        while r > 2 and all(ws.cell(r - 1, c).value is None for c in range(1, len(HEADERS) + 1)):
            r -= 1
        _set(ws, r, _row_values(f))
        added += 1
    return added, updated, len(drop)


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _signature(forms):
    return json.dumps([_row_values(f) for f in sorted(forms, key=lambda x: (x.get("ts", 0), str(x.get("id"))))],
                      ensure_ascii=False)


def sync(master, drive_copy, forms, state_path, log=print, force=False):
    """與上次同步內容相同就不動檔案。回傳 True 表示有寫入。檔案被鎖住時回傳 False 留待下次。"""
    sig = _signature(forms)
    try:
        with open(state_path, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        st = {}
    last = st.get("sig")
    # 清單沒變、主檔也沒被別人(例如 WMS 一鍵更新、ERP 清除)動過就不用重寫
    if last == sig and st.get("mtime") == _mtime(master) and not force:
        return False
    master_dir, master_name = os.path.split(master)
    if os.path.exists(os.path.join(master_dir, "~$" + master_name)):
        log("待簽核清單:主檔目前被 Excel 開啟,留待下次同步")
        return False
    try:
        wb = openpyxl.load_workbook(master)
        added, updated, removed = sync_workbook(wb, forms)
        if added or updated or removed or SHEET not in wb.sheetnames or last is None:
            tmp = master + ".signtmp"
            wb.save(tmp)
            os.replace(tmp, master)   # 先存暫存檔再換掉,寫到一半中斷也不會弄壞主檔
            try:
                shutil.copy2(master, drive_copy)
            except Exception as ex:
                log("警告: 待簽核清單已寫入主檔,但複製到雲端硬碟失敗(下次 WMS 更新時會一併複製): %s" % ex)
            log("待簽核清單:新增 %d、更新 %d、移除 %d(目前共 %d 張)" % (added, updated, removed, len(forms)))
    except PermissionError as ex:
        log("待簽核清單:主檔無法寫入(可能被開啟),留待下次: %s" % ex)
        return False
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump({"sig": sig, "mtime": _mtime(master)}, f, ensure_ascii=False)
    return True
