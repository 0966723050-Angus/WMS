r"""網站「ERP 查詢」(製令 / 製令變更 / 採購單 / 採購變更)改用 SQL 直接查鼎新 ERP 資料庫(只做 SELECT)。

取走網頁送出的查詢 → 依條件查資料庫 → 把清單回傳網站(erpq_result),不必再開 ERP 畫面。
puri09_watch.py(每 10 秒)與排程「WMS 儲位編輯寫入」(apply_and_sync.ps1,每分鐘)都會呼叫這裡,誰先取到誰處理。

用法:
  python -I scripts\erpq_sql.py                      取走並處理所有等待中的查詢(沒有就直接結束)
  python -I scripts\erpq_sql.py --id <id> --kind <moq|mochg|poq|pochg|slq|srq|miq|mrq|mfq|prq|coq|cochg|ivi|ivz|ivs|ivq|ivh> --cond "<JSON>"
                                                    處理一筆已經被取走的查詢(監看器印出 ERPQ_REQUEST 時用)
  python -I scripts\erpq_sql.py --test <kind> "<JSON>"  只查詢、印出結果,不回傳網站
連線設定沿用 WMS\WMS一鍵更新\sql_config.json(erp_sql.connect,唯讀連線)。
"""
import datetime
import json
import re
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


# ---------- 2026-11-18 新增:銷貨 / 銷退 / 領料 / 退料 / 生產入庫 / 請購 / 訂單 / 訂單變更 / 庫存異動 ----------
MOC_ISSUE_KIND = {"54": "54:廠內領料", "55": "55:託外領料", "56": "56:廠內退料", "57": "57:託外退料"}


def _doc(a, b, c=None):
    a, b, c = (a or "").strip(), (b or "").strip(), (c or "").strip() if c is not None else ""
    return "-".join(x for x in (a, b, c) if x)


def _moctc(label, where):
    """製令領料 / 退料(MOCTC 單頭 + MOCTE 單身),用單據性質區分"""
    return {
        "from": "MOCTC WITH (NOLOCK)",
        "where": where,
        "cond": {"type": ("TC001", "eq"), "no": ("TC002", "prefix")},
        "confirm": "TC009",
        "select": "TC001, TC002, TC003, TC008, TC007, TC009, TC015",
        "order": "TC001, TC002 DESC",
        "cols": [label + "單別", label + "單號", label + "日期", "性質", "備註", "確認碼", "確認者"],
        "row": lambda r: [r.TC001, r.TC002, _ymd(r.TC003), MOC_ISSUE_KIND.get((r.TC008 or "").strip(), r.TC008), r.TC007,
                          CONFIRM.get((r.TC009 or "").strip(), r.TC009), r.TC015],
        "key": lambda r: (r.TC001, r.TC002),
        "detail": {
            "from": "MOCTE WITH (NOLOCK)", "keycols": ("TE001", "TE002"),
            "select": "TE001, TE002, TE003, TE004, TE017, TE018, TE005, TE006, TE008, TE011, TE012, TE020, TE013",
            "order": "TE001, TE002, TE003",
            "cols": ["序號", "品號", "品名", "規格", "數量", "單位", "庫別", "製令", "專案代號", "備註"],
            "row": lambda r: [r.TE003, r.TE004, r.TE017, r.TE018, _qty(r.TE005), r.TE006, r.TE008, _doc(r.TE011, r.TE012), r.TE020, r.TE013],
        },
    }


def _invta(docno):
    """庫存異動單(INVTA 單頭 + INVTB 單身),單別固定(1101 庫存領料單 / 1102 零元入庫單 / 1199 報廢單)。不顯示金額(成本另有權限)"""
    return {
        "from": "INVTA WITH (NOLOCK)",
        "where": "TA001 = '%s'" % docno,
        "cond": {"no": ("TA002", "prefix")},
        "confirm": "TA006",
        "select": "TA001, TA002, TA003, TA005, TA011, TA006, TA015",
        "order": "TA002 DESC",
        "cols": ["單別", "單號", "異動日期", "備註", "數量合計", "確認碼", "確認者"],
        "row": lambda r: [r.TA001, r.TA002, _ymd(r.TA003), r.TA005, _qty(r.TA011), CONFIRM.get((r.TA006 or "").strip(), r.TA006), r.TA015],
        "key": lambda r: (r.TA001, r.TA002),
        "detail": {
            "from": "INVTB WITH (NOLOCK)", "keycols": ("TB001", "TB002"),
            "select": "TB001, TB002, TB003, TB004, TB005, TB006, TB007, TB008, TB012",
            "order": "TB001, TB002, TB003",
            "cols": ["序號", "品號", "品名", "規格", "數量", "單位", "庫別"],
            "row": lambda r: [r.TB003, r.TB004, r.TB005, r.TB006, _qty(r.TB007), r.TB008, r.TB012],
        },
    }


