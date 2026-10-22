# Document Styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Theme-derived document colours with optional theme slots, a stronger heading scale, paragraph spacing, readable width with aligned block edges, and configurable document fonts, in Live, Source and Reading mode.

**Architecture:** Colours are derived in `src/theme-colors.js` and set as CSS custom properties on the root by `src/themes.js`. Spacing and width are appearance settings in `src/appearance.js` exposed as CSS variables and a root class. Fonts are a new module `src/document-fonts.js` that sets three font-stack variables. `styles.css` reads only these tokens in the document area.

**Tech Stack:** Vanilla ES modules, CodeMirror 6 (vendored), jsdom + `node:test`, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-10-18-document-styling-design.md`

## Global Constraints

- Work only in `/Users/laas/proged/sodilaud/.claude/worktrees/document-styling` (branch `feat/document-styling`). Use absolute paths. Never `cd` into `src/vendor` or `node_modules`. Do not run `npm ci` (`node_modules` is a symlink).
- JS tests always run capped: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test <files>`.
- New JS source files go into the `check:js` script in `package.json`.
- Zero runtime network egress. Fonts are vendored files under `src/vendor/fonts/`; no CDN, no `local()` font sources. CSP is unchanged.
- Do not touch sidebar, status bar, title bar or menu chrome styling (another branch owns it). The Appearance menu gets new rows only.
- `renderMarkdown` stays the only HTML path. Copied HTML gets no theme styles.
- No em dashes anywhere (use `-`). No mention of AI, agents or Claude in code, commits or docs. Commit format `type(scope): description`. Code comments only where the why is non-obvious.
- Do not edit `RELEASE_NOTES.md`.
- Document colour properties (exact list, in this order): `--preview-code-bg`, `--preview-code-border`, `--preview-table-head-bg`, `--preview-table-border`, `--preview-hr`, `--preview-quote-bg`, `--preview-quote-border`, `--preview-quote-text`, `--preview-heading`, `--preview-link`, `--syntax-muted`, `--syntax-code`, `--syntax-string`, `--syntax-number`, `--syntax-danger`.
- Theme slots: `heading`, `codeBackground`, `codeBorder`, `tableHeaderBackground`, `tableBorder`, `rule`, `mutedText`, `link`.
- Storage keys: `sodilaud_paragraph_spacing` (default 1.0, 0.5-2.0, step 0.1), `sodilaud_readable_width` (default true), `sodilaud_content_width` (default 80, 60-120, step 5), `sodilaud_font_body`, `sodilaud_font_heading`, `sodilaud_font_code` (default `""`). `DEFAULT_EDITOR_LINE_SPACING` = 1.7.
- Heading scale (em of body): H1 2.25, H2 1.7, H3 1.3, H4 1.1, H5 1, H6 0.9; weight 700; line-height 1.25; letter-spacing -0.02em.
- The 4 MCP socket tests fail only inside the sandbox; that is expected.

## Review Focus

- Switching from a slot-setting theme (Executive) to one without slots must not keep Executive's slot values: every document property is cleared before applying. Pinned in Task 2.
- Switching from any custom theme back to Default Dark/Light must remove every document property from the root, or the previous theme's code background stays. Pinned in Task 1.
- A system font name typed with quotes, `;`, `{` or `url(` must be rejected and never reach `style.setProperty`. Pinned in Task 7.
- A change made in the main window (spacing, width, font) must reach the open Quick Notes window without a restart. Pinned in Tasks 4, 5 and 7.
- Blank lines inside fenced code must keep full line height in Live mode, or code with empty lines collapses. Pinned in Task 4.

---

### Task 1: Derive document colours from the theme (#54)

**Files:**
- Modify: `src/theme-colors.js` (add exports after `deriveThemeSurfaceColors`, line 174)
- Modify: `src/themes.js:155-223` (`applyTheme`, `clearCustomThemeStyles`)
- Modify: `src/styles.css` (palette blocks at lines 141-315; document rules around 1534-1555, 1596-1620, 1654-1920, 3435-3600)
- Test: `test/theme-colors.test.js`, new `test/theme-document-colors.test.js`, `test/editor-styles.test.js`

**Interfaces:**
- Produces: `DOCUMENT_THEME_PROPERTIES: string[]` (the 15 properties from Global Constraints, in that order); `deriveDocumentColors(theme, parseOpaqueColor = parseColor): Record<string,string>` returning every property in `DOCUMENT_THEME_PROPERTIES`, or `null` only when `theme` is falsy. Also `DEFAULT_SYNTAX = { dark: {code:"#5eead4", string:"#86efac", number:"#fbbf24", danger:"#fb7185"}, light: {code:"#047857", string:"#15803d", number:"#b45309", danger:"#be123c"} }` (exported for tests).
- Task 2 extends `deriveDocumentColors` with slots; keep each derived value computed in one place so a slot can replace it.

Derivation (`dark` = `contrastRatio(WHITE,bg) > contrastRatio(BLACK,bg)`; `lift(d,l)` = `mix(bg, dark ? WHITE : BLACK, dark ? d : l)`; all results `toHex(quantize(...))`):

| Property | Value |
| --- | --- |
| `--preview-code-bg` | `lift(0.05, 0.04)` |
| `--preview-code-border` | `mix(codeBg, fg, t)`, t from 0.14 up by 0.02 until contrast with `bg` >= 1.3 (max 0.6) |
| `--preview-table-head-bg` | `lift(0.04, 0.03)` |
| `--preview-table-border` | `lift(d, l)` from (0.14, 0.12) up by 0.02 until contrast with `bg` >= 1.3 (max 0.6) |
| `--preview-hr` | `mix(bg, fg, t)`, t from 0.25 up by 0.05 until contrast with `bg` >= 1.5 (max 0.6) |
| `--preview-quote-bg` | `lift(0.03, 0.025)` |
| `--preview-heading` | `ensureContrast(accent ?? fg, [bg], 4.5)` |
| `--preview-quote-border` | `mix(bg, heading, 0.6)` |
| `--preview-quote-text` | `ensureContrast(mix(fg, quoteBg, 0.2), [quoteBg], 4.5)` |
| `--preview-link` | `ensureContrast(accent ?? fg, [bg, quoteBg], 4.5)` |
| `--syntax-muted` | `ensureContrast(mix(fg, codeBg, 0.45), [codeBg], 4.5)` |
| `--syntax-code/-string/-number/-danger` | `ensureContrast(mix(DEFAULT_SYNTAX[dark?"dark":"light"][k], fg, 0.2), [codeBg], 4.5)` |

