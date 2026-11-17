r"""把 ERP 查詢(製令/製令變更/採購單/採購變更)的結果回傳網站。

用法:
  python -I scripts\erpq_result.py --id <查詢id> --file <結果.json>
      結果.json:{"cols": ["製令單別", "製令單號", ...], "rows": [["5101", "20261030001", ...], ...], "msg": "選填說明"}
      (也接受 rows 為物件陣列:[{"製令單別": "5101", ...}],會依 cols 順序轉成陣列;沒給 cols 就用第一列的鍵)
  python -I scripts\erpq_result.py --id <查詢id> --fail "<原因>"
設定檔 scripts\edit_config.json(endpoint / syncKey)。
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "edit_config.json")


def post(endpoint, payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, headers={"Content-Type": "text/plain; charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main(argv):
    if "--id" not in argv:
        print(__doc__)
        return 2
    qid = argv[argv.index("--id") + 1]
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    endpoint = cfg["endpoint"]
    if "--endpoint" in argv:   # 測試用
        endpoint = argv[argv.index("--endpoint") + 1]
    payload = {"action": "erpq_result", "key": cfg["syncKey"], "id": qid}
    if "--fail" in argv:
        payload.update(ok=False, msg=argv[argv.index("--fail") + 1])
    else:
        with open(argv[argv.index("--file") + 1], encoding="utf-8-sig") as f:
            res = json.load(f)
        cols = list(res.get("cols") or [])
        rows = res.get("rows") or []
        if rows and isinstance(rows[0], dict):
            if not cols:
                cols = list(rows[0].keys())
            rows = [[r.get(c, "") for c in cols] for r in rows]
        payload.update(ok=True, cols=cols, rows=rows, msg=res.get("msg", ""))
    out = post(endpoint, payload)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
