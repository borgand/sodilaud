# CM6 Live-Preview Editor Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `<textarea>` + backdrop editor and the Edit/Split/Preview modes with a CodeMirror 6 editor offering Live (Obsidian-style live preview), Source and Reading modes, keeping every existing editing feature.

**Architecture:** One vendored ESM bundle (`src/vendor/codemirror.js`, built with esbuild from pinned npm packages) and three new modules: `editor-view.js` (a facade, `createMarkdownEditor`, that main.js talks to instead of a textarea), `editor-commands.js` (keyboard and paste routing onto the existing pure edit functions) and `editor-live-preview.js` (decorations that hide Markdown syntax outside the lines the selection touches). The document stays a plain string. This is still today's window-owned model, with no collab (roadmap item 2 adds that). Reading mode keeps the existing `renderMarkdown` preview pane.

**Tech Stack:** Vanilla ES modules, no bundler for app code; CodeMirror 6 (`@codemirror/state`, `view`, `language`, `commands`), `@lezer/markdown` (with GFM), `@lezer/highlight`; esbuild (dev dependency, vendoring only); `node --test` + jsdom 26.1.0 for tests.

**Spec:** `docs/superpowers/specs/2026-09-27-editor-surface-design.md` and `ROADMAP.md` item 1 (the decisions list there is binding). Coupling map of the current textarea code: `/private/tmp/claude-501/-Users-laas-proged-sodilaud/6beca85f-aa84-41fc-bb16-3c89c0d965a4/scratchpad/textarea-map.md` (read sections relevant to your task; line numbers are as of commit `6c54f9e`).

## Global Constraints

- Branch `feat/cm6-editor`. Commit after each task with `type(scope): description`, scope `editor`, and end the message with `Co-Authored-By: Claude <noreply@anthropic.com>`. Never push.
- Never use em dashes in code, comments, docs or UI copy. Use a hyphen.
- No comments unless the *why* is non-obvious. Files start with `// SPDX-License-Identifier: GPL-3.0-or-later`.
- npm needs a writable cache: prefix npm commands with `npm_config_cache=$TMPDIR/npm-cache`.
- Pinned versions: `@codemirror/state` 6.7.6, `@codemirror/view` 6.43.13, `@codemirror/language` 6.12.4, `@codemirror/commands` 6.11.1, `@lezer/markdown` 1.7.2, `@lezer/highlight` (latest 1.x at install, then pinned exactly), `esbuild` 0.28.2. All exact (no `^`), all `devDependencies`: the app ships only the vendored bundle.
- Do NOT use `@codemirror/lang-markdown` (it statically pulls lang-html/js/css, +220 KB). Build the language from `@lezer/markdown` directly. Do NOT add `@codemirror/merge` or `@codemirror/search`: compare mode keeps `note-compare.js`, and find keeps `find.js`.
- The bundle lives in `src/vendor/` (the egress gate `scripts/check-no-egress.mjs` skips `vendor/`). No `eval`/`new Function`: CSP is `script-src 'self'`.
- Zero egress: never render remote images. Only `data:image/{png,gif,jpeg,webp};base64,` images render as widgets (same rule as `sanitizeMarkdownHtml`).
- Layout modes are exactly `"live" | "source" | "reading"`. Stored legacy values map: `edit` → `live`, `split` → `live`, `preview` → `reading`; anything else → `live`.
- Live mode uses `var(--font-sans)` for body text, with sized headings and monospace code. Source mode uses `var(--font-mono)`.
- Reveal granularity: every line the selection (any range, cursor included) touches shows raw Markdown. Only when the editor has focus - an unfocused editor shows every line rendered.
- Links: a plain click places the cursor. `⌘`-click (or Ctrl-click off macOS) opens through the existing `handlePreviewLinkClick` path (`resolveLinkAction` + `confirm_and_open_url`).
- Tables: rendered HTML table widget (via `renderMarkdown`, which sanitizes) when the selection is outside the table, raw pipes when inside. No cell editing.
- Run `npm run check` (versions, `node --check` list, egress gate, all tests) before each commit from Task 5 on. Before that, run `node --test` on the files named in the task plus the full suite, and note the failures the task expects.

## Review Focus

1. **Dead keys and IME composition** (the owner types Estonian õ ä ö ü š ž through dead keys on US International). Expected: no smart-edit handler acts while `view.composing` is true, when `event.isComposing`, when `event.key === "Dead"`, or when `keyCode === 229`, and composed text lands exactly once. Test pinned in Task 3.
2. **Switching notes with a pending save debounce.** Expected: loading note B into an editor never fires `onChange` and never writes note A's text into note B. Test pinned in Task 2 (facade) and Task 5 (app).
3. **MCP `append_to_note` into the open note while the user has a selection.** Expected: the selection maps through the append, no save loop, and undo does not remove the agent's text. Test pinned in Task 2 (facade) and Task 5 (app).
4. **Large notes (5,000 lines, many tables).** Expected: inline decorations are computed only for visible ranges. Table widgets are rebuilt only on doc or selection change, and table HTML is cached by source text. Test pinned in Task 4 (widget cache and visible-range test).
5. **Legacy and garbage stored layout modes.** Expected: normalized per Global Constraints, with no exception at boot. Test pinned in Task 5 (`view-preferences` unit test plus a boot test).

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `scripts/codemirror-entry.mjs` (new) | The only re-export list the app may use from CM6 | 1 |
| `scripts/vendor-codemirror.mjs` (new) | esbuild the entry into `src/vendor/codemirror.js` | 1 |
| `src/vendor/codemirror.js` (new, committed, generated) | Vendored ESM bundle | 1 |
| `test/helpers/cm-dom.js` (new) | jsdom + CM6 polyfills for unit tests | 1 |
| `src/editor-edit.js` | Keep `getChangedRange` (export it); delete `applyEditorEdit` in Task 6 | 2, 6 |
| `src/editor-view.js` (new) | `createMarkdownEditor` facade: state, modes, find/diff decorations, external text, selection, scroll | 2 |
| `src/editor-commands.js` (new) | keydown/paste routing onto the pure edit functions; `applyPureEdit` | 3 |
| `src/editor-smart.js`, `editor-indent.js`, `editor-autocomplete.js` | Delete the textarea `handle*` exports (Task 6). The pure `get*Edit` functions stay untouched | 6 |
| `src/editor-live-preview.js` (new) | Live mode decorations and widgets | 4 |
| `src/view-preferences.js` | `normalizeLayoutMode` | 5 |
| `src/index.html` | Editor hosts replace textarea, backdrop and line numbers; mode buttons | 5 |
| `src/main.js` | Use the facade for both panes | 5, 6 |
| `src/styles.css` | CM6 editor styles, Live typography, remove backdrop and split CSS | 4, 5, 6 |
| `src/syntax-highlighting.js` | Keep `escapeHTML`, `highlightPreviewCode`; delete `renderEditorBackdrop`/`buildSyntaxClasses` | 6 |
| `src/editor-line-numbers.js`, `src/editor-render-scheduler.js` | Delete | 6 |
| `test/helpers/app-harness.js` | Polyfills, `type()` via CM6, `editor(pane)` accessor | 5 |
| `THIRD_PARTY_NOTICES.md`, `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.release.conf.json` | Deps, notices, vendoring in build commands | 1 |
| `README.md`, help modal in `index.html`, `RELEASE_NOTES.md`, `ROADMAP.md`, `site/` | Docs | 7 |