When `parseOpaqueColor` cannot read `background` or `foreground`, darkness is unknown, so every lift mixes toward the foreground instead: return the same keys as `color-mix(in srgb, <background> P%, <foreground>)` strings built from the theme's raw (already `isValidColor`-validated) values, with P = 100 minus the dark-theme lift percentage (code 95, table head 96, table border 86, quote 97), the rule at 75, the code border at 86 over the code background expression, heading and link as the raw `accent` (or `foreground`), quote text and syntax colours as `color-mix(in srgb, <foreground> 80%, <default dark syntax colour>)` and `--syntax-muted` at `<foreground> 55%`. No floors.

- [ ] **Step 1: Write failing unit tests in `test/theme-colors.test.js`**

```js
test("deriveDocumentColors returns every document property for every preset", () => {
  for (const theme of PRESET_THEMES) {
    const colors = deriveDocumentColors(theme);
    assert.deepEqual(Object.keys(colors).sort(), [...DOCUMENT_THEME_PROPERTIES].sort(), theme.id);
  }
});
test("document text colours clear 4.5:1 on the surfaces they sit on", () => {
  for (const theme of PRESET_THEMES) {
    const c = deriveDocumentColors(theme);
    assert.ok(ratio(c["--preview-heading"], theme.background) >= 4.5, theme.id);
    assert.ok(ratio(c["--preview-link"], c["--preview-quote-bg"]) >= 4.5, theme.id);
    assert.ok(ratio(c["--preview-quote-text"], c["--preview-quote-bg"]) >= 4.5, theme.id);
    for (const k of ["--syntax-muted", "--syntax-code", "--syntax-string", "--syntax-number", "--syntax-danger"])
      assert.ok(ratio(c[k], c["--preview-code-bg"]) >= 4.5, `${theme.id} ${k}`);
  }
});
test("rules are visible but soft and code blocks sit just off the page", () => {
  for (const theme of PRESET_THEMES) {
    const c = deriveDocumentColors(theme);
    const hr = ratio(c["--preview-hr"], theme.background);
    assert.ok(hr >= 1.5 && hr <= 3, `${theme.id} hr ${hr}`);
    const code = ratio(c["--preview-code-bg"], theme.background);
    assert.ok(code > 1 && code < 1.3, `${theme.id} code ${code}`);
    assert.ok(ratio(c["--preview-table-border"], theme.background) >= 1.3, theme.id);
  }
});
test("an unmeasurable theme gets color-mix values, not nothing", () => {
  const c = deriveDocumentColors({ background: "rgba(10,10,10,0.9)", foreground: "#eeeeee", accent: "#ff8800" });
  for (const p of DOCUMENT_THEME_PROPERTIES) assert.match(c[p], /^(#|color-mix\()/, p);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/theme-colors.test.js`
Expected: FAIL, `deriveDocumentColors` is not exported.

- [ ] **Step 3: Implement `DOCUMENT_THEME_PROPERTIES`, `DEFAULT_SYNTAX` and `deriveDocumentColors` in `src/theme-colors.js`** per the table above. Add `...DOCUMENT_THEME_PROPERTIES` to `DERIVED_THEME_PROPERTIES` so `applyTheme`'s existing clear loop and `clearCustomThemeStyles` remove them.

- [ ] **Step 4: Run the unit tests; expect PASS.**

- [ ] **Step 5: Write `test/theme-document-colors.test.js` (app-level, fails first)**

```js
import { bootApp } from "./helpers/app-harness.js";
import { PRESET_THEMES } from "../src/preset-themes.js";
import { DOCUMENT_THEME_PROPERTIES, deriveDocumentColors } from "../src/theme-colors.js";
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
// Values of each property inside `html.theme-dark { ... }` and `html.theme-light { ... }`.
function paletteBlock(selector) { /* regex the block body, return Map(prop -> value) */ }
const defaults = { dark: paletteBlock("html.theme-dark"), light: paletteBlock("html.theme-light") };

test("no preset shows a Default Dark or Light colour in the document area", async () => {
  for (const theme of PRESET_THEMES.filter(t => !t.id.startsWith("default-"))) {
    await bootApp({ storage: { sodilaud_active_theme: theme.id } });
    const root = document.documentElement;
    for (const prop of DOCUMENT_THEME_PROPERTIES) {
      const value = root.style.getPropertyValue(prop);
      assert.ok(value, `${theme.id} sets ${prop}`);
      assert.notEqual(value, defaults.dark.get(prop), `${theme.id} ${prop} leaks Default Dark`);
      assert.notEqual(value, defaults.light.get(prop), `${theme.id} ${prop} leaks Default Light`);
    }
  }
});
test("Default Dark and Light declare the derived document colours", () => {
  for (const [id, block] of [["default-dark", defaults.dark], ["default-light", defaults.light]]) {
    const derived = deriveDocumentColors(PRESET_THEMES.find(t => t.id === id));
    for (const prop of DOCUMENT_THEME_PROPERTIES) assert.equal(block.get(prop), derived[prop], `${id} ${prop}`);
  }
  // the :root and @media blocks match theme-light and theme-dark respectively
});
test("going back to Default Dark removes every document property from the root", async () => {
  await bootApp({ storage: { sodilaud_active_theme: "executive" } });
  /* trigger theme change to default-dark via the theme grid or storage + preference event, as theme-switch.test.js does */
  for (const prop of DOCUMENT_THEME_PROPERTIES) assert.equal(document.documentElement.style.getPropertyValue(prop), "", prop);
});
```

Also add to `test/editor-styles.test.js`:

```js
test("document-area rules use theme tokens, never colour literals", () => {
  // Rules whose selector contains .markdown-preview, .cm-lp- or .cm-mode-live, or is
  // .cm-editor .syntax-heading/.syntax-link/.syntax-code, excluding selectors containing
  // .diff-, .mermaid-error, .cm-comment, find-preview-match.active-match, .cm-find-active.
  // For declarations color, background, background-color, border*, box-shadow, outline*,
  // accent-color, text-decoration-color: no #hex, rgb(, rgba(, hsl( literal, and every
  // var(--x) is in DOCUMENT_THEME_PROPERTIES or ALLOWED_BASE.
  const ALLOWED_BASE = ["--preview-bg", "--preview-text", "--editor-bg", "--editor-text", "--text-primary",
    "--text-secondary", "--text-muted", "--accent-color", "--accent-hover", "--border-color", "--bg-app"];
});
```

