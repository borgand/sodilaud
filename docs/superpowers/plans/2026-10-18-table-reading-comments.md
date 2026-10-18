# Comments on tables and in Reading mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comments can be anchored to table cell text in Live, Source and Reading mode, the composer survives the Live table widget rendering again, and Reading mode takes comments on prose, tables and review hunk lines.

**Architecture:** The Live `TableWidget` hosts the composer and the comment tints itself (like `HunkWidget`), and keeps its DOM across comment changes. `renderMarkdown` can emit `data-src-from`/`data-src-to` on blocks and table cells; a pure-DOM `source-map.js` aligns rendered text with that source slice to map selections to document offsets and back. A Reading controller opens a hosted composer in the hidden editor's state, so submit and range mapping reuse item 5's code.

**Tech Stack:** Vanilla ES modules, CodeMirror 6 (vendored `src/vendor/codemirror.js`), marked 18.0.12, jsdom + `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-18-table-reading-comments-design.md`

## Global Constraints

- Branch `feat/table-reading-comments`, worktree `/Users/laas/proged/sodilaud/.claude/worktrees/table-reading-comments` (written `<worktree>` in commands below). Use absolute paths and `git -C <worktree>`. Never `cd` into `src/vendor` or `node_modules`. Do not run `npm ci` (`node_modules` is a symlink).
- JS test command, always capped: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test <files>` run from the worktree root.
- New JS source files go into `check:js` in `package.json` (`node --check src/<file>.js`).
- Zero network egress, strict CSP, no new dependencies.
- No em dashes anywhere (use `-`). No mention of AI, agents-as-authors or Claude in commits, docs or PR text. Commit format `type(scope): description`.
- Code comments only where the why is non-obvious.
- Attribute names: `data-src-from`, `data-src-to` (digits only). Class names: Reading composer wrapper `reading-composer`, floating button `reading-comment-button`, source tint span `source-mark`; comment classes reuse `cm-comment`, `cm-comment-owner`/`cm-comment-agent`, `cm-comment-active`, `cm-comment-draft`, and `data-comment-id`.
- Shortcut: `Mod-Alt-M`: `metaKey` on Mac-like platforms (`isMacLikePlatform` in `src/platform-labels.js`), `ctrlKey` elsewhere. CI runs on Linux: platform-dependent behavior needs a test with `platform: "Linux x86_64"` in its own file (CodeMirror reads the platform once per process).
- An app-harness test file may boot the app several times only with distinct `instance` values (`bootMainWindow({ instance: N, ... })`).
- Do not edit `RELEASE_NOTES.md`.

## Review Focus

- An agent edit arriving while a Reading composer is open re-renders the preview: the half-typed text and focus must survive (Task 6 test "a remote edit while composing keeps the text and focus").
- Selecting across Markdown markup (`**bold**`, `[link](url)`) must anchor to the visible text only (Task 2 test "selection over emphasis maps to the text, not the asterisks").
- A fenced block with an info string (` ```javascript `): the info string must never absorb a mapping (Task 3 test "code positions cover the content only").
- Escaped pipes in cells (`a \| b`) stay inside one cell (Task 3 test "cell ranges keep escaped pipes").
- Switching layout mode with a composer open must close it, never leave an undrawn composer behind (Task 7 test "changing mode closes an open composer").

---

### Task 1: Reproduce the three bugs as failing tests

Context: roadmap item 9 lists three bugs. Root cause (verified in the harness): the Live table renders as a block `Decoration.replace` widget (`TableWidget`, `buildBlocks` in `src/editor-live-preview.js:726`) unless the editor has focus and the selection touches it. The composer is a block widget at `doc.lineAt(composer.to).to` (`composerDecorations` in `src/editor-comments.js:287`), so on any row but the last it lies inside the replaced range. When the composer's textarea takes focus, `view.hasFocus` turns false, `blockFocusSync` dispatches `setTableFocus(false)`, the table becomes the widget again and hides the composer. The toolbar button blurs the editor before the composer even opens. Reading mode has no mapping from rendered HTML to source, so `comment-btn` is disabled there.

**Files:**
- Create: `test/table-comments.test.js`

**Interfaces:**
- Consumes: `bootMainWindow` from `test/helpers/app-harness.js` (returns `app` with `dom`, `editor()`, `fileDocs.comments(path)`, `settle(ms)`, `until(fn)`, `click(id)`).
- Produces: three tests that later tasks switch on by removing their `todo` option: "Live: ⌘⌥M on a middle table row keeps the composer open and focused" (Task 5), "Live: the Comment button on a first row opens the composer under the rendered table" (Task 5), "Reading: a selection in a table cell and in prose takes a comment" (Task 7).

- [ ] **Step 1: Write the tests**

