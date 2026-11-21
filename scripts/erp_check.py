"""ERP 自動化的 SQL 先查 / 事後驗證工具(只做 SELECT,不改 ERP)。給 erp-approval、puri09 等 skill 用,
先用 SQL 判斷哪些單據真的需要開 ERP 畫面操作、要怎麼操作,操作完再用 SQL 確認結果,省掉大部分截圖與判讀。

用法(輸出最後一行都是 JSON):
  python -I erp_check.py sign-precheck
      讀 sign_result.py begin 存的這一批(sign_batch.json),逐張查 ERP 現況:
        已確認 → done(不必開畫面);查無單據 / 已作廢 → fail;未確認 → todo(變更單附最後版次 ver)。
      輸出 todo(依程式分組)、done、fail,以及可直接給 sign_result.py finish 用的 doneArg / failArg。
  python -I erp_check.py confirmed <程式> <單別> <單號> [--ver 版次] [--wait 秒]
      按下「單據確認」後用這個確認:每秒查一次,確認碼變成 Y 就回 ok:true(最多等 --wait 秒,預設 12)。
  python -I erp_check.py po-precheck
      讀 puri09_cleanup.py read 存的收料快照(puri09_snapshot.json),逐列檢查採購單:
        沒有採購單號 / 查無採購序號 / 採購單未確認 / 已結案 / 品號不符 / 已無未交量 / 已有未確認進貨單 → fail;
        其餘依「ERP 的供應廠商」分組,附未交量、單位、以及建議做法 method(F2:廠商簡稱與收料表相同;copy:直接用複製前置單據)。
  python -I erp_check.py po-receipt <採購單別-單號-序號,...> [--days 1]
      建立進貨單後查:這些採購序號今天(或最近 --days 天)被哪張進貨單引用、進貨數量、確認碼。
      回傳每列對應的進貨單與可直接給 puri09_cleanup.py clear 用的 doneArg(只含已確認的)。
"""
import datetime
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ERP_SQL_DIR = r"C:\ATK\Project\AI Agent\WMS\WMS一鍵更新"
SIGN_BATCH = os.path.join(HERE, "sign_batch.json")
PURI_SNAPSHOT = os.path.join(HERE, "puri09_snapshot.json")

# 程式代碼 → (單頭資料表, 單別欄, 單號欄, 確認碼欄, 版次欄(變更單才有), 說明)
PROGS = {
    "MOCI02": ("MOCTA", "TA001", "TA002", "TA013", None, "製令"),
    "MOCI12": ("MOCTO", "TO001", "TO002", "TO041", "TO003", "製令變更"),
    "MOCI03": ("MOCTC", "TC001", "TC002", "TC009", None, "製令領料"),
    "MOCI04": ("MOCTC", "TC001", "TC002", "TC009", None, "製令退料"),
    "MOCI05": ("MOCTF", "TF001", "TF002", "TF006", None, "生產入庫"),
    "PURI05": ("PURTA", "TA001", "TA002", "TA007", None, "請購單"),
    "PURI07": ("PURTC", "TC001", "TC002", "TC014", None, "採購單"),
    "PURI08": ("PURTE", "TE001", "TE002", "TE017", "TE003", "採購變更"),
    "PURI09": ("PURTG", "TG001", "TG002", "TG013", None, "進貨單"),
    "PURI11": ("PURTI", "TI001", "TI002", "TI013", None, "退貨單"),
    "COPI06": ("COPTC", "TC001", "TC002", "TC027", None, "客戶訂單"),
    "COPI07": ("COPTE", "TE001", "TE002", "TE029", "TE003", "訂單變更"),
    "COPI08": ("COPTG", "TG001", "TG002", "TG023", None, "銷貨單"),
    "COPI09": ("COPTI", "TI001", "TI002", "TI019", None, "銷退單"),
    "INVI05": ("INVTA", "TA001", "TA002", "TA006", None, "庫存異動"),
}


def out(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False, default=str))
    return code


def connect():
    if ERP_SQL_DIR not in sys.path:
        sys.path.insert(0, ERP_SQL_DIR)
    import erp_sql
    return erp_sql.connect()


def _s(v):
    return "" if v is None else str(v).strip()


def doc_status(cur, prog, dt, dn, ver=None):
    """回傳 {found, confirm, ver};找不到程式對照時 known=False。變更單沒指定版次時看最後一個版次。"""
    p = PROGS.get((prog or "").upper())
    if not p:
        return {"known": False}
    table, ct, cn, cc, cv, _ = p
    if cv:
        if ver:
            cur.execute("SELECT %s, %s FROM %s WITH (NOLOCK) WHERE %s = ? AND %s = ? AND %s = ?" % (cc, cv, table, ct, cn, cv), [dt, dn, ver])
        else:
            cur.execute("SELECT TOP 1 %s, %s FROM %s WITH (NOLOCK) WHERE %s = ? AND %s = ? ORDER BY %s DESC" % (cc, cv, table, ct, cn, cv), [dt, dn])
    else:
        cur.execute("SELECT %s FROM %s WITH (NOLOCK) WHERE %s = ? AND %s = ?" % (cc, table, ct, cn), [dt, dn])
    r = cur.fetchone()
    if not r:
        return {"known": True, "found": False}
    return {"known": True, "found": True, "confirm": _s(r[0]), "ver": _s(r[1]) if cv else ""}