- [ ] **Step 6: Run the new tests; expect FAIL** (themes do not set the properties yet; CSS still uses `--bg-input`, hex purples, `--border-color` for tables).

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/theme-document-colors.test.js test/editor-styles.test.js`

- [ ] **Step 7: Apply in `src/themes.js`.** In `applyTheme`, after the `deriveThemeSurfaceColors` block (line 192), set every entry of `deriveDocumentColors(theme, parseOpaqueThemeColor)`. The clear at line 159 and `clearCustomThemeStyles` already cover the new properties through `DERIVED_THEME_PROPERTIES`.

- [ ] **Step 8: Update `src/styles.css`.**
  - In all four palette blocks (`:root` light, `@media (prefers-color-scheme: dark) :root`, `html.theme-light`, `html.theme-dark`) set the 15 properties to `deriveDocumentColors` of the Default Light / Default Dark preset (print them with a one-off `node -e` and paste; do not commit the script).
  - Fenced code: `.cm-lp-codeblock-bg` and `.markdown-preview pre` use `border: 1px solid var(--preview-code-border)`, radius 8px, background `--preview-code-bg`; `.cm-mode-live .cm-lp-codeblock-head` divider uses `--preview-code-border`.
  - Inline code: `.markdown-preview code` and `.cm-mode-live .cm-lp-code` background `--preview-code-bg`; add `.cm-mode-live .cm-lp-code, .cm-mode-live .cm-lp-code .syntax-code { color: inherit; }` so inline code text is the body colour.
  - Tables: `.markdown-preview th` background `--preview-table-head-bg`; `th, td` border `--preview-table-border`.
  - `hr` and `.cm-lp-hr-widget`: `--preview-hr`; H1/H2 border in Reading already uses `--preview-hr`.
  - Blockquote (both modes): bar `--preview-quote-border`, background `--preview-quote-bg`, text `--preview-quote-text`.
  - Headings: `.markdown-preview h1..h6`, `.cm-mode-live .cm-lp-h1..h6` and `.cm-editor .syntax-heading` colour `--preview-heading`.
  - Links: `.markdown-preview a`, `.markdown-preview a:hover`, `.cm-mode-live .cm-lp-link`, `.cm-editor .syntax-link` colour `--preview-link`.
  - Find matches: `.cm-editor .cm-find-match` and `.markdown-preview mark.find-preview-match` background `color-mix(in srgb, var(--accent-color) 30%, transparent)`; active matches keep their yellow.
  - `.cm-lp-follow` background and `.editor-host .cm-editor .cm-gutters` background use `--preview-code-bg` instead of `--bg-input`.

- [ ] **Step 9: Run Task 1 tests plus the theme suite; expect PASS.**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/theme-colors.test.js test/theme-document-colors.test.js test/editor-styles.test.js test/theme-apply.test.js test/theme-switch.test.js test/theme-default.test.js test/theme-non-hex.test.js test/theme-unmeasurable.test.js test/mermaid.test.js`

- [ ] **Step 10: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/theme-colors.js src/themes.js src/styles.css test/theme-colors.test.js test/theme-document-colors.test.js test/editor-styles.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "feat(themes): derive document colours from the active theme"
```

---

### Task 2: Optional theme colour slots and retuned Executive (#55)

**Files:**
- Modify: `src/theme-colors.js` (`deriveDocumentColors`, add `THEME_SLOTS`)
- Modify: `src/themes.js` (`applyTheme` mutedText, `normalizeCustomTheme` 225-240, `parseThemeContent` 390-485, `exportCurrentTheme` 487-510)
- Modify: `src/preset-themes.js:180-189` (Executive)
- Test: new `test/theme-slots.test.js`, `test/theme-colors.test.js`

**Interfaces:**
- Consumes: `deriveDocumentColors`, `DOCUMENT_THEME_PROPERTIES` from Task 1.
- Produces: `THEME_SLOTS: Record<string,string>` = `{ heading: "--preview-heading", codeBackground: "--preview-code-bg", codeBorder: "--preview-code-border", tableHeaderBackground: "--preview-table-head-bg", tableBorder: "--preview-table-border", rule: "--preview-hr", mutedText: "--text-muted", link: "--preview-link" }`. Theme objects may carry any of these keys as colour strings.

Rules: a valid slot replaces the derived value before dependants are computed (code border, syntax colours and `--syntax-muted` use the slot code background; quote bar uses the slot heading). Text slots (`heading`, `link`) are floored 4.5:1 as in Task 1; surface slots are used verbatim (after `isValidColor`, untouched string). `mutedText` is applied in `applyTheme` after `deriveThemeSurfaceColors`: if measurable, `ensureContrast(mutedText, [background, sidebar], 4.5)`, else the raw value.

- [ ] **Step 1: Write failing tests in `test/theme-slots.test.js`**

```js
test("a slot replaces its derived value and feeds the values that depend on it", () => {
  const base = { background: "#181e21", foreground: "#fdc78e", accent: "#1e959d" };
  const c = deriveDocumentColors({ ...base, codeBackground: "#202020", heading: "#f2946c" });
  assert.equal(c["--preview-code-bg"], "#202020");
  assert.equal(c["--preview-heading"], "#f2946c");
  assert.equal(c["--preview-quote-border"], toHex(mix(parseColor("#181e21"), parseColor("#f2946c"), 0.6)));
  assert.ok(ratio(c["--syntax-code"], "#202020") >= 4.5);
});
test("a low-contrast heading slot is floored to 4.5:1", () => { /* heading #1a2024 on #181e21 */ });
test("JSON import keeps valid slots and drops invalid ones", async () => {
  // boot main window, import {"name":"S","background":"#111111","foreground":"#eeeeee",
  //   "heading":"#ff8800","codeBackground":"url(x)","tableBorder":"var(--x)","rule":"#333333"}
  // stored custom theme has heading and rule, no codeBackground or tableBorder
});
test("TOML import accepts lowercase and snake_case slot names", async () => { /* code_background = "#222222", tableheaderbackground = "#333333" */ });
test("export writes the slots the active theme sets", async () => { /* capture Blob text, as existing export tests do */ });
test("switching from Executive to Nord leaves no Executive slot value behind", async () => {
  // boot with executive, apply nord; --preview-heading equals deriveDocumentColors(nord) value
});
test("a mutedText slot sets --text-muted, floored against the sidebar", async () => {});
test("Executive headings are warm and its table header is neutral", () => {
  const exec = PRESET_THEMES.find(t => t.id === "executive");
  assert.equal(exec.heading, "#f2946c");
  assert.equal(exec.tableHeaderBackground, "#222a2d");
});
```

Find the existing import/export test helpers in `test/theme-input-validation.test.js` and reuse their approach for driving import (`processImportedTheme` via the Import button and a fake `import_file_native` handler).

- [ ] **Step 2: Run; expect FAIL.**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/theme-slots.test.js`

