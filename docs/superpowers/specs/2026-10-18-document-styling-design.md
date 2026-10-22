# Document styling

Issues #54, #55, #56, #57 and #58, shipped as one pull request on `feat/document-styling`.
The document area (Live, Source and Reading mode) gets its colours from the active theme,
themes can override document colours, headings get a stronger scale with rules, paragraph
spacing and a readable width become settings, and the document fonts become configurable with
two new bundled families.

## Intent

Side by side with Typora, the same document in Sodilaud looks less finished. The causes are
specific: document colours fall back to the Default Dark/Light palette under every other theme
(a navy code band on Executive's warm page), headings are small and coloured with the UI
accent, text runs the full window width, blocks do not share edges, and the document font is
the UI font. This change fixes each cause without touching the app chrome (sidebar, status bar,
title bar), which a later branch (#59, "quieter chrome") restyles.

## Goals

- Every colour drawn in the document area comes from the active theme, either set by the theme
  or derived from its six base colours. No Default Dark/Light value leaks into another theme.
- Themes may set eight optional document slots; unset slots fall back to the derivation.
- Executive is retuned: warm headings in the body text's colour family, neutral tables, a code
  block that matches the page.
- Headings: larger scale, bold, a thin rule under H1 and H2, spacing proportional to level.
- New settings: paragraph spacing, readable width (on/off and width), body/heading/code font.
- Live and Reading mode render the same scale, spacing, width, fonts and colours.

## Non-goals

- App chrome (sidebar, status bar, title bar, menus, modals). The only chrome-visible change is
  that a theme which sets the `mutedText` slot changes `--text-muted`.
- A theme editor UI. There is none today; see Rulings.
- A UI font setting and the document font in the outline (both optional in #56); see Rulings.
- Emphasis colour in Live mode (`.syntax-emphasis` uses `--accent-hover`). Unchanged; a
  follow-up if it bothers.
- State highlights that are semantic rather than thematic: diff add/remove greens and reds,
  comment marks, the agent-edit flash, the active find match (yellow), Mermaid error red.
- Styles in copied HTML (see Rulings).
- A heading-scale setting (#57 defers it).

## Decisions

Given (by the issue texts or the maintainer):

- The issue texts' proposed behaviour is the requirement.
- `renderMarkdown` stays the only HTML path; Live, Reading and copy-as-HTML render the same
  markup.
- Bundled fonts are vendored files from the font project's official GitHub release, OFL
  licensed, with `THIRD_PARTY_NOTICES.md` updated and no runtime egress. Keep the curated list
  to about four families.
- A test iterates every preset theme and proves no Default Dark/Light colour reaches the
  document area.

My calls (Rulings):

1. **No theme editor is built.** The issue says to expose the slots "in the theme editor", but
   Sodilaud has only a theme picker with Import and Export. The slots are carried by import and
   export (JSON and TOML/key-value) and documented in the README. Cost if wrong: a separate
   theme-editor issue.
2. **Defaults are derived too.** The Default Dark/Light CSS blocks get the document values that
   `deriveDocumentColors` computes for those presets, pinned by a test, so the default themes
   look like every other theme and the derivation has one definition.
3. **Syntax token colours are derived.** `--syntax-muted/-code/-string/-number/-danger` keep
   their default hues (green strings, amber numbers, red deletions) but are mixed 20% toward the
   theme foreground and floored at 4.5:1 against the code background. Without this the
   Default palette's teal and green would leak into every theme's code.
4. **Explicit text slots are still contrast-floored** (`heading`, `link`, `mutedText` at
   4.5:1 against the surfaces they sit on); explicit surface slots (`codeBackground`,
   `codeBorder`, `tableHeaderBackground`, `tableBorder`, `rule`) are used verbatim. Cost: an
   author's low-contrast heading is nudged.
5. **Unmeasurable themes still get theme colours.** When background or foreground cannot be
   parsed as opaque (an imported `rgba()` theme), document colours are emitted as CSS
   `color-mix()` expressions over the theme's own values instead of being left at defaults.
   They skip contrast floors, as the sidebar tones already do.
6. **Paragraph spacing is measured in lines.** The gap between blocks is
   `paragraphSpacing × lineSpacing × fontSize`. Default 1.0 keeps Live mode exactly as today
   (one blank source line); Reading mode, which used 1em, now matches Live. Range 0.5 to 2.0,
   step 0.1. Below 1.0 the caret on a blank line is shorter than a text line; accepted.
7. **Reading mode follows zoom and line spacing.** It used a fixed `1.05rem / 1.65`; it now uses
   `--editor-font-size` and `--editor-line-height`, as Live does. Required for "same rendering".
8. **Readable width defaults on at 80ch** (range 60 to 120, step 5) and applies to Source mode
   too, so switching modes does not reflow the column. `ch` resolves in each mode's own font,
   so Source gets 80 monospace characters.
9. **Default line spacing becomes 1.7** (from 1.6). Users who stored a value keep it.
10. **Curated fonts: Inter, IBM Plex Serif, JetBrains Mono, IBM Plex Mono.** Inter and
    JetBrains Mono are already bundled; both new families come from one upstream project
    (IBM Plex), one licence. Body and heading may use any of the four; code may use the two
    monospace families. "System font by name" is available for all three.
11. **No UI font setting and no outline font in this PR.** Both change chrome, which #59 owns.
12. **No preset suggests fonts.** The theme font-suggestion fields work (import, export, apply)
    but Executive is the default theme for new installs, and changing its typeface is a larger
    product call than this issue. Cost: users choose a font themselves.
13. **Copied HTML carries no theme styles.** It is the same `renderMarkdown` markup as Reading
    mode, and the paste target styles it. Embedding colours and fonts would fight email and
    document editors. Cost if wrong: wrap the fragment in a styled `div` later.
14. **Inline code text uses the body colour in both modes** (Live used `--syntax-code`; Reading
    already inherited the body colour). Only its background marks it as code.
15. **Headings use the `heading` slot, falling back to `accent`**, in both modes. Reading mode
    used `--text-primary`, Live used the accent; they now agree.
16. **Mermaid diagrams use the document body font.**

## Architecture

### Colours (#54, #55)

`src/theme-colors.js` gains:

- `DOCUMENT_THEME_PROPERTIES`: the CSS custom properties that colour the document area:
  `--preview-code-bg`, `--preview-code-border`, `--preview-table-head-bg`,
  `--preview-table-border`, `--preview-hr`, `--preview-quote-bg`, `--preview-quote-border`,
  `--preview-quote-text`, `--preview-heading`, `--preview-link`, `--syntax-muted`,
  `--syntax-code`, `--syntax-string`, `--syntax-number`, `--syntax-danger`.
- `THEME_SLOTS`: slot name to property: `heading` `--preview-heading`, `codeBackground`
  `--preview-code-bg`, `codeBorder` `--preview-code-border`, `tableHeaderBackground`
  `--preview-table-head-bg`, `tableBorder` `--preview-table-border`, `rule` `--preview-hr`,
  `mutedText` `--text-muted`, `link` `--preview-link`.
- `deriveDocumentColors(theme, parseOpaqueColor = parseColor)`: returns a full map of
  `DOCUMENT_THEME_PROPERTIES` (never partial, never null for a theme with valid colours).

Derivation, with `bg`, `fg`, `accent` from the theme, `dark` = white contrasts more with `bg`
than black does, and `lift(d, l)` = `mix(bg, dark ? white : black, dark ? d : l)`:

| Property | Value |
| --- | --- |
| code background | slot, else `lift(0.05, 0.04)` |
| code border | slot, else `mix(codeBg, fg, 0.14)`, raised in 0.02 steps to at least 1.3:1 against `bg` |
| table header background | slot, else `lift(0.04, 0.03)` |
| table border | slot, else `lift(0.14, 0.12)`, raised to at least 1.3:1 against `bg` |
| rule (hr, H1/H2 underline) | slot, else `mix(bg, fg, 0.25)`, raised in 0.05 steps (max 0.6) to at least 1.5:1 against `bg` |
| quote background | `lift(0.03, 0.025)` |
| heading | slot, else `accent`; floored 4.5:1 against `bg` |
| quote bar | `mix(bg, heading, 0.6)` |
| quote text | `mix(fg, quoteBg, 0.2)`, floored 4.5:1 against `quoteBg` |
| link | slot, else `accent`; floored 4.5:1 against `bg` and `quoteBg` |
| syntax muted | `mix(fg, codeBg, 0.45)`, floored 4.5:1 against `codeBg` |
| syntax code/string/number/danger | default dark or light value (`#5eead4 #86efac #fbbf24 #fb7185` / `#047857 #15803d #b45309 #be123c`) mixed 0.2 toward `fg`, floored 4.5:1 against `codeBg` |

"Floored" means `ensureContrast` as used today. The `mutedText` slot, when set, replaces the
derived `--text-muted` and is floored 4.5:1 against the sidebar surfaces, the same as today's
derived value. When `bg` or `fg` is unmeasurable, the same table is emitted as `color-mix(in
srgb, …)` strings with no floors (Ruling 5).

Prototype numbers for the current presets (before Executive's retune): code background contrast
1.09 to 1.17, rule 1.35 to 2.24 before the floor, heading contrast already at least 4.5 except
Default Light, Solarized Dark/Light and Pastel Daydream, which the floor fixes.

`themes.js` `applyTheme` clears `DOCUMENT_THEME_PROPERTIES` with the other derived properties,
then sets the derived map. `clearCustomThemeStyles` clears them too. `normalizeCustomTheme` and
`parseThemeContent` keep valid slots (JSON: the camelCase names under the root or `colors`;
TOML/key-value: the lowercase name or its snake_case form, for example `codebackground` or
`code_background`); invalid slot values are dropped silently, like an invalid `sidebar` today.
`exportCurrentTheme` writes the slots the theme sets.

Executive (preset) adds: `heading #f2946c` (7.4:1 on `#181e21`), `codeBackground #1f2629`,
`codeBorder #2f383b`, `tableHeaderBackground #222a2d`, `tableBorder #353e42`,
`rule #3a4346` (1.66:1).

`styles.css`: the four default palette blocks gain the new properties with the values the
derivation gives Default Dark and Default Light. Document rules switch to the tokens:

- fenced code (Live layer `.cm-lp-codeblock-bg`, Reading `pre`): `--preview-code-bg`, 1px
  `--preview-code-border`, radius 8px; Live's fence header divider uses `--preview-code-border`.
- inline code: `--preview-code-bg`, text in the body colour.
- table: `th` background `--preview-table-head-bg`, cell borders `--preview-table-border`.
- `hr` and the Live rule widget: `--preview-hr`.
- blockquote: bar `--preview-quote-border`, background `--preview-quote-bg`, text
  `--preview-quote-text`.
- headings: `--preview-heading` (`.markdown-preview h1-h6`, `.cm-mode-live .cm-lp-h1-6`, and
  `.cm-editor .syntax-heading`).
- links: `--preview-link` (`.markdown-preview a`, `.cm-lp-link`, `.syntax-link`).
- find matches (Live and Reading, not the active one): `color-mix(in srgb,
  var(--accent-color) 30%, transparent)` instead of a hard-coded purple.
- the link-follow button background and the line-number gutter use `--preview-code-bg`
  instead of the chrome's `--bg-input`.

### Headings and spacing (#57)

New tokens on `:root`: `--paragraph-spacing: 1` and
`--doc-gap: calc(var(--paragraph-spacing) * var(--editor-line-height) * var(--editor-font-size))`.

| Level | Size | Padding top | Padding bottom | Rule |
| --- | --- | --- | --- | --- |
| H1 | 2.25em | 0.6em | 0.25em | 1px `--preview-hr` |
| H2 | 1.7em | 0.6em | 0.25em | 1px `--preview-hr` |
| H3 | 1.3em | 0.5em | 0.1em | none |
| H4 | 1.1em | 0.4em | 0.1em | none |
| H5 | 1em | 0.4em | 0.1em | none |
| H6 | 0.9em | 0.4em | 0.1em | none |

All headings: weight 700, line-height 1.25, letter-spacing -0.02em, font `--doc-font-heading`,
colour `--preview-heading`. Both modes use padding, not margin: CodeMirror measures line boxes
and must not see margins, and padding does not collapse in Reading mode, so the two modes add
up the same. Reading mode: every block (`p`, `ul`, `ol`, `pre`, `blockquote`, `table` box,
`hr`, headings, diagrams) has `margin: 0 0 var(--doc-gap)`; the first child's padding-top is 0.
Live mode: blank lines outside code, tables and HTML blocks get a `cm-lp-gap` line class with
`line-height: var(--doc-gap)`, so one blank source line equals one Reading gap. The H1/H2 rule
sits on the last text line of the heading (`cm-lp-heading-rule`), so a Setext heading gets one
rule, not one per line.

Settings: `paragraphSpacing` (key `sodilaud_paragraph_spacing`, default 1.0, 0.5 to 2.0, step
0.1, shown as `1.0×`) next to Line spacing; `DEFAULT_EDITOR_LINE_SPACING` becomes 1.7.

### Readable width and block edges (#58)

Settings: `readableWidth` (key `sodilaud_readable_width`, default true) and `contentWidth` (key
`sodilaud_content_width`, default 80, 60 to 120, step 5, shown as `80ch`), one row "Readable
width" with a stepper and an On/Off toggle; the stepper is disabled while off. Applied as the
root class `readable-width` and `--content-width: <n>ch`.

- Live and Source: `.cm-content` gets `max-width: calc(var(--content-width) + 48px)` (its 24px
  padding on each side) and `margin-inline: auto`. Gutters stay at the editor's left edge.
- Reading: `.markdown-preview` gets `padding-inline: max(24px, calc((100% - var(--content-width)) / 2))`.
- Common column: the outer edges of every block are the paragraph text edges. In Live mode the
  `.cm-line` inline padding (CodeMirror's 6px/2px) becomes 0, so text, table widgets, diagrams
  and hunk widgets start at the same x; code block lines get 14px inline padding inside the
  background box; quote lines keep their bar at the column edge. Reading `pre` padding becomes
  `12px 14px`. Wide tables keep scrolling inside `.table-scroll`.

### Fonts (#56)

Bundled: IBM Plex Mono 2.5.0 and IBM Plex Serif 2.0.0, from
`https://github.com/IBM/plex/releases` tags `@ibm/plex-mono@2.5.0` (`ibm-plex-mono.zip`, SHA-256
`6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c`) and
`@ibm/plex-serif@2.0.0` (`ibm-plex-serif.zip`, SHA-256
`c006b095c47b919c6c8d78319e9e628745033f5db94507c1c9dfe4b35dd51f1e`). From each zip's
`fonts/split/woff2/`, weights 400 and 700, upright and italic:

- Mono: subsets Latin1, Latin2, Pi (Pi carries box drawing and arrows used in code): 12 files,
  186,272 bytes.
- Serif: subsets Latin1, Latin2: 8 files, 162,352 bytes.
- Total 348,624 bytes (about 340 KiB). Estonian letters (õ ä ö ü in Latin1, š ž in Latin2) are
  covered.

`@font-face` rules copy each subset's `unicode-range` from the upstream per-weight CSS next to
the files, drop the upstream `local()` sources (bundled rendering must be the same on every
machine), and add `font-display: swap`. The licence file (`LICENSE.txt`, OFL 1.1, Reserved Font
Name "Plex") is stored as `src/vendor/fonts/IBMPlexMono-OFL.txt` and `IBMPlexSerif-OFL.txt`. The
files are used unmodified, which the Reserved Font Name requires.

New module `src/document-fonts.js`, pure plus one small controller:

- `CURATED_FONTS`: `inter` (Inter, sans), `ibm-plex-serif` (IBM Plex Serif, serif),
  `jetbrains-mono` (JetBrains Mono, mono), `ibm-plex-mono` (IBM Plex Mono, mono).
- A font value is `""` (automatic), a curated id, or `system:<name>` where the name matches
  `/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u` after trimming. Anything else normalizes to `""`.
- Resolution: body = user, else theme `fontBody`, else `inter`; heading = user, else theme
  `fontHeading`, else the body font; code = user, else theme `fontCode`, else `jetbrains-mono`.
  Code accepts only monospace curated ids or a system name.
- Stacks set on the root: `--doc-font-body`, `--doc-font-heading`, `--doc-font-code`. A system
  name is quoted and followed by the sans stack (body, heading) or the mono stack (code).
- Keys `sodilaud_font_body`, `sodilaud_font_heading`, `sodilaud_font_code`, shared between the
  windows like the other appearance keys.
- UI: three rows in the Appearance menu ("Body font", "Heading font", "Code font"), each a
  `<select>` whose first option is "Theme default (<resolved name>)", then the curated fonts,
  then "System font…", which shows a text field below the row; the name applies on Enter or
  blur and an invalid name is not stored.

CSS: `:root` defines `--doc-font-body: var(--font-sans)`, `--doc-font-heading:
var(--doc-font-body)`, `--doc-font-code: var(--font-mono)`. Live `.cm-content`, Reading
`.markdown-preview` and the Live table widget use the body font; headings the heading font;
inline code, code blocks, diff hunks and Source mode the code font. The UI keeps `--font-sans`.

Theme font suggestions are optional theme fields `fontBody`, `fontHeading`, `fontCode`, carried
by import and export and validated by the same normalizer.

## Data flow

1. Start-up: each window calls `themes.load()`, `appearance.load()` and `fonts.load()`.
2. `applyTheme` clears derived properties, sets base colours, sidebar tones and the document
   map, then `onApplied`. The page's `onApplied` re-applies fonts (theme suggestions may have
   changed) and re-themes Mermaid.
3. A setting change persists its key and broadcasts it; the other window's
   `followPreferenceChange` passes the key to `appearance.reload` and `fonts.reload`.

## Edge cases

- Theme with only background and foreground: all document properties derived.
- Imported theme with `rgba()` background: `color-mix()` fallback, no defaults leak.
- Invalid slot value (`url(...)`, `var(--x)`): dropped by `isValidColor`, derivation used.
- System font not installed: the fallback stack renders; no error.
- Font name with quotes, semicolons or braces: rejected, setting stays as it was.
- Narrow window: readable width never adds padding beyond the window; `max()` keeps 24px.
- Split and compare views: each pane is narrower than the column, so nothing changes.
- Paragraph spacing below 1.0: blank-line caret shortens (Ruling 6).
- Default Dark/Light: static CSS values equal the derivation (Ruling 2).

## Testing

- `test/theme-colors.test.js`: derivation table, floors, slots, unmeasurable fallback.
- `test/theme-document-colors.test.js` (new): for every preset except the two defaults, boot the
  app with that theme and assert every `DOCUMENT_THEME_PROPERTIES` entry is set on the root and
  differs from both default palettes' values; a static scan of `styles.css` asserts document
  rules use only allowed tokens and no colour literals; the default blocks equal the derivation.
- `test/theme-input-validation.test.js` / a new slots test: import, normalize and export slots.
- `test/view-preferences.test.js`, `test/view-settings.test.js`: new settings, ranges, storage,
  sharing between windows.
- `test/editor-live-preview.test.js`: gap and heading-rule line classes.
- `test/document-fonts.test.js` (new): normalization, resolution, stacks, UI behaviour.
- `test/font-vendor.test.js` (new): every referenced font file exists, licences present, no
  `local()`, no remote URL.
- Manual run in the app: switch through all presets; compare Live and Reading of one document
  for scale, rules, spacing, width and fonts.
