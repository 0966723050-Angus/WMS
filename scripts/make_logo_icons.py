from PIL import Image, ImageDraw
import os

SRC = r"C:\Users\angus.ad\Downloads\logo.png"
OUT_DIR = r"C:\ATK\Project\AI Agent\WMS-Web\icons"
BRAND = (15, 118, 110, 255)  # #0f766e

os.makedirs(OUT_DIR, exist_ok=True)


def remove_white_bg(img, threshold=235):
    img = img.convert("RGBA")
    datas = img.getdata()
    new_data = []
    for r, g, b, a in datas:
        if r >= threshold and g >= threshold and b >= threshold:
            new_data.append((r, g, b, 0))
        else:
            new_data.append((r, g, b, a))
    img.putdata(new_data)
    return img


def autocrop(img):
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


logo = Image.open(SRC)
logo = remove_white_bg(logo)
logo = autocrop(logo)
logo.save(os.path.join(OUT_DIR, "atk-logo.png"))
print("atk-logo.png size:", logo.size)


def make_icon(size, maskable, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if maskable:
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, size, size], fill=BRAND)
        box_ratio = 0.55
    else:
        radius = int(size * 0.22)
        draw = ImageDraw.Draw(img)
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BRAND)
        box_ratio = 0.72

    max_w = size * box_ratio
    max_h = size * box_ratio * 0.55
    lw, lh = logo.size
    ratio = min(max_w / lw, max_h / lh)
    new_w, new_h = max(1, int(lw * ratio)), max(1, int(lh * ratio))
    resized = logo.resize((new_w, new_h), Image.LANCZOS)
    x = (size - new_w) // 2
    y = (size - new_h) // 2
    img.paste(resized, (x, y), resized)
    img.save(path)
    print("saved", path, size)


make_icon(192, False, os.path.join(OUT_DIR, "icon-192.png"))
make_icon(512, False, os.path.join(OUT_DIR, "icon-512.png"))
make_icon(512, True, os.path.join(OUT_DIR, "icon-maskable-512.png"))
