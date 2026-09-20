#!/usr/bin/env python3
# Generates creature_screens.h: the full creature-assigned LCD screen assets -
# a shared background, 4 creature sprite icons (with a transparent palette
# index so the background shows through), and a small proportional bitmap
# font for the name/flavor text. All 4bpp indexed (16-color palette) or 1bpp
# (font), since raw RGB565 for images this size would blow the flash budget
# (see lcd_draw_indexed()/lcd_draw_text() in lcd.c for the consumers).
import os
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
IMAGES_DIR = os.path.join(REPO_ROOT, "src", "lib", "images")
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_PATH = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"

BG_W, BG_H = 320, 240
SPRITE_W, SPRITE_H = 140, 200
TRANSPARENT_INDEX = 0

# Order matches CREATURES in src/lib/game-state.svelte.ts and creature_banners.h
# (0 Cat, 1 Baby Chick, 2 Canada Goose, 3 Turkey) - Turkey borrows the ostrich
# asset, same as everywhere else in this project.
CREATURES = [
    ("CAT", "cat.webp", "Bing", "a weirdly\npurple cat"),
    ("CHICK", "chick.webp", "Bong", "literally\na baby"),
    ("GOOSE", "goose.webp", "Ping", "unwanted on\nUW campus"),
    ("TURKEY", "ostridge.webp", "Pong", "where my\nhair at"),
]

LARGE_FONT_SIZE = 40  # name
SMALL_FONT_SIZE = 17  # flavor text
LARGE_CELL = (34, 46)
SMALL_CELL = (16, 22)
# Must match TEXT_PANEL_W minus its left/right padding in lcd.c - just a
# generation-time sanity check so an overlong line is caught here instead of
# discovered by squinting at the actual badge.
TEXT_AVAILABLE_WIDTH = 138
GLYPHS = " '" + "".join(chr(c) for c in range(0x30, 0x3A)) + "".join(
    chr(c) for c in range(0x41, 0x5B)
) + "".join(chr(c) for c in range(0x61, 0x7B))


def rgb565(r, g, b):
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def emit_u16_array(f, name, values):
    f.write(f"static const uint16_t {name}[{len(values)}] = {{\n")
    for i in range(0, len(values), 12):
        row = ", ".join(f"0x{v:04X}" for v in values[i : i + 12])
        f.write(f"    {row},\n")
    f.write("};\n\n")


def emit_u8_array(f, name, data):
    f.write(f"static const uint8_t {name}[{len(data)}] = {{\n")
    for i in range(0, len(data), 16):
        row = ", ".join(f"0x{b:02X}" for b in data[i : i + 16])
        f.write(f"    {row},\n")
    f.write("};\n\n")


