"""puri09 / 退貨單 skill 的清單工具:讀取 / 清除「收料」(進貨)或「退料」(退貨)工作表,
清除成功列的同時寫入「進退貨履歷」,並把 WMS.xlsx 同步到雲端硬碟。

    python -I puri09_cleanup.py read [--kind 進貨|退貨]
        讀「收料」(進貨,預設)或「退料」(退貨)工作表第 2 列起的資料列,印成 JSON 清單,並存一份快照。
        (進貨快照 puri09_snapshot.json;退貨快照 return_snapshot.json)
    python -I puri09_cleanup.py clear --done "3303-20261102004-0001=3402-20261110002,3303-...-0002=3402-20261110002"
        只清除「已成功建立單據」的列(以快照比對),建立失敗/略過的列保留。
        每個項目寫成「採購單別-單號-序號=ERP 產生的進貨(或退貨)單別-單號」,清除的同時會把這些列寫進
        「進退貨履歷」工作表(日期=今天、單據=進貨/退貨、單別、單號、廠商、採購單、品號、品名、數量)。
        採購單號是空白、或同一張採購單有多列時,項目寫成「採購單別-單號-序號|品號=單據號」(沒有採購單就是「|品號=單據號」)。
        退貨單用同一個指令,加上 --kind 退貨(讀的是「退料」工作表,履歷的單據=退貨)。
        快照之後才新增的列(網站又送了新的)不會被動到。清除前會先備份 WMS.xlsx。
    python -I puri09_cleanup.py clear [--done "..."] --fail "3303-20261102004-0001=查無採購序號;|EL-A001=沒有採購單號"
        --fail:建立失敗/略過的列,在「狀態」欄寫「⚠ 失敗:原因」(紅字),列保留;格式「採購單別-單號-序號=原因」,
        分號分隔;採購單號空白的列寫「|品號=原因」。可以和 --done 同時使用(成功的清除並寫履歷,失敗的標記),也可以只給 --fail。
        不論有沒有刪列,結束時都會自動把 WMS.xlsx 複製到雲端硬碟同步資料夾(不必再手動跑 Run_Sync)。
    python -I puri09_cleanup.py clear --all --doc 3402-20261110002 [--kind 退貨]
        清除快照內所有列(全部都成功、且同一張單時使用),一樣會寫進「進退貨履歷」。
    python -I puri09_cleanup.py sync
        把 WMS.xlsx 複製到雲端硬碟同步資料夾。

結束代碼:0 成功;3 WMS.xlsx 被 Excel 開啟(未動);1 其他錯誤。輸出一律是一行 JSON。
"""
import datetime
import json
import os
import shutil
import subprocess
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # `python -I` 不會自動加入本資料夾,receipt_snapshot 要靠這行才 import 得到
# 環境變數 PURI09_MASTER / PURI09_DRIVE / PURI09_DIR 只在測試時用來改指向副本
MASTER = os.environ.get("PURI09_MASTER", r"C:\ATK\Project\AI Agent\WMS\WMS.xlsx")
DRIVE = os.environ.get("PURI09_DRIVE", r"C:\Users\angus.ad\我的雲端硬碟\ATK\WMS.xlsx")
_WORK = os.environ.get("PURI09_DIR", HERE)
BACKUP_DIR = os.path.join(_WORK, "backup")
SNAPSHOT = os.path.join(_WORK, "puri09_snapshot.json")
SHEET = "收料"
HISTORY_SHEET = "進退貨履歷"
KEEP_BACKUPS = 20

# 「進退貨履歷」標題列可接受的寫法
HIST_ALIASES = {
    "date": ["日期"],
    "kind": ["單據"],
    "doc_type": ["單別"],
    "doc_no": ["單號"],
    "vendor": ["廠商", "廠商簡稱"],
    "po": ["採購單別-單號-序號", "採購單號", "採購單別單號序號", "採購單"],
    "code": ["品號", "材料品號"],
    "name": ["品名"],
    "qty": ["數量"],
}

