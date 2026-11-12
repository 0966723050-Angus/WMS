import argparse
import base64
import datetime
import hashlib
import hmac
import json
import os
import zlib

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = r"C:\Users\angus.ad\我的雲端硬碟\ATK\WMS.xlsx"
OUT_DIR = os.path.dirname(HERE)
# 存在此設定檔(內含 dataKey)就輸出加密的 data.enc;否則維持輸出明文 data.json
AUTH_CONFIG = os.path.join(HERE, "auth_config.json")
# 表單名稱 <-> 程式代碼對照表(網站「待簽核表單」頁的下拉選單用;使用者維護這個檔案)
FORMS_XLSX = os.environ.get("SIGN_FORMS_XLSX", r"C:\ATK\Project\AI Agent\ERP\表單與程式碼對照表.xlsx")


def load_data_key(path):
    with open(path, encoding="utf-8-sig") as f:
        key = base64.b64decode(json.load(f)["dataKey"])
    if len(key) != 32:
        raise ValueError("dataKey 必須是 32 bytes(base64)")
    return key


def encrypt_payload(plain, key):
    """壓縮後以 AES-256-GCM 加密。格式: nonce(12) + 密文 + tag(16)。
    nonce 由內容與金鑰的 HMAC 決定:資料沒變時輸出完全相同,排程不會每次都產生新 commit。"""
    from Crypto.Cipher import AES  # pycryptodome

    packed = zlib.compress(plain, 9)
    nonce = hmac.new(key, packed, hashlib.sha256).digest()[:12]
    ct, tag = AES.new(key, AES.MODE_GCM, nonce=nonce).encrypt_and_digest(packed)
    return nonce + ct + tag


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def norm(v):
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    return v