def _ivq(with_cost):
    """庫存狀態(INVQ01)。with_cost=True 時多「庫存成本」「最近進價-本國幣別」兩欄(需 cost 權限)。"""
    return {
        "from": ("INVMB WITH (NOLOCK) "
                 "LEFT JOIN CMSMC AS WH WITH (NOLOCK) ON WH.MC001 = MB017 "
                 "LEFT JOIN PURMA AS VND WITH (NOLOCK) ON VND.MA001 = MB032"),
        "cond": {"code": ("MB001", "prefix"), "name": ("MB002", "prefix"), "spec": ("MB003", "prefix"),
                 "qty": ("MB064", "num"), "wh": ("MB017", "eq")},
        "select": "MB001, MB002, MB003, MB064, MB004, MB065, MB050, MB032, VND.MA002 AS VND_NAME, WH.MC002 AS WH_NAME, MB017",
        "order": "MB001",
        "cols": ["品號", "品名", "規格", "庫存數量", "單位"] + (["庫存成本", "最近進價-本國幣別"] if with_cost else []) +
                ["主要廠商", "主要廠商名稱", "主要庫別名稱", "主要庫別"],
        "row": lambda r: [r.MB001, r.MB002, r.MB003, _qty(r.MB064), r.MB004] +
                         ([_money(r.MB065), _money(r.MB050)] if with_cost else []) +
                         [r.MB032, r.VND_NAME, r.WH_NAME, r.MB017],
        "key": lambda r: (r.MB001,),
        "detail": {
            "from": "INVMC WITH (NOLOCK) LEFT JOIN CMSMC AS WHN WITH (NOLOCK) ON WHN.MC001 = INVMC.MC002",
            "keycols": ("INVMC.MC001",),
            "where": "INVMC.MC007 <> 0",
            "select": "INVMC.MC001 AS PN, INVMC.MC002 AS WH, WHN.MC002 AS WHN, INVMC.MC007 AS QTY",
            "order": "INVMC.MC001, INVMC.MC002",
            "cols": ["庫別", "庫別名稱", "庫存數量"],
            "row": lambda r: [r.WH, r.WHN, _qty(r.QTY)],
        },
    }


