"""ERP 螢幕截圖 -> 文字辨識 -> 傳送到 WMS 網站「待簽核表單」的資料來源。

流程:取得畫面(即時截圖 / 剪貼簿圖片 / 圖片檔) -> 辨識 -> 把辨識出的表單送到網站中繼(Apps Script)。

兩種畫面:
  1. 有紅色框框:只辨識紅框內的文字 —— 4 碼單別、11 碼單號、單據名稱、廠商名稱;
     加上最上方標題列「(  )」內的 6 碼程式代碼(例如 PURI07)。每個紅框(或框內每一行)是一張待簽核表單。
  2. 沒有紅框:辨識工具列下方藍綠色框框(單別、單號),加上標題列的程式代碼。

文字辨識用 Windows 內建 OCR(scripts\\ocr_win.ps1,不需安裝任何套件)。標題裡的小字英文代碼 OCR 讀不準,
所以用「表單名稱 <-> 程式代碼」對照表(C:/ATK/Project/AI Agent/ERP/表單與程式碼對照表.xlsx)校正;表裡沒有的程式會記錄 OCR 原始結果並標記為不確定。
(對照表讀不到時退回 sign_programs.json。)
標題列讀不出程式代碼時的備援(依序):
  1. 表頭藍綠框:第一個框左邊的標籤(採購單別 -> 採購單、領料單別 -> 製令領料單、入庫單別 -> 生產入庫單、
     托外進貨單別 -> 托外進貨單 MOCI06;只寫「進貨單別」的才是進貨單 PURI09),
     加上藍綠框數量 —— 3 個(多一個「變更版次」)是變更單(採購單別 + 3 框 = 採購變更單 PURI08),2 個是一般單據。
  2. 紅框裡的單據名稱(例「工程採購單」-> 採購單);表頭有 3 個藍綠框時改用該表單的變更單。

用法:
    python -I sign_capture.py --image 圖片.png            辨識圖片檔(只顯示結果,加 --push 才傳送)
    python -I sign_capture.py --clipboard --push          辨識剪貼簿裡的圖片(例如用「剪取工具」框好紅框後複製)
    python -I sign_capture.py --screen --delay 5 --push   5 秒後截取「最前面的視窗」(請先切到 ERP)
    python -I sign_capture.py --screen --full --push      截取整個螢幕(所有螢幕)
輸出一律是一行 JSON(結果),結束代碼:0 成功(有辨識到表單);2 沒辨識到任何表單;1 其他錯誤。
設定檔 scripts\\edit_config.json(同 puri09_queue.py)。
"""
import argparse
import datetime
import difflib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from collections import Counter

from PIL import Image, ImageChops, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "edit_config.json")
PROGRAMS_FILE = os.path.join(HERE, "sign_programs.json")   # 備援;主要來源是下面的 Excel 對照表
SITE_PROGRAMS_FILE = os.path.join(HERE, "sign_programs_site.json")   # 網頁上「編輯表單清單」存的清單(apply_edits 同步下來);有的話優先使用
FORMS_XLSX = os.environ.get("SIGN_FORMS_XLSX", r"C:\ATK\Project\AI Agent\ERP\表單與程式碼對照表.xlsx")
OCR_PS = os.path.join(HERE, "ocr_win.ps1")
WORK = os.environ.get("SIGN_WORK", os.path.join(HERE, "sign_capture"))
LOG_FILE = os.path.join(WORK, "sign_capture.log")
CREATE_NO_WINDOW = 0x08000000

RESAMPLE = {"lanczos": Image.LANCZOS, "bicubic": Image.BICUBIC}


