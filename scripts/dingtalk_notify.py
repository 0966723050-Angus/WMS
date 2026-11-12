"""待簽核清單有新增項目時,用釘釘群機器人發通知。

流程:網站(Apps Script)有新增表單(截圖辨識或手動新增)就記進通知佇列 -> apply_edits 約每分鐘 pull 時帶回 signNotify
-> 這裡合併成一則訊息送出 -> 成功才呼叫 sign_notify_ack 清掉佇列(失敗下一輪會再試)。

機器人網址含 access_token,屬機密:只放在本機 scripts\\edit_config.json(已列入 .gitignore),不要放進程式碼或網站。
edit_config.json 可設定:
  dingtalkWebhook : 機器人 Webhook 網址(必填,沒設就不發通知)
  dingtalkSecret  : 機器人若選「加簽」才需要(SEC 開頭的字串)
  dingtalkKeyword : 機器人若設「自訂關鍵字」,填在這裡(訊息開頭會帶上)
"""
import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request

SITE_URL = "https://0966723050-angus.github.io/WMS/#/erp/sign"
MAX_LISTED = 10


def _signed_url(webhook, secret):
    if not secret:
        return webhook
    ts = str(int(time.time() * 1000))
    raw = ("%s\n%s" % (ts, secret)).encode("utf-8")
    sign = urllib.parse.quote_plus(base64.b64encode(hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).digest()))
    return "%s&timestamp=%s&sign=%s" % (webhook, ts, sign)


def send_text(cfg, text):
    """送一則文字訊息。成功回傳 (True, ''),失敗回傳 (False, 原因)。"""
    webhook = (cfg.get("dingtalkWebhook") or "").strip()
    if not webhook:
        return False, "未設定 dingtalkWebhook"
    kw = (cfg.get("dingtalkKeyword") or "").strip()
    if kw and kw not in text:
        text = kw + " " + text
    body = json.dumps({"msgtype": "text", "text": {"content": text}}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(_signed_url(webhook, (cfg.get("dingtalkSecret") or "").strip()), data=body,
                                 headers={"Content-Type": "application/json;charset=utf-8"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            res = json.loads(resp.read().decode("utf-8"))
    except Exception as ex:
        return False, "連線失敗: %s" % ex
    if res.get("errcode") == 0:
        return True, ""
    return False, "釘釘回應 %s: %s" % (res.get("errcode"), res.get("errmsg"))


def build_text(items, total=None):
    lines = ["【WMS 待簽核清單】新增 %d 張" % len(items)]
    for i, it in enumerate(items[:MAX_LISTED], start=1):
        head = (it.get("name") or it.get("prog") or "").strip()
        s = "%d. %s %s-%s" % (i, head, it.get("docType", ""), it.get("docNo", ""))
        if it.get("vendor"):
            s += " · " + it["vendor"]
        by = it.get("by") or ""
        if by:
            s += "(%s)" % by
        lines.append(s)
    if len(items) > MAX_LISTED:
        lines.append("…另有 %d 張" % (len(items) - MAX_LISTED))
    if total:
        lines.append("目前清單共 %d 張待簽核" % total)
    lines.append(SITE_URL)
    return "\n".join(lines)


def process(endpoint, key, cfg, items, total, call, log=print):
    """items: pull 回來的 signNotify。call(endpoint, params) 是 apply_edits 的 GET 呼叫函式。回傳已通知張數。"""
    if not items:
        return 0
    if not (cfg.get("dingtalkWebhook") or "").strip():
        return 0   # 沒設定機器人就不通知(佇列留著,最多 100 筆)
    items = sorted(items, key=lambda x: x.get("ts", 0))
    ok, why = send_text(cfg, build_text(items, total))
    if not ok:
        log("釘釘通知失敗(下一輪再試): %s" % why)
        return 0
    try:
        call(endpoint, {"action": "sign_notify_ack", "key": key, "ids": ",".join(str(x["id"]) for x in items if x.get("id"))})
    except Exception as ex:
        log("警告: 釘釘通知已送出,但回報清除佇列失敗(下一輪可能重複通知): %s" % ex)
    log("釘釘通知已送出:待簽核清單新增 %d 張" % len(items))
    return len(items)