Shared fixture: `PATH = "/docs/table.md"`, `TEXT = "# T\n\nThe intro is vague.\n\n| Name | Note |\n|---|---|\n| alpha | first row |\n| beta | middle row |\n| gamma | last row |\n\nAfter.\n"`, handlers as in `test/file-comments.test.js` (`qn_get_config`, `file_lists` returning `{ open: [PATH], recent: [] }`, `file_set_open`, `file_take_pending`), `platform: "MacIntel"`, one `instance` per test (1, 2, 3).

Test A (`instance: 1`): `view.focus()`, select `"middle row"` via `view.dispatch({ selection })`, dispatch keydown `{ key: "m", metaKey: true, altKey: true }` on `view.contentDOM`, `await app.settle(100)`. Assert:
```js
const input = doc.querySelector(".cm-comment-composer textarea");
assert.ok(input, "the composer is still open");
assert.equal(doc.activeElement, input, "focus is in the composer");
assert.ok(view.contentDOM.querySelector(".cm-lp-table"), "the table is rendered");
assert.equal(view.contentDOM.querySelector(".cm-lp-table .cm-comment-draft")?.textContent, "middle row");
input.value = "Why middle?";
doc.querySelector(".cm-comment-add").click();
await app.until(() => app.fileDocs.comments(PATH).length === 1);
assert.equal(app.fileDocs.comments(PATH)[0].anchoredText, "middle row");
view.contentDOM.blur(); await app.settle(100);
assert.equal(view.contentDOM.querySelector(".cm-lp-table .cm-comment-owner")?.textContent, "middle row");
```

