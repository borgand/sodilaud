# Comments on tables and in Reading mode

Roadmap item 9, with the leftover from item 12 ("clicking a line number comments on that line's
code ... works in Live mode only until item 9"). A comment can be anchored to any table cell
text from Live, Source or Reading mode, the entry popup (the composer) stays open while the
table widget renders again, and commenting works in Reading mode for prose, tables and review
hunk lines.

Comments stay what item 5 made them: source text ranges in the document Rust owns
(`docs/coedit.md`, `2026-10-05-agent-coedit-design.md`). Nothing changes in Rust, in MCP or in
the comment model. This item is entirely about turning what the reader points at into a source
range, and about drawing the composer and the marks where the reader looks.

## The three bugs and their root cause

Reproduced on 2026-10-18 in the jsdom app harness (`bootMainWindow`, a file with a three-row
table, real focus handling):

| Action | Composer right after | 100 ms later |
|---|---|---|
| `⌘⌥M` on the middle row | shown, table raw | gone, table rendered, focus on `body` |
| `⌘⌥M` on the last row | shown | shown below the rendered table, focus in it |
| Comment button on the middle row | never shown, table rendered | never shown |
| Comment button on the last row | shown below the rendered table | shown |

Causal chain (`src/editor-live-preview.js`, `src/editor-comments.js`):

1. A table renders as `TableWidget`, a block `Decoration.replace` over the table's lines
   (`buildBlocks`), unless the editor has focus and the selection touches the table
   (`revealedLines(state, focused)`).
2. The composer is a block widget at `doc.lineAt(composer.to).to` with `side: 1`
   (`composerDecorations`), so for any row but the last it sits strictly inside the table's
   line range.
3. `createComposerElement` focuses its textarea in a `setTimeout`. Focus leaves
   `view.contentDOM`, so `view.hasFocus` turns false. `blockFocusSync` then dispatches
   `setTableFocus(false)`, `buildBlocks` sees no revealed lines and replaces the table with the
   widget again.
4. A replacing decoration hides every decoration inside its range, so the composer widget is
   dropped and its textarea leaves the DOM. Focus falls to `body`: "the editor blurs, the table
   renders again and no comment entry appears".
5. On the last row the composer sits at the replaced range's end with `side: 1`, so it survives
   below the widget: "commenting works only on the last row".
6. The toolbar button takes focus on mousedown, so step 3 happens before the composer even
   opens, and the composer is created already hidden.

The fault is not focus handling as such: it is that nothing draws a composer whose range lies
inside a table while that table is a widget. Hunk widgets (item 12) solved the same problem by
hosting the composer themselves (`hosted: true`, `setHunkComposer`); tables never got that.

Reading mode (`#markdown-preview`) is a separate render of `renderMarkdown`, with no link from
its DOM back to source offsets, so `comment-btn` is disabled there and `createComments`'
`active()` returns null in Reading (`file-editor.js:146`, `notes.js:611`).

## Goals

- Live: a comment on any table cell text, opened by `⌘⌥M`, the toolbar button or the context
  menu, shows a composer that stays open and focused; existing comments on table text are
  tinted in the rendered table, and clicking one selects its thread.
- Source: unchanged (tables are plain text there and already work); covered by a test.
- Reading: select text in prose, a table cell or a review hunk and comment through the toolbar
  button, `⌘⌥M` (`Ctrl+Alt+M` off macOS) or a floating Comment button; review hunk line numbers
  comment on their line. Existing comments are tinted; clicking one selects its thread; the
  comments drawer and count work in Reading.

## Non-goals

- Cell-grid editing, or selecting inside the rendered Live table without revealing it (item 1
  decided a click enters the raw source; the reveal stays).
- Comments on Mermaid diagrams, images or checkboxes (no text to anchor to).
- Reading-mode comments in Quick Notes split-note mode (two previews); the primary pane's
  single Reading view is covered.
- A comment gutter marker per table row; the gutter keeps one line for the widget, the tint in
  the cells shows where comments are.
- Any change to Rust, MCP tools, `docs/coedit.md`'s comment model or export output.

## Decisions

Given (roadmap item 9 and the task): the three bugs, the goal sentence, Reading support for
prose, tables and hunk lines, a DOM-selection-to-source mapping, reproduction tests first.

My calls:

1. **The table widget hosts the composer (Live).** While a composer's whole range lies inside
   one table, that table renders as the widget even when the selection is in it, and the
   widget draws the composer below the table and the draft tint on the cell text. The switch to
   the widget happens once, when the composer opens, before its textarea exists; afterwards
   focus moving into the textarea changes nothing. Alternative rejected: keep the table raw
   while composing. Simpler, but the reader loses the table they were reading and the goal
   wording ("stays open while the table widget re-renders") points at hosting. Cost if wrong:
   a composer below a long table is further from the cell; the draft tint marks it.
2. **Composer below the table, not below the row.** A row inside a horizontally scrolling
   `table-scroll` box would put the composer in a cell as wide as the table. Same in Reading.
3. **`TableWidget` keeps its DOM across comment changes (`updateDOM`)**, as `HunkWidget` does,
   so a new comment, the active thread or the composer opening never rebuilds the table and
   never recreates the textarea.
4. **Hosting is decided by a facet, not stored.** `editor-comments.js` gets a `composerHost`
   facet of predicates; the CodeMirror composer is drawn unless the composer is `hosted` or a
   predicate claims it. Live preview registers "inside one table, Live mode". In Source mode no
   predicate claims it, so the plain composer shows under the line.
5. **A composer that only partly overlaps a table keeps that table raw** while it is open, so
   the CodeMirror composer under its last line stays visible.
6. **Reading mapping: source positions emitted by `renderMarkdown`, then alignment inside the
   block.** See below. Rejected: re-parsing the hidden editor's syntax tree to find blocks by
   order (fragile against raw HTML and link definitions), and plain `indexOf` of the selected
   text (fails across `**bold**` or links).
7. **Positions are opt-in** (`renderMarkdown(..., { positions: true })`). Reading and the Live
   table widget use them; export and copy-as-HTML from source do not. Copy-as-HTML in Reading
   clones the preview, so it strips annotations, marks and comment controls first.
8. **Reading composes against the hidden editor.** The CodeMirror view stays alive in Reading
   (it already holds folds and hunks' reviewed state). The Reading controller opens a `hosted`
   composer in that view's state, so `onSubmit`, `toConfirmed` and range mapping through agent
   edits are the code item 5 already tests. The composer element is drawn in the preview and
   does not refocus the hidden editor on close.
9. **A composer is closed when the layout mode changes**, so a Reading composer never lingers
   undrawn in Live, and a Live one never in Reading.
10. **Reading re-renders keep the composer element.** A preview render (remote edit, reviewed
    toggle) replaces `innerHTML`; the controller re-inserts the same composer element and gives
    focus back if it had it, so a half-typed comment survives an agent's edit.

## Architecture

```
renderMarkdown(text, fb, marked, {positions})      src/markdown.js
  lexer -> annotate tokens (srcFrom/srcTo) -> parser with renderer that adds
  data-src-from / data-src-to on blocks and table cells -> sanitize (validates attributes)

source-map.js (pure DOM)
  alignText(rendered, source)            greedy alignment, rendered index -> source offset
  pointToSource / rangeToSource          DOM point or Range -> document offsets
  paintSourceMarks(root, marks)          source ranges -> tinted spans
  blockForSource(root, pos)              where to put a composer
  stripSourceAnnotations(root)           for copy-as-HTML

Live:   TableWidget(source, review) + updateDOM          src/editor-live-preview.js
        composerHost predicate for tables
Reading: createReadingComments({preview, view, enabled})  src/reading-comments.js
        start(), renderWith(fn), hunkOptions(), close(), extension
Hosts:  file-editor.js, notes.js, comments-panel.js (startComment option)
```

### Source positions in `renderMarkdown`

- `marked.lexer(source)` gives top-level tokens whose `raw` strings concatenate to the source
  (checked on marked 18.0.12, CM text uses `\n` so offsets match editor positions). Offsets are
  accumulated; if a token's `raw` is not at the cursor, `indexOf(raw, cursor)` is tried, and if
  that fails annotation stops for the rest of the document (rendering is unaffected).
- Annotated: `paragraph`, `heading`, `blockquote`, `list` and each list item (`item.raw` is
  searched inside its list's range), `table`, every header and body cell, and `code`.
- Code: the range is the content only, without the fence lines, so the info string
  (`javascript`, `diff path=...`) can never absorb an alignment.
- Table cells: each source line of the table is split at unescaped `|`; a cell's range is its
  trimmed content. Rows with missing or extra cells annotate what exists. `\|` stays inside the
  cell.
- Nested blocks inside blockquotes and deeper list levels are not annotated: their `raw` has
  the `> ` or indent stripped. Their text maps through the nearest annotated ancestor.
- Attributes: `data-src-from` and `data-src-to`, digits only, `from <= to`, allowed on `p`,
  `h1`-`h6`, `blockquote`, `ul`, `ol`, `li`, `table`, `th`, `td`, `pre`. The sanitizer drops
  anything else. Raw HTML in a document could forge them; the worst outcome is a comment
  anchored to the wrong text of the user's own document, and alignment failure maps to nothing.

### Alignment (rendered text to source)

Within one annotated element, the rendered text (text nodes, skipping `button`, `input`,
`textarea`, `svg`, `.diff-hunk`, `.reading-composer`, `.reading-comment-button`) is aligned to
`source.slice(from, to)` greedily: each rendered character matches the next equal source
character at or after the cursor; whitespace matches any whitespace. A character with no match
(an entity like `&copy;` rendered as `©`) maps to -1 and does not move the cursor.

A selection start maps to the first matched character at or after it; a selection end maps to
one past the last matched character before it, so selecting `bold` in `**bold**` anchors to
`bold`, not to the asterisks. A point outside any annotated element, inside a hunk widget or
inside a diagram maps to null.

Limits (documented in `docs/coedit.md`):

- Inline HTML whose tag names contain the next rendered letter (`<b>b</b>`) can shift a
  mapping by a few characters.
- A rendered character that also appears much later in the source but not nearby can skip
  ahead; prose rarely does this, and the composer shows the tinted draft before submit, so a
  wrong anchor is visible.
- Reference-style link definitions and HTML comments carry no text; nothing anchors to them.
- Text added by Reading mode itself (fold buttons, checkboxes) is skipped and cannot be
  commented on.

### Hunks in Reading

`renderHunkWidgets` gets `onLineComment(target, index)` and `codeComments(target)` options,
where `target` is `{ hunk, index }` as `onToggleReviewed` already uses. The controller finds the
fence with a new `findHunkFence(state, target)` in `editor-hunks.js` and reuses
`hunkLineRange`, `hunkSpanRange`, `hunkMarks`, `paintMarks` and `setHunkComposer`, so Reading
hunks behave exactly like Live ones.

### Reading controller

`createReadingComments({ preview, view, enabled })` in `src/reading-comments.js`:

- `extension`: an update listener added to the editor; when `enabled()` and the comments, the
  active thread or the composer changed (`commentsDiffer`), it repaints.
- `start()`: maps the window selection (or a hunk's own selection) to a range, opens a hosted
  composer with `startCommentAt(view, from, to, { hosted: true })`, returns whether it did.
- Paint: `paintSourceMarks` for visible comments (class names as in Live: `cm-comment
  cm-comment-<author>`, `cm-comment-active`, draft `cm-comment-draft`, `data-comment-id`);
  hunk marks and dots per widget; the composer element (`createComposerElement(view, key, {
  refocus: false })`, cached per key) inside `div.reading-composer`, inserted after the
  top-level preview child holding `blockForSource(preview, composer.to)`, or as a hunk composer
  row. When the active thread changes, its first mark scrolls into view.
- Clicks on a tinted mark call `selectComment(view, id)`.
- A floating `button.reading-comment-button` ("Comment") appears below a mappable selection on
  mouseup and hides when the selection collapses or leaves the preview.
- A document `keydown` listener handles `Mod-Alt-M` while `enabled()`: `metaKey` on a Mac-like
  platform (`isMacLikePlatform`), `ctrlKey` elsewhere, with `altKey` and `code === "KeyM"`
  (`⌥M` on a Mac produces `µ` as `key`).
- `renderWith(fn)`: runs a preview render, then re-inserts the composer and repaints; restores
  focus and the textarea's selection if the composer had focus before.
- `close()`: closes the composer (mode switches).

### Host changes

- `createComments` takes an optional `startComment(view) => boolean`; `start()` uses it.
- `file-editor.js` and `notes.js`: `active()` no longer returns null in Reading (notes: still
  null in split-note Reading); `comment-btn` stays enabled in Reading; Reading renders go
  through `reading.renderWith` with `{ positions: true }` and the hunk options; mode changes
  call `reading.close()` and close any CodeMirror composer.
- `notes.js` `renderedHtmlForCopy` strips annotations from its preview clone.
- CSS: `.reading-composer`, `.reading-comment-button`, and `.markdown-preview .cm-comment`
  where the existing unscoped `.cm-comment` rules need a cursor.

## Edge cases

- Composer open, agent edits the table above: the range maps through the change (item 5); the
  widget's relative review changes, `updateDOM` repaints without rebuilding.
- Composer open, user switches mode: the composer closes (decision 9).
- Selection across two cells or rows: allowed; the comment covers the source between, pipes
  included, as in Source mode. Partial overlap of table and prose: decision 5.
- Empty document in Reading (`*Empty file*` fallback): nothing is annotated, `start()` returns
  false and the notification says to select text.
- Selection inside a hunk widget in Reading with the toolbar button: the hunk's own selection
  maps through `selectedSpan` and the fence.
- Resolved or orphaned comments: not tinted, as in Live.

## Testing

- Reproduction first (`test/table-comments.test.js`, app harness): the three bugs as failing
  tests, committed as `todo` and switched on by the tasks that fix them.
- Unit: `test/source-map.test.js` (alignment, mapping, painting, stripping),
  `test/markdown.test.js` (positions, cell ranges, sanitizer), `test/editor-comments.test.js`
  or the live-preview tests (facet hosting, `updateDOM`), `test/reading-comments.test.js`.
- Integration: Live table comment end to end, Source table comment, Reading prose, table and
  hunk line comments, agent edit while composing in Reading, mode switch closes the composer,
  Linux `Ctrl+Alt+M` in Reading (own file, `platform: "Linux x86_64"`).