# 標題列可接受的寫法(和 apply_edits.py 一致)
ALIASES = {
    "date": ["日期"],
    "vendor": ["廠商", "廠商簡稱"],
    "po": ["採購單號", "採購單別-單號-序號", "採購單別單號序號", "採購單"],
    "code": ["品號", "材料品號"],
    "name": ["品名"],
    "qty": ["數量", "收料數量", "進貨數量", "退料數量", "退貨數量"],
}
# 「退料」工作表多兩個欄位:要退的原進貨單別 / 單號
RET_ALIASES = dict(ALIASES, doc_type=["進貨單別"], doc_no=["進貨單號"])
# 選用欄位(沒有也不算缺欄):「狀態」欄,puri09 在 ERP 作業失敗時寫入「⚠ 失敗:原因」
STATUS_ALIASES = ["狀態"]

# 依單據種類(進貨 / 退貨)選用的工作表、標題別名、快照檔
PROFILES = {
    "進貨": {"sheet": SHEET, "aliases": ALIASES, "snapshot": SNAPSHOT, "key": "receipt"},
    "退貨": {"sheet": "退料", "aliases": RET_ALIASES, "snapshot": os.path.join(_WORK, "return_snapshot.json"), "key": "ret"},
}


def profile_of(kind):
    return PROFILES[kind]


def out(obj, code=0):
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(obj, ensure_ascii=False))
    return code


def norm(v):
    return " ".join(("" if v is None else str(v)).split())


def qty_of(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def excel_locked():
    d, n = os.path.split(MASTER)
    return os.path.exists(os.path.join(d, "~$" + n))


def columns(ws, aliases=None):
    aliases = aliases or ALIASES
    by_header = {}
    for c in range(1, ws.max_column + 1):
        h = str(ws.cell(1, c).value or "").strip()
        if h:
            by_header[h] = c
    cols = {}
    for key, names in aliases.items():
        for a in names:
            if a in by_header:
                cols[key] = by_header[a]
                break
    missing = [k for k in aliases if k not in cols]
    for a in STATUS_ALIASES:
        if a in by_header:
            cols["status"] = by_header[a]
            break
    return cols, missing


def read_rows(ws, cols):
    rows = []
    for r in range(2, ws.max_row + 1):
        vals = {k: ws.cell(r, c).value for k, c in cols.items()}
        if all(v in (None, "") for k, v in vals.items() if k != "status"):
            continue
        row = {
            "row": r,
            "vendor": norm(vals["vendor"]), "po": norm(vals["po"]), "code": norm(vals["code"]),
            "name": norm(vals["name"]), "qty": qty_of(vals["qty"]),
            "date": vals["date"].strftime("%Y-%m-%d") if hasattr(vals["date"], "strftime") else norm(vals["date"]),
            "fail": norm(vals.get("status")),   # 例:「⚠ 失敗:查無採購序號」,沒有就是空字串
        }
        if "doc_type" in cols:   # 退料:要退的原進貨單別 / 單號
            row["doc_type"] = norm(vals.get("doc_type"))
            row["doc_no"] = norm(vals.get("doc_no"))
        rows.append(row)
    return rows


def row_identity(r):
    """比對同一列用的內容:廠商、採購單、品號、數量(退料再加進貨單別/單號)。"""
    return (r["vendor"], r["po"], r["code"], r["qty"], r.get("doc_type", ""), r.get("doc_no", ""))


def backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = "WMS_puri09_%s.xlsx" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy2(MASTER, os.path.join(BACKUP_DIR, name))
    files = sorted((os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR) if f.startswith("WMS_") and f.endswith(".xlsx")),
                   key=os.path.getmtime)
    for old in files[:-KEEP_BACKUPS]:
        os.remove(old)
    return name


def split_doc(doc):
    """'3402-20261110002' -> ('3402', '20261110002')"""
    doc = norm(doc)
    if "-" in doc:
        a, b = doc.split("-", 1)
        return a.strip(), b.strip()
    return "", doc


def hist_columns(ws):
    by_header = {}
    for c in range(1, ws.max_column + 1):
        h = str(ws.cell(1, c).value or "").strip()
        if h:
            by_header[h] = c
    cols = {}
    for key, names in HIST_ALIASES.items():
        for a in names:
            if a in by_header:
                cols[key] = by_header[a]
                break
    return cols, [k for k in HIST_ALIASES if k not in cols]


