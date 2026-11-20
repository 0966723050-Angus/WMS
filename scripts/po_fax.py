"""採購單傳真(不經 ERP 畫面):ERP SQL 讀採購單 → 依 ERP「工程採購單」版面(A4 直向)自己畫 → FX 驅動程式以一般列印模式輸出成檔案
→ 換成「傳真」PJL 表頭(含廠商傳真號碼)→ 直接送到事務機 10.8.8.228:9100 撥出。

傳真 PJL 的格式是 2026-11-20 用驅動程式「工作類型=傳真」輸出到檔案比對出來的:
  @PJL JOB MODE=DIRECTFAX、@PJL SET JOBATTR="@FAEN=<號碼>{20}{30}{7<base64 名稱>}" 等;
  PCL XL 內容與一般列印相同,所以內容用一般列印模式產生(不會跳出「傳真受信方」視窗)。

用法:
  python po_fax.py preview 3303 20261120001 [--printer "Microsoft Print to PDF"] [--out x.pdf]   產生預覽(PDF),不傳真
  python po_fax.py send 3303 20261120001 [--to 5050606] [--dry-run]   傳真給廠商(--to 改傳到指定號碼;--dry-run 只產生檔案不送出)
  python po_fax.py number 3303 20261120001                              只查廠商傳真號碼與撥號號碼
輸出最後一行是 JSON:{"ok":..., "doc":..., "vendor":..., "fax":..., "dial":..., "error":...}
"""
import base64
import ctypes
import datetime
import json
import os
import re
import socket
import sys
import tempfile
from ctypes import wintypes as W

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, r"C:\ATK\Project\AI Agent\WMS\WMS一鍵更新")   # erp_sql(只做 SELECT)

PRINTER = "FX DocuCentre-V C2263 PCL 6"
DEVICE_IP = "10.8.8.228"
DEVICE_PORT = 9100
LOCAL_AREA = "06"           # 公司在台南:同區碼不撥區碼
LOG = os.path.join(HERE, "po_fax.log")

COMPANY = "銓行應用材料股份有限公司"
COMPANY_EN = "Alltek Applied Material Co., Ltd."
ADDR1 = "74144 臺南市新市區創業路28號1樓"
ADDR2 = "1F., No. 28, Chuangye Rd., Xinshi Dist., Tainan City 74144, Taiwan"
ADDR3 = "T +886-6-5056600    F +886-6-5050606    W www.atk.com.tw"


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


# ---------------- 資料 ----------------
def _ymd(v):
    v = (v or "").strip()
    return "%s-%s-%s" % (v[:4], v[4:6], v[6:8]) if len(v) == 8 and v.isdigit() else v


def _num(v, dec=0):
    try:
        f = float(v or 0)
    except Exception:
        return str(v or "")
    if dec == 0 and f == int(f):
        return "{:,}".format(int(f))
    s = "{:,.4f}".format(f).rstrip("0").rstrip(".")
    return s


def load_po(dt, dn):
    import erp_sql
    cn = erp_sql.connect()
    try:
        q = lambda sql: list(erp_sql._rows(cn, sql))
        dt_s, dn_s = dt.replace("'", ""), dn.replace("'", "")
        h = q("""SELECT TC001,TC002,TC003,TC004,TC005,TC008,TC009,TC011,TC014,TC019,TC020,TC021,TC024,TC026,TC048,TC052,
                        MA002,MA003,MA008,MA010,MA014,MV002,MQ002
                 FROM PURTC WITH (NOLOCK)
                 LEFT JOIN PURMA WITH (NOLOCK) ON MA001=TC004
                 LEFT JOIN CMSMV WITH (NOLOCK) ON MV001=TC011
                 LEFT JOIN CMSMQ WITH (NOLOCK) ON MQ001=TC001
                 WHERE TC001='%s' AND TC002='%s'""" % (dt_s, dn_s))
        if not h:
            raise RuntimeError("ERP 查無採購單 %s-%s" % (dt, dn))
        lines = q("""SELECT TD003,TD004,TD005,TD006,TD007,TD008,TD009,TD010,TD011,TD012,TD014,TD015,TD022,TD024,TD025,TD034,TD039,TD040
                     FROM PURTD WITH (NOLOCK) WHERE TD001='%s' AND TD002='%s' ORDER BY TD003""" % (dt_s, dn_s))
    finally:
        cn.close()
    return h[0], lines