KINDS.update({
    # ---- 2026-11-20 新增:進貨查詢 / 退貨查詢(採購單底下);proj / prod 條件鍵借用為「供應廠商」「進貨(退貨)日期」----
    "rcq": {   # 進貨單 PURTG / PURTH
        "from": "PURTG WITH (NOLOCK) LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TG005",
        "cond": {"type": ("TG001", "eq"), "no": ("TG002", "prefix"), "proj": (("TG005", "MA002"), "vendor"), "prod": ("TG003", "date")},
        "confirm": "TG013",
        "select": "TG001, TG002, TG003, TG005, MA002, TG026, TG017, TG019, TG013",
        "order": "TG001, TG002 DESC",
        "cols": ["進貨單別", "進貨單號", "進貨日期", "廠商", "數量合計", "進貨金額", "稅額", "確認碼"],
        "row": lambda r: [r.TG001, r.TG002, _ymd(r.TG003), _vendor(r.TG005, r.MA002), _qty(r.TG026), _money(r.TG017),
                          _money(r.TG019), CONFIRM.get((r.TG013 or "").strip(), r.TG013)],
        "key": lambda r: (r.TG001, r.TG002),
        "detail": {
            "from": "PURTH WITH (NOLOCK)", "keycols": ("TH001", "TH002"),
            "select": "TH001, TH002, TH003, TH004, TH005, TH006, TH007, TH015, TH008, TH018, TH019, TH009, TH011, TH012, TH013, TH042",
            "order": "TH001, TH002, TH003",
            "cols": ["序號", "品號", "品名", "規格", "進貨數量", "驗收數量", "單位", "單價", "金額", "庫別", "採購單", "專案代號"],
            "row": lambda r: [r.TH003, r.TH004, r.TH005, r.TH006, _qty(r.TH007), _qty(r.TH015), r.TH008, _money(r.TH018),
                              _money(r.TH019), r.TH009, _doc(r.TH011, r.TH012, r.TH013), r.TH042],
        },
    },
    "rtq": {   # 退貨單 PURTI / PURTJ
        "from": "PURTI WITH (NOLOCK) LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TI004",
        "cond": {"type": ("TI001", "eq"), "no": ("TI002", "prefix"), "proj": (("TI004", "MA002"), "vendor"), "prod": ("TI003", "date")},
        "confirm": "TI013",
        "select": "TI001, TI002, TI003, TI004, MA002, TI022, TI011, TI015, TI012, TI013, TI026",
        "order": "TI001, TI002 DESC",
        "cols": ["退貨單別", "退貨單號", "退貨日期", "廠商", "數量合計", "退貨金額", "稅額", "備註", "確認碼", "確認者"],
        "row": lambda r: [r.TI001, r.TI002, _ymd(r.TI003), _vendor(r.TI004, r.MA002), _qty(r.TI022), _money(r.TI011),
                          _money(r.TI015), r.TI012, CONFIRM.get((r.TI013 or "").strip(), r.TI013), r.TI026],
        "key": lambda r: (r.TI001, r.TI002),
        "detail": {
            "from": "PURTJ WITH (NOLOCK)", "keycols": ("TJ001", "TJ002"),
            "select": "TJ001, TJ002, TJ003, TJ004, TJ005, TJ006, TJ009, TJ007, TJ008, TJ010, TJ011, TJ019, TJ029",
            "order": "TJ001, TJ002, TJ003",
            "cols": ["序號", "品號", "品名", "規格", "退貨數量", "單位", "單價", "金額", "庫別", "退貨原因", "專案代號"],
            "row": lambda r: [r.TJ003, r.TJ004, r.TJ005, r.TJ006, _qty(r.TJ009), r.TJ007, _money(r.TJ008), _money(r.TJ010),
                              r.TJ011, r.TJ019, r.TJ029],
        },
    },
    "slq": {   # 銷貨單 COPTG / COPTH
        "from": "COPTG WITH (NOLOCK) LEFT JOIN COPMA WITH (NOLOCK) ON MA001 = TG004",
        "cond": {"type": ("TG001", "eq"), "no": ("TG002", "prefix")},
        "confirm": "TG023",
        "select": "TG001, TG002, TG003, TG004, MA002, TG045, TG046, TG023, TG043",
        "order": "TG001, TG002 DESC",
        "cols": ["銷貨單別", "銷貨單號", "銷貨日期", "客戶", "未稅金額", "稅額", "確認碼", "確認者"],
        "row": lambda r: [r.TG001, r.TG002, _ymd(r.TG003), _vendor(r.TG004, r.MA002), _money(r.TG045), _money(r.TG046),
                          CONFIRM.get((r.TG023 or "").strip(), r.TG023), r.TG043],
        "key": lambda r: (r.TG001, r.TG002),
        "detail": {
            "from": "COPTH WITH (NOLOCK)", "keycols": ("TH001", "TH002"),
            "select": "TH001, TH002, TH003, TH004, TH005, TH006, TH008, TH009, TH012, TH013, TH007, TH014, TH015, TH016, TH030",
            "order": "TH001, TH002, TH003",
            "cols": ["序號", "品號", "品名", "規格", "數量", "單位", "單價", "金額", "庫別", "訂單", "專案代號"],
            "row": lambda r: [r.TH003, r.TH004, r.TH005, r.TH006, _qty(r.TH008), r.TH009, _money(r.TH012), _money(r.TH013), r.TH007,
                              _doc(r.TH014, r.TH015, r.TH016), r.TH030],
        },
    },
    "srq": {   # 銷退單 COPTI / COPTJ
        "from": "COPTI WITH (NOLOCK) LEFT JOIN COPMA WITH (NOLOCK) ON MA001 = TI004",
        "cond": {"type": ("TI001", "eq"), "no": ("TI002", "prefix")},
        "confirm": "TI019",
        "select": "TI001, TI002, TI003, TI004, MA002, TI010, TI011, TI019, TI035",
        "order": "TI001, TI002 DESC",
        "cols": ["銷退單別", "銷退單號", "銷退日期", "客戶", "金額", "稅額", "確認碼", "確認者"],
        "row": lambda r: [r.TI001, r.TI002, _ymd(r.TI003), _vendor(r.TI004, r.MA002), _money(r.TI010), _money(r.TI011),
                          CONFIRM.get((r.TI019 or "").strip(), r.TI019), r.TI035],
        "key": lambda r: (r.TI001, r.TI002),
        "detail": {
            "from": "COPTJ WITH (NOLOCK)", "keycols": ("TJ001", "TJ002"),
            "select": "TJ001, TJ002, TJ003, TJ004, TJ005, TJ006, TJ007, TJ008, TJ011, TJ012, TJ013, TJ023, TJ028",
            "order": "TJ001, TJ002, TJ003",
            "cols": ["序號", "品號", "品名", "規格", "數量", "單位", "單價", "金額", "庫別", "原因/備註", "專案代號"],
            "row": lambda r: [r.TJ003, r.TJ004, r.TJ005, r.TJ006, _qty(r.TJ007), r.TJ008, _money(r.TJ011), _money(r.TJ012), r.TJ013,
                              r.TJ023, r.TJ028],
        },
    },
    "miq": _moctc("領料", "TC008 IN ('54', '55')"),
    "mrq": _moctc("退料", "TC008 IN ('56', '57')"),
    "mfq": {   # 生產入庫單 MOCTF / MOCTG
        "from": "MOCTF WITH (NOLOCK)",
        "cond": {"type": ("TF001", "eq"), "no": ("TF002", "prefix")},
        "confirm": "TF006",
        "select": "TF001, TF002, TF003, TF006, TF013",
        "order": "TF001, TF002 DESC",
        "cols": ["入庫單別", "入庫單號", "入庫日期", "確認碼", "確認者"],
        "row": lambda r: [r.TF001, r.TF002, _ymd(r.TF003), CONFIRM.get((r.TF006 or "").strip(), r.TF006), r.TF013],
        "key": lambda r: (r.TF001, r.TF002),
        "detail": {
            "from": "MOCTG WITH (NOLOCK)", "keycols": ("TG001", "TG002"),
            "select": "TG001, TG002, TG003, TG004, TG005, TG006, TG011, TG013, TG007, TG010, TG014, TG015, TG021",
            "order": "TG001, TG002, TG003",
            "cols": ["序號", "品號", "品名", "規格", "入庫數量", "驗收數量", "單位", "庫別", "製令", "專案代號"],
            "row": lambda r: [r.TG003, r.TG004, r.TG005, r.TG006, _qty(r.TG011), _qty(r.TG013), r.TG007, r.TG010,
                              _doc(r.TG014, r.TG015), r.TG021],
        },
    },
    "prq": {   # 請購單 PURTA / PURTB
        "from": "PURTA WITH (NOLOCK)",
        "cond": {"type": ("TA001", "eq"), "no": ("TA002", "prefix")},
        "confirm": "TA007",
        "select": "TA001, TA002, TA003, TA004, TA012, TA011, TA006, TA007, TA014",
        "order": "TA001, TA002 DESC",
        "cols": ["請購單別", "請購單號", "請購日期", "部門", "請購人員", "數量合計", "備註", "確認碼", "確認者"],
        "row": lambda r: [r.TA001, r.TA002, _ymd(r.TA003), r.TA004, r.TA012, _qty(r.TA011), r.TA006,
                          CONFIRM.get((r.TA007 or "").strip(), r.TA007), r.TA014],
        "key": lambda r: (r.TA001, r.TA002),
        "detail": {
            "from": "PURTB WITH (NOLOCK) LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TB010", "keycols": ("TB001", "TB002"),
            "select": "TB001, TB002, TB003, TB004, TB005, TB006, TB009, TB007, TB011, TB010, MA002, TB043, TB022, TB008",
            "order": "TB001, TB002, TB003",
            "cols": ["序號", "品號", "品名", "規格", "請購數量", "單位", "需求日", "廠商", "專案代號", "採購單", "庫別"],
            "row": lambda r: [r.TB003, r.TB004, r.TB005, r.TB006, _qty(r.TB009), r.TB007, _ymd(r.TB011), _vendor(r.TB010, r.MA002),
                              r.TB043, r.TB022, r.TB008],
        },
    },
    "coq": {   # 客戶訂單 COPTC / COPTD
        "from": "COPTC WITH (NOLOCK) LEFT JOIN COPMA WITH (NOLOCK) ON MA001 = TC004",
        # proj / prod 這兩個條件鍵在訂單查詢借用為「客戶單號(TC012)」「客戶名稱(TC053 客戶全名)」(網頁欄位名稱見 app.js ERPQ_KINDS.coq)
        "cond": {"type": ("TC001", "eq"), "no": ("TC002", "prefix"), "proj": ("TC012", "prefix"), "prod": ("TC053", "prefix")},
        "confirm": "TC027",
        "select": "TC001, TC002, TC003, TC004, MA002, TC012, TC008, TC029, TC027, TC040",
        "order": "TC001, TC002 DESC",
        "cols": ["訂單單別", "訂單單號", "訂單日期", "客戶", "客戶單號", "幣別", "訂單金額", "確認碼", "確認者"],
        "row": lambda r: [r.TC001, r.TC002, _ymd(r.TC003), _vendor(r.TC004, r.MA002), r.TC012, r.TC008, _money(r.TC029),
                          CONFIRM.get((r.TC027 or "").strip(), r.TC027), r.TC040],
        "key": lambda r: (r.TC001, r.TC002),
        "detail": {
            "from": "COPTD WITH (NOLOCK)", "keycols": ("TD001", "TD002"),
            "select": "TD001, TD002, TD003, TD004, TD005, TD006, TD008, TD009, TD010, TD011, TD012, TD013, TD027, TD016, TD007",
            "order": "TD001, TD002, TD003",
            "cols": ["序號", "品號", "品名", "規格", "訂單數量", "已交數量", "單位", "單價", "金額", "預交日", "專案代號", "結案", "庫別"],
            "row": lambda r: [r.TD003, r.TD004, r.TD005, r.TD006, _qty(r.TD008), _qty(r.TD009), r.TD010, _money(r.TD011),
                              _money(r.TD012), _ymd(r.TD013), r.TD027, r.TD016, r.TD007],
        },
    },
    "cochg": {   # 訂單變更 COPTE / COPTF(TF1xx = 變更前的值)
        "from": "COPTE WITH (NOLOCK) LEFT JOIN COPMA WITH (NOLOCK) ON MA001 = TE007",
        "cond": {"type": ("TE001", "eq"), "no": ("TE002", "prefix")},
        "confirm": "TE029",
        "select": "TE001, TE002, TE003, TE004, TE007, MA002, TE006, TE029, TE039",
        "order": "TE001, TE002 DESC, TE003 DESC",
        "cols": ["訂單單別", "訂單單號", "變更版次", "變更日期", "客戶", "變更原因", "確認碼", "確認者"],
        "row": lambda r: [r.TE001, r.TE002, r.TE003, _ymd(r.TE004), _vendor(r.TE007, r.MA002), r.TE006,
                          CONFIRM.get((r.TE029 or "").strip(), r.TE029), r.TE039],
        "key": lambda r: (r.TE001, r.TE002, r.TE003),
        "detail": {
            "from": "COPTF WITH (NOLOCK)", "keycols": ("TF001", "TF002", "TF003"),
            "select": "TF001, TF002, TF003, TF004, TF005, TF006, TF007, TF109, TF009, TF010, TF013, TF014, TF115, TF015, TF022, TF018",
            "order": "TF001, TF002, TF003, TF004",
            "cols": ["序號", "品號", "品名", "規格", "原數量", "數量", "單位", "單價", "金額", "原預交日", "預交日", "專案代號", "變更原因"],
            "row": lambda r: [r.TF004, r.TF005, r.TF006, r.TF007, _qty(r.TF109), _qty(r.TF009), r.TF010, _money(r.TF013),
                              _money(r.TF014), _ymd(r.TF115), _ymd(r.TF015), r.TF022, r.TF018],
        },
    },
    "ivi": _invta("1101"),   # 庫存領料單
    "ivz": _invta("1102"),   # 零元入庫單
    "ivs": _invta("1199"),   # 報廢單
    # ---- 2026-11-25 新增:庫存狀態查詢(鼎新 INVQ01)。條件欄位同 ERP「設定查詢條件」:品號 MB001 / 品名 MB002 / 規格 MB003 /
    # 庫存數量 MB064(數字,只能用 = >= <= <>)/ 主要庫別 MB017。顯示欄位同 INVQ01 的「資料瀏覽」;
    # 庫存成本(MB065)、最近進價-本國幣別(MB050)是成本資料,只有網站帳號有「cost」權限時才附上(由 Apps Script 依帳號權限
    # 在查詢條件加 cost=1,見 erpqRequest_;kind 仍是 ivq,run_query 內部換成 ivqc)。單身 = 各庫庫存量(INVMC,只列數量不為 0 的庫別)----
    "ivq": _ivq(False),
    "ivqc": _ivq(True),
})


