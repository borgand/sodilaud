# Markdown editor surface and document model - design

Date: 2026-09-27
Status: design sketch, not implemented
Branch: `docs/editor-surface-design`
Roadmap: [`ROADMAP.md`](../../../ROADMAP.md)

## Intent

**What.** Two coupled decisions:

1. **Editor.** Replace the `<textarea>` editor and the separate `marked` preview pane with an
   inline live-preview editor. Candidates: CodeMirror 6 with live-preview decorations (CM6-LP),
   or a ProseMirror editor (Milkdown or Tiptap) that edits a document tree and serializes to
   Markdown at the boundary (PM).
2. **Document model.** Decide who owns a document's text: the webview that shows it (Shape A),
   or the Rust process (Shape B).

**Why.** Four planned features share one surface: "open this Markdown, wherever it came from,
in a full, floating or popover window, and let an agent work on it too."

1. Open external `.md` files and folders (replace Typora).
2. MCP: an agent opens a file on disk, or pushes ad hoc Markdown as a review pop-up.
3. A Quick Notes popover modeled on the clipboard popup (`⌘⇧V`), concurrent with the main window.
   **Priority:** the agent pushes short-lived notes here (build instructions, test fixtures)
   instead of putting them in chat history, the working tree, or gitignored files.
4. Agent co-editing: you and an agent edit the same document at the same time, with anchored
   comments the agent picks up. The approach is ported from Marginalia (`~/proged/marginalia`)
   but built separately: its own MCP tools, skill, `/sodilaud` command, and hook.

**Decisions.**

- **CM6-LP** for the editor. The document stays a string, and every source, subsystem and agent
  operation here works on strings.
- **Shape B** for every document, including workspace notes. Rust owns the text, and every
  window, plus the agent, is a client of it.

## Facts from the current code

| Fact | Where | Consequence |
|---|---|---|
| Editor logic is already pure `(value, selStart, selEnd) -> {value, selectionStart, selectionEnd}` functions | `editor-smart.js`, `editor-tables.js`, `editor-indent.js`, `editor-autocomplete.js`, `markdown-insert.js` | Ports to CM6 as commands through one adapter. PM positions are tree positions, so none of it ports |
| Only `applyEditorEdit(textarea, edit)` touches the DOM | `editor-edit.js` | That function becomes the CM6 adapter |
| The window owns the collection (`notes`, `folders`, `trash` in `main.js`). It autosaves the full note text 400 ms after typing stops (`scheduleNoteSave`) via `save_note_db` | `main.js:260`, `main.js:1406-1470` | Shape A today: snapshots, last write wins. Two authors cannot be merged |
| Rust already keeps a full copy of every note for MCP, but only while agent access is on | `update_mcp_note`, `main.js:2005` | Rust holding the text is not new, but today it is a mirror, not the owner |
| MCP writes are validated and applied in JS (receipts, revisions, folder rules) | `mcp-writes.js` | Under Shape B this logic moves to Rust |
| Without a connected workspace DB, notes live in `localStorage` | `main.js:409-494` | Shape B needs Rust-side storage for every workspace. The `localStorage` mode becomes a default SQLite DB in app data, with a one-time import (same pattern as the legacy stash adoption) |
| MCP offsets count Unicode code points. JS strings and CM6 positions are UTF-16. Rust `String` is UTF-8 | `docs/mcp.md`, CM6 | The registry must convert between three offset units. Keep it in one module with property tests |
| Each window is a separate WKWebView. The clipboard popup is created once, hidden, and its page is emptied instead of destroyed | `clipboard/popup.rs`, `clipboard/panel.rs` | Quick Notes reuses the warm-panel pattern |
| Capabilities are per window label | `capabilities/*.json` | Each surface kind gets its own capability file |
| No bundler; `src/` is served as-is under `script-src 'self'` | `package.json`, `tauri.conf.json` | CM6 needs a vendor bundle step (esbuild into `src/vendor/`), the same way `marked` is vendored |

## Editor: CM6-LP vs PM

### Multiple concurrent instances

