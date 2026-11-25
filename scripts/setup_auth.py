"""資料加密金鑰(dataKey / costKey)的本機副本,存在 scripts/auth_config.json(不進版控)。

金鑰由 Apps Script 保管(DATA_KEY / COST_KEY):管理者在網站停用、刪除帳號或拿掉「庫存單位成本」權限時,
伺服器會自動換新金鑰(Claude Security F2 / F6 / F7)。本機只負責取回目前的金鑰,用它加密 data.enc / cost.enc。

  python scripts/setup_auth.py            首次設定:伺服器還沒有金鑰就產生,並寫入 auth_config.json
  python scripts/setup_auth.py --sync     向伺服器取回目前金鑰,和 auth_config.json 不同就更新
                                          (結束代碼 0=沒變、10=已更新需要重新發布、1=取不到金鑰)
  python scripts/setup_auth.py --rotate   手動更換金鑰(例如直接在指令碼屬性改過名單),排程約 1 分鐘內自動重新發布
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
FIELDS = ("dataKey", "costKey")


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


def valid_key(k):
    try:
        return isinstance(k, str) and len(base64.b64decode(k, validate=True)) == 32
    except Exception:
        return False


def read_json(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def write_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def fetch_keys(cfg, action="get_keys"):
    res = call(cfg["endpoint"], {"action": action, "key": cfg["syncKey"]})
    if not res.get("ok"):
        raise RuntimeError("中繼回應錯誤: %s" % res.get("error"))
    if not valid_key(res.get("dataKey")):
        raise RuntimeError("中繼沒有有效的 DATA_KEY(新版 Code.gs 是否已部署?)")
    keys = {"dataKey": res["dataKey"]}
    if res.get("costKey"):
        if not valid_key(res["costKey"]):
            raise RuntimeError("中繼的 COST_KEY 格式不正確")
        keys["costKey"] = res["costKey"]
    return keys


def save_keys(path, keys):
    """更新 auth_config.json 的金鑰欄位(保留其他欄位);回傳是否有變。"""
    cur = read_json(path)
    new = {k: v for k, v in cur.items() if k not in FIELDS}
    new.update(keys)
    if new == cur:
        return False
    write_atomic(path, new)
    return True


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--sync", action="store_true", help="向伺服器取回目前金鑰")
    g.add_argument("--rotate", action="store_true", help="手動更換金鑰")
    ap.add_argument("--edit-config", default=os.path.join(HERE, "edit_config.json"))
    ap.add_argument("--auth-config", default=os.path.join(HERE, "auth_config.json"))
    args = ap.parse_args()

    with open(args.edit_config, encoding="utf-8-sig") as f:
        cfg = json.load(f)

    try:
        if args.rotate:
            keys = fetch_keys(cfg, "rotate_keys")
        else:
            try:
                keys = fetch_keys(cfg)
            except RuntimeError as ex:
                if args.sync or "DATA_KEY" not in str(ex):
                    raise
                keys = fetch_keys(cfg, "rotate_keys")   # 首次設定:伺服器還沒有金鑰
    except Exception as ex:
        print("取不到目前的資料金鑰:", ex)
        return 1

    if args.rotate:
        # 不在這裡寫 auth_config.json:讓排程的 --sync 看到金鑰變了,自動重新加密發布
        print("已在伺服器更換金鑰;排程約 1 分鐘內會取回新金鑰並重新發布 data.enc / cost.enc")
        return 0
    changed = save_keys(args.auth_config, keys)
    if args.sync:
        if changed:
            print("資料金鑰已更換,已更新 auth_config.json,需要重新發布")
        return 10 if changed else 0
    print("已取得金鑰並寫入 %s%s" % (args.auth_config,
                              "" if "costKey" in keys else "(伺服器沒有 COST_KEY,不會輸出 cost.enc)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
