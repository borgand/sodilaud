# Agent co-editing with comments - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner and an agent edit one document (a file in the main window or a note in Quick
Notes) at once, with comments anchored to text that the agent picks up, addresses and resolves.

**Architecture:** Everything builds on `docs/collab.rs` `Collab`, which both notes (`Entry.collab`)
and files (`FileDoc.collab`) hold. `Collab` gains the document's comments, its merge bases and a
co-edited flag, and maps comments through every commit, so every write path (page pushes, agent
appends, disk merges, agent hunks) keeps anchors right without each caller doing it. A pure merge
engine (`docs/merge.rs`) locates agent hunks in a base snapshot and maps them through the updates
since. The registry exposes agent operations; `mcp.rs` wraps them as six tools behind the
persisted permission model. The page gets comment snapshots by event and keeps decorations mapped
locally with CodeMirror's own mapping, which `changes.rs` ports exactly so both sides agree.

**Tech Stack:** Rust (Tauri 2, rmcp 3.4, rusqlite, similar, sha2 already in Cargo.lock),
vanilla JS + CodeMirror 6 (`src/vendor/codemirror.js`), node:test + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-05-agent-coedit-design.md` (read with the A and B specs).

## Global Constraints

- Offsets: CM6 and comment anchors count UTF-16 units; MCP offsets count Unicode characters;
  only `docs/changes.rs` converts.
- Owner wins: an agent hunk whose range any non-base update touched is a conflict, never applied.
- Agent comments are never returned by `get_pending_comments`.
- `read_document` keeps the last 8 base texts per document; `apply_edit` takes 1-50 edits;
  `add_comment` body 1-2,000 chars; `resolve_comment` note 1-500 chars; `waitSeconds` 0-1,800.
- File comments: `comments/<sha256 of canonical path>.json` in app data, written 500 ms after a change.
- Reads default on (`list_documents`, `read_document`, `get_pending_comments`), writes default off
  (`apply_edit`, `add_comment`, `resolve_comment`).
- `--pretooluse-hook` exits 2 only when the path is co-edited; any error exits 0. No jq.
- Tests never touch the real `~/.claude` or the real app data dir: installers and stores take
  their directory as a parameter.
- No em dashes anywhere. No comments unless the why is non-obvious.
- `⌘⌥M` is `Mod-Alt-m` so it is Ctrl+Alt+M on Linux and Windows.

## Review Focus

1. An agent hunk next to (not inside) owner typing: must apply, owner text kept. Test: owner
   inserts at exactly the hunk's start and end; hunk applies, both insertions survive.
2. A comment whose whole range the agent rewrites by exactly replacing it: the comment follows
   the new text instead of orphaning. Test in comments mapping.
3. A long poll whose client disconnects: no comment is marked `sent`. Test with a cancelled token.
4. `~/.claude/settings.json` with other hooks and unknown keys: install keeps them, reinstall does
   not duplicate, remove leaves them. Invalid JSON is refused untouched. Integration tests.
5. Hook input that is not JSON, lacks `file_path`, names a relative or missing path, or a
   damaged `coedit.json`: exit 0. Hook unit tests.

---

## File structure

```
src-tauri/src/
  docs/changes.rs      + sections(), map_pos(), touches(), utf16<->byte/char helpers
  docs/merge.rs        NEW locate(base, old) and merge(base, since, edits) -> Outcome
  docs/comments.rs     NEW Comment model, anchor capture, headings, mapping, re-anchor, states
  docs/collab.rs       + comments, bases (8), co_edited; commit maps comments
  docs/coedit.rs       NEW registry agent operations: doc address, list/read/apply/add/resolve,
                       pending take + long-poll waiters, co-edited file set + coedit.json, mode
  docs/registry.rs     notes: load/save comments, events, trash clears co-edit
  docs/files.rs        files: load/save comments (500 ms), events, close clears co-edit
  docs/commands.rs     page commands for comments and co-edit state; events
  store/workspace.rs   comments table (migration) + load/save/delete
  store/comments.rs    NEW file comment JSON store
  hook.rs              NEW --pretooluse-hook
  integration.rs       NEW install/remove Claude Code files, settings merge
  mcp.rs               six tools, permissions, long poll
  mcp_config.rs        + holdForReview
  main.rs, lib.rs      dispatch hook flag; register commands; clear coedit.json at start/exit
