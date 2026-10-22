# Live mode: edit tables and code in their rendered form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Live mode, tables stay rendered while you type in their cells, code blocks keep their header while you edit them, a plain click follows a link, and a pencil button (or `Mod-Alt-E`) switches one block to raw Markdown on purpose.

**Architecture:**
- **The CodeMirror document and selection stay the only truth.** A caret "in a cell" is an ordinary cursor at a document position inside that cell's source. Typing, IME, undo, collab sync and comment mapping are CodeMirror's own; nothing edits a second copy of the text.
- **Grid mode.** While the editor has focus and the selection is in one rendered table, that table is not replaced by `TableWidget`. Its source lines stay real editor lines, decorated to look like a table: each row line is `display: table-row`, each cell's source segment is a `display: table-cell` mark, pipes, indentation and the separator row are hidden. Consecutive table-row lines form one anonymous CSS table, so columns align. Inline Markdown in cells is decorated by `buildInline` like prose. The focused cell is "revealed" (raw Markdown) the way a caret line is in prose. When focus or the selection leaves, `TableWidget` comes back.
- **A cell rectangle** is a `StateField` (`{ table, anchor: {row, col}, head: {row, col} }`, the table start mapped through changes), and the selection is then a cursor in the head cell. A transaction filter turns any user selection whose ends lie in two cells of the same grid table into a rectangle. Copy, cut, clear and comment read the field.
- **Pure geometry** (rows, cells and their source offsets, escaping, rectangles, quotes) lives in `src/table-cells.js` with no DOM and no CodeMirror. It splits cells exactly like `tableCellRanges` in `src/markdown.js`, so grid offsets match the widget's `data-src-from`/`data-src-to`.
- **Pencil state** is a `StateField` of raw block start positions, mapped through changes, dropped when the caret leaves the block.
- **Code fences** keep the `FenceLabelWidget` header and the hidden closing fence whatever the caret does. A transaction filter moves a cursor that lands on a hidden fence line to the line beyond it in the direction of travel.
- **A rectangle comment** stores its source range from the top-left cell's start to the bottom-right cell's end (format unchanged) plus one new optional field, `cellText` (Rust `cell_text: Option<String>`): the rectangle's cells joined by tabs and newlines, which Rust keeps current whenever it updates `anchored_text`. Its presence marks the comment as a rectangle. The highlight is recomputed from `from`/`to` with `rectRanges`.

**Tech Stack:** Vanilla ES modules, CodeMirror 6 (vendored `src/vendor/codemirror.js`: @codemirror/view 6.43.13, state 6.7.6, @lezer/markdown 1.7.2), marked, jsdom + `node:test`, Rust (Tauri) for the comment field.

**Spec:** `docs/superpowers/specs/2026-10-20-live-rendered-editing-design.md` (approved; binding).

## Global Constraints

- Worktree `/Users/laas/proged/sodilaud/.claude/worktrees/live-rendered-editing` (written `<worktree>` below), branch `feat/live-rendered-editing`. Use absolute paths and `git -C <worktree>`. Never `cd` into `src/vendor` or `node_modules`. No `npm ci`. No `git stash`.
- JS tests, always capped and guarded, from the worktree root: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test <files>`. Never pass DOM nodes (above all CodeMirror ones) to `assert.equal`/`deepEqual`/`strictEqual`. Compare with `assert.ok(a === b)`.
- Rust: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target`. The 4 MCP socket tests fail only inside the sandbox; that is expected.
- New JS source files go into `check:js` in `package.json` (`node --check src/<file>.js`).
- `renderMarkdown` stays the only HTML path. Zero network egress, strict CSP, no new dependencies, no re-vendoring of CodeMirror (static facets such as `EditorView.atomicRanges`, `EditorView.mouseSelectionStyle` and `EditorState.transactionFilter` are reachable through the exported classes).
- Every document edit is an ordinary CodeMirror transaction with a `userEvent` (`input.type`, `input.paste`, `delete.*`, `input`), so collab (`src/doc-sync.js`), history and comment ranges keep working.
- CI runs on Linux. A platform-dependent keyboard test goes in its own `*-linux.test.js` file booted with `platform: "Linux x86_64"` (CodeMirror reads the platform once per process).
- An app-harness test file may boot the app several times only with distinct `instance` values.
- No em dashes anywhere (use `-`). No mention of AI, agents-as-authors or Claude in commits, code or docs. Commit format `type(scope): description`. Code comments only where the why is non-obvious. Do not edit `RELEASE_NOTES.md`.
- Exact copy: pencil tooltip and `aria-label` `"Edit Markdown"`, when pressed `"Show rendered"`. Shortcut `Mod-Alt-e` (Cmd+Alt+E on macOS, Ctrl+Alt+E on Windows and Linux).
- Class names: grid row line `cm-lp-trow` (header row also `cm-lp-trow-head`, separator row `cm-lp-trow-sep`), cell `cm-lp-tcell` (focused `cm-lp-tcell-focus`, in a rectangle `cm-lp-tcell-selected`), pencil `cm-lp-pencil`.
- Constants: `CLICK_SLOP_PX = 4` (a press that moves no further is a click).

## Review Focus

- **An agent edit while a cell has focus** (remote collab transaction in the same cell, another row, or one that deletes the row): the caret stays in the cell, mapped, and the typed text survives. Test: Task 5 "an agent edit in the same table keeps the caret in the cell and the typed text".
- **IME composition in a cell**: composed text is clamped to the cell but never rewritten, and Enter/Tab/arrows confirming a composition are not taken as cell keys. Tests: Task 5 "composed text in a cell is inserted as typed", Task 6 "keys during composition are left to the input method".
- **Undo grouping**: a typing burst in a cell is one undo step. Clearing a rectangle, adding and deleting a row are one step each. Tests: Task 5 "undo removes a typing burst in one step", Task 7 "clearing a rectangle is one undo step", Task 6 "Tab in the last cell adds a row that one undo removes".
- **Escaped pipes and inline code containing pipes**: `a \| b` is one cell everywhere. `` `x|y` `` splits like marked does (two cells). The grid and the widget agree on cell offsets. Tests: Task 1 "rowCells matches tableCellRanges on every fixture", Task 5 "a typed pipe is stored escaped; pasted newlines become spaces".
- **Empty cells** (`||` and `|   |`), short rows and tables without outer pipes: caret placement, typing and row deletion all work. Tests: Task 1 empty-cell fixtures, Task 5 "an empty cell takes the caret and typed text", Task 6 "Backspace in an empty row deletes it".
- **Wide tables** scroll as a widget but wrap in grid mode (an anonymous CSS table cannot scroll on its own). Test: Task 5 "blurring the editor shows the scrolling widget again". The wrap is checked by hand in Task 10.
- **Quick Notes** uses the same Live editor. Test: Task 5 `test/live-table-grid-notes.test.js`.
- **Linux shortcuts**: Ctrl+Alt+E toggles the pencil and Cmd+Alt+E does not. Ctrl-click on a link places the caret. Tests: Task 4 `test/live-pencil-linux.test.js`, Task 2 "off macOS Ctrl-click on a link places the caret and Meta-click follows nothing".

---

### Task 1: Pure table cell model

Context: `src/markdown.js` exports `tableCellRanges(raw)` (line ~293). It splits each table line at unescaped `|`, drops blank outer segments, trims spaces and tabs, and blanks line 1 (the separator). The Live editor needs the same split with untrimmed segment bounds, absolute offsets, rectangles and quoting. This task adds a DOM-free module for that. Nothing uses it yet.

**Files:**
- Create: `src/table-cells.js`
- Create: `test/table-cells.test.js`
- Modify: `package.json` (`check:js`: add `node --check src/table-cells.js`)
- Modify: `src/editor-tables.js:34` (export `isSeparatorRow` if it is not exported)

