# Multiple main windows

Open files in more than one main window. Typical use: a review book stays open in one window
while another window edits other files. An open file can be moved to a new window, or to
another open window, from its context menu in the sidebar.

## Goals

- Any number of main windows. Each is a full peer of today's main window: start page, file
  editor, Sodilaud menu, and a sidebar with Open files and Outline.
- Each open file belongs to exactly one window. A window's sidebar lists only its own files.
- **Move to New Window** and **Move to Window > Window N - name** on an open file's context
  menu. **New Window** in the File section of the Sodilaud menu.
- The window set, each window's open files and each window's frame are restored on restart.
- Files opened from outside (Finder, the `sodilaud` command, MCP `open_document`) go to the
  most recently focused main window, or to the window that already has the file.
- Moving a file loses no text and never duplicates it. Unsaved edits, the saved state, the
  outside-edit state, comments, the cursor, the scroll position and folded sections carry over.

## Non-goals

- Quick Notes stays one shared panel. The Recent list stays global. Themes, appearance, the
  view mode and other settings stay shared and apply live to every window.
- Dragging a file between windows' sidebars. Tabs. Merging windows.
- Untitled (never saved) buffers cannot be moved; save them first.
- The Folders section (ROADMAP item 4) is not built here. The window model leaves room for it
  (see "Room for folders").
- No native macOS menu item for New Window; file actions live in the in-page Sodilaud menu.

## Current architecture (before this change)

**Window creation.** `src-tauri/tauri.conf.json` declares one window, label `main`, 960x680,
`visible: false`, loading `index.html` (entry `src/app.js`). `quicknotes::start` builds the
hidden `quicknotes` panel (`notes.html`), `clipboard::popup` builds `clipboard` on macOS.
`quicknotes::restore_windows` (`src-tauri/src/quicknotes/mod.rs`) shows `main` and/or the panel
from `QuickNotesConfig.windows_at_quit { main, quicknotes }`. The label `"main"` is hard-coded
as `quicknotes::window::MAIN_LABEL` and as literals in `clipboard/tray.rs` (`show_main`,
`hide_main`), `clipboard/runtime.rs` (`STOPPED_EVENT`) and `lib.rs` (About menu).

**Capabilities.** `src-tauri/capabilities/default.json` grants the file, comment, agent-access
and settings commands to `"windows": ["main"]`. Every file command also checks
`window.label() == MAIN_LABEL` (`require_main` in `files/commands.rs`), and comment commands
check it in `page_doc` (`docs/commands.rs`). `test/command-permissions.test.js` asserts
`main.windows` is exactly `["main"]`.

**Open files.** Rust owns file text in the document registry (`docs/files.rs`, `FileDocs`
keyed by path; each opening has a `doc_id`). `Registry::file_open` returns the existing
document when the path is already open, so a second `file_doc_open` of an open path gets the
current text and version. `files::Files` (`files/mod.rs`) holds grants, `FileLists { open,
recent }` persisted to `files.json` in app config, the watcher (whose watched set is replaced by
`file_set_open`), and a global `pending: Vec<String>` of files handed in from outside. The page
(`src/file-editor.js`, model in `src/files.js`) keeps buffers, calls `file_doc_open` and
`file_set_open` (sidebar order), and is a `@codemirror/collab` client through `src/doc-sync.js`.
On start-up `restore()` reads `file_lists`, reopens `open`, then `takePending()`.

**Outside opens.** Finder (`RunEvent::Opened`), the Linux/Windows single-instance plugin and
launch arguments call `files::open_from_system`; MCP `open_document` calls
`files::open_for_agent`. Both end in `present_pending`, which appends to `pending`, shows
`main` and emits `file-open-request` to it; the page then calls `file_take_pending`.

**Events.** `docs::commands::AppSink` emits `file-doc-updates`, `file-doc-saved`,
`file-doc-external` and file `comments-changed` to `main`; `coedit-state` and
`mcp-state-changed` to `main` and `quicknotes`. The pages listen with
`window.__TAURI__.event.listen(name, handler)`, whose default target is `Any`. In Tauri 2.11
(`event/listener.rs`, `match_any_or_filter`) an `Any` listener receives every `emit_to`,
whatever its target label, so with several main windows each page would receive every other
window's events (and N copies of the quit request).

**Menus and shortcuts.** On macOS the native menu is Tauri's default with About, Command Line
Tool and Quit replaced (`lib.rs` `macos_menu`); About focuses `main` and emits
`sodilaud-open-about` to it. File actions (New, Open, Save, Save As, Close, Start Page) are in
the in-page Sodilaud menu (`index.html` `#file-menu-section`) and page shortcuts
(`file-editor.js` `handleShortcut`). Cmd+Shift+N (Ctrl+Shift+N elsewhere) is the default
**global** Quick Notes hotkey (`quicknotes/config.rs` `DEFAULT_HOTKEY`), so it is taken.

