# Multiple main windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any number of peer main windows, each owning its own open files, with Move to New Window / Move to Window on a file's sidebar context menu, New Window in the File menu, and the window set restored on restart.

**Architecture:** Rust keeps a pure `WindowSet` (window order, per-window open files, active file, frame, focus order) inside `files::Files`, persisted in `files.json`. Registry documents are never tied to a window: moving a file reassigns ownership in Rust and the target page reopens the still-open document. File events go to every main window and pages listen only to events targeted at their own label.

**Tech Stack:** Rust (Tauri 2.11, serde_json), vanilla JS, CodeMirror 6, `node --test` with jsdom.

**Spec:** `docs/superpowers/specs/2026-10-18-multi-window-design.md`

## Global Constraints

- Window labels: first window `main`; extra windows `main-2`, `main-3`, ... from a session counter that never reuses a number. `is_main_label(l)` = `l == "main"` or `l` is `main-` followed by one or more ASCII digits. Labels are not persisted; saved windows map in order onto `main`, `main-2`, ...
- `src-tauri/capabilities/default.json` `"windows": ["main", "main-*"]`. New commands are granted only there and declared in `src-tauri/build.rs` and `lib.rs` `generate_handler!`.
- New commands: `main_window_new`, `main_window_move_file`, `main_window_list`, `main_window_close_done`. Commands that create windows are `async fn` (a window built inside a synchronous command deadlocks on Windows).
- New events: `main-window-close-requested` (Rust to one main window). Existing `file-open-request` is reused for moves.
- New error code: `FileErrorCode::OpenElsewhere` (serialized `"OpenElsewhere"`).
- `files.json`: `{ "windows": [{ "open": [..], "active": ".."|null, "frame": {x,y,width,height}|null }], "recent": [..], "open": [union of windows' open, window order] }`. A file without `windows` migrates `open` into one window.
- New Window shortcut: Cmd+Alt+N on macOS, Ctrl+Alt+N elsewhere, matched on `event.code === "KeyN"`. Cmd+Shift+N is the global Quick Notes hotkey and must not be used.
- New window size = source window's size (or 960x680), position = source + 28 logical px right and down.
- Carried view state on a move: `{ selection: { start, end }, top: number|null, previewTop: number, folds: string[] }`, at most 65,536 bytes as JSON (larger is dropped to `null` in Rust).
- Copy (exact): menu items "New Window", "Move to New Window", "Move to Window", "Close"; submenu entries `Window N - <file name>` or `Window N - Start Page`; errors "<name> is open in another window.", "<name> is open in another window. Close it there first.", "That window is closed.", "Save <name> first to move it.", "Could not move <name>: unsaved changes could not be sent.", "Could not save every file; the window stays open."
- JS tests: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test <files>` from the worktree root. Never run the suite uncapped.
- Rust: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked <filter>` from the worktree root. The 4 MCP socket tests fail only inside the sandbox.
- Never `cd` into `src/vendor` or `node_modules`. New JS source files go into `check:js` in `package.json`.
- Zero network egress; CSP unchanged. No em dashes. No mention of the coding assistant (AI, Claude, sessions) in commits, docs or PR text; the product's own MCP "agent" wording is fine. Commits `type(scope): description`. Comments only where the why is non-obvious.

## Review Focus

1. A move while edits are still unsent: the moved text must contain the last keystrokes. Test: type, move immediately; `file_doc_push` precedes `main_window_move_file` in invocations (Task 7).
2. A move must never close the registry document: no `file_doc_close` for the moved path (Task 7), and `move_to` keeps exactly one owner (Task 1).
3. A stale `file_set_open` from the source window after a move must not re-claim the file (Task 1 `set_open` drops paths owned elsewhere).
4. Quit while a window is closing: an unregistered window must not stall the quit (Task 5 `unregister` returns `Exit` when it was the last pending one).
5. Old `files.json` (only `open`) and a downgrade: migration into one window and union `open` written back (Task 1).

## File structure

```
src-tauri/src/files/windows.rs     NEW  WindowSet, WindowEntry, Claim, is_main_label, MAIN_LABEL (pure)
src-tauri/src/files/store.rs       SavedWindow, FileLists { windows, recent, open }, migration
src-tauri/src/files/mod.rs         Files holds Lists { windows, recent }; per-label pending; OpenElsewhere; present routing
src-tauri/src/files/commands.rs    per-window file_lists / file_set_open / file_take_pending; claim in file_doc_open; Save As refusal
src-tauri/src/main_window.rs       NEW  show, present, emit_all, create, restore, close flow, the four commands
src-tauri/src/lib.rs               on_window_event (focus, close), About routing, command list
src-tauri/src/quicknotes/window.rs MAIN_LABEL re-exported from files::windows; show_main uses main_window
src-tauri/src/clipboard/tray.rs, clipboard/runtime.rs, docs/commands.rs, mcp.rs, quit.rs
src-tauri/build.rs, src-tauri/capabilities/default.json
src/window-events.js               NEW  ownLabel, listenHere
src/open-file-menu.js              NEW  sidebar context menu
src/file-editor.js, src/app.js, src/clipboard-settings-ui.js, src/index.html, src/app.css
test/helpers/app-harness.js        label option, listen options recorded
test/window-events.test.js, test/multi-window-move.test.js, test/multi-window-close.test.js,
test/new-window.test.js, test/new-window-linux.test.js, test/command-permissions.test.js
docs/files.md, ROADMAP.md
```

---

### Task 1: Pure window set and `files.json` schema

**Files:**
- Create: `src-tauri/src/files/windows.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod windows;` only), `src-tauri/src/files/store.rs`
- Test: unit tests inside both files