def _like_escape(v):
    return v.replace("[", "[[]").replace("%", "[%]").replace("_", "[_]")


OPS = ("=", ">=", "<=", "<>", "%like%", "%like", "like%")   # 與網頁 / ERP 查詢對話框相同


def build_sql(kind, cond):
    """依條件組出 SELECT 與參數。只接受 KINDS 裡定義的條件鍵,值一律用參數帶入,不拼進 SQL 字串。"""
    K = KINDS.get(kind)
    if not K:
        raise ValueError("不支援的查詢種類:%s" % kind)
    where, params = [], []
    cond = cond or {}
    for key, val in cond.items():
        if key.startswith("op_"):
            continue
        val = str(val or "").strip()
        if not val:
            continue
        op = str(cond.get("op_" + key) or "").strip()
        if op and op not in OPS:
            raise ValueError("不支援的比較方式:%s" % op)
        if key == "confirm":
            if "confirm" not in K:
                raise ValueError("這種查詢沒有確認碼條件")
            if val not in ("Y", "N"):
                raise ValueError("確認碼只能是 Y 或 N")
            col, default = K["confirm"], "="
        elif key in K["cond"]:
            if len(val) > 40:
                raise ValueError("條件太長:%s" % key)
            col, how = K["cond"][key]
            default = "=" if how in ("eq", "date", "vendor", "num") else "like%"   # 舊版網頁沒送比較方式時:單別相同、單號開頭相同
            if how == "date":   # 日期欄是 yyyyMMdd:2026-11-20、2026/11/20 都轉成 20261120
                val = re.sub(r"[-/.\s]", "", val)
            elif how == "num":   # 數字欄(例:庫存數量):只能比大小,值轉成數字再帶入
                if op and op not in ("=", ">=", "<=", "<>"):
                    raise ValueError("數字條件只能用 = >= <= <>")
                try:
                    val = float(val.replace(",", ""))
                except ValueError:
                    raise ValueError("條件要輸入數字:%s" % key)
        else:
            raise ValueError("不支援的條件欄位:%s" % key)
        op = op or default
        cols = col if isinstance(col, tuple) else (col,)   # 多欄 = 任一欄符合(例:供應廠商代號或簡稱)
        if op in ("=", ">=", "<=", "<>"):
            joiner = " AND " if op == "<>" else " OR "
            where.append("(" + joiner.join("%s %s ?" % (c, op) for c in cols) + ")")   # op 只會是 OPS 裡的固定字串
            params.extend([val] * len(cols))
        else:
            v = _like_escape(val)
            pv = ("%" + v + "%") if op == "%like%" else ("%" + v) if op == "%like" else (v + "%")
            where.append("(" + " OR ".join("%s LIKE ?" % c for c in cols) + ")")
            params.extend([pv] * len(cols))
    if not where:
        raise ValueError("至少要有一個查詢條件")
    if K.get("where"):   # 固定條件(程式內寫死的常數,例如單據性質、固定單別;不含使用者輸入)
        where.insert(0, K["where"])
    sql = "SELECT TOP %d %s FROM %s WHERE %s ORDER BY %s" % (MAX_ROWS + 1, K["select"], K["from"], " AND ".join(where), K["order"])
    return sql, params