def hist_last_row(ws, cols):
    for r in range(ws.max_row, 1, -1):
        if any(ws.cell(r, c).value not in (None, "") for c in cols.values()):
            return r
    return 1


def append_history(wb, entries, kind, when=None):
    """把 entries([{row資料, doc}])接在「進退貨履歷」最後。已有同一單據/採購單/品號/數量的列不重複寫。回傳寫入列數。"""
    ws = wb[HISTORY_SHEET]
    cols, missing = hist_columns(ws)
    if missing:
        raise ValueError("「%s」標題列缺少欄位: %s" % (HISTORY_SHEET, ",".join(HIST_ALIASES[k][0] for k in missing)))
    existing = set()
    last = hist_last_row(ws, cols)
    for r in range(2, last + 1):
        existing.add((norm(ws.cell(r, cols["kind"]).value),
                      norm(ws.cell(r, cols["doc_type"]).value), norm(ws.cell(r, cols["doc_no"]).value),
                      norm(ws.cell(r, cols["po"]).value), norm(ws.cell(r, cols["code"]).value),
                      qty_of(ws.cell(r, cols["qty"]).value)))
    today = when or datetime.date.today()
    n = 0
    for e in entries:
        dtype, dno = split_doc(e["doc"])
        key = (kind, dtype, dno, e["po"], e["code"], e["qty"])
        if dno and key in existing:
            continue
        last += 1
        c = ws.cell(last, cols["date"], today)
        c.number_format = "yyyy-mm-dd"
        values = {"kind": kind, "doc_type": dtype, "doc_no": dno, "vendor": e["vendor"], "po": e["po"],
                  "code": e["code"], "name": e["name"]}
        for k, v in values.items():
            cell = ws.cell(last, cols[k], v)
            cell.number_format = "@"   # 單別/單號/採購單這類數字開頭的文字,一律存成文字
        q = e["qty"]
        ws.cell(last, cols["qty"], int(q) if q == int(q) else q)
        existing.add(key)
        n += 1
    return n


def kind_arg(argv):
    kind = argv[argv.index("--kind") + 1] if "--kind" in argv else "進貨"
    return kind if kind in PROFILES else None