**Interfaces:**
- Consumes: `crate::quicknotes::config::Frame` (already `Serialize, Deserialize, Clone, Copy, Debug, PartialEq`).
- Produces (`files::windows`):
  ```rust
  pub const MAIN_LABEL: &str = "main";
  pub fn is_main_label(label: &str) -> bool;
  #[derive(Clone, Debug, PartialEq)]
  pub struct WindowEntry { pub label: String, pub open: Vec<String>, pub active: Option<String>, pub frame: Option<Frame> }
  #[derive(Clone, Debug, PartialEq, Eq)]
  pub enum Claim { Mine, Elsewhere(String) }
  pub struct WindowSet { /* windows: Vec<WindowEntry>, focus: Vec<String> (most recent first), next: u32 */ }
  impl WindowSet {
      pub fn from_saved(saved: Vec<SavedWindow>) -> Self;   // >= 1 window; labels main, main-2, ...; focus = window order; next = len + 1
      pub fn labels(&self) -> Vec<String>;                  // window order
      pub fn entry(&self, label: &str) -> Option<&WindowEntry>;
      pub fn number(&self, label: &str) -> Option<usize>;   // 1-based position
      pub fn add(&mut self) -> String;                      // new empty window at the end, front of focus
      pub fn remove(&mut self, label: &str) -> Vec<String>; // its open paths; refuses (returns empty, keeps it) when it is the only window
      pub fn focused(&mut self, label: &str);               // moves to front of focus; unknown labels ignored
      pub fn target(&self) -> String;                       // front of focus
      pub fn owner(&self, path: &str) -> Option<String>;
      pub fn claim(&mut self, label: &str, path: &str) -> Claim;   // unowned: appended to label's open, Mine
      pub fn set_open(&mut self, label: &str, paths: Vec<String>, active: Option<String>); // drops paths another window owns; active kept only if in the result
      pub fn move_to(&mut self, path: &str, to: &str) -> Result<(), String>; // removes from owner, appends to `to`, active = path; Err("That window is closed.") for unknown `to`
      pub fn route(&mut self, paths: &[String]) -> Vec<(String, Vec<String>)>; // owner, else claim for target(); grouped by label in first-seen order
      pub fn all_open(&self) -> Vec<String>;               // window order
      pub fn set_frame(&mut self, label: &str, frame: Frame);
      pub fn saved(&self) -> Vec<SavedWindow>;              // window order
  }
  ```
- Produces (`files::store`):
  ```rust
  #[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)] #[serde(rename_all = "camelCase")]
  pub struct SavedWindow { #[serde(default)] pub open: Vec<String>, #[serde(default)] pub active: Option<String>, #[serde(default)] pub frame: Option<Frame> }
  pub struct FileLists { #[serde(default)] pub windows: Vec<SavedWindow>, #[serde(default)] pub recent: Vec<String>, #[serde(default)] pub open: Vec<String> }
  impl FileLists { pub fn opened_recent(&mut self, path: &str); pub fn forget_recent(&mut self, path: &str); }
  pub fn load(path: &Path) -> FileLists;   // windows empty and open non-empty -> windows = [SavedWindow { open, .. }]
  pub fn save(path: &Path, lists: &FileLists) -> Result<(), String>; // writes open = union of windows' open, window order, no duplicates
  ```
  `FileLists::opened` (recent + open) is replaced by `opened_recent` (recent only, newest first, `RECENT_LIMIT` 10); adding to a window's open list is `WindowSet::claim`. Keep `FileLists` derive `PartialEq` without `Eq` (Frame has f64).

- [ ] **Step 1: Write failing tests in `windows.rs`**

```rust
#[test] fn main_labels_are_main_and_numbered() {
    for ok in ["main", "main-2", "main-15"] { assert!(is_main_label(ok)); }
    for no in ["quicknotes", "clipboard", "main-", "main-x", "main2", "mainly"] { assert!(!is_main_label(no)); }
}
#[test] fn saved_windows_map_onto_main_then_numbered_labels() {
    let set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[]), saved(&["/b.md"])]);
    assert_eq!(set.labels(), ["main", "main-2", "main-3"]);
    assert_eq!(set.target(), "main");
    assert_eq!(WindowSet::from_saved(vec![]).labels(), ["main"]);
}
#[test] fn added_windows_never_reuse_a_label_and_take_focus() {
    let mut set = WindowSet::from_saved(vec![]);
    let second = set.add(); assert_eq!(second, "main-2"); assert_eq!(set.target(), "main-2");
    set.remove("main-2");
    assert_eq!(set.add(), "main-3");
}
#[test] fn the_last_window_cannot_be_removed() {
    let mut set = WindowSet::from_saved(vec![saved(&["/a.md"])]);
    assert!(set.remove("main").is_empty()); assert_eq!(set.labels(), ["main"]);
}
#[test] fn a_path_belongs_to_one_window() {
    let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[])]);
    assert_eq!(set.claim("main-2", "/a.md"), Claim::Elsewhere("main".into()));
    assert_eq!(set.claim("main-2", "/b.md"), Claim::Mine);
    assert_eq!(set.owner("/b.md").as_deref(), Some("main-2"));
}
#[test] fn moving_keeps_exactly_one_owner() {
    let mut set = WindowSet::from_saved(vec![saved(&["/a.md", "/b.md"]), saved(&[])]);
    set.move_to("/a.md", "main-2").unwrap();
    assert_eq!(set.entry("main").unwrap().open, ["/b.md"]);
    assert_eq!(set.entry("main-2").unwrap().open, ["/a.md"]);
    assert_eq!(set.entry("main-2").unwrap().active.as_deref(), Some("/a.md"));
    assert_eq!(set.move_to("/b.md", "main-9").unwrap_err(), "That window is closed.");
}
#[test] fn a_stale_open_list_cannot_take_back_a_moved_file() {
    let mut set = WindowSet::from_saved(vec![saved(&["/a.md", "/b.md"]), saved(&[])]);
    set.move_to("/a.md", "main-2").unwrap();
    set.set_open("main", vec!["/a.md".into(), "/b.md".into()], Some("/a.md".into()));
    assert_eq!(set.entry("main").unwrap().open, ["/b.md"]);
    assert_eq!(set.entry("main").unwrap().active, None);
}
#[test] fn outside_opens_go_to_the_owner_or_the_focused_window() {
    let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[])]);
    set.focused("main-2");
    assert_eq!(set.route(&["/a.md".into(), "/new.md".into()]),
        vec![("main".to_string(), vec!["/a.md".to_string()]), ("main-2".to_string(), vec!["/new.md".to_string()])]);
    assert_eq!(set.owner("/new.md").as_deref(), Some("main-2"));
}
#[test] fn saved_keeps_window_order_and_frames() { /* set_frame on main-2, saved()[1].frame == Some(frame) */ }
```
(`saved(paths)` is a test helper building `SavedWindow { open, ..Default::default() }`.)

