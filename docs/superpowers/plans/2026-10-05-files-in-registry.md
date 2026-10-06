# Files in the document registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files open in the main window join the Rust document registry: Rust owns their text and version, autosaves them, and 3-way merges outside edits into the open text.

**Architecture:** A `Collab` struct (text, version, last 1,000 updates) is extracted from the note `Entry` and reused by a new `FileDocs` store inside `Registry`. The main window's editor becomes a `@codemirror/collab` client through `doc-sync.js`, a generalization of `note-sync.js`. The watcher hands outside changes to `FileDocs`, which merges them with `diffy` and broadcasts the result as a minimal change set built with `similar`.

**Tech Stack:** Rust (Tauri 2, serde_json, `diffy` 0.5, `similar` 3), vanilla JS, CodeMirror 6 (`@codemirror/collab`), `node --test` with jsdom.

**Spec:** `docs/superpowers/specs/2026-10-05-files-in-registry-design.md` (builds on `docs/superpowers/specs/2026-09-28-rust-document-model-design.md`).

## Global Constraints

- Text is `\n` inside the registry; files are written in their (majority) line ending and BOM with `io::write_atomic`.
- Autosave delay 400 ms after the last accepted change. One write per file at a time.
- Opening a file never writes it.
- `Collab` keeps the last 1,000 updates (`HISTORY`); an older client reloads.
- Grants are checked on every `file_doc_*` call.
- File events go to the main window only (`emit_to(MAIN_LABEL, ...)`); note events stay Quick Notes only.
- The `Collab` extraction is its own commit, with every existing Rust and JS test unchanged and passing.
- Checks: `npm run check`, `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`, `npm run check:egress`.
- No em dashes anywhere. No comments unless the why is non-obvious.
- JS tests: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 600; exec @ARGV' npm test`. Avoid two equal timer delays racing in tests.

## Review Focus

1. Sodilaud's own autosave must never come back as an outside edit (write storm). Test: save, then run the external handler on the same bytes; nothing is broadcast (Task 5).
2. An outside edit that lands while an autosave is pending must not be overwritten by the old text. Test: push, outside edit, then save; disk holds the merged text (Task 5).
3. Astral characters and CRLF files through diff, merge and save. Tests in Tasks 2 and 5.
4. Save As onto a path that is open as another document must not be overwritten later by that document's pending autosave. Test: `discard` drops the doc without writing (Task 3); the page closes the other buffer without flushing (Task 8).
5. A failed write keeps the document dirty and reports the error; the next edit retries. Test: disk that fails, saved event carries the error, `saved_version` unchanged (Task 4).

---

## File structure

```
src-tauri/src/docs/collab.rs     NEW  Collab, Update, Pushed, Pulled, HISTORY
src-tauri/src/docs/registry.rs   Entry { note, rev, collab }; Registry gains `files: FileDocs`; Sink gains file events (default no-ops)
src-tauri/src/docs/changes.rs    + diff(old, new) -> change set (similar)
src-tauri/src/docs/files.rs      NEW  FileDoc, FileDocs: open/push/pull/close/save/flush/external/resolve/discard, Disk trait, scheduler
src-tauri/src/docs/commands.rs   AppSink emits file events to the main window
src-tauri/src/files/io.rs        + decode_normalized (majority line ending)
src-tauri/src/files/mod.rs       Files implements Disk; watcher loop calls the registry; saver thread
src-tauri/src/files/commands.rs  file_doc_open/push/pull/close/save/resolve; file_open_dialog returns a path; file_read/file_write removed
src-tauri/src/files/watch.rs     CHANGED_EVENT removed (changes go to the registry)
src-tauri/src/quit.rs            flush file saves before exit
src-tauri/build.rs, capabilities/default.json, lib.rs   command list
src/doc-sync.js                  NEW  generic collab client
src/note-sync.js                 thin wrapper over doc-sync.js (same API)
src/files.js                     model: versions, saved version, external state
src/file-editor.js               collab client per buffer, no autosave timers
src/app.js                       listens to file-doc-* events
test/helpers/fake-file-docs.js   NEW  fake FileDocs for page tests
test/helpers/app-harness.js      wires the fake file docs
test/doc-sync.test.js, test/files-model.test.js, test/file-editor.test.js, test/command-permissions.test.js
docs/files.md, ROADMAP.md, spec "Changes made during implementation"
```

