# Quick Notes panel and file editing - design

Date: 2026-09-28
Status: approved in brainstorming, awaiting written-spec review
Branch: `docs/quick-notes-design`
Roadmap: items 3 and 4 in [`ROADMAP.md`](../../../ROADMAP.md). Builds on
[`2026-09-27-editor-surface-design.md`](2026-09-27-editor-surface-design.md).

## Intent

**What.** Split Sodilaud into two surfaces:

1. **Quick Notes**: a floating panel, opened by a global hotkey, in the style of Raycast Notes.
   It takes over the whole notes collection and today's notes UI (sidebar, folders, pins,
   search, trash, toolbar, find, split-note, compare, focus mode).
2. **Main window**: a general Markdown editor for regular files on disk (the Typora
   replacement), with a VS Code-style start page when no file is open.

**Why.** Notes are short-lived working material the owner wants one keystroke away, visible
while working in another app (for example, a running list of actions), without the app
coming to the front or changing `⌘Tab` order. Regular Markdown files need a proper editor that
is not mixed with the notes collection. Doing both at once covers roadmap items 3 and 4.

**Decided in brainstorming (2026-09-28):**

| Topic | Decision |
|---|---|
| Quick Notes scope | The whole existing collection (localStorage or SQLite workspace). No tag, no reserved folder |
| Panel UI | Today's notes UI, sidebar collapsed by default. The last open note is shown on every reopen |
| Editable | Yes, from the first version |
| Dismiss | Only the hotkey, the (x) button, or `⌘W`. Never on blur, never on `Esc` |
| Stacking | The panel always floats above other windows. No pin toggle |
| Activation | Non-activating: Sodilaud does not come to the front, `⌘Tab` order is unchanged |
| Geometry | Resizable and draggable, remembered across hides and restarts. First open centered, 720x520 |
| Hotkey | `⌘⇧N` default, configurable |
| Platforms | macOS UX and architecture first. Best-effort parity on Windows and Linux (always-on-top window, same hotkey). Real blockers go back to the owner, not silent downgrades |
| Settings | The Sodilaud menu lives in the main window. Editor preferences are shared by both windows. Notes-only actions live in the panel's toolbar overflow |
| MCP | Existing note tools work against Quick Notes, including while the panel is hidden |
| Agent push (`push_quick_note`) | Not in this change. Follow-up |
| File editing MVP | New File, Open File, Save As, autosave, open and recent file lists, watcher with Reload / Keep mine, `.md` and `.txt`, Finder "Open With" |
| Release | Both parts ship together as 0.10.0, in two pull requests |
| Document model | Stays window-owned (Shape A). The panel is the only notes writer, so roadmap item 2 is no longer a prerequisite |

## Guardrails and definition of done

- Work happens on feature branches in `.claude/worktrees/`. The owner runs push and PR
  creation. Every PR ends with copy-paste build and test steps.
- `npm run check` (memory-capped), `cargo test` and `cargo clippy` pass. CI builds Windows and
  Linux; they are not tested by hand.

**Done:** 0.10.0 is release-ready. The panel has today's full notes feature set. The main
window has the start page and the file editing MVP. Settings are split as below. MCP works
against Quick Notes with the panel hidden. README, site, `docs/`, the Welcome note, the
shortcut reference, RELEASE_NOTES and ROADMAP match the code. Upgrading users lose no data.

**Not done here:** `push_quick_note`, Open Folder, 3-way merge, `.csv`/`.tsv`, MCP
`open_document`, the Rust document model, find or compare across files, manual Windows and
Linux verification, cutting the release (version bump and tag).

## Pull requests

1. **PR 1 - Quick Notes.** Panel window, hotkey, geometry, MCP retarget, page split, settings
   split, start page (file actions hidden), new Welcome note, upgrade banner, two-window quit,
   docs for all of it. After it merges, `main` is coherent: notes live in the panel and the
   main window shows the start page.