- [ ] **Step 3: Implement slots** in `deriveDocumentColors` (read each slot with `parseOpaqueColor`; an unparseable but valid slot string is used verbatim for surfaces and unfloored for text), `THEME_SLOTS` export, `mutedText` in `applyTheme`, a shared `pickSlots(source, isKv)` helper in `themes.js` used by `normalizeCustomTheme` and both branches of `parseThemeContent` (JSON: `colors[slot]`; kv: `kv[slot.toLowerCase()] ?? kv[snake_case(slot)]`), and `exportCurrentTheme` adding each slot the active theme has.

- [ ] **Step 4: Retune Executive** in `src/preset-themes.js`: add `heading: "#f2946c"`, `codeBackground: "#1f2629"`, `codeBorder: "#2f383b"`, `tableHeaderBackground: "#222a2d"`, `tableBorder: "#353e42"`, `rule: "#3a4346"`. Keep the six base colours unchanged.

- [ ] **Step 5: Run slots, colour and theme suites; expect PASS** (Task 1's leak test must still pass with Executive's slots).

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/theme-slots.test.js test/theme-colors.test.js test/theme-document-colors.test.js test/theme-input-validation.test.js test/theme-apply.test.js test/theme-switch.test.js`

- [ ] **Step 6: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/theme-colors.js src/themes.js src/preset-themes.js test/theme-slots.test.js test/theme-colors.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "feat(themes): add optional document colour slots and retune Executive"
```

---

### Task 3: Heading scale and H1/H2 rules, same in Live and Reading (#57)

**Files:**
- Modify: `src/styles.css` (`.markdown-preview` 1654-1682 and block rules 1684-1900; `.cm-mode-live .cm-lp-h*` 3439-3455)
- Modify: `src/editor-live-preview.js:419-425` (line classes) and the heading branch at ~583-588 in `buildInline`
- Modify: `src/view-preferences.js:8` (`DEFAULT_EDITOR_LINE_SPACING = 1.7`)
- Modify: `src/index.html:121` (initial label `1.7×`)
- Test: `test/editor-live-preview.test.js`, `test/editor-styles.test.js`, `test/view-preferences.test.js`

**Interfaces:**
- Produces: CSS tokens on `:root`: `--paragraph-spacing: 1;` and `--doc-gap: calc(var(--paragraph-spacing) * var(--editor-line-height) * var(--editor-font-size));` (Task 4 sets `--paragraph-spacing`). Live line class `cm-lp-heading-rule` on the last text line of an H1 or H2.

Values (both modes; sizes in em of the body text):

| Level | font-size | padding-top | padding-bottom | rule |
| --- | --- | --- | --- | --- |
| H1 | 2.25em | 0.6em | 0.25em | `border-bottom: 1px solid var(--preview-hr)` |
| H2 | 1.7em | 0.6em | 0.25em | same |
| H3 | 1.3em | 0.5em | 0.1em | none |
| H4 | 1.1em | 0.4em | 0.1em | none |
| H5 | 1em | 0.4em | 0.1em | none |
| H6 | 0.9em | 0.4em | 0.1em | none |

All headings: `font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; font-family: var(--doc-font-heading, inherit)`. Use padding, never margin, on Live lines (CodeMirror measures line boxes). In Live the rule goes on `.cm-lp-heading-rule`, not on `.cm-lp-h1`.

Reading mode: `.markdown-preview` uses `font-size: var(--editor-font-size); line-height: var(--editor-line-height)` (was `1.05rem`/`1.65`); headings and every block (`p, ul, ol, pre, blockquote, .table-scroll, hr, .mermaid-diagram, figure, h1-h6`) get `margin: 0 0 var(--doc-gap)`; `.markdown-preview > :first-child { padding-top: 0; }`; heading sizes switch from `rem` to `em`. `.markdown-preview hr` keeps `margin-bottom: var(--doc-gap)` and gets `margin-top: 0`. Reading `h5, h6` get rules too (currently none).

- [ ] **Step 1: Write failing tests.**

```js
// test/editor-live-preview.test.js
test("H1 and H2 carry a rule on their last text line, H3 does not", async () => {
  const t = await setup("# One\n\n## Two\n\n### Three\n\nSetext\nheading\n===\n\nbody", { focused: false });
  const ruled = t.lines().filter(l => l.classList.contains("cm-lp-heading-rule")).map(l => l.textContent);
  assert.deepEqual(ruled, ["One", "Two", "heading"]);
});
// test/editor-styles.test.js
test("Live and Reading use the same heading scale", () => {
  // parse font-size for `.markdown-preview hN` and `.cm-mode-live .cm-lp-hN`; both equal
  // ["2.25em","1.7em","1.3em","1.1em","1em","0.9em"][N-1]; weight 700 in both
});
test("Live heading lines use padding, not margin", () => { /* no margin* declaration in .cm-mode-live .cm-lp-h* rules */ });
test("Reading mode follows editor zoom and line spacing", () => { /* .markdown-preview font-size var(--editor-font-size), line-height var(--editor-line-height) */ });
// test/view-preferences.test.js
test("default line spacing is 1.7", () => assert.equal(DEFAULT_EDITOR_LINE_SPACING, 1.7));
```

