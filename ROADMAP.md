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

Status: files done in 0.10; files joined the document registry with 3-way merge of outside
edits (design: [`docs/superpowers/specs/2026-10-05-files-in-registry-design.md`](docs/superpowers/specs/2026-10-05-files-in-registry-design.md));
folders and the rest not started

Shipped: New, Open, Save As, autosave, open and recent lists across restarts, outside-edit
detection, `.md`, `.markdown` and `.txt`, and Finder "Open With". The file list lives in the
main window's sidebar, not in `doc-*` windows. Open files are registry documents: Rust owns
the text, autosaves it, and merges outside edits (Reload / Keep mine only when both sides
changed the same lines). Still to do, in this order:

- Open Folder and the Folders section below
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

Status: done for files and notes, shipped in 0.11.0 (#20) (spec
[`2026-10-05-agent-coedit-design.md`](docs/superpowers/specs/2026-10-05-agent-coedit-design.md),
guide [`docs/coedit.md`](docs/coedit.md))

You and an agent edit the same document at once, and you leave anchored comments that the
agent picks up and acts on. The design is ported from Marginalia; the code is built separately.

- Merge engine: agent `old_text -> new_text` hunks, re-anchored exact, then whitespace-tolerant,
  then fuzzy. User wins. Conflicts are returned to the agent.
- Comments anchored to text ranges, mapped through every change. Orphans are flagged, never
  dropped.
- MCP: `list_documents`, `read_document`, `apply_edit`, `get_pending_comments` (long-poll),
  `add_comment`, `resolve_comment`.
- Agent integration installed from a menu: `/sodilaud` command, skill, and a PreToolUse hook
  that sends native Edit/Write on co-edited files through `apply_edit`.

Depends on: 1, 2. Item 4 for files; notes work without it.
First step: hand-test item 2's live agent edits (an append landing in an open note while typing),
which 0.11 covers only with automated tests.
Decided 2026-10-05: comments on files are kept in app data, keyed by a hash of the path.

## 6. Table column widths that avoid wrapping short values

Status: done, shipped in 0.13.0 (#27) (spec
[`2026-10-06-table-column-widths-design.md`](docs/superpowers/specs/2026-10-06-table-column-widths-design.md))

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

Status: done, shipped in 0.12.0 (#25) (spec
[`2026-10-06-mermaid-diagrams-design.md`](docs/superpowers/specs/2026-10-06-mermaid-diagrams-design.md))

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
Decided 2026-10-06: the full Mermaid (12.1), lazy-loaded. While the cursor is inside a block, the
source stays editable with the diagram below it. Copy-as-HTML carries inline SVG. The ELK
layout (elkjs, EPL-2.0) is left out, so diagrams use dagre, the Mermaid 11 default.

## 8. `sodilaud` command-line tool

Status: done, shipped in 0.13.0 (#28) (spec
[`2026-10-06-cli-command-design.md`](docs/superpowers/specs/2026-10-06-cli-command-design.md))

Open files in Sodilaud from a terminal: `sodilaud notes.md`. The command starts Sodilaud if it
is not running, opens the file (or files) in the main window, and returns at once.

- Relative paths resolve against the terminal's working directory. A missing file is created
  empty, like New, only for `.md`, `.markdown` and `.txt`, and only in a folder that exists.
- Opens through the same path as Finder "Open With", so recents, the document registry and
  outside-edit merging all apply.
- Installed from a menu item (**Command Line Tool...**) as a script in `~/.local/bin`, with no
  administrator prompt and a PATH hint when needed. macOS and Linux only.

Depends on: 4 (files in the registry).
Decided 2026-10-06: fire-and-forget only, with no new IPC. On macOS the script runs
`open -a <Sodilaud.app>`; on Linux it runs the executable, whose single-instance handoff reaches
the running app. A script, not a symbolic link: a link to the binary on macOS would start a
second process instead of going through Launch Services.
Later: `--wait` (block until the opened files are closed, so the command works as `$EDITOR` and
as the editor for commit messages; exit non-zero if Sodilaud quits first). That reply is the
only reason VS Code and Zed run their own IPC, so it waits until there is demand. It would
likely use the local server MCP already runs.

## 9. Comments on tables and in Reading mode

Status: not started

Seen 2026-10-07 while reviewing a document with the co-edit comments (item 5). Comments work
on prose but fail around tables:

- Selecting text inside a rendered Live table enters the raw source (correct), but the text
  moves, and after it is re-found and selected, the comment button or `⌘⌥M` blurs the editor.
  The table renders again and no comment entry appears.
- Commenting works only on the last row of a table: the rendered table returns and the popup
  shows below it. On any other row nothing appears.
- Commenting is disabled in Reading mode. It should be possible there too, since reviewing is
  mostly done in Reading mode.

Goal: a comment can be anchored to any table cell text from Live, Source or Reading mode, and
the entry popup stays open while the table widget re-renders.

Depends on: 5.

## 10. Review book: skill and checker

Status: not started (spec
[`docs/superpowers/specs/2026-10-07-review-book-design.md`](docs/superpowers/specs/2026-10-07-review-book-design.md))

Items 10 to 14 build a guided code review in Sodilaud: after a feature is complete, the agent
presents the change as a book of chapters, narrative and diagrams first, then the diff hunks
each chapter owns, with links between them. Every hunk of the diff belongs to exactly one
chapter, the reviewer marks each hunk reviewed, and design questions are discussed in comment
threads with the agent. See the spec for the problem, the format and the rejected routes.

Decided 2026-10-07: the whole series is built on the long-running branch `feat/review-book`.
Items 10 to 14 are pull requests against that branch, not `main`, and no release happens until
the complete feature is judged worth keeping and merged to `main` with a merge commit.

This item: the `review-book` skill and its coverage checker in `src-tauri/resources/claude/`,
installed from the Agent Access menu like the `/sodilaud` command. The book is a folder of
Markdown files under `.claude/review/<branch>/`; hunks are `diff` fences with `path=`, `hunk=`
and `lines=` metadata. Acceptance: generate the book for the Mermaid change (#25) and read it
in today's Sodilaud.

Depends on: 5.

## 11. Review book: links and anchors

Status: not started

Heading ids in Reading and Live mode, `#heading` links that scroll, and `chapter.md#heading`
links that open a sibling file. A new command resolves the sibling against the current file's
directory and opens only existing text files inside it or below it.

Depends on: 10.

## 12. Review book: diff hunk widget

Status: not started

A `diff` fence with `path=` renders as a widget in Live and Reading mode: path and line range
header, old and new line numbers, syntax highlighting by file extension, a Reviewed toggle
that writes a `reviewed` token into the fence, a collapse toggle, and a per-line comment
button. Export emits a plain highlighted diff.

Depends on: 11.

## 13. Review book: discussion threads

Status: not started

Comment threads of any depth and either author. New MCP tool `reply_comment`, thread context
in `get_pending_comments`, a nested comments panel with a reply box on every open thread, and
an unread marker for new agent replies.

Depends on: 5. Item 9 can follow this one.

## 14. Review book: folding and outline

Status: not started

Section folding by heading in Live and Reading mode, an outline panel listing headings with
reviewed-over-total counts, and an "n/m reviewed" status bar item.

Depends on: 12.