2. **PR 2 - Files.** File grants, I/O, watcher, file associations, open and recent lists,
   editor wiring, start page file actions, files docs, security note, RELEASE_NOTES 0.10.0,
   ROADMAP.

## 1. Quick Notes panel window (PR 1)

### Rust: `src-tauri/src/quicknotes/`

- `window.rs`: creates the `quicknotes` webview window once at startup, hidden and warm, and
  never destroys it. A loaded hidden page keeps autosave and the MCP relay alive. Exposes
  toggle, show and hide for the hotkey, the (x) button, `⌘W` and the tray.
- `geometry.rs`: persists the frame in app data, debounced, on move and resize. On show, the
  frame is clamped so the panel is fully on a visible screen. Missing or invalid state falls
  back to 720x520, centered on the screen with the pointer.
- `hotkey.rs`: registers the global shortcut. Configurable, with the same error semantics as
  the clipboard hotkey: a rejected hotkey shows an inline error, an existing hotkey stays
  active, and the requested one is retried on the next settings change.
- The NSPanel class swap in `clipboard/panel.rs` moves to a shared `platform/panel.rs`, used
  by both the clipboard popup and Quick Notes. The clipboard popup keeps its current
  behavior.

### macOS panel behavior

- Non-activating panel. Collection behavior `CanJoinAllSpaces | FullScreenAuxiliary |
  IgnoresCycle`, so it shows over full-screen apps and on every Space, and stays out of
  `⌘Tab` and the Window menu cycle.
- Floating window level (`NSFloatingWindowLevel`), not the popup-menu level the clipboard
  popup uses. A long-lived panel must not cover system menus and alerts.
- Resizable. Header row with a drag area and an (x) button, using the clipboard popup's
  start-drag mechanism.
- If the panel conversion is refused (`PanelRefusal`), the window falls back to a regular
  always-on-top window and the refusal is logged.

### Windows and Linux

An ordinary always-on-top, skip-taskbar window with the same hotkey, geometry and dismiss
rules. Panel-specific code is `cfg(target_os = "macos")`.

### Capabilities