- [ ] **Step 2: Run; expect FAIL.**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/editor-live-preview.test.js test/editor-styles.test.js test/view-preferences.test.js`

- [ ] **Step 3: Implement.** In `editor-live-preview.js` add `lineClasses["h1-rule"]` and `["h2-rule"]` as `Decoration.line({ class: "cm-lp-h1 cm-lp-heading-rule" })` (and h2); in the heading branch mark lines `from..textEnd` with `hN`, then overwrite the last text line's entry with `hN-rule` for levels 1 and 2 (the `lineDecorations` map keeps one decoration per line; set it directly for that line). Then the CSS from the table above, the `:root` tokens, and the line-spacing default (`src/view-preferences.js`, `src/index.html` label, `--editor-line-height: 1.7` in `:root` at `styles.css:128`).

- [ ] **Step 4: Run Step 2's command plus `test/view-settings.test.js test/markdown.test.js test/file-editor.test.js`; expect PASS.** Update any assertion that hard-codes `1.6×` as the default to `1.7×`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/styles.css src/editor-live-preview.js src/view-preferences.js src/index.html test
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "feat(editor): stronger heading scale with H1 and H2 rules in Live and Reading"
```

---

### Task 4: Paragraph spacing setting (#57)

**Files:**
- Modify: `src/view-preferences.js` (constants and normalize/step functions)
- Modify: `src/appearance.js` (key, state, control, apply, load, reload, getter)
- Modify: `src/index.html:116-124` (new row after Line spacing)
- Modify: `src/editor-live-preview.js` (`buildInline`: gap line class)
- Modify: `src/styles.css` (`.cm-mode-live .cm-lp-gap`)
- Test: `test/view-preferences.test.js`, `test/view-settings.test.js`, `test/editor-live-preview.test.js`

**Interfaces:**
- Consumes: `--doc-gap` and `--paragraph-spacing` tokens from Task 3.
- Produces: in `view-preferences.js`: `DEFAULT_PARAGRAPH_SPACING = 1`, `MIN_PARAGRAPH_SPACING = 0.5`, `MAX_PARAGRAPH_SPACING = 2`, `PARAGRAPH_SPACING_STEP = 0.1`, `normalizeParagraphSpacing(value): number`, `stepParagraphSpacing(value, direction): number`. In `appearance.js`: `APPEARANCE_KEYS.paragraphSpacing = "sodilaud_paragraph_spacing"`, `applyParagraphSpacing(value, { persist })`, getter `paragraphSpacing`. DOM ids: `paragraph-spacing-decrease-btn`, `paragraph-spacing-value`, `paragraph-spacing-increase-btn`. Root property `--paragraph-spacing` (unitless string, e.g. `"1.2"`). Live line class `cm-lp-gap`.

- [ ] **Step 1: Write failing tests.**

```js
// view-preferences
test("paragraph spacing normalizes to 0.5-2.0 in 0.1 steps", () => {
  assert.equal(normalizeParagraphSpacing("abc"), 1);
  assert.equal(normalizeParagraphSpacing(0.1), 0.5);
  assert.equal(normalizeParagraphSpacing(9), 2);
  assert.equal(stepParagraphSpacing(1, 1), 1.1);
});
// view-settings: extend the labels assertion to
// ["Editor zoom", "Line spacing", "Paragraph spacing", "Syntax highlighting", "Line numbers"]
// (Task 5 and Task 7 extend it again); then:
test("paragraph spacing is adjustable, persistent and shared", async () => {
  // click increase: --paragraph-spacing "1.1", label "1.1×", storage key "1.1", broadcast seen;
  // clicking the value resets to "1.0×"; decrease disabled at 0.5.
  // Quick Notes window: bootApp with storage set, then fire the preference-change for the key and
  // assert its root --paragraph-spacing updated (copy how view-settings.test.js checks lineSpacing sharing).
});
// editor-live-preview
test("blank lines between blocks are gaps, blank lines in code are not", async () => {
  const t = await setup("para\n\npara\n\n```\na\n\nb\n```\n", { focused: false });
  const gaps = t.lines().map(l => l.classList.contains("cm-lp-gap"));
  assert.deepEqual(gaps, [false, true, false, true, false, false, false, false, false, false]);
});
```

Adjust the expected array to the real line count the fixture produces; the point is: only the two blank lines outside the fence are gaps.

- [ ] **Step 2: Run; expect FAIL.**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/view-preferences.test.js test/view-settings.test.js test/editor-live-preview.test.js`

- [ ] **Step 3: Implement.** Settings mirror line spacing exactly (label `${value.toFixed(1)}×`, value button resets). In `buildInline`, after the tree walk, for each line in `view.visibleRanges` whose text is whitespace-only, has no entry in `lineDecorations`, and whose position resolves (`syntaxTree(state).resolveInner(line.from, 1)`) with no ancestor named `FencedCode`, `CodeBlock`, `HTMLBlock` or `Table`, add `Decoration.line({ class: "cm-lp-gap" })`. CSS: `.cm-mode-live .cm-lp-gap { line-height: var(--doc-gap); }`. Markup row in `index.html` copies the Line spacing row with label "Paragraph spacing", value `1.0×`, titles "Decrease paragraph spacing" / "Reset paragraph spacing" / "Increase paragraph spacing".

- [ ] **Step 4: Run Step 2's command; expect PASS.**

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/view-preferences.js src/appearance.js src/index.html src/editor-live-preview.js src/styles.css test
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "feat(editor): add a paragraph spacing setting"
```

---

### Task 5: Readable content width and aligned block edges (#58)

**Files:**
- Modify: `src/view-preferences.js`, `src/appearance.js`, `src/index.html` (row after Paragraph spacing)
- Modify: `src/styles.css` (`.editor-host .cm-editor .cm-content` 1539-1544; `.markdown-preview` 1654; Live line, code block, quote, table rules 3435-3600; Reading `pre`)
- Test: `test/view-preferences.test.js`, `test/view-settings.test.js`, `test/editor-styles.test.js`

**Interfaces:**
- Produces: `DEFAULT_READABLE_WIDTH = true`, `DEFAULT_CONTENT_WIDTH = 80`, `MIN_CONTENT_WIDTH = 60`, `MAX_CONTENT_WIDTH = 120`, `CONTENT_WIDTH_STEP = 5`, `normalizeReadableWidth(value): boolean` (same parsing as `normalizeEditorLineNumbers`), `normalizeContentWidth(value): number` (rounded to the nearest 5, clamped), `stepContentWidth(value, direction): number`. `APPEARANCE_KEYS.readableWidth = "sodilaud_readable_width"`, `APPEARANCE_KEYS.contentWidth = "sodilaud_content_width"`, `applyReadableWidth(enabled, opts)`, `applyContentWidth(value, opts)`, getters. DOM ids: `content-width-decrease-btn`, `content-width-value`, `content-width-increase-btn`, `readable-width-toggle`. Root class `readable-width`; root property `--content-width: <n>ch`.