def split_lines(v):
    if v is None:
        return []
    s = str(v)
    return [p.strip() for p in s.split("\n")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--out-dir", default=OUT_DIR)
    ap.add_argument("--auth-config", default=AUTH_CONFIG)
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.src, data_only=True)

    ws1 = wb["在線製令一覽表"]
    ws2 = wb["在線製令物料明細"]

    projects = {}
    project_order = []
    order_index = {}

    for row in ws1.iter_rows(min_row=2, values_only=True):
        if not row or not row[0]:
            continue
        code, name, order_no, prod_code, prod_name, spec, status, note = (
            row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]
        )
        code = norm(code)
        if not code:
            continue
        if code not in projects:
            projects[code] = {"code": code, "name": norm(name), "orders": []}
            project_order.append(code)
        order = {
            "orderNo": norm(order_no),
            "productCode": norm(prod_code),
            "productName": norm(prod_name),
            "spec": norm(spec),
            "status": norm(status),
            "note": norm(note),
        }
        projects[code]["orders"].append(order)
        order_index[order["orderNo"]] = order

    materials = {}
    material_order = []

    for row in ws2.iter_rows(min_row=2, values_only=True):
        if not row or not row[1]:
            continue
        (proj_code, order_no, prod_code, prod_name, seq, mat_code, mat_name, spec,
         mat_type, po_no, vendor, eta, need_qty, arrival_status, received_qty,
         issued_qty, remain_qty, stock_qty) = row[:18]

        order_no = norm(order_no)
        if order_no not in materials:
            materials[order_no] = []
            material_order.append(order_no)

        need_qty = need_qty if need_qty is not None else 0
        issued_qty = issued_qty if issued_qty is not None else 0
        stock_qty = stock_qty if stock_qty is not None else 0

        # 已到料 iff 需領用量 <= 庫存數量 + 已領用量(已入庫存或已實際領用的都算到料)
        arrival_status = "已到料" if need_qty <= stock_qty + issued_qty else "未到料"

        materials[order_no].append({
            "seq": seq if seq is not None else "",
            "materialCode": norm(mat_code),
            "materialName": norm(mat_name),
            "spec": norm(spec),
            "materialType": norm(mat_type),
            "poNos": split_lines(po_no),
            "vendors": split_lines(vendor),
            "etas": split_lines(eta),
            "needQty": need_qty,
            "arrivalStatus": arrival_status,
            "receivedQty": received_qty if received_qty is not None else 0,
            "issuedQty": issued_qty,
            "remainQty": remain_qty if remain_qty is not None else 0,
            "stockQty": stock_qty,
        })

    # 若某製令下所有物料的未領用量皆為 0,製令狀態一律改為「完全領料」
    for order_no, rows in materials.items():
        if rows and all(r["remainQty"] <= 0 for r in rows):
            order = order_index.get(order_no)
            if order:
                order["status"] = "完全領料"

    storage_items = []
    if "庫存物料" in wb.sheetnames:
        ws4 = wb["庫存物料"]
        for row_no, row in enumerate(ws4.iter_rows(min_row=2, values_only=True), start=2):
            if not row or not row[0]:
                continue
            mat_code, mat_name, spec, stock_qty, category, location, bin_no = row[:7]
            storage_items.append({
                "row": row_no,
                "code": norm(mat_code),
                "name": norm(mat_name),
                "spec": norm(spec),
                "stockQty": stock_qty if stock_qty is not None else 0,
                "category": norm(category),
                "location": norm(location),
                "bin": norm(bin_no),
            })

    # 進退貨履歷:網站物料卡片的「退料」鍵用它找出已進貨的單據(單別/單號)與可退數量
    history = []
    if "進退貨履歷" in wb.sheetnames:
        ws5 = wb["進退貨履歷"]
        for row in ws5.iter_rows(min_row=2, values_only=True):
            if not row or not any(row[:9]):
                continue
            h_date, h_kind, h_type, h_no, h_vendor, h_po, h_code, h_name, h_qty = (list(row[:9]) + [None] * 9)[:9]
            h_kind = str(norm(h_kind))
            if h_kind not in ("進貨", "退貨") or not norm(h_code):
                continue
            history.append({
                "date": h_date.strftime("%Y-%m-%d") if hasattr(h_date, "strftime") else str(norm(h_date)),
                "kind": h_kind,
                "docType": str(norm(h_type)),
                "docNo": str(norm(h_no)),
                "vendor": str(norm(h_vendor)),
                "po": str(norm(h_po)),
                "code": str(norm(h_code)),
                "name": str(norm(h_name)),
                "qty": h_qty if isinstance(h_qty, (int, float)) else 0,
            })

    sign_forms = []
    try:
        wbf = openpyxl.load_workbook(FORMS_XLSX, read_only=True, data_only=True)
        for row in wbf.worksheets[0].iter_rows(min_row=2, values_only=True):
            name, code = str(norm(row[0])), str(norm(row[1])).upper()
            if name and code:
                sign_forms.append({"name": name, "code": code})
        wbf.close()
    except Exception as ex:   # 對照表讀不到不影響其他資料
        print("警告: 讀不到表單與程式碼對照表: %s" % ex)

    source_mtime = datetime.datetime.fromtimestamp(os.path.getmtime(args.src))

    data = {
        "generatedFrom": "WMS.xlsx",
        "sourceUpdatedAt": source_mtime.strftime("%Y-%m-%d %H:%M"),
        "projects": [projects[c] for c in project_order],
        "materials": materials,
        "storageItems": storage_items,
        "history": history,
        "signForms": sign_forms,
    }

    plain = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if os.path.exists(args.auth_config):
        write_atomic(os.path.join(args.out_dir, "data.enc"), encrypt_payload(plain, load_data_key(args.auth_config)))
        print("wrote encrypted data.enc")
    else:
        write_atomic(os.path.join(args.out_dir, "data.json"), plain)

    n_orders = sum(len(p["orders"]) for p in data["projects"])
    n_materials = sum(len(v) for v in materials.values())
    print(f"projects={len(data['projects'])} orders={n_orders} material_rows={n_materials} storage_items={len(storage_items)} history={len(history)} signForms={len(sign_forms)}")


if __name__ == "__main__":
    main()