- [ ] **Step 2: Write failing tests in `store.rs`**

```rust
#[test] fn a_file_from_an_older_release_becomes_one_window() {
    // write {"open":["/a.md"],"recent":["/a.md"]} raw, load
    assert_eq!(load(&path).windows, vec![SavedWindow { open: vec!["/a.md".into()], ..Default::default() }]);
}
#[test] fn the_open_list_is_still_written_for_older_releases() {
    // save windows [["/a.md","/b.md"], ["/c.md","/a.md"]]; read raw JSON
    assert_eq!(raw["open"], json!(["/a.md", "/b.md", "/c.md"]));
}
```
Keep and adapt the existing two tests (recent order/cap via `opened_recent`; damaged file gives defaults).

- [ ] **Step 3: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files::`
Expected: compile errors for the missing items.

- [ ] **Step 4: Implement `windows.rs` and the `store.rs` changes**

Leave `Files` callers compiling: in `files/mod.rs` and `files/commands.rs` replace `lists.opened(p)` with `lists.opened_recent(p)` plus a temporary push onto `lists.windows[0].open` (Task 2 replaces this with `WindowSet`); replace `lists.open = open` in `file_set_open` with the same on `windows[0]` (create it if missing), and `lists.open` reads in `Files::load` / `lists_view` with `windows.iter().flat_map(|w| &w.open)`.

- [ ] **Step 5: Run tests to verify they pass**

Run the Step 3 command. Expected: PASS (the 4 MCP socket tests are not in this filter).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/files
git commit -m "feat(files): window set model and per-window open lists in files.json"
```

---

### Task 2: Files owned per window in Rust

**Files:**
- Create: `src-tauri/src/main_window.rs` (only `show` and `present` in this task)
- Modify: `src-tauri/src/files/mod.rs`, `src-tauri/src/files/commands.rs`, `src-tauri/src/lib.rs` (`mod main_window;`, focus tracking in `on_window_event`), `src/file-editor.js` (`takePending`, `openPath`, `syncOpenList`)
- Test: `src-tauri/src/files/mod.rs` tests, `test/file-editor.test.js`

**Interfaces:**
- Consumes: Task 1 `WindowSet`, `Claim`, `SavedWindow`, `FileLists`, `MAIN_LABEL`.
- Produces (`files`):
  ```rust
  pub struct Lists { pub windows: WindowSet, pub recent: Vec<String> }
  #[derive(Serialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")]
  pub struct PendingOpen { pub path: String, pub view: Option<serde_json::Value> }
  impl Files {
      pub fn read<T>(&self, f: impl FnOnce(&Lists) -> T) -> T;
      pub fn update<T>(&self, f: impl FnOnce(&mut Lists) -> T) -> T; // persists saved() + recent, then watches all_open()
      pub fn queue(&self, label: &str, entries: Vec<PendingOpen>);
      pub fn take_pending(&self, label: &str) -> Vec<PendingOpen>;
      pub fn drop_pending(&self, label: &str);
  }
  impl FileError { pub fn open_elsewhere(path: &Path) -> Self; pub fn owned_elsewhere(path: &Path) -> Self; } // code OpenElsewhere / Unsupported
  pub fn present_pending(app: &AppHandle, files: &Files, granted: Vec<String>); // routes with WindowSet::route
  ```
  `update_lists` and `lists()` are removed in favour of `update` / `read`.
- Produces (`main_window`):
  ```rust
  pub fn show(app: &AppHandle, label: &str);     // macOS: ActivationPolicy::Regular first; unminimize, show, set_focus
  pub fn present(app: &AppHandle, label: &str);  // show + emit_to(label, files::commands::OPEN_REQUEST_EVENT, ())
  ```
- Command changes (`files/commands.rs`): `file_lists(window)` returns `{ open: <this window's open>, recent }`; `file_set_open(window, paths, active: Option<String>)` calls `WindowSet::set_open`; `file_take_pending(window) -> Vec<PendingOpen>`; `file_doc_open` claims the path for the window first: `Claim::Elsewhere(owner)` queues `{ path, view: None }` for the owner, runs `main_window::present(app, &owner)` on the main thread and returns `Err(FileError::open_elsewhere(&path))` without opening; `file_save_as_dialog` returns `Err(FileError::owned_elsewhere(&chosen))` when the chosen path's owner is another window (check before `file_discard`), and claims the saved path for the caller; `file_doc_open` and Save As add to recent with `opened_recent`.
- Focus: `lib.rs` `on_window_event` on `WindowEvent::Focused(true)` for `is_main_label` windows calls `files.update(|l| l.windows.focused(label))` without persisting being required (persisting is harmless).
- JS (`file-editor.js`): `takePending` accepts `[{ path, view }]` and opens `entry.path` (view handling arrives in Task 7); `openPath` returns `null` without `notify` when `error?.code === "OpenElsewhere"`; `syncOpenList` sends `{ paths: model.paths(), active: (showingStartPage ? null : model.active()?.path) ?? null }`.

