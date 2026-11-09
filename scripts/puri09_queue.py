"""ERP「進貨單」請求佇列的命令列工具(給 Claude 排程任務使用)。

網站 ERP 頁按下「進貨單」並確認後,請求會存在 Apps Script 中繼。Claude 排程任務定期執行:

    python -I scripts\\puri09_queue.py claim
        有排隊中的請求且目前沒有執行中 -> 取走並標記為執行中,輸出 {"pending": true, ...}
        否則輸出 {"pending": false}(排程任務看到這個就直接結束)

    python -I scripts\\puri09_queue.py report done "已建立進貨單 3402-xxxx..."
    python -I scripts\\puri09_queue.py report error "失敗原因"
        回報執行結果,網站 ERP 頁會顯示在「進貨單」按鈕下方

設定檔 scripts\\edit_config.json(不進版控):{"endpoint": "<Apps Script /exec 網址>", "syncKey": "<SYNC_KEY>"}
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "edit_config.json")


def call(endpoint, params):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
    last = None
    for _ in range(3):  # Apps Script 偶爾回傳 HTML,重試幾次
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as ex:
            last = ex
            time.sleep(2)
    raise last


def out(obj):
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(obj, ensure_ascii=False))


def main(argv):
    if len(argv) < 2 or argv[1] not in ("claim", "report"):
        out({"ok": False, "error": "用法: puri09_queue.py claim | report <done|error> <訊息>"})
        return 2
    try:
        with open(CONFIG, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        endpoint, key = cfg["endpoint"], cfg["syncKey"]
    except Exception as ex:
        out({"ok": False, "error": "讀不到 edit_config.json: %s" % ex})
        return 1

    try:
        if argv[1] == "claim":
            res = call(endpoint, {"action": "puri09_claim", "key": key})
        else:
            if len(argv) < 3 or argv[2] not in ("done", "error"):
                out({"ok": False, "error": "report 需要狀態 done 或 error"})
                return 2
            res = call(endpoint, {"action": "puri09_report", "key": key, "state": argv[2], "msg": " ".join(argv[3:])[:300]})
    except Exception as ex:
        out({"ok": False, "error": "連不上中繼服務: %s" % ex})
        return 1
    out(res)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
