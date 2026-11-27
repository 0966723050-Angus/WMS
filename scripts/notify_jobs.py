"""ERP 設定頁「通知」:依網站上的設定,到時間就檢查並用釘釘通知(2026-11-27 起)。

apply_edits.py(排程「WMS 儲位編輯寫入」每分鐘跑一次)pull 回來的 res["notify"] 交給 run()。
目前的通知項目:
  mfin 生產入庫:每週指定星期、時間(預設週一 14:00)之後的第一次檢查,
        找出「完全領料」的在線製令(製令所有物料的未領料量 = 需領用量 − 已領用量 都 ≤ 0),
        有的話發一則釘釘給設定的通知人員:「<姓名> 以下製令請開立生產入庫 / 專案代號 / 製令單別-單號」。
        沒有就不發。每個時段只做一次(notify_state.json 記錄),電腦當時沒開機的話,開機後同一週內補做。

單獨測試(只查、印出訊息,不發釘釘、不寫紀錄):
  python -I scripts\\notify_jobs.py --dry-run [--name 姓名]
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ERP_SQL_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "WMS", "WMS一鍵更新"))
STATE = os.path.join(HERE, "notify_state.json")


def _load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, STATE)


def due_slot(cfg, now):
    """最近一個已經到的時段(weekday:0=週日…6=週六,同網頁;time 'HH:MM')。沒設定好回 None。"""
    try:
        wd = int(cfg.get("weekday"))
        hh, mm = [int(x) for x in str(cfg.get("time") or "").split(":")]
    except Exception:
        return None
    if not (0 <= wd <= 6):
        return None
    py_wd = (wd - 1) % 7                     # Python:週一=0 … 週日=6
    days_back = (now.weekday() - py_wd) % 7
    slot = (now - datetime.timedelta(days=days_back)).replace(hour=hh, minute=mm, second=0, microsecond=0)
    if slot > now:                           # 今天就是那一天但還沒到時間 → 上一週的時段
        slot -= datetime.timedelta(days=7)
    return slot


def fully_issued_orders():
    """完全領料的在線製令:製令狀態 未生產/已領料/生產中、未作廢,有物料且每一行未領料量(需領用量 − 已領用量)都 ≤ 0。只做 SELECT。"""
    if ERP_SQL_DIR not in sys.path:
        sys.path.insert(0, ERP_SQL_DIR)
    import erp_sql
    sql = """SELECT TA001, TA002, TA551 FROM MOCTA WITH (NOLOCK)
             WHERE TA011 IN ('1','2','3') AND TA013 <> 'V'
               AND EXISTS (SELECT 1 FROM MOCTB WITH (NOLOCK) WHERE TB001 = TA001 AND TB002 = TA002)
               AND NOT EXISTS (SELECT 1 FROM MOCTB WITH (NOLOCK) WHERE TB001 = TA001 AND TB002 = TA002 AND TB004 - TB005 > 0)
             ORDER BY TA551, TA001, TA002"""
    assert sql.lstrip().startswith("SELECT "), "只允許 SELECT"
    cn = erp_sql.connect()
    try:
        cur = cn.cursor()
        cur.execute(sql)
        t = lambda v: ("" if v is None else str(v).strip())
        return [{"proj": t(r.TA551), "doc": "%s-%s" % (t(r.TA001), t(r.TA002))} for r in cur.fetchall()]
    finally:
        cn.close()


def build_mfin_text(name, orders):
    """使用者指定的格式:<姓名> 以下製令請開立生產入庫 / 專案代號: / 製令單別-單號:(每張製令一段)"""
    lines = ["%s 以下製令請開立生產入庫" % (name or "")]
    for o in orders:
        lines.append("")
        lines.append("專案代號：%s" % (o["proj"] or "(無)"))
        lines.append("製令單別-單號：%s" % o["doc"])
    return "\n".join(lines).strip()


def _report(endpoint, key, call, job, ok, n, msg, log):
    try:
        call(endpoint, {"action": "notify_report", "key": key, "job": job, "ok": "1" if ok else "0", "n": n, "msg": msg})
    except Exception as ex:
        log("通知:回報網站失敗:%s" % ex)


def run_mfin(endpoint, key, cfg_local, c, call, log):
    import dingtalk_notify
    orders = fully_issued_orders()
    if not orders:
        _report(endpoint, key, call, "mfin", True, 0, "沒有完全領料的在線製令,未發通知", log)
        log("通知 生產入庫:沒有完全領料的製令,未發通知")
        return True
    ok, why = dingtalk_notify.send_text(cfg_local, build_mfin_text(c.get("name"), orders))
    if not ok:
        _report(endpoint, key, call, "mfin", False, len(orders), "釘釘發送失敗:%s" % why, log)
        log("通知 生產入庫:釘釘發送失敗(下一輪再試):%s" % why)
        return False
    _report(endpoint, key, call, "mfin", True, len(orders), "已通知 %s:%d 張製令" % (c.get("name") or "", len(orders)), log)
    log("通知 生產入庫:已通知 %s,%d 張製令" % (c.get("name") or "", len(orders)))
    return True


JOBS = {"mfin": run_mfin}


def run(endpoint, key, cfg_local, notify, call, log=print, now=None):
    """notify = pull 回來的 res["notify"]。到時段且這個時段還沒做過才執行;設定是在時段之後才存的就不補做。"""
    if not isinstance(notify, dict) or not notify:
        return
    now = now or datetime.datetime.now()
    st = _load_state()
    changed = False
    for job, c in notify.items():
        fn = JOBS.get(job)
        if not fn or not isinstance(c, dict) or not c.get("enabled") or not c.get("email"):
            continue
        slot = due_slot(c, now)
        if slot is None:
            continue
        slot_key = slot.strftime("%Y-%m-%d %H:%M")
        if st.get(job) and st[job] >= slot_key:
            continue
        if slot.timestamp() * 1000 < float(c.get("updatedAt") or 0):
            st[job] = slot_key   # 設定在這個時段之後才儲存:不補做,從下一個時段開始
            changed = True
            continue
        try:
            done = fn(endpoint, key, cfg_local, c, call, log)
        except Exception as ex:
            log("通知 %s 執行失敗(下一輪再試):%s" % (job, ex))
            _report(endpoint, key, call, job, False, 0, "執行失敗:%s" % str(ex)[:150], log)
            done = False
        if done:
            st[job] = slot_key
            changed = True
    if changed:
        _save_state(st)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if "--dry-run" in sys.argv:
        name = sys.argv[sys.argv.index("--name") + 1] if "--name" in sys.argv else "(通知人員)"
        orders = fully_issued_orders()
        print("完全領料的在線製令:%d 張" % len(orders))
        print("----- 釘釘訊息預覽 -----")
        print(build_mfin_text(name, orders) if orders else "(沒有,不會發通知)")
        for wd, tm in ((1, "14:00"),):
            print("----- 時段計算(週一 14:00)-----")
            print("現在 %s → 最近時段 %s" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
                                         due_slot({"weekday": wd, "time": tm}, datetime.datetime.now()).strftime("%Y-%m-%d %H:%M (%a)")))
