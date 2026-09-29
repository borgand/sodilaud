# Rust-owned document model for notes - design

Date: 2026-09-28
Status: implemented 2026-09-28, one pull request, one release (0.11)
Branch: `feat/rust-doc-model`
Roadmap: item 2 in [`ROADMAP.md`](../../../ROADMAP.md). Builds on
[`2026-09-27-editor-surface-design.md`](2026-09-27-editor-surface-design.md) (Shape B).

## Intent

**What.** Rust owns the notes collection (notes, folders, trash, order, pins) and each note's
text. The Quick Notes page becomes a view over it. Each editor pane is a `@codemirror/collab`
client that sends versioned changes. MCP reads and writes the collection in Rust directly.

**Why.** Agent co-editing (item 5) and the 3-way merge of files (item 4) need one authority
that rebases concurrent edits instead of letting the last snapshot win. Today an
`append_to_note` replaces the editor text, and agent access needs the panel page to relay
every write.

**Done.** Notes behave as in 0.10 from the owner's side. An MCP `append_to_note` shows up in
an open editor without losing typing, the cursor or undo history. MCP works before the panel
page has loaded. Upgrading from the localStorage mode loses no notes. Checks pass:
`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `npm run check`.

**Not done here.** External files stay on today's model (they join the registry with item 4's
merge work). Comments, `apply_edit` and hunk merging, `push_quick_note`, `open_document`.

## Decisions

| Topic | Decision |
|---|---|
| Storage | The localStorage mode is replaced by `default.sqlite` in the app data dir: owner-only permissions and `secure_delete`, like any workspace |
| Import | On first boot the page sends its localStorage collection to `notes_import_local`. Rust writes it in one transaction and sets `meta.local_imported`, so it never runs twice. localStorage is left as it was, so installing 0.10 again still finds the notes |
| Disconnect | Switches to the default workspace instead of the local-only collection |
| Line endings | Note text is normalized to `\n` when it enters the registry, because CM6 does the same and offsets must agree |
| Content protocol | The `@codemirror/collab` authority: `doc_push(noteId, version, updates)` is rejected on a stale version, the client pulls and rebases. Rust broadcasts `notes-doc-updates` to every client |
| Content persistence | `doc_push` writes the note row, then applies the changes in memory. The page pushes 150 ms after typing stops (the old save debounce was 400 ms). A failed write changes nothing; the client keeps its changes and retries every 2 s |
| Titles | Rust derives the title from the first line (heading marks removed, 30 UTF-16 units, "Untitled Scratchpad" when empty) unless it is locked, and sets `updatedAt`, so agent edits retitle too |
| Structure | The page keeps computing sidebar changes with its existing helpers, then sends the resulting order plus the fields it changed with `notes_sync_structure`. Rust merges it: notes and folders it has that the page does not list were created concurrently (by an agent) and are kept; deleted folders are listed explicitly; a changed field overwrites Rust's value, so an agent's change to another field of the same note survives |
| Trash | Explicit commands: trash a note, restore, empty. Trashing the last note creates an empty "Untitled Scratchpad", for the page and for MCP |
| Events | Every structural change emits `notes-workspace-changed` with the full collection, bodies included. Structural changes are user actions, not keystrokes |
| MCP | Tools read the registry. Validation, receipts and revision checks move from `mcp-writes.js` to Rust. `mcp-writes.js` and the snapshot relay are deleted. A revision is the note's change counter, so it is opaque and cheap. `collectionId` is issued by Rust each time a workspace opens |
| Undo | Each client has its own history. Undo never reverts an agent's change or the other pane's change |
| Quit | Each page waits for its unconfirmed pushes, then answers the quit request. Rust has nothing left to write |

## Module map

```
src-tauri/src/
  store/workspace.rs   SQLite schema, load, save (moved from lib.rs), meta table, default workspace path
  docs/changes.rs      CM6 ChangeSet JSON -> text; UTF-16 / char / byte offsets
  docs/registry.rs     Workspace { id, path, notes, folders, trash, docs }; push, pull, structure merge, trash, MCP writes
  docs/commands.rs     Tauri commands and events
  mcp.rs               tools call the registry; permissions stay here
src/
  note-sync.js         collab client per editor pane: push debounce, confirm, rebase, pull on gaps
  notes.js             renders registry events, sends structure and trash commands
  storage.js, trash.js localStorage readers kept for the one-time import only
```

## Protocol

```
notes_boot({ legacyPath }) -> { state, needsLocalImport, fallback }
  state = { collectionId, name, path, isDefault, seq, notes[{...note, version, rev}], folders[{id, name, rev}], trash }
notes_import_local({ local: { notes, folders, trash } }) -> state
notes_connect({ dbPath }) / notes_disconnect() -> state      (connect seeds an empty file with the current collection)
notes_sync_structure({ structure: { collectionId, notes[{id, ...changed fields, content if new}], folders[{id, name?}], deletedFolderIds } }) -> state
notes_trash / notes_restore / notes_empty_trash / notes_vacuum
doc_push({ collectionId, noteId, version, updates[{ clientID, changes }] }) -> { accepted, version }
doc_pull({ collectionId, noteId, since }) -> { updates } | { reload: { text, version } }
event notes-workspace-changed: state
event notes-doc-updates: { collectionId, noteId, from, updates, title, updatedAt, rev, version }
```

The registry keeps the last 1,000 updates of each note in memory. A client whose version is
older than that window reloads the note text instead of rebasing.

## Changes made during implementation

1. **State sequence numbers.** Every collection state Rust hands out carries a global `seq`.
   The page ignores a state older than one it applied, and while its own structure writes
   are in flight it holds the newest state until they settle. `notes_sync_structure` returns
   the state it produced. Without this, a late event could put back an arrangement the user
   had just changed.
2. **Patches are relative to what was sent.** The page diffs its sidebar against Rust's last
   state plus the writes it has already sent, not Rust's last state alone; a pin followed by
   an unpin inside one round trip would otherwise cancel out. After a failed write, the next
   one sends every note's metadata in full.
3. **Confirmed text is kept apart from shown text.** Each note in the page carries
   `syncedContent` at `version`, which is what a new editor starts from. Starting from text
   that includes unsent typing would duplicate it when the typing arrives as an update.
4. **Each pane keeps an editor state per note.** Switching back to a note resumes the same
   collab client, with its unsent changes and undo history. A client whose editor state was
   replaced keeps pushing until its changes are confirmed, so switching notes right after
   typing loses nothing.
5. **Note events go to the Quick Notes window only** (`emit_to`), so note bodies never reach
   the main window or the clipboard popup, matching the command grants.
6. **No Rust-side save debounce.** `doc_push` writes the note row before it answers, so a quit
   has nothing to flush in Rust; each page only sends what it has not sent.

## Risks

- **Import** is the only step that can lose data. It is one transaction, guarded by the meta
  flag, and it leaves localStorage alone.
- **Offsets.** CM6 counts UTF-16 units, Rust strings are UTF-8, MCP counts characters.
  `docs/changes.rs` is the only place that converts, with randomized round-trip tests over
  astral characters.
- **Two panes on one note** used to share text by copying it. They are now two collab clients
  of the same document, so the other pane updates after the 150 ms push.