---

### Task 1: Vendor the CodeMirror bundle

**Files:**
- Create: `scripts/codemirror-entry.mjs`, `scripts/vendor-codemirror.mjs`, `src/vendor/codemirror.js` (generated), `test/helpers/cm-dom.js`, `test/codemirror-vendor.test.js`
- Modify: `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.release.conf.json` (if it has `beforeBuildCommand`), `THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Produces: `src/vendor/codemirror.js` exporting exactly the names in the entry below. `test/helpers/cm-dom.js` exporting `installEditorDom()` → `{ dom, window, document, cleanup() }`.

- [ ] **Step 1: Install pinned dev dependencies**

```bash
npm_config_cache=$TMPDIR/npm-cache npm i -D -E @codemirror/state@6.7.6 @codemirror/view@6.43.13 @codemirror/language@6.12.4 @codemirror/commands@6.11.1 @lezer/markdown@1.7.2 @lezer/highlight esbuild@0.28.2
```
(Bash tool: `allowed_domains: ["registry.npmjs.org"]`.) Then make `@lezer/highlight` exact in `package.json` if npm wrote a range.

- [ ] **Step 2: Write the entry**

`scripts/codemirror-entry.mjs`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later

export { Annotation, Compartment, EditorSelection, EditorState, Facet, Prec, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
export { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, drawSelection, gutterLineClass, keymap, lineNumbers, placeholder } from "@codemirror/view";
export { HighlightStyle, Language, defineLanguageFacet, ensureSyntaxTree, syntaxHighlighting, syntaxTree } from "@codemirror/language";
export { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
export { GFM, parser as markdownParser } from "@lezer/markdown";
export { tags } from "@lezer/highlight";
```

- [ ] **Step 3: Write the vendoring script** (mirrors `scripts/vendor-marked.mjs` style)

`scripts/vendor-codemirror.mjs`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./codemirror-entry.mjs", import.meta.url));
const outfile = fileURLToPath(new URL("../src/vendor/codemirror.js", import.meta.url));
const versions = await Promise.all(["@codemirror/state", "@codemirror/view", "@codemirror/language", "@codemirror/commands", "@lezer/markdown"].map(async name => {
  const pkg = JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8"));
  return `${name} ${pkg.version}`;
}));

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "none",
  target: "safari16",
  banner: { js: `// Generated by scripts/vendor-codemirror.mjs from ${versions.join(", ")}. MIT licensed; see THIRD_PARTY_NOTICES.md.` }
});
console.log(`Vendored CodeMirror (${versions.join(", ")})`);
```

- [ ] **Step 4: Wire scripts**

`package.json` scripts: add `"vendor:codemirror": "node scripts/vendor-codemirror.mjs"`. Change the Tauri `beforeBuildCommand` and `beforeDevCommand` in both tauri configs to `npm run vendor:marked && npm run vendor:codemirror`. Add `node --check scripts/vendor-codemirror.mjs` to `check:js` (do not add `src/vendor/*`).

- [ ] **Step 5: Write jsdom helper**

`test/helpers/cm-dom.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later

import { JSDOM } from "jsdom";

// jsdom has no layout. CM6 measures through Range rects, so give it empty ones.
export function polyfillLayout(window) {
  const rects = () => Object.assign([], { item: () => null });
  const box = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  window.Range.prototype.getClientRects = rects;
  window.Range.prototype.getBoundingClientRect = box;
  window.document.elementFromPoint ??= () => null;
}

export function installEditorDom(html = "<!doctype html><div id=host></div>") {
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  polyfillLayout(dom.window);
  const saved = {};
  for (const name of ["window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "KeyboardEvent", "ClipboardEvent", "Event", "MouseEvent"]) {
    saved[name] = globalThis[name];
    globalThis[name] = name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name];
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  return {
    dom, window: dom.window, document: dom.window.document,
    cleanup() { Object.entries(saved).forEach(([k, v]) => { globalThis[k] = v; }); dom.window.close(); }
  };
}
```
(If `ClipboardEvent` is undefined in jsdom, fall back to assigning `undefined`, which is harmless.)

- [ ] **Step 6: Write the failing test**

`test/codemirror-vendor.test.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installEditorDom } from "./helpers/cm-dom.js";

test("the vendored bundle exposes the pinned API and no dynamic code", async () => {
  const source = await readFile(new URL("../src/vendor/codemirror.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bnew Function\s*\(|\beval\s*\(/);
  const cm = await import("../src/vendor/codemirror.js");
  for (const name of ["EditorState", "EditorView", "Decoration", "WidgetType", "StateField", "StateEffect", "Compartment", "Language", "markdownParser", "GFM", "history", "lineNumbers", "HighlightStyle", "tags"]) {
    assert.ok(cm[name], `missing export ${name}`);
  }
});

test("a markdown editor mounts in jsdom and parses GFM tables and tasks", async () => {
  const env = installEditorDom();
  try {
    const cm = await import("../src/vendor/codemirror.js");
    const language = new cm.Language(cm.defineLanguageFacet(), cm.markdownParser.configure([cm.GFM]), [], "markdown");
    const view = new cm.EditorView({
      state: cm.EditorState.create({ doc: "| a |\n|---|\n| 1 |\n\n- [ ] t", extensions: [language] }),
      parent: env.document.getElementById("host")
    });
    const names = new Set();
    cm.ensureSyntaxTree(view.state, view.state.doc.length, 1000).iterate({ enter: node => { names.add(node.name); } });
    assert.ok(names.has("Table") && names.has("TaskMarker"));
    view.destroy();
  } finally { env.cleanup(); }
});
```

- [ ] **Step 7: Run to verify it fails, vendor, rerun**

Run `node --test test/codemirror-vendor.test.js`. Expected: FAIL, because the bundle is missing. Then run `npm run vendor:codemirror` and rerun. Expected: PASS. Check that the bundle is < 450 KB (`wc -c src/vendor/codemirror.js`).

- [ ] **Step 8: Notices**

Append to `THIRD_PARTY_NOTICES.md` a `## CodeMirror and Lezer` section, in the same style as the other entries. It says that Sodilaud includes CodeMirror 6 (`@codemirror/state`, `view`, `language`, `commands`) and Lezer (`@lezer/markdown`, `@lezer/highlight`, and their dependencies `@lezer/common`, `@lezer/lr`, `style-mod`, `w3c-keyname`, `crelt`), MIT licensed. Include the full MIT text with `Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others`. Check `node_modules/@codemirror/view/LICENSE` for the exact line. Also check `node_modules/style-mod/LICENSE`, `w3c-keyname/LICENSE` and `crelt/LICENSE`, and add a line naming any holder that differs.

- [ ] **Step 9: Full suite, then commit**

`npm test`: expected all green (nothing uses the bundle yet). Run `npm run check:egress`.
```bash
git add package.json package-lock.json scripts/codemirror-entry.mjs scripts/vendor-codemirror.mjs src/vendor/codemirror.js test/helpers/cm-dom.js test/codemirror-vendor.test.js THIRD_PARTY_NOTICES.md src-tauri/tauri.conf.json src-tauri/tauri.release.conf.json
git commit -m "chore(editor): vendor CodeMirror 6 as an ESM bundle"
```

---

### Task 2: `createMarkdownEditor` facade

**Files:**
- Create: `src/editor-view.js`, `test/editor-view.test.js`
- Modify: `src/editor-edit.js` (export `getChangedRange`), `package.json` (`check:js` += `src/editor-view.js`)

**Interfaces:**
- Consumes: `src/vendor/codemirror.js` (Task 1), `getChangedRange(previousValue, nextValue) -> { start, previousEnd, replacement }` from `editor-edit.js`.
- Produces (exact; Tasks 3-6 rely on it):

```js
/**
 * @param {object} options
 * @param {HTMLElement} options.parent
 * @param {string} options.ariaLabel
 * @param {string} [options.placeholder]
 * @param {"live"|"source"} [options.mode="live"]
 * @param {boolean} [options.syntaxHighlighting=true]
 * @param {boolean} [options.lineNumbers=false]
 * @param {(text: string) => void} [options.onChange]          user edits only (typing, commands, applyEdit, replaceRange); never setText/loadText
 * @param {() => void} [options.onSelectionChange]             selection or doc changed, from any source
 * @param {() => void} [options.onFocus]
 * @param {(href: string) => void} [options.onOpenLink]         consumed by Task 4
 * @param {Extension[]} [options.extensions]                   extra extensions (Task 3 editing commands, Task 4 live preview are added here by Task 5 via createAppEditor, see below)
 */