def dial_number(fax):
    """廠商傳真 → 撥號號碼:去掉 - 與空白;台南(06)同區只撥本地號碼;其他區碼保留。
    有多組號碼(以 / 、 , 或「或」分隔)只取第一組;有分機(#、轉)去掉。不合理就回傳空字串。"""
    s = (fax or "").strip()
    if not s:
        return ""
    s = re.split(r"[/、,，;；]|或", s)[0]
    s = re.split(r"#|轉|ext", s, flags=re.I)[0]
    s = s.replace("+886", "0").replace("(", "").replace(")", "")
    d = re.sub(r"[^\d]", "", s)
    if d.startswith("8860"):
        d = d[3:]
    elif d.startswith("886"):
        d = "0" + d[3:]
    if d.startswith(LOCAL_AREA) and len(d) >= 9:
        d = d[len(LOCAL_AREA):]
    return d if 7 <= len(d) <= 12 else ""


# ---------------- GDI 繪圖 ----------------
gdi = ctypes.WinDLL("gdi32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)
winspool = ctypes.WinDLL("winspool.drv", use_last_error=True)


class DOCINFOW(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_int), ("lpszDocName", W.LPCWSTR), ("lpszOutput", W.LPCWSTR),
                ("lpszDatatype", W.LPCWSTR), ("fwType", W.DWORD)]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", W.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long), ("biPlanes", W.WORD),
                ("biBitCount", W.WORD), ("biCompression", W.DWORD), ("biSizeImage", W.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", W.DWORD), ("biClrImportant", W.DWORD)]


gdi.CreateDCW.restype = W.HDC
gdi.CreateDCW.argtypes = [W.LPCWSTR, W.LPCWSTR, W.LPCWSTR, ctypes.c_void_p]
gdi.CreateFontW.restype = W.HFONT
gdi.CreateFontW.argtypes = [ctypes.c_int] * 5 + [W.DWORD] * 8 + [W.LPCWSTR]
gdi.SelectObject.restype = W.HGDIOBJ
gdi.SelectObject.argtypes = [W.HDC, W.HGDIOBJ]
gdi.CreatePen.restype = W.HPEN
user32.DrawTextW.argtypes = [W.HDC, W.LPCWSTR, ctypes.c_int, ctypes.POINTER(RECT), W.UINT]
winspool.OpenPrinterW.argtypes = [W.LPCWSTR, ctypes.POINTER(W.HANDLE), ctypes.c_void_p]
winspool.DocumentPropertiesW.argtypes = [W.HWND, W.HANDLE, W.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p, W.DWORD]

DT_LEFT, DT_CENTER, DT_RIGHT, DT_VCENTER, DT_SINGLELINE, DT_NOPREFIX, DT_END_ELLIPSIS, DT_WORDBREAK = 0, 1, 2, 4, 0x20, 0x800, 0x8000, 0x10


def page_devmode(printer):
    """取印表機預設 DEVMODE,改成 A4 直向(不改印表機本身的設定)。"""
    h = W.HANDLE()
    if not winspool.OpenPrinterW(printer, ctypes.byref(h), None):
        raise RuntimeError("找不到印表機:%s" % printer)
    try:
        size = winspool.DocumentPropertiesW(None, h, printer, None, None, 0)
        buf = ctypes.create_string_buffer(size)
        winspool.DocumentPropertiesW(None, h, printer, buf, None, 2)          # DM_OUT_BUFFER
        fields = int.from_bytes(buf.raw[72:76], "little") | 0x1 | 0x2          # DM_ORIENTATION | DM_PAPERSIZE
        ctypes.memmove(ctypes.addressof(buf) + 72, fields.to_bytes(4, "little"), 4)
        ctypes.memmove(ctypes.addressof(buf) + 76, (1).to_bytes(2, "little"), 2)   # DMORIENT_PORTRAIT
        ctypes.memmove(ctypes.addressof(buf) + 78, (9).to_bytes(2, "little"), 2)   # DMPAPER_A4
        out = ctypes.create_string_buffer(size)
        winspool.DocumentPropertiesW(None, h, printer, out, buf, 2 | 8)       # DM_OUT_BUFFER | DM_IN_BUFFER
        return out
    finally:
        winspool.ClosePrinter(h)


TA_LEFT, TA_RIGHT, TA_CENTER, TA_BASELINE = 0, 2, 6, 24
gdi.ExtTextOutW.argtypes = [W.HDC, ctypes.c_int, ctypes.c_int, W.UINT, ctypes.POINTER(RECT), W.LPCWSTR, W.UINT, ctypes.c_void_p]


class Canvas:
    """座標一律用 mm(紙張左上角為原點);文字 y 為基線位置(與 ERP 匯出 PDF 量到的一致)。"""

    def __init__(self, hdc):
        self.hdc = hdc
        self.dpi = gdi.GetDeviceCaps(hdc, 88)                 # LOGPIXELSX
        self.offx = gdi.GetDeviceCaps(hdc, 112)               # PHYSICALOFFSETX
        self.offy = gdi.GetDeviceCaps(hdc, 113)
        self.fonts = {}
        gdi.SetBkMode(hdc, 1)

    def px(self, mm, axis=0):
        return int(round(mm * self.dpi / 25.4)) - (self.offx if axis == 0 else self.offy)

    def font(self, pt, bold=False, face="細明體"):
        k = (pt, bold, face)
        if k not in self.fonts:
            self.fonts[k] = gdi.CreateFontW(-int(round(pt * self.dpi / 72)), 0, 0, 0, 700 if bold else 400,
                                            0, 0, 0, 136, 0, 0, 2, 0, face)
        gdi.SelectObject(self.hdc, self.fonts[k])

    def text(self, x, y, s, pt=9, align=TA_LEFT, face="細明體", clip=None, bold=False):
        """x,y = 基線起點(mm);clip=(x1, x2) 超出欄寬就截掉。"""
        s = str(s if s is not None else "")
        if not s:
            return
        self.font(pt, bold, face)
        gdi.SetTextAlign(self.hdc, align | TA_BASELINE)
        if clip:
            r = RECT(self.px(clip[0]), self.px(y - pt * 0.4, 1), self.px(clip[1]), self.px(y + pt * 0.15, 1))
            gdi.ExtTextOutW(self.hdc, self.px(x), self.px(y, 1), 4, ctypes.byref(r), s, len(s), None)   # ETO_CLIPPED
        else:
            gdi.ExtTextOutW(self.hdc, self.px(x), self.px(y, 1), 0, None, s, len(s), None)

    def line(self, x1, y1, x2, y2, width_mm=0.35):
        pen = gdi.CreatePen(0, max(1, int(round(width_mm * self.dpi / 25.4))), 0)
        old = gdi.SelectObject(self.hdc, pen)
        gdi.MoveToEx(self.hdc, self.px(x1), self.px(y1, 1), None)
        gdi.LineTo(self.hdc, self.px(x2), self.px(y2, 1))
        gdi.SelectObject(self.hdc, old)
        gdi.DeleteObject(pen)

    def image(self, path, x, y, w_mm, h_mm):
        from PIL import Image
        im = Image.open(path).convert("RGB")
        w_px, h_px = im.size
        stride = (w_px * 3 + 3) & ~3
        raw = im.transpose(Image.FLIP_TOP_BOTTOM).tobytes("raw", "BGR")
        if stride != w_px * 3:
            raw = b"".join(raw[i * w_px * 3:(i + 1) * w_px * 3] + b"\0" * (stride - w_px * 3) for i in range(h_px))
        bmi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w_px, h_px, 1, 24, 0, len(raw), 0, 0, 0, 0)
        gdi.SetStretchBltMode(self.hdc, 4)   # HALFTONE
        gdi.StretchDIBits(self.hdc, self.px(x), self.px(y, 1), self.px(x + w_mm) - self.px(x), self.px(y + h_mm, 1) - self.px(y, 1),
                          0, 0, w_px, h_px, raw, ctypes.byref(bmi), 0, 0x00CC0020)