- [ ] **Step 1: Write failing Rust tests in `files/mod.rs`**

```rust
#[test] fn pending_opens_are_kept_per_window() {
    let files = Files::for_test();   // new test constructor: no lists_path, WindowSet::from_saved(vec![]), empty recent
    files.queue("main", vec![PendingOpen { path: "/a.md".into(), view: None }]);
    files.queue("main-2", vec![PendingOpen { path: "/b.md".into(), view: Some(json!({"top": 3})) }]);
    assert_eq!(files.take_pending("main-2")[0].path, "/b.md");
    assert!(files.take_pending("main-2").is_empty());
    assert_eq!(files.take_pending("main").len(), 1);
}
#[test] fn an_open_elsewhere_error_names_the_file() {
    let error = FileError::open_elsewhere(Path::new("/d/plan.md"));
    assert_eq!(error.code, FileErrorCode::OpenElsewhere);
    assert_eq!(error.message, "plan.md is open in another window.");
    assert_eq!(FileError::owned_elsewhere(Path::new("/d/plan.md")).message, "plan.md is open in another window. Close it there first.");
}
```

- [ ] **Step 2: Write the failing JS test in `test/file-editor.test.js`**

```js
test("a file open in another window is not reported as an error here", async () => {
  const fake = lists();
  const notices = [];
  const app = await bootMainWindow({
    platform: "MacIntel",
    handlers: { ...fake.handlers, file_open_dialog: () => "/docs/b.md",
      file_doc_open: () => { throw { code: "OpenElsewhere", message: "b.md is open in another window." }; } }
  });
  app.click("start-open-file-btn");
  await app.settle();
  assert.equal(doc(app).getElementById("app-notification").hidden, true);
  assert.equal(doc(app).getElementById("start-page").hidden, false);
});

test("the open list carries the active file", async () => {
  // Open /docs/plan.md via file_open_dialog; the last file_set_open invocation has
  // args { paths: ["/docs/plan.md"], active: "/docs/plan.md" }.
});
```
Update the `lists()` helper's `file_take_pending` to return `[]` (unchanged) and add a test that `file_take_pending: () => [{ path: "/docs/plan.md", view: null }]` at boot shows that file.