A new `quicknotes` capability gets the notes, workspace, import/export and MCP snapshot and
write-completion commands (`load_db_*`, `save_*_db`, `select_db_file`, `vacuum_workspace`,
`import_file_native`, `save_file_native`, `update_mcp_snapshot`, `update_mcp_note`,
`complete_mcp_write`, plus the panel's own close, drag and quit-ack commands). Both windows
keep `confirm_and_open_url` and `show_alert_dialog`. The `main` capability loses the notes and
workspace commands and keeps settings, MCP control, clipboard config and quit.

### MCP

The relay target in `mcp.rs` (currently `"main"`) becomes `"quicknotes"`. Because the panel's
page stays loaded while hidden, agent reads and writes work without the panel on screen.

### Spike before building on it (about half a day)

1. **localStorage carry-over.** Existing localStorage notes, trash and preferences must be
   readable from the new `quicknotes` webview. The origin is the same; verify the data store
   is shared on macOS (and reason about WebView2 and WebKitGTK). If it is not, migrate the
   `sodilaud_*` keys through Rust once, before the panel loads, and never delete the source.
2. **Typing in a non-activating panel.** `⌘C`, `⌘V`, `⌘X`, `⌘Z`, `⌘⇧Z`, `⌘A`, dead keys on US
   International (õ ä ö ü š ž, on a line where live preview hides markup) and IME input must
   work while Sodilaud is not the active app. If menu key equivalents do not reach the panel,
   handle them in the page or the panel's `performKeyEquivalent:`. If that also fails, the
   fallback is to activate Sodilaud while the panel is key, which changes `⌘Tab` order; that
   fallback needs the owner's approval first.
3. **Native dialogs** (open workspace file, import, export) opened from the panel appear in
   front of it and return focus to it.

## 2. Frontend split (PR 1)

### Pages

- `src/notes.html` and `src/notes.js`: today's `index.html` and `main.js`, moved with
  `git mv`. This is the panel's page.
- `src/index.html` and `src/app.js`: the new main window page. PR 1 has the start page and the
  full Sodilaud menu. PR 2 adds the files UI.

### Shared modules extracted from `main.js`

Only what both pages need:

- `preferences.js`: editor zoom, line spacing, line numbers, syntax highlighting, and view mode
  (Live, Source, Reading). Uses the existing `sodilaud_*` localStorage keys unchanged.
- `themes.js`: preset and custom themes (`sodilaud_active_theme`, `sodilaud_custom_themes`,
  `color-scheme`). The theme picker moves from the panel's sidebar footer to the main window
  menu.
- `toolbar.js`: formatting toolbar wiring, so both pages get the same toolbar.

### Preference sync

When either page changes a shared preference, it writes localStorage and emits a Tauri event
`prefs-changed { key }`. The other page re-reads that key and applies it live. localStorage
stays the source of truth; no Rust state is added. Cross-webview `storage` events are not
relied on.

### Panel toolbar overflow (notes-only)

- Open or switch workspace file, disconnect workspace
- Import a text file as a note, export the current note
- Copy as Markdown, copy as HTML
- Sidebar note preview lines
- "Settings…", which shows the main window with its menu open

Empty Trash stays on the trash icon's context menu.

### Main window Sodilaud menu

- Themes and the shared editor preferences
- Quick Notes: hotkey
- Clipboard history settings
- Agent access and MCP configuration
- Keyboard shortcuts, Markdown cheatsheet, MCP reference
- About

MCP control commands already go through Rust and MCP state lives in Rust, so the menu works
from the main window while the snapshot comes from the panel.

## 3. Start page, onboarding and lifecycle (PR 1)

### Start page

Ephemeral UI in the main window, not a note or a file. Shown whenever no file is open (in
PR 1, always).

- Header "Sodilaud", then one line: "Markdown editor for your files. Quick Notes one hotkey
  away, stored separately."
- **Start:** New File, Open File. Hidden until PR 2.
- **Recent:** the last 10 opened files, or "No recent files". Hidden until PR 2.
- **Quick Notes:** the current hotkey (live from settings), an "Open Quick Notes" button, and
  an "Open the Welcome note" link. The link shows the panel with the note titled "Welcome to
  Quick Notes" selected if one exists, and otherwise shows the panel.
- **Upgrade banner:** a dismissible line above the sections, shown when
  `sodilaud_quicknotes_intro_seen` is absent and the collection already has notes: "Your notes
  moved to Quick Notes (`⌘⇧N`)", with an Open button. The flag is set when the banner is
  dismissed or the panel is first shown.
- "Show Start Page" in the main window menu reopens it while files are open (PR 2).

### Welcome note

`welcome-note.js` is rewritten. It is still seeded only into an empty collection, so upgrading
users keep their old Welcome note and never get the new one.

- Title "Welcome to Quick Notes".
- Covers the hotkey, dismissing (hotkey, (x), `⌘W`), that the panel floats while you work
  elsewhere, the sidebar toggle, folders, pins, trash, and workspace files.
- Keeps today's editing and Markdown tips, condensed.
- Points to the main window menu for agent access and settings.

### Launch

- First run: the main window shows the start page.
- Later runs: Rust restores the visibility of both windows as it was at quit
  (`windows_at_quit` in app data). If both were hidden, the main window shows.

### Quit

`request_quit` emits the quit event to both windows. Each flushes pending saves and acks. Rust
exits when both succeed. A failure in either window cancels the quit and that window shows its
error, as today. A window that never registered a quit handler counts as done, matching
today's fallback. Clipboard wipe on quit is unchanged and still happens first.

### Tray and Dock

- Tray: Show Editor, Quick Notes (with hotkey label), Clipboard History…, Quit Sodilaud.
- Dock click (`RunEvent::Reopen`): shows the main window, never the panel.
- Closing the main window hides it, as today. The app keeps running.

## 4. File editing in the main window (PR 2)

### Rust: `src-tauri/src/files/`

- `grants.rs`: the main window can only touch paths the user chose through the Open or Save
  dialog, Finder "Open With", or a persisted open or recent entry restored at start-up.
  Every file command checks the canonicalized path against the grant set. There is no command
  that reads or lists an arbitrary path.
- `io.rs`: reads UTF-8 only (other encodings get a clear error) and refuses files over 10 MB.
  Writes are atomic (temp file in the same directory, then rename) and preserve the original
  file mode, line endings (LF or CRLF, detected on load) and BOM. Text is never reformatted.
- `watch.rs`: watches only open files, with the `notify` crate (new dependency). Sodilaud's own
  writes are ignored by content hash. Events go to the main window.
- File associations for `.md` and `.txt` in `tauri.conf.json`. On macOS, `RunEvent::Opened`
  grants and opens the file. On Windows and Linux, `tauri-plugin-single-instance` (new
  dependency) forwards second-launch arguments to the running instance.

### Frontend: `app.js` and `files.js`

- Sidebar "Open files": files currently open, active one highlighted, hover (x) to close. The
  sidebar is hidden when nothing is open.
- Start page "Recent": the last 10 opened files. A missing file is shown muted; clicking it
  explains and removes it.
- One editor (same CM6 surface, toolbar and view modes) showing the active file. Undo history
  is kept per file while it is open.
- Autosave 400 ms after the last change, once the file has a path.
- New File: an untitled buffer. `⌘S` or Save As picks a path, then autosave takes over. An
  untitled buffer with content asks Save / Discard / Cancel on `⌘W`, window close, or quit.
- External change: a clean buffer reloads silently. A dirty buffer shows "Changed on disk:
  Reload / Keep mine". A deleted or moved file shows "File no longer on disk: Save As… /
  Close".
- Window title: the file name, with the full path in the tooltip.
- Shortcuts in the main window: `⌘N` new file, `⌘O` open, `⌘S` save (no-op once the file has
  a path), `⌘⇧S` Save As, `⌘W` close file (falls back to the start page). In the panel, `⌘N`
  stays new note.
- MCP cannot see files.

## 5. Errors, testing and docs

### Error handling

- Hotkey registration failure: inline error in Quick Notes settings. The tray item still opens
  the panel.
- Panel conversion refused: regular always-on-top window, logged. Notes stay usable.
- Workspace open failure in the panel: today's behavior (report and fall back to local notes).
- File read, write or grant failure: a non-blocking bar in the main window naming the file and
  the reason. A failed autosave keeps the buffer dirty and retries on the next change. The
  quit flush reports it and cancels the quit.

### Testing

- Node (`node --test`, jsdom, memory-capped): existing notes tests pass against `notes.js`.
  New tests for preference sync, start page states (fresh, upgrade banner, hotkey label), the
  open and recent list model, untitled close prompts, and the external-change bar.
- Rust: geometry clamping, grant checks (traversal and symlinks), atomic write preserving
  line endings, BOM and mode, UTF-8 rejection, watcher self-write suppression, the two-window
  quit coordinator (both succeed, one fails, one never registered), hotkey config parsing.
- CI runs on Linux: macOS panel code is `cfg`-gated, and platform-dependent JS is covered with
  a navigator preload.
- Manual macOS checklist in each PR's build steps: the three spike items, full-screen apps,
  Spaces, `⌘Tab` order, geometry restore, Finder "Open With", external edits from another
  editor.

### Docs

- PR 1: README features and storage, new `docs/quick-notes.md`, shortcut reference and
  cheatsheet, site landing copy (screenshot placeholder for the owner), `docs/mcp.md` (tools
  target Quick Notes and work while the panel is hidden).
- PR 2: README files section, new `docs/files.md`, a security note for the file grant
  boundary, RELEASE_NOTES 0.10.0, ROADMAP (item 3 done except agent push, item 4 MVP done with
  the rest listed, item 2 re-scoped), and open decision 2 in `2026-09-27-editor-surface-design.md`
  marked resolved.