CSS:
- `html.readable-width .editor-host .cm-editor .cm-content { max-width: calc(var(--content-width) + 48px); margin-inline: auto; }` (applies in Live and Source).
- `html.readable-width .markdown-preview { padding-inline: max(24px, calc((100% - var(--content-width)) / 2)); }`
- `.cm-editor.cm-mode-live .cm-line { padding-inline: 0; }`; `.cm-mode-live .cm-lp-codeblock { padding-inline: 14px; }`; `.markdown-preview pre { padding: 12px 14px; }`. The code block background layer already spans the line box, which is now the column.
- Live table widget, Mermaid widget, hunk widget: `margin-inline: 0`, so their outer edge is the column.

- [ ] **Step 1: Write failing tests.**

```js
test("content width normalizes to 60-120 in steps of 5", () => {
  assert.equal(normalizeContentWidth("x"), 80);
  assert.equal(normalizeContentWidth(83), 85);
  assert.equal(normalizeContentWidth(200), 120);
  assert.equal(stepContentWidth(80, -1), 75);
  assert.equal(normalizeReadableWidth(undefined), true);
});
test("readable width is on by default and can be turned off and resized", async () => {
  // bootMainWindow with empty storage: root has class readable-width, --content-width "80ch",
  // #content-width-value "80ch", toggle "On"/aria-pressed true. Click increase: "85ch", key "85".
  // Click toggle: class removed, stepper buttons disabled, key "false". Quick Notes window follows a
  // broadcast of each key.
});
test("Live lines have no inline padding so blocks share the text column", () => {
  // editor-styles: rule `.cm-editor.cm-mode-live .cm-line` has padding-inline: 0
});
```

Extend the labels list in `view-settings.test.js` to include "Readable width" after "Paragraph spacing".

- [ ] **Step 2: Run; expect FAIL.**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/view-preferences.test.js test/view-settings.test.js test/editor-styles.test.js`

- [ ] **Step 3: Implement** settings (pattern of zoom for the stepper, of line numbers for the toggle; the stepper is disabled while off), markup row "Readable width" with the stepper then the toggle, and the CSS above.

- [ ] **Step 4: Run Step 2's command plus `test/editor-live-preview.test.js test/split-view.test.js test/table-exit-integration.test.js`; expect PASS.**

- [ ] **Step 5: Manual check.** Start the app from this worktree (`npm run tauri -- dev`, run by the user if the sandbox blocks it). In a wide window confirm in Live, Source and Reading: text centred in about 80 characters; paragraph, heading rule, table, code block box, blockquote bar and hr share left and right edges; a wide table scrolls inside the column; line numbers stay at the left edge.

- [ ] **Step 6: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/view-preferences.js src/appearance.js src/index.html src/styles.css test
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "feat(editor): readable content width with aligned block edges"
```

---

### Task 6: Vendor IBM Plex Mono and IBM Plex Serif (#56)

**Files:**
- Create: `src/vendor/fonts/IBMPlexMono-{Regular,Italic,Bold,BoldItalic}-{Latin1,Latin2,Pi}.woff2` (12 files), `src/vendor/fonts/IBMPlexSerif-{Regular,Italic,Bold,BoldItalic}-{Latin1,Latin2}.woff2` (8 files), `src/vendor/fonts/IBMPlexMono-OFL.txt`, `src/vendor/fonts/IBMPlexSerif-OFL.txt`
- Modify: `src/styles.css` (new `@font-face` rules after line 116)
- Modify: `THIRD_PARTY_NOTICES.md` (section "Inter and JetBrains Mono", line 211)
- Test: new `test/font-vendor.test.js`

**Interfaces:**
- Produces: font families `'IBM Plex Mono'` (400, 700, normal and italic) and `'IBM Plex Serif'` (400, 700, normal and italic), loadable from `vendor/fonts/`.

- [ ] **Step 1: Write the failing test `test/font-vendor.test.js`.**

```js
test("every @font-face source is a vendored file that exists", async () => {
  // for each url("vendor/fonts/...") in styles.css: the file exists under src/
});
test("no @font-face uses local() or a remote URL", () => { /* no /local\(/ and no /url\("?https?:/ in @font-face blocks */ });
test("IBM Plex Mono and Serif declare 400 and 700, upright and italic", () => {
  // collect (family, weight, style) tuples; both families have all four
});
test("each bundled family ships its OFL licence", async () => {
  // IBMPlexMono-OFL.txt and IBMPlexSerif-OFL.txt contain "SIL Open Font License" and 'Reserved Font Name "Plex"'
});
```

- [ ] **Step 2: Run; expect FAIL** (`node --test test/font-vendor.test.js` with the capped command).

- [ ] **Step 3: Download and verify (needs network; run outside the sandbox if blocked).** Use a fresh directory under `$TMPDIR`, not the repo:

```bash
D=$(mktemp -d) && cd "$D"
curl -fsSLo mono.zip "https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-mono%402.5.0/ibm-plex-mono.zip"
curl -fsSLo serif.zip "https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-serif%402.0.0/ibm-plex-serif.zip"
shasum -a 256 mono.zip serif.zip
# expect 6d23f01257663d8cc49a0d64c22ced630b79e0e2a0ac08a0da86e9a38bbc481c  mono.zip
#        c006b095c47b919c6c8d78319e9e628745033f5db94507c1c9dfe4b35dd51f1e  serif.zip
unzip -q mono.zip && unzip -q serif.zip
head -3 ibm-plex-mono/LICENSE.txt ibm-plex-serif/LICENSE.txt   # "SIL Open Font License, Version 1.1"
```

Copy the 20 files listed above from `ibm-plex-mono/fonts/split/woff2/` and `ibm-plex-serif/fonts/split/woff2/` into `src/vendor/fonts/` unmodified, and the two `LICENSE.txt` files as `IBMPlexMono-OFL.txt` and `IBMPlexSerif-OFL.txt`. Expected total of the 20 woff2 files: 348,624 bytes (mono 186,272, serif 162,352); check with `cat <files> | wc -c`.

