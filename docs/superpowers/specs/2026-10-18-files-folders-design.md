# External files and folders: the rest of ROADMAP item 4

Finish ROADMAP item 4. Files shipped in 0.10 and joined the document registry later; four parts
are left, built in this order on `feat/files-folders` (stacked on `feat/multi-window`):

## Sub-features

1. **Open Folder and the Folders section.** A folder root is added only by an explicit action
   (**Open Folder…**, or **Show Folder in Sidebar** for the shown file). The tree loads one level
   at a time, watches only expanded folders, hides hidden entries, `.gitignore` matches and
   `node_modules`, and shows only `.md`, `.markdown`, `.txt`, `.csv` and `.tsv` files. No
   automatic project mode. Plan tasks 1-5.
2. **`.csv` and `.tsv`.** Open as plain text with live preview off, like `.txt`; Finder
   "Open With" associations. Plan tasks 6-7.
3. **MCP drafts.** An agent pushes Markdown into a review window; the draft stays in app data
   until it is saved as a file or to Quick Notes, or discarded. Plan tasks 8-9.
4. **Find and replace, split view and compare for files.** These exist for Quick Notes; bring
   them to the file editor. Plan tasks 10-13.

Plan task 14 is docs, the roadmap and the CI mirror.

## Goals

- A main window's sidebar gets a **Folders** section between Open files and Outline. Each
  window has its own roots, which come back after a restart with the folders that were
  expanded.
- A click on a file in the tree opens it like Open File (the window rules of multi-window R3
  apply: a file open in another window is shown there).
- `.csv`, `.tsv` and `.txt` open as plain text: no Markdown decorations, no Markdown keys, Tab
  types a tab, Reading shows the text as it is.
- `push_draft` (MCP write tool, off until selected) opens a draft in the most recently focused
  main window. The draft is a real document the user and the agent can edit and comment on.
- Find and replace (Cmd+F), split view (Cmd+\\) and compare in the file editor, behaving as
  they do in Quick Notes.

## Non-goals

- No MCP tool lists folders or reads folder entries. `list_documents` still lists only open
  documents.
- No file operations in the tree (rename, delete, new file, drag and drop), no search across a
  folder, no "Reveal in Finder".
- No grid editor for CSV/TSV.
- The open-file context menu is not changed here: multi-window Task 7 builds it on
  `feat/multi-window` (`src/open-file-menu.js`). Adding "Show Folder in Sidebar" to it is a
  follow-up after both land. Nothing here depends on that module.
- Find Results ("Show All Matches" and the "All notes" scope) stays a Quick Notes feature.
- `core.excludesFile` and `.git/info/exclude` are not read.

## Current architecture (relevant parts)