**Interfaces:**
- Produces (all offsets absolute, UTF-16 code units like CodeMirror):
  - `Cell = { segFrom, segTo, from, to, text }`. `segFrom..segTo` is the source between the pipes, excluding them. `from..to` is the trimmed content, identical to `tableCellRanges`. For an all-blank segment, `from === to === segTo`. `text` is `source.slice(from, to)`.
  - `Row = { from, to, cells: Cell[] }` (`from`/`to` = line bounds).
  - `Grid = { rows: Row[], separator: { from, to }, columns }`. `rows[0]` is the header. The separator line is not in `rows`. `columns = rows[0].cells.length`.
  - `rowCells(lineText: string, lineFrom: number) -> Cell[]`
  - `tableGrid(source: string, offset = 0) -> Grid` (`source` is the whole table; line index 1 is the separator)
  - `cellAt(grid, pos) -> { row, col } | null` (`pos` within `[segFrom, segTo]` of a cell; otherwise `null`)
  - `snapToCell(grid, pos) -> number`: a position inside a cell's content. In padding it clamps to `[from, to]`. Before the first segment it goes to the first cell's `from`. After the last segment it goes to the last cell's `to`. On the separator line it goes to the header cell whose segment covers the same column (else the last header cell), at its `to`.
  - `cellForColumn(row: Row, column: number) -> Cell` (column = offset from `row.from`. The cell whose segment covers it, else the last cell, or the first when the column is before it)
  - `rectCells(grid, a: {row,col}, b: {row,col}) -> Cell[][]` (rows `min..max`, cols `min..max`, cells a short row lacks are skipped)
  - `escapeCellText(text) -> string` (every `|` not already preceded by an odd run of `\` becomes `\|`. `\r\n`, `\n`, `\r` each become one space)
  - `unescapeCellText(text) -> string` (`\|` becomes `|`)
  - `newRowText(headerLineText: string, columns: number) -> string`: the header line's leading whitespace + `"|" + "  |".repeat(columns)`
  - `rectRanges(doc, from, to) -> {from, to}[]`. `doc` is a CodeMirror `Text` (uses `lineAt`, `line`, `lines`). Rows run from the line of `from` to the line of `to`, skipping separator lines (`isSeparatorRow`). Columns run from the cell containing `from` to the cell containing `to` (both by `cellAt` on their own row). Ranges are each cell's `from..to`, empty ones left out. Returns `[]` when either end is not in a cell.
  - `cellQuote(doc, from, to) -> string`: the same cells' `unescapeCellText(text)`, joined by `"\t"` within a row and `"\n"` between rows.

- [ ] **Step 1: Write the failing tests** in `test/table-cells.test.js`.

Fixtures (use all of them in the consistency test):
```js
const FIXTURES = [
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "a | b\n--|--\n1 | 2",
  "| x \\| y | z |\n|---|---|\n| `p|q` | r |",
  "|| b |\n|---|---|\n|   | 2 |",
  "| a | b | c |\n|---|---|---|\n| 1 |",
  "  | a |\n  |---|\n  | 1 |"
];
```
Tests:
- "rowCells matches tableCellRanges on every fixture": for each fixture, `tableGrid(f).rows` content ranges (`from`/`to`) equal `tableCellRanges(f)` lines 0, 2, 3, ... (import from `../src/markdown.js`).
- "segments exclude the pipes and keep padding": `rowCells("| a  | b |", 10)` gives `[{segFrom: 11, segTo: 15, from: 12, to: 13, text: "a"}, {segFrom: 16, segTo: 19, from: 17, to: 18, text: "b"}]`.
- "an escaped pipe stays in its cell; a pipe in inline code splits": fixture 3 header has 2 cells, the first with text `x \| y`. Body row cells are `` `p ``, `` q` ``, `r`.
- "empty cells sit before their closing pipe": fixture 4. Header cell 0 is `{segFrom: 1, segTo: 1, from: 1, to: 1, text: ""}`. Body cell 0 has `from === to === segTo`.
- "cellAt and snapToCell": on fixture 1 with offset 100: `cellAt(grid, 102)` is `{row: 0, col: 0}`. The position of a pipe's right side (the next `segFrom`) is in the next cell. A separator position gives `null`. `snapToCell` on the header's leading `|` gives the first cell's `from`. A separator position at column 5 snaps to header cell 1's `to`.
- "cellForColumn picks the covering cell, else the last": row `| a | bb |` with column 6 gives cell 1, column 40 gives cell 1, column 0 gives cell 0.
- "rectCells skips cells a short row lacks": fixture 5 rect `{0,1}`-`{1,2}` gives `[[b, c], []]`. The second row has only col 0.
- "escape and unescape": `escapeCellText("a|b\\|c\nd")` is `"a\\|b\\|c d"`. `unescapeCellText("a\\|b")` is `"a|b"`.
- "newRowText keeps the indentation": `newRowText("  | a | b |", 2)` is `"  |  |  |"`.
- "rectRanges and cellQuote follow the rectangle, not the source span": doc `Text.of(["x", "| a | b | c |", "|---|---|---|", "| d | e \\| f | g |", "| h | i | j |"])` (import `Text` from `../src/vendor/codemirror.js`). `from` = offset of `b`, `to` = end of `j`. `rectRanges` gives the ranges of `b`, `c`, `e \| f`, `g`, `i`, `j` (columns 1..2 of the three rows). `cellQuote` gives `"b\tc\ne | f\tg\ni\tj"`. A `from` in prose gives `[]` and `""`.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/table-cells.test.js`
Expected: FAIL, cannot find module `../src/table-cells.js`.

- [ ] **Step 3: Implement `src/table-cells.js`** with the signatures above. `rowCells` repeats `lineCellRanges`' backslash-parity rule but keeps the untrimmed segment. Do not change `markdown.js`. `rectRanges` and `cellQuote` share one walk.

- [ ] **Step 4: Run the tests again, plus the existing table tests**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/table-cells.test.js test/editor-tables.test.js`
Expected: PASS. Then `npm run check:js` passes.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/table-cells.js test/table-cells.test.js package.json src/editor-tables.js
git -C <worktree> commit -m "feat(editor): table cell geometry with source offsets"
```

### Task 2: A plain click follows a link; the hover arrow goes

Context: in `src/editor-live-preview.js` (LP), `livePreview().handlers.mousedown` (~line 1035) follows `.cm-lp-link` only on Cmd-click (Ctrl off macOS, `isOpenLinkClick`). `TableWidget.toDOM`'s mousedown (~line 286) does the same for `a[href]` in a rendered table. The `followButton` ViewPlugin (~1088-1168) shows a hover arrow. The new rules: a plain primary click with no modifier follows the link on mouse up, if the pointer moved no more than `CLICK_SLOP_PX` (4). A drag that starts on a link selects text. Cmd-click (Ctrl-click off macOS) places the caret in the link, which reveals its Markdown, using CodeMirror's default handling. The hover arrow is removed.

**Files:**
- Modify: `src/editor-live-preview.js` (handlers.mousedown, `TableWidget.toDOM` mousedown, delete `followButton`, `FOLLOW_HIDE_DELAY_MS`, `linkHref`, the `followButton` entry in `livePreview()`'s return, and its JSDoc for `onOpenLink`)
- Modify: `src/styles.css` (delete the `.cm-lp-follow` rules, ~3803-3832)
- Create: `test/helpers/live-editor.js` (move `setup()` and `settle` out of `test/editor-live-preview.test.js:17-56` unchanged, exported as `setupLive` and `settle`; add `mouseup(target, init)` and `mousemove(target, init)` beside `mousedown`, with `clientX`/`clientY` passed through)
- Modify: `test/editor-live-preview.test.js` (import the helper; replace tests at ~120-158)
- Modify: `test/live-link-open.test.js`

**Interfaces:**
- Produces: `CLICK_SLOP_PX` and `pressLink(view, event, href)` (module-private in LP). `setupLive(text, options)` in `test/helpers/live-editor.js`, used by every later task's tests. It returns the same `t` object as today's `setup()`.

- [ ] **Step 1: Write the failing tests** (in `test/editor-live-preview.test.js`, using `setPlatform` as the file does now)
- "a plain click on a link follows it on mouse up and leaves the caret": `[l](https://x.y)\nother`, caret on line 2. Mousedown, then a mouseup on the document at the same `clientX/Y`, on `.cm-lp-link`. Then `t.opened` deep-equals `["https://x.y"]`, the mousedown event was `defaultPrevented`, and the caret is still on line 2.
- "a press that drags off a link follows nothing": mousedown at (10,10), document mousemove to (40,10), mouseup at (40,10). `t.opened` is empty. A second mouseup on the document afterwards still opens nothing (the listeners are gone).
- "Cmd-click on a link places the caret in it" (MacIntel, `metaKey`): `t.opened` is empty, the event is not `defaultPrevented`, and the selection start is on line 1 (jsdom maps clicks only roughly, as the old test notes).
- "off macOS Ctrl-click on a link places the caret and Meta-click follows nothing" (Win32): Ctrl-click opens nothing and moves the selection to line 1. A Meta-click opens nothing.
- "on macOS Ctrl-click is a right-click and follows nothing".
- "a plain click on a link in a rendered table follows it": `intro\n\n| [t](https://t.y) |\n|---|\n| 1 |\n\nafter`, caret at 0. Mousedown and mouseup on `.cm-lp-table a[href]`. `t.opened` is `["https://t.y"]`.
- "hovering a link shows no follow button": dispatch `mouseover` on `.cm-lp-link`. `t.view.dom.querySelector(".cm-lp-follow")` is null.
- `test/live-link-open.test.js`: change "Cmd-click on a live-preview link opens it through the preview link policy" to a plain click (mousedown and mouseup) with the same expectations.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/editor-live-preview.test.js test/live-link-open.test.js`
Expected: the new tests FAIL (a plain click opens nothing, and Cmd-click follows).

- [ ] **Step 3: Implement**
- `pressLink(view, event, href)`: `preventDefault()`. Record `clientX/Y`. Add `mousemove` and `mouseup` listeners on `view.dom.ownerDocument` (capture). Mouseup within the slop calls `followHref(view, href)`. A move past the slop starts a drag: `view.focus()`, `anchor = view.posAtCoords(start) ?? view.posAtDOM(linkElement)`. Each move dispatches `{ selection: { anchor, head: view.posAtCoords(current) ?? anchor }, userEvent: "select.pointer" }`. Mouseup ends the drag without following. Always remove both listeners on mouseup.
- In `handlers.mousedown`: a primary click with no `metaKey/ctrlKey/altKey/shiftKey` on `.cm-lp-link` calls `pressLink` with `data-href` and returns true, unless `resolveLinkAction(href).kind === "ignore"` (then return false so the click places the caret). Remove the open-link branch: Cmd/Ctrl-click returns false.
- In `TableWidget`'s mousedown: a plain primary click on `a[href]` calls `pressLink`. Cmd/Ctrl-click on a link falls through to the ordinary cell-click path below it.
- `isOpenLinkClick` is now unused. Delete it.

- [ ] **Step 4: Run the tests again**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/editor-live-preview.test.js test/live-link-open.test.js test/link-confirmation.test.js test/file-links.test.js test/table-comments.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-live-preview.js src/styles.css test/helpers/live-editor.js test/editor-live-preview.test.js test/live-link-open.test.js
git -C <worktree> commit -m "feat(editor): follow links with a plain click in Live mode"
```

### Task 3: Code blocks keep their header while the caret is inside

Context: `buildInline.handleFence` in `src/editor-live-preview.js` (~585-613) replaces the opening fence line with `FenceLabelWidget` and hides the closing fence only while the caret is off those lines (`isRevealed`). `FenceLabelWidget.ignoreEvent()` returns false, so a click on the label puts the caret on the fence line and reveals it. Now the header and the hidden closing fence stay whatever the selection does, and a cursor never rests on a hidden fence line. Mermaid and review-hunk fences keep their current handling (`handleFence`'s first branch). A fence with no code lines (` ```\n``` `) and a fence with no `CodeMark` stay as today: shown raw while the caret is on them.

**Files:**
- Create: `src/editor-live-blocks.js` (shared Live block helpers. Later tasks add to it)
- Modify: `src/editor-live-preview.js` (`handleFence`, `FenceLabelWidget`, `livePreview()` return list, `isLive` now imported)
- Modify: `package.json` (`check:js`)
- Test: `test/editor-live-preview.test.js` (replace "a fenced block shows a header label and hides its closing fence until the caret is on them", ~605), new tests below

**Interfaces:**
- Produces in `src/editor-live-blocks.js`:
  - `isLive(state) -> boolean` (moved from LP, same body)
  - `headedFenceAt(state, pos, { mermaid = false } = {}) -> { from, to, open: Line, close: Line | null, first: Line, last: Line } | null`. The `FencedCode` node containing `pos` whose label header Live draws: not a review hunk (`reviewHunkMeta(info) === null`), has a `CodeMark`, has at least one code line. `first`/`last` are the first and last code lines. `close` is the closing fence line or null when unclosed. Mermaid fences count only when `mermaid` (a renderer is configured) is false.
  - `fenceCaretFilter`: an `EditorState.transactionFilter`.

- [ ] **Step 1: Write the failing tests** (use `setupLive` from `test/helpers/live-editor.js`. F stands for three backticks: `TEXT = "intro\nFjs\nlet a;\nlet b;\nF\nafter"`)
- "a fenced block keeps its header and hides its closing fence with the caret inside": caret in `let a;`. `.cm-lp-fence-label` text is `js`. No line text contains F.
- "a cursor moved onto the header goes past it in the direction of travel": from the start of `let a;`, dispatch `{ selection: cursor(open.from + 2), userEvent: "select" }`. The head becomes 5 (end of `intro`). From 5, the same dispatch puts the head at the start of `let a;`.
- "a cursor moved onto the closing fence goes past it": from the end of `let b;` to `close.from + 1` gives the start of `after`. From the start of `after` it gives the end of `let b;`.
- "a fence at the start of the document keeps an upward cursor on its first code line": `"Fjs\nx\nF"`. From the start of `x`, moving to 1 gives the start of `x`.
- "a click on the label puts the caret on the first code line": caret in `after`. Mousedown on `.cm-lp-fence-label`. The head is the start of `let a;`.
- "Backspace at the first code line and Delete at the last leave the fences intact": caret at the start of `let a;`, dispatch `{ changes: { from: first.from - 1, to: first.from }, userEvent: "delete.backward" }`. The doc is unchanged. The same holds for `delete.forward` at the end of `let b;`. A range deletion from `intro` to the middle of `let a;` still applies.
- "an empty fenced block shows its fences when the caret is on them": `"a\nF\nF\nb"`, caret on line 2. A line text is F.
- Keep the review-hunk and mermaid tests passing unchanged.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/editor-live-preview.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
- `handleFence`: when `headedFenceAt` finds the fence, always push the label replace (`marks[0].from..open.to`), always add the `codeblock-foot` line class, and hide the closing mark. Otherwise keep today's revealed logic.
- `FenceLabelWidget.ignoreEvent()` returns true. Its own mousedown (primary only) calls `preventDefault`, dispatches a cursor at the first code line's start, and focuses the view.
- `fenceCaretFilter`: only when `isLive`, `tr.selection` is set, and the new main range is empty. If the head is on a hidden `open` line: moving backward (`tr.startState.selection.main.head > head`) with a line above `open` goes to the end of the line above. Otherwise it goes to `first.from`. If the head is on the hidden `close` line: moving forward with a line below goes to the start of that line. Otherwise it goes to `last.to`. Also, a transaction with `isUserEvent("delete")` whose start selection was empty and whose change touches the `open` line or the `close` line (including the newline between it and the code) is dropped (return `[]`).
- Register `fenceCaretFilter` in `livePreview()`'s returned extensions. The mermaid flag comes from `state.facet(mermaidFacet) !== null`.

- [ ] **Step 4: Run the tests again**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/editor-live-preview.test.js test/editor-hunks.test.js test/syntax-highlighting.test.js`
Expected: PASS (if a listed file does not exist, drop it from the command). `npm run check:js` passes.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-live-blocks.js src/editor-live-preview.js package.json test/editor-live-preview.test.js
git -C <worktree> commit -m "feat(editor): keep code block headers while editing in Live mode"
```

### Task 4: Pencil toggles a block to raw Markdown (Mod-Alt-E)

Context: Live needs a deliberate way to see a table's or fence's raw Markdown. A block is "raw" while its start position is in a mapped list and the caret is inside it. Raw means: a table shows today's raw pipe lines (no widget), and a headed fence shows its ``` lines and info string. `Mod-Alt-e` is unused (checked: `src/` keymaps use `Mod-Alt-m`, `Mod-Alt-[`, `Mod-Alt-]`, `Alt-Mod-1..6`, `Alt-Mod-c`. Tauri menus use only `CmdOrCtrl+Q`). Mermaid gets its pencil in Task 9. Review hunks get none.

**Files:**
- Modify: `src/editor-live-blocks.js`
- Modify: `src/editor-live-preview.js` (`TableWidget`, `FenceLabelWidget`, `buildBlocks`, `handleFence`, `livePreview()`. Move `TABLE_CONTAINERS` and `fillsLines` to editor-live-blocks.js and import them back)
- Modify: `src/styles.css` (pencil)
- Create: `test/live-pencil.test.js`, `test/live-pencil-linux.test.js`

**Interfaces:**
- Consumes: `tableGrid` from `src/table-cells.js` (Task 1). `headedFenceAt`, `isLive` (Task 3).
- Produces in `src/editor-live-blocks.js`:
  - `TABLE_CONTAINERS`, `fillsLines(doc, ref)` (moved)
  - `liveTableAt(state, pos) -> { from, to } | null`: the `Table` node containing `pos` whose ancestors are all in `TABLE_CONTAINERS` and which `fillsLines`
  - `toggleRawBlock: StateEffectType<number>` (a block's `from`)
  - `rawBlocksField: StateField<number[]>`. Mapped with `mapPos(pos, 1)`. After each transaction it keeps only entries that are still a block start (`liveTableAt` or `headedFenceAt` at that position with the same `from`) and contain `selection.main.head`.
  - `isRawBlock(state, from) -> boolean`
  - `pencilBlockAt(state, pos) -> { from, to, kind: "table" | "fence" } | null`
  - `toggleRawCommand(view) -> boolean` (the block under the head. `false` when none)
  - `pressPencil(view, from)`: toggles. When turning on with the head outside the block, also sets a cursor at the block's entry: table = header cell 0's `to`, fence = `first.from`. Focuses the view.
  - `pencilButton(document, pressed: boolean, onPress: () => void) -> HTMLButtonElement`: `button.cm-lp-pencil`, `type=button`, `aria-pressed`, `title` and `aria-label` `"Edit Markdown"` or `"Show rendered"`, an inline SVG pencil. Mousedown calls `preventDefault` and `stopPropagation`. Click calls `onPress`.
  - `PencilWidget(from, pressed)`: a `WidgetType` around `pencilButton` (`eq` on both fields, `ignoreEvent() { return true; }`).

- [ ] **Step 1: Write the failing tests** (`test/live-pencil.test.js` with `setupLive`, MacIntel. F stands for three backticks: `TEXT = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nFjs\nlet a;\nF\nafter"`)
- "rendered tables and fence headers carry an Edit Markdown pencil": `.cm-lp-table .cm-lp-pencil` and `.cm-lp-codeblock-head .cm-lp-pencil` exist, each with `title` "Edit Markdown" and `aria-pressed` "false".
- "the fence pencil shows the raw fences and keeps the caret; pressed again shows the header": caret in `let a;`. Click the fence pencil. Line texts include `Fjs` and `F`. The head is unchanged. A pencil with `aria-pressed="true"` and title "Show rendered" exists. Click it: `.cm-lp-fence-label` is back.
- "the table pencil shows the pipes and puts the caret in the table": caret at 0. Click the table pencil. A line text includes "|---". `liveTableAt(state, head)` is not null.
- "Mod-Alt-E toggles the block under the caret": caret in `let a;`. Keydown on `contentDOM` `{ key: "´", code: "KeyE", keyCode: 69, metaKey: true, altKey: true }` (macOS turns Option-E into a dead key, so CodeMirror falls back to the key code). The fence is raw. Again: not raw. With the caret in `intro` the key does nothing.
- "the raw view ends when the caret leaves the block": toggle the fence on, then caret to `after`. `isRawBlock(state, fenceFrom)` is false and the label is back.
- "an edit above a raw block keeps it raw": toggle on, insert `"x\n"` at 0. Still raw.
- `test/live-pencil-linux.test.js`: `bootMainWindow({ platform: "Linux x86_64", instance: 1, disk: { "/docs/p.md": TEXT }, ... })` with the handlers from `test/table-comments.test.js`. Caret in `let a;`. Keydown `{ key: "e", code: "KeyE", keyCode: 69, ctrlKey: true, altKey: true }` makes the fence raw. `{ key: "e", metaKey: true, altKey: true }` does not.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-pencil.test.js test/live-pencil-linux.test.js`
Expected: FAIL (no pencil).

- [ ] **Step 3: Implement**
- `TableWidget.toDOM` appends `pencilButton(doc, false, () => pressPencil(view, view.posAtDOM(wrapper)))`. The wrapper's mousedown ignores events inside `.cm-lp-pencil`.
- `FenceLabelWidget` takes `from` and renders the label span plus the pencil. Keep `eq` on label and `from`.
- `buildBlocks`: a table with `isRawBlock` gets no widget. Instead add `Decoration.widget({ widget: new PencilWidget(from, true), side: 1 })` at the end of its first line. Every other table rule stays as today.
- `handleFence`: a fence with `isRawBlock` is drawn as today's revealed fence, plus a pressed `PencilWidget` at `open.to`. `fenceCaretFilter` and its delete guard skip raw fences.
- Add `rawBlocksField` and `Prec.high(keymap.of([{ key: "Mod-Alt-e", run: toggleRawCommand, preventDefault: true }]))` to `livePreview()`'s extensions. `blockField` and `inlinePreview` already rebuild on selection changes. Also rebuild `blockField` when `rawBlocksField` changes (compare `tr.startState.field(rawBlocksField) !== tr.state.field(rawBlocksField)`).
- CSS: `.cm-lp-pencil` sits top-right (absolute in `.cm-lp-table`, which gets `position: relative`; floated right in the fence head line). It is hidden (`opacity: 0`) unless `.cm-lp-table:hover`, `.cm-lp-codeblock-head:hover`, the line has `cm-lp-codeblock-caret`, or `[aria-pressed="true"]`. Style it like the fence label (muted, small). `handleFence` adds `cm-lp-codeblock-caret` to the head line's classes while the head is inside the fence.

- [ ] **Step 4: Run the tests again, plus the neighbors**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-pencil.test.js test/live-pencil-linux.test.js test/editor-live-preview.test.js test/table-comments.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-live-blocks.js src/editor-live-preview.js src/styles.css test/live-pencil.test.js test/live-pencil-linux.test.js
git -C <worktree> commit -m "feat(editor): pencil button and Mod-Alt-E to show a block's Markdown"
```

### Task 5: Tables stay rendered with the caret in a cell (grid mode)

Context: today `buildBlocks` (LP ~847) drops the `TableWidget` as soon as the focused selection touches a table's lines, which shows raw pipes. Grid mode keeps the table looking rendered while the caret is in a cell. In grid mode the table's source lines stay editor lines: each row line gets `Decoration.line({ class: "cm-lp-trow" })` (CSS `display: table-row`) and each cell segment gets a `cm-lp-tcell` mark (CSS `display: table-cell`). Pipes, indentation and the separator row's text are hidden with `Decoration.replace({})`. Consecutive table-row lines form one anonymous CSS table, so columns line up. Inline Markdown in cells is decorated by `buildInline` like prose. The focused cell is revealed (raw) instead of the caret line. The focus flag moves from `blockField` into `editor-live-blocks.js`, so the grid module can read it from state.

**Files:**
- Create: `src/editor-table-grid.js`
- Modify: `src/editor-live-blocks.js` (focus field)
- Modify: `src/editor-live-preview.js` (`blockField`, `blockFocusSync`, `buildBlocks`, `buildInline`'s `Table` case and `isRevealed`, `TableWidget` mousedown, `livePreview()` return)
- Modify: `src/styles.css` (grid rules next to `.cm-mode-live .cm-lp-table`, ~3873)
- Modify: `package.json` (`check:js`)
- Create: `test/live-table-grid.test.js`, `test/live-table-grid-notes.test.js`
- Modify: `test/editor-live-preview.test.js` ("tables render as an HTML widget until the caret enters them" ~230 and "clicking a table widget moves the caret into the table" ~254 now expect grid mode), `test/table-comments.test.js` (":293 a table ignores a Reading composer and reveals its source around the caret": the caret now shows the grid, not pipes. Keep its assertion that no Reading composer is drawn in the table)

**Interfaces:**
- Consumes: `tableGrid`, `cellAt`, `snapToCell`, `escapeCellText` (Task 1). `liveTableAt`, `isRawBlock`, `isLive`, `PencilWidget` (Tasks 3-4). `commentComposer` from `src/editor-comments.js`.
- Produces in `src/editor-live-blocks.js`: `setLiveFocus: StateEffectType<boolean>` (replaces LP's `setTableFocus`) and `liveFocusField: StateField<boolean>`.
- Produces in `src/editor-table-grid.js`:
  - `gridTable(state) -> { from, to, grid, cell: {row, col} | null } | null`. Non-null when all of these hold: `isLive`, `liveFocusField` is true, every selection range lies within one `liveTableAt` table, the table is not raw, no non-`outside` composer lies within the table (`from >= table.from && to <= table.to`), and the main range is a cursor in a cell or a range inside one cell's segment. `cell` is that cell. (Task 7 extends this for rectangles.)
  - `gridDecorations(state, table) -> Range<Decoration>[]`: line classes (`cm-lp-trow`, `cm-lp-trow-head` on rows[0], `cm-lp-trow-sep` on the separator, whose whole text is hidden). The hidden ranges around segments. Per cell, a `cm-lp-tcell` mark over `segFrom..segTo` (`cm-lp-tcell-focus` on the focused cell), or, for a zero-length segment, a `Decoration.widget` (side 1) rendering an empty `span` with the same classes. A `PencilWidget(table.from, false)` at the header line's end.
  - `gridExtension() -> Extension[]`: `cellSnapFilter`, `gridEditFilter`, and a `Prec.highest(EditorView.domEventHandlers({ keydown }))` that, in grid mode, swallows Enter and Tab (Task 6 gives them meaning).
  - `tableClickPos(wrapper, source, tableFrom, event) -> number`: the document position for a click in a rendered table. From the clicked `th`/`td` (`data-src-from`/`data-src-to`, relative to `source`): with `document.caretRangeFromPoint` or `caretPositionFromPoint` available, map the hit node and offset through `pointToSource(wrapper, node, offset, "start", source)` (`src/source-map.js`) and clamp to the cell. Without them (jsdom), use the cell's `data-src-to`. Add `tableFrom`.
- Filters:
  - `cellSnapFilter` (`EditorState.transactionFilter`): when `isLive` and the new main selection is a cursor inside a non-raw `liveTableAt` table, replace it with `snapToCell(tableGrid(...), head)`.
  - `gridEditFilter`: when `gridTable(tr.startState)` has a cell and `tr.docChanged` with `isUserEvent("input")` or `isUserEvent("delete")`, and the transaction is not `Transaction.remote` and not annotated `gridEdit` (an `Annotation<boolean>` exported for Tasks 6-7): rebuild the changes so each one is clamped to the focused cell's `[segFrom, segTo]`. Drop any change wholly outside it. Pass inserted text through `escapeCellText`, except when `isUserEvent("input.type.compose")`. Keep the `userEvent` and `scrollIntoView`, and map the selection through the new changes. When nothing remains, return `[]`.

- [ ] **Step 1: Write the failing tests** (`test/live-table-grid.test.js` with `setupLive`. `T = "intro\n\n| a | **b** |\n|---|---|\n| 1 | [l](https://x.y) |\n\nafter"`. Helpers: `posOf(t, needle)`, `rowLines(t)` = lines with class `cm-lp-trow`, and `type(t, text, userEvent = "input.type")` dispatching an insert at the head)
- "a caret in a cell keeps the table rendered as a grid": caret in `1`. No `.cm-lp-table`. 3 `.cm-lp-trow` lines, one `.cm-lp-trow-head`, one `.cm-lp-trow-sep`. The body row's `textContent` contains no `|` and no `https`. `.cm-lp-tcell-focus` `textContent.trim()` is `"1"`.
- "the focused cell shows its Markdown and the others stay rendered": caret inside `**b**`. The focused cell text includes `**b**`. Caret back in `1`: the header row text has no `**`.
- "typing in a cell changes its source and keeps the caret there": `type(t, "x")` after `1`. The doc contains `| 1x |`, grid mode holds, and the head is right after `x`.
- "a typed pipe is stored escaped; pasted newlines become spaces": `type(t, "|")` gives `1\|`. `type(t, "a\nb|c", "input.paste")` gives `a b\|c`.
- "an edit cannot reach past the cell's pipes": a `delete.backward` change over the pipe before `1` leaves the doc unchanged. A `delete.backward` from `segFrom - 1` to the head deletes only within the cell.
- "composed text in a cell is inserted as typed": `type(t, "é", "input.type.compose")` inserts `é`.
- "an agent edit in the same table keeps the caret in the cell and the typed text": type `x` after `1`. Dispatch `{ changes: { from: <start of "1">, insert: "R" }, annotations: Transaction.remote.of(true) }` and a second remote change inserting `"Z"` into the header cell `a`. The doc has `R1x` and `Za`. The head is after `x`. Grid mode holds.
- "undo removes a typing burst in one step": three `type` calls, then `undo(t.view)` (from the vendored module). The doc equals `T`.
- "a click on a rendered cell puts the caret in that cell": caret at 0, `t.setFocus(true)`. Mousedown on the widget's `td` containing `1`. The head equals the end of `1`, and grid mode is on after `settle()`.
- "a selection from outside into the table shows the pipes": anchor in `intro`, head in `1`. A line text includes `|---`.
- "blurring the editor shows the scrolling widget again": caret in `1`, then `t.setFocus(false)` and dispatch an empty transaction. `.cm-lp-table div.table-scroll` exists.
- "an empty cell takes the caret and typed text": `"x\n\n| a |  |\n|---|---|\n||  b |\n\ny"`. Caret into the empty header cell (position before its closing pipe), `type(t, "z")`. The doc has `| a |  z|` and `.cm-lp-tcell-focus` text is `z`. The `||` cell renders as an empty `.cm-lp-tcell` span.
- "Source mode shows plain pipes with the caret in a table": switch mode to source (as the existing "source mode shows raw Markdown" test does). No `.cm-lp-trow`.
- `test/live-table-grid-notes.test.js`: `bootApp({ platform: "MacIntel", registry: { seed: { notes: [{ ...note with T as its text }], imported: true } } })` as in `test/note-comments.test.js`. Focus the editor, caret in `1`, type `x` through `view.dispatch` with `userEvent: "input.type"`. `.cm-lp-trow` lines exist and the note text contains `1x`.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-table-grid.test.js test/live-table-grid-notes.test.js`
Expected: FAIL (the table goes raw on caret entry).

- [ ] **Step 3: Implement**
- Focus: `blockFocusSync` dispatches `setLiveFocus`. `blockField` stores decorations only and rebuilds when `liveFocusField` changes. Register `liveFocusField` in `livePreview()`.
- `buildBlocks` table rule, in this order: raw, so pressed pencil and no widget (Task 4). Composer within the table, so widget. Partial composer, so raw. `gridTable(state)?.from === table.from`, so no block decoration. Selection touches the table lines while focused, so raw (today). Otherwise widget.
- `buildInline`: `case "Table"`. When this node is the grid table, push `gridDecorations(...)` and return true, so inline nodes inside the cells get decorated. Make `isRevealed(from, to)` true for a range inside the grid table only when it overlaps the focused cell's `[segFrom, segTo]`. Otherwise return false as today. The blank-line `gap` pass keeps skipping tables.
- `TableWidget` mousedown: a plain click that is not on a link, mark, pencil or composer dispatches a cursor at `tableClickPos(...)` and focuses. It replaces `view.posAtDOM(wrapper)`.
- Add `gridExtension()` to `livePreview()`.
- CSS (`.cm-mode-live` scoped): `.cm-lp-trow { display: table-row; }`, `.cm-lp-tcell { display: table-cell; }` with the borders, padding and header weight of `.markdown-preview th/td` (copy the values, ~styles.css:1936 and 2152). `.cm-lp-trow-sep { font-size: 0; line-height: 0; }`. `.cm-content` in Live gets `border-collapse: collapse` (inherited by the anonymous table). In `.cm-lp-tcell-focus`, a subtle outline in the accent color.

- [ ] **Step 4: Run the tests again, plus every Live and comment test**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-table-grid.test.js test/live-table-grid-notes.test.js test/editor-live-preview.test.js test/table-comments.test.js test/live-pencil.test.js test/table-exit-integration.test.js test/editor-commands.test.js test/reading-comments.test.js test/doc-sync.test.js`
Expected: PASS. `test/table-exit-integration.test.js` exercises raw tables. If it relied on the caret revealing pipes, it now turns the pencil on first (`pressPencil`), since raw editing goes through the pencil.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-table-grid.js src/editor-live-blocks.js src/editor-live-preview.js src/styles.css package.json test/live-table-grid.test.js test/live-table-grid-notes.test.js test/editor-live-preview.test.js test/table-comments.test.js test/table-exit-integration.test.js
git -C <worktree> commit -m "feat(editor): edit table cells in the rendered table in Live mode"
```

### Task 6: Keys in a table cell

Context: in grid mode (Task 5), the caret is a document position inside a cell, and the grid keydown handler (`Prec.highest` `domEventHandlers` in `src/editor-table-grid.js`) currently swallows Enter and Tab. It must run before `markdownEditingCommands()`' `Prec.high` keydown in `src/editor-commands.js`, which would apply the raw-table edits of `src/editor-tables.js`. This task gives the keys their meaning through one pure-ish command function.

**Files:**
- Modify: `src/editor-table-grid.js`
- Test: `test/live-table-keys.test.js` (create)

**Interfaces:**
- Consumes: `gridTable`, `gridEdit` annotation (Task 5). `tableGrid`, `cellForColumn`, `newRowText` (Task 1). `liveTableAt` (Task 4).
- Produces: `cellKeyCommand(state, key: string, { shift = false } = {}) -> TransactionSpec | null`. `key` is one of `Tab`, `Enter`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Escape`, `Backspace`, `Delete`. It returns null when not in grid mode or when the key keeps its default. Specs that change the doc carry `annotations: [gridEdit.of(true), isolateHistory.of("full")]` and `userEvent: "input"` (row add) or `"delete"` (row delete). Also produces `enterTableSpec(view, forward: boolean) -> TransactionSpec | null` for arrow keys from outside.

Behavior (targets put the caret at the target cell's content `to` unless stated):
- `Tab`: next cell in the row, else the first cell of the next row. In the last cell of the last row, insert `"\n" + newRowText(headerLine, columns)` at the row's end and put the caret in its first cell. `Shift+Tab`: previous cell, else the last cell of the previous row. In the first header cell it does nothing (return a spec with no changes, so the key is still swallowed).
- `Enter`: the same column in the next row. In the last row: if the row is empty (every cell's `text === ""`), delete that line (with its preceding newline) and put the caret at the start of the line after the table, inserting `"\n"` when the table ends the document. Otherwise add a row as Tab does, with the caret in the same column.
- `ArrowUp`/`ArrowDown`: the same column (clamped to the row's last cell) in the row above or below. From the header row, Up goes to the end of the line above the table (null when there is none). From the last row, Down goes to the start of the line below (null when none).
- `ArrowLeft` at `head <= cell.from`: the previous cell's `to` (previous row's last cell from a row's first cell. Null at the very first cell). `ArrowRight` at `head >= cell.to`: the next cell's `from`. Otherwise null (CodeMirror moves within the cell).
- `Escape`: the start of the line after the table, inserting `"\n"` at the table end when there is none.
- `Backspace` with an empty selection at `head === cell.from`: if the row is a body row and empty, delete it and put the caret at the `to` of the same column in the row above. Otherwise a no-op spec (never join cells). `Delete` at `head === cell.to`: a no-op spec.
- Keys with `metaKey`, `ctrlKey` or `altKey`, and any key while composing (`view.composing`, `event.isComposing`, `keyCode === 229`), are not handled. `Shift+Arrow` is left to Task 7.
- `enterTableSpec`: on ArrowDown/ArrowUp outside any grid table, compute `view.moveVertically(main, forward)`. If a non-raw `liveTableAt` table lies between the old head and the new one, or contains the new head, return a cursor in the first (down) or last (up) row at `cellForColumn(row, oldHead - oldLine.from)`, clamped into that cell's content. The keydown handler tries it for unmodified ArrowUp/ArrowDown when not in grid mode.

- [ ] **Step 1: Write the failing tests** (`test/live-table-keys.test.js`, `setupLive`, MacIntel. `T = "above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nbelow"`. `key(t, name, init)` dispatches a keydown on `contentDOM` and awaits `settle()`. `at(t, needle)` puts the caret at the end of `needle`)
- "Tab and Shift+Tab move between cells and rows": from `b`, Tab goes to the end of `1`. Shift+Tab goes back to `b`.
- "Tab in the last cell adds a row that one undo removes": from `4`, Tab adds the line `|  |  |` and the caret is in its first cell, grid mode on. `undo(t.view)` restores `T`.
- "Enter goes down a column and adds a row from the last": from `1`, Enter goes to `3`. From `4`, Enter adds a row with the caret in column 1.
- "Enter in an empty last row deletes it and leaves the table": doc with last row `|  |  |`, caret in it, Enter. The row is gone and the head is at the start of the line after the table.
- "Backspace in an empty row deletes it": empty middle row, caret at its first cell's `from`. Backspace removes the row and the caret is at the end of `1` (the row above, col 0). Backspace at the start of non-empty `3` changes nothing.
- "Up and Down move by row and leave the table at its edges": from `a`, Up gives the end of the line above (the blank line before the table). From `4`, Down gives the start of the line below.
- "Left and Right cross cells only at the edges": caret at the start of `2`, Left gives the end of `1`. At the end of `1`, Right gives the start of `2`. In the middle of a longer cell text, Left is not handled (`cellKeyCommand` returns null).
- "Escape puts the caret after the table, adding a line at the end of the document": with `T`, Escape from `2` gives the start of line `""` after the table. With a doc ending at the table, a newline is appended and the caret is at the doc end.
- "ArrowDown from the line above enters the first row at the nearest column": caret at `above` column 4, the keydown handler path. Jsdom's `moveVertically` is approximate, so test `enterTableSpec` with a stubbed view `{ state, moveVertically: () => EditorSelection.cursor(<table start>) }`. The cursor lands in header cell 1 (column 4 is under `b`'s segment for `| a | b |`).
- "keys during composition are left to the input method": keydown Enter with `isComposing: true` in `4`. No row is added and the doc is unchanged.
- "keys with Cmd, Ctrl or Alt keep their usual meaning": Cmd+ArrowLeft in a cell is not handled.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-table-keys.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** `cellKeyCommand` and `enterTableSpec` as above. The keydown handler maps the event to a key and modifiers, calls `cellKeyCommand(view.state, ...)`, and on a non-null result calls `preventDefault()`, dispatches it with `scrollIntoView: true`, and returns true.

- [ ] **Step 4: Run the tests again, plus the neighbors**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-table-keys.test.js test/live-table-grid.test.js test/editor-commands.test.js test/table-exit-integration.test.js test/editor-tables.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-table-grid.js test/live-table-keys.test.js
git -C <worktree> commit -m "feat(editor): Tab, Enter, arrows and Escape in rendered table cells"
```

### Task 7: Cell rectangles: select, copy, cut, clear

Context: in grid mode, a drag or Shift+arrow that crosses from one cell into another selects a rectangle of cells, as in a spreadsheet. The rectangle lives in a `StateField`, and the CodeMirror selection becomes a cursor in the head cell. Global multiple selections stay off, so the single-range guards in `src/editor-commands.js` keep working. A transaction filter converts cross-cell user selections, so the same code serves mouse drags (CodeMirror's own in grid mode) and Shift+arrows. A drag that starts on the rendered widget needs CodeMirror's mouse pipeline, through `EditorView.mouseSelectionStyle`.

**Files:**
- Modify: `src/editor-table-grid.js`
- Modify: `src/editor-live-preview.js` (`TableWidget.ignoreEvent`, its mousedown listener)
- Modify: `src/styles.css` (`.cm-lp-tcell-selected`)
- Test: `test/live-table-rect.test.js` (create)

**Interfaces:**
- Consumes: `rectCells`, `cellAt`, `unescapeCellText` (Task 1). `gridTable`, `gridDecorations`, `gridEdit`, `tableClickPos` (Task 5). `cellKeyCommand` (Task 6).
- Produces:
  - `setCellRect: StateEffectType<Rect | null>`, `cellRectField: StateField<Rect | null>` with `Rect = { table: number, anchor: {row, col}, head: {row, col} }` (`table` mapped with `mapPos(table, 1)`. Cleared when the table at `table` is gone, or on any transaction that sets a selection without a `setCellRect` effect).
  - `cellRect(state) -> { table, grid, cells: Cell[][], from, to } | null`. `from` is the top-left cell's `from`, `to` the bottom-right cell's `to`.
  - `rectText(state) -> string`: `cells` rows of `unescapeCellText(cell.text)` joined by `"\t"` and `"\n"` (the cells' Markdown source).
  - `gridTable` now also returns `rect` (the `cellRect` value) and is non-null when a rectangle is set even though the selection is a cursor.
- Behavior:
  - `rectSelectionFilter` (`EditorState.transactionFilter`): for `tr.isUserEvent("select")` when the new main range is non-empty, both ends in the same non-raw `liveTableAt` table (in Live), and `cellAt` gives different cells for anchor and head. Replace it with `{ selection: cursor(headCell.to), effects: setCellRect.of({ table, anchor, head }) }`.
  - Keydown (grid mode, extending Task 6's handler). With no rectangle, Shift+Arrow is CodeMirror's, and the filter converts it once it crosses a pipe. With a rectangle, Shift+Arrow moves the rectangle's head by one cell (clamped), Escape/plain arrows drop it (the caret stays in the head cell), and Backspace/Delete clear every cell. The clear is one transaction replacing each cell's `from..to` with `""`, annotated `gridEdit` and `isolateHistory.of("full")`, `userEvent: "delete"`, keeping the rectangle.
  - `gridEditFilter` (Task 5) drops `input.*` transactions while a rectangle is set (typing does nothing).
  - Copy and cut (`Prec.highest` `domEventHandlers`): with a rectangle, set `clipboardData` `text/plain` to `rectText(state)` and `preventDefault()`. Cut also clears as Backspace does.
  - Grid highlight: `gridDecorations` adds `cm-lp-tcell-selected` to every rectangle cell (empty-cell widgets too). CSS gives them the selection background.
  - Widget drag: `TableWidget.ignoreEvent(event)` returns false only for a `mousedown` outside `.cm-lp-table-composer` and `.cm-lp-pencil`, so CodeMirror's mouse handling runs. Every other event stays ignored. The widget's own mousedown listener keeps handling link presses (Task 2) and comment-mark clicks (with `preventDefault`), and no longer dispatches the cursor itself. Register `EditorView.mouseSelectionStyle.of((view, event) => ...)`: for a primary, unmodified mousedown inside a `.cm-lp-table` widget it returns a style whose `anchor = tableClickPos(...)` and whose `get(cur)` gives `EditorSelection.single(anchor, head)`. `head` comes from `tableClickPos` while `cur` is still over a widget, else from `view.posAtCoords(cur) ?? anchor`. `update(u)` maps the anchor through `u.changes` and returns false. Selections from it carry `select.pointer`, so the filter turns cross-cell drags into rectangles.

- [ ] **Step 1: Write the failing tests** (`test/live-table-rect.test.js`, `setupLive`, MacIntel. `T = "x\n\n| a | b | c |\n|---|---|---|\n| 1 | **2** | 3 |\n| 4 | 5 \\| 6 | 7 |\n\ny"`. `drag(t, fromNeedle, toNeedle)` dispatches `{ selection: { anchor, head }, userEvent: "select.pointer" }`)
- "a drag from one cell into another selects the rectangle between them": `drag(t, "b", "5")`. The anchor is col 1 row 0 and the head col 1 row 2, so `cellRect` cells are `[[b], [**2**], [5 \| 6]]`. The selection is a cursor at the end of `5 \| 6`. Three `.cm-lp-tcell-selected` cells.
- "a drag within one cell selects text in that cell": `drag(t, "a", "a")` over the 1-character span selects it normally, and `cellRect` is null.
- "Shift+ArrowRight past a cell edge starts a rectangle and Shift+arrows grow it": caret at the end of `1`, dispatch the selection CodeMirror would produce (`{ anchor: end of 1, head: start of **2**, userEvent: "select.extend" }`). The rectangle is `{0,1}`-`{0,1}` in body rows. Keydown Shift+ArrowDown makes the head row +1, and the selected cells' count is 4.
- "copy gives tab-separated cells with escaped pipes undone": rectangle `a`-`5 \| 6`. Dispatch a `copy` event with a stub `clipboardData` (`{ data: {}, setData(type, value) { this.data[type] = value; } }`) on `contentDOM`. `text/plain` is `"a\tb\n1\t**2**\n4\t5 | 6"` and the event is `defaultPrevented`.
- "clearing a rectangle is one undo step": rectangle over `2`-`7`, keydown Backspace. Those cells' texts are `""` (the doc has `| 1 |  |  |` and `| 4 |  |  |`), and the rectangle is still set. `undo(t.view)` restores `T`.
- "typing does nothing while a rectangle is selected": `type(t, "z")` leaves the doc unchanged.
- "cut copies and clears": cut event → clipboard text set and cells cleared.
- "Escape drops the rectangle and keeps the caret in the head cell".
- "a drag from outside into the table shows the pipes, with no rectangle": anchor in `x`, head in `5`. `cellRect` is null and a line text includes `|---`.
- "a mousedown on the widget starts CodeMirror's selection at the clicked cell": caret at 0. Mousedown (primary) on the widget's `td` with `3`. The head is at the end of `3` (jsdom fallback) and grid mode is on. A mousedown inside `.cm-lp-table-composer` still leaves the selection alone (assert with a composer open as in `test/editor-live-preview.test.js` "focus leaving for the composer does not rebuild the table").

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-table-rect.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified. If CodeMirror's mouse pipeline does not reach `mouseSelectionStyle` under jsdom, keep the integration test and add a direct test of the style's `get()` with synthetic events. Do not fall back to the widget dispatching the cursor itself.

- [ ] **Step 4: Run the tests again, plus every table test**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/live-table-rect.test.js test/live-table-keys.test.js test/live-table-grid.test.js test/editor-live-preview.test.js test/table-comments.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-table-grid.js src/editor-live-preview.js src/styles.css test/live-table-rect.test.js
git -C <worktree> commit -m "feat(editor): select, copy and clear rectangles of table cells"
```

### Task 8: Comments on a cell rectangle

Context: a comment can now start from a rectangle (Task 7). It is one comment, stored with `from` = the top-left cell's start and `to` = the bottom-right cell's end, so `from`/`to`/`anchored_text` keep their meaning and reanchoring (`reanchor`, `map_through` in `src-tauri/src/docs/comments.rs`) keeps working. One optional field marks it: Rust `cell_text: Option<String>` (`#[serde(default, skip_serializing_if = "Option::is_none")]`, JSON `cellText`, since `Comment` is `rename_all = "camelCase"`). It holds the rectangle's cells joined by tabs and newlines. Its presence means "rectangle". Agents and the comments panel show it in place of `anchoredText`. Every place that paints a comment splits a rectangle comment into per-cell ranges with `rectRanges` (Task 1), so only the rectangle's cells are tinted.

**Files:**
- Modify: `src-tauri/src/docs/comments.rs` (field, `cell_text(text, from, to) -> String`, `Comment::quote(&self) -> &str`, refresh in `reanchor` and `map_through`, tests)
- Modify: `src-tauri/src/docs/coedit.rs` (`comment_add` gains `cells: bool`, `agent_view` and `pending_view` use `comment.quote()`), `src-tauri/src/docs/commands.rs` (`NewComment` gains `#[serde(default)] cells: bool`, passed through). Update every other `.comment_add(` call site (about 19, mostly tests in `src-tauri/src/mcp.rs`) to pass `false`.
- Modify: `src/editor-comments.js` (`commentTarget` facet, `startComment`, `startCommentAt`'s `cells` option, composer `cells`, `onSubmit` payload, `commentRanges`, `commentDecorations`)
- Modify: `src/comments-panel.js` (`submit` sends `cells`. The snippet uses `comment.cellText ?? comment.anchoredText`)
- Modify: `src/editor-live-preview.js` (`tableReview`: comment and draft marks through `commentRanges`)
- Modify: `src/reading-comments.js` (`paint`, ~118: ranges through `commentRanges`)
- Modify: `src/editor-table-grid.js` (provide `commentTarget` from the rectangle)
- Test: `test/table-rect-comments.test.js` (create), Rust tests in `comments.rs`

**Interfaces:**
- Consumes: `rectRanges` (Task 1), `cellRect` (Task 7).
- Produces:
  - Rust `pub(crate) fn cell_text(text: &str, from: usize, to: usize) -> String` (UTF-16 offsets like `slice`). Same result as JS `cellQuote` (Task 1): rows from `from`'s line to `to`'s line, separator rows skipped, columns from the cell holding `from` to the cell holding `to`, cells trimmed, `\|` turned back into `|`, tabs between cells and newlines between rows.
  - Rust `Comment::quote(&self) -> &str`: `cell_text` when present, else `anchored_text`.
  - JS `commentTarget` (`Facet<(state) => {from, to, cells: boolean} | null>`) in `editor-comments.js`. `startComment(view)` uses the first non-null value, else the selection.
  - JS `startCommentAt(view, from, to, { hosted, outside, cells = false })`. The composer value carries `cells`, and `onSubmit(view, { from, to, body, cells })`.
  - JS `commentRanges(state, item) -> {from, to}[]`: `item.cellText != null || item.cells === true` gives `rectRanges(state.doc, item.from, item.to)`. Otherwise `[{ from: item.from, to: item.to }]`. It is used for comments and for the draft composer.

- [ ] **Step 1: Write the failing tests**
- Rust (`comments.rs` tests): "cell_text quotes the rectangle, not the source span": text `"x\n| a | b | c |\n|---|---|---|\n| d | e \\| f | g |\n| h | i | j |\n"`, `from` = offset of `b`, `to` = end of `j`. The result is `"b\tc\ne | f\tg\ni\tj"`, the same vector as Task 1. "a cell comment keeps its cell text current through edits": build a `Comment` with `cell_text` set, `map_through` an insert of `Z` inside `e`. `cell_text` reflects `Ze` or `eZ` and `anchored_text` is the new slice. "a comment without cells serializes without cellText": `serde_json::to_value(&comment)` has no `cellText` key.
- JS (`test/table-rect-comments.test.js`, `setupLive` with `comments: true`, MacIntel. `T` from Task 7):
  - "Mod-Alt-M on a rectangle opens one composer drafted on its cells only": rectangle `b`-`5 \| 6`, keydown `{ key: "m", metaKey: true, altKey: true }`. `commentComposer(state)` has `cells: true`, `from` = start of `b`, `to` = end of `5 \| 6`. The rendered widget (the composer hosts it) has `.cm-comment-draft` spans whose texts are `b`, `2` (rendered bold text), `5 | 6`, and none over `1`/`4`.
  - "submit sends cells": the `onSubmit` spy in the helper receives `{ cells: true }`. Extend `setupLive` to record submissions.
  - "a cell comment is tinted on its cells only, in the widget and in the grid": `setComments` with `{ id: "c1", author: "owner", state: "open", from, to, cellText: "b\n**2**\n5 | 6" }`. With the caret in `x` (widget), the texts of `[data-comment-id="c1"]` are `b`, `2`, `5 | 6`. With the caret in `a` (grid), the `.cm-comment` marks cover the same three cells and not `1`.
  - "an ordinary comment across cells is still one range": the same without `cellText` covers `b ... 5 \| 6` as a single source range (today's behavior).
  - "the comments panel quotes a cell comment's cell text": extend `test/table-comments.test.js` with an app-harness test where `fileDocs` returns a comment with `cellText`. The `.comment-snippet` text equals it.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/table-rect-comments.test.js test/table-comments.test.js` and `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked cell_text`
Expected: FAIL.

- [ ] **Step 3: Implement** as specified. In `coedit.rs comment_add`, for a non-reply with `cells`, set `comment.cell_text = Some(cell_text(collab.text(), start, end))` after `Comment::new`. In `reanchor` and `map_through`, wherever `anchored_text` is reassigned, recompute `cell_text` when it is `Some`. Check whether `test/helpers/fake-file-docs.js`'s `comment_add` must keep `cells` (it should store `cellText` when `cells` is true, using `cellQuote`, so harness tests match Rust).

- [ ] **Step 4: Run the tests again, plus the comment suites and Rust**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/table-rect-comments.test.js test/table-comments.test.js test/reading-comments.test.js test/reading-comments-linux.test.js test/file-comments.test.js test/note-comments.test.js test/editor-live-preview.test.js`
Then: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo fmt --manifest-path src-tauri/Cargo.toml --check && CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings && CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked`
Expected: PASS (apart from the 4 sandbox-only MCP socket failures).

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src-tauri/src src/editor-comments.js src/comments-panel.js src/editor-live-preview.js src/reading-comments.js src/editor-table-grid.js test/table-rect-comments.test.js test/table-comments.test.js test/helpers
git -C <worktree> commit -m "feat(comments): comment on a rectangle of table cells"
```

### Task 9: Mermaid blocks keep the diagram; the pencil shows the source

Context: in `src/editor-live-preview.js`, `MermaidWidget` kind `"block"` (~174-232) moves the caret into the fence on mousedown, which swaps the diagram for the source plus a `"preview"` widget (`buildBlocks` ~888-893, rule `inside`). Now a click on the diagram does nothing to the caret. The pencil (Task 4) on the diagram shows the source with the live preview under it, as today's caret-inside view does. A cursor that arrives at a rendered diagram's edge with the arrow keys goes past it. A programmatic selection inside the block (Find, a comment jump) still shows the source, as today.

**Files:**
- Modify: `src/editor-live-preview.js` (`MermaidWidget`, `buildBlocks`, `fenceCaretFilter` usage)
- Modify: `src/editor-live-blocks.js` (`pencilBlockAt` accepts mermaid fences as `kind: "fence"`. Entry position = first code line start)
- Modify: `test/editor-live-preview.test.js` (replace "clicking a diagram moves the caret into its block" ~541. Adjust "with the caret inside, the source stays editable and the diagram renders below it" ~498 to turn the pencil on first)

**Interfaces:**
- Consumes: `pressPencil`, `isRawBlock`, `pencilButton`, `rawBlocksField` (Task 4). `fenceCaretFilter` (Task 3).
- Produces: none new.

- [ ] **Step 1: Write the failing tests** (the mermaid fake renderer already used in `test/editor-live-preview.test.js` ~486-590)
- "clicking a diagram leaves the caret where it was": caret at 0, mousedown on `.cm-lp-mermaid-block`. The head is still 0, and the block widget is still there.
- "the diagram's pencil shows the source with the diagram below": click `.cm-lp-mermaid-block .cm-lp-pencil`. Source lines are visible, a `.cm-lp-mermaid-preview` exists, the head is on the first code line, and a pressed pencil exists. Pressing it again brings the block back.
- "arrowing onto a diagram goes past it": `"a\nFmermaid\ngraph TD\nF\nb"` (F = three backticks). Dispatch a cursor at the block start with `userEvent: "select"` from the end of `a`. The head goes to the start of `b`. From `b` backward, it goes to the end of `a`.
- "a programmatic selection inside the block still shows the source" (no `userEvent`).

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/editor-live-preview.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
- `MermaidWidget` `"block"`: drop the caret mousedown. Append `pencilButton(doc, false, () => pressPencil(view, view.posAtDOM(wrapper)))` (the pencil is absolute top-right, like the table's). Give `eq`/`updateDOM` no new state.
- `buildBlocks` mermaid rule: `preview` when `isRawBlock(state, from)` or the selection is inside (today's `inside` rule. The filter below keeps user cursors out, so only the pencil and programmatic selections get there). Add a pressed `PencilWidget` at the end of the opening line in preview mode when raw.
- Extend `fenceCaretFilter`: for a user `select` cursor landing in a non-raw mermaid block shown as a diagram (`mermaidFacet` set), move it to the start of the line after the block when moving forward, or the end of the line before when moving back (stay at the block edge when there is no such line).

- [ ] **Step 4: Run the tests again**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/editor-live-preview.test.js test/live-pencil.test.js test/mermaid.test.js`
Expected: PASS (drop `test/mermaid.test.js` if it does not exist).

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/editor-live-preview.js src/editor-live-blocks.js test/editor-live-preview.test.js
git -C <worktree> commit -m "feat(editor): keep Mermaid diagrams on click and edit them with the pencil"
```

### Task 10: Docs, roadmap, PR text and the full CI mirror

**Files:**
- Modify: `README.md` (the editing-modes paragraph, ~line 194, and the feature list line ~71)
- Modify: `ROADMAP.md` (new item 18. A one-line pointer under item 1's table and link bullets)
- Create (uncommitted, not ignored by git): `<worktree>/.pr-body.md`

- [ ] **Step 1: README.** Replace the Live sentences about links and tables (~194) with these facts, in the file's style:
  - A click on a link opens it. Cmd-click (Ctrl-click off macOS) puts the cursor in the link to edit it.
  - Tables stay formatted while you type in a cell. The cell you are in shows its Markdown. Tab, Enter, the arrows and Escape move between cells. Tab in the last cell or Enter in the last row adds a row. Dragging across cells selects a rectangle you can copy (tab-separated), clear or comment on.
  - Code blocks keep their header while you edit them.
  - The pencil at a table's or code block's top right, or `Cmd+Alt+E` (`Ctrl+Alt+E` off macOS), shows that block's raw Markdown until you leave it.
  - Remove the hover-arrow sentence.
- [ ] **Step 2: ROADMAP.** Add:
```markdown
## 18. Edit tables and code in their rendered form

Status: done, to ship in the next release (spec [docs/superpowers/specs/2026-10-20-live-rendered-editing-design.md](docs/superpowers/specs/2026-10-20-live-rendered-editing-design.md))

In Live mode tables stay rendered while you type in their cells, with spreadsheet-style cell keys and rectangle selection, copy and comments; code blocks keep their header while edited; a plain click follows a link; a pencil button or Cmd/Ctrl+Alt+E shows one block's raw Markdown. This reverses item 1's "raw pipe source when entered", "no cell-grid editing" and "click places cursor" for links.
```
  Under item 1, after its table and link bullets, add: `Superseded in part by item 18.`
- [ ] **Step 3: `.pr-body.md`.** Write a summary, `Builds on #60-#64.`, and a "Release notes" paragraph for users, covering the README facts in 3-5 sentences. Do not mention any tooling or authorship.
- [ ] **Step 4: Manual check in the app** (record the results in the report, not in files): `npm run tauri dev` (or the project's usual dev command). Open a note with a 2-column table, a table wider than the window, a fence and a mermaid block. Check that the grid's column widths match the widget's within a few pixels, that the wide table wraps in grid mode and scrolls as a widget, the pencil's placement and hover visibility, a Japanese IME composition in a cell, and an agent `apply_edit` to the table while typing in a cell.
- [ ] **Step 5: Full CI mirror**

Run, from the worktree root:
`npm run check:versions && npm run check:js && npm run check:egress`
`RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 900; exec @ARGV' node --test`
`CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo fmt --manifest-path src-tauri/Cargo.toml --check`
`CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`
`CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked`
Expected: all pass, except the 4 MCP socket tests inside the sandbox. `grep -rn $'\u2014' README.md ROADMAP.md .pr-body.md src test docs/superpowers/plans/2026-10-20-live-rendered-editing.md` finds nothing new.

- [ ] **Step 6: Commit** (not `.pr-body.md`)

```bash
git -C <worktree> add README.md ROADMAP.md
git -C <worktree> commit -m "docs(editor): editing tables and code in their rendered form"
```