---

### Task 1: Extract `Collab` from the note `Entry`

**Files:**
- Create: `src-tauri/src/docs/collab.rs`
- Modify: `src-tauri/src/docs/mod.rs`, `src-tauri/src/docs/registry.rs`, `src-tauri/src/docs/agent.rs`
- Test: existing tests only (unchanged), plus unit tests inside `collab.rs`

**Interfaces:**
- Produces (in `docs::collab`, re-exported from `docs::registry` so imports elsewhere keep working):
  ```rust
  pub(crate) const HISTORY: usize = 1000;
  pub(crate) struct Update { client_id: String /* serde "clientID" */, changes: Value }
  pub(crate) struct Pushed { accepted: bool, version: u64 }
  pub(crate) enum Pulled { Updates(Vec<Update>), Reload { text: String, version: u64 } }
  #[derive(Clone, Debug)] pub(crate) struct Collab { text: String, version: u64, updates: VecDeque<Update> }
  impl Collab {
      pub(crate) fn new(text: String) -> Self;                 // version 0, empty history
      pub(crate) fn text(&self) -> &str;
      pub(crate) fn version(&self) -> u64;
      pub(crate) fn apply(&self, updates: &[Update]) -> Result<String, String>; // pure: text after updates
      pub(crate) fn commit(&mut self, text: String, updates: Vec<Update>) -> u64; // returns `from`; trims history
      pub(crate) fn pull(&self, since: u64) -> Result<Pulled, String>;
  }
  ```
- `Entry` becomes `{ note: Note, rev: u64, collab: Collab }`; `note.content` mirrors `collab.text()` and only `Workspace::apply_updates` changes it. `NoteState.version` reads `collab.version()`.

- [ ] **Step 1:** Write unit tests in `collab.rs`: `apply` leaves the collab unchanged; `commit` returns `from` and bumps the version by the number of updates; `pull` returns the tail, errors when `since` is ahead, reloads past `HISTORY`.
- [ ] **Step 2:** Run `cargo test --manifest-path src-tauri/Cargo.toml collab` - fails (module missing).
- [ ] **Step 3:** Implement `collab.rs`; move `Update`, `Pushed`, `Pulled`, `HISTORY` there; `pub(crate) use super::collab::{...}` in `registry.rs`. Rewrite `new_entry`, `state()`, `apply_updates` (apply, save row, then `collab.commit`), `push` (version check via `collab.version()`), `pull` (delegates to `collab.pull`). Agent `append_to_note` reads `current.collab.text()`.
- [ ] **Step 4:** `cargo test --manifest-path src-tauri/Cargo.toml` and the JS suite: all pass, no existing test edited.
- [ ] **Step 5:** Commit `refactor(docs): extract the shared Collab core from note entries`.

### Task 2: Minimal change sets (`changes::diff`, `Collab::replace`)

**Files:** Modify `src-tauri/Cargo.toml` (`diffy = "0.5.2"`, `similar = "3.2.0"`), `src-tauri/src/docs/changes.rs`, `src-tauri/src/docs/collab.rs`.

**Interfaces:**
- `pub(crate) fn diff(old: &str, new: &str) -> Value` - a CM6 change set over `old` (UTF-16 lengths) that turns it into `new`. Line diff first (`TextDiff::configure().timeout(..).diff_lines`), then a char diff inside each replaced hunk, so unchanged lines are kept parts.
- `Collab::replace(&mut self, client_id: &str, text: &str) -> Option<(u64, Vec<Update>)>` - `None` when the text is unchanged; otherwise commits one update from `client_id` and returns `(from, updates)`.

- [ ] **Step 1:** Tests: `apply(old, &diff(old, new)) == new` over the randomized alphabet of `random_edits_match_a_utf16_reference` (astral chars, newlines); an edit in the middle line of three keeps the first and last lines as numbers in the change set; `diff("", "")` is `[]`. Collab: `replace` with the same text returns `None`; with new text bumps the version and records client `disk`.
- [ ] **Step 2:** Run, fail (no `diff`).
- [ ] **Step 3:** Implement with a small builder (`keep(&str)`, `delete(&str)`, `insert(&str)`) that merges adjacent parts and emits `[len, line, ...]` for replacements. `replace_all` stays test-only.
- [ ] **Step 4:** Pass (the sandbox can build once the crates are fetched).
- [ ] **Step 5:** Commit `feat(docs): turn whole-text replacements into minimal change sets`.