def cmd_read(argv):
    kind = kind_arg(argv)
    if not kind:
        return out({"ok": False, "error": "--kind 只能是 進貨 或 退貨"}, 1)
    prof = profile_of(kind)
    wb = openpyxl.load_workbook(MASTER, read_only=False, data_only=True)
    if prof["sheet"] not in wb.sheetnames:
        # 還沒有人退料過:「退料」工作表由網站的第一筆退料建立,視為空清單
        if kind == "退貨":
            with open(prof["snapshot"], "w", encoding="utf-8") as f:
                json.dump([], f)
            return out({"ok": True, "count": 0, "rows": []})
        return out({"ok": False, "error": "沒有工作表「%s」" % prof["sheet"]}, 1)
    ws = wb[prof["sheet"]]
    cols, missing = columns(ws, prof["aliases"])
    if missing:
        return out({"ok": False, "error": "「%s」標題列缺少欄位: %s" % (prof["sheet"], ",".join(missing))}, 1)
    rows = read_rows(ws, cols)
    with open(prof["snapshot"], "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    return out({"ok": True, "count": len(rows), "rows": rows})


def cmd_clear(argv):
    kind = kind_arg(argv)
    if not kind:
        return out({"ok": False, "error": "--kind 只能是 進貨 或 退貨"}, 1)
    prof = profile_of(kind)
    if excel_locked():
        return out({"ok": False, "error": "WMS.xlsx 目前被 Excel 開啟,未清除資料,請關閉後重跑「clear」"}, 3)
    try:
        with open(prof["snapshot"], encoding="utf-8") as f:
            snap = json.load(f)
    except Exception:
        return out({"ok": False, "error": "找不到快照,請先執行 read"}, 1)

    default_doc = argv[argv.index("--doc") + 1] if "--doc" in argv else ""
    doc_of = {}   # 「採購單」或「採購單|品號」 -> ERP 產生的單別-單號

    def doc_for(t):
        return doc_of.get(t["po"] + "|" + t["code"]) or doc_of.get(t["po"]) or default_doc

    fail_items = {}   # 「採購單」或「採購單|品號」 -> 失敗原因
    if "--fail" in argv:
        for item in argv[argv.index("--fail") + 1].split(";"):
            if not norm(item):
                continue
            key, _, reason = item.partition("=")
            fail_items[norm(key)] = norm(reason) or "原因不明"

    if "--all" in argv:
        targets = snap
    elif "--done" in argv:
        for item in argv[argv.index("--done") + 1].split(","):
            if not norm(item):
                continue
            key, _, doc = item.partition("=")
            doc_of[norm(key)] = norm(doc)
        targets = [r for r in snap if (r["po"] + "|" + r["code"]) in doc_of or (r["po"] and r["po"] in doc_of)]
    elif fail_items:
        targets = []   # 只標記失敗,沒有成功要清除的
    else:
        return out({"ok": False, "error": "請指定 --done <採購單=單據號,...> 或 --all --doc <單據號> 或 --fail <採購單=原因;...>"}, 1)

    wb = openpyxl.load_workbook(MASTER)
    if prof["sheet"] not in wb.sheetnames:
        return out({"ok": False, "error": "沒有工作表「%s」" % prof["sheet"]}, 1)
    ws = wb[prof["sheet"]]
    cols, missing = columns(ws, prof["aliases"])
    if missing:
        return out({"ok": False, "error": "「%s」標題列缺少欄位: %s" % (prof["sheet"], ",".join(missing))}, 1)

    cur = read_rows(ws, cols)
    used = set()
    del_rows = []
    entries = []
    for t in targets:  # 逐筆找目前工作表裡內容完全相同的那一列(只刪一列)
        for r in cur:
            if r["row"] in used:
                continue
            if row_identity(r) == row_identity(t):
                used.add(r["row"])
                del_rows.append(r["row"])
                entries.append({"vendor": r["vendor"], "po": r["po"], "code": r["code"], "name": r["name"],
                                "qty": r["qty"], "doc": doc_for(t)})
                break
    if entries and HISTORY_SHEET not in wb.sheetnames:
        return out({"ok": False, "error": "WMS.xlsx 沒有工作表「%s」,未清除資料" % HISTORY_SHEET}, 1)
    no_doc = [e["po"] or e["code"] for e in entries if not e["doc"]]
    bak = backup()
    recorded = 0
    if entries:
        try:
            recorded = append_history(wb, entries, kind)   # 先寫履歷;標題對不上就整個中止,清單資料不動
        except ValueError as ex:
            return out({"ok": False, "error": "%s,未清除資料" % ex}, 1)
    # 失敗 / 略過的列:在「狀態」欄寫「⚠ 失敗:原因」(紅字),列保留(要在刪列之前用目前的列號標記)
    marked = 0
    if fail_items:
        from openpyxl.styles import Font
        st = cols.get("status")
        if not st:
            st = ws.max_column + 1
            ws.cell(1, st).value = "狀態"
        for t in snap:
            reason = fail_items.get(t["po"] + "|" + t["code"]) or (fail_items.get(t["po"]) if t["po"] else None)
            if reason is None:
                continue
            for r in cur:
                if r["row"] in used:
                    continue   # 這一列是成功要清除的,不標記
                if row_identity(r) == row_identity(t):
                    c = ws.cell(r["row"], st)
                    c.value = "⚠ 失敗:" + reason
                    c.font = Font(color="FFFF0000")
                    marked += 1
                    break
    for r in sorted(del_rows, reverse=True):
        ws.delete_rows(r)
    wb.save(MASTER)
    drive_ok = True   # 一律複製到雲端硬碟同步資料夾(不必再手動跑 Run_Sync)
    try:
        os.makedirs(os.path.dirname(DRIVE), exist_ok=True)
        shutil.copy2(MASTER, DRIVE)
    except Exception:
        drive_ok = False
    left = len(read_rows(openpyxl.load_workbook(MASTER)[prof["sheet"]], cols))
    # 清除後立刻把最新(通常是空的)清單回報給網站,「簽核」清單才不會還顯示已處理的資料
    synced = False
    try:
        if "PURI09_MASTER" in os.environ:   # 測試用副本不回報給正式網站
            raise RuntimeError("test copy")
        cfg_path = os.path.join(HERE, "edit_config.json")
        with open(cfg_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        import receipt_snapshot
        synced = receipt_snapshot.report(cfg["endpoint"], cfg["syncKey"], MASTER, force=True, kind=prof["key"])
    except Exception:
        synced = False
    # 同時回報網站「進貨單簽核 / 退貨單簽核」按鈕的執行結果(原本要另外跑 puri09_queue.py report,漏掉時按鈕會卡在「執行中」)
    status_reported = False
    if "--no-report" not in argv and "PURI09_MASTER" not in os.environ:
        docs = sorted({d for d in doc_of.values() if d} | ({default_doc} if default_doc else set()))
        msg = "已建立並確認 %d 張%s單" % (len(docs), kind) + (":" + "、".join(docs) if docs else "")
        if fail_items:
            msg += ";%d 筆失敗(收料表已標 ⚠):" % len(fail_items) + ";".join("%s %s" % (k, v) for k, v in list(fail_items.items())[:5])
        try:
            cfg_path = os.path.join(HERE, "edit_config.json")
            with open(cfg_path, encoding="utf-8-sig") as f:
                cfg = json.load(f)
            import urllib.parse, urllib.request
            params = {"action": ("ret" if prof["key"] == "ret" else "puri09") + "_report", "key": cfg["syncKey"],
                      "state": "error" if fail_items else "done", "msg": msg[:300]}
            ep = cfg["endpoint"]
            with urllib.request.urlopen(ep + ("&" if "?" in ep else "?") + urllib.parse.urlencode(params), timeout=30) as resp:
                status_reported = bool(json.loads(resp.read().decode("utf-8")).get("ok"))
        except Exception:
            status_reported = False
    published = False
    if recorded and "PURI09_MASTER" not in os.environ:   # 履歷有新增:重新產生網站資料(網站退料鈕要查履歷),背景執行不等待
        try:
            script = os.path.join(HERE, "sync_and_publish.ps1")
            subprocess.Popen(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script],
                             creationflags=0x08000000)   # CREATE_NO_WINDOW
            published = True
        except Exception:
            published = False
    res = {"ok": True, "deleted": len(del_rows), "requested": len(targets), "remaining": left, "backup": bak,
           "history": recorded, "marked": marked, "driveCopied": drive_ok, "snapshotSynced": synced, "statusReported": status_reported, "sitePublishStarted": published}
    if no_doc:
        res["warning"] = "這些項目沒有指定單據號,履歷的單別/單號是空白: " + ",".join(no_doc)
    return out(res)


def cmd_sync():
    try:
        os.makedirs(os.path.dirname(DRIVE), exist_ok=True)
        shutil.copy2(MASTER, DRIVE)
    except Exception as ex:
        return out({"ok": False, "error": "複製到雲端硬碟失敗: %s" % ex}, 1)
    same = os.path.getsize(MASTER) == os.path.getsize(DRIVE)
    return out({"ok": same, "drive": DRIVE, "mtime": datetime.datetime.fromtimestamp(os.path.getmtime(DRIVE)).strftime("%Y-%m-%d %H:%M:%S")},
               0 if same else 1)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("read", "clear", "sync"):
        return out({"ok": False, "error": "用法: puri09_cleanup.py read | clear [--done <採購單=單據號,...>] [--fail <採購單=原因;...>] | clear --all --doc <單據號> | sync  (退貨加 --kind 退貨)"}, 2)
    try:
        if argv[1] == "read":
            return cmd_read(argv)
        if argv[1] == "clear":
            return cmd_clear(argv)
        return cmd_sync()
    except PermissionError as ex:
        return out({"ok": False, "error": "WMS.xlsx 無法讀寫(可能被開啟): %s" % ex}, 3)
    except Exception as ex:
        return out({"ok": False, "error": str(ex)}, 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
