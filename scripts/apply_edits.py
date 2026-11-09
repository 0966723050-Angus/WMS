"""把網頁送出的資料寫回 WMS.xlsx:(1)「庫存查詢」的編輯(類別/儲放地點/儲位)-> 「庫存物料」工作表 E~G 欄;(2)物料卡片的「收料」-> 「收料」工作表,逐列接在既有資料後面。

流程:向 Apps Script 中繼取回待處理修改 -> 備份 -> 寫入主檔 -> 複製到雲端硬碟 -> 回報已處理。
有寫入時結束代碼為 10(讓排程接著重新產生 data.json 並發布),沒有事做為 0,失敗為 1。
設定檔 edit_config.json(不進版控):{"endpoint": "<Apps Script /exec 網址>", "syncKey": "<SYNC_KEY>"}
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
# 排程用 `python -I` 執行(隔離模式不會把本資料夾放進模組搜尋路徑),要明確加入才找得到同資料夾的 receipt_snapshot 等模組
sys.path.insert(0, HERE)
DEFAULT_CONFIG = os.path.join(HERE, "edit_config.json")
DEFAULT_MASTER = r"C:\ATK\Project\AI Agent\WMS\WMS.xlsx"
DEFAULT_DRIVE_COPY = r"C:\Users\angus.ad\我的雲端硬碟\ATK\WMS.xlsx"
BACKUP_DIR = os.path.join(HERE, "backup")
LOG_FILE = os.path.join(HERE, "apply_edits.log")
KEEP_BACKUPS = 20

SHEET = "庫存物料"
HEADERS = ["材料品號", "品名", "規格", "庫存數量", "類別", "儲放地點", "儲位"]
EXIT_APPLIED = 10


def log(msg):
    line = "[%s] %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line)


def norm(v):
    return " ".join(("" if v is None else str(v)).split())[:200]


def num_str(v):
    s = ("" if v is None else str(v)).strip()
    try:
        return str(float(s))
    except ValueError:
        return s


def call(endpoint, params):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
    last = None
    # Apps Script 偶爾會回傳 HTML 而不是 JSON,重試幾次
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as ex:
            last = ex
            time.sleep(2)
    raise last


WMS_TASK = "WMS 自動更新"


def wms_task_running():
    """排程「WMS 自動更新」目前是否在執行中。"""
    out = subprocess.run(["schtasks", "/query", "/tn", WMS_TASK, "/fo", "csv", "/nh"],
                         capture_output=True, text=True, encoding="mbcs", errors="replace")
    return out.returncode == 0 and ('"Running"' in out.stdout or '"執行中"' in out.stdout)


def wms_task_last_run():
    """排程「WMS 自動更新」的上次執行時間(字串,只用來比較前後是否改變)。"""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "(Get-ScheduledTaskInfo -TaskName '%s').LastRunTime.Ticks" % WMS_TASK],
        capture_output=True, text=True, encoding="mbcs", errors="replace")
    return out.stdout.strip()


def start_wms_update(endpoint, sync_key, req):
    """網頁管理者按了「WMS更新」:啟動排程「WMS 自動更新」(schedule_wms.ps1),並回報狀態。
    schedule_wms.ps1 自己會回報 running / done / error;這裡只負責啟動,啟動失敗才回報 error。"""
    log("收到 WMS 更新請求(%s)" % req.get("by"))
    try:
        if wms_task_running():
            log("WMS 自動更新已在執行中,請求視為已處理")
            call(endpoint, {"action": "wms_report", "key": sync_key, "state": "running", "msg": "已在執行中"})
            return
        before = wms_task_last_run()
        out = subprocess.run(["schtasks", "/run", "/tn", WMS_TASK], capture_output=True, text=True, encoding="mbcs", errors="replace")
        if out.returncode != 0:
            raise RuntimeError((out.stderr or out.stdout).strip())
        # schtasks /run 只代表「已送出」;排程可能因帳號未登入等原因被工作排程器拒絕,
        # 所以等幾秒確認上次執行時間有更新,才算真的啟動
        for _ in range(6):
            time.sleep(5)
            if wms_task_last_run() != before:
                break
        else:
            raise RuntimeError("工作排程器未啟動排程(請檢查排程的執行帳號是否為目前登入的使用者)")
        log("已啟動排程「%s」" % WMS_TASK)
        call(endpoint, {"action": "wms_report", "key": sync_key, "state": "running", "msg": "已啟動"})
    except Exception as ex:
        log("啟動 WMS 更新失敗: %s" % ex)
        try:
            call(endpoint, {"action": "wms_report", "key": sync_key, "state": "error", "msg": "啟動失敗: %s" % str(ex)[:150]})
        except Exception:
            pass


# ---------- 自動執行排程(網頁 ERP 頁「設定」) ----------
# 設定存在 Apps Script,每次 pull 一併取回:{job: {enabled, start, end, interval, skipSat, skipSun, updatedAt}}
# 每天 start 起每 interval 分鐘一個時段,到 end 為止;本程式每 5 分鐘執行一次,
# 遇到「目前所在時段」還沒執行過就啟動。已執行的時段記在 schedule_state.json。

SCHED_STATE = os.path.join(HERE, "schedule_state.json")
SCHED_GRACE_MIN = 10  # 結束時間後仍可補跑最後一個時段的寬限分鐘數


def ticks_to_datetime(ticks):
    try:
        return datetime.datetime(1, 1, 1) + datetime.timedelta(microseconds=int(ticks) // 10)
    except (TypeError, ValueError):
        return None


# 每個可排程的執行鍵:啟動函式,以及取得「上次實際執行時間」的函式(用來避免剛跑完又重跑)
SCHED_JOBS = {
    "wms": {"start": lambda ep, key, by: start_wms_update(ep, key, {"by": by}),
            "last_run": lambda: ticks_to_datetime(wms_task_last_run())},
}


def current_slot(cfg, now):
    """回傳 now 所在的時段起點(datetime);不在今天的時間區間內則回傳 None。"""
    try:
        sh, sm = [int(x) for x in cfg["start"].split(":")]
        eh, em = [int(x) for x in cfg["end"].split(":")]
        interval = int(cfg["interval"])
    except (KeyError, ValueError, AttributeError):
        return None
    if interval < 30:
        return None
    start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    end = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if now < start or end <= start or now > end + datetime.timedelta(minutes=SCHED_GRACE_MIN):
        return None
    k = int((min(now, end) - start).total_seconds() // (interval * 60))
    return start + datetime.timedelta(minutes=k * interval)


def run_due_schedules(endpoint, sync_key, schedules):
    try:
        with open(SCHED_STATE, encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        state = {}
    now = datetime.datetime.now()
    changed = False
    for job, cfg in schedules.items():
        spec = SCHED_JOBS.get(job)
        if not spec or not isinstance(cfg, dict) or not cfg.get("enabled"):
            continue
        if (now.weekday() == 5 and cfg.get("skipSat")) or (now.weekday() == 6 and cfg.get("skipSun")):
            continue  # 設定為週六 / 週日不執行
        slot = current_slot(cfg, now)
        if slot is None:
            continue
        slot_key = slot.strftime("%Y-%m-%d %H:%M")
        if state.get(job) == slot_key:
            continue
        state[job] = slot_key
        changed = True
        # 設定是在這個時段開始之後才儲存的:不補跑,等下一個時段
        if slot.timestamp() * 1000 < float(cfg.get("updatedAt") or 0):
            continue
        last = spec["last_run"]()
        if last and last >= slot:
            log("排程 %s %s:此時段已執行過(%s),略過" % (job, slot_key, last.strftime("%H:%M")))
            continue
        log("排程 %s 到了執行時段 %s" % (job, slot_key))
        spec["start"](endpoint, sync_key, "自動排程 %s" % slot.strftime("%H:%M"))
    if changed:
        with open(SCHED_STATE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)


def row_matches(ws, r, e):
    return (
        str(ws.cell(r, 1).value or "").strip() == e["code"]
        and norm(ws.cell(r, 2).value) == norm(e.get("name"))
        and norm(ws.cell(r, 3).value) == norm(e.get("spec"))
    )


def locate(ws, e):
    """依列號驗證;列號對不上時,用品號+品名+規格(+庫存數量)重新找,找不到唯一一列就放棄。"""
    r = e.get("row")
    if isinstance(r, int) and 2 <= r <= ws.max_row and row_matches(ws, r, e):
        return r
    cands = [i for i in range(2, ws.max_row + 1) if row_matches(ws, i, e)]
    if len(cands) > 1 and e.get("stock") not in (None, ""):
        cands = [i for i in cands if num_str(ws.cell(i, 4).value) == num_str(e["stock"])]
    return cands[0] if len(cands) == 1 else None


def set_text(cell, v):
    v = (v or "").strip()
    if not v:
        cell.value = None
        return
    cell.value = v
    cell.data_type = "s"  # 以 = + - @ 開頭的文字也要當一般文字,不能被當成公式


RECEIPT_SHEET = "收料"
RECEIPT_HEADERS = ["日期", "廠商", "採購單號", "品號", "品名", "數量"]
# 標題列可接受的別名(第一個是新建工作表時使用的名稱)
RECEIPT_ALIASES = {
    "日期": ["日期"],
    "廠商": ["廠商", "廠商簡稱"],
    "採購單號": ["採購單號", "採購單別-單號-序號", "採購單別單號序號", "採購單"],
    "品號": ["品號", "材料品號"],
    "品名": ["品名"],
    "數量": ["數量", "收料數量", "進貨數量"],
}


def load_receipts_done(path):
    try:
        with open(path, encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()


def remember_receipts(path, ids):
    """記下已寫入主檔的收料 id,萬一回報中繼失敗,下次不會重複寫入同一筆。"""
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
    except Exception:
        old = []
    merged = (old + [i for i in ids if i not in old])[-2000:]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f)


def apply_receipts(wb, receipts, state_path):
    """把網頁送出的收料,逐列接在「收料」工作表既有資料後面(不覆蓋原有資料)。
    欄位依第 1 列標題名稱對應:日期、廠商、採購單號、品號、品名、數量。
    回傳 (已寫入, 未處理, 重複略過)。"""
    if RECEIPT_SHEET not in wb.sheetnames:
        ws = wb.create_sheet(RECEIPT_SHEET)
        ws.append(RECEIPT_HEADERS)
        log("主檔沒有工作表「%s」,已建立" % RECEIPT_SHEET)
    ws = wb[RECEIPT_SHEET]

    # 第 1 列標題 -> 欄號;「收料」表的標題可能被使用者改名,所以每個欄位接受幾種寫法(例如 ERP 進貨用的「採購單別-單號-序號」)
    by_header = {}
    for c in range(1, ws.max_column + 1):
        h = str(ws.cell(1, c).value or "").strip()
        if h:
            by_header[h] = c
    col_of = {}
    for name in RECEIPT_HEADERS:
        for alias in RECEIPT_ALIASES.get(name, [name]):
            if alias in by_header:
                col_of[name] = by_header[alias]
                break
    missing = [h for h in RECEIPT_HEADERS if h not in col_of]
    if missing:
        log("工作表「%s」標題列缺少欄位 %s,收料留待處理" % (RECEIPT_SHEET, "、".join(missing)))
        return [], list(receipts), []

    last = 1
    for r in range(ws.max_row, 1, -1):
        if any(ws.cell(r, c).value not in (None, "") for c in col_of.values()):
            last = r
            break

    done_ids = load_receipts_done(state_path)
    done, skipped = [], []
    for rec in sorted(receipts, key=lambda x: x.get("ts", 0)):
        if rec.get("id") in done_ids:
            skipped.append(rec)
            continue
        last += 1
        when = datetime.datetime.fromtimestamp(rec.get("ts", time.time() * 1000) / 1000)
        c = ws.cell(last, col_of["日期"], when.date())
        c.number_format = "yyyy-mm-dd"
        set_text(ws.cell(last, col_of["廠商"]), rec.get("vendor"))
        set_text(ws.cell(last, col_of["採購單號"]), rec.get("po"))
        set_text(ws.cell(last, col_of["品號"]), rec.get("code"))
        set_text(ws.cell(last, col_of["品名"]), rec.get("name"))
        qty = float(rec.get("qty") or 0)
        ws.cell(last, col_of["數量"], int(qty) if qty == int(qty) else qty)
        done.append(rec)
        log("收料已寫入第 %d 列: %s 採購單 %s 品號 %s 數量 %s" % (last, rec.get("vendor"), rec.get("po"), rec.get("code"), rec.get("qty")))
    return done, [], skipped


def backup(master, backup_dir):
    os.makedirs(backup_dir, exist_ok=True)
    name = "WMS_%s.xlsx" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    shutil.copy2(master, os.path.join(backup_dir, name))
    files = sorted(
        (os.path.join(backup_dir, f) for f in os.listdir(backup_dir) if f.startswith("WMS_") and f.endswith(".xlsx")),
        key=os.path.getmtime,
    )
    for old in files[:-KEEP_BACKUPS]:
        os.remove(old)


def main():
    global LOG_FILE
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--master", default=DEFAULT_MASTER)
    ap.add_argument("--drive-copy", default=DEFAULT_DRIVE_COPY)
    ap.add_argument("--backup-dir", default=BACKUP_DIR)
    ap.add_argument("--log", default=LOG_FILE)
    args = ap.parse_args()
    LOG_FILE = args.log

    if not os.path.exists(args.config):
        log("尚未設定 %s,略過" % os.path.basename(args.config))
        return 0
    with open(args.config, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    endpoint, sync_key = cfg.get("endpoint", ""), cfg.get("syncKey", "")
    if not endpoint or not sync_key:
        log("edit_config.json 缺少 endpoint 或 syncKey,略過")
        return 0

    try:
        res = call(endpoint, {"action": "pull", "key": sync_key})
    except Exception as ex:
        log("取回待處理修改失敗: %s" % ex)
        return 1
    if not res.get("ok"):
        log("中繼回應錯誤: %s" % res.get("error"))
        return 1
    edits = res.get("edits", [])
    receipts = res.get("receipts", [])
    if res.get("wms"):
        start_wms_update(endpoint, sync_key, res["wms"])
    if res.get("schedules"):
        run_due_schedules(endpoint, sync_key, res["schedules"])
    # 「收料」工作表內容有變動(例如使用者自己編輯/清除)就回報給網站,供「進貨單簽核」清單使用;沒變動不重送
    try:
        import receipt_snapshot
        receipt_snapshot.report(endpoint, sync_key, args.master)
    except Exception as ex:
        log("警告: 回報收料清單快照失敗: %s" % ex)
    if not edits and not receipts:
        return 0

    master_dir, master_name = os.path.split(args.master)
    if os.path.exists(os.path.join(master_dir, "~$" + master_name)):
        log("主檔目前被 Excel 開啟,%d 筆修改、%d 筆收料留待下次處理" % (len(edits), len(receipts)))
        return 0

    state_path = os.path.join(os.path.dirname(args.log) or HERE, "receipts_done.json")
    done, failed = [], []
    r_done, r_failed, r_skipped = [], [], []
    try:
        backup(args.master, args.backup_dir)
        wb = openpyxl.load_workbook(args.master)

        if edits:
            if SHEET not in wb.sheetnames:
                log("主檔沒有工作表「%s」,中止" % SHEET)
                return 1
            ws = wb[SHEET]
            header = [str(ws.cell(1, c).value or "").strip() for c in range(1, 8)]
            if header != HEADERS:
                log("工作表「%s」標題列不符,中止: %s" % (SHEET, header))
                return 1

            for e in sorted(edits, key=lambda x: x.get("ts", 0)):
                r = locate(ws, e)
                if r is None:
                    failed.append(e)
                    log("找不到對應列,略過: %s (%s) 原列號 %s" % (e.get("code"), norm(e.get("name")), e.get("row")))
                    continue
                set_text(ws.cell(r, 5), e.get("category"))
                set_text(ws.cell(r, 6), e.get("location"))
                set_text(ws.cell(r, 7), e.get("bin"))
                done.append(e)
                log("已寫入第 %d 列 %s: 類別=%s 儲放地點=%s 儲位=%s" % (r, e["code"], e.get("category"), e.get("location"), e.get("bin")))

        if receipts:
            r_done, r_failed, r_skipped = apply_receipts(wb, receipts, state_path)

        if done or r_done:
            wb.save(args.master)
            if r_done:
                remember_receipts(state_path, [x["id"] for x in r_done])
            try:
                shutil.copy2(args.master, args.drive_copy)
            except Exception as ex:
                log("警告: 已寫入主檔,但複製到雲端硬碟失敗(下次 WMS 更新時會一併複製): %s" % ex)
            if r_done:  # 收料寫進「收料」表了:馬上回報最新清單(在 ack 之前,清單不會暫時少一筆)
                try:
                    import receipt_snapshot
                    receipt_snapshot.report(endpoint, sync_key, args.master, force=True)
                except Exception as ex:
                    log("警告: 回報收料清單快照失敗: %s" % ex)
    except PermissionError as ex:
        log("主檔無法寫入(可能被開啟),留待下次處理: %s" % ex)
        return 0
    except Exception as ex:
        log("處理失敗: %s" % ex)
        return 1

    ids = [e["id"] for e in done + failed + r_done + r_skipped if e.get("id")]
    if ids:
        try:
            call(endpoint, {"action": "ack", "key": sync_key, "ids": ",".join(ids)})
        except Exception as ex:
            log("警告: 回報已處理失敗,下次可能重複處理(儲位修改內容相同不影響;收料已用 receipts_done.json 防重複): %s" % ex)

    log("完成: 儲位修改 寫入 %d 筆,略過 %d 筆;收料 寫入 %d 筆,重複略過 %d 筆,未處理 %d 筆"
        % (len(done), len(failed), len(r_done), len(r_skipped), len(r_failed)))
    return EXIT_APPLIED if done else 0


if __name__ == "__main__":
    sys.exit(main())