# ---- 版面:A4 直向,位置取自 ERP 匯出的採購單 PDF(2026-11-20,3303-20261111006)----
BANNER = os.path.join(HERE, "po_banner.jpg")   # ERP 憑證上的公司抬頭圖
X0, X1 = 10.65, 200.75                       # 表格左右框線
VLINES = [18.3, 78.4, 100.8, 113.4, 138.3, 155.9, 188.4]
ROW_TOPS = [93.5, 106.2, 118.55, 131.6, 143.95, 157.0, 169.35, 182.4, 194.75, 207.8, 220.15, 232.5]   # 12 格品項
ROW_BOTTOM = 244.85
PER_PAGE = len(ROW_TOPS)
SRC = {"1": "請購", "2": "訂單", "3": "製令", "9": "其他"}


def draw_page(c, h, items, page, pages, last, totals):
    if os.path.exists(BANNER):
        c.image(BANNER, 10.0, 10.0, 177.4, 10.4)
    else:
        c.text(10, 18, COMPANY, 15, face="新細明體", bold=True)
    c.text(97.3, 33.2, h.get("MQ002") or "採購單", 12, face="新細明體")
    c.text(168.3, 43.3, "頁    次:", 9)
    c.text(183.8, 43.3, "%d /%d" % (page, pages), 9)

    # 單頭框
    c.line(X0, 45.1, X1, 45.1); c.line(X0, 80.0, X1, 80.0)
    c.line(X0, 45.1, X0, 80.0); c.line(X1, 45.1, X1, 80.0)
    base = [48.3, 52.5, 56.6, 60.7, 64.8, 69.0, 73.1, 77.2]
    L = [("採購單別:", h["TC001"]), ("採購單號:", h["TC002"]), ("單據日期:", _ymd(h["TC024"])), ("廠商名稱:", h.get("MA003") or h.get("MA002")),
         ("廠商地址:", h.get("MA014")), ("聯 絡 人:", h.get("TC052")), ("送貨地址:", h.get("TC021")), ("備    註:", h.get("TC009"))]
    for (k, v), y in zip(L, base):
        c.text(11.2, y, k)
        c.text(25.6, y, v, clip=(25.6, 77.5) if y in (base[0], base[1], base[2], base[5]) else (25.6, 200))
    rate = h.get("TC026")
    M = [(0, "交易幣別:", h.get("TC005")), (1, "營業稅率:", ("%g%%" % (float(rate) * 100)) if rate not in (None, "") else ""),
         (2, "採購人員:", h.get("MV002") or ""), (5, "廠商電話:", h.get("MA008"))]
    for i, k, v in M:
        c.text(78.3, base[i], k)
        c.text(92.3, base[i], v, clip=(92.3, 138))
    R = [(0, "交易方式:", {"1": "一般"}.get(str(h.get("TC048") or ""), str(h.get("TC048") or ""))), (1, "付款條件:", h.get("TC008")),
         (5, "廠商傳真:", h.get("MA010"))]
    for i, k, v in R:
        c.text(138.8, base[i], k)
        c.text(152.9, base[i], v, clip=(152.9, 200))

    # 表格框線:標題列 80.0~93.5、12 格品項、合計列
    for y in [80.0, 93.5] + ROW_TOPS[1:] + [ROW_BOTTOM, 250.75]:
        c.line(X0, y, X1, y)
    c.line(X0, 80.0, X0, 250.75); c.line(X1, 80.0, X1, 250.75)
    for x in VLINES:
        c.line(x, 80.0, x, ROW_BOTTOM)

    # 標題列
    t1, t2, t3 = 83.2, 87.3, 91.5
    c.text(11.2, t1, "序號")
    c.text(18.7, t1, "品號"); c.text(18.7, t2, "品名"); c.text(18.7, t3, "規格")
    c.text(78.7, t1, "採購數量"); c.text(100.3, t3, "已交數量", align=TA_RIGHT)
    c.text(101.2, t1, "單位"); c.text(112.9, t3, "庫別", align=TA_RIGHT)
    c.text(113.7, t1, "採購單價"); c.text(137.8, t3, "採購金額", align=TA_RIGHT)
    c.text(147.1, t1, "預 交 日", align=TA_CENTER)
    c.text(172.15, t1, "專案代號", align=TA_CENTER); c.text(172.15, t2, "來源單號", align=TA_CENTER); c.text(172.15, t3, "備    註", align=TA_CENTER)
    c.text(194.6, t1, "急料", align=TA_CENTER); c.text(194.6, t2, "來源", align=TA_CENTER)

    # 品項
    for i, it in enumerate(items):
        T = ROW_TOPS[i]
        b1, b2, b3 = T + 2.7, T + 6.6, T + 10.6
        c.text(11.0, b1, it["TD003"])
        c.text(19.3, b1, it["TD004"], clip=(19, 37))
        c.text(37.5, b1, it.get("TD040") or "")
        c.text(44.7, b1, it.get("TD039") or "", clip=(44.7, 78))
        c.text(19.0, b2, it["TD005"], clip=(19, 78))
        c.text(19.0, b3, it["TD006"], clip=(19, 78))
        c.text(80.1, b1, _num(it["TD008"], 1), clip=(79, 100.5))
        c.text(99.9, b3, _num(it.get("TD015"), 1), align=TA_RIGHT)
        c.text(101.6, b1, it["TD009"], clip=(101.2, 113))
        c.text(107.6, b3 + 0.3, it["TD007"])
        c.text(115.0, b1, _num(it["TD010"], 1), clip=(114, 138))
        c.text(136.3, b3, _num(it["TD011"]), align=TA_RIGHT)
        c.text(138.9, b1, _ymd(it["TD012"]))
        c.text(156.6, b1, it.get("TD022") or "", clip=(156.3, 188))
        c.text(156.6, b2 + 0.3, (it.get("TD024") or "")[:18], 8)
        c.text(156.3, b3, it.get("TD014") or "", clip=(156.2, 188))
        c.text(194.6, b1, it.get("TD025") or "", align=TA_CENTER)
        c.text(194.6, b2, SRC.get(str(it.get("TD034") or ""), ""), align=TA_CENTER)
    if last and len(items) < PER_PAGE:
        c.text(19.3, ROW_TOPS[len(items)] + 3.4, "以下空白//")

    # 合計列(最後一頁)
    if last:
        amt, tax, qty = totals
        y = 248.1
        c.text(25.6, y, "數量合計:" + _num(qty, 1))
        c.text(66.9, y, "採購金額: " + _num(amt))
        c.text(110.3, y, "稅額: " + _num(tax))
        c.text(147.3, y, "金額合計:" + _num(float(amt or 0) + float(tax or 0)))

    # 頁尾說明與簽核欄
    c.text(10.2, 256.7, "1.請確認交期並回簽訂單、2.出貨單請備註訂單號碼。")
    c.text(10.2, 261.0, "1.Please confirm the delivery date and sign back PO to us. 2.PO No. must be indicated on the delivery note.")
    c.text(10.2, 269.2, "部門主管:"); c.text(68.5, 269.2, "會簽單位:"); c.text(126.7, 269.2, "申請人:")
    c.text(10.2, 282.4, "總經理：")