src-tauri/resources/claude/sodilaud.md, SKILL.md   NEW bundled command and skill
src/
  editor-comments.js   NEW CM6 extension: ranges, gutter markers, composer, agent fade
  comments-panel.js    NEW drawer, shared by file-editor.js and notes.js
  doc-sync.js          + onRemote hook so agent updates can be highlighted
  file-editor.js, notes.js, index.html, notes.html, app.css/styles.css
test/
  editor-comments.test.js, comments-panel.test.js, file-comments.test.js,
  note-comments.test.js, mcp-coedit-permissions.test.js (JS)
docs/mcp.md, docs/coedit.md (NEW), README.md link, ROADMAP.md item 5
```

## Task 1: Change-set position mapping (`changes.rs`)

**Interfaces - Produces:**
- `pub(crate) fn sections(changes: &Value) -> Result<Vec<Section>, String>` where
  `Section { from: usize, to: usize, insert: usize }` in UTF-16 units of the old document,
  `insert` the UTF-16 length inserted; kept runs are omitted.
- `pub(crate) fn map_pos(changes: &Value, pos: usize, assoc: i8) -> Result<usize, String>`:
  CM6 `ChangeDesc.mapPos` semantics (Simple mode): a position at the start of a replaced range
  maps to the start of the insertion; inside a replaced range maps to its start (`assoc < 0`) or
  the end of the insertion (`assoc > 0`); a pure insertion at `pos` goes after it unless `assoc < 0`.
- `pub(crate) fn touches(changes: &Value, from: usize, to: usize) -> Result<bool, String>`: a
  deletion overlapping `[from, to)`, or an insertion strictly inside it.
- `pub(crate) fn utf16_of_byte(text, byte) -> usize`, `pub(crate) fn char_to_utf16(text, chars) -> Option<usize>`,
  `pub(crate) fn utf16_to_char(text, units) -> usize`.

- [ ] Step 1: tests: `map_pos` table cases mirroring CM6 (start of replace, inside, end, pure
  insert both assocs, past end errors); a randomized test that `map_pos` of every kept character
  lands on the same character after `apply`; `touches` cases (adjacent insert false, inside true,
  overlap delete true, disjoint false).
- [ ] Step 2: run `cargo test docs::changes`, see them fail.
- [ ] Step 3: implement by walking `sections`, porting CM6's loop:

```rust
for s in sections { // with kept gaps tracked as pos_a/pos_b
    if pos < s.from { return Ok(pos_b + (pos - pos_a)) }      // in a kept run
    pos_b += s.from - pos_a; pos_a = s.from;
    let len = s.to - s.from;
    if s.to > pos || (s.to == pos && assoc < 0 && len == 0) {
        return Ok(if pos == pos_a || assoc < 0 { pos_b } else { pos_b + s.insert });
    }
    pos_b += s.insert; pos_a = s.to;
}
```
- [ ] Step 4: tests pass. Step 5: commit `feat(docs): map positions through change sets`.

## Task 2: Merge engine (`docs/merge.rs`)

**Interfaces - Consumes:** Task 1. **Produces:**
- `pub(crate) struct Edit { old_text: String, new_text: String }` (serde camelCase).
- `pub(crate) enum Reason { NotFound, Ambiguous, EditedByOwner, OverlapsEdit }` (snake_case).
- `pub(crate) struct Conflict { index, reason, current_text }`.
- `pub(crate) fn locate(base: &str, old: &str) -> Result<(usize, usize), Reason>` UTF-16 range:
  exact unique; several exact = `Ambiguous`; else whitespace-tolerant (tokens joined by `\s+`)
  unique; else fuzzy: windows of the same line count (and +-1) whose character similarity
  (`similar` ratio) is >= 0.9, best unique (a tie = `Ambiguous`). Windows whose length differs by
  more than 20% are skipped; fuzzy is skipped for `old` over 20,000 chars.
- `pub(crate) fn merge(base: &str, current: &str, since: &[Update], edits: &[Edit]) -> Outcome`
  with `Outcome { applied: Vec<usize>, conflicts: Vec<Conflict>, changes: Option<Value> }`: each
  located range is checked with `touches` against every update in order, then mapped (`from`
  with assoc 1, `to` with -1); a touched range is `EditedByOwner` with the mapped region as
  `current_text`; ranges overlapping an earlier accepted one are `OverlapsEdit`; accepted ones
  become one change set over `current`.

- [ ] Step 1: tests: exact, ambiguous, whitespace-tolerant, fuzzy (one changed word in 3 lines),
  not found; owner typing elsewhere shifts the hunk; owner typing inside = conflict with current
  text; insertions exactly at the hunk edges survive; overlapping edits; astral characters.
  Property test (Lcg): random base, 1-3 non-overlapping hunks of unique substrings, 0-5 random
  owner updates; assert every applied hunk's mapped range in `current` equals the base text it
  located, the result equals `current` with those ranges replaced, and every character the owner
  inserted is still present in order.
- [ ] Step 2-4: fail, implement, pass. Step 5: commit `feat(docs): merge agent hunks around owner edits`.

## Task 3: Comment model and `Collab` co-edit state (`docs/comments.rs`, `collab.rs`)

**Produces:**
- `Author { Owner, Agent }`, `State { Held, Queued, Sent, Resolved, Open }` plus `orphaned: bool`
  (wire state is `orphaned` when set and not resolved).
- `Comment { id, author, state, orphaned, from, to (UTF-16), anchored_text, heading_path:
  Vec<String>, body, note: Option<String>, reply_to: Option<String>, created_at, updated_at }`.
- `anchor_at(text, from, to) -> (anchored_text, heading_path)`; `context(text, from, to) ->
  (before, after)` two lines each; `headings(text) -> Vec<Heading{level, text, offset(chars)}>`
  (ATX, skipping fenced code).
- `map_through(comments, changes, new_text)`: map `from` assoc 1 and `to` assoc -1; a collapsed
  range is re-anchored; otherwise `anchored_text` follows the text now in range.
- `reanchor(comment, text)`: stored offsets if the text there still matches; else nearest exact
  `anchored_text` to the old offset; else fuzzy (>= 0.9) within the same heading section; else
  orphaned with offsets clamped.
- `Collab`: `comments: Vec<Comment>`, `comments_rev: u64` (bumped on any change),
  `bases: VecDeque<(u64, String)>` (8), `co_edited: bool`; `commit` maps comments;
  `snapshot_base() -> u64`, `base(version) -> Option<&str>`, `since(version) -> Option<Vec<Update>>`.

- [ ] Steps: tests first (headings, context, mapping through edits around and inside, exact
  replacement follows, deletion re-anchors elsewhere or orphans, load-time re-anchor), implement,
  commit `feat(docs): anchored comments that follow every edit`.

## Task 4: Comment storage and registry wiring

- `store/workspace.rs`: `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, noteId TEXT NOT NULL, data TEXT NOT NULL)`;
  `load_comments(conn) -> HashMap<noteId, Vec<Comment>>`, `save_note_comments(conn, note_id, &[Comment])`
  (delete + insert in a transaction), `delete_note_comments(conn, ids)`.
- `store/comments.rs`: `file_path(dir, path) -> PathBuf` (sha256 hex of the canonical path),
  `load(dir, path) -> Vec<Comment>` (ignores a file whose `path` differs), `save(dir, path, &[Comment])`
  atomic, owner-only; an empty list removes the file.
- Notes: `Workspace::open` loads comments into entries and re-anchors; `apply_updates` and every
  commit that changed `comments_rev` saves that note's comments; restore reloads a note's
  comments; emptying trash deletes them. Trash and workspace switch drop co-edit state.
- Files: `file_open` loads comments (dir from `Registry.comment_dir`), re-anchors; a change
  sets `comments_due = now + 500 ms` served by the autosave thread (`file_next_due` returns
  `Due::Save | Due::Comments`); close writes pending comments.
- Sink: `comments(&CommentsEvent { doc, version, comments })` routed to the window that owns the
  doc. Emitted after the doc update that changed them.

- [ ] Steps: tests (round trip, migration on an old DB, re-anchor on open after an outside
  change, file JSON written after the delay and on close, file comments survive reopen),
  implement, commit `feat(docs): keep comments for notes and files`.

## Task 5: Agent operations and co-edit set (`docs/coedit.rs`)

**Produces (on `Registry`):**
- `DocRef { Note(note_id) | File(path) }` parsed from `{ path } | { noteId }` (path canonicalized,
  must be open).
- `coedit_list() -> Vec<Value>`; `coedit_read(doc, offset, limit) -> Value` (snapshots base,
  marks co-edited); `coedit_apply(doc, base_version, request_id, edits) -> Result<Value, String>`
  (`STALE_BASE` text when the base is unknown or older than the history); `coedit_add_comment(doc,
  anchor_text, occurrence, body, request_id)`; `coedit_resolve(id, note)`;
  `coedit_take_pending(doc: Option<DocRef>) -> Vec<Value>` (marks `sent`);
  `coedit_wait() -> Arc<tokio::sync::Notify>`; `listening` counter with a `coedit_state` event.
- Co-edited files: `HashSet<PathBuf>` mirrored to `coedit.json` (`{ "files": [...] }`) in app
  data; `open_document` adds, close/discard removes; cleared at start and exit.
- Receipts for `apply_edit`/`add_comment`: one map, 1,000 entries, fingerprint = arguments.
- Mode: `hold_for_review` (persisted in `mcp.json`). Owner commands: add (from a page version,
  mapped forward), edit/delete (until `sent`), resolve, reply, resend, send review (per doc),
  clear resolved.

- [ ] Steps: tests for each operation on notes and files, partial success, retries, stale base,
  owner-wins acceptance scenario (agent applies while owner pushes and adds two comments; both
  arrive in the next take), replies carry `replyTo`, resolving a reply resolves its parent,
  agent comments never pending. Commit `feat(coedit): agent operations on co-edited documents`.

## Task 6: MCP tools

- Six tools in `mcp.rs`, args structs with `deny_unknown_fields`, permission gate as the other
  tools, `READ_TOOLS` gains three, `WRITE_TOOLS` three. `get_pending_comments` takes the
  request's `CancellationToken`: loop { take; if any or deadline: return; select notified /
  deadline / cancelled }; check `is_cancelled()` before every take.
- JS: `MCP_READ_TOOLS`/`MCP_WRITE_TOOLS` in notes.js and checkboxes in notes.html.
- [ ] Steps: tests (gating, validation, read/apply round trip on a note, long poll wakes on a new
  comment, a cancelled poll takes nothing, `tools/list` count 21), commit `feat(mcp): co-editing tools`.

## Task 7: Pre-tool-use hook (`hook.rs`)

- `pub fn run_pretooluse_hook(identifier) -> i32` and testable `decide(input: &str, coedit: &Path) -> Option<String>`.
  main.rs dispatches `--pretooluse-hook` before Tauri; exit code 2 with the message on stderr.
- [ ] Steps: tests (co-edited path blocked, symlinked/relative path resolution, other path, bad
  JSON, missing file, damaged coedit.json), commit `feat(coedit): redirect native edits of co-edited files`.

## Task 8: Claude Code integration and bundled command/skill

- `integration.rs`: `plan(home, exe) -> Plan { changes: Vec<String>, installed: bool }`,
  `install(home, exe)`, `remove(home)`. Settings merge keeps every other key and hook, backs up
  to `settings.json.bak`, identifies its entry by `--pretooluse-hook`, preserves key order
  (`serde_json` `preserve_order`, indexmap is already in the lock file).
- Commands `coedit_integration_plan/install/remove` (Quick Notes window) using `dirs::home_dir()`.
- MCP Configuration: an "Claude Code integration" section listing the plan, Install/Update and
  Remove buttons.
- `resources/claude/sodilaud.md` and `SKILL.md` per the spec.
- [ ] Steps: tests on temp dirs only, commit `feat(coedit): install the Claude Code integration`.

## Task 9: Editor UI, main window

- `editor-comments.js`: `commentsExtension({ onCompose, onSelect })` with `setComments` effect
  (list of `{id, from, to, author, state}`), mapped `RangeSet` decorations (`cm-comment`,
  `cm-comment-agent`), gutter markers, inline composer widget (block widget under the selection's
  line; `Mod-Enter` submits, `Escape` cancels), `Mod-Alt-m` opens it, `agentFlash` effect + 2 s fade.
- `comments-panel.js`: `createCommentsPanel({ document, root, actions })` renders the drawer.
- `doc-sync.js`: `onRemote(client, transaction, updates)` so the extension can flash agent ranges.
- `file-editor.js`: placement policy (snapshot version vs synced version), commands, status-bar
  count, toolbar button, panel.
- [ ] Steps: jsdom tests, commit `feat(files): comment on files and see agent edits`.

## Task 10: Editor UI, Quick Notes

- Same extension on both panes; the panel follows the active pane's note; context menu entry.
- [ ] Steps: jsdom tests, commit `feat(quicknotes): comment on notes`.

## Task 11: Docs

- `docs/mcp.md` (tools, workflow, integration), `docs/coedit.md`, README link, ROADMAP item 5,
  spec "Changes made during implementation". Commit `docs(coedit): ...`.

## Task 12: Review and CI mirror

- Diff review against the spec; run every CI step; sandbox-off rerun of socket tests.
