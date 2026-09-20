#!/usr/bin/env python3
# Generates creature_banners.h: 4 pre-rendered 1bpp name banner masks (pure
# black text on white, so 1 bit/pixel loses nothing) for the badge to expand
# to RGB565 at draw time - see lcd_draw_creature() in lcd.c.
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 320, 48
BYTES_PER_ROW = (W + 7) // 8
FONT_PATH = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
CREATURES = [
    ("CREATURE_CAT", "CAT"),
    ("CREATURE_CHICK", "BABY CHICK"),
    ("CREATURE_GOOSE", "CANADA GOOSE"),
    ("CREATURE_TURKEY", "TURKEY"),
]
# Not part of the wire creature_banners[] table - fixed system screens the
# badge shows on its own, before/around the handshake (see main.c).
SYSTEM = [
    ("SYSTEM_BINGBONG", "BINGBONG"),
    ("SYSTEM_PRESS_TO_JOIN", "PRESS ANY KEY TO JOIN"),
]

def render(text):
    img = Image.new("RGB", (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    size = 40
    while size > 8:
        font = ImageFont.truetype(FONT_PATH, size)
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if tw <= W - 20 and th <= H - 8:
            break
        size -= 2
    x = (W - tw) // 2 - bbox[0]
    y = (H - th) // 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=(0, 0, 0))
    return img

def to_packed_bits(img):
    # 1 = black (text), 0 = white (background) - see COLOR_BLACK/COLOR_WHITE
    # in lcd_draw_creature(). MSB-first within each byte.
    px = img.load()
    rows = []
    for y in range(H):
        row = bytearray(BYTES_PER_ROW)
        for x in range(W):
            r, _g, _b = px[x, y]
            if r < 128:
                row[x // 8] |= 0x80 >> (x % 8)
        rows.append(bytes(row))
    return b"".join(rows)

def emit_array(f, name, packed):
    f.write(f"static const uint8_t {name}[CREATURE_BANNER_BYTES] = {{\n")
    for i in range(0, len(packed), 16):
        row = ", ".join(f"0x{b:02X}" for b in packed[i : i + 16])
        f.write(f"    {row},\n")
    f.write("};\n\n")

def main():
    png_dir = os.path.join(OUT_DIR, "banners")
    os.makedirs(png_dir, exist_ok=True)

    header_path = os.path.join(OUT_DIR, "creature_banners.h")
    with open(header_path, "w") as f:
        f.write("// Auto-generated 1bpp banner masks (see gen_creature_banners.py): the 4\n")
        f.write("// creature names (wire order, for creature_banners[]) plus 2 fixed system\n")
        f.write("// screens. 1 bit/pixel, MSB-first, since these are pure black-on-white\n")
        f.write("// text - lcd_draw_banner() expands each bit to RGB565 at draw time.\n")
        f.write("#pragma once\n#include <stdint.h>\n\n")
        f.write(f"#define CREATURE_BANNER_WIDTH {W}\n")
        f.write(f"#define CREATURE_BANNER_HEIGHT {H}\n")
        f.write(f"#define CREATURE_BANNER_BYTES_PER_ROW {BYTES_PER_ROW}\n")
        f.write(f"#define CREATURE_BANNER_BYTES (CREATURE_BANNER_BYTES_PER_ROW * CREATURE_BANNER_HEIGHT)\n\n")

        array_names = []
        for name, text in CREATURES:
            img = render(text)
            img.save(os.path.join(png_dir, f"{name.lower()}.png"))
            packed = to_packed_bits(img)
            array_name = f"{name.lower()}_banner"
            emit_array(f, array_name, packed)
            array_names.append(array_name)

        f.write("static const uint8_t *const creature_banners[4] = {\n")
        for n in array_names:
            f.write(f"    {n},\n")
        f.write("};\n\n")

        for name, text in SYSTEM:
            img = render(text)
            img.save(os.path.join(png_dir, f"{name.lower()}.png"))
            packed = to_packed_bits(img)
            emit_array(f, f"{name.lower()}_banner", packed)

    print("wrote", header_path)

if __name__ == "__main__":
    main()
