# Roadmap

Plans that are agreed but not built yet. Each item ships as its own pull request series and
links its design once one exists. Order is the intended build order. Dependencies are listed
per item.

Design: [`docs/superpowers/specs/2026-09-27-editor-surface-design.md`](docs/superpowers/specs/2026-09-27-editor-surface-design.md)

## 1. Editor swap: CodeMirror 6 live preview

Status: implemented on `feat/cm6-editor`, pending manual verification

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
- Images: only `data:` images render. Remote images show as links (zero egress, CSP
  `img-src`).

- Spike (~1 day): vendor-bundle CM6, mount it in the secondary pane, port `getSmartKeyEdit`,
  and live-preview headings, emphasis, links and task boxes. Measure mount and swap time on a
  5,000-line note. Input test that must pass: dead keys on the US International layout, which
  a UHK keyboard uses to produce Estonian letters (õ, ä, ö, ü, š, ž). Typing them must work on
  a line where live preview is active and hides markup.

Depends on: nothing.
Later: Vim motions (`@replit/codemirror-vim`), not in the first version.

## 2. Rust-owned document model

Status: designed

Move the workspace collection (notes, folders, trash, order, pins) from `main.js` into a Rust
document registry. Every client sends versioned changes instead of full-text snapshots.

- `main.js` becomes a view over registry events. Every editor surface becomes a
  `@codemirror/collab` client.
- MCP tools call the registry directly. `mcp-writes.js` logic moves to Rust, and agent access
  no longer needs the main window's page to be loaded.
- `localStorage` mode becomes a default SQLite workspace in app data, with a one-time import.

Depends on: 1. Unblocks everything below.

## 3. Quick Notes popover and agent push

Status: planned, priority

A popover window, modeled on the clipboard popup (warm panel, non-activating, hotkey), for
glancing at and copying from short-lived notes. An agent can push a note there: "complete plan
5, test it, then put build instructions for me in a Sodilaud quick note."

- v1: rendered Markdown, read-only, with a copy button per code block, plus keep, delete and
  "open in main window".
- v2: editable in place (a compact CM6 surface).
- New MCP tool `push_quick_note`.

Depends on: 2.
Open: Quick Notes scope (reserved folder, separate workspace, or tag). Whether
`push_quick_note` is on by default, given that write tools reset to off at every start
(needs a security review).

## 4. External files and folders

Status: planned

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
Open: whether open files and folders live in the main window's sidebar (leaning this way: one
place, and the popover is already the lightweight surface) or in separate windows per folder
root. The spec currently assumes separate `doc-*` windows.

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
Open: comment storage for external files (app data keyed by path, or a sidecar file).
