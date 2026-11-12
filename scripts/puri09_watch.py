"""ERP「進貨單」請求監看器(給 Claude 的 Monitor 工具使用,讓按下確認後幾秒內就開始執行)。

每 10 秒向中繼服務取一次請求(puri09_claim:取走即標記為執行中)。
取到進貨單請求時,在標準輸出印一行 "PURI09_REQUEST by=<帳號>",Monitor 會把這一行當成通知喚醒 Claude 去執行 puri09 skill;
同時也檢查「退貨單簽核」的佇列(ret_claim),取到時印 "RETURN_REQUEST by=<帳號>";
以及「待簽核表單」的簽核請求(sign_claim),取到時印 "SIGN_REQUEST by=<帳號> count=<張數>"。
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


def claim(endpoint, key, action="puri09_claim"):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode({"action": action, "key": key})
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
            # 退貨單簽核的佇列(舊版中繼沒有這個動作時略過,不算錯誤)
            try:
                res2 = claim(endpoint, key, "ret_claim")
                if res2.get("ok") and res2.get("pending"):
                    print("RETURN_REQUEST by=%s" % (res2.get("request") or {}).get("by", ""), flush=True)
            except Exception:
                pass
            # 待簽核表單的簽核請求(sign_claim);請求內容在 request.items
            try:
                res3 = claim(endpoint, key, "sign_claim")
                if res3.get("ok") and res3.get("pending"):
                    req = res3.get("request") or {}
                    print("SIGN_REQUEST by=%s count=%d" % (req.get("by", ""), len(req.get("items") or [])), flush=True)
            except Exception:
                pass
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