# ---------------- 待簽核清單 ----------------
def cmd_sign_precheck(argv):
    if not os.path.exists(SIGN_BATCH):
        return out({"ok": False, "error": "找不到這一批(sign_batch.json),請先執行 sign_result.py begin"}, 1)
    with open(SIGN_BATCH, encoding="utf-8") as f:
        items = json.load(f).get("items") or []
    todo, done, fail = [], [], []
    cn = connect()
    try:
        cur = cn.cursor()
        for it in items:
            prog, dt, dn = _s(it.get("程式代碼")).upper(), _s(it.get("單別")), _s(it.get("單號"))
            key = "%s|%s|%s" % (prog, dt, dn)
            st = doc_status(cur, prog, dt, dn)
            base = {"key": key, "prog": prog, "dt": dt, "dn": dn, "name": _s(it.get("表單名稱")), "vendor": _s(it.get("廠商"))}
            if not st["known"]:
                todo.append(dict(base, note="程式代碼沒有 SQL 對照,照原流程用畫面判斷"))
            elif not st["found"]:
                fail.append(dict(base, reason="查無單據"))
            elif st["confirm"] == "Y":
                done.append(dict(base, note="ERP 已是確認狀態(未操作)"))
            elif st["confirm"] == "V":
                fail.append(dict(base, reason="單據已作廢"))
            else:
                todo.append(dict(base, ver=st["ver"], confirm=st["confirm"]))
    finally:
        cn.close()
    groups = {}
    for t in todo:
        groups.setdefault(t["prog"], []).append(t)
    return out({"ok": True, "total": len(items), "needUi": len(todo), "todo": groups, "done": done, "fail": fail,
                "doneArg": ",".join(d["key"] for d in done),
                "failArg": ";".join("%s=%s" % (d["key"], d["reason"]) for d in fail)})


def cmd_confirmed(argv):
    if len(argv) < 5:
        return out({"ok": False, "error": "用法:confirmed <程式> <單別> <單號> [--ver 版次] [--wait 秒]"}, 2)
    prog, dt, dn = argv[2].upper(), argv[3], argv[4]
    ver = argv[argv.index("--ver") + 1] if "--ver" in argv else None
    wait = float(argv[argv.index("--wait") + 1]) if "--wait" in argv else 12.0
    end = time.time() + wait
    cn = connect()
    try:
        cur = cn.cursor()
        while True:
            st = doc_status(cur, prog, dt, dn, ver)
            if not st.get("known"):
                return out({"ok": False, "error": "程式代碼沒有 SQL 對照:%s" % prog}, 2)
            if st.get("found") and st.get("confirm") == "Y":
                return out({"ok": True, "confirm": "Y", "ver": st.get("ver", "")})
            if time.time() >= end:
                return out({"ok": False, "found": st.get("found"), "confirm": st.get("confirm", ""), "ver": st.get("ver", ""),
                            "error": "查無單據" if not st.get("found") else "確認碼仍是 %s" % (st.get("confirm") or "空白")}, 1)
            time.sleep(1)
    finally:
        cn.close()


# ---------------- 收料 → 進貨單(PURI09) ----------------
def _split_po(po):
    parts = [p.strip() for p in (po or "").split("-")]
    return parts if len(parts) == 3 and all(parts) else None


