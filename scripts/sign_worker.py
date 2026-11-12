"""處理同事從網頁「待簽核表單」上傳的截圖:取回圖片 -> 辨識 -> 把表單送回網站 -> 回報結果。

由 apply_edits.py(排程約每分鐘跑一次)在 pull 到「待辨識圖片」時呼叫 process();也可以單獨測試。
圖片在 Apps Script 端切成多段暫存(最長 6 小時),這裡逐段取回、組回圖片後交給 sign_capture.recognize()。
"""
import base64
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sign_capture as sc  # noqa: E402

UPLOAD_DIR = os.path.join(sc.WORK, "uploads")
KEEP_UPLOADS = 20          # 留最近幾張原圖,辨識錯誤時可以回頭檢查
TIME_BUDGET_S = 100        # 單次最多處理多久;沒處理完的 3 分鐘後會重新排入


def _get(endpoint, key, params):
    q = dict(params, key=key)
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(q)
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=40) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as ex:
            last = ex
            time.sleep(1.5)
    raise last


def fetch_image(endpoint, key, img):
    parts = []
    for n in range(int(img.get("parts") or 0)):
        res = _get(endpoint, key, {"action": "signimg_get", "id": img["id"], "n": n})
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "取回圖片失敗")
        parts.append(res["data"])
    raw = base64.b64decode("".join(parts))
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, "%s.img" % img["id"])
    with open(path, "wb") as f:
        f.write(raw)
    files = sorted((os.path.join(UPLOAD_DIR, x) for x in os.listdir(UPLOAD_DIR)), key=os.path.getmtime)
    for old in files[:-KEEP_UPLOADS]:
        try:
            os.remove(old)
        except OSError:
            pass
    return Image.open(io.BytesIO(raw)).convert("RGB")


def summary(res):
    forms = res["forms"]
    if not forms:
        return "error", "沒辨識到表單:" + ";".join(res["warnings"] or ["找不到紅框或單別/單號"])
    names = "、".join(sorted({f["progName"] or f["prog"] for f in forms if (f["progName"] or f["prog"])})) or "?"
    msg = "辨識到 %d 張(%s)" % (len(forms), names)
    low = sum(1 for f in forms if f.get("conf") == "low")
    if low:
        msg += ",其中 %d 張把握度不高請核對" % low
    if res["warnings"]:
        msg += ";" + ";".join(res["warnings"])
    return "done", msg


def process(endpoint, key, images, log=print):
    """images: pull 回來的 signImages 清單。回傳處理完的張數。"""
    start = time.time()
    done = 0
    for img in images:
        if time.time() - start > TIME_BUDGET_S:
            log("簽核截圖:本輪時間用完,剩下的下一輪再處理")
            break
        iid = img.get("id")
        try:
            im = fetch_image(endpoint, key, img)
            res = sc.recognize(im, tag=str(iid)[-8:])
            forms = res["forms"]
            for f in forms:
                f.pop("box", None)
            if forms:
                r = sc.push_to(endpoint, key, forms, {"by": img.get("by", "")})
                if not r.get("ok"):
                    raise RuntimeError("送出表單失敗:%s" % (r.get("error") or r))
            state, msg = summary(res)
            _get(endpoint, key, {"action": "signimg_report", "id": iid, "state": state, "msg": msg, "n": len(forms)})
            log("簽核截圖 %s(%s):%s" % (iid, img.get("by", ""), msg))
        except Exception as ex:
            log("簽核截圖 %s 處理失敗:%s" % (iid, ex))
            try:
                _get(endpoint, key, {"action": "signimg_report", "id": iid, "state": "error", "msg": "處理失敗:%s" % str(ex)[:80], "n": 0})
            except Exception:
                pass
        done += 1
    return done
