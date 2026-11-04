"""把網頁「物料儲位查詢」送出的編輯(類別/儲放地點/儲位)寫回 WMS.xlsx 的「庫存物料」工作表 E~G 欄。

流程:向 Apps Script 中繼取回待處理修改 -> 備份 -> 寫入主檔 -> 複製到雲端硬碟 -> 回報已處理。
有寫入時結束代碼為 10(讓排程接著重新產生 data.json 並發布),沒有事做為 0,失敗為 1。
設定檔 edit_config.json(不進版控):{"endpoint": "<Apps Script /exec 網址>", "syncKey": "<SYNC_KEY>"}
"""
import argparse
import datetime
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "edit_config.json")
DEFAULT_MASTER = r"C:\ATK\Project\AI Agent\WMS\WMS.xlsx"
DEFAULT_DRIVE_COPY = r"C:\Users\angus.ad\我的雲端硬碟\ATK\WMS.xlsx"
BACKUP_DIR = os.path.join(HERE, "backup")
LOG_FILE = os.path.join(HERE, "apply_edits.log")
KEEP_BACKUPS = 20

SHEET = "庫存物料"
HEADERS = ["材料品號", "品名", "規格", "庫存數量", "類別", "儲放地點", "儲位"]
EXIT_APPLIED = 10


def log(msg):
    line = "[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line)


def norm(v):
    return " ".join(("" if v is None else str(v)).split())[:200]


def num_str(v):
    s = ("" if v is None else str(v)).strip()
    try:
        return str(float(s))
    except ValueError:
        return s


def call(endpoint, params):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
    last = None
    # Apps Script 偶爾會回傳 HTML 而不是 JSON,重試幾次
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as ex:
            last = ex
            time.sleep(2)
    raise last


def row_matches(ws, r, e):
    return (
        str(ws.cell(r, 1).value or "").strip() == e["code"]
        and norm(ws.cell(r, 2).value) == norm(e.get("name"))
        and norm(ws.cell(r, 3).value) == norm(e.get("spec"))
    )


def locate(ws, e):
    """依列號驗證;列號對不上時,用品號+品名+規格(+庫存數量)重新找,找不到唯一一列就放棄。"""
    r = e.get("row")
    if isinstance(r, int) and 2 <= r <= ws.max_row and row_matches(ws, r, e):
        return r
    cands = [i for i in range(2, ws.max_row + 1) if row_matches(ws, i, e)]
    if len(cands) > 1 and e.get("stock") not in (None, ""):
        cands = [i for i in cands if num_str(ws.cell(i, 4).value) == num_str(e["stock"])]
    return cands[0] if len(cands) == 1 else None


def set_text(cell, v):
    v = (v or "").strip()
    if not v:
        cell.value = None
        return
    cell.value = v
    cell.data_type = "s"  # 以 = + - @ 開頭的文字也要當一般文字,不能被當成公式


def backup(master, backup_dir):
    os.makedirs(backup_dir, exist_ok=True)
    name = "WMS_%s.xlsx" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy2(master, os.path.join(backup_dir, name))
    files = sorted(
        (os.path.join(backup_dir, f) for f in os.listdir(backup_dir) if f.startswith("WMS_") and f.endswith(".xlsx")),
        key=os.path.getmtime,
    )
    for old in files[:-KEEP_BACKUPS]:
        os.remove(old)


def main():
    global LOG_FILE
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--master", default=DEFAULT_MASTER)
    ap.add_argument("--drive-copy", default=DEFAULT_DRIVE_COPY)
    ap.add_argument("--backup-dir", default=BACKUP_DIR)
    ap.add_argument("--log", default=LOG_FILE)
    args = ap.parse_args()
    LOG_FILE = args.log

    if not os.path.exists(args.config):
        log("尚未設定 %s,略過" % os.path.basename(args.config))
        return 0
    with open(args.config, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    endpoint, sync_key = cfg.get("endpoint", ""), cfg.get("syncKey", "")
    if not endpoint or not sync_key:
        log("edit_config.json 缺少 endpoint 或 syncKey,略過")
        return 0

    try:
        res = call(endpoint, {"action": "pull", "key": sync_key})
    except Exception as ex:
        log("取回待處理修改失敗: %s" % ex)
        return 1
    if not res.get("ok"):
        log("中繼回應錯誤: %s" % res.get("error"))
        return 1
    edits = res.get("edits", [])
    if not edits:
        return 0

    master_dir, master_name = os.path.split(args.master)
    if os.path.exists(os.path.join(master_dir, "~$" + master_name)):
        log("主檔目前被 Excel 開啟,%d 筆修改留待下次處理" % len(edits))
        return 0

    try:
        backup(args.master, args.backup_dir)
        wb = openpyxl.load_workbook(args.master)
        if SHEET not in wb.sheetnames:
            log("主檔沒有工作表「%s」,中止" % SHEET)
            return 1
        ws = wb[SHEET]
        header = [str(ws.cell(1, c).value or "").strip() for c in range(1, 8)]
        if header != HEADERS:
            log("工作表「%s」標題列不符,中止: %s" % (SHEET, header))
            return 1

        done, failed = [], []
        for e in sorted(edits, key=lambda x: x.get("ts", 0)):
            r = locate(ws, e)
            if r is None:
                failed.append(e)
                log("找不到對應列,略過: %s (%s) 原列號 %s" % (e.get("code"), norm(e.get("name")), e.get("row")))
                continue
            set_text(ws.cell(r, 5), e.get("category"))
            set_text(ws.cell(r, 6), e.get("location"))
            set_text(ws.cell(r, 7), e.get("bin"))
            done.append(e)
            log("已寫入第 %d 列 %s: 類別=%s 儲放地點=%s 儲位=%s" % (r, e["code"], e.get("category"), e.get("location"), e.get("bin")))

        if done:
            wb.save(args.master)
            try:
                shutil.copy2(args.master, args.drive_copy)
            except Exception as ex:
                log("警告: 已寫入主檔,但複製到雲端硬碟失敗(下次 WMS 更新時會一併複製): %s" % ex)
    except PermissionError as ex:
        log("主檔無法寫入(可能被開啟),留待下次處理: %s" % ex)
        return 0
    except Exception as ex:
        log("處理失敗: %s" % ex)
        return 1

    ids = [e["id"] for e in done + failed if e.get("id")]
    try:
        call(endpoint, {"action": "ack", "key": sync_key, "ids": ",".join(ids)})
    except Exception as ex:
        log("警告: 回報已處理失敗,下次可能重複處理(寫入內容相同,不影響結果): %s" % ex)

    log("完成: 寫入 %d 筆,略過 %d 筆" % (len(done), len(failed)))
    return EXIT_APPLIED if done else 0


if __name__ == "__main__":
    sys.exit(main())
