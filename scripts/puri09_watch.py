"""ERP「進貨單」請求監看器(給 Claude 的 Monitor 工具使用,讓按下確認後幾秒內就開始執行)。

每 10 秒向中繼服務取一次請求(puri09_claim:取走即標記為執行中)。
取到請求時,在標準輸出印一行 "PURI09_REQUEST by=<帳號>",Monitor 會把這一行當成通知喚醒 Claude 去執行 puri09 skill。
連續讀取失敗時,每次失敗串只印一行 "PURI09_WATCH_ERROR ..." 提醒。沒有請求時不輸出任何東西。

用法: python -I scripts\\puri09_watch.py            (一直執行,由 Monitor 到期時結束它)
      python -I scripts\\puri09_watch.py --interval 5
設定檔 scripts\\edit_config.json(同 puri09_queue.py)。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "edit_config.json")


def claim(endpoint, key):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode({"action": "puri09_claim", "key": key})
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv):
    interval = 10
    if "--interval" in argv:
        interval = max(2, int(argv[argv.index("--interval") + 1]))
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    endpoint, key = cfg["endpoint"], cfg["syncKey"]
    if "--endpoint" in argv:  # 測試用:改指向假的中繼
        endpoint = argv[argv.index("--endpoint") + 1]

    failing = 0
    while True:
        try:
            res = claim(endpoint, key)
            failing = 0
            if res.get("ok") and res.get("pending"):
                by = (res.get("request") or {}).get("by", "")
                print("PURI09_REQUEST by=%s" % by, flush=True)
            elif not res.get("ok"):
                raise RuntimeError(res.get("error") or "中繼回應錯誤")
        except Exception as ex:
            failing += 1
            if failing == 3:  # 連續失敗 3 次才提醒一次,之後靜默直到恢復
                print("PURI09_WATCH_ERROR %s" % str(ex)[:120], flush=True)
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except KeyboardInterrupt:
        pass