- [ ] **Step 4: Add 20 `@font-face` rules** to `styles.css`, one per file, in the existing style: `font-family: 'IBM Plex Mono'` or `'IBM Plex Serif'`, `font-style`, `font-weight`, `font-display: swap`, `src: url("vendor/fonts/<file>") format("woff2")`, and `unicode-range` copied from the subset's block in the upstream per-weight CSS (`ibm-plex-mono/fonts/split/woff2/IBMPlexMono-Regular.css`, `-Italic.css`, `-Bold.css`, `-BoldItalic.css`, and the serif equivalents). Do not copy the upstream `local(...)` sources.

- [ ] **Step 5: Update `THIRD_PARTY_NOTICES.md`.** Rename the section to "Inter, JetBrains Mono and IBM Plex", add: IBM Plex Mono 2.5.0 and IBM Plex Serif 2.0.0, Latin1, Latin2 (and Pi for Mono) WOFF2 subsets from the official `IBM/plex` GitHub releases, unmodified, under the SIL Open Font License 1.1, `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"`, licence files next to the fonts. The OFL text already quoted there applies.

- [ ] **Step 6: Run font-vendor test and `npm run check:egress`; expect PASS.**

- [ ] **Step 7: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/vendor/fonts src/styles.css THIRD_PARTY_NOTICES.md test/font-vendor.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "chore(fonts): vendor IBM Plex Mono and IBM Plex Serif subsets"
```

---

### Task 7: Document font settings (#56)

**Files:**
- Create: `src/document-fonts.js`
- Modify: `package.json` (`check:js`: add `node --check src/document-fonts.js`)
- Modify: `src/index.html` (three rows after Readable width, plus a hidden text field per row)
- Modify: `src/app.js:54-72, 287-296, 496-497` and `src/notes.js:217-245, 729-730, 1628-1631` (create, load, reload, re-apply on theme change)
- Modify: `src/themes.js` (return `activeTheme()`; keep `fontBody`/`fontHeading`/`fontCode` in `normalizeCustomTheme`, `parseThemeContent`, `exportCurrentTheme`)
- Modify: `src/mermaid.js:190` (`themeVariablesFrom` font)
- Modify: `src/styles.css` (`:root` font tokens; document rules)
- Test: new `test/document-fonts.test.js`, `test/view-settings.test.js`, `test/mermaid.test.js`

**Interfaces:**
- Consumes: font families from Task 6; `createThemes` from `src/themes.js`.
- Produces (`src/document-fonts.js`):
  - `CURATED_FONTS: Array<{ id, name, kind: "sans"|"serif"|"mono", stack }>` with ids `inter`, `ibm-plex-serif`, `jetbrains-mono`, `ibm-plex-mono`.
  - `FONT_KEYS = { body: "sodilaud_font_body", heading: "sodilaud_font_heading", code: "sodilaud_font_code" }`.
  - `normalizeFontValue(value, slot: "body"|"heading"|"code"): string` returning `""`, a curated id allowed for the slot (code: mono only), or `system:<trimmed name>` when the name matches `/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u`; anything else `""`.
  - `resolveFonts(user: {body,heading,code}, theme?: {fontBody,fontHeading,fontCode}): { body, heading, code }` of CSS font-family stacks. Body: user, else theme, else `inter`. Heading: user, else theme, else the body stack. Code: user, else theme, else `jetbrains-mono`.
  - `createDocumentFonts({ document, storage, broadcast, themeFonts: () => object|undefined }): { load(), reload(key): boolean, apply() }` setting `--doc-font-body`, `--doc-font-heading`, `--doc-font-code` on the root and driving the controls when present.
  - DOM ids: `font-body-select`, `font-heading-select`, `font-code-select`, `font-body-system`, `font-heading-system`, `font-code-system`.

Stacks: `inter` = `'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`; `ibm-plex-serif` = `'IBM Plex Serif', Georgia, "Times New Roman", serif`; `jetbrains-mono` = `'JetBrains Mono', "Fira Code", Menlo, Monaco, Consolas, "Courier New", monospace`; `ibm-plex-mono` = `'IBM Plex Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace`. A system name becomes `"<name>", ` + the `inter` stack (body, heading) or the `jetbrains-mono` stack (code).

Select options, in order: `""` labelled `Theme default (<resolved name>)` (heading: `Theme default (same as body)` when it resolves to the body), the curated fonts allowed for the slot by name, then `system` labelled `System font…`. Choosing `System font…` shows the row's text field and focuses it; Enter or blur stores `system:<name>` if valid, otherwise leaves the stored value unchanged and marks the field `aria-invalid="true"`. A stored `system:` value shows `System font…` selected with the name in the visible field.

- [ ] **Step 1: Write failing tests in `test/document-fonts.test.js`.**

```js
test("font values normalize per slot", () => {
  assert.equal(normalizeFontValue("ibm-plex-mono", "body"), "ibm-plex-mono");
  assert.equal(normalizeFontValue("ibm-plex-serif", "code"), "");
  assert.equal(normalizeFontValue("system:  Iosevka Term ", "code"), "system:Iosevka Term");
  for (const bad of ['system:Evil"; }', "system:url(x)", "system:a{b}", "system:", "comic"])
    assert.equal(normalizeFontValue(bad, "body"), "", bad);
});
test("fonts resolve user over theme over default, heading follows body", () => {
  const f = resolveFonts({ body: "ibm-plex-serif", heading: "", code: "" }, { fontCode: "ibm-plex-mono" });
  assert.match(f.body, /^'IBM Plex Serif'/);
  assert.equal(f.heading, f.body);
  assert.match(f.code, /^'IBM Plex Mono'/);
  assert.match(resolveFonts({ body: "", heading: "", code: "system:Iosevka" }).code, /^"Iosevka", 'JetBrains Mono'/);
});
test("choosing a font sets the root stacks, persists and reaches Quick Notes", async () => {
  // bootMainWindow: select ibm-plex-mono in #font-body-select (dispatch change) ->
  // root --doc-font-body starts with 'IBM Plex Mono', storage sodilaud_font_body = "ibm-plex-mono".
  // bootApp with that storage then the preference event: its root has the same stack.
});
test("an invalid system font name is not stored", async () => {
  // choose System font..., type 'X"; color: red', blur -> storage unchanged, aria-invalid "true",
  // root --doc-font-body unchanged.
});
test("a theme's font suggestion applies until the user picks a font", async () => {
  // import a custom theme with fontHeading "ibm-plex-serif"; heading stack is Plex Serif;
  // pick inter for heading -> Inter; theme export includes fontHeading.
});
```

Extend `view-settings.test.js` labels to `["Editor zoom", "Line spacing", "Paragraph spacing", "Readable width", "Body font", "Heading font", "Code font", "Syntax highlighting", "Line numbers"]`. In `test/mermaid.test.js` assert `themeVariablesFrom` uses `--doc-font-body` when the root sets it.

- [ ] **Step 2: Run; expect FAIL.**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/document-fonts.test.js test/view-settings.test.js test/mermaid.test.js`

