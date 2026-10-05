# Files in the document registry - design

Date: 2026-10-05
Status: awaiting written-spec review
Branch: `feat/files-registry`
Roadmap: the "3-way merge of outside edits" part of item 4 in
[`ROADMAP.md`](../../../ROADMAP.md), and the prerequisite for item 5. Builds on
[`2026-09-28-rust-document-model-design.md`](2026-09-28-rust-document-model-design.md).
Sibling specs: [`2026-10-05-agent-push-and-open-design.md`](2026-10-05-agent-push-and-open-design.md),
[`2026-10-05-agent-coedit-design.md`](2026-10-05-agent-coedit-design.md).

## Intent

**What.** Files open in the main window join the Rust document registry the way notes did in
0.11. Rust owns each open file's text and version, the editor is a `@codemirror/collab` client,
Rust autosaves, and an edit made outside Sodilaud is 3-way merged into the open text instead of
offering only Reload / Keep mine.

**Why.** Agent co-editing of files (spec C) needs one authority that rebases an agent's edits
around the owner's typing. The same authority makes outside edits (git checkout, another
editor, an agent writing the file directly) merge instead of forcing a choice.

**Done.**

- Editing, autosave, Save As, close, quit and the open/recent lists behave as in 0.10.
- An outside edit to a part of the file the owner has not touched since the last save appears
  in the editor without moving the cursor, losing typing or undo history.
- An outside edit that overlaps unsaved typing keeps the owner's text and shows today's
  banner (Reload / Keep mine).
- Checks pass: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `npm run check`.

**Not done here.** Agent tools for files, comments (spec C). Folders, `.csv`/`.tsv`, find and
replace, split and compare for files.

## Decisions

| Topic | Decision |
|---|---|
| Shared core | A `Collab` struct (text, version, last 1,000 updates, apply, pull) extracted from the note `Entry`. Notes keep their behaviour and their tests; files use the same struct. Spec C's merge engine and comments work on `Collab`, so both document kinds get them |
| File registry | `Registry.files: HashMap<PathBuf, FileDoc>` keyed by canonical path, independent of the open workspace (switching workspaces does not touch files). `FileDoc { collab, line_ending, bom, synced: String, disk_hash, save: SaveState }` |
| Protocol | `file_doc_open(path) -> { text, version, lineEnding, bom, savedVersion }`, `file_doc_push(path, version, updates) -> { accepted, version }`, `file_doc_pull(path, since)`, `file_doc_close(path)`. Event `file-doc-updates { path, from, updates, version }` to the main window only. Grants are checked on every call, as `file_read` does today |
| Untitled files | Stay in the page until Save As. After the first write the page calls `file_doc_open` and continues as a client |
| Autosave | Rust writes 400 ms after the last accepted change (today's delay), atomically with `io::write_atomic`, in the file's line ending and BOM. One write per file at a time; a change during a write schedules another. Event `file-doc-saved { path, version, hash, error? }`. The page's dirty dot means "version > saved version" |
| Line endings | Text is `\n` inside the registry. A file with mixed endings loads normalized and is written with its majority ending only once it is edited. Opening never writes |
| Outside edits | The watcher reads the new bytes. Base = `synced` (last text read or written), mine = current text, theirs = disk. Mine == base: apply theirs. Otherwise a line-based 3-way merge (`diffy::merge`). Clean: apply the merged text. Conflict: keep mine, set `external = conflict`, show the banner |
| Applying a text | Any whole-text replacement (outside edit, Reload) is turned into a minimal change set (`similar` diff) and broadcast as an update from client `disk`, so cursors and undo survive. `changes::replace_all` stays test-only |
| Removed on disk | As today: banner, buffer kept, no autosave until the owner saves or closes |
| Close | `file_doc_close` flushes a pending save, then drops the doc when no client holds it. Spec C will also keep docs alive while an agent co-edits them |
| Quit | The page waits for unconfirmed pushes (as Quick Notes does), then Rust flushes pending saves before exit |
| New crates | `diffy` (3-way merge), `similar` (minimal diffs). `cargo fetch` needs the sandbox off |

## Module map

```
src-tauri/src/
  docs/collab.rs       Collab { text, version, updates }: push, pull, apply_text (minimal diff)
  docs/registry.rs     Entry uses Collab; Registry.files
  docs/files.rs        FileDoc, open/push/pull/close, autosave scheduler, external merge
  docs/changes.rs      diff(old, new) -> change set JSON
  files/commands.rs    file_doc_* commands; file_write stays for Save As of untitled buffers
  files/watch.rs       reports to docs/files.rs instead of straight to the page
src/
  doc-sync.js          note-sync.js generalized: push/pull/identity passed in; note-sync.js wraps it
  file-editor.js       buffers hold version and saved version; autosave timers removed
  files.js             model: saved state from events, external = merged | conflict | removed
```

## Risks

- **Refactoring note `Entry`** could regress notes. Existing registry and `note-sync` tests run
  unchanged before and after the extraction; the extraction is its own commit.
- **Merge correctness.** Unit tests: disjoint edits merge, overlapping edits conflict, astral
  characters and CRLF files round-trip, an outside edit during a pending autosave.
- **Write storms.** The watcher must ignore Sodilaud's own writes (hash recorded before the
  rename, as today).