### Task 3: `FileDocs` core: open, push, pull, close, discard

**Files:** Create `src-tauri/src/docs/files.rs`; modify `docs/mod.rs`, `docs/registry.rs` (field `pub(crate) files: FileDocs`, Sink gains `fn file_doc(&self, _: &FileDocUpdates) {}`, `fn file_saved(&self, _: &FileSaved) {}`, `fn file_external(&self, _: &FileExternal) {}` with default bodies), `files/io.rs` (`decode_normalized`), `files/mod.rs` (`FileError::new` becomes `pub(crate)`, new code `NotOpen`).

**Interfaces:**
```rust
pub(crate) trait Disk {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FileError>;      // records the hash with the watcher
    fn write(&self, path: &Path, text: &str, ending: LineEnding, bom: bool) -> Result<String, FileError>;
}
#[serde(rename_all = "lowercase")] pub(crate) enum External { Conflict, Removed }
pub(crate) struct FileDoc { pub(crate) collab: Collab, line_ending, bom, synced: String, disk_hash: String, save: SaveState { saved_version, due: Option<Instant>, error: Option<String> }, external: Option<External> }
#[serde(rename_all = "camelCase")] pub(crate) struct FileOpened { path, name, text, version, line_ending, bom, saved_version, external }
pub(crate) struct FileDocUpdates { path: String, from: u64, updates: Vec<Update>, version: u64 }
pub(crate) struct FileSaved { path: String, version: u64, hash: Option<String>, error: Option<String> }
pub(crate) struct FileExternal { path: String, kind: ExternalKind /* applied | merged | conflict | removed */ }
impl Registry {
    pub(crate) fn file_open(&self, path: &Path, disk: &dyn Disk) -> Result<FileOpened, FileError>; // returns the live doc if already open
    pub(crate) fn file_push(&self, path: &Path, version: u64, updates: Vec<Update>) -> Result<Pushed, FileError>;
    pub(crate) fn file_pull(&self, path: &Path, since: u64) -> Result<Pulled, FileError>;
    pub(crate) fn file_close(&self, path: &Path, disk: &dyn Disk) -> Result<(), FileError>; // flushes, then drops
    pub(crate) fn file_discard(&self, path: &Path);   // drops without writing
}
io::decode_normalized(bytes) -> Result<(String, LineEnding, bool), FileError> // `\n` text, majority ending (CRLF only when CRLF lines outnumber LF lines)
```

- [ ] **Step 1:** Tests (temp dir, `TestDisk` over `io`): open normalizes a mixed file and reports CRLF majority, opening does not write (mtime/bytes unchanged); push at the current version applies and broadcasts `FileDocUpdates` and sets a due save; a stale push is rejected; pull mirrors notes; push for an unopened path errors with `NotOpen`; open twice returns the live text and version; close drops it.
- [ ] **Step 2:** Fail.
- [ ] **Step 3:** Implement. `FileDocs { docs: Mutex<HashMap<PathBuf, FileDoc>>, writing: Mutex<()>, wake: Condvar }`. Events are emitted while the docs lock is held.
- [ ] **Step 4:** Pass; existing tests unchanged.
- [ ] **Step 5:** Commit `feat(files): keep open files in the document registry`.

### Task 4: Autosave and explicit saves

**Files:** `src-tauri/src/docs/files.rs`.

**Interfaces:**
```rust
pub(crate) const SAVE_DELAY: Duration = Duration::from_millis(400);
impl Registry {
    pub(crate) fn file_save(&self, path: &Path, disk: &dyn Disk) -> Result<FileSaved, FileError>; // writes now if dirty and not blocked
    pub(crate) fn file_flush_all(&self, disk: &dyn Disk) -> Vec<FileError>;
    pub(crate) fn file_next_due(&self) -> PathBuf;   // blocks until a due save comes up (saver thread)
    fn file_due_now(&self, now: Instant) -> Option<PathBuf>; // test seam for the scheduler
}
```
`file_save`: lock `writing`; snapshot `(text, version, ending, bom)` under the docs lock; write without the docs lock; re-lock; on success set `saved_version = version`, `synced = text`, `disk_hash = hash`, clear error; on failure set error; emit `FileSaved`. A push during the write leaves `version > saved_version` and its own `due`, so another write follows. Blocked (`external` set) or clean docs return the current state without writing.