Test B (`instance: 2`): focus, select `"alpha"`, `view.contentDOM.blur()` (what the button's mousedown does), `await app.settle()`, `app.click("comment-btn")`, `await app.settle(100)`. Assert a `.cm-comment-composer textarea` exists, it is inside `.cm-lp-table` (`input.closest(".cm-lp-table")`), and focus is on it.

Test C (`instance: 3`): `app.click("mode-reading")`, settle. Assert `doc.getElementById("comment-btn").disabled === false`. Select the text node `"beta"` inside `#markdown-preview td` with `window.getSelection().setBaseAndExtent(node, 0, node, 4)`; click `comment-btn`; settle; the composer `#markdown-preview .reading-composer textarea` exists; set value `"Cell note"`, click `#markdown-preview .cm-comment-add`; `until` one comment; assert `anchoredText === "beta"` and `#markdown-preview .cm-comment-owner` text is `"beta"`. Then select `"vague"` inside the `p` and repeat with the button: second comment's `anchoredText === "vague"`.

Find text nodes with a `TreeWalker` (`NodeFilter.SHOW_TEXT`, value 4) over `#markdown-preview`.

- [ ] **Step 2: Run them and see each fail for the reason above**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/table-comments.test.js`
Expected: A fails at "the composer is still open" (or focus), B fails with no composer, C fails at `disabled`. If a test fails for another reason (harness setup), fix the test, not the app.

- [ ] **Step 3: Mark them `todo` so the branch stays green**

Add `{ todo: "item 9: fixed in Task 5" }` to A and B and `{ todo: "item 9: fixed in Task 7" }` to C (`test(name, { todo }, fn)`). Re-run: expected 0 failures, 3 todo.

- [ ] **Step 4: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/table-reading-comments add test/table-comments.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/table-reading-comments commit -m "test(comments): reproduce table and Reading mode comment bugs"
```

---

### Task 2: `source-map.js`, rendered text to source offsets

A pure-DOM module (no CodeMirror import) that maps between text in rendered HTML and source offsets, using `data-src-from` / `data-src-to` attributes that Task 3 makes `renderMarkdown` emit. Offsets are absolute (document positions) in Reading; in the Live table widget they are relative to the table's source.

**Files:**
- Create: `src/source-map.js`
- Create: `test/source-map.test.js`
- Modify: `package.json` (`check:js`: add `node --check src/source-map.js`)

**Interfaces:**
- Produces:
  - `export const SOURCE_FROM = "data-src-from"`, `export const SOURCE_TO = "data-src-to"`
  - `alignText(rendered: string, source: string): Int32Array` - per rendered index, the source index it matches, or -1.
  - `sourceBlockOf(root: Element, node: Node): Element | null` - innermost ancestor-or-self with both attributes, inside `root`, not inside a skipped element.
  - `pointToSource(root: Element, node: Node, offset: number, edge: "start" | "end", source: string): number | null`
  - `rangeToSource(root: Element, range: Range, source: string): { from: number, to: number } | null` - null when either end maps to null or `to <= from`.
  - `blockForSource(root: Element, pos: number): Element | null` - innermost annotated element with `from <= pos <= to`.
  - `paintSourceMarks(root: Element, marks: Array<{ from: number, to: number, className: string, id?: string }>, source: string): void` - first unwraps every existing `span.source-mark` in `root` and normalizes, then wraps the rendered characters whose aligned source offset lies in `[from, to)` in `<span class="source-mark ${className}" data-comment-id=id>`.
  - `stripSourceAnnotations(root: Element): void` - removes both attributes everywhere, unwraps `span.source-mark`, removes `.reading-composer` and `.reading-comment-button`.
  - `source` is the text the offsets index into (the document, or the table source in Live).

Rules (from the spec):
- Rendered text of an element = its text nodes in document order, skipping any inside `button, input, textarea, svg, .diff-hunk, .reading-composer, .reading-comment-button`.
- `alignText`: greedy; for each rendered char, find the next source char at or after the cursor that is equal, where any whitespace (including U+00A0) equals any whitespace; on a match set the cursor past it; with no match anywhere ahead store -1 and keep the cursor.
- Alignment of an element uses `source.slice(from, to)` of that element; mapped offset = `from + aligned`.
- `edge: "start"`: first matched rendered char at or after the point; `"end"`: one past the last matched rendered char before the point. A point outside every annotated element, or inside a skipped element, is null.

- [ ] **Step 1: Write the failing tests** (`test/source-map.test.js`, build DOM with `installEditorDom` from `test/helpers/cm-dom.js` and `innerHTML` with hand-written attributes)

- `alignText("bold", "**bold**")` deep-equals `[2, 3, 4, 5]`; `alignText("a © b", "a &copy; b")[2] === -1` and index 4 maps to 9.
- "selection over emphasis maps to the text, not the asterisks": source `"Some **bold** text"`, DOM `<p data-src-from="0" data-src-to="18">Some <strong>bold</strong> text</p>`; a Range over the text node `bold` (0..4) gives `{ from: 7, to: 11 }`; a Range from `Some ` offset 5 to `text` offset 0 gives `{ from: 5, to: 13 }`.
- a link: source `"See [docs](https://x.y/ab) now"`, DOM `<p ...>See <a>docs</a> now</p>`; selecting from `docs` offset 0 to the end of ` now` maps to `{ from: 5, to: 30 }` (starts at `docs`, ends after `now`).
- table cell: two `td`s with their own ranges; a selection in the second cell maps inside its range.
- a point inside `<button>` or `.diff-hunk` inside an annotated `p` maps to null; a point outside any annotated element maps to null.
- `paintSourceMarks` wraps exactly `bold` for `{ from: 7, to: 11 }`, across the `strong` boundary for `{ from: 5, to: 15 }` (two spans), and a second call removes the first call's spans.
- `blockForSource(root, 8)` returns the innermost element (`td` over `table`).
- `stripSourceAnnotations` leaves no `[data-src-from]`, no `.source-mark`, no `.reading-composer`, and the text unchanged.

- [ ] **Step 2: Run, expect failure** (module not found)

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/source-map.test.js`

- [ ] **Step 3: Implement `src/source-map.js`** per the Interfaces and Rules above; add it to `check:js`.

- [ ] **Step 4: Run, expect PASS**; also `npm run check:js`.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/source-map.js test/source-map.test.js package.json
git -C <worktree> commit -m "feat(comments): map rendered text back to source offsets"
```

---

### Task 3: Source positions in `renderMarkdown`

**Files:**
- Modify: `src/markdown.js` (`renderMarkdown` at line 280, `sanitizeMarkdownHtml` at 102, `MARKDOWN_ALLOWED_ATTRIBUTES` at 18)
- Test: `test/markdown.test.js`

**Interfaces:**
- Produces:
  - `renderMarkdown(rawText, emptyFallback = "", markedApi = globalThis.window?.marked, { positions = false } = {}): string` - unchanged output when `positions` is false.
  - `export function tableCellRanges(raw: string): Array<Array<{ from: number, to: number }>>` - per source line of a table (separator line included as an empty array), the trimmed content range of each cell, offsets into `raw`.
- Consumes: `SOURCE_FROM`, `SOURCE_TO` from `src/source-map.js` (Task 2).

Design:
- With `positions` and `markedApi.lexer`/`markedApi.parser` available: `tokens = markedApi.lexer(source)`; walk top-level tokens with a cursor: if `source.startsWith(token.raw, cursor)` the token spans `[cursor, cursor + raw.length)`, else try `indexOf(raw, cursor)`, else stop annotating the remaining tokens. Store `srcFrom`/`srcTo` on the token. Then `markedApi.parser(tokens, { renderer })` with the existing `hunkRenderer` extended.
- Annotate: `paragraph`, `heading`, `blockquote`, `list` (`ul`/`ol`), each `list` item (`item.raw` searched within the list's range), `table` (the `<table>` element), header and body cells (cell tokens get ranges from `tableCellRanges(token.raw)`: line 0 is the header, lines 2+ the rows, offset by the table's `srcFrom`), `code` (the `pre` element; range = content only: for a fenced block from after the first line break to the start of the closing fence line, or to the end when there is no closing fence; for an indented block the whole raw).
- The renderer adds ` data-src-from="N" data-src-to="M"` to the first opening tag of the default output (the way `hunkRenderer` injects into `<code`). Tokens without ranges render unchanged. Nested tokens inside blockquotes are not annotated.
- `tableCellRanges`: split each line at `|` not preceded by an odd number of backslashes; leading and trailing pipes are optional (GFM); trim spaces/tabs of each cell.
- Sanitizer: allow the two attributes on `p`, `h1`-`h6`, `blockquote`, `ul`, `ol`, `li`, `table`, `th`, `td`, `pre`; drop them when not `/^\d+$/` or when from > to.
- Empty `rawText` (fallback rendered): no positions.

- [ ] **Step 1: Write the failing tests** in `test/markdown.test.js` (it already loads `marked`):
- positions off: output for a fixed document equals today's output (no `data-src-` substring).
- `renderMarkdown("# T\n\nSome **bold**.\n", "", marked, { positions: true })`: `h1` has from `0` and its slice trimmed is `"# T"`; the `p` slice trimmed is `"Some **bold**."` and starts at `5`.
- list: each `li` range slices to its item's source (`"- a\n"`, `"- b"`).
- "cell ranges keep escaped pipes": `tableCellRanges("| a | b \\| c |\n|---|---|\n| 1 | 2 |")` gives header cells slicing to `"a"` and `"b \\| c"`, separator `[]`, row cells `"1"`, `"2"`; and in rendered output the `td` ranges slice the document to `"1"` and `"2"`.
- "code positions cover the content only": for ` ```javascript\nconsole.log(1)\n``` `, the `pre` range slices to `"console.log(1)\n"` (or without the final newline; assert the slice starts with `console`).
- blockquote: `blockquote` annotated, its inner `p` not.
- sanitizer drops `data-src-from="x"` and a pair with from > to, and drops the attributes from a `span`.
- `keepTableValuesWhole` still wraps tokens in annotated cells (cell `td` keeps its attributes).

- [ ] **Step 2: Run, expect failures**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/markdown.test.js`

- [ ] **Step 3: Implement** as designed.

- [ ] **Step 4: Run `test/markdown.test.js test/source-map.test.js test/editor-live-preview.test.js`, expect PASS.** Add one cross-module assertion to `test/source-map.test.js`: render a document with positions, put it in a `div`, select `middle` in a table cell and `rangeToSource` returns the offsets of `middle` in the source.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/markdown.js test/markdown.test.js test/source-map.test.js
git -C <worktree> commit -m "feat(markdown): optional source positions on blocks and table cells"
```

---

### Task 4: Composer hosting by facet in `editor-comments.js`

Context: the CodeMirror composer is a block widget under the line of `composer.to`. Widgets that replace a range (tables, review hunks) hide it, so they must draw it themselves. Today only an explicit `hosted: true` flag (hunks) says so. Tables need a rule that depends on the mode and the syntax tree, so it becomes a facet.

**Files:**
- Modify: `src/editor-comments.js` (`composerDecorations` at 287, `createComposerElement` at 185)
- Create: `test/editor-comments.test.js`

**Interfaces:**
- Produces:
  - `export const composerHost = Facet.define()` - values are `(state, composer) => boolean`.
  - `export function composerHosted(state): boolean` - true when an open composer has `hosted` or any `composerHost` predicate returns true; false with no composer.
  - `createComposerElement(view, key, { refocus = true } = {})` - with `refocus: false`, Cancel, Escape and a successful submit close the composer without calling `view.focus()`.

- [ ] **Step 1: Write the failing tests** (`test/editor-comments.test.js`, `installEditorDom`, an `EditorView` with `commentsExtension({ onSubmit: async () => {} })`):
- with `composerHost.of(() => true)`, `startCommentAt(view, 0, 4)` draws no `.cm-comment-composer` and `composerHosted(view.state)` is true; without it the composer is drawn.
- the predicate is re-evaluated on reconfiguration: put `composerHost.of(...)` in a `Compartment`, open the composer, reconfigure to `[]`, the composer is now drawn.
- `refocus: false`: build `createComposerElement(view, key, { refocus: false })`, spy `view.focus`, click `.cm-comment-cancel`, assert not called and `commentComposer(view.state) === null`.

- [ ] **Step 2: Run, expect failures**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/editor-comments.test.js`

- [ ] **Step 3: Implement**: replace the `EditorView.decorations.compute([composerField], ...)` with a `StateField` whose value is rebuilt when the composer changed, `tr.docChanged` or `tr.reconfigured`, returning `Decoration.none` when `composerHosted(state)`; provide it through `EditorView.decorations.from(field)`. Add the facet to the module scope (not inside `commentsExtension`) so other modules can provide it.

- [ ] **Step 4: Run the new test plus `test/file-comments.test.js test/note-comments.test.js test/editor-live-preview.test.js`, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-comments.js test/editor-comments.test.js
git -C <worktree> commit -m "refactor(comments): let widgets claim the composer through a facet"
```

---

### Task 5: Live table widget hosts the composer and shows comment tints

Context: see Task 1's root cause. Fix: while a composer's whole range lies inside one table in Live mode, that table renders as the widget even when the selection is in it, and the widget draws the draft tint, the comment tints and the composer (below the table). `TableWidget` keeps its DOM across comment changes via `updateDOM`, as `HunkWidget` does (`src/editor-live-preview.js:319-388`), so focus moving into the composer rebuilds nothing.

**Files:**
- Modify: `src/editor-live-preview.js` (`tableHtml` 48, `TableWidget` 232-265, `buildBlocks` 726-770, `livePreview` return list 946)
- Test: `test/editor-live-preview.test.js`, `test/table-comments.test.js` (remove `todo` from tests A and B)

**Interfaces:**
- Consumes: `composerHost`, `commentComposer`, `shownComments`, `activeComment`, `createComposerElement`, `selectComment` from `src/editor-comments.js` (Task 4); `paintSourceMarks` from `src/source-map.js` (Task 2); `renderMarkdown(source, "", undefined, { positions: true })` (Task 3).
- Produces: nothing new for later tasks.

Design:
- `tableHtml(source)` renders with `{ positions: true }` (offsets relative to the table source; the cache key stays `source`).
- `tableReview(state, from, to)` returns `{ marks, composer }`: `marks` are visible comments (not orphaned, not resolved, `to > from`) intersecting `[from, to)`, clipped and made relative (`- from`), with `className` `cm-comment cm-comment-${author}` plus ` cm-comment-active` for the active one and `id`; plus the draft `{ className: "cm-comment cm-comment-draft" }` when the open composer lies inside `[from, to]`; `composer` is `{ key }` for that composer, else null.
- `buildBlocks`: for a table, `hosts` = open composer with `from >= ref.from && to <= ref.to`; `partial` = open composer overlapping the table without `hosts`. Render the widget when `(!inside || hosts) && !partial`.
- `composerHost.of((state, composer) => isLive(state) && <composer inside one Table node, found with the same container rules as buildBlocks>)` in `livePreview`'s extension list.
- `TableWidget(source, review)`: `eq` = same source and same review (JSON compare, as `sameReview`); `toDOM` stores `dom.tableSource`, paints; `updateDOM(dom, view)` returns false when `dom.tableSource !== this.source`, else repaints and returns true. Painting = `paintSourceMarks(dom, review.marks, source)` and the composer: keep an existing `.cm-lp-table-composer` with the same `data-key`, else replace it with a new one wrapping `createComposerElement(view, key)` appended to the wrapper; remove it for null; `view.requestMeasure()` when the height changed.
- Mousedown in the widget: a target inside `[data-comment-id]` calls `selectComment(view, id)` with `preventDefault` instead of placing the caret; a target inside `.cm-lp-table-composer` is left alone (no `preventDefault`, no caret move), so the textarea and buttons work.
- CSS (`src/styles.css`, near `.cm-lp-table` rules): `.cm-lp-table-composer` spacing like `.diff-hunk .diff-composer-row .cm-comment-composer`.

- [ ] **Step 1: Write the failing tests** in `test/editor-live-preview.test.js` (setup there overrides `hasFocus`; add `commentsExtension({ onSubmit: async () => {} })` to a variant of `setup`):
- "a composer inside a table keeps the table rendered and sits below it": focused, selection on `2` in `| 1 | 2 |`, `startComment(view)`; the `.cm-lp-table` exists, `.cm-lp-table .cm-comment-draft` text is `2`, `.cm-lp-table .cm-comment-composer` exists.
- "focus leaving for the composer does not rebuild the table": keep a reference to the `.cm-lp-table` element and the textarea, `t.setFocus(false)`, `t.view.dispatch({})`, `await settle()` twice (`blockFocusSync` then dispatches `setTableFocus(false)` from a microtask); the same element and textarea are still connected.
- "comments on table text are tinted in the widget": `view.dispatch({ effects: setComments.of([{ id: "c1", from, to, author: "agent", state: "open", orphaned: false }]) })` with the range of `1`; `.cm-lp-table .cm-comment-agent[data-comment-id="c1"]` text is `1`; a second `setComments` with `[]` removes it without replacing the widget element.
- "a composer over a table and the line after keeps the table raw": selection from inside the table to `after`; no `.cm-lp-table`.
- "Source mode draws the plain composer for table text": `editor.setMode("source")`, select table text, `startComment`; `.cm-comment-composer` exists outside any `.cm-lp-table`.

- [ ] **Step 2: Run, expect failures**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/editor-live-preview.test.js`

- [ ] **Step 3: Implement** as designed.

- [ ] **Step 4: Remove the `todo` option from tests A and B in `test/table-comments.test.js`. Run `test/editor-live-preview.test.js test/table-comments.test.js test/file-comments.test.js test/note-comments.test.js test/table-exit-integration.test.js test/editor-tables.test.js`; expect PASS with test C still todo.**

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-live-preview.js src/styles.css test/editor-live-preview.test.js test/table-comments.test.js
git -C <worktree> commit -m "fix(live): keep the comment composer open on table rows"
```

---

### Task 6: Reading-mode comment controller

A module that lets Reading mode take and show comments against the hidden CodeMirror view's state. It opens a `hosted` composer there (so CodeMirror draws nothing), draws the composer element and the tints in the preview, and maps review hunk selections through the existing hunk helpers.

**Files:**
- Create: `src/reading-comments.js`
- Modify: `src/editor-hunks.js` (add `findHunkFence`; make `reviewedChange` use it)
- Modify: `src/diff-hunk.js` (`renderHunkWidgets` at 324: new options)
- Modify: `package.json` (`check:js`: add `node --check src/reading-comments.js`)
- Create: `test/reading-comments.test.js`
- Modify: `src/styles.css` (`.reading-composer`, `.reading-comment-button`, `.markdown-preview .cm-comment { cursor: pointer; }`)

**Interfaces:**
- Consumes: `startCommentAt`, `commentComposer`, `shownComments`, `activeComment`, `commentsDiffer`, `createComposerElement(view, key, { refocus: false })`, `selectComment`, `closeComposer` from `src/editor-comments.js`; `rangeToSource`, `paintSourceMarks`, `blockForSource`, `sourceBlockOf` from `src/source-map.js`; `hunkLineRange`, `hunkSpanRange`, `hunkMarks`, `hunkOffsetPosition` from `src/editor-hunks.js`; `paintMarks`, `paintDots`, `setHunkComposer`, `selectedSpan` from `src/hunk-comments.js`; `isMacLikePlatform` from `src/platform-labels.js`; `EditorView.updateListener`.
- Produces:
  - `findHunkFence(state, { hunk = null, index = -1 }): object | null` in `src/editor-hunks.js`.
  - `renderHunkWidgets(container, { hljs, onToggleReviewed, onLineComment = null, codeComments = null })` where `onLineComment(target, index)` and `codeComments(target) => handlers for enableCodeSelection`, `target = { hunk, index }`.
  - `createReadingComments({ preview: HTMLElement, view: () => EditorView | null, enabled: () => boolean })` returning:
    - `extension` - add to the editor's extensions.
    - `start(): boolean` - maps the current selection, opens a hosted composer; false when nothing maps.
    - `renderWith(fn: () => void): void` - runs a preview render, then re-inserts the composer element and repaints; if the composer textarea had focus before `fn`, focus and its `selectionStart/End` are restored.
    - `hunkOptions(): { onLineComment, codeComments }` - pass to `renderHunkWidgets`.
    - `close(): void` - closes an open composer.
    - `destroy(): void` - removes document listeners.

Design:
- Selection mapping in `start()`: if the selection's anchor is inside a `.diff-hunk` widget, use `selectedSpan(widget, selection)` and `hunkSpanRange(state, findHunkFence(state, targetOf(widget)), span)`; else `rangeToSource(preview, selection.getRangeAt(0), state.doc.toString())`. `targetOf(widget)` = `{ hunk: widget.dataset.hunk ?? null, index: <position among preview's .diff-hunk widgets> }`.
- Paint (on `extension` updates where `commentsDiffer(startState, state)` and `enabled()`, and after `renderWith`): `paintSourceMarks(preview, marks, docText)` with the same class names as Live (`cm-comment cm-comment-${author}`, ` cm-comment-active`, draft `cm-comment cm-comment-draft` for a hosted composer outside hunks); per hunk widget `paintMarks(widget, hunkMarks(state, found, ranges))`, dots as `hunkReview` in `src/editor-live-preview.js:270` does, and `setHunkComposer(widget, { key, row: hunkOffsetPosition(state, found, composer.to).row }, create)` when the composer is in that hunk. Otherwise the composer element goes in a `div.reading-composer` inserted after the preview's top-level child that contains `blockForSource(preview, composer.to)`. `create` returns the element cached for the composer's key (built once with `createComposerElement(view, key, { refocus: false })`). When `activeComment` changes, the first `[data-comment-id=id]` in the preview gets `scrollIntoView({ block: "nearest" })` (guard: the method may be missing in jsdom).
- Clicks: a `click` on the preview whose target is inside `.source-mark[data-comment-id]` calls `selectComment(view, id)`.
- Floating button: on `mouseup` in the preview, when `start`'s mapping would succeed (and the selection is not inside a hunk, which has its own button), show `button.reading-comment-button` ("Comment", `title` "Comment on the selection") positioned below the selection's last client rect relative to the preview; its `mousedown` prevents default; its `click` calls `start()` and hides it. Hide on `selectionchange` when the selection is collapsed or outside the preview.
- Keyboard: `document` `keydown` while `enabled()`: `(isMacLikePlatform() ? event.metaKey : event.ctrlKey) && event.altKey && event.code === "KeyM"` and the event target is not a textarea/input: `preventDefault()` and `start()`.
- Line numbers: `onLineComment(target, index)` opens a hosted composer on `hunkLineRange(state, findHunkFence(state, target), index)`; `codeComments(target)` returns `{ onComment: span => <open on hunkSpanRange>, onMarkClick: id => selectComment(view, id) }`.

- [ ] **Step 1: Write the failing tests** (`test/reading-comments.test.js`: `installEditorDom`, `window.marked = marked`, an `EditorView` from `createMarkdownEditor` with `commentsExtension({ onSubmit })` and the controller's `extension`; a `div.markdown-preview` filled via `controller.renderWith(() => { preview.innerHTML = renderMarkdown(text, "", marked, { positions: true }); renderHunkWidgets(preview, controller.hunkOptions()); })`):
- "start maps a table cell selection and opens a hosted composer below the table": select `beta` text node; `start()` true; `commentComposer(view.state)` has the offsets of `beta`; `.reading-composer` follows the `.table-scroll` element; `.cm-comment-draft` text `beta`; no `.cm-comment-composer` inside `view.dom`.
- "submit sends the range and closing does not focus the hidden editor": click `.cm-comment-add` with a value; `onSubmit` received `{ from, to, body }` of `beta`; `view.focus` spy not called; `.reading-composer` gone.
- "comments are tinted and a click selects the thread": `setComments` with one agent comment on `vague`; `#preview .cm-comment-agent` text `vague`; clicking it calls `onSelect` with the id (pass `onSelect` to `commentsExtension`).
- "a remote edit while composing keeps the text and focus": open composer, type `"half"` in the textarea and focus it, `view.dispatch({ changes: { from: 0, insert: "New line.\n\n" } })`, `renderWith(<render again>)`; the same textarea element is connected, its value is `"half"`, `document.activeElement` is it, and `commentComposer` moved by 11.
- "a hunk line number comments on that line": document with a ` ```diff path=a.js hunk=h1a2b3 ` fence (use an id matching `HUNK_ID` in `src/anchors.js`); click the first `.diff-ln-button`; the composer range equals `hunkLineRange` for row 1; the composer row is inside the hunk (`tr.diff-composer-row`).
- "nothing selected: start returns false".
- "Mod-Alt-M in Reading starts a comment" (Mac platform via `Object.defineProperty(navigator, "platform", { value: "MacIntel" })` before import): keydown `{ code: "KeyM", key: "µ", metaKey: true, altKey: true }` on `document.body` opens the composer when `enabled()` is true and does nothing when false.

- [ ] **Step 2: Run, expect failures**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/reading-comments.test.js`