**Close and quit.** `lib.rs` `on_window_event`: closing `main` is prevented; on macOS it hides
(`tray::hide_main`, activation policy Accessory), elsewhere it quits (`quit::request`). Quit
(`quit.rs`) asks every window that called `quit_handler_ready` to save
(`sodilaud-quit-requested`, answered with `quit_window_done`), then flushes file saves, records
`windows_at_quit` and exits.

**Per-window state in the page.** In memory: buffers, active file, sidebar hidden, nav history,
outline. In `localStorage`, shared and broadcast with `prefs-changed` (`src/preferences.js`,
filtered by window label): theme keys, appearance keys, `sodilaud_layout_mode`. Clipboard
settings (`clipboard-settings.js`) are in `localStorage` but not broadcast; the Quick Notes
hotkey shown in the menu is read once at start (`qn_get_config`).

## Decisions

Given (accepted by the user):

1. Extra main windows are full peers of today's main window.
2. Each open file belongs to exactly one window; the sidebar lists only its own files.
3. "Move to New Window" on an open file's sidebar context menu; File > New Window.
4. The window set and per-window file lists are restored on restart.
5. Quick Notes stays one shared panel; Recent stays global; settings and themes are shared and
   apply live to all windows.

Rulings (my call, grounded in the code above):

- **R1 Labels.** The first window keeps the label `main` (declared in `tauri.conf.json`, so
  nothing else changes for single-window users). Extra windows are `main-2`, `main-3`, ... from
  a counter that never reuses a number within a session, so a late event for a closed window
  cannot reach a new one. Labels are not persisted: at launch the saved windows map in order
  onto `main`, `main-2`, `main-3`. `is_main_label(label)` is `main` or `main-` followed by
  digits.
- **R2 Capabilities.** `default.json` becomes `"windows": ["main", "main-*"]` (Tauri 2
  capability globs). No new capability file. New commands are granted there only.
- **R3 Target window.** Finder, the CLI, single-instance handoff and MCP `open_document` open
  in the most recently focused main window (tracked from `WindowEvent::Focused(true)`). A file
  already open in some window is shown in that window instead, which is focused. If no main
  window exists, one is created. The Recent list, Open File, sibling links and Back/Forward
  inside a window follow the same rule: a path owned by another window focuses that window
  and shows the file there (Rust answers `file_doc_open` with code `OpenElsewhere`).
- **R4 Menu routing.** In-page menus and shortcuts act on their own window. The native About
  item and the panel's "show main window" (`show_main_window`, `sodilaud-open-section`) go
  to the most recently focused main window. The tray's Show Editor and the Dock's reopen show
  that window.
- **R5 New Window.** In-page File section item **New Window**, shortcut **Cmd+Alt+N**
  (Ctrl+Alt+N on Windows and Linux; matched by `event.code === "KeyN"` because Option+N is a
  dead key on macOS). Cmd+Shift+N is the global Quick Notes hotkey. A new window opens with
  the start page, the size of the window it came from, offset 28 logical px right and down.
- **R6 Move to Window.** Included. The submenu lists the other windows as
  `Window N - <active file name>` (or `Window N - Start Page`), N = 1-based position in the
  window set. Moving brings the target window to the front with the file shown. Moving the
  last file out of a window leaves that window on its start page; it does not close.
- **R7 Move protocol.** The source page flushes its unsent changes (`sync.flush()`; abort with a
  notification if it fails), captures the view state, and calls `main_window_move_file`. Rust
  reassigns ownership, queues a pending open with the view state for the target, creates or
  focuses the target, and emits `file-open-request` to it. The source drops the buffer
  **without** `file_doc_close`, so the registry document (text, `doc_id`, version, saved
  version, outside-edit state, comments, co-edit marks) never closes. The target opens it with
  `file_doc_open`, which returns the open document. Carried view state: selection, the document
  position at the top of the editor viewport, the Reading-mode scroll offset, folded section ids.
  Lost: undo history (CodeMirror history lives in the source `EditorState`), Back/Forward
  history, an open find panel or comment draft.
