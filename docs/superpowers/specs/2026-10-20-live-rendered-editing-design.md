# Live mode: edit tables and code in their rendered form

Date: 2026-10-20. Status: draft for approval.

## Why

In Live mode, a click anywhere in a rendered table switches the whole table to raw pipe source,
and a click on a link puts the caret in it and shows its Markdown. So you cannot select text in a
table to copy or comment on it, and you cannot follow a link by clicking it (only the hover
arrow does that). Reviewing a document with tables and links means fighting the editor.

The owner wants Live mode to stay rendered while you work in it: type into table cells and code
blocks as they look, follow links with a click, and switch a block to raw Markdown only on
purpose, with a pencil button.

This reverses three decisions from 2026-09-27 (ROADMAP item 1): "raw pipe source when entered",
"No cell-grid editing", and "click places cursor" for links. The non-goal "selecting inside a
rendered table without revealing" in the table-reading-comments spec is reversed too.

## Goals

1. **Tables stay rendered in Live** while the caret is in them. Cell text is edited in place.
2. **Code blocks keep their header** while the caret is in them. The code is edited as it looks,
   with the ``` lines hidden.
3. **A pencil button** at the top right of each table and code block switches that block to raw
   Markdown and back.
4. **A plain click on a link follows it** in Live mode, in prose and in tables.
5. Text in a rendered table can be selected, copied and commented on without leaving the
   rendered view, across cells as well as within one.

## Non-goals

- Source mode and Reading mode do not change.
- Reformatting the table source: column padding is not re-aligned after an edit.
- Merged cells, multi-line cells, or editing the separator row and column alignment in the
  rendered view. These need the pencil.
- Review-hunk fences: they keep their current widget and behaviour, with no pencil.
- Tables and fences that Live mode does not render today (in blockquotes, oddly indented,
  fences without a header) stay as they are. Only today's rendered tables and headed fences
  change (my call).
- Notes compare mode and the right pane of split view get the same behaviour only because they
  use the same Live editor; no extra work is planned for them.

## Anti-goals (a failure even if it works)

- Typing in a cell loses characters, moves the caret, or drops focus when the table re-renders,
  including while an agent edits the same file.
- Undo does not undo a cell edit in one step per typing burst, the way it does in prose.
- A drag-select that starts on a link follows the link.
- The pencil adds visual noise: it shows only on hover or when the caret is in the block, in the
  style of the existing fence header.

## Behaviour

### Tables

- A click in a cell puts the caret there, at the clicked character. The table stays rendered.
- **The focused cell shows its raw Markdown** (for example `**bold**`, `[a](b)`, `` `x` ``);
  other cells stay rendered. Leaving the cell renders it again. This is the same reveal rule as
  prose lines, applied per cell.
- Typing, Backspace, Delete, paste (as plain text, newlines become spaces) change that cell's
  source. A `|` typed into a cell is stored as `\|`.
- Keys in a cell:
  - Tab / Shift+Tab: next / previous cell; Tab in the last cell adds a row.
  - Enter: the same column in the next row; in the last row it adds a row.
  - Up / Down: the cell above / below; from the header row Up leaves the table to the line
    above; from the last row Down leaves it to the line below.
  - Left / Right at the start / end of a cell's text move to the previous / next cell.
  - Escape: puts the caret on the line after the table.
  - Undo / Redo work as in prose.
- Moving into a table from the line above or below with the arrow keys puts the caret in the
  first or last row's cell nearest the column it came from.
- **Selecting across cells selects a rectangle of cells**, as in a spreadsheet (owner's
  decision). A drag inside one cell selects text in that cell; once the drag crosses into another
  cell the selection becomes the rectangle between the two cells. Shift+arrow past a cell's edge
  does the same. Selected cells are highlighted whole.
  - Copy gives the rectangle as plain text: cells separated by tabs, rows by newlines (pastes
    into a spreadsheet).
  - Backspace / Delete clears the text of every selected cell in one undo step. Typing does
    nothing while a rectangle is selected (my call).
- **A selection that starts outside the table and ends inside it** (a drag from a paragraph,
  Shift+Down from the line above, or such a comment made in Source mode) shows the table as raw
  pipes, as today (owner's decision).
- Comments: the existing table composer and comment marks keep working. A comment can be
  started from a text selection in one cell or from a rectangle. A rectangle comment is one
  comment: it is stored with the source range from the rectangle's first cell to its last (so the
  comment format does not change), its quoted text is the rectangle's cells (tabs and newlines),
  and only the rectangle's cells are highlighted. This needs the rectangle recorded with the
  comment so the highlight can be redrawn (my call; the builder picks how).
- Backspace in an empty row (all cells empty) deletes the row; Enter in an empty last row
  deletes it and puts the caret below the table, as `getTableEnterEdit` / `getTableBackspaceEdit`
  do today (my call). Adding or deleting rows and columns otherwise needs the pencil.
- An agent's edit to the table while a cell has focus keeps the caret in that cell (mapped
  through the change) and keeps what you typed.

### Code blocks

- The header (label from the info string or path) stays visible and the closing ``` stays
  hidden while the caret is inside the block. The code lines are ordinary editor lines, so typing,
  selection, undo and highlighting work as they do today.