- [ ] **Step 3: Implement** `findHunkFence` (and use it in `reviewedChange`), the `renderHunkWidgets` options (pass `onLineComment` and `codeComments` into `buildHunkElement`), the controller and the CSS.

- [ ] **Step 4: Run `test/reading-comments.test.js test/diff-hunk.test.js test/editor-hunks.test.js test/hunk-comments.test.js`, expect PASS; `npm run check:js`.**

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/reading-comments.js src/editor-hunks.js src/diff-hunk.js src/styles.css package.json test/reading-comments.test.js
git -C <worktree> commit -m "feat(reading): comment on prose, tables and hunk lines in Reading mode"
```

---

### Task 7: Wire Reading comments into the file editor and Quick Notes

**Files:**
- Modify: `src/comments-panel.js` (`createComments` options, `start` at 406)
- Modify: `src/file-editor.js` (editor extensions ~96-104, `active` 144-147, `renderPreview` 259-275, `setLayoutMode` 745-765)
- Modify: `src/notes.js` (`createComments` 604-617, `createAppEditor` extensions ~641-652, `renderPreviewHunks` 1540, `updateMarkdownPreview` 1547-1581, `setLayoutMode` 1586-1605, `renderedHtmlForCopy` 1688-1700)
- Test: `test/table-comments.test.js` (remove `todo` from test C, add tests), create `test/reading-comments-linux.test.js`

**Interfaces:**
- Consumes: `createReadingComments` and its methods (Task 6); `stripSourceAnnotations` (Task 2); `renderMarkdown(..., { positions: true })` (Task 3); `closeComposer`, `startComment` from `src/editor-comments.js`.
- Produces: `createComments({ ..., startComment = view => startComment(view) })`; `start()` calls it.

Changes:
- `comments-panel.js`: optional `startComment` option as above.
- `file-editor.js`: create `reading = createReadingComments({ preview, view: () => editor.view, enabled: () => layoutMode === "reading" && Boolean(model.active()) })` before the editor (the `view` getter is lazy) and add `reading.extension` to the editor's extensions. `active()` drops the `layoutMode !== "reading"` condition. `createComments` gets `startComment: view => layoutMode === "reading" ? reading.start() : startComment(view)`. `renderPreview` runs its body inside `reading.renderWith(...)`, renders with `{ positions: true }` and passes `...reading.hunkOptions()` to `renderHunkWidgets`. `setLayoutMode`: before switching, `reading.close()` and `closeComposer(editor.view)`; `comment-btn` is no longer disabled in Reading.
- `notes.js`: the same for the primary pane: `enabled: () => currentLayoutMode === "reading" && !isSplitNoteMode`; `active()` returns null only for split-note Reading; `reading.extension` only in the primary editor's extensions (`createAppEditor` gets it through its options for `pane === "primary"`); `updateMarkdownPreview`'s marked branch inside `reading.renderWith`, `{ positions: true }`, hunk options in `renderPreviewHunks` for the primary preview only; `setLayoutMode` closes composers on both editors and `reading.close()`; `comment-btn` enabled in Reading unless split-note mode; `renderedHtmlForCopy` calls `stripSourceAnnotations(copy)` before `exportHunks`.

- [ ] **Step 1: Write the failing tests** (`test/table-comments.test.js`, new `instance` per test):
- remove `todo` from test C.
- "Reading: a review hunk line number comments on that line" (file with a review hunk fence; `mode-reading`; click `.diff-ln-button`; composer in `tr.diff-composer-row`; submit; `anchoredText` is the line's code without `+`).
- "changing mode closes an open composer": open a Reading composer, click `mode-live`; `.cm-comment-composer` absent everywhere and `commentComposer(app.editor().state)` null (import from `src/editor-comments.js`); then open a Live composer on prose, click `mode-reading`; none left.
- "Reading: the comments count and drawer show": `comments-count-btn.hidden === false` in Reading.
- `test/reading-comments-linux.test.js` (`platform: "Linux x86_64"`): in Reading, select prose; keydown `{ code: "KeyM", key: "m", ctrlKey: true, altKey: true }` on `document.body` opens `.reading-composer`; `metaKey` instead does not.
- Quick Notes (`bootApp`, add to `test/note-comments.test.js` as a second test with `instance: 2`): click `mode-reading`, select `Friday` in `#markdown-preview`, click `comment-btn`, fill `#markdown-preview .reading-composer textarea`, click `.cm-comment-add`; `app.registry.comments("a")` ends with `["Friday", <body>]`. (Stripping for copy-as-HTML is unit-tested in Task 2; here only the call is added.)