def _label_receipts(cond):
    """待列印標籤清單(網頁 標籤 → 待列印清單):期間內已確認的進貨單身。
    cond.prod = 起日、cond.proj = 迄日(yyyyMMdd)。以進貨日期為準;另外把期間內才確認、但進貨日期在起日前 7 天內的也算進來
    (先建單隔天才確認)。不分頁,最多 3000 列。回傳格式同其他查詢(cols / rows),比對在線製令與剔除已下載由網頁處理。"""
    a = re.sub(r"\D", "", str((cond or {}).get("prod") or ""))
    b = re.sub(r"\D", "", str((cond or {}).get("proj") or "")) or a
    if len(a) != 8 or len(b) != 8:
        raise ValueError("日期格式不正確")
    if a > b:
        a, b = b, a
    early = (datetime.datetime.strptime(a, "%Y%m%d") - datetime.timedelta(days=7)).strftime("%Y%m%d")
    sql = """SELECT TOP 3001 TH001, TH002, TH003, TH004, TH005, TH006, TH007, TH015, TH008, TH042, TG003, TG005, MA002
             FROM PURTH WITH (NOLOCK)
             JOIN PURTG WITH (NOLOCK) ON TG001 = TH001 AND TG002 = TH002
             LEFT JOIN PURMA WITH (NOLOCK) ON MA001 = TG005
             WHERE TG013 = 'Y' AND ((TG003 BETWEEN ? AND ?) OR (PURTG.MODI_DATE BETWEEN ? AND ? AND TG003 >= ?))
             ORDER BY TG003, TH001, TH002, TH003"""
    if ERP_SQL_DIR not in sys.path:
        sys.path.insert(0, ERP_SQL_DIR)
    import erp_sql
    cn = erp_sql.connect()
    stock = {}
    try:
        cur = cn.cursor()
        cur.execute(sql, [a, b, a, b, early])
        raw = cur.fetchall()
        # 各料號目前庫存(2026-11-26 使用者要求:多張製令需求合計超過進貨數量時,要看庫存夠不夠)。
        # 範圍同網站「庫存」頁(INVR17):庫別 1 開頭的 INVMC 加總;已確認的進貨已經算在裡面
        codes = sorted({(r.TH004 or "").strip() for r in raw[:3000] if (r.TH004 or "").strip()})
        for i in range(0, len(codes), 500):
            part = codes[i:i + 500]
            q = ("SELECT MC001, SUM(MC007) FROM INVMC WITH (NOLOCK) WHERE MC002 LIKE '1%%' AND MC001 IN (%s) GROUP BY MC001"
                 % ",".join("?" * len(part)))
            assert q.startswith("SELECT "), "只允許 SELECT"
            cur.execute(q, part)
            for code, s in cur.fetchall():
                stock[(code or "").strip()] = s
    finally:
        cn.close()
    rows = []
    for r in raw[:3000]:
        t = lambda v: ("" if v is None else str(v).strip())
        qty = r.TH015 if r.TH015 not in (None, 0) else r.TH007
        rows.append([t(r.TH001) + "-" + t(r.TH002) + "-" + t(r.TH003), t(r.TH001) + "-" + t(r.TH002), t(r.TH003), t(r.TH004),
                     t(r.TH005), t(r.TH006), _qty(qty), t(r.TH008), t(r.TH042), t(r.TG003), _vendor(t(r.TG005), t(r.MA002)),
                     _qty(stock.get(t(r.TH004), 0))])
    return {"cols": ["key", "進貨單", "序號", "品號", "品名", "規格", "驗收數量", "單位", "專案代號", "進貨日期", "廠商", "庫存"],
            "rows": rows, "dcols": [], "details": [None] * len(rows),
            "msg": "超過 3000 筆,只列出前 3000 筆,請縮小日期區間。" if len(raw) > 3000 else ""}