export function createMarkdownEditor(options) -> MarkdownEditor

MarkdownEditor = {
  view,                                   // EditorView
  getText(): string,
  loadText(text): void,                   // new note: fresh state (new undo history), selection 0, scroll top, no onChange
  setText(text): void,                    // external update (MCP append): minimal change via getChangedRange, Transaction.addToHistory false, selection mapped, no onChange
  getSelection(): { start, end, direction: "forward"|"backward"|"none" },
  setSelection(start, end, { scroll = true } = {}): void,
  applyEdit(edit): boolean,               // pure-edit shapes: {value, selectionStart, selectionEnd} | {moveTo} | null; one transaction, userEvent "input", fires onChange; returns false for null
  replaceRange(from, to, insert, selection?): void,   // user edit (context-menu cut/paste); fires onChange
  focus(): void, hasFocus(): boolean,
  setMode(mode: "live"|"source"): void,
  setSyntaxHighlighting(enabled: boolean): void,
  setLineNumbers(enabled: boolean): void,
  setFindMatches(matches: {start,end}[], activeIndex: number): void,   // mark classes "cm-find-match" and "cm-find-match cm-find-active"
  setDiff({ decorations, changedLines } | null): void,                 // decorations: [{start,end,className}] from note-compare.js; changedLines: 0-based line indexes (read note-compare.js to confirm and adapt); gutter shows while a diff is set even if line numbers are off
  scrollToRange(start, end): void,        // centers range
  getScrollTop(): number, setScrollTop(px): void,
  destroy(): void
}

