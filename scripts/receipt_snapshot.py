"""把 WMS.xlsx「收料」(進貨單簽核)或「退料」(退貨單簽核)工作表目前的資料列回報給網站的中繼服務(Apps Script),
讓網站「進貨單簽核」「退貨單簽核」能列出已收料 / 已退料清單明細。

- report(endpoint, key, master, force=False, kind="receipt"):以檔案修改時間判斷有沒有變動,沒變就不重送。
  kind 為 "receipt"(收料)或 "ret"(退料)。
  失敗(檔案被 Excel 鎖住、連不上中繼)一律回傳 False,不丟例外,不影響主流程。
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_WORK = os.environ.get("PURI09_DIR", HERE)
STATES = {
    "receipt": os.path.join(_WORK, "receipt_snapshot_state.json"),
    "ret": os.path.join(_WORK, "return_snapshot_state.json"),
}
ACTIONS = {"receipt": "receipts_snapshot", "ret": "returns_snapshot"}
KIND_NAME = {"receipt": "進貨", "ret": "退貨"}   # puri09_cleanup.PROFILES 的鍵
MAX_ROWS = 60

sys.path.insert(0, HERE)


def _rows(master, kind):
    import openpyxl
    import puri09_cleanup as pc  # 共用工作表標題別名與讀取邏輯

    prof = pc.PROFILES[KIND_NAME[kind]]
    wb = openpyxl.load_workbook(master, data_only=True)
    if prof["sheet"] not in wb.sheetnames:
        return []   # 例如還沒有人退過料,「退料」工作表尚未建立:視為空清單
    ws = wb[prof["sheet"]]
    cols, missing = pc.columns(ws, prof["aliases"])
    if missing:
        return []
    return pc.read_rows(ws, cols)


def _post(endpoint, payload):
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "text/plain;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:  # Apps Script 會 302 轉址,urllib 會自動跟隨
        return json.loads(resp.read().decode("utf-8"))


def report(endpoint, key, master, force=False, kind="receipt"):
    try:
        state_file = STATES[kind]
        mtime = os.path.getmtime(master)
        try:
            with open(state_file, encoding="utf-8") as f:
                last = json.load(f).get("mtime")
        except Exception:
            last = None
        if not force and last == mtime:
            return True  # 檔案沒變,上次已回報過

        rows = _rows(master, kind)
        out_rows = []
        for r in rows[:MAX_ROWS]:
            o = {"v": r["vendor"], "p": r["po"], "c": r["code"], "n": r["name"], "q": r["qty"], "d": r["date"],
                 "f": r.get("fail", "")}
            if kind == "ret":
                o["dt"] = r.get("doc_type", "")
                o["dn"] = r.get("doc_no", "")
            out_rows.append(o)
        payload = {"action": ACTIONS[kind], "key": key, "total": len(rows), "rows": out_rows}
        res = _post(endpoint, payload)
        if not res.get("ok"):
            return False
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump({"mtime": mtime}, f)
        return True
    except Exception:
        return False