def log(msg):
    try:
        os.makedirs(WORK, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


# ---------------------------------------------------------------- 顏色遮罩與連通區塊(純 Pillow,不需 numpy)

def _band_mask(band, test):
    return band.point(lambda v: 255 if test(v) else 0)


def red_mask(img):
    """紅色標記(使用者畫的框、箭頭)。門檻放寬到能容忍 JPEG 壓縮後變淡的紅線,再膨脹一圈接回被壓縮切碎的細線。"""
    r, g, b = img.convert("RGB").split()
    m = ImageChops.multiply(_band_mask(ImageChops.subtract(r, g), lambda v: v > 85),
                            _band_mask(ImageChops.subtract(r, b), lambda v: v > 85))
    m = ImageChops.multiply(m, _band_mask(r, lambda v: v > 150))
    return m.filter(ImageFilter.MaxFilter(3))


def cyan_mask(img):
    r, g, b = img.convert("RGB").split()
    m = ImageChops.multiply(_band_mask(r, lambda v: v < 80), _band_mask(g, lambda v: v > 170))
    m = ImageChops.multiply(m, _band_mask(b, lambda v: v > 170))
    return ImageChops.multiply(m, _band_mask(ImageChops.difference(g, b), lambda v: v < 50))


_RUN = re.compile(rb"\xff+")


def components(mask, min_pixels=6):
    """遮罩中相連的白色區塊(8 方向相連),回傳 [{'box': (x0,y0,x1,y1), 'n': 像素數}]。以每列的連續段落合併,速度快。"""
    w, h = mask.size
    data = mask.tobytes()
    parent, info = [], []

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    prev = []
    for y in range(h):
        row = data[y * w:(y + 1) * w]
        cur = []
        for m in _RUN.finditer(row):
            x0, x1 = m.span()
            rid = len(parent)
            parent.append(rid)
            info.append((x0, x1, y))
            cur.append((rid, x0, x1))
            for pid, px0, px1 in prev:
                if px0 <= x1 and x0 <= px1:
                    ra, rb = find(rid), find(pid)
                    if ra != rb:
                        parent[ra] = rb
        prev = cur
    agg = {}
    for rid, (x0, x1, y) in enumerate(info):
        root = find(rid)
        a = agg.get(root)
        if a is None:
            agg[root] = [x0, y, x1, y + 1, x1 - x0]
        else:
            a[0] = min(a[0], x0)
            a[1] = min(a[1], y)
            a[2] = max(a[2], x1)
            a[3] = max(a[3], y + 1)
            a[4] += x1 - x0
    return [{"box": tuple(a[:4]), "n": a[4]} for a in agg.values() if a[4] >= min_pixels]


def find_red_boxes(img):
    """紅色空心矩形(使用者畫的框)。排除工具列上的紅色小圖示、標題列的紅色箭頭。"""
    W, H = img.size
    mask = red_mask(img)
    boxes = []
    for c in components(mask):
        x0, y0, x1, y1 = c["box"]
        w, h = x1 - x0, y1 - y0
        if w < max(60, W * 0.04) or not (10 <= h <= H * 0.25):
            continue
        if y1 < H * 0.05:            # 標題列(箭頭)
            continue
        # 實心的不是框:看「框內部」是不是空的。不能用整體填滿率判斷 —— 只框一列的細長框,
        # 粗紅線本身就佔了 4 成以上面積(2026-11-13 PURI07 截圖就是這樣被誤排除)。
        t = max(4, min(8, h // 4))
        if w > 2 * t and h > 2 * t:
            inner = mask.crop((x0 + t, y0 + t, x1 - t, y1 - t))
            iw, ih = inner.size
            if sum(1 for v in inner.tobytes() if v) / float(iw * ih) > 0.2:
                continue
        elif c["n"] / float(w * h) > 0.6:
            continue
        boxes.append((x0, y0, x1, y1))
    boxes.sort(key=lambda b: (b[1], b[0]))
    return boxes


def find_cyan_fields(img):
    """工具列下方表頭區的藍綠色輸入框(單別、單號),由上到下取前兩個。表格標題列的藍綠格位置較低,不算。"""
    W, H = img.size
    fields = []
    for c in components(cyan_mask(img)):
        x0, y0, x1, y1 = c["box"]
        w, h = x1 - x0, y1 - y0
        if w >= 30 and 12 <= h <= 48 and y0 < H * 0.35 and y0 > H * 0.04:
            fields.append((x0, y0, x1, y1))
    fields.sort(key=lambda b: (b[1], b[0]))
    return fields[:2]


def header_cyan_fields(img):
    """表頭「單別 / 單號 / (變更版次)」那一欄的藍綠色輸入框:從最上面一個往下,只收同一欄、上下緊鄰的框。
    下方表格標題列的藍綠格(序號、採購單別欄名)離很遠或不同欄,不會算進來。"""
    W, H = img.size
    cands = []
    for c in components(cyan_mask(img)):
        x0, y0, x1, y1 = c["box"]
        w, h = x1 - x0, y1 - y0
        if w >= 30 and 12 <= h <= 48 and H * 0.04 < y0 < H * 0.45:
            cands.append((x0, y0, x1, y1))
    cands.sort(key=lambda b: (b[1], b[0]))
    if not cands:
        return []
    chain = [cands[0]]
    for b in cands[1:]:
        last = chain[-1]
        h = last[3] - last[1]
        if abs(b[0] - chain[0][0]) <= max(6, h * 0.4) and 0 <= b[1] - last[3] <= h * 1.2:
            chain.append(b)
    return chain


# ---------------------------------------------------------------- 裁切、前處理、OCR

def whiten(c, cyan, red=True):
    """把紅色標記(和藍綠底)換成白色,只留文字,OCR 準確度會高很多。"""
    c = c.convert("RGB")
    mask = red_mask(c)
    if cyan:
        mask = ImageChops.lighter(mask, cyan_mask(c))
    white = Image.new("RGB", c.size, (255, 255, 255))
    c.paste(white, mask=mask)
    return c


def finish(c, scale, resample, mode):
    if mode == "bin":
        c = c.point(lambda v: 0 if v < 150 else 255)
    elif mode == "bin170":   # 標題列小字:門檻高一點,筆畫比較不會斷
        c = c.convert("L").point(lambda v: 0 if v < 170 else 255).convert("RGB")
    c = c.resize((c.size[0] * scale, c.size[1] * scale), RESAMPLE[resample])
    pad = 10 * scale
    out = Image.new("RGB", (c.size[0] + 2 * pad, c.size[1] + 2 * pad), (255, 255, 255))
    out.paste(c, (pad, pad))
    return out


def run_ocr(paths):
    """一次辨識多張圖,回傳和 paths 對齊的文字清單。"""
    os.makedirs(WORK, exist_ok=True)
    lst = os.path.join(WORK, "ocr_list.txt")
    with open(lst, "w", encoding="utf-8") as f:
        f.write("\n".join(paths))
    r = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", OCR_PS, "-ListFile", lst],
                       capture_output=True, creationflags=CREATE_NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError("OCR 失敗: " + r.stderr.decode("utf-8", "replace")[:300])
    data = json.loads(r.stdout.decode("utf-8-sig"))
    by_path = {os.path.normcase(os.path.abspath(d["path"])): d["text"] for d in data}
    return [by_path.get(os.path.normcase(os.path.abspath(p)), "") for p in paths]


class Ocr:
    """收集要辨識的裁切圖(每個區域多種前處理),最後一次 OCR,再依區域取回各版本的文字。"""

    def __init__(self, img, tag):
        self.img, self.tag = img, tag
        self.jobs = []   # (region_name, path)
        self.dir = os.path.join(WORK, "crops")
        os.makedirs(self.dir, exist_ok=True)

    def add(self, name, box, cyan, variants, src=None):
        base = whiten((src or self.img).crop(box), cyan=cyan)
        for scale, resample, mode in variants:
            p = os.path.join(self.dir, "%s_%s_s%d_%s_%s.png" % (self.tag, name, scale, resample, mode))
            finish(base.copy(), scale, resample, mode).save(p)
            self.jobs.append((name, p))

    def run(self):
        try:
            texts = run_ocr([p for _, p in self.jobs]) if self.jobs else []
        finally:
            if not os.environ.get("SIGN_KEEP_CROPS"):   # 裁切圖只是辨識用的暫存,用完就刪(除錯時設 SIGN_KEEP_CROPS=1 保留)
                for _, p in self.jobs:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
        out = {}
        for (name, _), t in zip(self.jobs, texts):
            out.setdefault(name, []).append(t)
        return out


# ---------------------------------------------------------------- 文字解析

CJK = "㐀-鿿"
DIGIT_FIX = str.maketrans({"O": "0", "o": "0", "Ｏ": "0", "l": "1", "I": "1", "|": "1", "丨": "1", "i": "1", "Ⅰ": "1",
                           "S": "5", "B": "8", "Z": "2"})


def compact(text):
    """去掉中文字之間 OCR 插入的空白;其他空白保留成單一空格。"""
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"(?<=[%s·•‧\-]) (?=[%s·•‧\-])" % (CJK, CJK), "", t)
    return t


def valid_doc_no(s):
    if not re.fullmatch(r"\d{11}", s):
        return False
    y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
    return 2000 <= y <= 2099 and 1 <= m <= 12 and 1 <= d <= 31


def vote(cands):
    """回傳 (最多的值, 票數);沒有候選回傳 ('', 0)。"""
    cands = [c for c in cands if c]
    if not cands:
        return "", 0
    value, n = Counter(cands).most_common(1)[0]
    return value, n


def digits_candidates(texts, length, validator=None):
    out = []
    for t in texts:
        s = re.sub(r"\s+", "", t).translate(DIGIT_FIX)
        for m in re.finditer(r"(?<!\d)\d{%d}(?!\d)" % length, s):
            if validator is None or validator(m.group(0)):
                out.append(m.group(0))
    return out


def parse_red_line(text):
    """紅框內一行文字 -> dict(docType, docNo, docName, vendor) 或 None。"""
    t = compact(text)
    m_no = None
    for m in re.finditer(r"(?<!\d)\d{11}(?!\d)", t):
        if valid_doc_no(m.group(0)):
            m_no = m
            break
    if not m_no:
        return None
    before = t[:m_no.start()]
    after = t[m_no.end():]
    types = re.findall(r"(?<!\d)\d{4}(?!\d)", before)
    if not types:
        return None
    doc_type = types[-1]
    tokens = [x for x in re.split(r"\s+", after.strip()) if x]
    cjk_tokens = [re.sub(r"[「」\[\]【】()（）]", "", x) for x in tokens if re.search("[%s]" % CJK, x)]
    cjk_tokens = [x for x in cjk_tokens if x]
    doc_name = cjk_tokens[0] if cjk_tokens else ""
    vendor = cjk_tokens[-1] if len(cjk_tokens) >= 2 else ""
    vendor = re.sub(r"[·•‧・]", "-", vendor).strip("-")
    return {"docType": doc_type, "docNo": m_no.group(0), "docName": doc_name, "vendor": vendor}


# ---------------------------------------------------------------- 程式代碼(標題列 ( ) 內)

def load_programs():
    """程式代碼對照表 -> [{'code': 'PURI07', 'name': '採購單'}, ...]。一個代碼可以對應多個表單名稱(例如 INVI05)。
    網頁上編輯過的清單(sign_programs_site.json)優先,其次是 Excel 對照表,最後是備援 json。"""
    try:
        with open(SITE_PROGRAMS_FILE, encoding="utf-8-sig") as f:
            site = [{"code": str(p["code"]).upper(), "name": str(p["name"])} for p in json.load(f) if p.get("code") and p.get("name")]
        if site:
            return site
    except Exception:
        pass
    try:
        import openpyxl
        wb = openpyxl.load_workbook(FORMS_XLSX, read_only=True, data_only=True)
        ws = wb.worksheets[0]
        out = []
        for row in ws.iter_rows(min_row=2, values_only=True):
            name, code = (str(row[0]).strip() if row[0] else ""), (str(row[1]).strip().upper() if row[1] else "")
            if name and re.fullmatch(r"[A-Z0-9]{4,10}", code):
                out.append({"code": code, "name": name})
        wb.close()
        if out:
            return out
    except Exception:
        pass
    try:
        with open(PROGRAMS_FILE, encoding="utf-8-sig") as f:
            data = json.load(f)
        return [p for p in data if p.get("code") and p.get("name")]
    except Exception:
        return []


_CANON = str.maketrans({"O": "0", "Q": "0", "D": "0", "I": "1", "l": "1", "|": "1", "丨": "1", "G": "C", "Ｏ": "0"})


def canon_code(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper().translate(_CANON))


def _core(name):
    """表單/程式名稱去掉尾巴的「建立作業」「建立」「作業」,只留中文,方便和對照表的表單名稱比對。"""
    name = re.sub(r"[^%s]" % CJK, "", name)
    return re.sub(r"(建立作業?|建立|作業)$", "", name)


def parse_title(texts, programs):
    """標題列文字 -> (程式代碼, 表單名稱, 把握度 known/code/guess/none)。
    known = 名稱和代碼都對得上;code = 主要靠代碼對上(名稱沒讀清楚),紅框單據名稱對得到別的程式時以單據名稱為準。
    標題長得像「採購單建立作業(PURI07)[公司名]」:用「括號前的中文名稱」和「括號內的代碼」分別和對照表比對,
    兩者綜合分數最高、且夠像的才算認得(代碼小字英文 OCR 常讀錯,所以不能只靠代碼)。"""
    scores = {}   # 程式代碼 -> (分數, 名稱相似度, 對照表項目)
    raw_codes = []
    for t in texts:
        s = re.sub(r"\s+", "", t)
        m = re.search(r"^(.*?)[\(（]([^\)）】〕\]]*)", s)
        if not m:
            continue
        name = _core(m.group(1))
        code_raw = m.group(2)
        raw_codes.append(code_raw)
        for p in programs:
            name_sim = difflib.SequenceMatcher(None, name, _core(p["name"])).ratio() if name else 0.0
            code_sim = difflib.SequenceMatcher(None, canon_code(code_raw), canon_code(p["code"])).ratio()
            score = 0.6 * name_sim + 0.4 * code_sim
            if (name_sim >= 0.6 or code_sim >= 0.8) and score >= 0.6:
                if p["code"] not in scores or score > scores[p["code"]][0]:
                    scores[p["code"]] = (score, name_sim, p)
    ranked = sorted(scores.values(), key=lambda v: -v[0])
    # 第一名要明顯領先其他代碼才算認得:只讀到「PURI0」時 PURI07 和 PURI09 一樣像,不能隨便挑一個
    if ranked and (len(ranked) == 1 or ranked[0][0] - ranked[1][0] >= 0.05):
        best = ranked[0]
        return best[2]["code"], best[2]["name"], "known" if best[1] >= 0.8 else "code"
    # 對照表裡沒有:用 OCR 的代碼(大寫英數,補正 |→I),格式像程式代碼才採用
    cands = []
    for c in raw_codes:
        c2 = re.sub(r"[^A-Za-z0-9|]", "", c).replace("|", "I").upper()
        if re.fullmatch(r"[A-Z]{4}\d{2}", c2):
            cands.append(c2)
    code, _ = vote(cands)
    if code:
        return code, "", "guess"
    return "", "", "none"


# ---------------------------------------------------------------- 辨識主流程

FIELD_H = 23.0   # 標準大小下,藍綠色輸入框的高度(像素)


def normalize_scale(img):
    """ERP 的字大小是固定像素。圖片被縮放過(或 Windows 顯示比例不是 100%)時,用藍綠色單別/單號框的高度當尺規,
    把圖片校正成標準大小再辨識;找不到藍綠框就不調整。回傳 (圖片, 縮放倍率)。"""
    fields = find_cyan_fields(img)
    if not fields:
        return img, 1.0
    hs = sorted(f[3] - f[1] for f in fields)
    scale = max(0.6, min(1.8, FIELD_H / hs[len(hs) // 2]))
    if abs(scale - 1.0) <= 0.08:
        return img, 1.0
    return img.resize((int(round(img.size[0] * scale)), int(round(img.size[1] * scale))), Image.LANCZOS), scale


def program_from_doc_name(doc_name, programs):
    """標題列讀不出程式代碼時的備援:用紅框裡的單據名稱(例「工程採購單」)找對照表中包含在內、最長的表單名稱
    (「採購單」-> PURI07;「工程採購變更單」會對到較長的「採購變更單」而不是「採購單」)。"""
    name = re.sub(r"[^%s]" % CJK, "", doc_name or "")
    best = None
    for p in programs:
        core = _core(p["name"])
        if len(core) >= 2 and core in name and (best is None or len(core) > len(_core(best["name"]))):
            best = p
    return best


# 表頭標籤(第一個藍綠框左邊的字,去掉「別」)對到多個表單時的偏好(使用者確認過的畫面)
LABEL_PREFER = {"領料單": "MOCI03", "入庫單": "MOCI05"}


def _label_core(text):
    t = re.sub(r"[^%s]" % CJK, "", text or "")
    return re.sub(r"[別號]+$", "", t)


def program_from_header(label_texts, n_fields, programs):
    """備援:用表頭第一個藍綠框左邊的標籤(例「採購單別」)和藍綠框數量判斷程式。
    藍綠框 3 個(單別、單號、變更版次)= 變更單;2 個 = 一般單據。例:採購單別 + 2 框 = 採購單 PURI07、+ 3 框 = 採購變更單 PURI08;
    領料單別 = 製令領料單 MOCI03;入庫單別 = 生產入庫單 MOCI05。回傳 (對照表項目 或 None, 讀到的標籤)。"""
    label, _ = vote([_label_core(t) for t in label_texts if len(_label_core(t)) >= 2])
    if not label:
        return None, ""
    want_change = n_fields >= 3
    scored = []   # (相似度, 是否變更單, 表單, 對到的字)
    for p in programs:
        core = _core(p["name"])
        base = core.replace("變更", "")
        # 標籤通常是表單名稱的後段(「生產入庫單」的標籤是「入庫單別」):和名稱中同長度(±1)的每一段比,取最像的
        best_r, best_sub = 0.0, ""
        for n in {len(label) - 1, len(label), len(label) + 1}:
            for i in range(0, max(0, len(base) - n) + 1):
                sub = base[i:i + n]
                if len(sub) < 2:
                    continue
                r = difflib.SequenceMatcher(None, label, sub).ratio()
                if r > best_r or (r == best_r and sub.endswith("單") and not best_sub.endswith("單")):
                    best_r, best_sub = r, sub
        if best_r >= 0.6:
            scored.append((round(best_r, 3), "變更" in core, p, best_sub))
    if not scored:
        return None, label
    same_kind = [x for x in scored if x[1] == want_change]
    pool = same_kind or scored
    top = max(x[0] for x in pool)
    pool = [x for x in pool if x[0] == top]
    canon = Counter(x[3] for x in pool).most_common(1)[0][0]   # 校正後的標籤(例「採單」-> 「採購單」)
    progs = [x[2] for x in pool]
    if len({p["code"] for p in progs}) == 1:
        return progs[0], canon
    exact = [p for p in progs if _core(p["name"]).replace("變更", "") == canon]
    if len({p["code"] for p in exact}) == 1:
        return exact[0], canon
    pref = LABEL_PREFER.get(canon)
    if not pref:
        # 只讀到一部分(例「庫單」):候選表單「全部」都包含某個偏好標籤(「入庫單」)時才套用;
        # 「料單」還可能是製令退料單,就不猜
        for key, code in LABEL_PREFER.items():
            if canon in key and all(key in _core(p["name"]) for p in progs):
                pref, canon = code, key
                break
    for p in progs:
        if p["code"] == pref:
            return p, canon
    return None, canon   # 對到好幾種表單、又沒有偏好:不猜


def change_variant(p, programs):
    """表單的變更單版本(採購單 -> 採購變更單);沒有就回傳 None。"""
    base = _core(p["name"])
    for q in programs:
        if "變更" in q["name"] and _core(q["name"]).replace("變更", "") == base:
            return q
    return None


def recognize(img, tag="img"):
    orig = img
    img, norm = normalize_scale(img)
    W, H = img.size
    result = {"ok": True, "mode": "", "prog": "", "progName": "", "progConf": "none", "forms": [], "warnings": [], "size": [W, H], "scale": round(norm, 3)}
    reds = find_red_boxes(img)
    cyans = [] if reds else find_cyan_fields(img)
    ocr = Ocr(img, tag)

    # 標題列從「原始圖片」裁切:整張圖先縮放校正會讓標題小字更糊,OCR 幾乎讀不出來
    OW, OH = orig.size
    title_box = (0, 0, max(120, int(OW * 0.25)), max(20, int(OH * 0.035)))
    ocr.add("title", title_box, cyan=False, src=orig,
            variants=[(s, r, "gray") for s in (2, 3, 4) for r in ("lanczos", "bicubic")] + [(s, "lanczos", "bin170") for s in (3, 4, 6)])

    # 備援用:表頭藍綠框數量 + 第一個框左邊的標籤文字(標題列讀不出程式代碼時用)
    hdr = header_cyan_fields(img)
    if hdr:
        # 和標題列一樣從原始圖片裁切(座標換回原圖比例),縮放過的圖小字會更糊
        hx0, hy0, hx1, hy1 = [v / norm for v in hdr[0]]
        hh = hy1 - hy0
        ocr.add("label", (max(0, int(hx0 - hh * 7)), max(0, int(hy0 - 2)), max(1, int(hx0 - 2)), int(hy1 + 2)), cyan=True, src=orig,
                variants=[(s, "lanczos", m) for s in (2, 3, 4) for m in ("gray", "bin170")])

    if reds:
        result["mode"] = "red"
        for i, (x0, y0, x1, y1) in enumerate(reds):
            ocr.add("red%d" % i, (x0 + 3, y0 + 3, x1 - 3, y1 - 3), cyan=False,
                    variants=[(s, r, "gray") for s in (2, 3, 4) for r in ("lanczos", "bicubic")] + [(3, "lanczos", "bin"), (4, "bicubic", "bin")])
    elif len(cyans) >= 2:
        result["mode"] = "cyan"
        v = [(s, r, m) for s in (2, 3, 4, 5) for r in ("lanczos", "bicubic") for m in ("gray", "bin")]
        for i, (x0, y0, x1, y1) in enumerate(cyans):
            ocr.add("cyan%d" % i, (x0 + 2, y0 + 2, x1 - 2, y1 - 2), cyan=True, variants=v)
    else:
        result["ok"] = False
        result["warnings"].append("找不到紅色框框,也找不到工具列下方的藍綠色單別/單號框")

    texts = ocr.run()

    programs = load_programs()
    code, name, conf = parse_title(texts.get("title", []), programs)
    result["prog"], result["progName"], result["progConf"] = code, name, conf

    if result["mode"] == "red":
        for i in range(len(reds)):
            per_line = {}
            for t in texts.get("red%d" % i, []):
                for line in t.split("\n"):
                    p = parse_red_line(line)
                    if p:
                        per_line.setdefault((p["docType"], p["docNo"]), []).append(p)
            if not per_line:
                result["warnings"].append("第 %d 個紅框沒有辨識出 4 碼單別 + 11 碼單號" % (i + 1))
            for (dtype, dno), plist in per_line.items():
                names, _ = vote([p["docName"] for p in plist])
                vendors, _ = vote([p["vendor"] for p in plist])
                result["forms"].append({"docType": dtype, "docNo": dno, "docName": names, "vendor": vendors,
                                        "conf": "high" if len(plist) >= 2 else "low", "box": list(reds[i])})
    elif result["mode"] == "cyan":
        types = digits_candidates(texts.get("cyan0", []), 4)
        nos = digits_candidates(texts.get("cyan1", []), 11, valid_doc_no)
        dtype, n1 = vote(types)
        dno, n2 = vote(nos)
        if dtype and dno:
            result["forms"].append({"docType": dtype, "docNo": dno, "docName": "", "vendor": "",
                                    "conf": "high" if n1 >= 2 and n2 >= 2 else "low", "box": list(cyans[0])})
        else:
            result["warnings"].append("藍綠框沒有辨識出 4 碼單別 + 11 碼單號(單別 %s、單號 %s)" % (dtype or "?", dno or "?"))

    hp, hlabel = (None, "")
    if conf != "known" and hdr:
        hp, hlabel = program_from_header(texts.get("label", []), len(hdr), programs)
        result["header"] = {"label": hlabel, "fields": len(hdr), "prog": hp["code"] if hp else ""}
    for f in result["forms"]:
        f["prog"], f["progName"], f["src"] = result["prog"], result["progName"], "紅框" if result["mode"] == "red" else "藍綠框"
        if conf == "known":
            continue
        # 標題列沒有完全認出來:先看表頭(標籤 + 藍綠框數量),再看紅框裡的單據名稱
        p = hp
        if not p:
            p = program_from_doc_name(f.get("docName"), programs)
            if p and len(hdr) >= 3:   # 變更單的資料瀏覽,單據名稱仍是原單別名稱(例「工程採購單」)
                p = change_variant(p, programs) or p
        if p:
            f["prog"], f["progName"] = p["code"], p["name"]
    if conf != "known" and not result["forms"] and hp:
        result["prog"], result["progName"], result["progConf"] = hp["code"], hp["name"], "header"
    elif conf == "code" and all(f["prog"] == code for f in result["forms"]):
        pass   # 代碼認得、表頭 / 單據名稱沒有不同意見
    elif conf != "known":
        by_name = {(f["prog"], f["progName"]) for f in result["forms"] if f["prog"]}
        if result["forms"] and len(by_name) == 1 and all(f["prog"] for f in result["forms"]):
            result["prog"], result["progName"] = by_name.pop()
            result["progConf"] = "header" if hp else "docName"
        elif conf == "guess":
            result["warnings"].append("程式代碼 %s 不在「表單與程式碼對照表」中,是依 OCR 結果猜的" % code)
        else:
            result["warnings"].append("沒辨識出標題列的程式代碼")
    return result


# ---------------------------------------------------------------- 取得畫面

def grab_foreground():
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass
    from PIL import ImageGrab
    hwnd = user32.GetForegroundWindow()
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom), all_screens=True).convert("RGB")


def grab_full():
    import ctypes
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass
    from PIL import ImageGrab
    return ImageGrab.grab(all_screens=True).convert("RGB")


def grab_clipboard():
    from PIL import ImageGrab
    im = ImageGrab.grabclipboard()
    if isinstance(im, list):   # 複製的是檔案:取第一個圖片檔
        for p in im:
            if str(p).lower().endswith((".png", ".jpg", ".jpeg", ".bmp")):
                return Image.open(p).convert("RGB")
        return None
    return im.convert("RGB") if im is not None else None


# ---------------------------------------------------------------- 傳送

def push_to(endpoint, key, forms, extra=None):
    payload = {"action": "signforms_push", "key": key, "forms": forms}
    if extra:
        payload.update(extra)
    req = urllib.request.Request(endpoint, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "text/plain;charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=40) as resp:
        return json.loads(resp.read().decode("utf-8"))


def push(forms, extra=None):
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    return push_to(cfg["endpoint"], cfg["syncKey"], forms, extra)


def main(argv):
    ap = argparse.ArgumentParser(description="ERP 截圖辨識 -> WMS 待簽核表單")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--image", help="辨識圖片檔")
    src.add_argument("--clipboard", action="store_true", help="辨識剪貼簿裡的圖片")
    src.add_argument("--screen", action="store_true", help="即時截圖(預設截最前面的視窗)")
    ap.add_argument("--full", action="store_true", help="--screen 時改截整個螢幕")
    ap.add_argument("--delay", type=float, default=0, help="--screen 截圖前等待的秒數(讓你切到 ERP)")
    ap.add_argument("--push", action="store_true", help="把辨識出的表單傳送到網站(沒加就只顯示結果)")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")

    os.makedirs(WORK, exist_ok=True)
    if args.image:
        img, name = Image.open(args.image).convert("RGB"), os.path.basename(args.image)
    elif args.clipboard:
        img, name = grab_clipboard(), "clipboard"
    else:
        if args.delay:
            time.sleep(args.delay)
        img, name = (grab_full() if args.full else grab_foreground()), "screen"
    if img is None:
        print(json.dumps({"ok": False, "error": "剪貼簿裡沒有圖片"}, ensure_ascii=False))
        return 1
    last = os.path.join(WORK, "last_capture.png")
    img.save(last)

    res = recognize(img, tag="cap")
    res["source"] = name
    forms = res["forms"]
    log("辨識 %s:模式=%s 程式=%s(%s) 表單=%d %s" % (name, res["mode"], res["prog"], res["progConf"], len(forms),
                                                  " ".join("%s-%s" % (f["docType"], f["docNo"]) for f in forms)))
    if args.push and forms:
        try:
            res["push"] = push(forms, {"source": name})
        except Exception as ex:
            res["push"] = {"ok": False, "error": str(ex)[:200]}
            log("傳送失敗: %s" % ex)
        else:
            log("傳送結果: %s" % json.dumps(res["push"], ensure_ascii=False))
    for f in forms:
        f.pop("box", None)
    print(json.dumps(res, ensure_ascii=False))
    if not forms:
        return 2
    if args.push and not res.get("push", {}).get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as ex:
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps({"ok": False, "error": str(ex)[:300]}, ensure_ascii=False))
        log("錯誤: %s" % ex)
        sys.exit(1)
