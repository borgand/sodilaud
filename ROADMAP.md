# Roadmap

Plans that are agreed but not built yet. Each item ships as its own pull request series and
links its design once one exists. Order is the intended build order. Dependencies are listed
per item.

Design: [`docs/superpowers/specs/2026-09-27-editor-surface-design.md`](docs/superpowers/specs/2026-09-27-editor-surface-design.md)

## 1. Editor swap: CodeMirror 6 live preview

Status: done, shipped in 0.9.0 (#9)

Replace the textarea and the separate preview pane with a CM6 live-preview editor on today's
window-owned model. Collab comes with item 2. Doing the swap first means the registry only
ever has CM6 clients, so no throwaway textarea client gets written. Existing pure edit
functions (smart lists, tables, indent, autocomplete, insert templates) are kept through a
command adapter.

Decided 2026-09-27:

- View modes: **Live** (default), **Source** (the same editor with decorations off) and
  **Reading** (rendered through `renderMarkdown`, read-only). Synced split preview is dropped.
  A stored `split` preference maps to Live.
- Reveal: every line the cursor or selection touches shows raw Markdown (Obsidian style).
- Tables: a rendered HTML table widget when the cursor is outside it, with the raw pipe source
  when entered, where the existing table Tab/Enter/Backspace handling still works. No cell-grid
  editing.
- Compare mode keeps `note-compare.js`, rendered as CM6 decorations (no `@codemirror/merge`).
  Split-note mode becomes a second view.
- `renderMarkdown` stays the only HTML path (Reading, export, copy-as-HTML).
- Typography: proportional body text in Live (sized headings, monospace code); Source stays
  monospace.
- Rollout: a hard switch once the spike passes. No classic-editor setting; rollback means
  installing the previous release.
- Links: a click places the cursor. `⌘`-click opens through the existing URL confirmation.
- Images: only `data:` images render. Remote images stay as muted Markdown source (zero egress,
  CSP `img-src`).

- Spike (~1 day): vendor-bundle CM6, mount it in the secondary pane, port `getSmartKeyEdit`,
  and live-preview headings, emphasis, links and task boxes. Measure mount and swap time on a
  5,000-line note. Input test that must pass: dead keys on the US International layout, which
  a UHK keyboard uses to produce Estonian letters (õ, ä, ö, ü, š, ž). Typing them must work on
  a line where live preview is active and hides markup.

Depends on: nothing.
Later: Vim motions (`@replit/codemirror-vim`), not in the first version.

## 2. Rust-owned document model

Status: done for notes, to ship in 0.11; files join with item 4's merge work

Design: [`docs/superpowers/specs/2026-09-28-rust-document-model-design.md`](docs/superpowers/specs/2026-09-28-rust-document-model-design.md)

Since 0.10 the Quick Notes panel is the only window that edits notes, so a note has one writer
besides agents, and Quick Notes shipped on the window-owned model. This item is still needed
for agent co-editing (item 5) and for three-way merges of files.

Move the workspace collection (notes, folders, trash, order, pins) from `main.js` into a Rust
document registry. Every client sends versioned changes instead of full-text snapshots.

- `main.js` becomes a view over registry events. Every editor surface becomes a
  `@codemirror/collab` client.
- MCP tools call the registry directly. `mcp-writes.js` logic moves to Rust, and agent access
  no longer needs the main window's page to be loaded.
- `localStorage` mode becomes a default SQLite workspace in app data, with a one-time import.

Depends on: 1. Unblocks everything below.

## 3. Quick Notes popover and agent push

Status: done. Panel in 0.10; agent push (`push_quick_note`) built on `feat/mcp-push-open`

Design: [`docs/superpowers/specs/2026-09-28-quick-notes-and-files-design.md`](docs/superpowers/specs/2026-09-28-quick-notes-and-files-design.md)

Decided 2026-09-28: Quick Notes is the whole notes collection, not a subset. The panel carries
today's full notes UI and is editable from the start; the main window became a file editor.
What remains of this item is agent push: an agent puts a note there ("complete plan 5, test
it, then put build instructions for me in a Sodilaud quick note").

- New MCP tool `push_quick_note`, creating a note and optionally showing the panel.

Depends on: nothing (the panel shipped without item 2).
Decided 2026-10-05: `push_quick_note` is a write tool, off until selected. Access and permissions
are now remembered across restarts (see
[`docs/superpowers/specs/2026-10-05-agent-push-and-open-design.md`](docs/superpowers/specs/2026-10-05-agent-push-and-open-design.md)).

## 4. External files and folders

Status: files done in 0.10; folders, merge and the rest not started

Shipped: New, Open, Save As, autosave, open and recent lists across restarts, outside-edit
detection (reload a clean file, Reload / Keep mine for an edited one), `.md`, `.markdown` and
`.txt`, and Finder "Open With". The file list lives in the main window's sidebar, not in
`doc-*` windows. Still to do, in this order:

- Open Folder and the Folders section below
- 3-way merge of outside edits (needs item 2)
- `.csv` and `.tsv`
- MCP drafts (`open_document` for files is built on `feat/mcp-push-open`)
- Find and replace, split view and compare for files

The original plan follows.

Open arbitrary `.md` files and folders outside the workspace, as a Typora replacement.
Autosave (atomic write) with a watcher that 3-way merges external changes. Files are never
reformatted.

- MCP `open_document` opens a path or note. It grants that one file only: no MCP tool lists
  folders.
- MCP drafts: an agent pushes Markdown into a review window, which stays in app data until
  saved as a file or to the workspace.
- Finder "Open With…" through file associations for `.md`, `.txt`, `.csv` and `.tsv`
  (the macOS "opened" event calls `open_document`).
- `.txt` uses the same editor with live preview off. `.csv` and `.tsv` open as plain text
  first; a grid view is a separate editor component, if it is ever needed.

Sidebar model (decided 2026-09-27): file first, folder on demand, like Typora.

- **Open files** section: every one-off file (from Finder, an agent, or Open…), kept as a recent
  list across restarts.
- **Folders** section: a root is added only by an explicit action, "Browse folder" on an open
  file or "Open Folder…". The tree loads one level at a time and watches only expanded
  folders. It hides hidden folders, `.gitignore` matches and `node_modules`, and shows only the
  four file types above.
- Workspace notes stay a separate section. External files never appear in the note list, so
  delete, trash, search, pins and `list_notes` each keep one meaning.
- Rejected: automatic project mode, where opening a file roots its parent folder. Parents such
  as `~/Downloads` are huge, and an agent opening a single file would silently widen scope to
  the folder. Also rejected: files only, with siblings reachable only through Open….

Depends on: 1, 2.
Decided 2026-09-28: open files and folders live in the main window's sidebar.

## 5. Agent co-editing with comments

Status: planned

You and an agent edit the same document at once, and you leave anchored comments that the
agent picks up and acts on. The design is ported from Marginalia; the code is built separately.

- Merge engine: agent `old_text -> new_text` hunks, re-anchored exact, then whitespace-tolerant,
  then fuzzy. User wins. Conflicts are returned to the agent.
- Comments anchored to text ranges, mapped through every change. Orphans are flagged, never
  dropped.
- MCP: `read_document`, `apply_edit`, `get_pending_comments` (long-poll), `resolve_comment`.
- Agent integration installed from a menu: `/sodilaud` command, skill, and a PreToolUse hook
  that sends native Edit/Write on co-edited files through `apply_edit`.

Depends on: 1, 2. Item 4 for files; notes work without it.
First step: hand-test item 2's live agent edits (an append landing in an open note while typing),
which 0.11 covers only with automated tests.
Open: comment storage for external files (app data keyed by path, or a sidecar file).

## 6. Table column widths that avoid wrapping short values

Status: planned

Tables let long-text columns take the width and squeeze short ones until they wrap
character by character. Seen 2026-10-05: in Live mode a `Date` column one character wide
(`2026-09-15` on ten lines) next to a wide description column, and in a second table `LB-01`
split at its hyphen.

Likely causes:

- The Live table widget sits inside the editor content, which wraps lines with CM6's
  `overflow-wrap: anywhere`. That lets a cell's minimum width fall to one character, so the
  auto table layout gives everything to the long column. Reset wrapping inside the widget to
  `normal`.
- Even then, the browser breaks at hyphens and slashes, so dates and IDs still wrap.

Goal: a column narrows below its widest unbreakable value only when the table cannot fit
otherwise.

- Per column, measure the longest whitespace-free token (e.g. `2026-09-30`, `LB-01`), capped
  at about 18 characters, and set it as the column's minimum width (`<colgroup>` or cell
  `min-width`). A value with spaces may still wrap between words: `2026-09-30 14:00` keeps
  the date whole and may push the time to a second line.
- Long prose columns take the remaining width and wrap as now.
- When the minimums add up to more than the editor width, the table scrolls horizontally
  instead of wrapping tokens.
- Same rules in Live, Reading and exported HTML (`renderMarkdown`), so one helper serves all
  three.

Depends on: nothing.

## 7. Mermaid diagrams

Status: planned

Render fenced ` ```mermaid ` blocks as diagrams, the way tables render: a diagram widget in
Live mode when the cursor is outside the block, the raw source when inside it, and the diagram
in Reading mode, export and copy-as-HTML.

- Vendor Mermaid into `src/vendor/` (no CDN, keeping zero egress) and load it lazily, only
  when a document has a Mermaid block. It is large (about 3 MB minified), so measure what it
  adds to the bundle and to first render.
- Run with `securityLevel: "strict"`, which keeps clicks and raw HTML out of diagrams. Check it
  works under the app CSP (`script-src 'self'`, no `eval`) and that diagrams pull nothing
  remote.
- Diagram colors follow the active theme and preset; re-render on theme change.
- A syntax error shows Mermaid's message in place of the diagram, never a blank block.
- Render off the typing path: debounce, and cache by source text so editing elsewhere does not
  re-render every diagram.

Depends on: nothing.
Open: whether a lighter renderer covers the diagrams actually used (flowchart, sequence)
well enough to skip the full bundle.