| | CM6-LP | Milkdown | Tiptap |
|---|---|---|---|
| Bundle to parse per window (min, approx.) | ~350-450 KB | Largest (PM + remark/unified + ctx runtime) | PM + core + markdown extension |
| Instance creation | Sync. Parses incrementally, only as far as the viewport | Async. Parses the full doc through remark | Sync. Parses the full doc |
| Swapping the doc in a warm view | `setState`. Cost grows with visible lines | Recreate, or full re-parse | `setContent`, full re-parse |
| Collab protocol | `@codemirror/collab`: text-offset change sets that map directly onto the Rust string | `prosemirror-collab`: tree steps. Needs the same schema in Rust, and the steps don't map onto a string |

Per-window cost is dominated by the webview and is the same for both options (not measured
here). The difference that matters is swap cost in a warm popover.

### Content from outside the workspace

CM6 keeps the file's text. Syntax it doesn't recognise stays as text, and a file you only
viewed is never rewritten. PM re-serializes the whole file on the first edit. That produces
noisy git diffs in repos Sodilaud doesn't own. For notes, it also changes MCP revisions and
offsets without any user edit.

### Agent edits and comments

Agent edits arrive as `old_text -> new_text` hunks, which are string operations. CM6 applies
them as change sets. PM would first have to map each hunk onto tree positions. Comment anchors
are text ranges that get mapped through each accepted change set.

### What would force reconsidering CM6

1. Grid-table editing becomes a hard requirement (CM6 needs nested editors in a block widget).
2. The note model changes to blocks (block IDs, transclusion, databases).
3. Users must never see Markdown syntax (live preview reveals it at the cursor).
4. The spike finds WKWebView input problems (IME composition, dictation, autocorrect).

## Document model: Shape B everywhere

### Why B and not A, or a mix

The question is not whether text crosses to Rust; it already does, on every autosave. The
question is who is authoritative, and what gets sent:

- **Shape A** (today): the window is authoritative and sends snapshots ("here is the text").
  Two snapshots cannot be merged, so the last one wins.