- [ ] **Step 3: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files::` and `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/file-editor.test.js`
Expected: FAIL (missing items; notification shown; `active` absent; pending object not opened).

- [ ] **Step 4: Implement**

`Files::load` builds `Lists { windows: WindowSet::from_saved(lists.windows), recent }` and grants every path in `all_open()` and `recent`. `present_pending` calls `files.update(|l| l.windows.route(&granted))`, queues each group for its label and calls `main_window::present` for each label. `open_for_agent` keeps running `present_pending` on the main thread. `file_doc_open`'s `present` must run via `app.run_on_main_thread` (the command is synchronous but may run off the main thread in tests).

- [ ] **Step 5: Run tests to verify they pass**

Run both Step 3 commands, then the full Rust suite: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked`. Expected: PASS except the 4 sandboxed MCP socket tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src src/file-editor.js test/file-editor.test.js
git commit -m "feat(files): open files belong to one window and outside opens are routed"
```

---

### Task 3: Events and permissions for every main window

**Files:**
- Create: `src/window-events.js`, `test/window-events.test.js`
- Modify: `src-tauri/src/main_window.rs` (`emit_all`, `labels`, `show_target`), `src-tauri/src/docs/commands.rs` (`AppSink`, `page_doc`), `src-tauri/src/mcp.rs` (`AppEvents`), `src-tauri/src/clipboard/runtime.rs` (STOPPED_EVENT), `src-tauri/src/clipboard/tray.rs` (`show_main`, `hide_main`), `src-tauri/src/quicknotes/window.rs` (`MAIN_LABEL` re-export, `show_main`), `src-tauri/src/files/commands.rs` (`require_main`), `src-tauri/src/lib.rs` (About, `on_window_event`, `RunEvent::Reopen`), `src-tauri/capabilities/default.json`, `src/app.js`, `src/clipboard-settings-ui.js`, `test/helpers/app-harness.js`, `test/command-permissions.test.js`, `package.json` (`check:js`)
- Test: `test/window-events.test.js`, `test/command-permissions.test.js`, `test/clipboard-settings-ui.test.js`

**Interfaces:**
- Consumes: Task 1 `is_main_label`, `MAIN_LABEL`; Task 2 `Files::read`, `main_window::show`.
- Produces (`main_window`):
  ```rust
  pub fn labels(app: &AppHandle) -> Vec<String>;   // live webview windows with is_main_label
  pub fn emit_all<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S); // emit_to each label
  pub fn show_target(app: &AppHandle) -> Option<String>; // WindowSet::target(), shown; None if that window does not exist
  pub fn hide_all(app: &AppHandle);                // hides every main window; macOS: ActivationPolicy::Accessory
  ```
  `tray::show_main` calls `show_target`; `tray::hide_main` calls `hide_all`; `quicknotes::window::show_main(app, section)` shows the target and emits `OPEN_SECTION_EVENT` to that label; the About menu emits `sodilaud-open-about` with `emit_to(target, ...)` (not `window.emit`, which broadcasts). `AppSink::file_doc/file_saved/file_external`, file `comments`, `coedit_state` (plus `quicknotes`), `mcp::AppEvents` (plus `quicknotes`) and the clipboard `STOPPED_EVENT` use `emit_all`. `require_main` and `page_doc` accept any `is_main_label` window. `lib.rs` `on_window_event` applies today's close behavior to any main label (Task 5 replaces it).
- Produces (JS, `src/window-events.js`):
  ```js
  export function ownLabel(window) -> string | null;   // window.__TAURI__.window.getCurrentWindow().label, null on failure
  export function listenHere(window, name, handler) -> Promise<unlisten | undefined>;
  // calls window.__TAURI__.event.listen(name, handler, { target: { kind: "WebviewWindow", label } }); no-op without the bridge
  ```
  `preferences.js` imports `ownLabel` instead of its private `currentLabel`. `app.js` `registerNativeHandlers` and `registerQuitHandler` use `listenHere` for every event except `prefs-changed`; `agentAccess.listen` and `setupClipboardHistory` receive `(name, handler) => listenHere(window, name, handler)`.
- Produces (shared settings): `setupClipboardHistory({ ..., broadcast })` returns `{ reload() }`; `apply` calls `broadcast(CLIPBOARD_SETTINGS_KEY)` after writing storage; `reload()` re-reads storage and re-renders without invoking `clip_set_config`. `app.js` `followPreferenceChange`: `CLIPBOARD_SETTINGS_KEY` -> `clipboard.reload()`; `"sodilaud_quicknotes_hotkey"` -> `loadQuickNotesConfig()`. `setQuickNotesHotkey` calls `broadcastPreference(window, "sodilaud_quicknotes_hotkey")` after a successful `qn_set_hotkey`.
- Harness: `bootMainWindow({ label })` (default `"main"`); the fake `listen(name, handler, options)` records options; the result exposes `listenOptions: Map<name, options>`; the invoke fallback treats any label starting with `main` as the main window.

- [ ] **Step 1: Write failing tests**

`test/window-events.test.js`:
```js
test("the main window hears only events sent to it", async () => {
  const app = await bootMainWindow({ label: "main-2", platform: "MacIntel" });
  for (const name of ["file-doc-updates", "file-doc-saved", "file-doc-external", "file-open-request",
    "comments-changed", "coedit-state", "sodilaud-quit-requested", "sodilaud-open-about", "sodilaud-open-section", "mcp-state-changed"]) {
    assert.deepEqual(app.listenOptions.get(name), { target: { kind: "WebviewWindow", label: "main-2" } }, name);
  }
  assert.equal(app.listenOptions.get("prefs-changed"), undefined);
});
```
`test/command-permissions.test.js`: change `assert.deepEqual(main.windows, ["main"])` to `["main", "main-*"]`; add a test that `lib.rs`, `files/commands.rs` and `docs/commands.rs` contain no `== MAIN_LABEL` / `== quicknotes::window::MAIN_LABEL` comparisons and that `clipboard/` contains no `"main"` literal.
`test/clipboard-settings-ui.test.js`: a test that changing the capacity emits `prefs-changed` with key `clipboardHistory.settings`, and one that a `prefs-changed` for that key with new storage re-renders the capacity input without a second `clip_set_config` invocation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/window-events.test.js test/command-permissions.test.js test/clipboard-settings-ui.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the Rust and JS changes listed in Interfaces; add `src/window-events.js` to `check:js`**

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command, then `npm run check:js`, then `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`. Expected: PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src src-tauri test package.json
git commit -m "feat(windows): send window events to every main window and listen per window"
```

---

### Task 4: Creating, restoring and moving between windows in Rust

**Files:**
- Modify: `src-tauri/src/main_window.rs`, `src-tauri/src/lib.rs` (setup, `generate_handler!`), `src-tauri/src/quicknotes/mod.rs` (`restore_windows`), `src-tauri/src/quit.rs` (`exit` records frames and `main = any visible`), `src-tauri/build.rs`, `src-tauri/capabilities/default.json`
- Test: `src-tauri/src/main_window.rs` unit tests, `test/command-permissions.test.js`

**Interfaces:**
- Consumes: Task 1 `WindowSet::{add, move_to, set_frame, entry, number, labels}`; Task 2 `Files::{update, read, queue, drop_pending}`, `PendingOpen`, `main_window::present`; Task 3 `main_window::{show, labels}`; `quicknotes::config::{clamp_frame, Frame, Screen}`.
- Produces:
  ```rust
  pub const VIEW_LIMIT: usize = 65_536;
  pub fn create(app: &AppHandle, label: &str, frame: Option<Frame>, visible: bool) -> Option<WebviewWindow>;
  // WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into())).title("Sodilaud"), default inner_size 960x680; frame -> position + size (physical)
  pub fn cascade_from(source: &WebviewWindow) -> Option<Frame>;  // source outer size, position + 28 * scale_factor
  pub fn restore(app: &AppHandle, visible: bool);  // after files::start: clamp each saved frame to the screens; apply to "main"; create the others
  pub fn record_frames(app: &AppHandle);            // each live main window's outer frame -> WindowSet::set_frame, persisted
  pub fn limited_view(view: Option<serde_json::Value>) -> Option<serde_json::Value>; // None when serialized length > VIEW_LIMIT
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct WindowSummary { pub label: String, pub number: usize, pub title: String }
  pub fn summaries(set: &WindowSet, except: &str) -> Vec<WindowSummary>; // title = file name of active, else of first open, else "Start Page"
  #[tauri::command] pub async fn main_window_new(app: AppHandle, window: WebviewWindow) -> Result<String, FileError>;
  #[tauri::command] pub async fn main_window_move_file(app: AppHandle, window: WebviewWindow, path: String, to: Option<String>, view: Option<serde_json::Value>) -> Result<String, FileError>;
  #[tauri::command] pub fn main_window_list(window: tauri::Window, files: State<'_, Files>) -> Result<Vec<WindowSummary>, FileError>;
  ```
  `main_window_move_file`: caller must be a main window; `files.require(&path)`; the registry must have the path open (`registry.file_doc_ids()`), else `FileError::not_open`; the caller must own it, else `FileError::not_open`; `to` must be another existing window, else `FileError::other("That window is closed.")`; `to == None` adds a window (`WindowSet::add`) and creates it with `cascade_from(&window)`; then `move_to`, `queue(target, [PendingOpen { path, view: limited_view(view) }])`, `present(target)`; returns the target label. `main_window_new` adds and creates a window the same way and returns its label.
  `quicknotes::restore_windows` calls `main_window::restore(app, main_visible)` where `main_visible` is today's `startup_windows(...).0`. `quit::exit` calls `record_frames` before saving, and sets `WindowsAtQuit.main` to whether any main window is visible.