- **Grants** (`src-tauri/src/files/grants.rs`): a set of canonical file paths. Only a native
  dialog, Finder/CLI/launch arguments, MCP `open_document`, a sibling link
  (`file_doc_open_sibling`, any text file in the linking file's folder or below), or
  `files.json` adds one. Every file command calls `Files::require`.
- **Window set** (`src-tauri/src/files/windows.rs`): `WindowEntry { label, open, active, frame }`,
  persisted as `SavedWindow` in `files.json` `windows[]` (`files/store.rs`), with
  `#[serde(default)]` fields so new fields need no migration. `Files::update` persists and
  replaces the watched file set after every change.
- **Watcher** (`files/watch.rs`): a 1 s poll of size and mtime of open files, run by the thread
  in `files::start` (`files/mod.rs`).
- **Text file rule**: `is_text_file` (`files/mod.rs`, `md|markdown|txt`), `TEXT_EXTENSIONS`
  (`files/commands.rs`, dialog filter), the `sodilaud` script `case` in `src-tauri/src/cli.rs`,
  `SIBLING_EXTENSION` in `src/markdown.js`, and `fileAssociations` in
  `src-tauri/tauri.conf.json`. `.txt` currently gets the full Markdown treatment (live preview,
  smart keys); nothing in `src/` treats it differently.
- **Page**: `src/file-editor.js` (one CM6 editor `#editor-host`, `src/files.js` model, collab
  through `src/doc-sync.js`, which supports several clients per document), wired in `src/app.js`
  with `listenHere`. Sidebar `#files-sidebar` holds `#open-files-list` and `#outline-section`; it
  is hidden while no file is open.
- **Quick Notes find/split/compare** (`src/notes.js`): the find bar (2297-2534, 2743-2803) works
  on the primary editor through `findTextMatches` (`src/find.js`) and the generic CM6 find field
  (`editor.setFindMatches`); replacements go through `editor.applyEdit`. Split view
  (3217-3400) is a second editor with per-pane state maps; compare (3068-3215) uses
  `compareNoteText` (`src/note-compare.js`) with a 150 ms debounce and cache in `notes.js`, and
  `editor.setDiff`. `index.html` does not load `vendor/diff.min.js`.
- **MCP** (`src-tauri/src/mcp.rs`): `READ_TOOLS` / `WRITE_TOOLS`; writes default off
  (`saved_permissions`); `push_quick_note` goes through `Registry::agent_write` (requestId
  receipts) into the "From agents" folder; `open_document` calls `files::open_for_agent`, which
  ends in `present_pending` (route to owner or most recently focused window, `file-open-request`).

## Decisions

Given (from the roadmap item and the task):

1. Roots are added only by Open Folder or "Browse folder" on an open file; one level at a time;
   watch expanded folders only; hide hidden folders, `.gitignore` matches, `node_modules`; show
   only the five file types; no automatic project mode.
2. `.csv`/`.tsv` open as plain text, live preview off; Finder associations.
3. Drafts stay in app data until saved as a file or to the workspace.
4. Find/replace, split and compare come to files.
5. No MCP tool lists folders.

Rulings (my call, grounded in the code):

- **R1 Folders are per window.** `WindowEntry` and `SavedWindow` gain `folders: Vec<String>`
  (canonical roots, sidebar order) and `expanded: Vec<String>` (canonical folders). The same
  root may appear in several windows; folders are views, not ownership. Closing a non-last
  window drops its folders with it. A window that fails at launch (`fold_into_target`) hands
  its roots to the target window (appended, no duplicates). Accepted controller proposal; it
  matches multi-window's "Room for folders".
- **R2 The window's folder list is the folder grant.** No folder entry in `Grants`. A folder
  command takes a path, canonicalizes it, and accepts it only if it is a root of the calling
  window or below one (`starts_with` after canonicalization, so `..` and symbolic links that
  leave the root are refused). Roots enter the list only through `folder_open_dialog` (native
  folder picker) or `folder_browse(path)`, where `path` must be a granted file open in the
  calling window; the root is its parent folder. `files.json` is written only by Rust, so
  restored roots are earlier user choices, as for files. Why no dialog for Browse: the page can
  already open any text file in that folder or below through `file_doc_open_sibling`, so listing
  it adds enumeration only, and it stays a click in the UI.
- **R3 Opening from the tree** goes through `folder_open_file(path)`: the file must be under a
  root of the calling window and pass the same filter as the listing (type, not hidden, not in
  `node_modules`, not `.gitignore`d). It is then granted like a dialog choice and opened with
  `file_doc_open`. Anything the tree does not show cannot be granted through it.
- **R4 Capabilities.** The new folder and draft commands are declared in `build.rs`, registered
  in `lib.rs` and granted only in `capabilities/default.json` (`main`, `main-*`). Quick Notes and
  the clipboard popup cannot list folders. Every command also checks `require_main`.
- **R5 Listing.** `folder_list(path)` returns one level: folders first, then files, each group
  sorted by lowercased name, then by name. Hidden means a name starting with `.`. Symbolic
  links are followed only when the target stays inside the root. At most `LIST_LIMIT = 2000`
  entries are returned and at most `SCAN_LIMIT = 20000` directory entries are read; either cap
  sets `truncated: true` and the tree shows "Some items are not shown." Empty folders are shown.
- **R6 `.gitignore`.** A small matcher written here (`files/ignore.rs`), no new crate (a new
  crate needs an unsandboxed fetch and review). It reads `.gitignore` files from the git top
  (the nearest ancestor of the root, the root included, that contains `.git`) down to the
  listed folder; without a `.git` ancestor, from the root down. Supported: comments, blank
  lines, `\#` and `\!` escapes, `!` negation, trailing `/` (folders only), a `/` at the start or
  in the middle anchoring to the `.gitignore`'s folder, `*`, `?`, `[...]` (with `!`/`^` and
  ranges), `**/`, `/**` and `/**/`. Trailing spaces are trimmed unless escaped. Later lines win;
  a folder that is ignored hides everything under it (git's rule that a negation cannot
  re-include a file in an ignored folder).
