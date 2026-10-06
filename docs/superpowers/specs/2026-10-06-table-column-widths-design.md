# Table column widths

Roadmap item 6. Keep short values such as `2026-09-30` and `LB-01` whole in table cells, so a
long prose column cannot squeeze a date column down to one character. The same rules apply in
Live mode, Reading mode and copy-as-HTML.

## Causes

- The Live table widget sits inside the CodeMirror content, which wraps with
  `white-space: break-spaces`, `word-break: break-word` and `overflow-wrap: anywhere`. With
  `anywhere`, a cell's minimum content width is one character, so the auto table layout hands
  the width to the longest column.
- Even with normal wrapping, browsers break after hyphens and slashes, so `2026-09-15` and
  `LB-01` still split in a narrow column.

## Decisions (2026-10-06)

- **Keep tokens whole with `white-space: nowrap` spans, not `min-width` in `ch`.** The roadmap
  suggested measuring each column's longest whitespace-free token and setting it as the
  column's `min-width`. Two problems: `min-width` on `<col>` has no effect in any engine, and on
  table cells it is not reliably honored by WebKit, which renders the app on macOS and Linux.
  A `width` on cells does act as a minimum, but it also marks the column as fixed, so a column
  of `In progress` values would wrap even when the table has room. A `ch` estimate also misses
  bold, code and wide glyphs. Wrapping each short token in a `nowrap` span makes the browser's
  own min-content width of the column equal its longest short token, measured in the real font,
  and the auto layout does the rest. The per-column result is the one the roadmap asks for.
- **Which tokens.** Whitespace-separated runs inside a table cell's text, at most 18 characters,
  that contain a character where a browser may break (anything other than a letter, digit or
  combining mark: `-`, `/`, `.`, `:` and so on). Plain words need no span: they do not break
  under normal wrapping. Tokens with Chinese, Japanese or Korean characters are left alone,
  since those scripts wrap between characters by design. A longer token (a URL, a hash) stays
  breakable, so one long value cannot force a very wide column.
- **Spaces still wrap.** `2026-09-30 14:00` becomes two spans with a space between, so the date
  stays whole and the time may move to a second line.
- **Horizontal scroll.** Each table is wrapped in `<div class="table-scroll"
  style="overflow-x: auto">`. When the short tokens add up to more than the available width,
  that box scrolls instead of the tokens breaking, and the rest of the document does not
  scroll with it.
- **Inline styles.** The span and the scroll box carry inline `style` attributes, so copied HTML
  keeps the behavior without the app stylesheet. The app CSP allows inline style attributes
  (`style-src 'self' 'unsafe-inline'`).

## Helper: `keepTableValuesWhole(root)` in `src/markdown.js`

Runs on a DOM node or fragment. For each `table` it adds the scroll box (once) and wraps the
qualifying tokens in each `th` and `td` text node. It skips text already inside its own spans
and tables already in a scroll box, so a second run changes nothing.

`sanitizeMarkdownHtml` calls it as its last step, after the allowlist pass. Every rendering path
goes through the sanitizer (`renderMarkdown` for Reading mode, Quick Notes, the file editor,
copy-as-HTML and the Live table widget), so one helper serves all of them. Because it runs after
the allowlist, note content cannot forge these elements: a `div` or `span` written in the note
is unwrapped and its `style` is dropped before the helper adds its own.

## Live mode

The table widget keeps its cache and click-to-edit behavior; its cached HTML now includes the
spans and scroll box. `styles.css` resets `white-space`, `word-break` and `overflow-wrap` to
`normal` on `.cm-lp-table`, so prose in cells wraps between words rather than anywhere.

## Trade-offs

- Find in Reading mode matches within one text node. A search that runs across a short token
  and the text next to it in a table cell (for example `on 2026-09-30`) does not match, the same
  as a search across a bold boundary today.
- Copied HTML contains the extra `div` and `span` elements.

## Tests

- `test/markdown.test.js`: tokens with break characters get `nowrap` spans, plain words and
  long or CJK tokens do not, spaces stay between spans, the scroll box wraps each table once,
  text outside tables is untouched, note content cannot forge the styles, and a second pass is
  a no-op.
- `test/editor-live-preview.test.js`: the Live widget renders the spans and the scroll box.
- `test/editor-styles.test.js`: the Live widget resets wrapping to `normal`.
