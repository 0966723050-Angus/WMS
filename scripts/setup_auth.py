"""產生資料加密金鑰並上傳到 Apps Script(DATA_KEY),同時存成本機 scripts/auth_config.json。

首次啟用加密:  python scripts/setup_auth.py
更換金鑰(例如有人離職):  python scripts/setup_auth.py --rotate   ,之後重新產生資料並發布
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def call(endpoint, params):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
    last = None
    for _ in range(3):  # Apps Script 偶爾回傳 HTML,重試
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as ex:
            last = ex
            time.sleep(2)
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rotate", action="store_true", help="已有金鑰時強制更換")
    ap.add_argument("--edit-config", default=os.path.join(HERE, "edit_config.json"))
    ap.add_argument("--auth-config", default=os.path.join(HERE, "auth_config.json"))
    args = ap.parse_args()

    if os.path.exists(args.auth_config) and not args.rotate:
        print("auth_config.json 已存在;要更換金鑰請加 --rotate")
        return 0

    with open(args.edit_config, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    key = base64.b64encode(os.urandom(32)).decode("ascii")

    res = call(cfg["endpoint"], {"action": "set_data_key", "key": cfg["syncKey"], "dataKey": key})
    if not res.get("ok"):
        print("上傳金鑰失敗:", res.get("error"))
        return 1

    with open(args.auth_config, "w", encoding="utf-8") as f:
        json.dump({"dataKey": key}, f)
    print("已產生並上傳金鑰,已寫入", args.auth_config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
