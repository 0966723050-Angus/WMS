"""ERP「進貨單」請求監看器(給 Claude 的 Monitor 工具使用,讓按下確認後幾秒內就開始執行)。

每 10 秒向中繼服務取一次請求(puri09_claim:取走即標記為執行中)。
取到進貨單請求時,在標準輸出印一行 "PURI09_REQUEST by=<帳號>",Monitor 會把這一行當成通知喚醒 Claude 去執行 puri09 skill;
同時也檢查「退貨單簽核」的佇列(ret_claim),取到時印 "RETURN_REQUEST by=<帳號>";
「待簽核表單」按確認後,apply_edits 會把表單寫進 WMS.xlsx「待簽核清單」並留下通知檔 sign_approval_pending.json;
這裡看到通知檔就印 "SIGN_APPROVAL_REQUEST count=<張數> by=<帳號>"(15 分鐘內沒被處理會再提醒一次),
Claude 收到後依序:sign_result.py begin -> 執行 skill erp-approval -> sign_result.py finish(結果回報釘釘)。
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
SIGN_PENDING = os.path.join(HERE, "sign_approval_pending.json")
SIGN_REMIND_S = 15 * 60


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
    sign_announced = {}   # 通知檔的 ts -> 上次印出的時間
    while True:
        try:
            # 待簽核清單有新的簽核要執行(通知檔由 apply_edits 在寫入 WMS.xlsx 後建立;sign_result.py begin 會刪掉它)
            if os.path.exists(SIGN_PENDING):
                try:
                    with open(SIGN_PENDING, encoding="utf-8") as pf:
                        pend = json.load(pf)
                    ts = pend.get("ts")
                    if time.time() - sign_announced.get(ts, 0) > SIGN_REMIND_S:
                        sign_announced[ts] = time.time()
                        print("SIGN_APPROVAL_REQUEST count=%s by=%s" % (pend.get("count", "?"), pend.get("by", "")), flush=True)
                except Exception:
                    pass
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
