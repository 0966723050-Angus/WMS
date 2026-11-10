"""把 WMS.xlsx「收料」工作表目前的資料列回報給網站的中繼服務(Apps Script),
讓網站「進貨單簽核」能列出已收料清單明細。

- report(endpoint, key, master, force=False):以檔案修改時間判斷有沒有變動,沒變就不重送。
  失敗(檔案被 Excel 鎖住、連不上中繼)一律回傳 False,不丟例外,不影響主流程。
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(os.environ.get("PURI09_DIR", HERE), "receipt_snapshot_state.json")
MAX_ROWS = 60

sys.path.insert(0, HERE)


def _rows(master):
    import openpyxl
    import puri09_cleanup as pc  # 共用「收料」表標題別名與讀取邏輯

    wb = openpyxl.load_workbook(master, data_only=True)
    if pc.SHEET not in wb.sheetnames:
        return []
    ws = wb[pc.SHEET]
    cols, missing = pc.columns(ws)
    if missing:
        return []
    return pc.read_rows(ws, cols)


def _post(endpoint, payload):
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "text/plain;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:  # Apps Script 會 302 轉址,urllib 會自動跟隨
        return json.loads(resp.read().decode("utf-8"))


def report(endpoint, key, master, force=False):
    try:
        mtime = os.path.getmtime(master)
        try:
            with open(STATE, encoding="utf-8") as f:
                last = json.load(f).get("mtime")
        except Exception:
            last = None
        if not force and last == mtime:
            return True  # 檔案沒變,上次已回報過

        rows = _rows(master)
        payload = {
            "action": "receipts_snapshot", "key": key, "total": len(rows),
            "rows": [{"v": r["vendor"], "p": r["po"], "c": r["code"], "n": r["name"], "q": r["qty"], "d": r["date"],
                      "f": r.get("fail", "")}
                     for r in rows[:MAX_ROWS]],
        }
        res = _post(endpoint, payload)
        if not res.get("ok"):
            return False
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump({"mtime": mtime}, f)
        return True
    except Exception:
        return False
