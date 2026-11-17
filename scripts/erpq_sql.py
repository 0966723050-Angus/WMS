r"""網站「ERP 查詢」(製令 / 製令變更 / 採購單 / 採購變更)改用 SQL 直接查鼎新 ERP 資料庫(只做 SELECT)。

取走網頁送出的查詢 → 依條件查資料庫 → 把清單回傳網站(erpq_result),不必再開 ERP 畫面。
puri09_watch.py(每 10 秒)與排程「WMS 儲位編輯寫入」(apply_and_sync.ps1,每分鐘)都會呼叫這裡,誰先取到誰處理。

用法:
  python -I scripts\erpq_sql.py                      取走並處理所有等待中的查詢(沒有就直接結束)
  python -I scripts\erpq_sql.py --id <id> --kind <moq|mochg|poq|pochg> --cond "<JSON>"
                                                    處理一筆已經被取走的查詢(監看器印出 ERPQ_REQUEST 時用)
  python -I scripts\erpq_sql.py --test <kind> "<JSON>"  只查詢、印出結果,不回傳網站
連線設定沿用 WMS\WMS一鍵更新\sql_config.json(erp_sql.connect,唯讀連線)。
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "edit_config.json")
LOG = os.path.join(HERE, "erpq_sql.log")
ERP_SQL_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "WMS", "WMS一鍵更新"))
MAX_ROWS = 500   # 與 ERP 查詢對話框「總資料筆數限制」預設相同

CONFIRM = {"Y": "Y:已確認", "N": "N:未確認", "V": "V:作廢", "U": "U:確認失敗"}
MOC_STATUS = {"1": "未生產", "2": "已領料", "3": "生產中", "Y": "已完工", "y": "指定完工"}
MATERIAL_TYPE = {"1": "1:直接材料", "2": "2:間接材料", "3": "3:廠商供料", "4": "4:不發料", "5": "5:客戶供料"}
MAX_DETAIL_LINES = 3000   # 單身總列數上限(超過的單據不附單身,網頁註明)


def _ymd(v):
    v = (v or "").strip()
    return "%s-%s-%s" % (v[:4], v[4:6], v[6:8]) if len(v) == 8 and v.isdigit() else v


def _qty(v):
    if v is None:
        return ""
    f = float(v)
    return str(int(f)) if f == int(f) else ("%.4f" % f).rstrip("0").rstrip(".")


def _money(v):
    return "" if v is None else "{:,.2f}".format(float(v)).rstrip("0").rstrip(".")


def _vendor(code, name):
    code, name = (code or "").strip(), (name or "").strip()
    return "%s %s" % (code, name) if name else code


# 每種查詢:資料表、條件欄位(cond 的鍵 -> 欄位, 比對方式)、確認碼欄位、輸出欄位
# 比對方式:eq = 完全相同;prefix = 開頭相同(輸入部分單號也查得到,例如 20261113 = 當天所有單)
KINDS = {
    "moq": {
        "from": "MOCTA WITH (NOLOCK)",
        "cond": {"proj": ("TA551", "prefix"), "prod": ("TA006", "prefix"), "type": ("TA001", "eq"), "no": ("TA002", "prefix")},
        "confirm": "TA013",
        "select": "TA001, TA002, TA003, TA551, TA006, TA034, TA035, TA015, TA009, TA010, TA011, TA013, TA029",
        "order": "TA001, TA002 DESC",
        "cols": ["製令單別", "製令單號", "開單日期", "專案代號", "產品品號", "品名", "規格", "預計產量",
                 "預計開工", "預計完工", "狀態碼", "確認碼", "備註"],
        "row": lambda r: [r.TA001, r.TA002, _ymd(r.TA003), r.TA551, r.TA006, r.TA034, r.TA035, _qty(r.TA015),
                          _ymd(r.TA009), _ymd(r.TA010), MOC_STATUS.get((r.TA011 or "").strip(), r.TA011),
                          CONFIRM.get((r.TA013 or "").strip(), r.TA013), r.TA029],
        "key": lambda r: (r.TA001, r.TA002),
        "detail": {   # 單身 MOCTB
            "from": "MOCTB WITH (NOLOCK)", "keycols": ("TB001", "TB002"),
            "select": "TB001, TB002, TB003, TB012, TB013, TB004, TB005, TB007, TB011, TB017, TB015, TB006, TB009",
            "order": "TB001, TB002, TB006, TB003",
            "cols": ["材料品號", "品名", "規格", "需領用量", "已領用量", "未領用量", "單位", "材料型態", "備註", "預計領料", "製程代號", "庫別"],
            "row": lambda r: [r.TB003, r.TB012, r.TB013, _qty(r.TB004), _qty(r.TB005), _qty(float(r.TB004 or 0) - float(r.TB005 or 0)),
                              r.TB007, MATERIAL_TYPE.get((r.TB011 or "").strip(), r.TB011), r.TB017, _ymd(r.TB015), r.TB006, r.TB009],
        },
    },
    "mochg": {
        "from": "MOCTO WITH (NOLOCK)",
        "cond": {"type": ("TO001", "eq"), "no": ("TO002", "prefix")},
        "confirm": "TO041",
        "select": "TO001, TO002, TO003, TO004, TO009, TO035, TO036, TO017, TO041, TO043, TO044",
        "order": "TO001, TO002 DESC, TO003 DESC",
        "cols": ["製令單別", "製令單號", "變更版次", "變更日期", "產品品號", "品名", "規格", "預計產量",
                 "確認碼", "確認日期", "確認者"],
        "row": lambda r: [r.TO001, r.TO002, r.TO003, _ymd(r.TO004), r.TO009, r.TO035, r.TO036, _qty(r.TO017),
                          CONFIRM.get((r.TO041 or "").strip(), r.TO041), _ymd(r.TO043), r.TO044],
        "key": lambda r: (r.TO001, r.TO002, r.TO003),
        "detail": {   # 單身 MOCTP(TP1xx = 變更前的值)
            "from": "MOCTP WITH (NOLOCK)", "keycols": ("TP001", "TP002", "TP003"),
            "select": "TP001, TP002, TP003, TP004, TP013, TP014, TP104, TP107, TP007, TP105, TP005, TP006, TP008, TP018, TP024, TP026, TP010",
            "order": "TP001, TP002, TP003, TP007, TP004",
            "cols": ["材料品號", "材料品名", "材料規格", "原材料品號", "原製程代號", "製程代號", "原需領用量", "需領用量",
                     "已領用量", "未領用量", "單位", "備註", "被取替代品號", "被取替代製程", "庫別"],
            "row": lambda r: [r.TP004, r.TP013, r.TP014, r.TP104, r.TP107, r.TP007, _qty(r.TP105), _qty(r.TP005), _qty(r.TP006),
                              _qty(float(r.TP005 or 0) - float(r.TP006 or 0)), r.TP008, r.TP018, r.TP024, r.TP026, r.TP010],
        },
    },
    "poq": {
        "from": "PURTC WITH (NOLOCK) LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TC004",
        "cond": {"type": ("TC001", "eq"), "no": ("TC002", "prefix")},
        "confirm": "TC014",
        "select": "TC001, TC002, TC003, TC004, MA002, TC023, TC019, TC020, TC014, TC024, TC025",
        "order": "TC001, TC002 DESC",
        "cols": ["採購單別", "採購單號", "採購日期", "廠商", "數量合計", "採購金額", "稅額", "確認碼", "確認日期", "確認者"],
        "row": lambda r: [r.TC001, r.TC002, _ymd(r.TC003), _vendor(r.TC004, r.MA002), _qty(r.TC023), _money(r.TC019),
                          _money(r.TC020), CONFIRM.get((r.TC014 or "").strip(), r.TC014), _ymd(r.TC024), r.TC025],
        "key": lambda r: (r.TC001, r.TC002),
        "detail": {   # 單身 PURTD
            "from": "PURTD WITH (NOLOCK)", "keycols": ("TD001", "TD002"),
            "select": "TD001, TD002, TD003, TD004, TD005, TD006, TD008, TD015, TD009, TD010, TD011, TD012, TD022, TD014, TD016, TD007",
            "order": "TD001, TD002, TD003",
            "cols": ["序號", "品號", "品名", "規格", "採購數量", "已交數量", "單位", "單價", "金額", "預交日", "專案代號", "備註", "結案", "庫別"],
            "row": lambda r: [r.TD003, r.TD004, r.TD005, r.TD006, _qty(r.TD008), _qty(r.TD015), r.TD009, _money(r.TD010),
                              _money(r.TD011), _ymd(r.TD012), r.TD022, r.TD014, r.TD016, r.TD007],
        },
    },
    "pochg": {
        "from": "PURTE WITH (NOLOCK) LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TE005",
        "cond": {"type": ("TE001", "eq"), "no": ("TE002", "prefix")},
        "confirm": "TE017",
        "select": "TE001, TE002, TE003, TE004, TE005, MA002, TE017, TE011, TE021",
        "order": "TE001, TE002 DESC, TE003 DESC",
        "cols": ["採購單別", "採購單號", "變更版次", "變更日期", "廠商", "確認碼", "確認日期", "確認者"],
        "row": lambda r: [r.TE001, r.TE002, r.TE003, _ymd(r.TE004), _vendor(r.TE005, r.MA002),
                          CONFIRM.get((r.TE017 or "").strip(), r.TE017), _ymd(r.TE011), r.TE021],
        "key": lambda r: (r.TE001, r.TE002, r.TE003),
        "detail": {   # 單身 PURTF(TF1xx = 變更前的值)
            "from": "PURTF WITH (NOLOCK)", "keycols": ("TF001", "TF002", "TF003"),
            "select": "TF001, TF002, TF003, TF004, TF005, TF006, TF007, TF109, TF009, TF010, TF011, TF012, TF113, TF013, TF020, TF027, TF014",
            "order": "TF001, TF002, TF003, TF004",
            "cols": ["序號", "品號", "品名", "規格", "原數量", "數量", "單位", "單價", "金額", "原預交日", "預交日", "專案代號", "備註", "結案"],
            "row": lambda r: [r.TF004, r.TF005, r.TF006, r.TF007, _qty(r.TF109), _qty(r.TF009), r.TF010, _money(r.TF011),
                              _money(r.TF012), _ymd(r.TF113), _ymd(r.TF013), r.TF020, r.TF027, r.TF014],
        },
    },
}


def _like_escape(v):
    return v.replace("[", "[[]").replace("%", "[%]").replace("_", "[_]")


def build_sql(kind, cond):
    """依條件組出 SELECT 與參數。只接受 KINDS 裡定義的條件鍵,值一律用參數帶入,不拼進 SQL 字串。"""
    K = KINDS.get(kind)
    if not K:
        raise ValueError("不支援的查詢種類:%s" % kind)
    where, params = [], []
    for key, val in (cond or {}).items():
        val = str(val or "").strip()
        if not val:
            continue
        if key == "confirm":
            if val not in ("Y", "N"):
                raise ValueError("確認碼只能是 Y 或 N")
            where.append("%s = ?" % K["confirm"])
            params.append(val)
        elif key in K["cond"]:
            if len(val) > 40:
                raise ValueError("條件太長:%s" % key)
            col, how = K["cond"][key]
            if how == "eq":
                where.append("%s = ?" % col)
                params.append(val)
            else:
                where.append("%s LIKE ?" % col)
                params.append(_like_escape(val) + "%")
        else:
            raise ValueError("不支援的條件欄位:%s" % key)
    if not where:
        raise ValueError("至少要有一個查詢條件")
    sql = "SELECT TOP %d %s FROM %s WHERE %s ORDER BY %s" % (MAX_ROWS + 1, K["select"], K["from"], " AND ".join(where), K["order"])
    return sql, params


def run_query(kind, cond):
    sql, params = build_sql(kind, cond)
    assert sql.startswith("SELECT "), "只允許 SELECT"
    if ERP_SQL_DIR not in sys.path:
        sys.path.insert(0, ERP_SQL_DIR)
    import erp_sql
    K = KINDS[kind]
    cn = erp_sql.connect()
    try:
        cur = cn.cursor()
        cur.execute(sql, params)
        raw = cur.fetchall()
        keys = [tuple((v or "").strip() for v in K["key"](r)) for r in raw[:MAX_ROWS]]
        lines = _load_details(cur, K["detail"], keys)
    finally:
        cn.close()
    rows = [_texts(K["row"](r)) for r in raw[:MAX_ROWS]]
    msgs = []
    if len(raw) > MAX_ROWS:
        msgs.append("超過 %d 筆,只列出前 %d 筆,請加條件縮小範圍。" % (MAX_ROWS, MAX_ROWS))
    details, total, cut = [], 0, 0
    for k in keys:
        d = lines.get(k, [])
        if total + len(d) > MAX_DETAIL_LINES:
            details.append(None)
            cut += 1
        else:
            details.append(d)
            total += len(d)
    if cut:
        msgs.append("單身明細太多,有 %d 張單沒有附單身,請加條件縮小範圍。" % cut)
    return {"cols": K["cols"], "rows": rows, "dcols": K["detail"]["cols"], "details": details, "msg": " ".join(msgs)}


def _texts(vals):
    return [("" if v is None else str(v).strip()) for v in vals]


def _load_details(cur, D, keys, batch=150):
    """依單頭的鍵(單別、單號[、版次])分批查單身,回傳 {鍵: [[值...], ...]}。值一律用參數帶入。"""
    out = {}
    uniq = list(dict.fromkeys(keys))
    n = len(D["keycols"])
    one = "(" + " AND ".join("%s = ?" % c for c in D["keycols"]) + ")"
    for i in range(0, len(uniq), batch):
        part = uniq[i:i + batch]
        sql = "SELECT %s FROM %s WHERE %s ORDER BY %s" % (D["select"], D["from"], " OR ".join([one] * len(part)), D["order"])
        assert sql.startswith("SELECT "), "只允許 SELECT"
        cur.execute(sql, [v for k in part for v in k])
        for r in cur.fetchall():
            k = tuple((r[j] or "").strip() for j in range(n))
            out.setdefault(k, []).append(_texts(D["row"](r)))
    return out


# ---------- 與網站中繼(Apps Script)溝通 ----------
def load_config():
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    return cfg["endpoint"], cfg["syncKey"]


def _claim(endpoint, key):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode({"action": "erpq_claim", "key": key})
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post(endpoint, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, headers={"Content-Type": "text/plain; charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _log(text):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), text))
    except Exception:
        pass


def answer(endpoint, key, rq):
    """處理一筆已取走的查詢並回傳網站。回傳 (成功與否, 說明)。"""
    qid, kind, cond = rq.get("id", ""), rq.get("kind", ""), rq.get("cond") or {}
    payload = {"action": "erpq_result", "key": key, "id": qid}
    try:
        res = run_query(kind, cond)
        payload.update(ok=True, **res)
        note = "%d 筆,單身 %d 列" % (len(res["rows"]), sum(len(d or []) for d in res["details"]))
    except Exception as ex:
        payload.update(ok=False, msg="資料庫查詢失敗:%s" % str(ex)[:200])
        note = "失敗:%s" % str(ex)[:200]
    out = _post(endpoint, payload)
    _log("id=%s kind=%s by=%s cond=%s -> %s, 回傳 %s" % (qid, kind, rq.get("by", ""), json.dumps(cond, ensure_ascii=False),
                                                     note, "ok" if out.get("ok") else out))
    return bool(payload.get("ok")) and bool(out.get("ok")), note


def handle_pending(endpoint, key, limit=10):
    """取走並處理所有等待中的查詢,回傳處理筆數。"""
    n = 0
    while n < limit:
        res = _claim(endpoint, key)
        if not (res.get("ok") and res.get("pending")):
            break
        answer(endpoint, key, res.get("request") or {})
        n += 1
    return n


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    if "--test" in argv:
        i = argv.index("--test")
        res = run_query(argv[i + 1], json.loads(argv[i + 2]))
        print(json.dumps({"count": len(res["rows"]), "lines": sum(len(d or []) for d in res["details"]),
                          "chars": len(json.dumps(res, ensure_ascii=False)), "msg": res["msg"],
                          "rows": res["rows"][:2], "dcols": res["dcols"], "details": [(d or [])[:3] for d in res["details"][:2]]},
                         ensure_ascii=False))
        return 0
    endpoint, key = load_config()
    if "--id" in argv:
        rq = {"id": argv[argv.index("--id") + 1], "kind": argv[argv.index("--kind") + 1],
              "cond": json.loads(argv[argv.index("--cond") + 1]) if "--cond" in argv else {}}
        ok, note = answer(endpoint, key, rq)
        print(("已回傳:" if ok else "回傳失敗:") + note)
        return 0 if ok else 1
    n = handle_pending(endpoint, key)
    if n:
        print("處理 %d 筆 ERP 查詢" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
