"""ERP 簽核(skill erp-approval)前後的收尾工具:記下這一批要簽核的表單,簽核完成後比對結果並回報到釘釘 / 網站。

流程:
  網頁按「確認」-> apply_edits 把表單寫進 WMS.xlsx「待簽核清單」-> 留下通知檔 sign_approval_pending.json
  -> 監看器(puri09_watch.py)印出 SIGN_APPROVAL_REQUEST,喚醒 Claude 去跑 skill erp-approval。

  python -I sign_result.py begin
      在跑 erp-approval 之前執行:把工作表目前所有列存成這一批的快照(sign_batch.json),清掉各列舊的「狀態」,
      並刪除通知檔。印出一行 JSON(count=這一批幾張)。
  python -I sign_result.py finish
      erp-approval 跑完之後執行:和快照比對 ——
        已不在工作表 = 簽核成功;還在、「狀態」有字 = 失敗(原因就是狀態內容);還在、狀態空白 = 未處理。
      把結果整理成一則訊息送到釘釘(edit_config.json 的 dingtalkWebhook),同時回報給網站的簽核狀態,最後刪掉快照。
      印出一行 JSON(成功 / 失敗 / 未處理張數與是否已送釘釘)。
  python -I sign_result.py status
      看目前有沒有待處理的簽核(通知檔)與進行中的批次。
"""
import json
import os
import sys
import time

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:   # 主控台預設是 cp950,輸出含特殊符號時會出錯;一律用 UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import dingtalk_notify as dn  # noqa: E402
import sign_sheet as ss  # noqa: E402

MASTER = os.environ.get("SIGN_MASTER", r"C:\ATK\Project\AI Agent\WMS\WMS.xlsx")
DRIVE = os.environ.get("SIGN_DRIVE", r"C:\Users\angus.ad\我的雲端硬碟\ATK\WMS.xlsx")
CONFIG = os.environ.get("SIGN_CONFIG", os.path.join(HERE, "edit_config.json"))
WORK = os.environ.get("SIGN_WORK", HERE)
PENDING = os.path.join(WORK, "sign_approval_pending.json")
BATCH = os.path.join(WORK, "sign_batch.json")

COL = {h: i for i, h in enumerate(ss.HEADERS, start=1)}   # 欄位名稱 -> 欄號