- **R7 Watcher budget.** A folder watcher polls, on the existing 1 s thread, the mtime of each
  watched folder; when it changes, it relists with the R5 filter and emits `folder-changed
  { path }` to every main window only if the visible listing changed. Watched folders are the
  union, in window order, of every window's roots and expanded folders, capped at
  `FOLDER_WATCH_LIMIT = 128`. Folders past the cap list fresh each time they are expanded but
  do not update live. An edit to a `.gitignore` takes effect at the next listing of that folder
  (atomic saves change the folder mtime, so it is usually at once). Cost: one `stat` per watched
  folder per second.
- **R8 Expansion state** lives in the page and is reported with `folder_set_expanded(paths)`
  after each expand or collapse; Rust keeps only paths inside the window's roots, persists them
  and updates the watcher. Roots are expanded when added.
- **R9 Sidebar.** The sidebar shows while a window has an open file **or** a root. The Folders
  section has a heading "Folders", one tree (`role="tree"`) per window with root rows that have
  a × button ("Remove <name> from the sidebar"). The shown file's row is marked `.active`. The
  tree is keyboard navigable (ArrowUp/Down, Right expands or moves in, Left collapses or moves
  to the parent, Home/End, Enter or Space opens). File menu gets **Open Folder…**
  (Cmd+Shift+O, Ctrl+Shift+O elsewhere) and **Show Folder in Sidebar** (enabled when the shown
  file has a path); the start page gets **Open Folder…**. A draft's folder cannot be shown
  (it is app data); the item is disabled for drafts.
- **R10 Plain text kind.** `.txt`, `.csv` and `.tsv` are "plain" files (a behavior change for
  `.txt`, which today gets live preview; the roadmap's original plan says `.txt` has live
  preview off). For plain files: no live preview decorations in either Live or Source, no
  Markdown syntax highlighting, no smart keys or Markdown paste, no section folding, Tab
  inserts a tab character, the formatting toolbar is disabled, the outline is empty, and
  Reading shows the text in a `<pre class="plain-text-preview">`. The Live/Source buttons still
  switch the shared preference; on a plain file both show the same plain editor. Implemented as
  an editor-level `plainTextFacet` toggled per shown buffer, which every Markdown-only extension
  checks.
- **R11 CSV/TSV everywhere a text type is listed**: one `pub const TEXT_EXTENSIONS` in
  `files/mod.rs` used by `is_text_file` and the Open dialog filter; Save As adds "CSV" and "TSV"
  filters and puts the filter of the buffer's own extension first; the `sodilaud` script,
  `SIBLING_EXTENSION`, MCP `open_document` text, error messages and docs say
  ".md, .markdown, .txt, .csv and .tsv"; `tauri.conf.json` gets associations `csv`
  (`text/csv`, "CSV document") and `tsv` (`text/tab-separated-values`, "TSV document"), role
  Editor.
- **R12 A draft is a file in app data.** `push_draft` writes
  `<app data>/drafts/<uuid>/<name>.md` plus `draft.json { requestId, fingerprint, createdAt }`,
  grants it, marks it co-edited and opens it through `present_pending` (owner window, else the
  most recently focused main window; R3 of multi-window). Being a real file document gives the
  draft autosave (to app data), collab, comments, agent edits (`apply_edit`) and restore after a
  restart for free. `<name>` is the title with `/ \ : * ? " < > |` and control characters
  replaced by `-`, trimmed, at most 100 characters, "Draft" when empty. `FileOpened` gains
  `draft: bool`; drafts never enter Recent. Every draft folder in app data is granted at launch.
- **R13 Draft tool.** `push_draft { requestId, title, content }`: write tool, off until
  selected; title 1-200 characters after trimming, content at most 100000 UTF-8 bytes (the
  `push_quick_note` limits, so Save to Quick Notes never fails on size for an unedited draft).
  A requestId seen before with the same title and content returns the same draft; with
  different arguments it is refused ("requestId was already used with different arguments.").
  Returns `{ path, name, bytes }`. No `show` argument: a draft is for review, so it always opens.