- [ ] **Step 1: Write failing Rust tests in `main_window.rs`**

```rust
#[test] fn other_windows_are_listed_by_number_and_file() {
    let mut set = WindowSet::from_saved(vec![saved(&["/d/a.md"], Some("/d/a.md")), saved(&[], None), saved(&["/d/b.md", "/d/c.md"], None)]);
    let listed = summaries(&set, "main");
    assert_eq!(listed.iter().map(|w| (w.label.as_str(), w.number, w.title.as_str())).collect::<Vec<_>>(),
        vec![("main-2", 2, "Start Page"), ("main-3", 3, "b.md")]);
}
#[test] fn a_large_view_state_is_dropped() {
    assert_eq!(limited_view(Some(json!({"top": 1}))), Some(json!({"top": 1})));
    assert_eq!(limited_view(Some(json!({"x": "a".repeat(VIEW_LIMIT)}))), None);
}
```
In `test/command-permissions.test.js` assert the four new commands are granted only by `default`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked main_window` and `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/command-permissions.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement; register the three commands in `build.rs`, `generate_handler!` and `default.json` (`allow-main-window-new`, `allow-main-window-move-file`, `allow-main-window-list`)**

- [ ] **Step 4: Run tests and clippy**

Run the Step 2 commands, then `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri test/command-permissions.test.js
git commit -m "feat(windows): create, restore and move files between main windows"
```

---

### Task 5: Closing a window