def _inv_history(cond):
    """庫存狀態「歷史異動」(鼎新 INVQ01「查歷史異動」):某品號在 INVLA(庫存交易明細)的所有異動,日期由舊到新。
    cond:code 品號(完全相同,必填)、wh 庫別、dfrom / dto 日期區間(yyyyMMdd,可帶 - /)、cost(由 Apps Script 依帳號 cost 權限加上,
    有才附「單位成本」「異動金額」與金額合計)。最多回傳最近 1000 筆;合計用整個條件範圍算,不受筆數限制。"""
    cond = cond or {}
    with_cost = bool(cond.get("cost"))
    code = str(cond.get("code") or "").strip()
    if not code or len(code) > 40:
        raise ValueError("缺少品號")
    where, params = ["LA001 = ?"], [code]
    wh = str(cond.get("wh") or "").strip()
    if wh:
        if len(wh) > 10:
            raise ValueError("庫別太長")
        where.append("LA009 = ?")
        params.append(wh)
    for key, op in (("dfrom", ">="), ("dto", "<=")):
        v = re.sub(r"[-/.\s]", "", str(cond.get(key) or ""))
        if v:
            if not (len(v) == 8 and v.isdigit()):
                raise ValueError("日期格式不正確(要 yyyyMMdd,例 20260101)")
            where.append("LA004 %s ?" % op)   # op 只會是上面固定的兩種
            params.append(v)
    w = " AND ".join(where)
    sql = ("SELECT TOP 1001 LA004, LA005, LA006, LA007, LA008, LA009, WH.MC002 AS WH_NAME, WH.MC003 AS FAC, FB.MB002 AS FAC_NAME, "
           "LA010, LA011, LA012, LA013, MQ.MQ002 AS DOC_NAME "
           "FROM INVLA WITH (NOLOCK) "
           "LEFT JOIN CMSMC AS WH WITH (NOLOCK) ON WH.MC001 = LA009 "
           "LEFT JOIN CMSMB AS FB WITH (NOLOCK) ON FB.MB001 = WH.MC003 "
           "LEFT JOIN CMSMQ AS MQ WITH (NOLOCK) ON MQ.MQ001 = LA006 "
           "WHERE " + w + " ORDER BY LA004 DESC, LA006 DESC, LA007 DESC, LA008 DESC, LA009 DESC")
    sql_sum = ("SELECT COUNT(*), SUM(LA005 * LA011), SUM(LA005 * LA013), "
               "SUM(CASE WHEN LA005 = 1 THEN LA013 ELSE 0 END), SUM(CASE WHEN LA005 = -1 THEN LA013 ELSE 0 END) "
               "FROM INVLA WITH (NOLOCK) WHERE " + w)
    assert sql.startswith("SELECT ") and sql_sum.startswith("SELECT "), "只允許 SELECT"
    if ERP_SQL_DIR not in sys.path:
        sys.path.insert(0, ERP_SQL_DIR)
    import erp_sql
    cn = erp_sql.connect()
    try:
        cur = cn.cursor()
        cur.execute(sql, params)
        raw = cur.fetchall()
        cur.execute(sql_sum, params)
        tot = cur.fetchone()
    finally:
        cn.close()
    raw = list(reversed(raw[:1000]))   # 取最近 1000 筆,再排成由舊到新
    t = lambda v: ("" if v is None else str(v).strip())
    rows = []
    for r in raw:
        row = [t(r.DOC_NAME), _ymd(t(r.LA004)), "%s-%s-%s" % (t(r.LA006), t(r.LA007), t(r.LA008)), "入庫" if r.LA005 == 1 else "出庫",
               _qty(r.LA011), t(r.LA009), t(r.WH_NAME), t(r.LA010), t(r.FAC), t(r.FAC_NAME)]
        if with_cost:
            row += [_money(r.LA012), _money(r.LA013)]
        rows.append(row)
    cols = ["單據名稱", "日期", "單別-單號-序號", "入出別", "異動數量", "庫別", "庫別名稱", "備註", "廠別代號", "廠別名稱"]
    if with_cost:
        cols += ["單位成本", "異動金額"]
    n, qty, amt, a_in, a_out = tot[0] or 0, tot[1] or 0, tot[2] or 0, tot[3] or 0, tot[4] or 0
    msg = "總數量 " + _qty(qty)
    if with_cost:
        msg += " · 總金額 %s · 總入庫金額 %s · 總出庫金額 %s" % (_money(amt) or "0", _money(a_in) or "0", _money(a_out) or "0")
    if n > 1000:
        msg += " · 共 %d 筆,只列出最近 1000 筆,請縮小日期區間" % n
    return {"cols": cols, "rows": rows, "dcols": [], "details": [None] * len(rows), "msg": msg}


