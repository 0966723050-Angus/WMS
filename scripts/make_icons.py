from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = r"C:\ATK\Project\AI Agent\WMS-Web\icons"
BRAND = (15, 118, 110, 255)  # #0f766e
WHITE = (255, 255, 255, 255)

os.makedirs(OUT_DIR, exist_ok=True)


def find_font(size):
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def draw_box_icon(draw, cx, cy, s, color):
    # simple isometric-ish warehouse box glyph
    half = s / 2
    top = (cx, cy - half)
    left = (cx - half, cy - half * 0.35)
    right = (cx + half, cy - half * 0.35)
    bottom_left = (cx - half, cy + half * 0.75)
    bottom_right = (cx + half, cy + half * 0.75)
    bottom = (cx, cy + half)

    draw.polygon([top, right, bottom, left], fill=color)
    # shading lines
    draw.line([top, bottom], fill=(255, 255, 255, 90), width=max(1, int(s * 0.04)))
    draw.line([left, bottom], fill=(0, 0, 0, 40), width=max(1, int(s * 0.03)))
    draw.line([right, bottom], fill=(0, 0, 0, 40), width=max(1, int(s * 0.03)))


def make_icon(size, maskable=False, path=None):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(size * (0.12 if maskable else 0.0))
    if maskable:
        draw.rectangle([0, 0, size, size], fill=BRAND)
    else:
        radius = int(size * 0.22)
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BRAND)

    box_size = size * (0.42 if maskable else 0.5)
    draw_box_icon(draw, size / 2, size * (0.44 if maskable else 0.42), box_size, WHITE)

    font = find_font(int(size * 0.16))
    text = "WMS"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text((size / 2 - tw / 2, size * 0.72 - th / 2), text, font=font, fill=WHITE)

    img.save(path)
    print("saved", path, size)


make_icon(192, maskable=False, path=os.path.join(OUT_DIR, "icon-192.png"))
make_icon(512, maskable=False, path=os.path.join(OUT_DIR, "icon-512.png"))
make_icon(512, maskable=True, path=os.path.join(OUT_DIR, "icon-maskable-512.png"))
