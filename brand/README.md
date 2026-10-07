# Sodilaud brand

The visual identity for Sodilaud: app icon, tray glyph, wordmark and lockups, and the
visual-language tokens. "Sodilaud" is Estonian for "scrapboard" (pronounced "so-dee-loud").

## The idea

A **board** (outline) with a **scrap** (amber panel) pinned over its corner, and a Markdown
**`#`** on the scrap. The scrap is the Quick Notes panel floating over whatever you are doing;
the board is the surface it floats on. It is drawn with a uniform outline, mitered corners,
flat colour and no glow, on a coral tile. Nothing in it is a notebook, a pencil, a spiral or `</>`.

## Files

| Path | What |
| --- | --- |
| `icon/icon-macos.svg` | 1024 master with the macOS squircle (824 px body, 100 px margin) and full detail |
| `icon/icon-master.svg` | 1024 full-bleed square, for platforms that apply their own mask |
| `icon/icon-flat.svg` | Rounded tile, no `#`, heavier strokes: survives 16 px (favicon, Windows, Linux) |
| `icon/variants/` | `icon-macos-mid.svg` (64-256 px, no title line) and `icon-macos-flat.svg` (16-32 px) |
| `icon/png/macos/`, `icon/png/flat/` | 16, 32, 64, 128, 256, 512, 1024 px |
| `tray/tray-{16,18,32,36}.svg` + `tray/png/` | Monochrome template glyph, black on transparent |
| `wordmark/` | `wordmark-*`, `lockup-horizontal-*`, `lockup-stacked-*` in `ink` (for light), `amber` (for dark) and `currentcolor`, as outlined SVG, plus PNGs |
| `tokens/tokens.css`, `tokens/tokens.json` | Design tokens (same values) |
| `previews/old-vs-new.png` | Old and new icon on light and dark Dock backgrounds at 16, 32, 128 and 512 px |
| `scripts/` | `generate.py` rebuilds every SVG; `export-png.mjs` rebuilds every PNG |

### Detail steps down with size

| Size | Source | Why |
| --- | --- | --- |
| 512 and up | `icon-macos.svg` (adds a heading line on the board) | Room for the extra detail |
| 64 to 256 | `icon-macos-mid.svg` (board, scrap, `#`) | The `#` still reads |
| 16 and 32 | `icon-macos-flat.svg` (board and scrap only) | The `#` would blur; two overlapping squares and the amber scrap still read |

### Rebuild

```sh
pip install fonttools
python3 brand/scripts/generate.py path/to/jetbrains-mono-latin-500-normal.woff
NODE_PATH=$(npm root -g) node brand/scripts/export-png.mjs   # needs Playwright and Chromium
```

## Palette

Dark is the default and uses the existing built-in **Executive** theme values.

| Token | Hex | Use |
| --- | --- | --- |
| `--sod-ink` | `#181e21` | Dark ground, icon outlines |
| `--sod-ink-raised` | `#242e2e` | Dark raised surface |
| `--sod-amber` | `#fdc78e` | Dark text, the scrap (11.0:1 on ink) |
| `--sod-teal` | `#1e959d` | Accent: fills, focus ring, graphics (4.7:1 on ink) |
| `--sod-teal-deep` | `#1b676b` | Dark selection |
| `--sod-coral` | `#ee5a3c` | The icon tile and brand moments (ink on coral 4.9:1) |
| `--sod-umber` | `#543529` | Dark hairlines |
| `--sod-paper` / `--sod-paper-raised` | `#f6f2ea` / `#ece6db` | Light ground and surface |
| `--sod-teal-ink` / `--sod-coral-ink` | `#146a71` / `#b8351b` | Teal and coral as text on paper (5.7:1, 5.3:1) |

Limits measured while choosing these: teal on `--sod-ink-raised` is 3.9:1 and coral on it is
4.1:1, so use them there as fills and graphics, not body text. Amber on the Executive selection
colour is 4.3:1, so selected rows use `--sod-selection-fg` (paper, 5.9:1); `src/theme-colors.js` already
raises contrast for the active-note row in the app.
The coral was estimated from a screenshot of the Typora Executive theme; the repo's Executive
theme has no coral, so confirm it if you want an exact match.

### How it coexists with user themes

- App chrome is driven by the theme. The six theme fields (`background`, `foreground`,
  `sidebar`, `accent`, `border`, `selection`) keep setting the existing variables inline, which
  beats the optional `:root[data-brand="sodilaud"]` mapping in `tokens.css`. A user theme always wins.
- Coral is a **brand** colour, not a theme colour. It appears only in the icon, the lockups, the
  website and onboarding moments, never as an app-chrome accent that a theme would need to replace.
- Brand surfaces (icon, wordmark, site) use the constants; they never change with the user theme.
- Executive can become the default theme by changing which preset loads first; that is an app change
  and is not made here.

## Type

- **Wordmark and code: JetBrains Mono Medium (500)**, mixed case "Sodilaud", outlined in the SVGs.
  SIL OFL 1.1. The app already uses JetBrains Mono for `--font-mono`.
- **UI and body: Inter** (OFL), as on the website today. `src/styles.css` currently sets
  `--font-sans: 'Outfit'`, not Inter, and neither Outfit nor JetBrains Mono is bundled, so both fall
  back to system fonts unless installed. Decide whether the app moves to Inter to match the site.

## Shape, stroke, spacing

- Icon geometry is strict: mitered corners, no rounding inside the tile. The tile is a 22.4%
  squircle (macOS) or rounded square (flat).
- Icon outline is 6% of the tile (9% in the flat version). UI glyphs stay 2 px on a 24 px grid.
- UI radii: 2 px (kbd, inputs), 4 px (buttons, rows), 8 px (popovers, panels). Hairlines are 1 px.
- Spacing is a 4 px base: 2, 4, 8, 12, 16, 24, 32, 48, 64.

## Elevation and glow

Flat. Separate surfaces with a 1 px hairline and a surface tone. Popovers and menus get one soft
shadow (`--sod-elevation-1`); native windows keep the OS shadow. No glow, no gradients, no blur.
Focus is a 2 px solid accent ring with a 2 px offset.

## Motion

- Summoning is fast: 140 ms fade plus a 2% scale, on the `cubic-bezier(0.16, 1, 0.3, 1)` curve the app
  already uses. No bounce.
- Hover and focus changes are 90 ms. Larger layout moves are 220 ms.
- Nothing loops except an optional slow pulse on the "MCP listening" indicator. Everything is off
  under `prefers-reduced-motion`.

## Tray glyph

`tray-16` and `tray-18` are 1x, `tray-32` and `tray-36` are 2x (they also cut the `#` out of the
scrap). Each is drawn on its own pixel grid so strokes are whole pixels. The app currently builds its
tray glyph in Rust from an 18x18 ASCII clipboard bitmap scaled 2x (`src-tauri/src/clipboard/layout.rs`,
`tray_glyph()`), so `tray-18` and `tray-36` are the drop-in sizes. Wiring them in is not done here.

## Not done here

- `src-tauri/icons/`, `images/logo.png`, `site/` and the Rust tray glyph still use the old art. This
  change only adds `brand/`.
- `icon.icns` and `icon.ico` are not generated. `icon/png/macos/icon-macos-1024.png` is the source.
- The in-app UI icon set, social/OG image and DMG background are later items.