def cmd_po_precheck(argv):
    if not os.path.exists(PURI_SNAPSHOT):
        return out({"ok": False, "error": "找不到收料快照(puri09_snapshot.json),請先執行 puri09_cleanup.py read"}, 1)
    with open(PURI_SNAPSHOT, encoding="utf-8") as f:
        rows = json.load(f)
    groups, fail = {}, []
    cn = connect()
    try:
        cur = cn.cursor()
        for r in rows:
            po, code, qty, vendor = _s(r.get("po")), _s(r.get("code")), float(r.get("qty") or 0), _s(r.get("vendor"))
            key = po if po else "|" + code
            base = {"row": r.get("row"), "po": po, "code": code, "qty": qty, "vendor": vendor, "key": key}
            sp = _split_po(po)
            if not sp:
                fail.append(dict(base, reason="沒有採購單號" if not po else "採購單號格式不對"))
                continue
            cur.execute("""SELECT TD004, TD008, TD015, TD016, TD009, TC014, TC004, MA002
                           FROM PURTD WITH (NOLOCK) JOIN PURTC WITH (NOLOCK) ON TC001 = TD001 AND TC002 = TD002
                           LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TC004
                           WHERE TD001 = ? AND TD002 = ? AND TD003 = ?""", sp)
            x = cur.fetchone()
            if not x:
                fail.append(dict(base, reason="查無採購單序號"))
                continue
            td_code, td_qty, td_got, td_close, unit, tc_ok, vcode, vshort = _s(x[0]), float(x[1] or 0), float(x[2] or 0), _s(x[3]), _s(x[4]), _s(x[5]), _s(x[6]), _s(x[7])
            remain = round(td_qty - td_got, 4)
            if tc_ok != "Y":
                fail.append(dict(base, reason="採購單未確認(確認碼 %s)" % (tc_ok or "空白")))
                continue
            if td_close not in ("", "N"):
                fail.append(dict(base, reason="採購單身已結案"))
                continue
            if code and td_code and code != td_code:
                fail.append(dict(base, reason="品號與採購單不符(採購單是 %s)" % td_code))
                continue
            if remain <= 0:
                fail.append(dict(base, reason="已全數進貨(未交量 0)"))
                continue
            # 已有未確認的進貨單引用這個採購序號 → 不要重複建單
            cur.execute("""SELECT TOP 1 TH001, TH002 FROM PURTH WITH (NOLOCK) JOIN PURTG WITH (NOLOCK) ON TG001 = TH001 AND TG002 = TH002
                           WHERE TH011 = ? AND TH012 = ? AND TH013 = ? AND TG013 = 'N'""", sp)
            pend = cur.fetchone()
            if pend:
                fail.append(dict(base, reason="已存檔未確認:%s-%s(請先在 ERP 確認或刪除,避免重複建單)" % (_s(pend[0]), _s(pend[1]))))
                continue
            g = groups.setdefault(vcode, {"vendorCode": vcode, "vendorShort": vshort, "excelVendor": vendor,
                                          "method": "F2" if vendor and vendor == vshort else "copy", "rows": []})
            if vendor != vshort:
                g["method"] = "copy"
            warn = "進貨數量 %g 大於未交量 %g" % (qty, remain) if qty > remain else ""
            g["rows"].append(dict(base, dt=sp[0], dn=sp[1], seq=sp[2], unit=unit, remain=remain, warn=warn))
    finally:
        cn.close()
    gl = list(groups.values())
    for g in gl:
        g["pos"] = sorted({"%s-%s" % (r["dt"], r["dn"]) for r in g["rows"]})
    return out({"ok": True, "total": len(rows), "groups": gl, "groupCount": len(gl), "fail": fail,
                "failArg": ";".join("%s=%s" % (f["key"], f["reason"]) for f in fail)})


def cmd_po_receipt(argv):
    if len(argv) < 3:
        return out({"ok": False, "error": "用法:po-receipt <採購單別-單號-序號,...> [--days 1]"}, 2)
    pos = [p.strip() for p in argv[2].split(",") if p.strip()]
    days = int(argv[argv.index("--days") + 1]) if "--days" in argv else 1
    since = (datetime.date.today() - datetime.timedelta(days=days - 1)).strftime("%Y%m%d")
    res, done = [], []
    cn = connect()
    try:
        cur = cn.cursor()
        for po in pos:
            sp = _split_po(po)
            if not sp:
                res.append({"po": po, "error": "格式不對"})
                continue
            cur.execute("""SELECT TH001, TH002, TH003, TH004, TH007, TH015, TG013, TG003
                           FROM PURTH WITH (NOLOCK) JOIN PURTG WITH (NOLOCK) ON TG001 = TH001 AND TG002 = TH002
                           WHERE TH011 = ? AND TH012 = ? AND TH013 = ? AND (TG003 >= ? OR PURTG.CREATE_DATE >= ?)
                           ORDER BY PURTG.CREATE_DATE DESC, PURTG.CREATE_TIME DESC""", sp + [since, since])
            hits = [{"receipt": "%s-%s" % (_s(x[0]), _s(x[1])), "seq": _s(x[2]), "code": _s(x[3]), "qty": float(x[4] or 0),
                     "accepted": float(x[5] or 0), "confirm": _s(x[6]), "date": _s(x[7])} for x in cur.fetchall()]
            res.append({"po": po, "receipts": hits})
            ok = [h for h in hits if h["confirm"] == "Y"]
            if ok:
                done.append("%s=%s" % (po, ok[0]["receipt"]))
    finally:
        cn.close()
    return out({"ok": True, "lines": res, "doneArg": ",".join(done)})


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    try:
        if cmd == "sign-precheck":
            return cmd_sign_precheck(argv)
        if cmd == "confirmed":
            return cmd_confirmed(argv)
        if cmd == "po-precheck":
            return cmd_po_precheck(argv)
        if cmd == "po-receipt":
            return cmd_po_receipt(argv)
    except Exception as ex:
        return out({"ok": False, "error": "%s: %s" % (type(ex).__name__, ex)}, 1)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv))