- **Shape B**: Rust is authoritative, and clients send changes against a version ("apply this
  on version 17"). A stale agent edit is rebased around your typing, not dropped or allowed to
  clobber.

Solo editing costs the same as today: a debounced push of changes instead of a debounced push
of the full text.

A per-source split (B for files and drafts, A for notes) was rejected. Agent-pushed Quick Notes
are workspace notes. A Quick Note open in the popover and in the main window at the same time,
while the agent appends to it, has three writers. Having one model for everything also means no
document ever changes modes.

### Consequences

- Rust owns the workspace collection: notes, folders, trash, order, pins. `main.js` becomes a
  view that renders registry events and sends commands. This is the largest part of the change.
- `mcp-writes.js` validation, receipts and revision tracking move to Rust.
  MCP no longer relays to the main window, so agent access works while every window is hidden.
- `localStorage` mode is replaced by a default SQLite workspace in app data.
- Every editor surface is a `@codemirror/collab` client, even when it has no peers, so a
  surface never switches modes.
- Undo is per client. With collab, CM6 history does not revert the agent's changes or another
  window's changes.

### Module map

```
src-tauri/src/
  docs/
    registry.rs     DocKey -> Doc { text, version, recent updates, clients, comments }; accept/pull/subscribe
    changes.rs      CM6 ChangeSet JSON <-> text edits; UTF-16 / code point / byte offset conversion
    merge.rs        agent hunks (old -> new) -> ChangeSet: exact, whitespace-tolerant, fuzzy; user wins
    comments.rs     anchors { from, to, snippet, heading path }, mapped per update; orphans flagged, never dropped
    persist.rs      debounced saver per backend; atomic file writes; save status events
  store/
    workspace.rs    SQLite notes/folders/trash + comments table (grows from today's lib.rs DB code)
    files.rs        read/write/watch user-chosen paths; 3-way merge on external change (base = last synced)
    drafts.rs       app-data scratch for MCP drafts until promoted
  windows.rs        open_document router: main, "quicknotes" panel, "doc-*" windows
  mcp.rs            tools call registry directly (no relay through the main window)
src/editor/
  surface.js        mountMarkdownSurface(): EditorView + collab client + registry IPC
  extensions.js     buildExtensions(flavor)
  live-preview.js   hide markup outside cursor lines; inline widgets
  commands.js       adapters from the existing pure edit functions
  comments.js       margin gutter + range highlights from registry comment events
  search.js         find.js logic on SearchCursor
src/editor-smart.js, editor-tables.js, editor-indent.js, editor-autocomplete.js, markdown-insert.js
                    unchanged, tests keep running
agent/              shipped with the app, installed by a menu action (like Marginalia's installer)
  skills/sodilaud/  skill: when and how to open docs, push quick notes, run the co-edit loop
  commands/sodilaud.md
  hooks/sodilaud-hook.sh   PreToolUse: deny native Edit/Write on co-edited paths -> apply_edit
```

### Type sketch

```rust
pub enum DocKey { Note(String), File(PathBuf), Draft(Uuid) }

pub struct Doc {
    key: DocKey,
    text: String,
    version: u64,
    updates: VecDeque<Update>,  // bounded window of recent updates, for rebasing stale clients and agent base versions
    comments: Vec<Comment>,
    synced: String,             // last text persisted or read from disk; 3-way base for external changes
}

pub struct Update { client: ClientId, changes: ChangeSetJson }  // ClientId: Window(label) | Agent(session)

impl Registry {
    fn open(&self, key: DocKey) -> Result<Snapshot, Error>;                        // text + version + comments
    fn push(&self, key: &DocKey, base: u64, updates: Vec<Update>) -> Result<u64, Rejected>;  // collab: reject if base != version
    fn pull(&self, key: &DocKey, since: u64) -> Result<Vec<Update>, Error>;
    fn apply_agent_edit(&self, key: &DocKey, base: u64, hunks: Vec<Hunk>) -> EditOutcome;  // applied, or conflicts with current text
    fn comment(&self, key: &DocKey, op: CommentOp) -> Result<Comment, Error>;
}
```

```js
/** @typedef {"full" | "compact" | "review"} SurfaceFlavor */
/**
 * @typedef {object} MarkdownSurface
 * @property {(key: string | null) => Promise<void>} load   subscribe to a registry doc, setState from its snapshot
 * @property {() => Promise<void>} flush                    push unconfirmed updates (quit, panel hide)
 * @property {(cmd: SurfaceCommand) => boolean} run
 * @property {() => void} destroy
 */
export function mountMarkdownSurface(parent, key, { flavor }) { throw new Error("not implemented"); }
```

### Agent interface (new MCP tools, alongside the existing note tools)

| Tool | Purpose |
|---|---|
| `push_quick_note` | Create a note in the Quick Notes scope and optionally show the popover |
| `open_document` | Open a file path or note ID in a window. Registers it as co-edited |
| `read_document` | Text + version, recorded as the agent's merge base |
| `apply_edit` | `old_text -> new_text` hunks against a base version. Returns applied hunks and conflicts |
| `get_pending_comments` / `resolve_comment` | Long-poll the comment queue, then resolve with a note |

### Saving

Everything autosaves, with no toggle in the first version. Every copy (editor view, registry,
disk) should stay as close as possible, because other tools read the disk copy. The agent's
copy is stale by nature, and version-based merging handles that.

- Notes: SQLite, 400 ms after the last change (as today).
- Files: atomic write (temp file, then rename), 400 ms after the last change. Only changes
  trigger a write, so viewing a file never touches it. A watcher 3-way merges external changes.
- Drafts: app data until "Save as file" or "Save to workspace".
- Revert: undo, plus "Revert to version on disk" for files.
- If a toggle is ever needed, it is per file and forced on while an agent is attached.

## Open decisions

1. Comment storage for external files: Sodilaud app data keyed by path (default, writes nothing
   into your repos) or a sidecar file next to the document.
2. Quick Notes scope: a reserved folder in the main workspace, a separate workspace, or a tag.
3. MCP permissions for pushes: write tools are reset to off at every start, which blocks
   "put build instructions in a quick note" unless you re-enable them each session. Options:
   `push_quick_note` on by default because it can only create in the Quick Notes scope, or
   remembered per-tool permissions. This needs a security review against
   `docs/security/2026-09-25-audit-findings.md`.
4. Size of the registry's update window. An agent whose base version is older than the window
   falls back to hunk re-anchoring against the current text, which works but may produce more
   conflicts.

## Sequencing

See `ROADMAP.md`. In short: swap in CM6 on today's window-owned model first, so the registry
only ever has CM6 clients. Then move the collection into Rust, which adds collab. Quick Notes
and agent push build on that, and external files and co-editing with comments come last. Each
step ships on its own. The editor-swap decisions (view modes, reveal, tables) are recorded in
roadmap item 1.
