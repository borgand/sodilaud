# Quick Notes and Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the notes app into a floating Quick Notes panel, and make the main window a Markdown file editor with a start page. Both ship in 0.10.0 as two stacked pull requests.

**Architecture:** Today's `index.html` and `main.js` become the panel page (`notes.html`, `notes.js`), with the settings UI taken out. A new, smaller main-window page (`index.html`, `app.js`) holds the start page, the Sodilaud menu and, in PR 2, the file editor. Rust gains a `quicknotes` module (panel window, hotkey, geometry, window state), a shared `platform/panel.rs`, a two-window quit coordinator and, in PR 2, a `files` module (grants, atomic I/O, watcher). Shared preferences stay in localStorage. A `prefs-changed` Tauri event keeps both pages live.

**Tech Stack:** Tauri 2, Rust (objc2 on macOS, `tauri-plugin-global-shortcut`, `notify`, `tauri-plugin-single-instance`), vanilla ES modules, CodeMirror 6 (vendored), `node --test` with jsdom.

**Spec:** `docs/superpowers/specs/2026-09-28-quick-notes-and-files-design.md`

## Global Constraints

- Branches: PR 1 is `feat/quick-notes`, branched from `docs/quick-notes-design`, which carries the spec and this plan. PR 2 is `feat/files`, stacked on `feat/quick-notes`. Work happens in `.claude/worktrees/`. Never push; the owner runs push and PR creation.
- Files start with `// SPDX-License-Identifier: GPL-3.0-or-later` (JS, Rust) or the HTML equivalent used today. Never use em dashes in code, copy or docs; use a hyphen. New `src/*.js` files go into `package.json` `check:js`.
- Tests: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 900; exec @ARGV' npm run check`, plus `cargo test` and `cargo clippy --all-targets -- -D warnings` in `src-tauri`. npm cache: `npm_config_cache=$TMPDIR/npm-cache`.
- Commits: `type(scope): description`, with the trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Panel window label: `quicknotes`. Main window label: `main`. Default Quick Notes hotkey: `super+shift+KeyN` (shown as `⌘⇧N`; `ctrl+shift+KeyN` off macOS).
- Panel geometry: first open 720x520, centered on the screen with the pointer. Floating level. `CanJoinAllSpaces | FullScreenAuxiliary | IgnoresCycle`. Non-activating.
- The panel is dismissed only by the hotkey, its (x) button or `⌘W`. Never on blur, never on `Esc`.
- Every command registered in `lib.rs` must be declared in `build.rs` and granted by exactly the capability of the window that calls it (`test/command-permissions.test.js`).
- Zero egress: no network crates or APIs (`npm run check:egress`).

## Deviations from the spec (decided while planning, flagged to the owner in PR 1)

1. **Agent access stays in the panel's menu.** The MCP enable flow seeds the snapshot before the server starts, revokes permissions before the native call, and waits on the notes save queue. All of that lives beside the notes state in `notes.js`, and splitting it across two webviews would put those security orderings behind an IPC race. The main window's menu gets an "Agent access…" item that opens the panel with its menu shown. MCP still works while the panel is hidden, because its page stays loaded.
2. **Quick Notes hotkey and window state live in Rust** (`quicknotes.json` in the app config dir), not in localStorage. Rust then registers the hotkey at startup before any page loads.
3. **Windows and Linux have no tray** (the tray needs `libayatana-appindicator` on Linux, which CI lacks). There, closing the main window quits the app after both windows flush. The global shortcut plugin becomes cross-platform, so the panel hotkey works everywhere.
4. **Help and About live in the main window.** `⌘/` in the panel opens the main window on the help modal.

## Review Focus