export const markdownLanguage; // Language built from markdownParser.configure([GFM])
export const externalChange;   // Annotation<boolean> marking loadText/setText transactions
```

Implementation requirements:
- Base extensions: `markdownLanguage`, `history()`, `drawSelection()`, `EditorView.lineWrapping`, `keymap.of([...historyKeymap, ...defaultKeymap])`, `placeholder(options.placeholder)` when given, and `EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: "false", autocorrect: "off", autocapitalize: "off" })`. Also `EditorView.editorAttributes` from a mode compartment: `{ class: "cm-mode-live" }` or `{ class: "cm-mode-source" }`. The `options.extensions` go in a compartment of their own, so Task 4 can make live preview react to mode via a facet or class (the live-preview plugin reads `view.dom.classList.contains("cm-mode-live")`, or better a `StateField` the facade exposes. Choose `modeFacet = Facet.define({ combine: v => v[0] ?? "live" })`, exported, supplied via the mode compartment).
- Export `modeFacet` as well.
- Syntax highlighting: `HighlightStyle.define` with `class` specs reusing the existing CSS classes: `tags.heading`→`syntax-heading`; `tags.emphasis`, `tags.strong`, `tags.strikethrough`→`syntax-emphasis`; `tags.link`, `tags.url`→`syntax-link`; `tags.monospace`→`syntax-code`; `tags.processingInstruction`, `tags.meta`, `tags.contentSeparator`, `tags.list`, `tags.quote`→`syntax-punctuation`. Toggle through a compartment.
- Line numbers: compartment with `lineNumbers()` when `lineNumbers || diff !== null`, plus `gutterLineClass` from the diff field, with classes `cm-diff-line-added`/`cm-diff-line-removed` (map from the note-compare line data).
- Find and diff: one `StateField` each, updated through `StateEffect`s, mapped through changes (`decorations.map(tr.changes)`) and provided with `EditorView.decorations.from(field)`. Clamp and drop ranges outside the doc.
- Update listener: `docChanged` and no `externalChange` annotation on any transaction → `onChange(getText())`. `docChanged || selectionSet` → `onSelectionChange()`. `focusChanged && view.hasFocus` → `onFocus()`.
- `loadText`: `view.setState(EditorState.create({ doc: text, extensions: currentExtensions() }))`, where `currentExtensions()` rebuilds from the current mode, highlighting, line-number and diff settings. Clear find decorations. Scroll to top.
- `setText`: if equal, no-op. Else, one dispatch of `{ changes: { from: start, to: previousEnd, insert: replacement }, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)] }`.
- `applyEdit`: `{ moveTo }` → selection-only dispatch. Otherwise compute the change from `getChangedRange(getText(), edit.value)` and dispatch it with `selection: EditorSelection.single(edit.selectionStart, edit.selectionEnd)`, `userEvent: "input"` and `scrollIntoView: true`.

- [ ] **Step 1: Write failing tests** in `test/editor-view.test.js`, using `installEditorDom()` per test and `await import("../src/editor-view.js")`. Cover, each as its own `test(...)`:
  1. `loadText` sets text, selection 0, fires no `onChange`, and undo after `loadText` does nothing (fresh history): `undo(editor.view)` returns false. Import `undo` from the vendor bundle.
  2. User transaction (`editor.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" })`) fires `onChange` with the full new text.
  3. **Review Focus 2:** `loadText("B")` after a user edit of "A": `onChange` calls equal exactly the user edit, and the last `onChange` text is never "B".
  4. **Review Focus 3:** `loadText("hello world")`, select 0-5 (`setSelection(0,5)`), then `setText("hello world\nappended")`. The selection stays `{start:0,end:5}`, `onChange` is not called, and `undo(view)` leaves "appended" in place.
  5. `applyEdit({ value: "ab", selectionStart: 1, selectionEnd: 1 })` on "a": text "ab", caret 1, one `onChange`. A single `undo` restores "a". `applyEdit(null)` returns false. `applyEdit({ moveTo: 0 })` moves the caret without `onChange`.
  6. `setFindMatches([{start:0,end:1},{start:2,end:3}], 1)` renders two `.cm-find-match` elements, one with `.cm-find-active` (query `editor.view.contentDOM`). After inserting text at 0, both marks shift by the inserted length (check via the field's decorations or via DOM text of marks).
  7. `setDiff({ decorations: [{start:0,end:1,className:"diff-text-added"}], changedLines: <shape from note-compare> })` renders a `.diff-text-added` span and shows the `.cm-lineNumbers` gutter while `lineNumbers` is false. `setDiff(null)` hides the gutter again.
  8. `setMode("source")` toggles `cm-mode-source` on `editor.view.dom` and keeps the text and selection.
  9. The content element has `aria-label` equal to the option and `spellcheck="false"`.

- [ ] **Step 2:** `node --test test/editor-view.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `src/editor-view.js` to the interface above. Export `getChangedRange` from `editor-edit.js` (only add `export`).
- [ ] **Step 4:** Tests pass. `npm test` stays green.
- [ ] **Step 5:** Commit: `feat(editor): CodeMirror editor facade with find, diff and external-update support`.

---

### Task 3: Editing commands on CM6

**Files:**
- Create: `src/editor-commands.js`, `test/editor-commands.test.js`
- Modify: `package.json` (`check:js`)

**Interfaces:**
- Consumes: pure functions (unchanged): `getSmartKeyEdit(value, start, end, key)`, `getListMoveEdit(value, start, end, direction)`, `getMarkdownPasteEdit(value, start, end, text)` (`editor-smart.js`); `getIndentEdit(value, start, end, outdent)` (`editor-indent.js`); `getMarkdownAutocompleteEdit(value, start, end)` (`editor-autocomplete.js`); `getTableEnterEdit`, `getTableBackspaceEdit`, `getTableTabEdit` (reached through those). Plus `createMarkdownEditor(...).applyEdit` semantics from Task 2.
- Produces: `export function markdownEditingCommands(): Extension` and `export function applyPureEdit(view, edit): boolean` (the same transaction shape as the facade's `applyEdit`; the facade's `applyEdit` must call this, so move the logic here and have `editor-view.js` import it).

Routing: read the current `handleEditorTab`, `handleMarkdownAutocomplete`, `handleEditorSmartKeydown` and `handleMarkdownPaste` (`editor-indent.js:170`, `editor-autocomplete.js:201`, `editor-smart.js:305`/`352`) and reproduce their key filters exactly, but reading `view.state` instead of a textarea. Use `Prec.high(EditorView.domEventHandlers({ keydown, paste }))`:
- keydown order: Tab/Shift-Tab (indent) → Enter (autocomplete) → smart keydown (Alt-Up/Down list move, Home, Backspace, pairing keys). The first non-null edit wins: `event.preventDefault()`, `applyPureEdit`, return true.
- Guard first: `if (view.composing || event.isComposing || event.key === "Dead" || event.keyCode === 229) return false;`
- Single selection only: if `view.state.selection.ranges.length > 1`, return false (let CM handle it).
- paste: `event.clipboardData?.getData("text/plain")` → `getMarkdownPasteEdit`.
- Selection direction: pass `selection.main.from/to`. The pure functions expect start ≤ end.

- [ ] **Step 1: Failing tests** `test/editor-commands.test.js`. Mount via `createMarkdownEditor({ parent, ariaLabel: "t", extensions: [markdownEditingCommands()] })` and dispatch `new window.KeyboardEvent("keydown", { key, shiftKey, altKey, bubbles: true, cancelable: true })` on `editor.view.contentDOM`. Cases (each asserts text and caret, and derives expected values by calling the same pure function on the same input, so the tests pin the routing rather than duplicating logic):
  1. Tab on `"- a"` caret 3 indents like `getIndentEdit(...,false)`. Shift-Tab outdents.
  2. Enter on `"- a"` caret 3 → equals `getMarkdownAutocompleteEdit`.
  3. Enter in the last empty row of a table exits like `getTableEnterEdit`.
  4. `(` with selection "x" of "x" wraps like `getSmartKeyEdit(...,"(")`.
  5. Alt-ArrowDown on the first of two list items moves it like `getListMoveEdit`.
  6. Paste of `https://example.com` over selected "site" → `getMarkdownPasteEdit` (build the event with `new window.Event("paste", {bubbles:true, cancelable:true})` and define `clipboardData = { getData: () => "https://example.com" }` on it).
  7. **Review Focus 1:** with `key: "Dead"`, and with `keyCode: 229` (define it via `Object.defineProperty`), a `"("` keydown returns without an edit and the text is unchanged. Also, with `view.composing` forced true (`Object.defineProperty(editor.view, "composing", { get: () => true })`), Enter on `"- a"` does not continue the list.
  8. Undo after Enter-continuation restores the original in one step.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Refactor `editor-view.js` `applyEdit` to delegate to `applyPureEdit`.
- [ ] **Step 4:** `node --test test/editor-commands.test.js test/editor-view.test.js`, then `npm test`, all green.
- [ ] **Step 5:** Commit `feat(editor): route smart editing keys and paste through CodeMirror`.

---

### Task 4: Live preview

**Files:**
- Create: `src/editor-live-preview.js`, `test/editor-live-preview.test.js`
- Modify: `src/styles.css` (append a `/* Editor: live preview */` block), `package.json` (`check:js`)

**Interfaces:**
- Consumes: `modeFacet` (Task 2); `renderMarkdown(text)` and `isSafeMarkdownUrl(value, isImage)` from `markdown.js`; the syntax tree node names from `@lezer/markdown` (GFM): `ATXHeading1..6`, `SetextHeading1/2`, `HeaderMark`, `Emphasis`, `StrongEmphasis`, `EmphasisMark`, `Strikethrough`, `StrikethroughMark`, `InlineCode`, `CodeMark`, `FencedCode`, `CodeInfo`, `Link`, `LinkMark`, `URL`, `LinkTitle`, `Image`, `Blockquote`, `QuoteMark`, `BulletList`, `OrderedList`, `ListItem`, `ListMark`, `Task`, `TaskMarker`, `HorizontalRule`, `Table`.
- Produces: `export function livePreview({ onOpenLink }): Extension`. It is inert unless `state.facet(modeFacet) === "live"`.

Behavior (all decorations skipped when mode is source):
- **Revealed lines:** when `view.hasFocus`, the set of line numbers touched by any selection range. The decorations below apply only to nodes whose lines are not revealed. Recompute on `docChanged`, `selectionSet`, `viewportChanged` and `focusChanged`, and on a mode change (compare facet values).
- **Line classes (always in live, including revealed lines):** `cm-lp-h1`..`cm-lp-h6` on heading lines, `cm-lp-quote` on blockquote lines, `cm-lp-codeblock` on FencedCode lines, `cm-lp-hr` on HR lines.
- **Hidden marks (`Decoration.replace({})`)** on unrevealed lines: `HeaderMark` plus the following space; `EmphasisMark`; `StrikethroughMark`; `CodeMark` of `InlineCode` (the inline-code body gets mark class `cm-lp-code`); `QuoteMark` plus the following space. For `Link`: hide both `LinkMark`s, the `URL` and `LinkTitle`, and the surrounding `(`/`)` (hide from the second `LinkMark` through the end of `Link`), and mark the text with class `cm-lp-link` and `data-href` via `Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": url } })`. Autolinks (`<https://..>`, or `URL` directly inside `Paragraph`) get only the `cm-lp-link` mark.
- **Widgets:**
  - `TaskMarker` → checkbox widget (`<input type=checkbox class="cm-lp-task">`, checked when the marker is `[x]` or `[X]`). `mousedown` on it toggles the marker text through `view.dispatch({ changes: { from, to, insert: checked ? "[ ]" : "[x]" }, userEvent: "input" })` and calls `preventDefault`. `ignoreEvent()` returns false for mousedown handling inside the widget. Also hide the preceding `ListMark` and space when the item is a task.
  - `ListMark` of `BulletList` (non-task) → bullet widget `•` (`cm-lp-bullet`). Ordered list marks stay as text.
  - `HorizontalRule` → `<hr class="cm-lp-hr-widget">` replacing the line content.
  - `Image` with a URL that passes `isSafeMarkdownUrl(url, true)` and starts with `data:image/` → `<img class="cm-lp-image" alt=...>` widget replacing the whole node. Any other image → leave the source visible and give it mark class `cm-lp-image-blocked` (no network, ever).
  - `Table` not touched by a revealed line → a block widget replacing the whole table range. It renders `renderMarkdown(tableSource)` into `<div class="cm-lp-table markdown-preview">`, where `markdown-preview` reuses the existing table CSS. Because block replacements cannot come from a ViewPlugin, tables live in a `StateField` (recomputed on doc change or selection change or focus change; the focus state comes from a `StateEffect` dispatched by a `focusChanged` update listener). Widget `eq()` compares source text, and a module-level `Map` caches source text → HTML with at most 200 entries (evict the oldest). Clicking the widget places the cursor at the table start (`mousedown` → dispatch a selection), which reveals the raw table.
- **Links:** `EditorView.domEventHandlers({ mousedown })`. When `(event.metaKey || event.ctrlKey)` and the target is inside `.cm-lp-link`, call `onOpenLink(dataHref)`, `preventDefault` and return true. Plain clicks return false (cursor placement).
- **Visible ranges only:** the inline ViewPlugin iterates `syntaxTree(state).iterate({ from, to })` for each `view.visibleRanges` entry. Tables in the StateField iterate the whole tree, but only `Table` nodes: use `iterate` with `enter` returning false for non-block children (skip `Paragraph` subtrees).
- **CSS** (styles.css): `.cm-editor.cm-mode-live .cm-content { font-family: var(--font-sans); }` and `.cm-mode-source .cm-content { font-family: var(--font-mono); }`. Headings sized h1 1.8em through h6 1em with weight 600. `.cm-lp-code` and `.cm-lp-codeblock` monospace with a subtle background (reuse the preview's code colors). `.cm-lp-link` in the accent/link color with an underline and pointer cursor only while `⌘` is held (skip the modifier styling if it's complex, and use a plain underline). Blockquote left border like the preview. Task checkbox aligned. Use existing theme variables only (read `styles.css` `:root` and the theme blocks).

- [ ] **Step 1: Failing tests** `test/editor-live-preview.test.js`. Mount `createMarkdownEditor({ parent, ariaLabel:"t", extensions: [livePreview({ onOpenLink })] })`. To make "focus" true in jsdom, stub `Object.defineProperty(editor.view, "hasFocus", { get: () => true })` and dispatch a selection to trigger an update. Cases:
  1. `"# Title\n\nbody"`, focused, caret on line 3: the heading line has `cm-lp-h1`, and the rendered text of line 1 (`view.contentDOM.querySelector(".cm-line").textContent`) is `"Title"`. Move the caret to line 1: the line text becomes `"# Title"`.
  2. Unfocused (`hasFocus` false): every line is rendered, including the one holding the caret.
  3. `"**b** [l](https://x.y)"` with the caret on another line: text shows `"b l"`, and `.cm-lp-link[data-href="https://x.y"]` exists.
  4. `⌘`-mousedown on `.cm-lp-link` calls `onOpenLink("https://x.y")` once. A plain mousedown does not.
  5. `"- [ ] t"` caret elsewhere: a `.cm-lp-task` checkbox exists and is unchecked. A mousedown on it changes the doc to `"- [x] t"`, which fires `onChange` (pass `onChange` to the facade).
  6. `"![a](https://evil.example/x.png)"`: no `<img>` in `contentDOM`, and a `.cm-lp-image-blocked` exists. `"![a](data:image/png;base64,iVBORw0KGgo=)"`: one `img.cm-lp-image`.
  7. A table with the caret outside: one `.cm-lp-table table` exists and no `.cm-line` contains `"|---"`. Caret inside the table: no `.cm-lp-table`, and the raw pipes show.
  8. `setMode("source")`: none of the `cm-lp-*` decorations or widgets exist, and the text shows raw.
  9. **Review Focus 4:** build a 5,000-line doc with 200 tables. Mount it and move the caret 50 times. Every dispatch completes, and the `renderMarkdown` table cache holds ≤ 200 entries. Export a test hook `__tableCacheSize()` from the module. The whole test must finish in under 5 s: pass `{ timeout: 5000 }` to `test`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `editor-live-preview.js` and the CSS.
- [ ] **Step 4:** New tests pass, and `npm test` is green.
- [ ] **Step 5:** Commit `feat(editor): Obsidian-style live preview decorations`.

---

### Task 5: Integrate into the app (main.js, index.html, harness)

This task switches the app over. Find, find-results, compare mode and line numbers are rewired in Task 6. Tests in `find-replace.test.js`, `find-results.test.js`, `split-view.test.js` (compare cases), `editor-line-numbers.test.js` (boot cases) and `editor-render-scheduler.test.js` (boot case) **may fail at the end of this task**. List their failures in the task report. Every other test must pass.

**Files:**
- Modify: `src/index.html`, `src/main.js`, `src/view-preferences.js`, `src/styles.css`, `test/helpers/app-harness.js`, and the integration tests listed in Step 6.
- Test: `test/view-preferences.test.js`, `test/layout-mode-migration.test.js` (new).

**Interfaces:**
- Consumes: `createMarkdownEditor` (Task 2), `markdownEditingCommands` (Task 3), `livePreview` (Task 4).
- Produces: in `main.js`, `primaryEditor` and `secondaryEditor` (both `MarkdownEditor`), created through `function createAppEditor(host, { ariaLabel, pane })` = `createMarkdownEditor({ parent: host, ariaLabel, placeholder: "Type something here... Supports Markdown formatting.", mode: editorModeFor(currentLayoutMode), syntaxHighlighting: syntaxHighlightingEnabled, lineNumbers: editorLineNumbersEnabled, extensions: [markdownEditingCommands(), livePreview({ onOpenLink: openExternalHref })], onChange, onSelectionChange, onFocus })`. Here `openExternalHref(href)` is the body of today's `handlePreviewLinkClick` after the href is read (extract it into a function and call it from both places). `editorModeFor("source") === "source"`, else `"live"`.
- `view-preferences.js`: `export const LAYOUT_MODES = ["live", "source", "reading"]; export function normalizeLayoutMode(value)`.
- Harness: `type(text)` replaces the primary doc with a user transaction. New `editor(pane = "primary")` returns the `EditorView` (`EditorView.findFromDOM(document.querySelector(pane === "primary" ? "#editor-host .cm-editor" : "#secondary-editor-host .cm-editor"))`, importing `EditorView` from `../../src/vendor/codemirror.js`). New `editorText(pane)`. It must call `polyfillLayout(dom.window)` from `cm-dom.js` before importing main.js, and must also set `globalThis.MutationObserver`, `requestAnimationFrame`, `cancelAnimationFrame` and `getComputedStyle` from the jsdom window (CM6 reads them as globals).

- [ ] **Step 1: `normalizeLayoutMode` test first** (`test/view-preferences.test.js`, add cases): `edit`→`live`, `split`→`live`, `preview`→`reading`, `live`/`source`/`reading` unchanged, `null`/`"garbage"`/`42`→`live`. Run it and see it FAIL, implement it, then see it PASS.

- [ ] **Step 2: index.html**
  - Replace each `#editor-wrapper` body (line numbers, backdrop, textarea) with `<div class="editor-host" id="editor-host"></div>`. Do the same in the secondary pane with `id="secondary-editor-host"`. Keep `#editor-wrapper`/`#secondary-editor-wrapper` as containers. Remove `#editor-divider`/`#secondary-editor-divider`.
  - Mode buttons become `#mode-live` (label "Live"), `#mode-source` ("Source") and `#mode-reading` ("Reading"), with `data-mode` values to match. Keep the `layout-btn` class and update the titles/aria-labels.
  - Keep `#preview-wrapper`/`#markdown-preview` (and the secondary twins) as the Reading view.

- [ ] **Step 3: main.js wiring** (use the coupling map §1 as the checklist; every item there must be handled here or explicitly deferred to Task 6):
  - Replace the DOM refs for textareas/backdrops/line numbers with `editorHost`/`secondaryEditorHost`, and create `primaryEditor`/`secondaryEditor` in `init()` before the first `loadActiveNote()`.
  - `loadActiveNote` → `primaryEditor.loadText(activeNote.content)`. `loadSecondaryNote` → `secondaryEditor.loadText(...)`. Delete the scroll resets of the removed elements, and keep `markdownPreview.scrollTop = 0`.
  - `handleEditorInput`/`handleSecondaryEditorInput` become the `onChange(text)` callbacks: `activeNote.content = text` and the rest of the existing body. Drop the render-scheduler calls, since CM renders itself.
  - Cursor position and word/selection counts: change `updateCursorPositionForText(el)` and `updateWordCharCountForText(el)` to take a `MarkdownEditor` (use `getText()`/`getSelection()`). Merge the duplicated `updateWordCharCount` into the parameterized one. Wire them from `onSelectionChange`. `onFocus` → `setActivePane(pane)`. Remove the `select`/`mouseup`/`keyup`/`focus` textarea listeners and the four textarea keydown/paste listeners (Task 3 handles those inside CM).
  - `setLayoutMode(mode)`: normalize, set class `mode-live|mode-source|mode-reading` on `#app` (remove the old `mode-*` classes), `primaryEditor.setMode(editorModeFor(mode))` and the same for the secondary, then persist. Boot reads `normalizeLayoutMode(localStorage.getItem("sodilaud_layout_mode"))` and writes the normalized value back. `createNote`'s rule becomes: a blank note while in `reading` → `live`. Any keyboard shortcut that cycled edit/split/preview cycles live/source/reading.
  - Delete the split synced-scroll listeners (coupling map §1.7) and the ResizeObserver/double-timer redraw for the backdrop (§1.4 redraw, §1.9). Keep `scheduleFindHighlightRedraw` callers compiling until Task 6 by making it a no-op, or delete it with its callers if nothing else needs it.
  - `applyNoteChange` (MCP append/rename): replace the `.value` write with `editor.setText(note.content)` for whichever pane shows the note, and keep the preview refresh and counts.
  - Zoom and line spacing: CSS vars stay. Make `.cm-editor .cm-content`/`.cm-gutters` read `--editor-font-size`/`--editor-line-height` in styles.css.
  - Syntax highlighting toggle → `setSyntaxHighlighting` on both editors, plus the existing preview re-render. Line numbers toggle → `setLineNumbers` on both (compare-mode gutter comes in Task 6).
  - Context menu: `contextMenuTarget` detection accepts `e.target.closest(".cm-editor")` and maps it to the matching `MarkdownEditor`. Store `contextMenuEditor`. The Insert submenu shows for editors. Cut/Copy/Paste/Select All on an editor use `getSelection`/`getText`/`replaceRange`/`setSelection(0, len)`. Inputs keep the old path. Insert → `editor.applyEdit(getMarkdownTemplateEdit(text, start, end, name))`.
  - Copy Markdown → `primaryEditor.getText()`. Copy HTML → if mode is `reading`, use `markdownPreview.innerHTML`; else `renderMarkdown(primaryEditor.getText())`.
  - `toggleFindBar` prefill → `primaryEditor.getSelection()`. `hideFindBar` refocus → `primaryEditor.focus()`. (The find logic itself is Task 6.)
  - Every remaining `editorTextarea`/`secondaryEditorTextarea` reference outside find/compare/line-number code is gone. `grep -n "Textarea\|editorBackdrop\|LineNumbers" src/main.js` lists only Task 6 territory.
- [ ] **Step 4: styles.css**: `.editor-host { position:absolute; inset:0; }` and `.editor-host .cm-editor { height:100%; background:var(--editor-bg); color:var(--editor-text); }`. `.cm-scroller` keeps `padding: 24px` equivalent spacing and `scrollbar-gutter: stable`. `.cm-editor.cm-focused { outline: none; }`. Mode layout: `.mode-reading` hides `.editor-wrapper` and shows `.preview-wrapper`. `live` and `source` show the editor only. Delete the `.mode-split` rules. Keep the backdrop CSS until Task 6.
- [ ] **Step 5: Harness** as specified in Interfaces. `type(text)` = `const view = editor(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" }); await settle(600);`.
- [ ] **Step 6: Rewrite integration tests** to drive CM through `app.editor()`. Keep each test's intent and assertion strength:
  - `editor-tab-integration`, `editor-smart-integration`, `editor-autocomplete-integration`, `table-exit-integration` and `task-list-exit-integration`: dispatch `KeyboardEvent`s on `app.editor().contentDOM`, then assert the doc, the caret, and that the save pipeline ran (same invocations or storage assertions as before).
  - `markdown-insert.test.js` 3rd test: right-click target is `app.editor().contentDOM`, via a `contextmenu` MouseEvent.
  - `new-note-layout-mode`: `preview`→`reading` and `edit`→`live` wording, and the same rules.
  - `view-settings`: mode buttons, `sodilaud_layout_mode` values, and line-number/syntax toggles asserted through `.cm-lineNumbers` presence and highlight classes instead of backdrop DOM.
  - `mcp-append-integration`: selection preserved via `app.editor().state.selection.main`, no duplicate save, and the doc holds the appended text.
  - `mcp-organize-integration`: the doc reflects the rename/move.
  - `accessibility.test.js`: the editor content element (`.cm-content`) has accessible name "Sodilaud content", and the secondary one "Secondary scratchpad content".
  - Any other file that reads `#editor-textarea` directly: switch it to `app.editorText()`/`app.editor()`.
  - New `test/layout-mode-migration.test.js`: boot with `storage: { sodilaud_layout_mode: "split" }`. `#app` has `mode-live`, and storage is rewritten to `"live"`. **Review Focus 2 (app level):** type "A" into note 1, switch to note 2 before 600 ms, wait 600 ms, and assert note 2's saved content is unchanged and note 1's is "A".
- [ ] **Step 7:** `npm test`: all green except the Task 6 list above. `npm run check:egress` and `check:js` (add nothing new here) pass.
- [ ] **Step 8:** Commit `feat(editor): switch the app to the CodeMirror editor with Live, Source and Reading modes`.

---

### Task 6: Find, compare, line numbers on CM6 and remove the textarea machinery

**Files:**
- Modify: `src/main.js`, `src/styles.css`, `src/syntax-highlighting.js`, `src/editor-edit.js`, `src/editor-smart.js`, `src/editor-indent.js`, `src/editor-autocomplete.js`, `package.json` (`check:js`: remove deleted files, keep new ones)
- Delete: `src/editor-line-numbers.js`, `src/editor-render-scheduler.js`, their pure tests, and the backdrop-render tests in `test/syntax-highlighting.test.js` (keep the `highlightPreviewCode`/`escapeHTML` tests)
- Tests: rewrite `test/find-replace.test.js`, `test/find-results.test.js`, `test/split-view.test.js`, and `test/editor-line-numbers.test.js` (boot cases become gutter tests) and `test/editor-render-scheduler.test.js` (delete, or fold its "latest value" assertion into a preview-render test). Update `test/editor-edit.test.js` to test `getChangedRange` only.

**Interfaces:**
- Consumes: `setFindMatches`, `scrollToRange`, `setSelection`, `applyEdit`, `setDiff`, `setLineNumbers` (Task 2).

Steps:
- [ ] **Step 1: Rewrite the tests first**, keeping each test's intent:
  - find-replace: Replace and Replace All give the same resulting text and offsets as today, and **one `undo(app.editor())` restores the pre-replace text** (this replaces the "one native edit transaction" check).
  - find-results: Find All lists matches; clicking a result switches the note, selects the match (`app.editor().state.selection.main`), and the `.cm-find-active` mark is on it.
  - split-view compare: diff classes render in both editors (`.diff-text-added`/`.diff-text-removed` etc., the exact class names that `note-compare.js` emits). Changed-line gutter classes (`cm-diff-line-added`/`cm-diff-line-removed`) are present, and the gutter is visible while line numbers are off. Keep the debounce, cache and cancel-on-close, same-note-disables-compare, and notification cases.
  - line numbers: `.cm-lineNumbers` is absent by default, present after the toggle, and the preference persists. There is no scroll-mirroring test (CM gutters scroll with the content).
  Run them and confirm they FAIL.
- [ ] **Step 2: Find:** `runFind` reads `primaryEditor.getText()` and calls `primaryEditor.setFindMatches(findMatches, activeMatchIndex)`. `selectMatch` → `setSelection(match.start, match.end)` + `scrollToRange`. `replaceOne`/`replaceAll` → `primaryEditor.applyEdit(edit)`. `hideFindBar` → `setFindMatches([], -1)`. Delete `scrollActiveMatchIntoView`'s backdrop branch and keep the preview-mark scrolling for Reading mode. `updatePreviewHighlights` stays for Reading mode. Delete `scheduleFindHighlightRedraw`/`redrawFindHighlights` and their callers.
- [ ] **Step 3: Compare:** `redrawComparisonBackdrops` becomes `applyComparisonDecorations()`. It calls `primaryEditor.setDiff({ decorations: comparison.leftDecorations, changedLines: comparison.leftChangedLines })` and `secondaryEditor.setDiff({ decorations: comparison.rightDecorations, changedLines: comparison.rightChangedLines })`, and `setDiff(null)` on both when compare turns off. `syncCompareControl`/`canCompareVisibleNotes` read `getText()`. Move the diff CSS selectors from `.editor-backdrop .diff-*` to `.cm-editor .diff-*`, and the gutter rails to `.cm-gutterElement.cm-diff-line-added/removed` (adapt to where `gutterLineClass` puts the class: on `.cm-gutterElement`).
- [ ] **Step 4: Delete** `renderPrimaryEditorBackdrop`, `renderSecondaryEditorBackdrop`, `updateSecondaryEditorBackdrop`, `updateEditorLineNumberGutter`, `updateHighlights` (or reduce it to find-and-diff dispatch), both render schedulers, and every remaining textarea/backdrop reference. From `syntax-highlighting.js` delete `renderEditorBackdrop`/`buildSyntaxClasses`/`SYNTAX_CLASSES` if unused. From `editor-edit.js` delete `applyEditorEdit`. Delete the `handle*` textarea handlers in `editor-smart.js`/`editor-indent.js`/`editor-autocomplete.js` (the pure functions stay). Delete the backdrop, textarea and split CSS (`.editor-textarea`, `.editor-backdrop`, `.editor-line-numbers*`, `.editor-divider`, `.mode-split`, `.syntax-highlighting-enabled .editor-textarea`). Keep the `.syntax-*` color rules, re-scoped to `.cm-editor .syntax-*`.
- [ ] **Step 5:** `grep -rn "editorTextarea\|editor-textarea\|editorBackdrop\|editor-backdrop\|renderEditorBackdrop\|applyEditorEdit\|createEditorRenderScheduler\|renderEditorLineNumbers\|mode-split" src test` → no hits.
- [ ] **Step 6:** `npm run check`: all green.
- [ ] **Step 7:** Commit `refactor(editor): move find, compare and line numbers onto CodeMirror and delete the textarea backdrop`.

---

### Task 7: Docs and final verification

**Files:** `README.md`, `src/index.html` (help modal: shortcuts and Markdown tabs), `RELEASE_NOTES.md`, `ROADMAP.md`, `site/` (only if it mentions the Edit/Split/Preview modes or the textarea editor), `docs/superpowers/specs/2026-09-27-editor-surface-design.md` (only the compare-mode note below).

- [ ] **Step 1:** `grep -rni "split preview\|edit mode\|preview mode\|synced\|Edit / Split\|mode-split" README.md site src/index.html docs/*.md`. Update every user-facing mention to Live / Source / Reading, and describe live preview (syntax shows on the line you are editing, `⌘`-click opens links, tables render until you click into them).
- [ ] **Step 2:** `RELEASE_NOTES.md`: add an "Unreleased" entry following the existing format. Do not bump versions.
- [ ] **Step 3:** `ROADMAP.md` item 1: Status → "implemented on `feat/cm6-editor`, pending manual verification". Change the compare-mode bullet to "Compare mode keeps `note-compare.js`, rendered as CM6 decorations (no `@codemirror/merge`)". The spec gets the same one-line change where it lists `@codemirror/merge`, if it does.
- [ ] **Step 4:** `npm run check`: green. `git status`: clean apart from these docs.
- [ ] **Step 5:** Commit `docs(editor): document Live, Source and Reading modes`.

## Final whole-branch review (after Task 7)

Run one reviewer over `git diff main...feat/cm6-editor` against this plan, the spec and the Review Focus list. Fix `Act on` findings, then run `npm run check` again.

## Manual verification left for the owner (cannot run in jsdom)

WKWebView behavior: dead keys (US International) typing õ ä ö ü š ž on a revealed line and on a line next to a rendered heading; cursor movement across hidden marks; checkbox clicks; `⌘`-click on links; tables revealing on click; zoom and line spacing; theme colors in Live and Source; find highlighting and scrolling; compare mode; MCP append while typing.