- [ ] **Step 1:** Tests: a due save is not returned before 400 ms and is after; save writes CRLF+BOM bytes and emits `FileSaved { version, hash }`; a push after the snapshot keeps the doc dirty; a failing disk reports `error` and keeps `saved_version`; a conflicted doc is not written; `file_close` flushes a pending save.
- [ ] **Step 2-4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(files): autosave open files from Rust`.

### Task 5: Outside edits: merge, conflict, removal, resolve

**Files:** `src-tauri/src/docs/files.rs`.

**Interfaces:**
```rust
pub(crate) enum Resolve { Disk, Mine }   // serde lowercase
impl Registry {
    pub(crate) fn file_changed_on_disk(&self, path: &Path, removed: bool, disk: &dyn Disk);
    pub(crate) fn file_resolve(&self, path: &Path, keep: Resolve, disk: &dyn Disk) -> Result<(), FileError>;
}
pub(crate) fn merge(base: &str, mine: &str, theirs: &str) -> Option<String>; // diffy, None on conflict
```
Rules: under `writing` lock, read bytes; same hash as `disk_hash` -> ignore. `mine == base` -> `collab.replace("disk", theirs)`, `saved_version = version`, `synced = theirs`, emit `applied`. Otherwise `merge` -> replace with merged, `synced = theirs`, due save now + 400 ms, emit `merged`. Conflict -> `external = Conflict`, `synced = theirs`, emit `conflict`. Removed -> `external = Removed`, emit `removed`. `Resolve::Disk` re-reads and replaces as in the clean case; `Resolve::Mine` clears `external` and saves at once.

- [ ] **Step 1:** Tests: disjoint edits merge (line 1 mine, line 3 theirs) and the next save writes the merge; overlapping edits conflict and keep mine; astral text and a CRLF file round-trip through a merge and save byte for byte; an outside edit during a pending autosave ends with the merge on disk; our own write is not an outside edit; removal blocks saves; Reload takes disk; Keep mine writes mine.
- [ ] **Step 2-4:** Fail, implement, pass.
- [ ] **Step 5:** Commit `feat(files): 3-way merge outside edits into open files`.

### Task 6: Tauri wiring

**Files:** `files/commands.rs`, `files/mod.rs`, `files/watch.rs`, `docs/commands.rs`, `quit.rs`, `lib.rs`, `build.rs`, `capabilities/default.json`, `test/command-permissions.test.js`.

**Interfaces (commands, main window only, each `require_main` + `files.require(path)`):**
```
file_open_dialog() -> Option<String>                       (granted path; the page then opens it)
file_doc_open(path) -> FileOpened                         (adds to the recent list)
file_doc_push(path, version, updates) -> Pushed
file_doc_pull(path, since) -> Pulled
file_doc_close(path) -> ()
file_doc_save(path) -> FileSaved                           (Cmd+S, Try again, quit)
file_doc_resolve(path, keep: "disk" | "mine") -> ()
events (main window): file-doc-updates, file-doc-saved, file-doc-external
```
`file_read` and `file_write` are removed; `file_save_as_dialog` calls `registry.file_discard(path)` before writing. `Files` implements `Disk` (read records the hash with the watcher; write is `Files::write`). `files::start` spawns the saver thread (`loop { let path = registry.file_next_due(); registry.file_save(&path, files) }`) and the watcher loop calls `registry.file_changed_on_disk`. `quit::exit` calls `registry.file_flush_all`.

- [ ] **Step 1:** Update `test/command-permissions.test.js`: the file command list is the new one plus `file_doc_*`; a new test asserts `docs/commands.rs` emits `FILE_DOC_EVENT`, `FILE_SAVED_EVENT`, `FILE_EXTERNAL_EVENT` with `emit_to(quicknotes::window::MAIN_LABEL, ...)`.
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement the wiring.
- [ ] **Step 4:** `cargo clippy` and the JS permissions test pass.
- [ ] **Step 5:** Commit `feat(files): file document commands and events`.

### Task 7: `doc-sync.js`

**Files:** Create `src/doc-sync.js`; modify `src/note-sync.js`, `package.json` (`check:js`); test `test/doc-sync.test.js`.

**Interfaces:**
```js
export const PUSH_DELAY_MS = 150;
export function applyUpdatesToText(text, updates);
export function createDocSync({ push, pull, same, isGone, ready, onStatus, onReload, label, pushDelay });
//   push(doc, version, updates) -> Promise<{accepted, version}>
//   pull(doc, since) -> Promise<{updates} | {reload: {text, version}}>
//   same(doc, event) -> boolean ; isGone(error) -> boolean
//   onReload(doc, text, version)
// returns { extension(doc, version), receive(event), flush(), pending(filter = () => true) }
```
`note-sync.js` keeps `createNoteSync`'s signature and behaviour; `extension(noteId, version)` passes `{ noteId, collectionId: collectionId() }`.

- [ ] **Step 1:** `test/doc-sync.test.js`: a file-keyed sync over an in-memory authority pushes, confirms, receives a `disk` update without losing a local unsent edit, and `pending(doc => doc.path === "/a")` reports per document.
- [ ] **Step 2-4:** Fail, implement, pass; `test/note-sync.test.js` unchanged and passing.
- [ ] **Step 5:** Commit `refactor(sync): generalize the note collab client to any document`.

### Task 8: The main window as a collab client

**Files:** `src/files.js`, `src/file-editor.js`, `src/app.js`; create `test/helpers/fake-file-docs.js`; modify `test/helpers/app-harness.js`, `test/files-model.test.js`, `test/file-editor.test.js`.

**Model (`files.js`):** buffer `{ id, path, name, text, version, latest, savedVersion, lineEnding, bom, external, editorState }`. `isDirty(buffer, unsent = false)` is `text !== ""` for an untitled buffer and `unsent || latest > savedVersion` otherwise. Methods: `openFile(opened)`, `newUntitled()`, `adopt(id, opened)` (after Save As), `docUpdated(path, version)`, `saved(path, { version, error })`, `external(path, kind)`, `reload(id, text, version)`, `edit`, `close`, `activate`, `byPath`, `paths`, `list`, `active`, `get`.

**Editor (`file-editor.js`):** one `createDocSync` keyed by `{ path }` using `file_doc_push` / `file_doc_pull`; `loadText(buffer.text, { extensions: sync.extension({ path }, buffer.version) })`; status "Saving..." while unsent or `latest > savedVersion`; Cmd+S: `sync.flush()` then `file_doc_save`; banner Reload / Keep mine call `file_doc_resolve`; close: flush, `file_doc_save`, then `file_doc_close`; quit: flush, then `file_doc_save` for every saved buffer; Save As: dialog, `file_doc_close(old)` (unless the path was another open buffer, which is closed locally), `file_doc_open(new)`, `adopt`, reload the editor keeping the selection.

- [ ] **Step 1:** Rewrite `files-model.test.js` and `file-editor.test.js` against the fake: open + autosave; outside edit to a clean file applies without a banner and keeps the cursor; a merged outside edit keeps unsaved typing and undo; a conflict shows the banner and Reload / Keep mine work; removal offers Save As; Cmd+W; new file Save As then autosave goes through the registry; quit saves and reports a failure; recent list; reading mode and Finder.
- [ ] **Step 2-4:** Fail, implement, pass (JS suite twice: macOS default and the Linux navigator preload).
- [ ] **Step 5:** Commit `feat(files): edit files as registry collab clients`.

### Task 9: Docs and roadmap

**Files:** `docs/files.md`, `ROADMAP.md` (item 4 status), the spec's "Changes made during implementation" section.

- [ ] **Step 1:** Update "Changes made elsewhere" (merge, conflict, removal), line endings (majority), and Save As note.
- [ ] **Step 2:** Roadmap item 4 status: files and 3-way merge done; folders and the rest not started.
- [ ] **Step 3:** Record deviations in the spec.
- [ ] **Step 4:** Commit `docs(files): describe merged outside edits`.

### Final verification

Mirror CI: `npm run check`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --locked --manifest-path src-tauri/Cargo.toml` (and unsandboxed for the MCP socket tests), `npm run check:egress`, plus the JS suite with the Linux navigator preload.
