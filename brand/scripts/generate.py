#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate the Sodilaud brand SVG sources.

Usage: python3 brand/scripts/generate.py /path/to/jetbrains-mono-latin-500-normal.woff

The wordmark is JetBrains Mono Medium (SIL OFL 1.1) converted to outlines, so the
committed SVGs need no font. The font file is only required to regenerate them.
Needs: pip install fonttools
"""
import math
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
INK, AMBER, TEAL, CORAL = "#181e21", "#fdc78e", "#1e959d", "#ee5a3c"
NAME = "Sodilaud"


def fmt(n):
    s = f"{n:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def write(rel, text):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print("wrote", rel)


# ---------------------------------------------------------------- the mark
# Drawn on a 100-unit tile. The board is the outline, the scrap is the amber
# panel pinned over its corner, the hash is Markdown. Tight corners (miter
# joins), uniform stroke, flat colour.
def mark(level):
    """level: 'full' (512+), 'mid' (64-256) or 'flat' (16-32)."""
    if level == "flat":
        return (
            f'<rect x="16" y="17" width="44" height="44" fill="none" stroke="{INK}" stroke-width="9"/>'
            f'<rect x="38" y="39" width="46" height="46" fill="{AMBER}" stroke="{INK}" stroke-width="9"/>'
        )
    out = (
        f'<rect x="14" y="15" width="48" height="48" fill="none" stroke="{INK}" stroke-width="6"/>'
        f'<rect x="34" y="33" width="52" height="52" fill="{AMBER}" stroke="{INK}" stroke-width="6"/>'
        f'<path d="M53 42V76M67 42V76M43 52H77M43 66H77" fill="none" stroke="{INK}" stroke-width="4"/>'
    )
    if level == "full":
        out += f'<path id="detail-512" d="M23 24H47" fill="none" stroke="{INK}" stroke-width="3"/>'
    return out


def squircle(size, offset, n=5.0, steps=16):
    """Superellipse |x|^n + |y|^n = 1 as a smooth cubic path (Catmull-Rom)."""
    a = size / 2
    cx = cy = offset + a
    pts = []
    for i in range(steps * 4):
        t = 2 * math.pi * i / (steps * 4)
        c, s = math.cos(t), math.sin(t)
        x = a * math.copysign(abs(c) ** (2 / n), c)
        y = a * math.copysign(abs(s) ** (2 / n), s)
        pts.append((cx + x, cy + y))
    d = [f"M{fmt(pts[0][0])} {fmt(pts[0][1])}"]
    count = len(pts)
    for i in range(count):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % count], pts[(i + 2) % count]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d.append(f"C{fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} {fmt(p2[0])} {fmt(p2[1])}")
    return "".join(d) + "Z"


def svg(w, h, body, title, extra=""):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" width="{fmt(w)}" height="{fmt(h)}"{extra} role="img">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def icon_macos(level):
    # 1024 canvas, 824 squircle with 100 px margin (Apple's icon grid).
    return svg(
        1024, 1024,
        f'<path d="{squircle(824, 100)}" fill="{CORAL}"/>'
        f'<g transform="translate(100 100) scale(8.24)">{mark(level)}</g>',
        "Sodilaud",
    )


def icon_master():
    return svg(
        1024, 1024,
        f'<rect width="1024" height="1024" fill="{CORAL}"/>'
        f'<g transform="scale(10.24)">{mark("full")}</g>',
        "Sodilaud (full-bleed master)",
    )


def icon_flat():
    return svg(
        1024, 1024,
        f'<rect width="1024" height="1024" rx="229" fill="{CORAL}"/>'
        f'<g transform="scale(10.24)">{mark("flat")}</g>',
        "Sodilaud (flat)",
    )


# ------------------------------------------------------------- tray glyph
# Single-colour template glyph: black on transparent. The board is an outline
# that stops short of the scrap; the scrap is solid. Each size is drawn on its
# own pixel grid so strokes land on whole pixels (1 px at 1x, 2 px at 2x).
# The 2x sizes also cut the Markdown hash out of the scrap.
TRAY = {
    "tray-16": dict(box=16, board=(1.5, 1.5, 8, 8, 1), scrap=(6, 6, 9, 9), gap=5, hash=None),
    "tray-32": dict(box=32, board=(3, 3, 16, 16, 2), scrap=(12, 12, 18, 18), gap=9,
                    hash=("M18 14V28M24 14V28M14 18H28M14 24H28", 2)),
    "tray-18": dict(box=18, board=(1.5, 1.5, 9, 9, 1), scrap=(7, 7, 10, 10), gap=6, hash=None),
    "tray-36": dict(box=18, board=(1.5, 1.5, 9, 9, 1), scrap=(7, 7, 10, 10), gap=6,
                    hash=("M10.5 8V16M13.5 8V16M8 10.5H16M8 13.5H16", 1)),
}


def tray(spec):
    box = spec["box"]
    bx, by, bw, bh, bs = spec["board"]
    sx, sy, sw, sh = spec["scrap"]
    gap = spec["gap"]
    defs = (
        f'<mask id="gap" maskUnits="userSpaceOnUse" x="0" y="0" width="{box}" height="{box}">'
        f'<rect width="{box}" height="{box}" fill="#fff"/>'
        f'<rect x="{fmt(gap)}" y="{fmt(gap)}" width="{box}" height="{box}" fill="#000"/></mask>'
    )
    scrap_mask = ""
    if spec["hash"]:
        d, width = spec["hash"]
        defs += (
            f'<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="{box}" height="{box}">'
            f'<rect width="{box}" height="{box}" fill="#fff"/>'
            f'<path d="{d}" fill="none" stroke="#000" stroke-width="{width}"/></mask>'
        )
        scrap_mask = ' mask="url(#cut)"'
    body = (
        f"<defs>{defs}</defs>"
        f'<rect x="{fmt(bx)}" y="{fmt(by)}" width="{bw}" height="{bh}" fill="none" stroke="#000" stroke-width="{bs}" mask="url(#gap)"/>'
        f'<rect x="{sx}" y="{sy}" width="{sw}" height="{sh}" fill="#000"{scrap_mask}/>'
    )
    return svg(box, box, body, "Sodilaud tray glyph (template)")


# ---------------------------------------------------------------- wordmark
def load_glyphs(font_path):
    font = TTFont(font_path)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    names = [cmap[ord(c)] for c in NAME]
    advance = font["hmtx"][names[0]][0]
    # bounds of the whole word at upm scale (y up)
    xmin = ymin = 1e9
    xmax = ymax = -1e9
    for i, g in enumerate(names):
        bp = BoundsPen(glyph_set)
        glyph_set[g].draw(bp)
        x0, y0, x1, y1 = bp.bounds
        xmin, xmax = min(xmin, x0 + i * advance), max(xmax, x1 + i * advance)
        ymin, ymax = min(ymin, y0), max(ymax, y1)
    return glyph_set, names, advance, upm, (xmin, ymin, xmax, ymax)


def word_path(glyph_set, names, advance, scale, ox, baseline):
    """SVG path data for the word, baseline at y=baseline, left ink edge at x=ox."""
    pen = SVGPathPen(glyph_set, ntos=lambda v: fmt(v))
    xmin = word_path.xmin
    for i, g in enumerate(names):
        tp = TransformPen(pen, (scale, 0, 0, -scale, ox + (i * advance - xmin) * scale, baseline))
        glyph_set[g].draw(tp)
    return pen.getCommands()


def wordmark(font_path):
    glyph_set, names, advance, upm, bounds = load_glyphs(font_path)
    word_path.xmin = bounds[0]
    xmin, ymin, xmax, ymax = bounds
    out = {}

    def lockup_parts(tile, font_size, layout):
        scale = font_size / upm
        ink_w = (xmax - xmin) * scale
        cap_h = ymax * scale
        return scale, ink_w, cap_h

    def tile_group(size):
        return (
            f'<g><rect width="{size}" height="{size}" rx="{fmt(size * 0.224)}" fill="{CORAL}"/>'
            f'<g transform="scale({fmt(size / 100)})">{mark("full")}</g></g>'
        )

    for name, color in (("ink", INK), ("amber", AMBER), ("currentcolor", "currentColor")):
        # Wordmark alone at font-size 100.
        scale, ink_w, cap_h = lockup_parts(0, 100, "")
        pad = 0
        d = word_path(glyph_set, names, advance, scale, pad, ymax * scale)
        out[f"wordmark/wordmark-{name}.svg"] = svg(ink_w, cap_h, f'<path d="{d}" fill="{color}"/>', "Sodilaud")

        # Horizontal lockup: tile 96, cap height ~ 0.42 of the tile.
        tile = 96
        fs = tile * 0.42 / (ymax / upm)
        scale, ink_w, cap_h = lockup_parts(tile, fs, "")
        gap = tile * 0.30
        width = tile + gap + ink_w
        base = tile / 2 + cap_h / 2
        d = word_path(glyph_set, names, advance, scale, tile + gap, base)
        out[f"wordmark/lockup-horizontal-{name}.svg"] = svg(
            width, tile, f'{tile_group(tile)}<path d="{d}" fill="{color}"/>', "Sodilaud"
        )

        # Stacked lockup: tile 160 over the wordmark, centred.
        tile = 160
        fs = 64
        scale, ink_w, cap_h = lockup_parts(tile, fs, "")
        gap = tile * 0.24
        width = max(tile, ink_w)
        height = tile + gap + cap_h
        d = word_path(glyph_set, names, advance, scale, (width - ink_w) / 2, tile + gap + cap_h)
        out[f"wordmark/lockup-stacked-{name}.svg"] = svg(
            width,
            height,
            f'<g transform="translate({fmt((width - tile) / 2)} 0)">{tile_group(tile)}</g><path d="{d}" fill="{color}"/>',
            "Sodilaud",
        )
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    write("icon/icon-macos.svg", icon_macos("full"))
    write("icon/variants/icon-macos-mid.svg", icon_macos("mid"))
    write("icon/variants/icon-macos-flat.svg", icon_macos("flat"))
    write("icon/icon-master.svg", icon_master())
    write("icon/icon-flat.svg", icon_flat())
    for name, spec in TRAY.items():
        write(f"tray/{name}.svg", tray(spec))
    for rel, text in wordmark(sys.argv[1]).items():
        write(rel, text)


if __name__ == "__main__":
    main()
