"""puri09 skill 的收料資料工具:讀取 / 清除「收料」工作表,並把 WMS.xlsx 同步到雲端硬碟。

    python -I puri09_cleanup.py read
        讀「收料」工作表第 2 列起的資料列,印成 JSON 清單,並存一份快照(puri09_snapshot.json)。
    python -I puri09_cleanup.py clear --done "3303-20261102004-0001,3303-...-0002"
        只清除「已成功建立進貨單」的列(以採購單別-單號-序號比對快照),建立失敗/略過的列保留。
        快照之後才新增的收料(網站又送了新的)不會被動到。清除前會先備份 WMS.xlsx。
    python -I puri09_cleanup.py clear --all
        清除快照內所有列(全部都成功時使用)。
    python -I puri09_cleanup.py sync
        把 WMS.xlsx 複製到雲端硬碟同步資料夾。

結束代碼:0 成功;3 WMS.xlsx 被 Excel 開啟(未動);1 其他錯誤。輸出一律是一行 JSON。
"""
import datetime
import json
import os
import shutil
import sys

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
# 環境變數 PURI09_MASTER / PURI09_DRIVE / PURI09_DIR 只在測試時用來改指向副本
MASTER = os.environ.get("PURI09_MASTER", r"C:\ATK\Project\AI Agent\WMS\WMS.xlsx")
DRIVE = os.environ.get("PURI09_DRIVE", r"C:\Users\angus.ad\我的雲端硬碟\ATK\WMS.xlsx")
_WORK = os.environ.get("PURI09_DIR", HERE)
BACKUP_DIR = os.path.join(_WORK, "backup")
SNAPSHOT = os.path.join(_WORK, "puri09_snapshot.json")
SHEET = "收料"
KEEP_BACKUPS = 20

# 標題列可接受的寫法(和 apply_edits.py 一致)
ALIASES = {
    "date": ["日期"],
    "vendor": ["廠商", "廠商簡稱"],
    "po": ["採購單號", "採購單別-單號-序號", "採購單別單號序號", "採購單"],
    "code": ["品號", "材料品號"],
    "name": ["品名"],
    "qty": ["數量", "收料數量", "進貨數量"],
}


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


def columns(ws):
    by_header = {}
    for c in range(1, ws.max_column + 1):
        h = str(ws.cell(1, c).value or "").strip()
        if h:
            by_header[h] = c
    cols = {}
    for key, names in ALIASES.items():
        for a in names:
            if a in by_header:
                cols[key] = by_header[a]
                break
    missing = [k for k in ALIASES if k not in cols]
    return cols, missing


def read_rows(ws, cols):
    rows = []
    for r in range(2, ws.max_row + 1):
        vals = {k: ws.cell(r, c).value for k, c in cols.items()}
        if all(v in (None, "") for v in vals.values()):
            continue
        rows.append({
            "row": r,
            "vendor": norm(vals["vendor"]), "po": norm(vals["po"]), "code": norm(vals["code"]),
            "name": norm(vals["name"]), "qty": qty_of(vals["qty"]),
            "date": vals["date"].strftime("%Y-%m-%d") if hasattr(vals["date"], "strftime") else norm(vals["date"]),
        })
    return rows


def backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = "WMS_puri09_%s.xlsx" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy2(MASTER, os.path.join(BACKUP_DIR, name))
    files = sorted((os.path.join(BACKUP_DIR, f) for f in os.listdir(BACKUP_DIR) if f.startswith("WMS_") and f.endswith(".xlsx")),
                   key=os.path.getmtime)
    for old in files[:-KEEP_BACKUPS]:
        os.remove(old)
    return name


def cmd_read():
    wb = openpyxl.load_workbook(MASTER, read_only=False, data_only=True)
    if SHEET not in wb.sheetnames:
        return out({"ok": False, "error": "沒有工作表「%s」" % SHEET}, 1)
    ws = wb[SHEET]
    cols, missing = columns(ws)
    if missing:
        return out({"ok": False, "error": "「%s」標題列缺少欄位: %s" % (SHEET, ",".join(missing))}, 1)
    rows = read_rows(ws, cols)
    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    return out({"ok": True, "count": len(rows), "rows": rows})


def cmd_clear(argv):
    if excel_locked():
        return out({"ok": False, "error": "WMS.xlsx 目前被 Excel 開啟,未清除收料資料,請關閉後重跑「clear」"}, 3)
    try:
        with open(SNAPSHOT, encoding="utf-8") as f:
            snap = json.load(f)
    except Exception:
        return out({"ok": False, "error": "找不到快照,請先執行 read"}, 1)

    if "--all" in argv:
        targets = snap
    elif "--done" in argv:
        done = {norm(p) for p in argv[argv.index("--done") + 1].split(",") if norm(p)}
        targets = [r for r in snap if r["po"] in done]
    else:
        return out({"ok": False, "error": "請指定 --done <採購單列表> 或 --all"}, 1)

    wb = openpyxl.load_workbook(MASTER)
    ws = wb[SHEET]
    cols, missing = columns(ws)
    if missing:
        return out({"ok": False, "error": "「%s」標題列缺少欄位: %s" % (SHEET, ",".join(missing))}, 1)

    cur = read_rows(ws, cols)
    used = set()
    del_rows = []
    for t in targets:  # 逐筆找目前工作表裡內容完全相同的那一列(只刪一列)
        for r in cur:
            if r["row"] in used:
                continue
            if (r["vendor"], r["po"], r["code"], r["qty"]) == (t["vendor"], t["po"], t["code"], t["qty"]):
                used.add(r["row"])
                del_rows.append(r["row"])
                break
    bak = backup()
    for r in sorted(del_rows, reverse=True):
        ws.delete_rows(r)
    wb.save(MASTER)
    left = len(read_rows(openpyxl.load_workbook(MASTER)[SHEET], cols))
    # 清除後立刻把最新(通常是空的)清單回報給網站,「進貨單簽核」才不會還顯示已處理的資料
    synced = False
    try:
        cfg_path = os.path.join(HERE, "edit_config.json")
        with open(cfg_path, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        import receipt_snapshot
        synced = receipt_snapshot.report(cfg["endpoint"], cfg["syncKey"], MASTER, force=True)
    except Exception:
        synced = False
    return out({"ok": True, "deleted": len(del_rows), "requested": len(targets), "remaining": left, "backup": bak,
                "snapshotSynced": synced})


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
        return out({"ok": False, "error": "用法: puri09_cleanup.py read | clear --done <採購單,...> | clear --all | sync"}, 2)
    try:
        if argv[1] == "read":
            return cmd_read()
        if argv[1] == "clear":
            return cmd_clear(argv)
        return cmd_sync()
    except PermissionError as ex:
        return out({"ok": False, "error": "WMS.xlsx 無法讀寫(可能被開啟): %s" % ex}, 3)
    except Exception as ex:
        return out({"ok": False, "error": str(ex)}, 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