# 待簽核清單的「查看」:程式代碼 → 查詢種類(庫存異動 INVI05 依單別分)
SIGN_VIEW_KIND = {"PURI07": "poq", "PURI08": "pochg", "PURI05": "prq", "PURI09": "rcq", "PURI11": "rtq",
                  "MOCI02": "moq", "MOCI12": "mochg", "MOCI03": "miq", "MOCI04": "mrq", "MOCI05": "mfq",
                  "COPI06": "coq", "COPI07": "cochg", "COPI08": "slq", "COPI09": "srq"}
SIGN_VIEW_INV = {"1101": "ivi", "1102": "ivz", "1199": "ivs"}
SIGN_VIEW_TITLE = {"poq": "採購單", "pochg": "採購變更單", "prq": "請購單", "rcq": "進貨單", "rtq": "退貨單", "moq": "製令",
                   "mochg": "製令變更單", "miq": "製令領料單", "mrq": "製令退料單", "mfq": "生產入庫單", "coq": "客戶訂單",
                   "cochg": "訂單變更單", "slq": "銷貨單", "srq": "銷退單", "ivi": "庫存領料單", "ivz": "零元入庫單", "ivs": "報廢單"}


def _sign_view(cond):
    """cond.docs = ["程式|單別|單號", ...](最多 20 張)→ 每張單的單頭(cols/row)與單身(dcols/lines);變更單每個版次各一筆。"""
    docs = [str(d) for d in ((cond or {}).get("docs") or [])][:20]
    out = []
    for d in docs:
        parts = [x.strip() for x in d.split("|")]
        if len(parts) != 3:
            continue
        prog, dt, dn = parts[0].upper(), parts[1], parts[2]
        kind = SIGN_VIEW_INV.get(dt) if prog == "INVI05" else SIGN_VIEW_KIND.get(prog)
        label = "%s-%s" % (dt, dn)
        if not kind:
            out.append({"doc": label, "prog": prog, "title": prog, "error": "這種表單(%s)還不支援查看" % prog})
            continue
        c = {"no": dn, "op_no": "="}
        if "type" in KINDS[kind]["cond"]:
            c.update(type=dt, op_type="=")
        try:
            res = run_query(kind, c)
        except Exception as ex:
            out.append({"doc": label, "prog": prog, "title": SIGN_VIEW_TITLE.get(kind, prog), "error": "查詢失敗:%s" % str(ex)[:120]})
            continue
        if not res["rows"]:
            out.append({"doc": label, "prog": prog, "title": SIGN_VIEW_TITLE.get(kind, prog), "error": "ERP 查無這張單據"})
            continue
        for i, row in enumerate(res["rows"]):
            out.append({"doc": label, "prog": prog, "title": SIGN_VIEW_TITLE.get(kind, prog), "cols": res["cols"], "row": row,
                        "dcols": res["dcols"], "lines": res["details"][i] or []})
    return {"cols": [], "rows": [], "dcols": [], "details": [], "docs": out, "msg": ""}