def render(h, lines, printer, out_path):
    """畫出整張採購單,用指定印表機(一般列印模式)輸出到 out_path。回傳頁數。"""
    dm = page_devmode(printer)
    hdc = gdi.CreateDCW("WINSPOOL", printer, None, dm)
    if not hdc:
        raise RuntimeError("CreateDC 失敗(%d)" % ctypes.get_last_error())
    try:
        c = Canvas(hdc)
        doc = "PO %s-%s" % (h["TC001"], h["TC002"])
        di = DOCINFOW(ctypes.sizeof(DOCINFOW), doc, out_path, None, 0)
        if gdi.StartDocW(hdc, ctypes.byref(di)) <= 0:
            raise RuntimeError("StartDoc 失敗(%d)" % ctypes.get_last_error())
        pages = max(1, (len(lines) + PER_PAGE - 1) // PER_PAGE)
        qty = sum(float(x["TD008"] or 0) for x in lines)
        for p in range(pages):
            gdi.StartPage(hdc)
            c.fonts = {}
            draw_page(c, h, lines[p * PER_PAGE:(p + 1) * PER_PAGE], p + 1, pages, p == pages - 1, (h.get("TC019"), h.get("TC020"), qty))
            gdi.EndPage(hdc)
        gdi.EndDoc(hdc)
        return pages
    finally:
        gdi.DeleteDC(hdc)


# ---------------- 傳真 ----------------
def to_fax_job(prn, number, name, docname):
    """一般列印檔 → 傳真工作:換掉 PJL 表頭(MODE=DIRECTFAX + @FAEN 受信方),結尾工作類型改 DIRECTFAX。"""
    i = prn.find(b"@PJL ENTER LANGUAGE")
    if i < 0:
        raise RuntimeError("列印檔格式不對(找不到 ENTER LANGUAGE)")
    head = prn[:i].decode("utf-8", "replace")
    body = prn[i:]
    get = lambda key, default="": (re.search(r'@PJL SET JOBATTR="@%s=([^"]*)"' % key, head) or [None, default])[1]
    now = datetime.datetime.now()
    nm = base64.b64encode(name.encode("utf-8")).decode("ascii")
    lines = [
        "\x1b%-12345X@PJL SET STRINGCODESET=UTF8",
        "@PJL COMMENT DATE=%s" % now.strftime("%m/%d/%Y"),
        "@PJL COMMENT TIME=%s" % now.strftime("%H:%M:%S"),
        "@PJL COMMENT DNAME=%s" % docname,
        "@PJL JOB MODE=DIRECTFAX",
        '@PJL SET JOBATTR="@LUNA=%s"' % get("LUNA", "WMS"),
        '@PJL SET JOBATTR="@IEXT=STANDARD"',
        '@PJL SET JOBATTR="@JOEP="',
        '@PJL SET JOBATTR="@JOAD="',
        '@PJL SET JOBATTR="@DAID="',
        '@PJL SET JOBATTR="@ACNA=%s"' % docname,
        '@PJL SET JOBATTR="@SBKP=OFF"',
        '@PJL SET JOBATTR="@NLPP=1"',
        '@PJL SET JOBATTR="@HOAD=%s"' % get("HOAD"),
        "@PJL SET RESOLUTION=200",
        '@PJL SET JOBATTR="@FARE=FINE"',
        '@PJL SET JOBATTR="@TRRE=ONERROR"',
        '@PJL SET JOBATTR="@TXHE=ON"',
        '@PJL SET JOBATTR="@FAEN=%s{20}{30}{7%s}"' % (number, nm),
        '@PJL SET JOBATTR="@JOAU=%s"' % get("JOAU", "WMS"),
        '@PJL SET JOBATTR="@CNAM=%s"' % get("CNAM"),
        "@PJL SET COPIES=1",
        "@PJL SET QTY=1",
        '@PJL SET JOBATTR="@FSCM=BOTH"',
        '@PJL SET JOBATTR="@MSDA=OFF"',
        '@PJL SET JOBATTR="@TPIC=DEVICE"',
        '@PJL SET JOBATTR="@DIND=OFF"',
        '@PJL SET JOBATTR="@DIBB=OFF"',
        '@PJL SET JOBATTR="@DIBK=OFF"',
    ]
    body = body.replace(b"FXJOBINFO JOBTYPE=PRINT", b"FXJOBINFO JOBTYPE=DIRECTFAX")
    return ("\n".join(lines) + "\n").encode("utf-8") + body


def send_raw(data):
    with socket.create_connection((DEVICE_IP, DEVICE_PORT), timeout=30) as s:
        s.sendall(data)
        s.shutdown(socket.SHUT_WR)


def main(argv):
    if len(argv) < 4 or argv[1] not in ("preview", "send", "number"):
        print(__doc__)
        return 2
    cmd, dt, dn = argv[1], argv[2].strip(), argv[3].strip()
    opt = lambda k: argv[argv.index(k) + 1] if k in argv and argv.index(k) + 1 < len(argv) else None
    res = {"ok": False, "doc": "%s-%s" % (dt, dn)}
    try:
        h, lines = load_po(dt, dn)
        res.update(vendor=h.get("MA002") or "", vendorCode=h.get("TC004"), fax=h.get("MA010") or "", dial=dial_number(h.get("MA010")))
        if cmd == "number":
            res["ok"] = bool(res["dial"])
            if not res["ok"]:
                res["error"] = "廠商沒有可用的傳真號碼"
            return out(res)
        if cmd == "preview":
            printer = opt("--printer") or "Microsoft Print to PDF"
            path = opt("--out") or os.path.join(tempfile.gettempdir(), "PO_%s-%s.pdf" % (dt, dn))
            res["pages"] = render(h, lines, printer, path)
            res.update(ok=True, file=path)
            return out(res)
        # send
        if (h.get("TC014") or "") != "Y":
            raise RuntimeError("採購單尚未確認(確認碼 %s),不傳真" % (h.get("TC014") or "空白"))
        number = re.sub(r"[^\d]", "", opt("--to") or "") or res["dial"]
        if not number:
            raise RuntimeError("廠商「%s」沒有可用的傳真號碼" % (h.get("MA002") or h.get("TC004")))
        res["sentTo"] = number
        tmp = os.path.join(tempfile.gettempdir(), "po_fax_%s-%s.prn" % (dt, dn))
        res["pages"] = render(h, lines, PRINTER, tmp)
        with open(tmp, "rb") as f:
            prn = f.read()
        job = to_fax_job(prn, number, str(h.get("TC004") or "VENDOR"), "PO %s-%s" % (dt, dn))
        if "--dry-run" in argv:
            jp = tmp[:-4] + "_fax.prn"
            with open(jp, "wb") as f:
                f.write(job)
            res.update(ok=True, dryRun=True, file=jp)
        else:
            send_raw(job)
            res.update(ok=True, sentAt=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            log("傳真 %s → %s(%s)%d 頁" % (res["doc"], number, res["vendor"], res["pages"]))
        try:
            os.remove(tmp)
        except Exception:
            pass
    except Exception as ex:
        res["error"] = str(ex)
        log("失敗 %s:%s" % (res["doc"], ex))
    return out(res)


def out(res):
    print(json.dumps(res, ensure_ascii=False, default=str))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv))