- **R14 Draft UI.** An open draft has a "Draft" tag in Open files and a bar above the editor:
  "Draft from an agent. It stays in Sodilaud until you save it." with **Save As…**,
  **Save to Quick Notes** and **Discard**. Cmd+S on a draft is Save As. After a successful
  Save As, the page calls `draft_discard { path, ask: false }`. **Save to Quick Notes** calls
  `draft_save_to_notes`, which flushes, creates the note through
  `Registry::agent_write("push_quick_note", { requestId: "draft-<uuid>", title, content })` (so
  it lands in "From agents" like a pushed note, and a retry never makes two notes), reveals it
  in the Quick Notes panel, then discards the draft. **Discard** asks natively ("Discard the
  draft <name>? This cannot be undone."). Closing a draft's buffer keeps the draft; the start
  page lists every draft under **Drafts** (newest first), from where it opens again.
- **R15 Shared find bar.** The single-document find and replace logic moves from `notes.js`
  into `src/find-bar.js`, used by both pages, with the same markup ids. `notes.js` keeps Find
  Results on top of it. Shortcuts in the file editor: Cmd+F (Ctrl+F) find; replace is
  Cmd+Alt+F on macOS (matched on `event.code === "KeyF"`; Cmd+H is the native Hide item) and
  Ctrl+H elsewhere; Enter/Shift+Enter next/previous; Escape closes; Alt+C/W/R toggles as in
  Quick Notes.
- **R16 Split view is new code** in `src/file-split.js`: Quick Notes' split is tied to note
  ids, folder-grouped selects and title inputs. The right pane shows any saved file open in
  this window, the same file included (a second collab client of the same document, which
  `doc-sync.js` supports). Untitled buffers are not offered on the right. Split is per window,
  not persisted, and unavailable in Reading mode (the button is disabled; switching to Reading
  closes it). Closing the file shown on the right shows the next saved file there, or closes
  the split when none is left.
- **R17 Shared compare controller.** The debounce, cache and decoration code moves from
  `notes.js` into `src/pane-compare.js` (`createPaneCompare`), used by both pages. Compare in
  files needs split view with two different files; `index.html` loads `vendor/diff.min.js`
  (vendored, so no egress change).

## Architecture

### Rust

```
src-tauri/src/files/ignore.rs    NEW  pure gitignore matcher: Pattern, IgnoreSet::from_files, is_ignored(rel, is_dir)
src-tauri/src/files/folders.rs   NEW  listing (FolderEntry, FolderListing, list, is_listed), FolderWatcher
src-tauri/src/files/drafts.rs    NEW  draft store in app data: create/find/list/discard, file name rule
src-tauri/src/files/windows.rs   WindowEntry.folders/expanded and their methods
src-tauri/src/files/store.rs     SavedWindow.folders/expanded
src-tauri/src/files/mod.rs       TEXT_EXTENSIONS, folder watcher in Files and the poll thread, draft dir, root checks
src-tauri/src/files/commands.rs  folder_* and draft_* commands, file_lists additions, draft flag, Save As filters
src-tauri/src/docs/files.rs      FileOpened.draft
src-tauri/src/mcp.rs             push_draft
src-tauri/src/cli.rs, tauri.conf.json, build.rs, lib.rs, capabilities/default.json
```

New commands (all main windows only):

| Command | Arguments | Returns |
|---|---|---|
| `folder_open_dialog` | - | `FolderRoot { path, name } \| null` |
| `folder_browse` | `path` (a granted file open in this window) | `FolderRoot` |
| `folder_remove` | `path` (a root of this window) | `()` |
| `folder_list` | `path` (a root or a folder below one) | `FolderListing { path, entries: [{ name, path, kind: "folder"\|"file" }], truncated }` |
| `folder_set_expanded` | `paths` | `()` |
| `folder_open_file` | `path` | `OpenedDocument { path, name, bytes }` |
| `draft_discard` | `path`, `ask` | `bool` (discarded) |
| `draft_save_to_notes` | `path` | `{ noteId }` |

`file_lists` gains `folders: [FolderRoot]`, `expanded: [string]` (this window) and
`drafts: [{ path, name }]` (all drafts, newest first).

New event: `folder-changed { path }` to every main window.

No folder is scanned on the main thread. `folder_list` is an async command that lists on a
blocking thread (`tauri::async_runtime::spawn_blocking`). Setting the watched folders (from
`folder_set_expanded`, `folder_open_dialog`, `folder_browse` or any lists update) reads only
modification times. Each watched folder is first listed by the poll thread, and the poll thread
lists without holding the watcher lock: it takes the folders out, polls them, then puts back the
state of those still watched.

### JS

```
src/folder-tree.js     NEW  pure tree model: roots, children cache, expanded set, visible rows, keyboard moves
src/folder-sidebar.js  NEW  Folders section DOM, invoke calls, events
src/find-bar.js        NEW  find and replace for one editor (extracted from notes.js)
src/pane-compare.js    NEW  compare controller (extracted from notes.js)
src/file-split.js      NEW  right pane for the file editor
src/files.js           fileKind(name), buffer.kind, buffer.draft
src/editor-view.js     plainTextFacet, setPlainText
src/editor-live-preview.js, src/editor-commands.js, src/editor-folds.js   honour plainTextFacet
src/file-editor.js, src/app.js, src/index.html, src/app.css, src/notes.js, src/agent-access.js
```

## Data flow

**Open Folder.** Menu -> `folder_open_dialog` -> rfd folder picker -> canonical root appended to
the window's `folders` and `expanded`, persisted, watched -> page adds the root, `folder_list`
-> rows.

**Expand.** Click/Right -> `folder_list(path)` -> children cached -> `folder_set_expanded(all
expanded)`. Collapse -> `folder_set_expanded`. A `folder-changed { path }` for a folder the
page shows expanded -> relist that folder only; for others, drop the cache.

**Open from the tree.** Click/Enter on a file -> `folder_open_file(path)` -> `openPath(path)`
(`file_doc_open`, with the multi-window `OpenElsewhere` rule).

**Restore.** `file_lists` -> roots and expanded -> list each root and each expanded folder
whose parent is visible, top-down.

**Push draft.** Agent `push_draft` -> validate -> `drafts::create` (or the earlier draft for a
repeated requestId) -> grant -> `coedit_mark_file` -> `present_pending` -> the target page takes
it and opens it like any file; `FileOpened.draft` shows the tag and bar.

**Draft to file.** Save As (dialog writes the chosen path) -> the page opens the new file ->
`draft_discard { ask: false }` -> Rust discards the registry document, removes the draft
folder, drops it from window lists.

**Draft to Quick Notes.** `draft_save_to_notes` -> `file_flush`/current text from the registry ->
`agent_write("push_quick_note", ...)` -> `quicknotes::window::reveal(Focus::Id)` -> discard
the draft -> page closes the buffer.

## Edge cases

- A root that is gone at launch is kept in the list and shown with "Folder not found" and its ×
  button, so the user decides; `folder_list` returns `NotFound`.
- A root inside another root of the same window is allowed (two rows); the same root twice in
  one window is ignored.
- A file in the tree that is open in another window: `file_doc_open` returns `OpenElsewhere`
  and Rust focuses that window (existing behavior).
- Listing a folder with 100,000 entries: reading stops at 20,000; the tree says so.
- Symbolic link loops: one level at a time, so a loop only goes as deep as the user expands.
- A draft whose `draft.json` is missing or damaged is still listed and openable; it only loses
  requestId deduplication.
- Discard while an agent is editing the draft: the document is discarded; the agent's next
  edit gets `NotOpen`.
- Split view on a file that is then moved to another window (multi-window Task 7): the page
  removes every buffer through one function, which also clears the right pane (see Task 12).
- A plain file renamed by Save As to `.md` switches to Markdown at once (kind follows the
  name in `model.adopt`).

## Testing

- Rust unit tests: gitignore patterns (each supported form, negation, folder rule, anchoring,
  the git-top walk); listing filter, order, caps, symlink containment; folder watcher (change
  reported once, unchanged visible listing not reported, cap); `WindowSet` folders and
  expansion (dedup, fold into target, persisted, filtered to roots); root containment for
  commands; drafts (file name rule, create, dedupe, conflict, list order, discard, launch
  grants); `push_draft` gating and validation; tool count and rejected-writes list.
- JS (`node --test`, jsdom harness `bootMainWindow`): folder tree model (rows, keyboard
  moves, expand cache); Folders section (Open Folder, Browse, expand lists and reports,
  `folder-changed` relists, click opens, remove, restore, sidebar visible with only a folder);
  plain files (no live decorations, Tab inserts a tab, Reading `<pre>`, toolbar disabled, `.md`
  unaffected); drafts (tag, bar, Save As discards, Save to Quick Notes, Discard, start page
  Drafts, Cmd+S is Save As, permission checkbox); find bar in files (Cmd+F, replace, undo,
  Cmd+Alt+F on macOS and Ctrl+H on a Linux navigator preload); Quick Notes find, split and
  compare tests stay green after the extraction; split view (right pane, same file twice,
  closing, Reading disables); compare in files.
- Manual (release build): open a repository folder, expand `src`, check ignored files are
  hidden, create a file in an expanded folder from a terminal, open a `.csv` from Finder,
  push a draft from an agent and save it both ways, find and replace in a file, split and
  compare two files.