- [ ] **Step 3: Implement `src/document-fonts.js`** and add it to `check:js`.

- [ ] **Step 4: Wire both windows.** `createThemes` returns `activeTheme: () => <the applied theme object or undefined>`. In `app.js` and `notes.js` create `fonts = createDocumentFonts({ document, storage: localStorage, broadcast, themeFonts: () => themes.activeTheme() })`; call `fonts.apply()` at the start of each `onApplied` (before `mermaid.setTheme`), `fonts.load()` after `appearance.load()`, and `if (fonts.reload(key)) return;` in `followPreferenceChange` after `appearance.reload`. After a font change, call `mermaid.setTheme(themeVariablesFrom(document))` in the page that owns Mermaid (pass an `onApplied` callback to `createDocumentFonts` for that).

- [ ] **Step 5: CSS.** `:root`: `--doc-font-body: var(--font-sans); --doc-font-heading: var(--doc-font-body); --doc-font-code: var(--font-mono);`. Use `--doc-font-body` for `.cm-editor.cm-mode-live .cm-content`, `.markdown-preview` and `.cm-mode-live .cm-lp-table.markdown-preview`; `--doc-font-heading` for headings in both modes; `--doc-font-code` for `.cm-editor.cm-mode-source .cm-content`, `.cm-mode-live .cm-lp-code`, `.cm-mode-live .cm-lp-codeblock`, `.markdown-preview pre`, `.markdown-preview code` and diff hunk code. Leave every chrome rule on `--font-sans`/`--font-mono`.

- [ ] **Step 6: Mermaid.** In `themeVariablesFrom`, read `style.getPropertyValue("--doc-font-body").trim()` and use it unless empty or containing `var(`; otherwise keep the body `fontFamily`.

- [ ] **Step 7: Run Step 2's command plus `test/theme-slots.test.js test/theme-input-validation.test.js test/notes-boot.test.js test/start-page.test.js`; expect PASS.**

- [ ] **Step 8: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add src/document-fonts.js package.json src/index.html src/app.js src/notes.js src/themes.js src/mermaid.js src/styles.css test
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "feat(editor): configurable body, heading and code fonts"
```

---

### Task 8: Documentation and full CI mirror

**Files:**
- Modify: `README.md` (feature list near line 86; editing paragraph near line 208; "Themes" section 212-230)
- Modify: `ROADMAP.md` (append an item)
- Create (uncommitted): `.pr-body.md`

- [ ] **Step 1: README.** Feature list: replace the themes line with "Built-in and importable color themes; the whole document (code, tables, rules, quotes, headings, links) takes its colors from the theme" and add "Configurable document fonts (Inter, IBM Plex Serif, JetBrains Mono, IBM Plex Mono, or any installed font), heading scale with section rules, paragraph spacing and a readable column width". After the Line numbers paragraph add one paragraph on **Appearance → Paragraph spacing**, **Readable width** (on by default, 80 characters) and **Body / Heading / Code font** (Theme default, bundled fonts, System font… by name; a missing system font falls back). In "Themes", after the JSON example, document the optional slots with a JSON example using Executive's values (`heading`, `codeBackground`, `codeBorder`, `tableHeaderBackground`, `tableBorder`, `rule`, `mutedText`, `link`) and the font suggestions (`fontBody`, `fontHeading`, `fontCode`: a bundled id or `system:<name>`), and say unset slots are derived from the base colors and that TOML accepts lowercase or snake_case names.

- [ ] **Step 2: ROADMAP.md.** Append "## 15. Document styling" with `Status: done, to ship in the next release (#54, #55, #56, #57, #58) (spec [docs/superpowers/specs/2026-10-18-document-styling-design.md](docs/superpowers/specs/2026-10-18-document-styling-design.md))` and two sentences on scope.

- [ ] **Step 3: Full CI mirror** from the worktree root:

```bash
cd /Users/laas/proged/sodilaud/.claude/worktrees/document-styling
NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 900; exec @ARGV' npm run check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo fmt --manifest-path src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:egress
```

Expected: all pass; the only allowed failures are the 4 MCP socket tests inside the sandbox. Run `grep -rn "—" README.md ROADMAP.md THIRD_PARTY_NOTICES.md docs/superpowers src/document-fonts.js` and expect no matches from this branch's lines.

- [ ] **Step 4: Manual pass in the app** (user runs `npm run tauri -- dev` from the worktree if the sandbox blocks it): cycle through every preset theme with a document containing a fenced code block, inline code, a table, an hr, a blockquote, H1-H4 and a link, in Live and Reading; confirm no navy or purple from the defaults, Executive headings coral, same scale and spacing in both modes, fonts switch and survive a restart, and Quick Notes follows changes.

- [ ] **Step 5: Write `.pr-body.md`** (do not commit): summary, `Closes #54`, `Closes #55`, `Closes #56`, `Closes #57`, `Closes #58`, testing notes, bundle size added (348,624 bytes of fonts), and a release-notes paragraph: "Documents now take every color from the active theme, and themes can set heading, code, table, rule, link and muted-text colors. Executive has warm headings and neutral tables. Headings are larger with a rule under H1 and H2. New Appearance settings: paragraph spacing, a readable column width (on by default), and body, heading and code fonts, with IBM Plex Serif and IBM Plex Mono now bundled."

- [ ] **Step 6: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling add README.md ROADMAP.md
git -C /Users/laas/proged/sodilaud/.claude/worktrees/document-styling commit -m "docs(readme): document theme slots, fonts and document layout settings"
```