def out(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    return code


def load_cfg():
    with open(CONFIG, encoding="utf-8-sig") as f:
        return json.load(f)


def _cell(ws, r, name):
    v = ws.cell(r, COL[name]).value
    return "" if v is None else str(v).strip()


def read_rows(ws):
    rows = []
    for r in range(2, ws.max_row + 1):
        d = {h: _cell(ws, r, h) for h in ss.HEADERS}
        if d["程式代碼"] and d["單別"] and d["單號"]:
            d["_row"] = r
            rows.append(d)
    return rows


def key_of(d):
    return "%s|%s|%s" % (d["程式代碼"], d["單別"], d["單號"])


def locked():
    d, n = os.path.split(MASTER)
    return os.path.exists(os.path.join(d, "~$" + n))


def cmd_status(argv):
    pend = None
    if os.path.exists(PENDING):
        with open(PENDING, encoding="utf-8") as f:
            pend = json.load(f)
    batch = None
    if os.path.exists(BATCH):
        with open(BATCH, encoding="utf-8") as f:
            batch = {"startedAt": json.load(f).get("startedAt")}
    return out({"ok": True, "pending": pend, "batch": batch})


def cmd_begin(argv):
    if locked():
        return out({"ok": False, "error": "WMS.xlsx 正被 Excel 開啟,請先關閉"}, 3)
    wb = openpyxl.load_workbook(MASTER)
    if ss.SHEET not in wb.sheetnames:
        return out({"ok": True, "count": 0, "message": "沒有「待簽核清單」工作表"})
    ws = wb[ss.SHEET]
    rows = read_rows(ws)
    if not rows:
        if os.path.exists(PENDING):
            os.remove(PENDING)
        return out({"ok": True, "count": 0, "message": "無待簽核項目"})
    items = [{k: v for k, v in d.items() if k != "_row"} for d in rows]
    with open(BATCH, "w", encoding="utf-8") as f:
        json.dump({"startedAt": int(time.time() * 1000), "items": items}, f, ensure_ascii=False)
    # 清掉舊的「狀態」,這一輪簽核後狀態有字就代表這一輪失敗
    cleared = 0
    for d in rows:
        c = ws.cell(d["_row"], COL["狀態"])
        if c.value not in (None, ""):
            c.value = None
            cleared += 1
    if cleared:
        tmp = MASTER + ".signtmp"
        wb.save(tmp)
        os.replace(tmp, MASTER)
    if os.path.exists(PENDING):
        os.remove(PENDING)
    return out({"ok": True, "count": len(items), "clearedStatus": cleared,
                "items": [{"name": i["表單名稱"], "prog": i["程式代碼"], "doc": "%s-%s" % (i["單別"], i["單號"]), "vendor": i["廠商"]} for i in items]})


def reason_of(status):
    s = status.strip()
    for p in ("⚠ 失敗:", "⚠ 失敗：", "⚠", "失敗:", "失敗："):
        if s.startswith(p):
            s = s[len(p):].strip()
    return s or "原因不明"


def build_report(done, failed, pending_rows, total):
    lines = ["【ERP 簽核結果】共 %d 張:成功 %d、失敗 %d" % (total, len(done), len(failed) + len(pending_rows)) + ("、未處理 %d" % len(pending_rows) if pending_rows else "")]

    def one(d):
        s = "%s %s %s-%s" % (d["表單名稱"] or d["程式代碼"], d["程式代碼"], d["單別"], d["單號"])
        if d.get("廠商"):
            s += " · " + d["廠商"]
        return s

    for d in done[:15]:
        lines.append("✓ " + one(d))
    if len(done) > 15:
        lines.append("…另有 %d 張成功" % (len(done) - 15))
    for d in failed[:15]:
        lines.append("✗ %s\n   原因:%s" % (one(d), d["_reason"]))
    for d in pending_rows[:10]:
        lines.append("… %s\n   原因:簽核程序沒有處理到這一列" % one(d))
    if failed or pending_rows:
        lines.append("失敗的表單仍留在 WMS.xlsx「待簽核清單」,狀態欄有原因,處理後可再按確認重跑。")
    return "\n".join(lines)


def cmd_finish(argv):
    if not os.path.exists(BATCH):
        return out({"ok": False, "error": "找不到這一批的快照(sign_batch.json),請先執行 begin"}, 1)
    with open(BATCH, encoding="utf-8") as f:
        batch = json.load(f)
    items = batch.get("items") or []
    wb = openpyxl.load_workbook(MASTER, read_only=True, data_only=True)
    cur = {}
    if ss.SHEET in wb.sheetnames:
        ws = wb[ss.SHEET]
        # read_only 不能用 cell(r, c),逐列讀
        header = [str(c.value or "").strip() for c in next(ws.iter_rows(min_row=1, max_row=1))]
        for row in ws.iter_rows(min_row=2, values_only=True):
            d = {h: ("" if (i >= len(row) or row[i] is None) else str(row[i]).strip()) for i, h in enumerate(header)}
            if d.get("程式代碼") and d.get("單別") and d.get("單號"):
                cur[key_of(d)] = d
    wb.close()

    done, failed, pending_rows = [], [], []
    for it in items:
        k = key_of(it)
        if k not in cur:
            done.append(it)
        else:
            st = cur[k].get("狀態", "")
            it = dict(it)
            if st:
                it["_reason"] = reason_of(st)
                failed.append(it)
            else:
                pending_rows.append(it)
    total = len(items)
    text = build_report(done, failed, pending_rows, total)

    sent = False
    sent_err = ""
    try:
        cfg = load_cfg()
        ok, why = dn.send_text(cfg, text)
        sent, sent_err = ok, why
    except Exception as ex:
        sent_err = str(ex)

    # 回報給網站的簽核狀態(網站「待簽核表單」頁的提示文字)
    site_ok = False
    try:
        import urllib.parse
        import urllib.request
        cfg = load_cfg()
        bad = len(failed) + len(pending_rows)
        msg = "共 %d 張:成功 %d、失敗 %d" % (total, len(done), bad)
        q = {"action": "sign_report", "key": cfg["syncKey"], "state": "done" if not bad else "error", "msg": msg}
        url = cfg["endpoint"] + ("&" if "?" in cfg["endpoint"] else "?") + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=30) as resp:
            site_ok = bool(json.loads(resp.read().decode("utf-8")).get("ok"))
    except Exception:
        pass

    if sent:   # 通知送出才刪快照;送不出去留著,可以重跑 finish
        os.remove(BATCH)
    return out({"ok": True, "total": total, "success": len(done), "failed": len(failed), "unprocessed": len(pending_rows),
                "dingtalk": sent, "dingtalkError": sent_err, "site": site_ok,
                "failures": [{"doc": "%s-%s" % (d["單別"], d["單號"]), "prog": d["程式代碼"], "reason": d["_reason"]} for d in failed]})


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "begin":
        return cmd_begin(argv)
    if cmd == "finish":
        return cmd_finish(argv)
    if cmd == "status":
        return cmd_status(argv)
    return out({"ok": False, "error": "用法: sign_result.py begin | finish | status"}, 2)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as ex:
        print(json.dumps({"ok": False, "error": str(ex)}, ensure_ascii=False))
        sys.exit(1)