1. **Upgrading user's notes.** The panel webview must read the same localStorage (`sodilaud_notes`, `sodilaud_folders`, `sodilaud_trash`) and remembered workspace as the old main window. Pinned in Task 1 by booting `notes.html` with seeded storage and checking that no Welcome note is added, and checked manually in the PR 1 checklist.
2. **Quit with unsaved notes while the panel is hidden.** `⌘Q` from the main window must flush the panel's pending save. Pinned in Task 4 (coordinator: panel fails → quit cancelled) and Task 3 (notes page acks with `ok: false` on flush failure).
3. **Hotkey conflicts.** A Quick Notes hotkey equal to the clipboard hotkey must be rejected, not silently steal it. Pinned in Task 3 (`qn_set_hotkey` returns `HotkeyUnavailable` for the clipboard's chord).
4. **Off-screen geometry** after a monitor is unplugged. The panel must come back on a visible screen. Pinned in Task 3 (`clamp_frame` tests).
5. **File writes preserve bytes.** CRLF, BOM and file mode survive an edit round trip, and a non-UTF-8 file is refused rather than mangled. Pinned in Task 9.

---

## PR 1: Quick Notes

### Task 1: Move the notes page and add the main-window page shell

**Files:**
- Move: `src/index.html` → `src/notes.html`, `src/main.js` → `src/notes.js` (`git mv`)
- Create: `src/index.html` (start page shell), `src/app.js`, `src/app.css`
- Modify: `test/helpers/app-harness.js` (boot `notes.html` + `notes.js`), every test that reads `src/index.html` or `src/main.js` by path, `package.json` (`check:js`), `scripts/check-no-egress.mjs` (`ALLOWED` key `src/index.html` → `src/notes.html`)
- Create: `test/helpers/main-window-harness.js` (boots `index.html` + `app.js`, same stub bridge)
- Test: `test/start-page.test.js`, `test/notes-page-upgrade.test.js`

**Interfaces:**
- Produces: `bootMainWindow({ storage, handlers, platform })` → `{ dom, invocations, emit, click, settle }`, the same shape as `bootApp`.
- Produces: `app.js` exports nothing and boots on import, like `notes.js`.

- [ ] Run `git mv` for both files, then fix every reference that `grep -rn "index.html\|main.js" test scripts package.json src` finds.
- [ ] Write `test/notes-page-upgrade.test.js`: boot `notes.html` with `sodilaud_notes` holding two notes. Assert the sidebar titles are exactly those two (no Welcome note added).
- [ ] Write `src/index.html`: the same CSP-safe head as `notes.html` (stylesheets `styles.css` and `app.css`, module `app.js`), a `<main id="start-page">` with header `Sodilaud`, the tagline, `#start-actions` (hidden, holding New File and Open File for PR 2), `#recent-files` (hidden), `#quicknotes-card` (hotkey label `#quicknotes-hotkey-label`, `#open-quicknotes-btn`, `#open-welcome-note-link`) and `#upgrade-banner` (hidden).
- [ ] Write `test/start-page.test.js`: a fresh boot shows `#quicknotes-card` with the hotkey label from `qn_get_config`, and hides `#start-actions` and `#recent-files`.
- [ ] Implement `app.js`: load config through `invoke("qn_get_config")` (`{ hotkey, hotkeyError }`), render the label with `formatAccelerator` from `clipboard-settings.js`, and wire `#open-quicknotes-btn` to `invoke("qn_show", { focusNoteTitle: null })`.
- [ ] Run `npm run check`. Expected: PASS.
- [ ] Commit `refactor(app): move the notes UI to notes.html and add the main-window page`.

### Task 2: Shared macOS panel with two styles

**Files:**
- Move: `src-tauri/src/clipboard/panel.rs` → `src-tauri/src/platform/panel.rs`. Create `src-tauri/src/platform/mod.rs`.
- Modify: `src-tauri/src/clipboard/popup.rs`, `src-tauri/src/lib.rs` (`mod platform;`)

**Interfaces:**
- Produces: `pub enum PanelStyle { Popup, Floating }` and `pub fn make_floating_panel(window: &WebviewWindow, style: PanelStyle) -> Result<(), PanelRefusal>`. `Popup` keeps today's `NSPopUpMenuWindowLevel` plus `Transient`. `Floating` uses `NSFloatingWindowLevel`, drops `Transient`, and adds `NSWindowStyleMask::Resizable`.
- Produces: `pub fn level_and_behavior(style) -> (isize, NSWindowCollectionBehavior)`, a pure function with a unit test on both styles.
- `present`, `conceal`, `order_out`, `order_front_transparent`, `restore_window_class` are unchanged.

- [ ] Write a unit test `floating_style_is_resizable_and_not_transient` for `level_and_behavior`.
- [ ] Move the file, add the enum, and route `convert` through `level_and_behavior`. The clipboard popup passes `PanelStyle::Popup`.
- [ ] Run `cargo test` and `cargo clippy --all-targets -- -D warnings`. Expected: PASS, and every existing panel test still passes.
- [ ] Commit `refactor(platform): share the floating panel between the clipboard popup and Quick Notes`.

### Task 3: Quick Notes window, hotkey, geometry and capabilities

**Files:**
- Create: `src-tauri/src/quicknotes/mod.rs`, `config.rs` (pure: load/save `quicknotes.json`, `clamp_frame`), `window.rs` (create, show, hide, toggle, geometry events), `hotkey.rs`, `commands.rs`
- Create: `src-tauri/capabilities/quicknotes.json`
- Modify: `src-tauri/Cargo.toml` (move `tauri-plugin-global-shortcut` to `[dependencies]`), `src-tauri/src/lib.rs` (plugin on every platform, `manage(QuickNotes)`, setup creates the panel, commands registered), `src-tauri/build.rs`, `src-tauri/capabilities/default.json` (notes and workspace commands move out), `src-tauri/src/mcp.rs` (relay target `"quicknotes"`), `src-tauri/tauri.conf.json` (main window `"visible": false`, `"label": "main"`), `src-tauri/src/clipboard/runtime.rs` (expose the registered clipboard chord for the conflict check)
- Modify: `test/command-permissions.test.js`
- Test: Rust unit tests in `config.rs` and `hotkey.rs`

**Interfaces:**
- `QuickNotesConfig { hotkey: String, frame: Option<Frame>, windows_at_quit: Option<WindowsAtQuit> }`, where `Frame { x, y, width, height }` is in logical points and `WindowsAtQuit { main: bool, quicknotes: bool }`.
- `pub fn clamp_frame(frame: Option<Frame>, screens: &[Rect], pointer_screen: Rect) -> Frame`. A missing or invalid frame gives 720x520 centered on `pointer_screen`. A frame less than 60% visible on every screen is moved onto `pointer_screen`, keeping its size up to that screen's size.
- Commands, all under the `quicknotes` capability unless noted:
  - `qn_close()`: hide
  - `qn_start_drag()`
  - `qn_get_config() -> { hotkey, hotkeyError }`: both capabilities
  - `qn_set_hotkey(hotkey) -> { hotkey, hotkeyError }`: main only
  - `qn_show({ focusNoteTitle: Option<String> })`: main only. Shows the panel and emits `quicknotes-focus-note` with the title.
  - `show_main_window({ section: Option<String> })`: quicknotes only. Shows main and emits `sodilaud-open-section` with `"help" | "settings"`.
- Hotkey errors reuse the clipboard `ClipError::{HotkeyInvalid, HotkeyUnavailable}` serialization, so the JS messages can be shared.
- `qn_set_hotkey` returns `HotkeyUnavailable` when the chord equals the registered clipboard hotkey (`same_shortcut`).

- [ ] Write the `config.rs` tests: round-trip save/load; a corrupt file loads the defaults; `clamp_frame` cases (none → centered; fully off-screen → pointer screen; partly visible above 60% → unchanged; larger than the screen → shrunk).
- [ ] Implement `config.rs` with owner-only writes (`restrict_to_owner`, made `pub(crate)` in `lib.rs`).
- [ ] Implement `window.rs`: `ensure_created` in setup builds `WebviewWindowBuilder::new(app, "quicknotes", WebviewUrl::App("notes.html".into()))` with `decorations(false)`, `always_on_top(true)`, `skip_taskbar(true)`, `visible_on_all_workspaces(true)`, `resizable(true)`, `background_throttling(Disabled)`, `visible(false)` and `min_inner_size(420, 320)`. On macOS it applies `make_floating_panel(PanelStyle::Floating)`. `show` clamps and applies the frame, then calls `window.show()` + `panel::present` (macOS) or `set_focus` (other platforms). `hide` calls `panel::order_out` (macOS) or `window.hide()`. `toggle` checks `is_visible()`. Moved and Resized events save the frame after 300 ms (debounced by a generation counter). CloseRequested → `prevent_close` + hide.
- [ ] Implement `hotkey.rs` with the same plan/register/unregister semantics as the clipboard runtime. The callback runs `window::toggle` on the main thread.
- [ ] Write `capabilities/quicknotes.json` for `windows: ["quicknotes"]` and move the notes, workspace, import/export and MCP snapshot and write-completion permissions there. Both keep `confirm_and_open_url`, `show_alert_dialog`, `core:default`. Update `command-permissions.test.js` to assert the split: notes commands only in `quicknotes`, `clip_set_config` and `qn_set_hotkey` only in `default`.
- [ ] Change the `mcp.rs` relay target to `"quicknotes"`.
- [ ] Run `cargo test`, `cargo clippy`, `npm run check`. Expected: PASS.
- [ ] Commit `feat(quicknotes): floating Quick Notes panel with a global hotkey`.

### Task 4: Two-window quit and launch restore

**Files:**
- Create: `src-tauri/src/quit.rs` (pure `QuitCoordinator` + glue)
- Modify: `src-tauri/src/clipboard/tray.rs` (`request_quit` delegates to `quit::request`), `src-tauri/src/clipboard/commands.rs` (`quit_handler_ready` and `quit_app` move to `quit.rs`, keeping their names and adding window labels), `src-tauri/src/lib.rs` (ExitRequested on every platform; on non-macOS a main-window CloseRequested becomes a quit request; setup restores window visibility), `src/notes.js` and `src/app.js` quit listeners
- Test: Rust unit tests in `quit.rs`, `test/quit-handshake.test.js`

**Interfaces:**
- `QuitCoordinator::register(label)`, `begin() -> Vec<String>` (labels to ask, empty meaning exit now), `report(label, ok) -> QuitStep { Wait, Exit, Cancel }`, `reset()`.
- JS: on `sodilaud-quit-requested`, each page flushes and then calls `invoke("quit_window_done", { ok })`. `quit_handler_ready` takes the calling `Window` and registers its label.
- `windows_at_quit` is saved in `QuickNotesConfig` right before exit. In setup, a missing value (first run) shows main. A saved value restores each window, and if both were hidden, main shows.

- [ ] Write the coordinator tests: no registered windows → exit now; both ok → Exit on the second report; one false → Cancel and later reports ignored; a report from an unregistered label is ignored.
- [ ] Implement `quit.rs` and wire it in. The clipboard wipe stays first in `request`.
- [ ] Write `test/quit-handshake.test.js`: boot `notes.html` with `save_note_db` rejecting and a workspace connected, emit `sodilaud-quit-requested`, and assert that `quit_window_done` was invoked with `{ ok: false }`.
- [ ] Update both pages: `notes.js` replaces `invoke("quit_app")` with `quit_window_done`. `app.js` registers and answers `{ ok: true }` (PR 2 adds file flushing).
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `feat(app): flush both windows on quit and restore window visibility at launch`.

### Task 5: Shared themes and preferences, with sync

**Files:**
- Create: `src/themes.js` (theme engine and picker), `src/preferences.js` (shared pref keys, `broadcastPreference`, `onPreferenceChange`)
- Modify: `src/notes.js` (use both modules; remove the theme modal, the appearance controls except preview lines, clipboard settings, help and about), `src/notes.html` (remove that markup), `src/index.html` and `src/app.js` (add it)
- Move tests: `theme-*.test.js`, `view-settings.test.js`, `help-menu.test.js`, `clipboard-settings-ui.test.js`, `native-about-menu.test.js` and the relevant cases in `accessibility.test.js` switch to `bootMainWindow`
- Test: `test/preference-sync.test.js`

**Interfaces:**
- `createThemeController({ document, invoke, resolveCssColor, parseOpaqueThemeColor, onApplied })` → `{ load(), apply(themeId), openModal(), closeModal(), isModalOpen(), activeThemeId() }`. The modal functions are no-ops when the page has no `#theme-modal-backdrop`.
- `SHARED_PREFERENCE_KEYS = ["sodilaud_active_theme", "sodilaud_custom_themes", "color-scheme", "sodilaud_editor_zoom", "sodilaud_editor_line_spacing", "sodilaud_editor_line_numbers", "sodilaud_syntax_highlighting", "sodilaud_layout_mode"]`.
- `broadcastPreference(key)` emits `prefs-changed` `{ key }` through `window.__TAURI__.event.emit` and never throws. `onPreferenceChange(handler)` listens, ignoring its own window's events by comparing `window.__TAURI__.window.getCurrentWindow().label` with the payload's `source`.

- [ ] Write `test/preference-sync.test.js`: boot the panel, emit `prefs-changed` `{ key: "sodilaud_editor_zoom" }` after setting storage to `1.5`, and assert that the editor's zoom style reflects 150%. Boot the main window, click zoom in, and assert that an `emit` of `prefs-changed` with `sodilaud_editor_zoom` was recorded (extend the harness to record emits).
- [ ] Move the theme functions from `notes.js` into `themes.js`, keeping behavior. `syncClipboardPopupTheme` runs from `onApplied` in the main window only.
- [ ] Remove the markup and listeners from the panel, and add them to the main window. Guard every removed element reference.
- [ ] Port the moved tests to `bootMainWindow`.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `refactor(app): share themes and editor preferences between both windows`.

### Task 6: Main-window menu, Quick Notes settings, start-page states

**Files:**
- Modify: `src/index.html`, `src/app.js`, `src/app.css`
- Create: `src/quicknotes-settings-ui.js` (hotkey capture, like the clipboard modal)
- Test: `test/start-page.test.js` (extend), `test/quicknotes-settings-ui.test.js`

**Interfaces:**
- Menu sections: Appearance (theme, zoom, line spacing, syntax highlighting, line numbers), Quick Notes (hotkey button, Reset, inline error), Agent access (`Agent access…` → `qn_show` then emit `quicknotes-open-menu`), Clipboard history (macOS), Help (Help and reference, About).
- Upgrade banner: shown when `localStorage.sodilaud_quicknotes_intro_seen` is absent **and** there is an existing collection (`sodilaud_notes` has more than 0 notes, or a remembered workspace from `load_workspace_preference`, which moves to both capabilities). Dismissing it or pressing Open sets the flag.
- `#open-welcome-note-link` → `qn_show({ focusNoteTitle: "Welcome to Quick Notes" })`.
- `sodilaud-open-section` handler: `"help"` opens help, `"settings"` opens the menu.

- [ ] Write tests: banner shown for seeded notes and hidden for a fresh boot; Open sets the flag and invokes `qn_show`; the hotkey capture sends `qn_set_hotkey` and renders `HotkeyUnavailable` as an inline error.
- [ ] Implement.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `feat(app): main-window menu, Quick Notes hotkey settings and upgrade banner`.

### Task 7: Panel chrome and behavior

**Files:**
- Modify: `src/notes.html` (header strip with a drag region and `#quicknotes-close-btn`; sidebar starts `collapsed`), `src/notes.js`, `src/styles.css`
- Test: `test/quicknotes-panel.test.js`

**Interfaces:**
- `#quicknotes-close-btn` → `invoke("qn_close")`. `mousedown` on `.quicknotes-drag` → `invoke("qn_start_drag")`.
- `⌘W` / `Ctrl+W` in the panel → `qn_close` (preventDefault).
- `Esc` never hides.
- `⌘/` → `invoke("show_main_window", { section: "help" })`. Menu item `Settings…` → `show_main_window({ section: "settings" })`.
- `quicknotes-focus-note` `{ title }` → select the first note with that title if it exists.
- `quicknotes-open-menu` → open the actions dropdown.
- The active note id persists in `sodilaud_quicknotes_active_note` and is restored at boot when that note exists.

- [ ] Write tests for each interface line above against `bootApp`.
- [ ] Implement.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `feat(quicknotes): panel header, dismiss shortcuts and cross-window links`.

### Task 8: Welcome note, tray, docs

**Files:**
- Modify: `src/welcome-note.js`, `test/welcome-note.test.js`, `src-tauri/src/clipboard/tray.rs` (Show Editor, Quick Notes item with its hotkey label), `README.md`, `docs/mcp.md`, `site/` landing copy
- Create: `docs/quick-notes.md`

- [ ] Rewrite the Welcome note ("Welcome to Quick Notes"): the hotkey, dismissing, floating, the sidebar toggle, folders/pins/trash, workspace files, condensed editing tips, and the main window menu for settings and help. Update the test's expectations.
- [ ] Tray: `Show Editor`, `Quick Notes  ⌘⇧N` (label refreshed from `hotkey.rs`), `Clipboard History…`, `Clear Clipboard History`, `Quit Sodilaud`.
- [ ] Update the docs, with no em dashes.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `docs(quicknotes): Welcome note, tray entry and documentation`.

## PR 2: Files

### Task 9: Rust file grants and byte-preserving I/O

**Files:**
- Create: `src-tauri/src/files/mod.rs`, `grants.rs`, `io.rs`, `store.rs` (open and recent lists in `files.json`), `commands.rs`
- Modify: `lib.rs`, `build.rs`, `capabilities/default.json`, `test/command-permissions.test.js`

**Interfaces:**
- `FileText { path, text, line_ending: "lf" | "crlf", bom: bool, hash }`.
- `io::read(path) -> Result<FileText, FileError>` refuses anything over 10 MB (`TooLarge`) and non-UTF-8 input (`NotUtf8`), normalizes CRLF to LF for the editor, and records the ending and BOM.
- `io::write_atomic(path, text, line_ending, bom) -> Result<hash>` writes a temp file in the same directory, applies the original mode, fsyncs, renames, and returns the hash of the written bytes.
- Commands (main only):
  - `file_open_dialog() -> Option<FileText>`
  - `file_save_as_dialog({ text, suggestedName, lineEnding, bom }) -> Option<{ path, hash }>`
  - `file_read({ path }) -> FileText`
  - `file_write({ path, text, lineEnding, bom }) -> { hash }`
  - `file_lists() -> { open: [path], recent: [{ path, exists }] }`
  - `file_set_open({ paths })`
  - `file_forget_recent({ path })`
- Every path command canonicalizes and requires the grant. Grants come from the dialogs, from `files.json` at startup (the open and recent entries) and from Finder opens.

- [ ] Write the tests: CRLF round trip, BOM round trip, mode preserved (0600 stays 0600), non-UTF-8 → `NotUtf8`, 11 MB → `TooLarge`, an ungranted path → `NotGranted`, `..` traversal to an ungranted file → `NotGranted`, a symlink to an ungranted target → `NotGranted`.
- [ ] Implement.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `feat(files): granted, byte-preserving file I/O for the main window`.

### Task 10: Watcher, Finder "Open With", single instance

**Files:**
- Create: `src-tauri/src/files/watch.rs`
- Modify: `Cargo.toml` (`notify = "8"`, `tauri-plugin-single-instance = "2"` for non-macOS), `tauri.conf.json` (`bundle.fileAssociations` for `md`, `markdown`, `txt`), `lib.rs` (`RunEvent::Opened`, single-instance callback)

**Interfaces:**
- `file_watch({ paths })` replaces the watched set. Events go to main as `file-changed` `{ path, kind: "modified" | "removed" }`. A modified event whose content hash equals our last write is dropped.
- A Finder open grants the path, adds it to open and recent, shows main, and emits `file-open-request` `{ path }`.

- [ ] Write a unit test for the self-write filter (a pure `should_report(last_written_hash, current_hash)`) and for argument parsing of second-launch argv (`paths_from_args`).
- [ ] Implement.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `feat(files): watch open files and open Markdown from Finder`.

### Task 11: File editor in the main window

**Files:**
- Create: `src/files.js` (pure model: open list, active file, dirty state, untitled buffers, external-change state), `src/format-toolbar.js` (extracted from `notes.js`, used by both pages)
- Modify: `src/index.html`, `src/app.js`, `src/app.css`, `src/notes.js` (uses `format-toolbar.js`)
- Test: `test/files-model.test.js`, `test/file-editor.test.js`

**Interfaces:**
- `createFilesModel()` → `{ openFile(fileText), newUntitled(), activate(id), close(id) -> "closed" | "needs-prompt", edit(id, text), markSaved(id, path, hash), externalChange(path, kind, reader), list(), active() }`.
- The external-change states are `clean-reload`, `conflict` (Reload / Keep mine) and `missing` (Save As… / Close).
- Autosave 400 ms after the last edit when the file has a path. A failed write keeps it dirty and shows the error bar.
- Shortcuts: `⌘N`, `⌘O`, `⌘S`, `⌘⇧S`, `⌘W`.
- Quit handshake: flush every dirty file. An untitled buffer with text asks through `rfd` (`file_confirm_discard` → `save | discard | cancel`).

- [ ] Write the model tests: open, edit and dirty; close a clean file; close an untitled buffer with text → `needs-prompt`; an external modify when clean → reload; an external modify when dirty → conflict; removed → missing; recent list capped at 10, newest first, no duplicates.
- [ ] Write the editor tests with `bootMainWindow`: Open File shows the file text and the sidebar entry; typing then waiting 450 ms invokes `file_write` with the new text; `file-changed` while dirty shows the conflict bar; `⌘W` on the last file shows the start page.
- [ ] Extract the toolbar, and implement the model and wiring.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `feat(files): edit Markdown files in the main window`.

### Task 12: Docs, release notes, roadmap

**Files:** `README.md`, `docs/files.md` (new), `docs/security/2026-09-25-audit-findings.md` (file grant boundary note), `RELEASE_NOTES.md` (0.10.0 section, unreleased), `ROADMAP.md`, `docs/superpowers/specs/2026-09-27-editor-surface-design.md` (open decision 2 resolved), site copy.

- [ ] Update all of them, with no em dashes.
- [ ] Run all checks. Expected: PASS.
- [ ] Commit `docs(files): document file editing and the 0.10.0 changes`.