- [ ] **Step 2: Run, expect failures**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/table-comments.test.js test/reading-comments-linux.test.js test/note-comments.test.js`

- [ ] **Step 3: Implement** the changes above.

- [ ] **Step 4: Run the whole JS suite**: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' npm test`; expect PASS, no `todo` left in `test/table-comments.test.js`.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/comments-panel.js src/file-editor.js src/notes.js test/table-comments.test.js test/reading-comments-linux.test.js test/note-comments.test.js
git -C <worktree> commit -m "feat(reading): enable comments in Reading mode for files and notes"
```

---

### Task 8: Docs and the full CI mirror

**Files:**
- Modify: `ROADMAP.md` (item 9 status; item 12's "works in Live mode only until item 9" sentence)
- Modify: `docs/coedit.md` (a short "Where you can comment" section: Live, Source and Reading; tables; hunk lines; Reading's floating button and shortcut; the mapping limits from the spec: inline HTML can shift an anchor by a few characters, diagrams, images and checkboxes take no comments, split-note Reading takes none)
- Create (do not commit): `.pr-body.md`

- [ ] **Step 1: Edit docs.** ROADMAP item 9: `Status: done, to ship in the next release (spec [`2026-10-18-table-reading-comments-design.md`](docs/superpowers/specs/2026-10-18-table-reading-comments-design.md))`. Item 12: replace "and works in Live mode only until item 9" with "in Live and Reading mode". Check the README feature list mentions comments; if it says Live only, fix it.

- [ ] **Step 2: Write `.pr-body.md`** (uncommitted): summary, root cause paragraph (composer inside the replaced table range; focus moving into the composer re-rendered the table), how it was tested, and a release-notes paragraph: "Comments now work on tables and in Reading mode. Select text in any table cell, in Live, Source or Reading mode, and the comment box stays open under the table. In Reading mode, select text and press ⌘⌥M (Ctrl+Alt+M on Linux and Windows), use the Comment button, or click a review hunk's line number." No em dashes, no mention of tooling.

- [ ] **Step 3: Run the CI mirror** from the worktree root, each must pass:

```bash
NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 900; exec @ARGV' npm run check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo fmt --manifest-path src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:egress
```

Expected: all green, except the 4 MCP socket tests that fail only inside the sandbox.

- [ ] **Step 4: Grep for forbidden text** in the diff: `git -C <worktree> diff main -- . ':!package-lock.json' | grep -nP '\x{2014}'` returns nothing.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add ROADMAP.md docs/coedit.md README.md
git -C <worktree> commit -m "docs(comments): table and Reading mode comments"
```