def _sign_check(cond):
    """送簽前檢查(網頁「確認」送簽、ERP 查詢頁「送簽」之前):cond.docs = ["程式|單別|單號", ...](最多 20 張)→ 每張單在 ERP 的確認碼。
    只有確認碼是 N(未確認)才可以送簽;已確認(Y)、作廢(V)、確認失敗(U)、查無單據都回 error(原因),網頁據此阻擋並提醒送簽者。
    程式代碼沒有 SQL 對照(例如 MOCI06/07)無法檢查,不擋(照原流程)。變更單看最後一個版次。"""
    docs = [str(d) for d in ((cond or {}).get("docs") or [])][:20]
    if HERE not in sys.path:
        sys.path.insert(0, HERE)   # python -I 不會自動加入本資料夾
    import erp_check
    if ERP_SQL_DIR not in sys.path:
        sys.path.insert(0, ERP_SQL_DIR)
    import erp_sql
    out = []
    cn = erp_sql.connect()
    try:
        cur = cn.cursor()
        for d in docs:
            parts = [x.strip() for x in d.split("|")]
            if len(parts) != 3:
                continue
            prog, dt, dn = parts[0].upper(), parts[1], parts[2]
            item = {"doc": "%s-%s" % (dt, dn), "prog": prog, "title": (erp_check.PROGS.get(prog) or ("", "", "", "", "", prog))[5],
                    "cols": ["確認碼"], "row": [""], "dcols": [], "lines": []}
            try:
                st = erp_check.doc_status(cur, prog, dt, dn)
            except Exception as ex:
                item["error"] = "查詢失敗:%s" % str(ex)[:100]
                out.append(item)
                continue
            if not st.get("known"):
                item["row"] = ["未對照,無法檢查"]
            elif not st.get("found"):
                item["error"] = "ERP 查無這張單據,請確認單別、單號"
            else:
                c = (st.get("confirm") or "").strip()
                item["row"] = [CONFIRM.get(c, c or "空白")]
                if c == "N":
                    pass
                elif c == "Y":
                    item["error"] = "ERP 已是確認狀態(Y:已確認),不需要再送簽"
                elif c == "V":
                    item["error"] = "單據已作廢(V),不能送簽"
                else:
                    item["error"] = "確認碼是「%s」,不是未確認(N),不能送簽" % (c or "空白")
            out.append(item)
    finally:
        cn.close()
    return {"cols": [], "rows": [], "dcols": [], "details": [], "docs": out, "msg": ""}


def run_query(kind, cond):
    if kind == "ivh":
        return _inv_history(cond)
    if kind == "lbr":
        return _label_receipts(cond)
    if kind == "sgv":
        return _sign_view(cond)
    if kind == "sgc":
        return _sign_check(cond)
    cond = dict(cond or {})
    with_cost = cond.pop("cost", None)   # 由 Apps Script 依帳號的 cost 權限加上,網頁送的值不會被採用(Code.gs 白名單沒有 cost)
    if kind == "ivq" and with_cost:
        kind = "ivqc"   # 附庫存成本、最近進價
    elif kind == "ivqc":
        raise ValueError("不支援的查詢種類:%s" % kind)
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
        keyw = "(" + " OR ".join([one] * len(part)) + ")"
        if D.get("where"):   # 固定條件(程式內寫死的常數,例如只列庫存不為 0 的庫別)
            keyw += " AND (%s)" % D["where"]
        sql = "SELECT %s FROM %s WHERE %s ORDER BY %s" % (D["select"], D["from"], keyw, D["order"])
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
        note = ("查看 %d 張" % len(res["docs"])) if "docs" in res else "%d 筆,單身 %d 列" % (len(res["rows"]), sum(len(d or []) for d in res["details"]))
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
