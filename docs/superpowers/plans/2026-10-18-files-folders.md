# External files and folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish ROADMAP item 4: a per-window Folders section, `.csv`/`.tsv` as plain text (with `.txt`), MCP drafts kept in app data until saved, and find/replace, split view and compare in the file editor.

**Architecture:** Rust lists one folder level at a time for roots stored per window in `files.json` (the window's folder list is the grant), polls expanded folders on the existing 1 s thread, and stores drafts as real files under app data so they reuse the file document registry. The page gets a pure tree model plus a sidebar module, a plain-text editor facet, and three modules shared with or ported from Quick Notes (`find-bar.js`, `pane-compare.js` shared; `file-split.js` new).

**Tech Stack:** Rust (Tauri 2.11, serde, rfd, rmcp), vanilla JS, CodeMirror 6, `node --test` with jsdom.

**Spec:** `docs/superpowers/specs/2026-10-18-files-folders-design.md`

## Global Constraints

- Branch `feat/files-folders`, stacked on `feat/multi-window` (head 9be8b5c). Multi-window Task 7 (open-file context menu, `src/open-file-menu.js`, `moveFile`) is still being built there: do not create or edit `src/open-file-menu.js` and do not add items to the open-file context menu.
- Shown/opened file types: `md`, `markdown`, `txt`, `csv`, `tsv` (case-insensitive). Plain kinds: `txt`, `csv`, `tsv`. User copy lists them as ".md, .markdown, .txt, .csv and .tsv".
- Limits: `LIST_LIMIT = 2000` entries returned per folder, `SCAN_LIMIT = 20000` directory entries read per listing, `FOLDER_WATCH_LIMIT = 128` watched folders app-wide, draft title 1-200 characters after trimming, draft content at most 100000 UTF-8 bytes, draft file name at most 100 characters.
- New commands (main windows only; declare in `src-tauri/build.rs`, register in `lib.rs` `generate_handler!`, grant `allow-<kebab>` only in `src-tauri/capabilities/default.json`): `folder_open_dialog`, `folder_browse`, `folder_remove`, `folder_list`, `folder_set_expanded`, `folder_open_file`, `draft_discard`, `draft_save_to_notes`. Each starts with `require_main(window.label())?`. A command that opens a native dialog stays a sync command like `file_open_dialog`.
- New event: `folder-changed` with payload `{ path }`, sent with `crate::main_window::emit_all`; the page listens with `listenHere` (`src/window-events.js`).
- `files.json` window entry: `{ open, active, frame, folders: [canonical root], expanded: [canonical folder] }`, new fields `#[serde(default)]`.
- New MCP tool `push_draft` (write tool, off until selected). Exact description and copy in Task 8.
- Copy (exact): section heading "Folders"; menu items "Open Folder…" (Cmd+Shift+O / Ctrl+Shift+O), "Show Folder in Sidebar"; start link "Open Folder…"; root remove button label "Remove <name> from the sidebar"; truncated note "Some items are not shown."; missing root "Folder not found"; draft tag "Draft"; draft bar "Draft from an agent. It stays in Sodilaud until you save it." with "Save As…", "Save to Quick Notes", "Discard"; discard dialog "Discard the draft <name>? This cannot be undone."; start page section "Drafts".
- JS tests, from the worktree root, always in this guarded form: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test <files>`. Never run node tests uncapped.
- Never pass DOM nodes to `assert.equal`, `assert.deepEqual`, `assert.strictEqual` or their `not` forms (a failing one serialized jsdom and exploded memory to 150 GB). Compare nodes with `assert.ok(a === b)`; compare text, attributes and booleans with `assert.equal`.
- Rust tests: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked <filter>` from the worktree root. The 4 MCP socket tests fail only inside the sandbox; that is expected. No new crates.
- Linux CI: anything keyboard or platform dependent gets a test file that boots with `platform: "Linux x86_64"` (CodeMirror picks Cmd or Ctrl once per process, so Linux tests live in their own file).
- Never `cd` into `src/vendor` or `node_modules`. New JS source files go into `check:js` in `package.json`. Zero network egress, CSP unchanged, vendored assets only.
- No em dashes anywhere (use `-`). No mention of AI, Claude, coding assistants or sessions in commits, docs or PR text (the product's MCP "agent" wording is fine). Commits `type(scope): description`. Comments only where the why is non-obvious. Do not edit `RELEASE_NOTES.md`.

## Review Focus

1. A path that leaves a root through `..` or a symbolic link must never be listed or granted: Task 3 tests `folder_list`/`folder_open_file` refusals with a symlink out of the root.
2. A huge folder (`~/Downloads`-sized) must not freeze the app: Task 1 tests that reading stops at `SCAN_LIMIT` and sets `truncated`.
3. A draft must not be lost when its window closes or the app quits: Task 8 tests that drafts on disk are listed and granted again by `Files` at load; Task 9 tests that closing a draft buffer keeps it on the start page.
4. Plain files must not be reformatted by Markdown keys: Task 7 tests that Enter after `- a` in a `.txt` inserts only a newline and Tab in a `.tsv` inserts `\t`.
5. Quick Notes find, split and compare must not regress through the extraction: Tasks 10 and 13 run the existing Quick Notes tests unchanged.

## File structure

```
src-tauri/src/files/ignore.rs     NEW  gitignore matcher (pure)
src-tauri/src/files/folders.rs    NEW  one-level listing, filter, FolderWatcher
src-tauri/src/files/drafts.rs     NEW  draft store in app data
src-tauri/src/files/windows.rs    per-window folders and expanded
src-tauri/src/files/store.rs      SavedWindow.folders/expanded
src-tauri/src/files/mod.rs        TEXT_EXTENSIONS, root checks, folder watcher, draft dir
src-tauri/src/files/commands.rs   folder_* / draft_* commands, file_lists, draft flag
src-tauri/src/docs/files.rs       FileOpened.draft
src-tauri/src/mcp.rs              push_draft
src-tauri/src/cli.rs, src-tauri/tauri.conf.json, src-tauri/build.rs, src-tauri/src/lib.rs, src-tauri/capabilities/default.json
src/folder-tree.js                NEW  pure tree model
src/folder-sidebar.js             NEW  Folders section UI
src/find-bar.js                   NEW  shared find and replace
src/pane-compare.js               NEW  shared compare controller
src/file-split.js                 NEW  right pane of the file editor
src/files.js, src/editor-view.js, src/editor-live-preview.js, src/editor-commands.js, src/editor-folds.js
src/file-editor.js, src/app.js, src/index.html, src/app.css, src/notes.js, src/agent-access.js, src/markdown.js
test/folder-tree.test.js, test/folders-sidebar.test.js, test/plain-files.test.js, test/plain-files-linux.test.js,
test/drafts.test.js, test/find-bar-files.test.js, test/find-bar-files-linux.test.js, test/file-split.test.js, test/file-compare.test.js
docs/files.md, docs/mcp.md, README.md, ROADMAP.md
```

---

### Task 1: Gitignore matcher and one-level folder listing (Rust, pure)

**Files:**
- Create: `src-tauri/src/files/ignore.rs`, `src-tauri/src/files/folders.rs`
- Modify: `src-tauri/src/files/mod.rs` (add `pub mod ignore; pub mod folders;`, and replace the extension list in `is_text_file` with a `pub const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "csv", "tsv"];` used by it)
- Test: unit tests inside both new files

**Interfaces:**
- Consumes: nothing new.
- Produces (`files::ignore`):
  ```rust
  pub struct IgnoreSet { /* patterns with their base folder, in order */ }
  impl IgnoreSet {
      /// `.gitignore` files from the git top (nearest ancestor of `root`, root included, containing `.git`)
      /// or from `root` when there is none, down to `folder` (inclusive). Missing files are skipped.
      pub fn for_folder(root: &Path, folder: &Path) -> IgnoreSet;
      /// Parses one `.gitignore` whose folder is `base`.
      pub fn add(&mut self, base: &Path, contents: &str);
      /// `path` is absolute; `is_dir` says whether it is a folder. Later patterns win; a folder ignored
      /// on the way down from the git top ignores everything below it.
      pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool;
  }
  ```
- Produces (`files::folders`):
  ```rust
  pub const LIST_LIMIT: usize = 2000;
  pub const SCAN_LIMIT: usize = 20000;
  #[derive(Serialize, Clone, Debug, PartialEq, Eq)] #[serde(rename_all = "lowercase")]
  pub enum EntryKind { Folder, File }
  #[derive(Serialize, Clone, Debug, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct FolderEntry { pub name: String, pub path: String, pub kind: EntryKind }
  #[derive(Serialize, Clone, Debug, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct FolderListing { pub path: String, pub entries: Vec<FolderEntry>, pub truncated: bool }
  /// `root` and `folder` are canonical; `folder` is `root` or below it.
  pub fn list(root: &Path, folder: &Path) -> Result<FolderListing, FileError>;
  /// Whether `path` (canonical) would be shown by `list` of its parent: under `root`, no component
  /// below `root` hidden or `node_modules`, a shown file type, not ignored.
  pub fn is_listed(root: &Path, path: &Path) -> bool;
  ```
  Filter: skip names starting with `.`, skip `node_modules`, skip ignored entries, files only with a `TEXT_EXTENSIONS` extension; a symbolic link is followed (`fs::metadata`) and kept only when its canonical target starts with `root`; entry `path` is `folder.join(name)` as a string. Order: folders, then files; each by `name.to_lowercase()`, then `name`. Stop reading after `SCAN_LIMIT` directory entries and return at most `LIST_LIMIT`; either sets `truncated`. A missing `folder` returns `FileError::not_found`.

- [ ] **Step 1: Write failing tests in `ignore.rs`**

Use a scratch-folder helper like the one in `files/grants.rs` tests. Each test builds an `IgnoreSet` with `add(base, contents)` unless it names `for_folder`.
```rust
#[test] fn a_plain_name_matches_at_any_depth()            // "build" ignores /r/build and /r/a/build (dir) and /r/a/build (file)
#[test] fn a_trailing_slash_matches_folders_only()        // "out/" ignores dir /r/out, not file /r/out
#[test] fn a_leading_or_middle_slash_anchors_to_the_base() // "/top.md" ignores /r/top.md not /r/a/top.md; "docs/gen" ignores /r/docs/gen only
#[test] fn wildcards_and_classes()                         // "*.tmp.md", "draft?.md", "[ab].md", "[!c].md"
#[test] fn double_star_forms()                             // "**/cache", "logs/**", "a/**/b.md"
#[test] fn negation_reincludes_unless_a_parent_folder_is_ignored() // "*.md" + "!keep.md" keeps keep.md; "gen/" + "!gen/keep.md" still ignores it
#[test] fn comments_blank_lines_escapes_and_trailing_spaces()      // "# x", "", "\\#hash.md", "\\!bang.md", "name.md   "
#[test] fn the_git_top_gitignore_applies_to_a_subfolder_root()     // repo/.git, repo/.gitignore "*.log.md"; for_folder(repo/docs, repo/docs) ignores repo/docs/a.log.md
#[test] fn without_git_only_files_from_the_root_down_apply()       // parent/.gitignore "*.md" is not read for root parent/r
```

- [ ] **Step 2: Write failing tests in `folders.rs`**

```rust
#[test] fn lists_folders_then_shown_files_by_name()        // dirs B, a; files c.MD, b.txt, x.csv, y.tsv, z.markdown, img.png -> ["a","B","b.txt","c.MD","x.csv","y.tsv","z.markdown"], kinds folder,folder,file...
#[test] fn hides_dot_entries_node_modules_and_ignored()     // .hidden.md, .git/, node_modules/, ignored.md via .gitignore -> none listed; empty folder "empty" listed
#[test] fn a_symbolic_link_out_of_the_root_is_not_listed()  // #[cfg(unix)] link.md -> outside file, linkdir -> outside dir: absent; inner.md -> r/a.md: listed
#[test] fn a_huge_folder_stops_reading_and_says_so()        // 2001 files "f{i}.md": entries.len() == LIST_LIMIT, truncated == true; 3 files: truncated == false
#[test] fn is_listed_matches_the_listing_filter()           // true for r/a/b.md; false for r/.x/b.md, r/node_modules/b.md, r/ignored.md, r/p.png, outside path
#[test] fn a_missing_folder_is_not_found()                  // list(root, root.join("gone")) -> code NotFound
```
For the `SCAN_LIMIT` path, add a unit test of a private `fn collect(entries: impl Iterator<Item = ...>, ...)` only if `list` is structured that way; otherwise the `LIST_LIMIT` test above is enough.

- [ ] **Step 3: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files::ignore files::folders`
Expected: compile errors for the missing items.

- [ ] **Step 4: Implement both modules**

Glob matching: translate each pattern segment into a small matcher (no regex crate): `*` matches within one path component, `?` one character, `[...]` a class with ranges and `!`/`^` negation, `**` whole components. Match against the path relative to the pattern's base, `/`-separated.

- [ ] **Step 5: Run tests to verify they pass**

Run the Step 3 command, then `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files::`. Expected: PASS (existing `agent_document` tests still pass; `.csv` is now accepted by `agent_document`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/files
git commit -m "feat(folders): list one folder level with gitignore and type filters"
```

---

### Task 2: Per-window folders, expansion and the folder watcher (Rust, pure)

**Files:**
- Modify: `src-tauri/src/files/windows.rs`, `src-tauri/src/files/store.rs`, `src-tauri/src/files/folders.rs` (add `FolderWatcher`), `src-tauri/src/main_window.rs` (only the `saved(...)` test helper if a struct literal needs the new fields)
- Test: unit tests in `windows.rs`, `store.rs`, `folders.rs`

**Interfaces:**
- Consumes: Task 1 `folders::list`, `FolderListing`.
- Produces (`files::store`): `SavedWindow` gains `#[serde(default)] pub folders: Vec<String>` and `#[serde(default)] pub expanded: Vec<String>`.
- Produces (`files::windows`): `WindowEntry` gains `pub folders: Vec<String>`, `pub expanded: Vec<String>`; `from_saved` and `saved` carry them; `add` starts them empty.
  ```rust
  impl WindowSet {
      /// Appends `root` (canonical) and expands it; false when the window is unknown or already has it.
      pub fn add_folder(&mut self, label: &str, root: &str) -> bool;
      /// Removes the root and every expanded path under it.
      pub fn remove_folder(&mut self, label: &str, root: &str);
      pub fn folders(&self, label: &str) -> Vec<String>;
      /// Keeps only paths equal to or below one of the window's roots (component-wise prefix), without duplicates, in the given order.
      pub fn set_expanded(&mut self, label: &str, paths: Vec<String>);
      /// Roots then expanded folders of every window, window order, without duplicates, at most `limit`.
      pub fn watched_folders(&self, limit: usize) -> Vec<String>;
  }
  ```
  `fold_into_target` also appends the removed window's roots and expanded paths to the target (no duplicates).
- Produces (`files::folders`):
  ```rust
  pub const FOLDER_WATCH_LIMIT: usize = 128;
  #[derive(Default)] pub struct FolderWatcher { /* per folder: root, last mtime, last listing */ }
  impl FolderWatcher {
      /// Watches exactly `folders` ((root, folder) pairs), keeping state of those already watched.
      pub fn set(&mut self, folders: Vec<(PathBuf, PathBuf)>);
      /// Folders whose visible listing changed since the last poll; each change reported once.
      pub fn poll(&mut self) -> Vec<String>;
  }
  ```
  A folder whose mtime is unchanged is not relisted. A folder that disappears is reported once.

- [ ] **Step 1: Write failing tests**

`windows.rs`:
```rust
#[test] fn each_window_keeps_its_own_folders()           // add_folder("main", "/r"), add_folder("main-2", "/r") both true; again on main false; folders("main") == ["/r"]; entry("main").expanded == ["/r"]
#[test] fn expanded_folders_must_lie_in_a_root()          // set_expanded("main", ["/r/a", "/elsewhere", "/r/a", "/rx"]) -> ["/r/a"] ("/rx" is not under "/r")
#[test] fn removing_a_root_drops_its_expanded_folders()   // expanded ["/r", "/r/a", "/s"] with roots /r, /s; remove_folder("/r") -> folders ["/s"], expanded ["/s"]
#[test] fn watched_folders_are_the_union_capped()         // two windows sharing /r; limit 2 -> ["/r", "/r/a"]
#[test] fn a_failed_window_hands_its_folders_on()         // fold_into_target("main-2") -> main has main-2's roots appended
#[test] fn folders_survive_saving()                       // saved()[0].folders and .expanded equal the entry's
```
`store.rs`:
```rust
#[test] fn a_window_without_folders_loads_with_none()     // raw {"windows":[{"open":["/a.md"]}]} -> folders and expanded empty
```
`folders.rs`:
```rust
#[test] fn the_folder_watcher_reports_a_visible_change_once()   // set([(r, r)]); poll empty; write r/new.md; poll == [r]; poll empty
#[test] fn an_invisible_change_is_not_reported()                // write r/.hidden.md and r/p.png -> poll empty (mtime changed, listing same)
#[test] fn a_removed_folder_is_reported_once()
```
For the mtime tests, bump the folder's mtime explicitly with `File::set_modified` on a fresh handle if needed, as `watch.rs` tests do, so they are not timing dependent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files::`
Expected: compile errors for the missing items.

- [ ] **Step 3: Implement**

Prefix test for "below a root": `Path::new(p).starts_with(root)` (component-wise), never string `starts_with`.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked main_window`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(folders): per-window folder roots, expansion and folder watcher"
```

---

### Task 3: Folder commands, watching and the folder-changed event (Rust)

**Files:**
- Modify: `src-tauri/src/files/mod.rs`, `src-tauri/src/files/commands.rs`, `src-tauri/src/lib.rs` (`generate_handler!`), `src-tauri/build.rs`, `src-tauri/capabilities/default.json`
- Test: unit tests in `files/mod.rs`; `test/command-permissions.test.js` (runs unchanged; it checks every registered command is declared and granted)

**Interfaces:**
- Consumes: Task 1 `folders::{list, is_listed, FolderListing}`, Task 2 `WindowSet` folder methods, `FolderWatcher`, `FOLDER_WATCH_LIMIT`.
- Produces (`files`):
  ```rust
  pub const FOLDER_EVENT: &str = "folder-changed";
  #[derive(Serialize, Clone, Debug, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct FolderRoot { pub path: String, pub name: String }
  impl FileError { pub fn not_in_folder(path: &Path) -> Self; } // code NotGranted, "<name> is not in a folder shown in this window."
  impl Files {
      /// The canonical `path` and the root of `label`'s that contains it (the longest such root).
      pub fn in_folder(&self, label: &str, path: &str) -> Result<(PathBuf, PathBuf), FileError>; // (root, canonical)
  }
  ```
  `Files` holds `folder_watcher: Mutex<FolderWatcher>`; `Files::update` also sets it from `lists.windows.watched_folders(FOLDER_WATCH_LIMIT)` (each paired with its containing root). The poll thread in `files::start` calls `folder_watcher.poll()` after the file poll and, on the main thread, `crate::main_window::emit_all(&app, FOLDER_EVENT, json!({ "path": path }))` for each.
- Produces (commands in `files/commands.rs`):
  ```rust
  #[tauri::command] pub fn folder_open_dialog(window: Window, files: State<'_, Files>) -> Result<Option<FolderRoot>, FileError>; // rfd::FileDialog::new().set_title("Open Folder").pick_folder()
  #[tauri::command] pub fn folder_browse(window: Window, files: State<'_, Files>, path: String) -> Result<FolderRoot, FileError>;   // require granted + owner == this window, root = parent
  #[tauri::command] pub fn folder_remove(window: Window, files: State<'_, Files>, path: String) -> Result<(), FileError>;
  #[tauri::command] pub fn folder_list(window: Window, files: State<'_, Files>, path: String) -> Result<FolderListing, FileError>;
  #[tauri::command] pub fn folder_set_expanded(window: Window, files: State<'_, Files>, paths: Vec<String>) -> Result<(), FileError>;
  #[tauri::command] pub fn folder_open_file(window: Window, files: State<'_, Files>, path: String) -> Result<OpenedDocument, FileError>; // in_folder + is_listed + agent_document rules + grant
  ```
  `file_lists` (`ListsView`) gains `folders: Vec<FolderRoot>` and `expanded: Vec<String>` for the calling window. `folder_browse` of a file not owned by this window returns `FileError::not_open`. Adding a root that the window already has returns the existing `FolderRoot` (no error).

- [ ] **Step 1: Write failing tests in `files/mod.rs`**

Build `Files::for_test()`, add roots with `files.update(|l| l.windows.add_folder("main", root))`, and test the containment helper the commands use:
```rust
#[test] fn a_path_in_a_root_of_this_window_is_accepted()       // in_folder("main", r/a/b.md) == Ok((r, r/a/b.md)); nested roots: longest wins
#[test] fn a_path_outside_or_in_another_windows_root_is_refused() // r2 only in main-2 -> NotGranted for main; "/r/../secret.md" -> NotGranted
#[test] fn a_symbolic_link_out_of_a_root_is_refused()          // #[cfg(unix)] r/escape -> outside dir; in_folder(r/escape/x.md) NotGranted
#[test] fn updating_the_lists_watches_roots_and_expanded_folders() // after add_folder, the folder watcher watches r (expose a #[cfg(test)] fn watched_folders(&self) -> Vec<String>)
```
Plus one test for the opening rule as a plain function `pub(crate) fn folder_file(files: &Files, label: &str, path: &str) -> Result<OpenedDocument, FileError>` that `folder_open_file` wraps: listed `.md` is granted (afterwards `files.require(path)` is Ok); `r/ignored.md` (in `.gitignore`), `r/.x.md` and `r/p.png` are refused with `NotGranted`/`Unsupported`, and `require` stays refused.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files::`
Expected: compile errors.

- [ ] **Step 3: Implement the helpers, commands, poll and registration**

Declare the six commands in `build.rs`, add them to `generate_handler!`, and add `allow-folder-open-dialog`, `allow-folder-browse`, `allow-folder-remove`, `allow-folder-list`, `allow-folder-set-expanded`, `allow-folder-open-file` to `capabilities/default.json` only.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command, then `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/command-permissions.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri test
git commit -m "feat(folders): folder commands for main windows and live folder updates"
```

---

### Task 4: Folder tree model (JS, pure)

**Files:**
- Create: `src/folder-tree.js`, `test/folder-tree.test.js`
- Modify: `package.json` (`check:js`: add `node --check src/folder-tree.js`)

**Interfaces:**
- Consumes: the `FolderListing` shape `{ path, entries: [{ name, path, kind: "folder" | "file" }], truncated }` and `FolderRoot { path, name }` from Rust.
- Produces:
  ```js
  export function createFolderTree() -> {
    setRoots(roots),               // [{ path, name }], sidebar order; drops cache and expansion outside them
    roots(),
    addRoot(root),                  // appends unless present; expands it
    removeRoot(path),
    setListing(listing),            // caches children of listing.path
    setMissing(path),               // a root or folder that could not be listed ("Folder not found" row state)
    forget(path),                   // drops the cached children of path and below
    isExpanded(path), expand(path), collapse(path),  // collapse also collapses below
    expanded(),                     // every expanded path, roots first, then depth-first visible order
    needsListing(),                 // expanded paths that are visible and have no cached children
    rows(),                         // visible rows, depth-first:
      // { path, name, kind: "root" | "folder" | "file", level (1 for roots), expanded, missing, truncatedNote: false }
      // after the children of a truncated listing: { path: `${listing.path}#more`, kind: "note", level, name: "Some items are not shown." }
    move(path, key)                 // key "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Home" | "End" -> { focus: path } or { expand: path } or { collapse: path }
  }
  ```
  `move` rules: Down/Up go to the next/previous row (notes are skipped); Right on a collapsed root/folder -> `{ expand }`, on an expanded one -> first child; Left on an expanded root/folder -> `{ collapse }`, otherwise -> its parent row; Home/End -> first/last row.

- [ ] **Step 1: Write the failing tests**

```js
test("rows list roots, then the children of expanded folders depth first")   // rows().map(r => `${r.level}:${r.kind}:${r.name}`)
test("a collapsed folder hides its children but keeps its cache")
test("needsListing names visible expanded folders without children")         // after expand of an uncached folder; not for one under a collapsed parent
test("a truncated listing ends with a note row")
test("keyboard moves follow the tree pattern")                                 // each rule above, assert.deepEqual on plain objects
test("removing a root drops its rows and its expanded paths")
test("expanded() is roots first, then visible order")
```
All values compared are strings, numbers, booleans or plain objects.

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/folder-tree.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/folder-tree.js`**

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command, then `npm run check:js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/folder-tree.js test/folder-tree.test.js package.json
git commit -m "feat(folders): folder tree model"
```

---

### Task 5: Folders section in the main window sidebar

**Files:**
- Create: `src/folder-sidebar.js`, `test/folders-sidebar.test.js`, `test/folders-sidebar-linux.test.js`
- Modify: `src/index.html`, `src/file-editor.js`, `src/app.js`, `src/app.css`, `package.json` (`check:js`)
- Test: `test/folders-sidebar.test.js`; regression `test/file-editor.test.js`, `test/accessibility.test.js`, `test/help-menu.test.js`, `test/help-platform-labels.test.js`

**Interfaces:**
- Consumes: Task 3 commands and `file_lists` fields `folders`, `expanded`; Task 4 `createFolderTree`; event `folder-changed { path }`.
- Produces (markup in `src/index.html`, inside `#files-sidebar` between `#open-files-list` and `#outline-section`):
  ```html
  <section class="folders-section" id="folders-section" aria-labelledby="folders-title" hidden>
    <h2 class="files-sidebar-title" id="folders-title">Folders</h2>
    <ul class="folder-tree" id="folder-tree" role="tree" aria-labelledby="folders-title"></ul>
  </section>
  ```
  File menu (after `#menu-open-file-btn`): `<button class="dropdown-item" id="menu-open-folder-btn" title="Open Folder (Cmd+Shift+O)">Open Folder…</button>` and `<button class="dropdown-item" id="menu-browse-folder-btn" disabled>Show Folder in Sidebar</button>`. Start page `#start-actions`: `<button class="start-link" id="start-open-folder-btn" type="button">Open Folder…</button>`. Help "Files (this window)": a row "Open Folder" with `Cmd` `+` `Shift` `+` `O` (the existing platform-label mechanism shows Ctrl off macOS).
- Produces (`src/folder-sidebar.js`):
  ```js
  export function createFolderSidebar({ document, invoke, openPath, notify, onChange }) -> {
    restore(lists),          // lists.folders, lists.expanded -> list roots and visible expanded folders, top-down
    openFolderDialog(),      // folder_open_dialog -> addRoot -> list
    browseFolder(path),      // folder_browse({ path }) -> addRoot -> list
    folderChanged(payload),  // relist payload.path if it is a visible expanded folder, else tree.forget(path)
    setActivePath(path),     // marks the matching file row .active / aria-selected
    hasRoots()
  }
  ```
  Rows: `<li role="treeitem" aria-level aria-expanded(folders/roots only) data-path class="folder-row folder-row-<kind>">` with a name button; root rows add `<button class="folder-remove" aria-label="Remove <name> from the sidebar" title="Remove from sidebar">×</button>` that calls `folder_remove` then removes the root. One row is in the tab order (roving `tabindex`); keydown on the tree applies `tree.move`, plus Enter/Space opening a file or toggling a folder. Every expand/collapse/remove ends with `folder_set_expanded({ paths: tree.expanded() })`. A file row click: `invoke("folder_open_file", { path })` then `openPath(result.path)`; errors go to `notify(error.message)`. `onChange()` after every render, so the file editor can re-evaluate the sidebar.
- Produces (`file-editor.js`): creates the folder sidebar in `createFileEditor`; `renderSidebar` shows `#files-sidebar` when `model.list().length > 0 || folders.hasRoots()` (and not toggled off); `#toggle-files-sidebar` follows the same rule, as does `toggleSidebar`; `#folders-section` hidden without roots; `render()` calls `folders.setActivePath(active path)`; `#menu-browse-folder-btn` enabled when the shown buffer has a path and is not a draft (`buffer.draft !== true`; Task 9 sets the flag); `restore()` passes the `file_lists` result to `folders.restore`; new API members `openFolderDialog`, `browseFolder()` (shown file), `folderChanged(payload)`. `handleShortcut`: Cmd+Shift+O (Ctrl+Shift+O off macOS; `key.toLowerCase() === "o"` with `shiftKey`) -> `openFolderDialog`.
- Produces (`app.js`): `listen("folder-changed", ({ payload }) => fileEditor.folderChanged(payload))` in `registerNativeHandlers`; menu and start buttons wired with `closeMenus`.

- [ ] **Step 1: Write the failing tests in `test/folders-sidebar.test.js`**

Boot `bootMainWindow({ platform: "MacIntel", instance: N, disk, handlers })` (one `instance` per test). Handlers stub `qn_get_config`, `file_lists`, `file_set_open`, `file_take_pending` as in `test/file-editor.test.js`'s `lists()` helper, plus fake folder commands backed by a plain object `{ "/r": [...entries], "/r/docs": [...] }` that record their arguments.
```js
test("Open Folder adds a root, lists it and shows the sidebar with no file open")   // click menu-open-folder-btn; #files-sidebar hidden false; tree row texts
test("expanding a folder lists it once and reports the expanded set")               // click a folder row twice-open/close: one folder_list for /r/docs; last folder_set_expanded paths deepEqual ["/r", "/r/docs"] then ["/r"]
test("a file in the tree opens through folder_open_file")                           // click row /r/a.md -> folder_open_file({ path }) then file_doc_open; row has class active
test("folder-changed relists a visible folder and only that one")                   // emit("folder-changed", { path: "/r" }) -> exactly one more folder_list({ path: "/r" }); new row appears
test("removing a root calls folder_remove and hides the section")
test("roots and expanded folders come back from file_lists")                        // file_lists returns folders [{path:"/r",name:"r"}], expanded ["/r","/r/docs"]: folder_list for /r then /r/docs
test("Show Folder in Sidebar roots the shown file's folder")                        // open /r/a.md via file_lists open; click menu-browse-folder-btn -> folder_browse({ path: "/r/a.md" })
test("arrow keys move through the tree and Right expands")                          // keydown on the focused row; document.activeElement?.closest("li")?.dataset.path equals expected string
test("Cmd+Shift+O opens the folder dialog")
test("a root that cannot be listed shows Folder not found")                          // folder_list throws { code: "NotFound" }
```
Compare `dataset.path`, `textContent`, `hidden` and attribute strings only; never DOM nodes in `assert.equal`/`deepEqual`.

In `test/folders-sidebar-linux.test.js` (platform `Linux x86_64`): Ctrl+Shift+O opens the dialog; Cmd(meta)+Shift+O does not; the help row shows `Ctrl`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/folders-sidebar.test.js test/folders-sidebar-linux.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

CSS in `src/app.css`: indentation by `--level` (`padding-inline-start: calc(var(--level) * 12px)`), a disclosure caret for folders, the existing `.open-file-item` hover/active colors for rows, theme tokens only.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `test/file-editor.test.js test/accessibility.test.js test/help-menu.test.js test/help-platform-labels.test.js test/new-window.test.js` in the same guarded form, then `npm run check:js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json
git commit -m "feat(folders): Folders section with Open Folder and Show Folder in Sidebar"
```

---

### Task 6: `.csv` and `.tsv` accepted everywhere a text type is

**Files:**
- Modify: `src-tauri/src/files/commands.rs` (use `super::TEXT_EXTENSIONS` for the Open filter; Save As filters), `src-tauri/src/files/mod.rs` (`FileError::not_text` message), `src-tauri/src/cli.rs` (script `case`, usage and error text), `src-tauri/src/mcp.rs` (`OpenDocumentArgs.path` doc comment and the `open_document` description), `src-tauri/tauri.conf.json` (`fileAssociations`), `src/markdown.js` (`SIBLING_EXTENSION`)
- Test: unit tests in `files/mod.rs`, `files/commands.rs`, `cli.rs`; `test/markdown.test.js` or `test/file-links.test.js` (one case); `test/release-manifest.test.js` only if it reads associations

**Interfaces:**
- Consumes: Task 1 `files::TEXT_EXTENSIONS` (already includes `csv`, `tsv`).
- Produces:
  - `FileError::not_text` message: "<name> is not a Markdown or text file. Sodilaud opens .md, .markdown, .txt, .csv and .tsv files."
  - `pub(crate) fn save_filters(suggested_name: &str) -> Vec<(&'static str, &'static [&'static str])>` in `files/commands.rs`: `[("Markdown", ["md"]), ("Text", ["txt"]), ("CSV", ["csv"]), ("TSV", ["tsv"])]` with the entry matching the suggested name's extension (case-insensitive; `markdown` counts as Markdown) moved first. `file_save_as_dialog` adds them in that order.
  - The `sodilaud` script accepts `*.[Cc][Ss][Vv]|*.[Tt][Ss][Vv]` too; its usage line and refusal text list the five types.
  - `tauri.conf.json` `fileAssociations` gains `{ "ext": ["csv"], "name": "CSV document", "role": "Editor", "mimeType": "text/csv" }` and `{ "ext": ["tsv"], "name": "TSV document", "role": "Editor", "mimeType": "text/tab-separated-values" }`.
  - `SIBLING_EXTENSION = /\.(md|markdown|txt|csv|tsv)$/i`.
  - `open_document` text: ".md, .markdown, .txt, .csv or .tsv".

- [ ] **Step 1: Write failing tests**

```rust
// files/mod.rs
#[test] fn csv_and_tsv_files_are_text_files()            // agent_document of data.CSV and t.tsv is Ok; paths_from_args keeps /a.csv
// files/commands.rs
#[test] fn save_as_offers_the_files_own_type_first()      // save_filters("data.csv")[0].0 == "CSV"; ("t.TSV") -> "TSV"; ("notes.markdown") -> "Markdown"; ("x") -> "Markdown"; len 4
// cli.rs: extend the existing script test that runs the generated script on sample paths so a.csv and b.tsv are accepted and c.json is refused
```
JS: in `test/file-links.test.js` (or `test/markdown.test.js`, whichever tests `resolveLinkAction`), assert `resolveLinkAction("data.csv").kind === "sibling"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files:: cli::` and `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-links.test.js test/markdown.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 commands, plus `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked mcp::tests::open_document` and `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/release-manifest.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri src test
git commit -m "feat(files): open .csv and .tsv files and associate them in Finder"
```

---

### Task 7: Plain text files (`.txt`, `.csv`, `.tsv`) without Markdown behavior

**Files:**
- Create: `test/plain-files.test.js`, `test/plain-files-linux.test.js`
- Modify: `src/files.js`, `src/editor-view.js`, `src/editor-live-preview.js`, `src/editor-commands.js`, `src/editor-folds.js`, `src/file-editor.js`, `src/app.css`
- Test: the two new files; regression `test/file-editor.test.js`, `test/editor-view.test.js`, `test/editor-live-preview.test.js`, `test/editor-smart-integration.test.js`, `test/outline.test.js`, `test/files-model.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (the Rust side already opens `.csv`/`.tsv` after Task 6; tests use the fake file docs).
- Produces (`src/files.js`):
  ```js
  export function fileKind(name) -> "plain" | "markdown"   // /\.(txt|csv|tsv)$/i -> "plain"
  // every buffer has `kind`; createBuffer, fromOpened and adopt set it from `name`
  ```
- Produces (`src/editor-view.js`):
  ```js
  export const plainTextFacet = Facet.define({ combine: values => values.some(Boolean) });
  // createMarkdownEditor: option `plainText = false`; a `plainCompartment` holding plainTextFacet.of(plain);
  // the highlight compartment uses `syntaxHighlighting && !plain`; restoreState reconfigures it with the others.
  editor.setPlainText(enabled)   // reconfigures plain + highlight compartments
  editor.isPlainText()
  ```
- Consumers of the facet: `editor-live-preview.js` `isLive` is false when the facet is set (no decorations, no widgets); `editor-commands.js` `keydown` returns false for everything except Tab without modifiers, which inserts `"\t"` at the selection (replacing it) as a user input, and `paste` returns false; `editor-folds.js` `sectionFolding` offers no folds when the facet is set.
- Produces (`file-editor.js`): after `loadBuffer`/`restoreState` of the shown buffer, `editor.setPlainText(buffer.kind === "plain")`; for plain buffers `renderPreview` writes `<pre class="plain-text-preview">` with `textContent` = the text (no `renderMarkdown`, no hunks, no mermaid), the format toolbar is disabled (`formatToolbar.setEnabled(false)`), and `renderOutline` produces no entries. Switching to a Markdown buffer restores the layout-mode rules.

- [ ] **Step 1: Write the failing tests**

`test/plain-files.test.js` (platform `MacIntel`, `disk` with `/d/a.txt` = `"# Title\n- a\n\nsee [x](y)\n"`, `/d/t.tsv` = `"a\tb\n"`, `/d/n.md` = `"# Title\n\nsee [x](y)\n"`, all in `file_lists` `open`):
```js
test("a .txt file shows its Markdown source without live decorations")   // Live mode, cursor on line 1: assert.ok(querySelector("#editor-host .cm-lp-link") === null) for a.txt; assert.ok(... !== null) for n.md
test("Enter after a list line in a .txt inserts only a newline")         // cursor at end of "- a", keydown Enter -> text "# Title\n- a\n\n" not "- a\n- "
test("Tab in a .tsv inserts a tab character")                             // keydown Tab -> editorText contains "a\tb\n\t" at the cursor position
test("Reading mode shows plain text as preformatted text")               // click mode-reading: #markdown-preview .plain-text-preview textContent === file text; no h1
test("the formatting toolbar is disabled and the outline empty for plain files")
test("switching back to a .md file restores live preview and the toolbar")
test("Save As to .md turns a plain buffer into Markdown")                // model.adopt with a new name: kind "markdown"
```
`test/plain-files-linux.test.js` (platform `Linux x86_64`): "Tab in a .tsv inserts a tab character" and "Ctrl+B does nothing in a plain file" (no `**` inserted).

Unit test in `test/files-model.test.js`: `fileKind("A.TXT") === "plain"`, `fileKind("x.csv")`, `fileKind("y.tsv")` plain, `fileKind("n.md")`, `fileKind("n.markdown")` markdown.

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/plain-files.test.js test/plain-files-linux.test.js test/files-model.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

Check how `Cmd+B` reaches formatting (`markdownFormattingKeymap` in `editor-commands.js`); it must also do nothing on a plain file.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `test/file-editor.test.js test/editor-view.test.js test/editor-live-preview.test.js test/editor-smart-integration.test.js test/editor-format-keys.test.js test/outline.test.js test/split-view.test.js` in the same guarded form. Expected: PASS (Quick Notes never sets the facet).

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(files): open .txt, .csv and .tsv as plain text"
```

---

### Task 8: Drafts in app data and the `push_draft` MCP tool (Rust)

**Files:**
- Create: `src-tauri/src/files/drafts.rs`
- Modify: `src-tauri/src/files/mod.rs` (`pub mod drafts;`, `Files` knows the drafts directory, launch grants, `open_draft_for_agent`), `src-tauri/src/files/commands.rs` (`file_doc_open` draft flag and no Recent for drafts, `file_lists.drafts`, `draft_discard`, `draft_save_to_notes`), `src-tauri/src/docs/files.rs` (`FileOpened` gains `#[serde(default)] pub draft: bool`, false in `opened`), `src-tauri/src/mcp.rs` (tool, `WRITE_TOOLS`, server instructions, tests), `src-tauri/build.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`
- Test: unit tests in `drafts.rs`, `files/mod.rs`, `mcp.rs`

**Interfaces:**
- Consumes: `Registry::agent_write(&self, operation: &str, args: &Value) -> Result<Value, String>` (`docs/agent.rs`), `registry.file_discard(&Path)`, `registry.file_flush_all`/`file_save` or the current text via `file_open(path, disk).text`, `registry.coedit_mark_file(&Path)`, `quicknotes::window::reveal(app, Focus::Id(id))`, `files::present_pending`.
- Produces (`files::drafts`, pure over a directory):
  ```rust
  pub const DIRECTORY: &str = "drafts";
  pub const META: &str = "draft.json";
  pub const TITLE_LIMIT: usize = 200;      // characters, after trimming
  pub const CONTENT_LIMIT: usize = 100_000; // UTF-8 bytes
  pub fn file_name(title: &str) -> String; // replaces / \ : * ? " < > | and control chars with '-', trims, <= 100 chars, "Draft" if empty, + ".md"
  #[derive(Serialize, Clone, Debug, PartialEq, Eq)] #[serde(rename_all = "camelCase")]
  pub struct Draft { pub path: String, pub name: String, pub created_at: u64 /* ms since epoch */ }
  pub enum Created { New(Draft), Existing(Draft) }
  pub fn create(dir: &Path, request_id: &str, title: &str, content: &str) -> Result<Created, String>;
  // writes <dir>/<uuid>/<file_name(title)> (owner-only via crate::restrict_to_owner) and draft.json { requestId, fingerprint, createdAt };
  // same requestId + same fingerprint (sha256 of title + "\0" + content) -> Existing; same requestId otherwise -> Err("requestId was already used with different arguments.")
  pub fn list(dir: &Path) -> Vec<Draft>;            // every <uuid>/ with exactly one .md file, newest first; a missing/damaged draft.json uses the file mtime
  pub fn is_draft(dir: &Path, path: &Path) -> bool; // canonical path is <dir>/<one folder>/<file>.md
  pub fn remove(dir: &Path, path: &Path) -> Result<(), String>; // removes that draft's folder; refuses non-drafts
  ```
- Produces (`files`): `Files` stores `drafts_dir: Option<PathBuf>` (`app_data_dir()/drafts`, set in `Files::load`), grants every `drafts::list` path at load, and exposes `pub fn is_draft(&self, path: &Path) -> bool`. `pub fn open_draft_for_agent(app: &AppHandle, request_id: &str, title: &str, content: &str) -> Result<OpenedDocument, FileError>` creates, grants, and presents it like `open_for_agent` (main-thread `present_pending`).
- Produces (commands):
  ```rust
  #[tauri::command] pub fn draft_discard(app: AppHandle, window: Window, files: State<'_, Files>, registry: State<'_, SharedRegistry>, path: String, ask: bool) -> Result<bool, FileError>;
  // non-draft -> FileError Unsupported "<name> is not a draft."; ask -> rfd MessageDialog OkCancel, title "Discard draft?", text "Discard the draft <name>? This cannot be undone."; Cancel -> Ok(false)
  // then registry.file_discard, drafts::remove, drop the path from every window's open list and from recent; Ok(true)
  #[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct SavedNote { note_id: String }
  #[tauri::command] pub fn draft_save_to_notes(app: AppHandle, window: Window, files: State<'_, Files>, registry: State<'_, SharedRegistry>, path: String) -> Result<SavedNote, FileError>;
  // text = the open document's current text (or the file on disk if not open); title = file stem; over CONTENT_LIMIT -> Unsupported
  // "This draft is larger than 100,000 bytes, which Quick Notes does not take. Save it as a file instead."
  // agent_write("push_quick_note", { requestId: "draft-<draft folder name>", title, content }) -> note id at result["note"]["id"];
  // reveal Quick Notes on the main thread with Focus::Id; then discard as draft_discard(ask: false)
  ```
  `file_doc_open` sets `opened.draft = files.is_draft(&path)` and skips `opened_recent` for drafts. `ListsView` gains `drafts: Vec<Draft>`.
- Produces (`mcp.rs`): `push_draft` added to `WRITE_TOOLS` (now 15 write tools, 23 tools in all).
  ```rust
  #[derive(Debug, Serialize, serde::Deserialize, schemars::JsonSchema)]
  #[serde(deny_unknown_fields, rename_all = "camelCase")]
  struct PushDraftArgs {
      /// Unique retry key (1-128 characters). Reuse with identical arguments on retry.
      request_id: String,
      /// Title, used as the draft's file name (1-200 characters after trimming).
      title: String,
      /// Markdown content, at most 100000 UTF-8 bytes. Defaults to empty.
      #[serde(default)]
      content: String,
  }
  ```
  Description (exact): "Put a Markdown draft in front of the user for review: it opens in Sodilaud's main window (the one used last) and is kept in Sodilaud until the user saves it as a file or to Quick Notes, or discards it. Use it for a document the user should read and maybe keep, when there is no file to write to. The draft is co-edited: follow up with read_document and apply_edit using the returned path. Retry identical arguments after a failure; a requestId is never applied twice." Annotations: title "Push draft", `read_only_hint = false`, `destructive_hint = false`, `idempotent_hint = true`, `open_world_hint = false`. On success: `registry.coedit_mark_file(path)`, result `OpenedDocument { path, name, bytes }`. Without an app (tests): validate, then return a tool error "Drafts need the Sodilaud app.".

- [ ] **Step 1: Write failing tests**

`drafts.rs`:
```rust
#[test] fn a_title_becomes_a_safe_file_name()        // "Plan: a/b" -> "Plan- a-b.md"; "   " -> "Draft.md"; 300 x "a" -> 100 chars + ".md"
#[test] fn creating_writes_the_text_and_meta()        // file text equals content; draft.json has requestId
#[test] fn a_repeated_request_returns_the_same_draft() // Existing with the same path
#[test] fn a_reused_request_id_with_other_text_is_refused()
#[test] fn drafts_are_listed_newest_first_and_survive_damaged_meta()
#[test] fn only_a_draft_can_be_removed()              // is_draft false for dir/x.md and for a path outside; remove refuses them
```
`files/mod.rs`:
```rust
#[test] fn drafts_on_disk_are_granted_at_load()       // a Files built by a #[cfg(test)] constructor taking a drafts dir with one draft: require(path) Ok, is_draft true
```
`mcp.rs` (helpers `server()`, `args::<T>`, `error_text`):
```rust
#[test] fn push_draft_is_off_until_selected_and_validates() // denied while off; then insert "push_draft": empty title, 201-char title, 100001-byte content, 129-char requestId -> invalid params; valid -> tool error "Drafts need the Sodilaud app."
```
Update `saved_permissions_restore_choices_and_default_new_tools` if it enumerates write tools, and the stdio relay test: `tools.len() == 23`, and add `push_draft` to the list of writes rejected while off.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked files:: mcp::`
Expected: compile errors / FAIL (socket tests may fail in the sandbox regardless).

- [ ] **Step 3: Implement, declare and grant**

Declare `draft_discard`, `draft_save_to_notes` in `build.rs`, register them, add `allow-draft-discard`, `allow-draft-save-to-notes` to `capabilities/default.json`. Add a sentence on `push_draft` to the server instructions in `get_info()` next to `push_quick_note`.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command, then `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/command-permissions.test.js`. Expected: PASS except the 4 MCP socket tests inside the sandbox.

- [ ] **Step 5: Commit**

```bash
git add src-tauri test
git commit -m "feat(mcp): push_draft keeps an agent's Markdown in app data until saved"
```

---

### Task 9: Drafts in the main window

**Files:**
- Create: `test/drafts.test.js`
- Modify: `src/files.js` (`buffer.draft` from `opened.draft`), `src/file-editor.js`, `src/index.html`, `src/app.css`, `src/agent-access.js`, `test/mcp-permissions.test.js`, `src-tauri/resources/claude/SKILL.md` (tool list lines that name the write tools)
- Test: `test/drafts.test.js`; regression `test/mcp-permissions.test.js`, `test/agent-access-main.test.js`, `test/agent-access-quicknotes.test.js`, `test/file-editor.test.js`, `test/start-page.test.js`

**Interfaces:**
- Consumes: Task 8 `FileOpened.draft`, `file_lists.drafts: [{ path, name, createdAt }]`, `draft_discard({ path, ask }) -> boolean`, `draft_save_to_notes({ path }) -> { noteId }`.
- Produces (markup):
  - In `#file-editor`, after `#file-banner`: `<div class="draft-bar" id="draft-bar" role="status" hidden><span class="draft-bar-text">Draft from an agent. It stays in Sodilaud until you save it.</span><button class="file-banner-btn" id="draft-save-as-btn" type="button">Save As…</button><button class="file-banner-btn" id="draft-save-notes-btn" type="button">Save to Quick Notes</button><button class="file-banner-btn" id="draft-discard-btn" type="button">Discard</button></div>`
  - Start page, after `#recent-files`: `<section class="start-section" id="drafts-section" aria-labelledby="drafts-title" hidden><h2 class="start-section-title" id="drafts-title">Drafts</h2><ul class="recent-list" id="drafts-list"></ul></section>`
  - Open files row of a draft: `<span class="open-file-tag">Draft</span>` after the name button.
- Produces (`file-editor.js`): `save(id)` on a draft is `saveAs(id)`; after a successful `saveAs` of a draft, `invoke("draft_discard", { path: previousPath, ask: false })` (failure logged, not shown); `saveDraftToNotes(id)`: `await sync.flush()`, `draft_save_to_notes`, then drop the buffer without `file_doc_close` (Rust discarded it), `syncOpenList`, `refreshLists`; `discardDraft(id)`: `draft_discard({ ask: true })`, on `true` drop the buffer the same way; `refreshRecent` also reads `drafts` and renders `#drafts-list` (button `.start-link` per draft opening `openPath(path)`, section hidden when empty). Dropping a buffer goes through one function `forget(id)` (`model.close(id, { force: true })`, clear `shownId`, show the start page when nothing is left), which `closeFile` uses too.
- Produces (`agent-access.js`): `WRITE_FUNCTIONS` gains `["push_draft", "Push draft", "Put Markdown into a main window for review, kept in Sodilaud until you save it."]` right after `open_document`.

- [ ] **Step 1: Write the failing tests in `test/drafts.test.js`**

Boot with the fake file docs; extend the `file_doc_open` handler result with `draft: true` for paths under `/data/drafts/` (wrap `app.fileDocs.commands` or use a `handlers.file_doc_open` that calls the fake and adds the flag).
```js
test("a draft opens with the Draft tag and the draft bar")                 // file_take_pending returns a draft path; #draft-bar hidden false; .open-file-tag text "Draft"
test("Cmd+S on a draft asks where to save it")                            // key meta+s -> file_save_as_dialog invoked, not file_doc_save
test("saving a draft as a file discards the draft")                        // Save As resolves { path: "/d/plan.md", ... }; then draft_discard({ path: draft, ask: false }); buffer now /d/plan.md, bar hidden
test("Save to Quick Notes sends the last keystrokes first and closes the draft") // type, click draft-save-notes-btn: last file_doc_push index < draft_save_to_notes index; no file_doc_close; sidebar empty
test("Discard asks and keeps the draft when cancelled")                    // draft_discard returns false -> still open; true -> gone
test("closing a draft keeps it on the start page")                         // closeFile -> file_doc_close; file_lists.drafts has it; #drafts-list text includes name; click reopens it
```
`test/mcp-permissions.test.js`: add `push_draft` to the hard-coded writes list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/drafts.test.js test/mcp-permissions.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`#menu-browse-folder-btn` (Task 5) stays disabled for drafts through `buffer.draft`.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `test/agent-access-main.test.js test/agent-access-quicknotes.test.js test/file-editor.test.js test/start-page.test.js test/folders-sidebar.test.js` in the same guarded form. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test src-tauri/resources
git commit -m "feat(files): review, save and discard drafts in the main window"
```

---

### Task 10: Extract the find bar from Quick Notes into `src/find-bar.js`

**Files:**
- Create: `src/find-bar.js`
- Modify: `src/notes.js` (find bar logic at about 2297-2534 and 2743-2803, its listeners at about 2032-2075 and the global keys at about 2107-2163, call sites in `loadActiveNote` ~830, `refreshOpenNoteViews` ~547, `applyWorkspaceState` ~486, `handleEditorInput` ~1475, `handleTitleInput` ~1514, `handleContextFind` ~3060), `package.json` (`check:js`)
- Test: existing `test/find.test.js`, `test/find-replace.test.js`, `test/find-results.test.js`, `test/accessibility.test.js`, `test/split-view.test.js` must pass unchanged

**Interfaces:**
- Consumes: `findTextMatches` (`src/find.js`); the editor API from `createMarkdownEditor` (`getText`, `getSelection`, `setSelection`, `applyEdit`, `setFindMatches`, `scrollToRange`, `focus`).
- Produces:
  ```js
  export function createFindBar({
    document,
    editor,                 // () => editor API (the pane to search)
    preview = () => null,   // () => element to highlight in Reading mode, or null
    isReading = () => false,
    notify = () => {},
    onUpdate = () => {}     // (state) after every search, selection or close: notes.js updates Find Results from it
  }) -> {
    attach(),               // wires the bar's own inputs and buttons (ids below)
    open({ replace = false } = {}), close(), isOpen(), toggleReplace(force),
    run({ preserveActive = false, selectActive = true } = {}),  // re-run after text or document changes
    next(), prev(), select(index, { focusEditor = false } = {}),
    replaceOne(), replaceAll(),
    handleKeydown(event) -> boolean,  // Alt+C, Alt+W, Alt+R while open, as notes.js does today
    state() -> { query, matches, activeIndex, invalidPattern, options: { useRegex, matchCase, exactMatch }, open, replaceOpen }
  }
  ```
  Element ids (both pages): `find-bar`, `find-input`, `find-count`, `find-prev`, `find-next`, `find-close`, `find-toggle-replace`, `replace-row`, `replace-input`, `replace-one-btn`, `replace-all-btn`, `find-case-toggle`, `find-exact-toggle`, `find-regex-toggle`. `find-results-toggle` is optional (looked up, may be null). Behavior and copy move as they are; `notes.js` keeps Find Results (`toggleFindResults`, `renderFindResults`, the "All notes" scope) and its Mod+F / Mod+H / Escape routing, now calling the module.

- [ ] **Step 1: Run the existing find tests to record the baseline**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/find.test.js test/find-replace.test.js test/find-results.test.js test/accessibility.test.js test/split-view.test.js`
Expected: PASS (this is the safety net; no test changes in this task).

- [ ] **Step 2: Move the code into `src/find-bar.js` and make `notes.js` use it**

Keep each replacement one undo step (`editor().applyEdit`) and the same notification text for Replace All.

- [ ] **Step 3: Run the Step 1 command and `npm run check:js`**

Expected: PASS, identical test names.

- [ ] **Step 4: Commit**

```bash
git add src/find-bar.js src/notes.js package.json
git commit -m "refactor(notes): move find and replace into a shared find bar module"
```

---

### Task 11: Find and replace in the file editor

**Files:**
- Create: `test/find-bar-files.test.js`, `test/find-bar-files-linux.test.js`
- Modify: `src/index.html` (the find bar markup inside `#editor-pane`, before `#editor-wrapper`, copied from `src/notes.html` 214-262 without `#find-results-toggle`; help rows), `src/file-editor.js`, `src/app.js` (Escape chain), `src/app.css` (only if the bar needs positioning in this layout)
- Test: the two new files; regression `test/file-editor.test.js`, `test/accessibility.test.js`, `test/help-platform-labels.test.js`

**Interfaces:**
- Consumes: Task 10 `createFindBar`.
- Produces (`file-editor.js`): one find bar per window: `editor: () => activeEditor()` (the left editor; Task 12 makes it the focused pane), `preview: () => preview`, `isReading: () => layoutMode === "reading"`, `notify`. `run({ preserveActive: true, selectActive: false })` after editor changes, remote updates of the shown file and buffer switches. `handleShortcut` handles, before its `altKey` early return: Cmd+F (Ctrl+F) -> `open()`; replace -> `open({ replace: true })` on macOS with `metaKey && altKey && !ctrlKey && !shiftKey && event.code === "KeyF"`, elsewhere `ctrlKey && !altKey && !metaKey && !shiftKey && key === "h"`; with the bar open, `findBar.handleKeydown(event)`. API gains `closeFind() -> boolean` (true when it closed an open bar), used by the Escape chain in `app.js` after menus and before other Escape handling. Find does nothing on the start page.
- Help rows in "Files (this window)": "Find" `Cmd` `+` `F`; "Find and Replace" as one key element `<kbd data-shortcut-off-mac="Ctrl+H">Cmd+Alt+F</kbd>` (`applyPlatformShortcutLabels` in `src/platform-labels.js` swaps the text off macOS).

- [ ] **Step 1: Write the failing tests**

`test/find-bar-files.test.js` (platform `MacIntel`, `/d/a.md` = `"one two one\n"` open):
```js
test("Cmd+F opens the find bar and counts matches in the file")      // type "one" into #find-input, input event: #find-count text "1 of 2"
test("Enter and Shift+Enter move between matches")                   // editor selection start 8 then 0
test("Replace All changes every match in one undo step and saves")    // replace "one" -> "1": editorText "1 two 1\n"; undo restores; fileDocs.text after settle equals "1 two 1\n" before undo
test("Cmd+Alt+F opens the replace row even when Option+F is a dead key") // key { metaKey, altKey, key: "ƒ", code: "KeyF" }: #replace-row visible
test("Escape closes the bar and returns focus to the editor")
test("Reading mode highlights matches in the preview")               // .find-preview-match count 2
test("find does nothing on the start page")
```
`test/find-bar-files-linux.test.js` (platform `Linux x86_64`): Ctrl+F opens, Ctrl+H opens replace, the help row shows `Ctrl`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/find-bar-files.test.js test/find-bar-files-linux.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `test/file-editor.test.js test/accessibility.test.js test/help-menu.test.js test/help-platform-labels.test.js test/find-replace.test.js test/plain-files.test.js` in the same guarded form. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(files): find and replace in the file editor"
```

---

### Task 12: Split view in the file editor

**Files:**
- Create: `src/file-split.js`, `test/file-split.test.js`
- Modify: `src/index.html`, `src/file-editor.js`, `src/app.css`, `package.json` (`check:js`)
- Test: `test/file-split.test.js`; regression `test/file-editor.test.js`, `test/file-comments.test.js`, `test/find-bar-files.test.js`, `test/accessibility.test.js`

**Interfaces:**
- Consumes: `createMarkdownEditor` (`src/editor-view.js`), the file editor's `sync` (`createDocSync`, several clients per document), `model` (`src/files.js`), and the same editor extensions the left editor gets.
- Produces (markup): in `#file-toolbar`, a `<div class="split-controls">` after `.comment-controls` with `<button class="layout-btn" id="split-file-btn" type="button" title="Split View (Cmd+\)" aria-label="Split view" aria-pressed="false">` (columns icon) and `<button class="layout-btn" id="compare-files-btn" type="button" title="Compare the two files" aria-pressed="false" hidden>Compare <span id="compare-files-count"></span></button>`. In `#editor-pane`, after `#editor-wrapper`: `<div class="editor-wrapper secondary-editor-wrapper" id="secondary-editor-wrapper" hidden><div class="secondary-pane-header"><select id="secondary-file-select" aria-label="File in the right pane"></select><button class="icon-btn" id="close-secondary-btn" type="button" aria-label="Close the right pane" title="Close split view">×</button></div><div class="editor-host" id="secondary-editor-host"></div></div>`.
- Produces (`src/file-split.js`):
  ```js
  export function createFileSplit({ document, createEditor, sync, model, onFocusPane, onChange }) -> {
    open(), close(), toggle(), isOpen(),
    show(bufferId),            // right pane shows that saved buffer (a second sync client of its document)
    shownId(),                 // buffer id on the right, or null
    editor(),                  // the right editor API
    bufferClosed(id),          // the buffer left this window: show the next saved buffer, or close when none
    refreshChoices(),          // rebuild #secondary-file-select from model.list() (path !== null only)
    activePane()               // "primary" | "secondary": the pane focused last
  }
  ```
  The right pane keeps its own `Map<bufferId, EditorState>`; untitled buffers are never offered. `file-editor.js`: `createFileSplit` with `createEditor: (host) => createMarkdownEditor({ ...same options as the left, parent: host })`; `#split-file-btn` and Cmd+\ (Ctrl+\ off macOS, `key === "\\"` or `"|"`) toggle it; opening shows the first saved buffer other than the shown one, else the shown one; split is disabled in Reading mode (button `disabled`, title "Split view works in Live and Source") and `setLayoutMode("reading")` closes it; every place a buffer leaves the model (`closeFile`, Task 9's `forget`, and multi-window's `moveFile` once it lands) calls `split.bufferClosed(id)`; comments `editors()` returns both panes; the find bar's `editor()` returns the editor of `activePane()`; plain buffers get `setPlainText(true)` on the right too. Classes: `#file-editor.split-mode` while open; `.secondary-editor-wrapper.active-pane` / `#editor-wrapper.active-pane` for the focused pane.

- [ ] **Step 1: Write the failing tests in `test/file-split.test.js`**

Platform `MacIntel`, `/d/a.md`, `/d/b.md` open, one `instance` per test.
```js
test("Split View shows another open file on the right")              // click split-file-btn: #secondary-editor-wrapper hidden false; editorText("secondary") === b text; select value "/d/b.md"
test("an edit on the right reaches the registry and the left when both show one file") // select /d/a.md on the right; type on the right; until fileDocs.text("/d/a.md") includes it; editorText("primary") includes it
test("untitled files are not offered on the right")                  // New File; select options list only saved paths
test("closing the file shown on the right shows the next one or closes the split")
test("Reading mode closes the split and disables the button")
test("Cmd+\\ toggles split view")
test("find searches the pane focused last")                          // focus right editor, Cmd+F, query only in b -> "1 of 1"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-split.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

CSS: `#file-editor.split-mode .editor-wrapper { flex: 1 1 50%; }`, a border between panes, the preview wrapper hidden while split (Reading is off anyway).

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `test/file-editor.test.js test/file-comments.test.js test/find-bar-files.test.js test/accessibility.test.js test/drafts.test.js` in the same guarded form, then `npm run check:js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json
git commit -m "feat(files): split view with a second file in the right pane"
```

---

### Task 13: Compare two files (shared compare controller)

**Files:**
- Create: `src/pane-compare.js`, `test/file-compare.test.js`
- Modify: `src/notes.js` (compare at about 3068-3215: keep `canCompareVisibleNotes`, `syncCompareControl` and the button UI; move the debounce, cache and decoration code), `src/file-editor.js`, `src/index.html` (load `vendor/diff.min.js` with the other vendor scripts, as `notes.html` line 14 does), `package.json` (`check:js`)
- Test: `test/file-compare.test.js`; existing `test/split-view.test.js`, `test/note-compare.test.js` unchanged; `test/no-egress.test.js`

**Interfaces:**
- Consumes: `compareNoteText(leftText, rightText, diffApi)` (`src/note-compare.js`), `editor.setDiff({ decorations, changedLines } | null)`, Task 12 `createFileSplit` (`isOpen`, `shownId`, `editor`).
- Produces:
  ```js
  export const COMPARE_DELAY_MS = 150;
  export function createPaneCompare({ left, right, diffApi, delay = COMPARE_DELAY_MS, onResult = () => {} }) -> {
    // left/right: () => editor API | null; onResult({ changedLineCount })
    setEnabled(enabled),   // true: compare now; false: cancel any pending run and clear both sides (setDiff(null))
    isEnabled(),
    schedule(),            // after an edit on either side: debounced compare
    refresh(),             // re-apply cached decorations without recomputing (both texts unchanged)
    destroy()
  }
  ```
  Cache key: the two texts; a schedule with unchanged texts reuses the cached result. `notes.js` uses it with `left: () => primaryEditor`, `right: () => secondaryEditor`. `file-editor.js`: `#compare-files-btn` is shown while split is open with two different files and `window.Diff` exists; clicking toggles compare (`aria-pressed`, `#file-editor.compare-mode`, `#compare-files-count` shows the changed line count as Quick Notes does); edits in either pane and remote updates call `schedule()`; closing split, showing the same file on both sides or switching either pane to another file turns compare off or recomputes (off when same file, recompute otherwise).

- [ ] **Step 1: Write the failing tests in `test/file-compare.test.js`**

```js
test("Compare highlights the differences between the two files")      // a "one\ntwo\n", b "one\n2\n": split, click compare-files-btn; .cm-diff-line-removed in primary, .cm-diff-line-added in secondary (assert counts as numbers)
test("an edit recomputes after the delay")                              // type on the right; after settle(COMPARE_DELAY_MS + 50) counts change
test("Compare is hidden when both panes show the same file and off when split closes")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-compare.test.js test/split-view.test.js test/note-compare.test.js`
Expected: `test/file-compare.test.js` FAILS; the Quick Notes tests PASS (baseline).

- [ ] **Step 3: Implement `src/pane-compare.js`, move notes.js onto it, wire the file editor**

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command plus `test/file-split.test.js test/no-egress.test.js test/accessibility.test.js` in the same guarded form, then `npm run check:js` and `npm run check:egress`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src test package.json
git commit -m "feat(files): compare two files side by side"
```

---

### Task 14: Docs, roadmap, PR body and the full CI mirror

**Files:**
- Modify: `docs/files.md`, `docs/mcp.md`, `README.md`, `ROADMAP.md`, `src/index.html` (help text "Files (this window)" note if it still says only "Markdown and text files")
- Create (uncommitted, not in git): `.pr-body.md`

**Interfaces:**
- Consumes: everything above. No code changes unless a check fails; fix a failure in the file that owns it.

- [ ] **Step 1: `docs/files.md`**

- Types: `.md`, `.markdown`, `.txt`, `.csv` and `.tsv`; `.txt`, `.csv` and `.tsv` open as plain text (no live preview or Markdown keys, Tab types a tab, Reading shows the text as it is).
- New "Folders" section: Open Folder… (Cmd+Shift+O, Ctrl+Shift+O on Windows and Linux) and Show Folder in Sidebar; each window has its own folders, restored after a restart with the expanded folders; what is hidden (names starting with a dot, `node_modules`, `.gitignore` matches read from the repository top down) and what is shown (the five types); folders load one level at a time and update while expanded (at most 128 folders update live); more than 2,000 items shows "Some items are not shown."; remove a folder with its × button.
- New "Drafts" section: an agent can put a draft in front of you; the Draft tag and bar; Save As…, Save to Quick Notes (goes to the "From agents" folder), Discard; closing keeps the draft on the start page under Drafts; drafts are kept in the app's data folder, readable only by you.
- New "Find, split view and compare" section: Cmd+F, Cmd+Alt+F (Ctrl+H on Windows and Linux), Cmd+\, Compare with two different files; split view is not available in Reading mode.
- Limits: remove the two lines saying find/split/compare and folders are not available.
- Access and privacy: folders shown in a window's sidebar may be listed by that window; listing is never available to MCP; files are granted when you open them from the tree.

- [ ] **Step 2: `docs/mcp.md` and `README.md`**

Add a "Pushing a draft" section after "Pushing a quick note" (arguments table: `requestId`, `title`, `content`; behavior: opens in the main window used last, co-edited, kept until saved or discarded; result `{ path, name, bytes }`; example JSON); add `push_draft` to the write-functions table; update the open_document types; fix the write-function count to 15 in both `docs/mcp.md` and `README.md` (they said thirteen while there were fourteen); add a sentence that no function lists folders.

- [ ] **Step 3: `ROADMAP.md` item 4**

Replace the Status line with: `Status: done. Files in 0.10; folders, .csv/.tsv, drafts and find/split/compare for files on feat/files-folders (spec [docs/superpowers/specs/2026-10-18-files-folders-design.md](docs/superpowers/specs/2026-10-18-files-folders-design.md))`, and replace the "Still to do, in this order" list with a "Shipped later" list of the four parts. Note under the Sidebar model that Folders are per window (decided 2026-10-18).

- [ ] **Step 4: Write `.pr-body.md` (do not commit it)**

Content: a summary of the four sub-features, the test list, the manual check list from Step 6, the line `Refs ROADMAP item 4`, the line "Stacked on `feat/multi-window`: merge that branch first, then rebase this one onto `main`.", and this release-notes paragraph:

> **Folders, CSV and drafts.** Open a folder with Open Folder… (Cmd+Shift+O) or Show Folder in Sidebar, and browse it in the sidebar's new Folders section, one level at a time; hidden files, `node_modules` and anything in `.gitignore` stay out of the way, and each window keeps its own folders. `.csv` and `.tsv` files now open, and with `.txt` they open as plain text without Markdown formatting. Agents can push a draft for you to review with the new `push_draft` function; it stays in Sodilaud until you save it as a file or to Quick Notes. Find and replace (Cmd+F), split view (Cmd+\) and compare now work on files too.

- [ ] **Step 5: Run the full CI mirror from the worktree root**

```bash
npm run check:versions && npm run check:js && npm run check:egress
RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:egress
```
Expected: all pass (these are the steps of `npm run check` plus the Rust CI steps); inside the sandbox only the 4 MCP socket tests fail.

- [ ] **Step 6: Commit**

```bash
git add docs README.md ROADMAP.md src/index.html
git commit -m "docs(files): folders, csv and tsv, drafts, and find/split/compare for files"
```

Manual check list for the reviewer (release build): open a repository folder and expand `src` (ignored and hidden files absent); create a `.md` in an expanded folder from a terminal (appears within a second); open a `.csv` from Finder (plain text, Tab types a tab); push a draft from an agent, edit it, save it as a file, push another and save it to Quick Notes, discard a third; quit with a draft and a folder open and relaunch (both back); find and replace in a file; split and compare two files; a second window has its own Folders.