# ---- Background: opaque photo, quantized to 16 colors, no transparency. ----
def build_background():
    img = Image.open(os.path.join(IMAGES_DIR, "background.webp")).convert("RGB")
    # Center-crop to the panel's 4:3 aspect before resizing, so the source's
    # 16:9 crop doesn't get squashed.
    src_w, src_h = img.size
    target_ratio = BG_W / BG_H
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        new_w = int(src_h * target_ratio)
        x0 = (src_w - new_w) // 2
        img = img.crop((x0, 0, x0 + new_w, src_h))
    else:
        new_h = int(src_w / target_ratio)
        y0 = (src_h - new_h) // 2
        img = img.crop((0, y0, src_w, y0 + new_h))
    img = img.resize((BG_W, BG_H), Image.LANCZOS)
    quant = img.quantize(colors=16, method=Image.MEDIANCUT)
    palette = quant.getpalette()[: 16 * 3]
    pal565 = [rgb565(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]) for i in range(16)]

    indices = list(quant.getdata())
    packed = bytearray((BG_W * BG_H) // 2)
    for i in range(0, len(indices), 2):
        packed[i // 2] = (indices[i] << 4) | indices[i + 1]
    return pal565, bytes(packed)


# ---- Sprites: alpha-masked icon, quantized to 15 colors + 1 transparent. ----
def build_sprite(filename):
    img = Image.open(os.path.join(IMAGES_DIR, filename)).convert("RGBA")
    # Source art has its own transparent padding around the character -
    # crop to the actual opaque content first so it fills the sprite box
    # instead of floating in a sea of blank space.
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    img.thumbnail((SPRITE_W, SPRITE_H), Image.LANCZOS)
    canvas = Image.new("RGBA", (SPRITE_W, SPRITE_H), (0, 0, 0, 0))
    x0 = (SPRITE_W - img.width) // 2
    y0 = (SPRITE_H - img.height) // 2
    canvas.paste(img, (x0, y0), img)

    rgb = canvas.convert("RGB")
    quant = rgb.quantize(colors=15, method=Image.MEDIANCUT)
    palette = quant.getpalette()[: 15 * 3]
    # Index 0 is reserved for "transparent" (never sampled by the LCD code) -
    # real colors shift up by one.
    pal565 = [0x0000] + [
        rgb565(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]) for i in range(15)
    ]

    alpha = canvas.split()[3]
    quant_indices = list(quant.getdata())
    alpha_data = list(alpha.getdata())
    indices = [
        TRANSPARENT_INDEX if alpha_data[i] < 128 else quant_indices[i] + 1
        for i in range(len(quant_indices))
    ]

    packed = bytearray((SPRITE_W * SPRITE_H) // 2)
    for i in range(0, len(indices), 2):
        packed[i // 2] = (indices[i] << 4) | indices[i + 1]
    return pal565, bytes(packed)


# ---- Font: proportional glyphs, stored in a fixed-width 1bpp cell. ----
def build_font(size, cell_w, cell_h):
    font = ImageFont.truetype(FONT_PATH, size)
    bytes_per_row = (cell_w + 7) // 8
    glyphs = {}
    for ch in GLYPHS:
        img = Image.new("L", (cell_w, cell_h), 0)
        draw = ImageDraw.Draw(img)
        bbox = draw.textbbox((0, 0), ch, font=font)
        advance = draw.textlength(ch, font=font)
        # Shift horizontally to the glyph's own ink so narrow chars (', i)
        # aren't wasted on padding, but leave y alone - (0, 0) is already a
        # shared baseline-relative origin for every glyph in this font,  so
        # each glyph's ink naturally lands at its correct height relative to
        # the others (ascenders up, descenders down). Shifting y by -bbox[1]
        # instead (as this used to) would flush every glyph's ink to the top
        # of the cell, wiping out the baseline they're supposed to share.
        draw.text((-bbox[0], 0), ch, font=font, fill=255)
        packed = bytearray(bytes_per_row * cell_h)
        px = img.load()
        for y in range(cell_h):
            for x in range(cell_w):
                if px[x, y] >= 128:
                    packed[y * bytes_per_row + (x // 8)] |= 0x80 >> (x % 8)
        glyphs[ch] = (max(1, round(advance)), bytes(packed))
    return bytes_per_row, glyphs


def emit_font(f, prefix, size, cell_w, cell_h):
    bytes_per_row, glyphs = build_font(size, cell_w, cell_h)
    data = bytearray()
    widths = []
    offsets = []
    for ch in GLYPHS:
        advance, packed = glyphs[ch]
        offsets.append(len(data))
        widths.append(advance)
        data += packed

    f.write(f"#define {prefix}_CELL_WIDTH {cell_w}\n")
    f.write(f"#define {prefix}_CELL_HEIGHT {cell_h}\n")
    f.write(f"#define {prefix}_BYTES_PER_ROW {bytes_per_row}\n")
    f.write(f"#define {prefix}_GLYPH_BYTES ({bytes_per_row} * {cell_h})\n")
    f.write(f'static const char {prefix}_CHARSET[] = "{GLYPHS}";\n')
    emit_u8_array(f, f"{prefix.lower()}_widths", widths)
    emit_u8_array(f, f"{prefix.lower()}_bitmap", bytes(data))
    f.write(
        f"static const font_t {prefix} = {{ {prefix}_CHARSET, {prefix.lower()}_widths, "
        f"{prefix.lower()}_bitmap, {prefix}_CELL_WIDTH, {prefix}_CELL_HEIGHT, {prefix}_BYTES_PER_ROW }};\n\n"
    )


def main():
    header_path = os.path.join(OUT_DIR, "creature_screens.h")
    with open(header_path, "w") as f:
        f.write(
            "// Auto-generated (see gen_creature_screens.py): the creature-assigned\n"
            "// screen's background, per-creature sprite icons, and a small\n"
            "// proportional bitmap font. Images are 4bpp indexed (16-color palette),\n"
            "// 2 pixels/byte, high nibble first; the font is 1bpp. See\n"
            "// lcd_draw_indexed()/lcd_draw_text() in lcd.c for how these are consumed.\n"
            "#pragma once\n#include <stdint.h>\n\n"
            "typedef struct {\n"
            "    const char *charset;\n"
            "    const uint8_t *widths;\n"
            "    const uint8_t *bitmap;\n"
            "    uint8_t cell_width;\n"
            "    uint8_t cell_height;\n"
            "    uint8_t bytes_per_row;\n"
            "} font_t;\n\n"
            "typedef struct {\n"
            "    const uint16_t *palette;\n"
            "    const uint8_t *pixels;\n"
            "} indexed_image_t;\n\n"
            "typedef struct {\n"
            "    indexed_image_t sprite;\n"
            "    const char *name;\n"
            "    const char *flavor;\n"
            "} creature_screen_t;\n\n"
        )

        f.write(f"#define BG_WIDTH {BG_W}\n#define BG_HEIGHT {BG_H}\n")
        f.write(f"#define SPRITE_WIDTH {SPRITE_W}\n#define SPRITE_HEIGHT {SPRITE_H}\n\n")

        bg_pal, bg_pixels = build_background()
        emit_u16_array(f, "background_palette", bg_pal)
        emit_u8_array(f, "background_pixels", bg_pixels)
        f.write(
            "static const indexed_image_t background_image = "
            "{ background_palette, background_pixels };\n\n"
        )

        screen_names = []
        for creature_name, filename, slot_name, flavor in CREATURES:
            pal, pixels = build_sprite(filename)
            lower = creature_name.lower()
            emit_u16_array(f, f"{lower}_palette", pal)
            emit_u8_array(f, f"{lower}_pixels", pixels)
            screen_name = f"{lower}_screen"
            # flavor contains real newline chars (Python's \n) - escape them
            # back to a literal backslash-n so the emitted C string keeps
            # them as \n for lcd_draw_text() to line-wrap on.
            c_flavor = flavor.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
            f.write(
                f'static const creature_screen_t {screen_name} = {{ {{ {lower}_palette, {lower}_pixels }}, '
                f'"{slot_name}", "{c_flavor}" }};\n\n'
            )
            screen_names.append(screen_name)

        f.write("static const creature_screen_t *const creature_screens[4] = {\n")
        for n in screen_names:
            f.write(f"    &{n},\n")
        f.write("};\n\n")

        emit_font(f, "FONT_LARGE", LARGE_FONT_SIZE, *LARGE_CELL)
        emit_font(f, "FONT_SMALL", SMALL_FONT_SIZE, *SMALL_CELL)

    print("wrote", header_path)
    validate_widths()


def validate_widths():
    _, large_glyphs = build_font(LARGE_FONT_SIZE, *LARGE_CELL)
    _, small_glyphs = build_font(SMALL_FONT_SIZE, *SMALL_CELL)

    def line_width(glyphs, line):
        w = sum(glyphs[ch][0] + 1 for ch in line)
        return w - 1 if line else 0

    overflow = False
    for _, _, slot_name, flavor in CREATURES:
        w = line_width(large_glyphs, slot_name)
        if w > TEXT_AVAILABLE_WIDTH:
            print(f"WARNING: name '{slot_name}' is {w}px, wider than {TEXT_AVAILABLE_WIDTH}px available")
            overflow = True
        for line in flavor.split("\n"):
            w = line_width(small_glyphs, line)
            if w > TEXT_AVAILABLE_WIDTH:
                print(f"WARNING: flavor line '{line}' is {w}px, wider than {TEXT_AVAILABLE_WIDTH}px available")
                overflow = True
    if not overflow:
        print("all text fits within", TEXT_AVAILABLE_WIDTH, "px")


if __name__ == "__main__":
    main()