- **R8 Events.** Rust sends file events, `coedit-state`, `mcp-state-changed` and the clipboard
  `STOPPED_EVENT` to every main window. Pages already ignore documents they do not hold
  (`doc-sync` `same`, `files.js` `forEvent`, `comments-panel` `docKey`), so no ownership lookup
  is needed in the sink, and an event during a move reaches whichever window holds the file.
  The main window page listens only to events targeted at its own label
  (`listen(name, handler, { target: { kind: "WebviewWindow", label } })`). `prefs-changed`
  stays an app-wide broadcast. `notes.js` is unchanged.
- **R9 Ownership checks.** Rust tracks ownership for routing, persistence and the
  `OpenElsewhere` rule. `file_doc_push/pull/save/resolve/close` check only "a main window" and
  the grant, as today: every main window has the same capability, so per-window enforcement
  would add failure modes (in-flight pushes during a move) without a security gain.
  `file_set_open` drops any path another window owns, so a stale list cannot steal a file.
- **R10 Save As onto another window's file** is refused with "<name> is open in another window.
  Close it there first." Today Save As onto an open path discards that document, which would
  orphan the other window's buffer.
- **R11 Close.** Closing a main window while other main windows exist: Rust prevents the close
  and emits `main-window-close-requested` to it; the page asks about untitled buffers and saves
  everything (as for a quit) and answers `main_window_close_done { ok }`. On `ok`, Rust closes
  that window's files in the registry, removes it from the set, unregisters it from the quit
  coordinator and destroys it. A page that never registered a quit handler is closed at once.
  Closing the **last** main window keeps today's behavior: hidden on macOS (files stay open),
  quit elsewhere. If two windows close at once, the check runs again at `close_done`.
- **R12 Persistence.** `files.json` gains `windows: [{ open, active, frame }]`. A file without
  `windows` migrates its `open` list into one window. `open` is still written, as the union of
  all windows' files in window order, so an older build reopens everything in one window. Frames
  of every main window are recorded at quit and restored, clamped to the visible screens with
  the existing `quicknotes::config::clamp_frame`; this also restores the first window's frame,
  which today always opens at the default size. Empty windows are restored as empty windows.
  If `windows_at_quit.main` is false, every main window is created hidden.
- **R13 Shared settings stay live.** The view mode (`sodilaud_layout_mode`) stays one shared
  preference, as today, so changing Live/Source/Reading changes every window. Clipboard
  settings and the Quick Notes hotkey label now follow `prefs-changed` too
  (`clipboardHistory.settings`, and a `sodilaud_quicknotes_hotkey` signal key) so another main
  window does not show or re-apply a stale value.
- **R14 MCP.** `list_documents` and comments are per document in the registry and unchanged; no
  window field is added. `open_document` follows R3.

## Architecture

### Rust

`src-tauri/src/files/windows.rs` (new, pure): `WindowSet`, the windows in order with their open
files, active file and frame, the focus order and the label counter. No Tauri types; fully unit
tested.

```rust
pub const MAIN_LABEL: &str = "main";
pub fn is_main_label(label: &str) -> bool;
pub struct WindowSet { /* windows: Vec<WindowEntry>, focus: Vec<String>, next: u32 */ }
pub enum Claim { Mine, Elsewhere(String) }
```

`src-tauri/src/files/store.rs`: `FileLists { windows: Vec<SavedWindow>, recent, open (legacy) }`.

`src-tauri/src/files/mod.rs`: `Files` keeps `lists: Mutex<Lists>` where `Lists` holds the live
`WindowSet` and `recent`; `update_lists` persists `WindowSet::saved()`. `pending` becomes
per-label `HashMap<String, Vec<PendingOpen { path, view }>>`. The watcher watches the union of
all windows' files. `present_pending` routes each path with `WindowSet::route`.

`src-tauri/src/main_window.rs` (new, Tauri glue): create a window (`WebviewWindowBuilder`,
`WebviewUrl::App("index.html")`, title "Sodilaud", size from the source window or 960x680),
show/focus/hide, `emit_all(app, event, payload)`, focus tracking, the close flow, launch
restore, and the commands `main_window_new`, `main_window_move_file`, `main_window_list`,
`main_window_close_done`. Commands that create windows are `async`: a window created inside a
synchronous command deadlocks on Windows.

`MAIN_LABEL` moves from `quicknotes::window` to `files::windows`; `quicknotes::window::show_main`,
`tray::show_main/hide_main`, the About menu, `quit::exit` and the clipboard runtime go through
`main_window`.

### JS

- `src/window-events.js` (new): `ownLabel(window)`, `listenHere(window, name, handler)`.
- `src/open-file-menu.js` (new): the sidebar context menu (Move to New Window, Move to Window >,
  Close), opened by right-click, the ContextMenu key or Shift+F10, styled with the existing
  `.custom-context-menu` / `.context-menu-item` / `.context-menu-submenu` classes.
