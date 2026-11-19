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


def _post(cfg, text):
    webhook = (cfg.get("dingtalkWebhook") or "").strip()
    body = json.dumps({"msgtype": "text", "text": {"content": text}}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(_signed_url(webhook, (cfg.get("dingtalkSecret") or "").strip()), data=body,
                                 headers={"Content-Type": "application/json;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def send_text(cfg, text):
    """送一則文字訊息。成功回傳 (True, ''),失敗回傳 (False, 原因)。
    機器人若設了「自訂關鍵字」(dingtalkKeyword,可用逗號分隔多個):訊息含任一關鍵字就照原樣送;
    不含時先照原樣送(機器人可能另外設了訊息裡有的字,例如「簽」),被釘釘以關鍵字不符(310000)退回才在開頭補上關鍵字重送。"""
    webhook = (cfg.get("dingtalkWebhook") or "").strip()
    if not webhook:
        return False, "未設定 dingtalkWebhook"
    kws = [k.strip() for k in (cfg.get("dingtalkKeyword") or "").replace("，", ",").split(",") if k.strip()]
    try:
        res = _post(cfg, text)
        if res.get("errcode") == 310000 and kws and not any(k in text for k in kws):
            res = _post(cfg, kws[0] + "\n" + text)
    except Exception as ex:
        return False, "連線失敗: %s" % ex
    if res.get("errcode") == 0:
        return True, ""
    return False, "釘釘回應 %s: %s" % (res.get("errcode"), res.get("errmsg"))


def who_of(it):
    """送簽人顯示名稱:使用者名單的名稱;沒有就用 email @ 前面那段。"""
    n = (it.get("byName") or "").strip()
    if n:
        return n
    by = (it.get("by") or "").strip()
    return by.split("@")[0] if by else "(未知)"


def build_text(items, total=None):
    """新格式(2026-11-19 使用者指定),依送簽人、表單名稱分組,不放任何連結:
    Amber:
    送簽了1張採購單
    3303-20261111002
    立懋"""
    groups = []   # [(送簽人, [(表單名稱, [item...])])],照送簽時間先後
    for it in items:
        who = who_of(it)
        g = next((x for x in groups if x[0] == who), None)
        if not g:
            g = (who, [])
            groups.append(g)
        form = (it.get("name") or it.get("prog") or "表單").strip()
        f = next((x for x in g[1] if x[0] == form), None)
        if not f:
            f = (form, [])
            g[1].append(f)
        f[1].append(it)
    blocks = []
    for who, forms in groups:
        lines = [who + "："]
        for form, lst in forms:
            lines.append("送簽了%d張%s" % (len(lst), form))
            for it in lst:
                lines.append("%s-%s" % (it.get("docType", ""), it.get("docNo", "")))
                if (it.get("vendor") or "").strip():
                    lines.append(it["vendor"].strip())
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


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