**Files:**
- Create: `test/multi-window-close.test.js`
- Modify: `src-tauri/src/main_window.rs`, `src-tauri/src/quit.rs`, `src-tauri/src/lib.rs` (`on_window_event`, command list), `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `src/app.js`, `src/file-editor.js`
- Test: `quit.rs` unit tests, `test/multi-window-close.test.js`

**Interfaces:**
- Consumes: Task 2 `Files::{update, drop_pending}`; Task 3 `listenHere`, `main_window::hide_all`; Task 4 `main_window::create`.
- Produces:
  ```rust
  // quit.rs
  impl QuitCoordinator { pub fn unregister(&mut self, label: &str) -> QuitStep; } // Exit when a quit was waiting only on it
  pub fn forget_window(app: &AppHandle, label: &str); // unregister; on Exit calls exit(app)
  // main_window.rs
  pub const CLOSE_REQUESTED_EVENT: &str = "main-window-close-requested";
  pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi);
  #[tauri::command] pub fn main_window_close_done(window: tauri::Window, ok: bool);
  ```
  `on_close_requested`: always `prevent_close`. If this is the only main window: today's behavior (macOS `hide_all`, else `quit::request`). Else if the label is not registered with the quit coordinator: close now (same as `close_done(ok = true)`). Else `emit_to(label, CLOSE_REQUESTED_EVENT, ())`.
  `main_window_close_done(ok)`: `ok == false` does nothing. Otherwise, if it is now the only main window, apply the last-window behavior; else `paths = files.update(|l| l.windows.remove(label))`, `registry.file_close(path, files)` for each (log errors), `files.drop_pending(label)`, `quit::forget_window`, `window.destroy()`.
  JS: `fileEditor.flushForClose()` = the existing `flushForQuit` logic with failure message "Could not save every file; the window stays open." (extract a shared `flushAll(failureMessage)`). `app.js` registers `listenHere(window, "main-window-close-requested", ...)` that runs `flushForClose()` once at a time and invokes `main_window_close_done({ ok })`.

- [ ] **Step 1: Write failing tests**

`quit.rs`:
```rust
#[test] fn a_closed_window_no_longer_holds_up_a_quit() {
    let mut coordinator = with_windows(&["main", "main-2", "quicknotes"]);
    coordinator.begin();
    coordinator.report("main", true);
    coordinator.report("quicknotes", true);
    assert_eq!(coordinator.unregister("main-2"), QuitStep::Exit);
    assert_eq!(coordinator.registered(), vec!["main".to_string(), "quicknotes".to_string()]);
}
#[test] fn unregistering_outside_a_quit_only_forgets_the_window() {
    let mut coordinator = with_windows(&["main", "main-2"]);
    assert_eq!(coordinator.unregister("main-2"), QuitStep::Wait);
    assert_eq!(coordinator.begin(), Begin::Ask(vec!["main".into()]));
}
```
`test/multi-window-close.test.js` (boot with `label: "main-2"`, a `lists()`-style handler set, `disk` with one file open):
```js
test("a close request saves the window's files and answers Rust", async () => {
  // type into the open file, then app.emit("main-window-close-requested")
  // await until an invocation main_window_close_done exists
  // assert file_doc_save for the path precedes it, and its args are { ok: true }
});
test("cancelling the unsaved-file question keeps the window open", async () => {
  // New File, type text, handler file_confirm_discard: () => "cancel"
  // emit close request; main_window_close_done args { ok: false }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked quit` and `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/multi-window-close.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement; register `main_window_close_done` in `build.rs`, `generate_handler!`, `default.json`; add it to the Task 4 permission assertion**

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 commands and `node --test test/command-permissions.test.js` (capped). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri src test
git commit -m "feat(windows): close a main window after saving its files"
```

---

### Task 6: New Window in the File menu and Cmd+Alt+N

**Files:**
- Create: `test/new-window.test.js`, `test/new-window-linux.test.js`
- Modify: `src/index.html` (menu item, help row), `src/app.js`
- Test: the two new files, `test/help-platform-labels.test.js` if it enumerates rows

**Interfaces:**
- Consumes: Task 4 command `main_window_new` (no arguments, returns a label).
- Produces: `<button class="dropdown-item" id="menu-new-window-btn" title="New Window (Cmd+Alt+N)">New Window</button>` directly after `#menu-new-file-btn`; a help row "New Window" with keys `Cmd` `+` `Alt` `+` `N` in the "Files (this window)" section, after New File (the existing `data-shortcut-off-mac` / `applyPlatformShortcutLabels` mechanism turns Cmd into Ctrl off macOS). `app.js`: `function isNewWindowShortcut(event)` (macOS: `metaKey && altKey && !ctrlKey && !shiftKey`; others: `ctrlKey && altKey && !metaKey && !shiftKey`; both require `event.code === "KeyN"`), checked in `handleKeydown` before `fileEditor.handleShortcut`; `openNewWindow()` invokes `main_window_new` and notifies "Could not open a new window" on failure.

- [ ] **Step 1: Write failing tests**

`test/new-window.test.js` (platform `MacIntel`):
```js
test("New Window in the File menu asks Rust for a window", async () => { /* click menu-new-window-btn; one main_window_new invocation */ });
test("Cmd+Alt+N opens a window even when Option+N is a dead key", async () => {
  /* keydown { metaKey: true, altKey: true, key: "Dead", code: "KeyN" } -> one main_window_new; preventDefault called */
});
test("Cmd+Shift+N is left to the Quick Notes hotkey", async () => { /* keydown meta+shift+N -> no main_window_new */ });
```
`test/new-window-linux.test.js` (platform `Linux x86_64`): Ctrl+Alt+N opens a window; Cmd(meta)+Alt+N does not; the help row shows `Ctrl`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/new-window.test.js test/new-window-linux.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the Step 2 command plus `test/help-menu.test.js test/help-platform-labels.test.js test/file-editor.test.js`. Expected: PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/index.html src/app.js test/new-window.test.js test/new-window-linux.test.js
git commit -m "feat(windows): New Window in the File menu with Cmd+Alt+N"
```

---

### Task 7: Move to New Window and Move to Window

**Files:**
- Create: `src/open-file-menu.js`, `test/multi-window-move.test.js`
- Modify: `src/file-editor.js`, `src/index.html` (`<div class="custom-context-menu" id="open-file-menu" role="menu" hidden></div>` inside `#app`), `src/app.css` (only if the existing `.custom-context-menu` rules need `position: fixed` in this window), `package.json` (`check:js`)
- Test: `test/multi-window-move.test.js`

**Interfaces:**
- Consumes: Task 2 pending entries `[{ path, view }]` and `file_set_open` `active`; Task 4 commands `main_window_move_file({ path, to, view }) -> label` and `main_window_list() -> [{ label, number, title }]`; `foldedSections`, `setFoldedSections` from `src/editor-folds.js`; `EditorView` from `src/vendor/codemirror.js`.
- Produces (`src/open-file-menu.js`):
  ```js
  export function createOpenFileMenu({ document, root, invoke, onMove, onClose }) -> {
    open(buffer, { x, y }, anchor),  // fetches main_window_list; builds items; focuses the first enabled item
    close(),                          // hides; returns focus to anchor
    isOpen()
  }
  // Items: "Move to New Window" (disabled with title "Save the file first" when buffer.path === null)
  //        -> onMove(buffer.id, null);
  //        "Move to Window" submenu, only when main_window_list returns entries; entry text `Window ${number} - ${title}`
  //        -> onMove(buffer.id, label);
  //        "Close" -> onClose(buffer.id).
  // Escape closes; ArrowDown/ArrowUp move focus; a click outside or window blur closes.
  ```
- Produces (`file-editor.js`):
  ```js
  viewState(buffer) -> { selection: { start, end }, top: number | null, previewTop: number, folds: string[] }
  // shown buffer: editor selection; top = view.lineBlockAtHeight(scrollDOM top - view.documentTop).from; preview.scrollTop; foldedSections(state)
  // other buffer: from buffer.editorState (selection.main, folds), top null, buffer.previewTop ?? 0
  applyViewState(view)   // on the shown buffer: setFoldedSections, setSelection clamped to doc length (no scroll),
                         // top !== null -> EditorView.scrollIntoView(min(top, length), { y: "start" }), preview.scrollTop = previewTop
  moveFile(id, to = null) -> Promise<boolean>
  ```
  `moveFile`: untitled -> notify "Save <name> first to move it." and return false; `await sync.flush()` false -> notify "Could not move <name>: unsaved changes could not be sent." and return false; capture `viewState`; `invoke("main_window_move_file", { path, to, view })`, on error notify its message and return false; then `model.close(id, { force: true })` **without** `file_doc_close`, clear `shownId` if it was shown, show the start page if nothing is left, `syncOpenList()`, `render()`. `takePending` applies `entry.view` after `openPath` succeeds. `renderSidebar` wires `contextmenu` on each `.open-file-item` and `ContextMenu` / `Shift+F10` on its name button to `menu.open`. The returned API gains `moveFile`.

- [ ] **Step 1: Write failing tests in `test/multi-window-move.test.js`** (boot `bootMainWindow` with `disk` holding `/book/01.md` and `/book/02.md`, both open via `file_lists`, handlers recording `main_window_move_file`)

```js
test("moving sends the last keystrokes first and never closes the document", async () => {
  // show /book/01.md, type "x" at 0 without waiting, call app-level contextmenu -> "Move to New Window"
  // await until main_window_move_file invoked
  const names = app.invocations.map(i => i.command);
  assert.ok(names.lastIndexOf("file_doc_push") < names.indexOf("main_window_move_file"));
  assert.ok(!app.invocations.some(i => i.command === "file_doc_close" && i.args.path === "/book/01.md"));
  assert.equal(app.fileDocs.text("/book/01.md").startsWith("x"), true);
  assert.equal(app.fileDocs.isOpen("/book/01.md"), true);
  assert.deepEqual(lastSetOpen(app).paths, ["/book/02.md"]);
  assert.equal(moveArgs(app).to, null);
  assert.deepEqual(Object.keys(moveArgs(app).view).sort(), ["folds", "previewTop", "selection", "top"]);
});
test("the menu lists the other windows by number and file", async () => {
  // main_window_list: () => [{ label: "main-2", number: 2, title: "notes.md" }]
  // open the menu; a submenu item reads "Window 2 - notes.md"; clicking it -> move args { to: "main-2" }
});
test("an untitled file cannot be moved", async () => {
  // New File; open its menu; "Move to New Window" is disabled; no main_window_move_file
});
test("a file handed over with its view opens where it was", async () => {
  // boot with file_take_pending: () => [{ path: "/book/02.md", view: { selection: { start: 4, end: 4 }, top: null, previewTop: 0, folds: ["intro"] } }]
  // /book/02.md is shown; editor selection main.head === 4; foldedSections(state) includes "intro"
});
test("a failed move keeps the file here", async () => {
  // main_window_move_file throws { message: "That window is closed." } -> notification text, file still listed
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' node --test test/multi-window-move.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement; add `src/open-file-menu.js` to `check:js`**

- [ ] **Step 4: Run the Step 2 command plus `test/file-editor.test.js test/file-scroll.test.js test/outline.test.js test/accessibility.test.js`, then `npm run check:js`. Expected: PASS.**

- [ ] **Step 5: Commit**

```bash
git add src test/multi-window-move.test.js package.json
git commit -m "feat(windows): move an open file to a new or another window"
```

---

### Task 8: Docs, roadmap and the full CI mirror

**Files:**
- Modify: `docs/files.md`, `ROADMAP.md`, `src/index.html` (help note in "Files (this window)" if it says "This window edits" in a way that implies only one window)
- Create (uncommitted): `.pr-body.md`

**Interfaces:**
- Consumes: everything above. No code changes unless a check fails.

- [ ] **Step 1: `docs/files.md`**: add a "Windows" section: New Window (Cmd+Alt+N, Ctrl+Alt+N on Windows and Linux), each file belongs to one window, Move to New Window / Move to Window from the file's right-click menu (untitled files must be saved first), what carries over (unsaved edits, comments, cursor, scroll, folds) and what does not (undo history), where outside opens go (most recently used window, or the window that has the file), closing a window saves and closes its files, the last window behaves as before, and windows with their files and positions come back after a restart. Update sentences that say "the main window" where they now mean "a main window".

- [ ] **Step 2: `ROADMAP.md`**: add an item at the end:

```markdown
## 15. Multiple main windows

Status: done (spec
[`docs/superpowers/specs/2026-10-18-multi-window-design.md`](docs/superpowers/specs/2026-10-18-multi-window-design.md))

Several peer main windows, each with its own open files. Move to New Window and Move to Window
on an open file's context menu; New Window in the File menu (Cmd+Alt+N). Windows, their files
and their positions are restored on restart. The Folders section of item 4 will be per window.
```

- [ ] **Step 3: Write `.pr-body.md` (do not commit it)** with a summary, the test list, and a release-notes paragraph:

> **Multiple windows.** Open a second main window with New Window (Cmd+Alt+N) in the File menu, or right-click an open file and choose Move to New Window or Move to Window. Each window keeps its own open files, so a review book can stay in one window while you work in another. Unsaved edits, comments, the cursor and folded sections move with the file. Files opened from Finder, the `sodilaud` command or an agent open in the window you used last, or in the window that already has them. Windows, their files and their positions come back after a restart.

- [ ] **Step 4: Run the full CI mirror from the worktree root**

```bash
NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 900; exec @ARGV' npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:egress
```
Expected: all pass; in the sandbox only the 4 MCP socket tests fail. Fix anything else in the task that owns it.

- [ ] **Step 5: Commit**

```bash
git add docs/files.md ROADMAP.md src/index.html
git commit -m "docs(windows): multiple main windows in the files guide and roadmap"
```

- [ ] **Step 6: Manual check list for the reviewer (release build)**: two windows; move a review-book chapter while typing in it; edit in both; quit and relaunch (both windows, files and positions back); Finder Open With lands in the last used window; opening a file already in the other window focuses that window; close a non-last window with an untitled file (asked) and with saved files (closed); close the last window on macOS (hides, tray Show Editor brings it back).