- `src/file-editor.js`: `moveFile(id, to)`, `viewState(buffer)`, `applyViewState(buffer, view)`,
  pending opens with view state, `OpenElsewhere` handling, `flushForClose()`, and `active` sent
  with `file_set_open`.
- `src/app.js`: `listenHere` for window-directed events, New Window item and shortcut,
  close-request handler, live follow of clipboard settings and the Quick Notes hotkey.

## Data flow

**Move to New Window (A -> new).** A: `sync.flush()` -> `viewState` ->
`invoke("main_window_move_file", { path, to: null, view })`. Rust: grant check, document open
check, `WindowSet::add` -> `main-K`, `move_to(path, A, main-K)`, persist, pending[`main-K`] =
[{path, view}], create window. A: drop buffer (no close), `file_set_open`, render. New page:
`restore()` -> `file_lists` (open = [path]) -> `file_doc_open` (existing document) ->
`takePending()` -> apply view.

**Move to existing window T.** As above with `to: "main-T"`; Rust focuses T and emits
`file-open-request` to T; T's `takePending()` opens the file and applies the view.

**Open from Finder / CLI / MCP.** `present_pending(paths)`: for each path, its owner if any,
else `WindowSet::target()` (most recently focused); a missing target creates a window. Each
window's paths are queued, the window is shown and focused, and gets `file-open-request`.

**Open inside a window** (dialog, Recent, link, Back). `file_doc_open` calls
`WindowSet::claim(label, path)`. `Elsewhere(owner)` queues the path for the owner, focuses it,
emits `file-open-request`, and returns `FileError { code: OpenElsewhere }`; the page does
nothing more.

**Close a window (not the last).** CloseRequested -> `main-window-close-requested` -> page
`flushForClose()` -> `main_window_close_done({ ok })` -> Rust `file_close` for each of its paths,
`WindowSet::remove`, watcher update, `QuitCoordinator::unregister`, `destroy()`.

**Quit.** Unchanged protocol, now over every registered main window. `exit` records each main
window's frame into the set and `windows_at_quit.main = any main window visible`.

**Launch.** `files::start` loads the set (labels `main`, `main-2`, ...). `main_window::restore`
applies the saved frame to `main` and creates the other windows (hidden if
`windows_at_quit.main` is false). Each page's `file_lists` returns its own `open`.

## Room for folders

`SavedWindow` and `WindowEntry` are plain structs persisted with `#[serde(default)]` fields, so
item 4 can add `folders: Vec<String>` per window without a migration. `file_lists` returns an
object, so a `folders` field can join `open` and `recent`. The sidebar keeps sections as
siblings in `#files-sidebar`; the context menu module takes a list of items, so a folder row can
reuse it.

## Edge cases

- A move while an agent edits the file: the document never closes; updates go to every main
  window and whoever holds the file applies them; the target opens at the newest version and the
  carried selection is clamped to the document length.
- A move while the file has an outside-edit conflict or a failed save: carried by the registry
  (`external`, `savedVersion`), so the banner shows in the target.
- The flush before a move fails (registry rejected the push three times): the move is cancelled
  with "Could not move <name>: unsaved changes could not be sent." and the buffer stays.
- Target window closed between menu open and click: Rust returns "That window is closed." and
  nothing moves.
- Two windows closing at once leaving one: the second `close_done` sees it is last and falls
  back to the last-window behavior.
- A saved window whose files are all gone at launch opens as an empty window.
- `file_set_open` containing a path another window owns (stale list): that path is dropped.
- Quit while a move is in flight: ownership was already reassigned and persisted in Rust before
  the target page opened the file, so the next launch shows it in the target window.

## Testing

- Rust unit tests: `WindowSet` (labels, add/remove, focus, target, claim, move, set_open
  filtering, route, saved order), `files.json` migration and union `open`, `QuitCoordinator::
  unregister`, `is_main_label`.
- JS (node --test, jsdom harness): `listenHere` passes the window target; harness gains a
  `label` option and records listen options; file editor move (flush first, invoke arguments,
  no `file_doc_close`, buffer removed, `file_set_open` updated); pending open with view state
  restores selection and folds; `OpenElsewhere` shows no notification; untitled buffers cannot be
  moved; New Window item and Cmd+Alt+N / Ctrl+Alt+N (Linux navigator preload); context menu
  lists other windows; close request flushes and answers `main_window_close_done`; capability
  test for `["main", "main-*"]`.
- Manual (release build): two windows, move a review book chapter, edit in both, quit and
  relaunch, Finder Open With into the focused window, close a non-last window.