- The caret skips the hidden fence lines: Up from the first code line goes to the line above the
  block, Down from the last code line to the line below.
- **Mermaid blocks** keep the diagram. A click on the diagram no longer opens the source. The
  pencil shows the source with the live diagram preview under it, as today's "caret inside" view.

### Pencil

- A pencil button at the top right of each rendered table and code block header. Tooltip "Edit
  Markdown". When on, it is shown pressed and the tooltip is "Show rendered".
- On: that block shows its raw Markdown (pipes; the ``` lines and info string) with the caret
  where it was, mapped to the source. Off: back to rendered.
- The raw view also turns off when the caret leaves the block, so no table stays raw by
  accident.
- Reachable from the keyboard: with the caret in a block, `Cmd+Alt+E` (`Ctrl+Alt+E` on Windows
  and Linux) toggles it. (Builder: check the shortcut is free.)

### Links

- A plain click on a rendered link (prose, table cell, autolink) follows it, through the same
  `resolveLinkAction` / confirmation path the hover arrow uses today. It acts on mouse up with no
  drag, so a drag that starts on a link selects text.
- Cmd-click (Ctrl-click off macOS) on a link puts the caret in it and shows its Markdown, which is
  how you edit a link with the mouse. Moving onto it with the arrow keys shows it as today.
- The hover arrow button is removed: a click now does what it did.
- A link inside the focused table cell is raw text, so clicking it just places the caret.

## Constraints

- Every edit is an ordinary CodeMirror transaction on the document, so collab sync
  (`@codemirror/collab` in doc-sync.js), history and comment ranges work unchanged.
- `renderMarkdown` stays the only HTML path. Cell source ranges come from its `positions` option
  (`data-src-from` / `data-src-to`), which the table-reading-comments work added.
- Quick Notes uses the same Live editor and gets the same behaviour.
- Tests run under jsdom with the RSS guard; never pass DOM nodes to `assert.equal`.
- CI is Linux: keyboard tests need the Linux navigator preload where shortcuts differ.

## Builder's calls

- How cell editing and the cell rectangle are built (a rectangle can be a set of CodeMirror
  selection ranges, one per cell, or a table-local selection model).
- How a rectangle comment records its cells (for example comment metadata, or deriving the
  rectangle from the stored range's first and last cell).
- How the per-cell reveal re-renders without losing the caret.
- Whether the pencil's on-state lives in a StateField keyed by block position (mapped through
  changes) or elsewhere.

## Delivery

One PR, branch `feat/live-rendered-editing`. It builds on the open PRs #60-#64 (it is branched
from their local merge); it is rebased on `main` and opened after they merge. Docs
(`docs/editor.md` or the closest existing page), ROADMAP (new item) and release notes in the PR
body. No release.
