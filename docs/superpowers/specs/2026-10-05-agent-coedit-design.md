# Agent co-editing with comments - design

Date: 2026-10-05
Status: implemented 2026-10-05 on `feat/agent-coedit`
Branch: `feat/agent-coedit` (stacked on `feat/files-registry`)
Roadmap: item 5 in [`ROADMAP.md`](../../../ROADMAP.md). Needs
[`2026-10-05-files-in-registry-design.md`](2026-10-05-files-in-registry-design.md) and uses
`open_document` from [`2026-10-05-agent-push-and-open-design.md`](2026-10-05-agent-push-and-open-design.md).
Ported from Marginalia (`~/proged/marginalia/docs/main-prd.md`, F1-F5), built separately:
no shared files, tool names, commands or state.

## Intent

**What.** The owner and an agent edit the same document at once. The owner selects text,
leaves a comment ("too vague, give concrete failure modes") and keeps reading, editing and
commenting. The agent picks comments up, rewrites the section, cross-checks the whole
document and edits other places for consistency, then resolves the comment with a one-line
note. Works for files in the main window and for notes in Quick Notes.

**Why.** Iterating on a spec through chat is slow: pinpointing text in prose is clumsy, and
turn-taking stops the owner while the agent works. Comments anchored to text are the right
address, and merging both parties' edits live removes the turn-taking.

**Done.** Marginalia's acceptance test, in Sodilaud: while the agent is applying an earlier
comment, the owner types in the same document and adds two more comments; nothing is lost,
the agent's edits land in the right places, and both new comments reach the agent without
the owner doing anything else. Plus:

- Comments survive app restarts and edits by either side; a comment whose text is gone is
  flagged as an orphan, never dropped.
- Claude Code's native Edit/Write on a co-edited file is redirected to `apply_edit`.
- Checks pass: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `npm run check`.

- An agent can open a document it generated and leave its own review comments on it to start
  the discussion. The owner answers in place, and only the answers reach the agent.

**Not done here.** Comments on code files, threads deeper than one reply, PTY/prompt injection (there is no terminal in Sodilaud to inject into).

## Decisions

| Topic | Decision |
|---|---|
| Document address | Every tool takes either `path` (absolute, a file open in the main window) or `noteId` (a note in the open collection) |
| Co-edited set | A document becomes co-edited when an agent calls `open_document` or `read_document` on it, and stops being co-edited when the owner closes it (files) or it is trashed (notes). Co-edited file paths are mirrored to `coedit.json` in app data for the hook |
| Merge base | `read_document` stores the text at the returned version (last 8 versions per document). `apply_edit` names one; an unknown version returns `STALE_BASE` |
| Merge engine | Per edit: locate `oldText` in the base text (exact and unique, then whitespace-tolerant, then fuzzy at similarity >= 0.9 over a window of lines); map that range through every update since the base; if an update from the owner touched the range, the edit is a conflict (**owner wins**); otherwise it applies. Edits that overlap each other are rejected. All applied edits go out as one update from client `agent`. Partial success is normal |
| Conflict result | `{ index, reason: not_found | ambiguous | edited_by_owner | overlaps_edit, currentText }`, where `currentText` is the mapped region as it is now, so the agent can retry without a full reread |
| Retries | `apply_edit` takes a `requestId`, with the receipt rules of the other write tools |
| Comment anchor | `{ from, to }` in UTF-16 units of the current text, plus `anchoredText`, `headingPath`, two lines of context before and after. Mapped through every update from any client |
| Re-anchoring | When a mapping collapses the range or the text no longer matches (an outside edit, a file changed while Sodilaud was closed): search `anchoredText` nearest the old offset; else fuzzy within the same heading; else status `orphaned`, kept with its snippet |
| Authors | Every comment has `author: owner | agent`. Agent comments come only from `add_comment`, are shown in the agent's color, and are **never** returned by `get_pending_comments` |
| Answering an agent comment | **Reply** on an agent comment creates an owner comment on the same range with `replyTo` set. It follows the normal states and dispatch, and reaches the agent with `replyTo: { id, body }` so the agent sees its own question next to the answer. One level only: an owner comment cannot be replied to. Resolving a reply also resolves its parent. The owner can resolve an agent comment directly (dismiss) |
| Comment states | Agent comments: `open`, `resolved`, `orphaned`. Owner comments: `held` (hold-for-review mode), `queued`, `sent` (returned to an agent), `resolved` (with the agent's note), `orphaned`. The owner can edit or delete a comment until it is `sent` |
| Dispatch | Pull. `get_pending_comments` long-polls up to `waitSeconds` (max 1,800) and returns queued comments, marking them `sent`. Two modes, global: **Send as I go** (default; new comments are `queued`) and **Hold for review** (`held` until **Send review (N)**) |
| Storage | Notes: `comments` table in the workspace SQLite DB (schema migration). Files: `comments/<sha256 of canonical path>.json` in app data (decided 2026-10-05), with the path inside, written 500 ms after a change. Comments are loaded and re-anchored when a document opens |
| Hook | `sodilaud --pretooluse-hook`: the app binary reads the hook JSON on stdin, checks `tool_input.file_path` against `coedit.json`, exits 2 with "This file is co-edited in Sodilaud. Use mcp__sodilaud__read_document and mcp__sodilaud__apply_edit." Fail-open on any error. No `jq` needed |
| Integration install | MCP Configuration → **Install Claude Code integration…**: shows what will change, then writes `~/.claude/commands/sodilaud.md`, `~/.claude/skills/sodilaud/SKILL.md`, and merges a PreToolUse hook (matcher `Edit|Write|MultiEdit`) into `~/.claude/settings.json` after a `.bak` copy. Reinstall updates in place; **Remove** reverses it |
| `/sodilaud [path]` | Optional path: `open_document`, then the long-poll loop from Marginalia's command (stop after 3 empty 30-minute polls). Per comment: `read_document`, edit the anchored section, **then reread the whole document and fix every other place the change affects** (terminology, cross-references, numbering, summaries), all through `apply_edit`, then `resolve_comment` with a one-line note naming the other places changed |
| Kickstart | `/sodilaud` and the skill describe it: generate or open the document, `add_comment` on the open questions, then enter the loop. Replies arrive through the loop like any comment |
| Skill | When to use which tool: present a file (`open_document`), throw-away output (`push_quick_note`), start a review with questions (`add_comment`), co-editing loop (`/sodilaud`). Never native Edit/Write on co-edited files |

## MCP tools

| Tool | Kind | Arguments | Result |
|---|---|---|---|
| `list_documents` | read | none | Open files and notes with comments: `{ path or noteId, name, version, coEdited, pendingComments }` |
| `read_document` | read | `path` or `noteId`, `offset`, `limit` (default 200,000 chars) | `{ version, content, headings[{level, text, offset}], comments[open ones], nextOffset }`. Marks the document co-edited |
| `apply_edit` | write | doc, `baseVersion`, `requestId`, `edits[{ oldText, newText }]` (1-50) | `{ applied[index], conflicts[], version }` |
| `get_pending_comments` | read | doc (optional), `waitSeconds` (0-1,800, default 0) | `{ comments[{ id, doc, headingPath, anchoredText, contextBefore, contextAfter, body, createdAt, replyTo? }], timedOut }`. Owner comments only |
| `add_comment` | write | doc, `anchorText` (exact, unique in the current text; else `occurrence`, 1-based), `body` (1-2,000 chars), `requestId` | `{ comment }`, author `agent`. Marks the document co-edited |
| `resolve_comment` | write | `id`, `note` (1-500 chars) | `{ comment }` |

Reading a file needs it open in Sodilaud (granted); `open_document` is the way in.

## Editor UI (both windows)

- **Add comment**: select text, then `⌘⌥M`, the toolbar comment button or the context menu.
  An inline composer opens under the selection; `⌘Enter` submits, `Esc` cancels. Typing
  elsewhere is never blocked.
- **In the text**: tinted range plus a gutter marker; orphans have no range.
- **Comments panel**: a right-hand drawer toggled from a status-bar count ("3 comments").
  Lists anchored snippet, author, body, state and the agent's note; click scrolls to the
  range. Agent comments have **Reply** and **Resolve**.
  Mode switch (Send as I go / Hold for review), **Send review (N)**, **Resend** on a `sent`
  comment, **Clear resolved**.
  An "Agent listening" dot shows while a `get_pending_comments` call is waiting.
- **Agent edits**: changed ranges get a highlight that fades over 2 s.

## Module map

```
src-tauri/src/
  docs/merge.rs        hunk location (exact, whitespace, fuzzy), mapping, conflicts
  docs/changes.rs      map_pos(changes, pos, assoc), touches(changes, from, to)
  docs/comments.rs     Comment, mapping per update, re-anchor, states, waiters (long-poll)
  docs/coedit.rs       co-edited set, base snapshots, coedit.json
  store/workspace.rs   comments table + migration
  store/comments.rs    file comment JSON store
  hook.rs              --pretooluse-hook mode (main.rs dispatches on the flag)
  integration.rs       install/remove Claude Code files and settings merge
  mcp.rs               five tools
  resources/claude/    sodilaud.md command, SKILL.md (bundled, versioned)
src/
  editor-comments.js   CM6 extension: highlights, gutter, composer, fade highlight
  comments-panel.js    drawer, used by file-editor.js and notes.js
```

## Risks

- **Mapping bugs** misplace an agent edit. Property tests: random owner edits interleaved
  with agent hunks; an applied hunk must replace exactly the text its `oldText` matched.
- **Long-poll lifetime**: the stdio relay must not time out held calls; a disconnect cancels
  the waiter before it takes any comment. A `sent` comment the agent never resolved can be put
  back to `queued` with **Resend** in the panel.
- **Writing into `~/.claude`**: only on explicit install, with a preview and a backup; the
  settings merge never removes other hooks.
- **Hook speed**: one small file read per Edit/Write call; measured under 20 ms.

## Changes made during implementation

1. **Owner wins against every newer change.** `apply_edit` reports `edited_by_owner` for any
   update since `baseVersion` that touched the edit's range: the owner's typing, a merged
   outside edit, or the agent's own earlier `apply_edit`. Only text that nobody changed since the
   agent read it is replaced. Text inserted exactly at either end of the range is not a touch.
2. **Ranges follow the editor's mapping exactly.** `docs/changes.rs` ports CodeMirror's
   `mapPos`, so Rust and the page place every range the same way (start maps forward, end
   backward). A comment whose text is edited inside keeps its range and takes the new text as
   `anchoredText`; an exact rewrite of its text carries it to the replacement. Re-anchoring runs
   only when a range collapses and when a document is opened.
3. **Orphan is a flag, not a state.** A comment keeps its state and gets `orphaned: true`, shown
   as `orphaned` until it is resolved, so it can be placed again on a later open. Orphans are not
   handed to agents.
4. **Send review is per document**, for the document the panel shows; the mode is global and is
   remembered in `mcp.json` as `holdForReview`.
5. **More owner actions.** The owner can resolve a `sent` comment as well as dismiss an agent
   comment, and can delete a resolved or orphaned comment (Clear resolved does it in bulk).
   Deleting a comment deletes its replies.
6. **Tool details.** `read_document` takes `limit` up to 200,000 characters and also returns
   `doc` and `totalLength`; its `comments` leave out held and resolved ones. `list_documents`
   also lists notes an agent read, without comments. `get_pending_comments` computes the context
   lines when the comment is taken, so they match the text the agent will read.
7. **`open_document` marks the file co-edited at once**, before the main window has opened it, so
   the hook protects it from the first call.
8. **Hook data.** `coedit.json` is `{ "files": [...] }` in the app data folder
   (`<data dir>/<identifier>`, which the hook finds without Tauri). It is emptied at launch and at
   quit; after a crash it is stale until the next launch.
9. **Integration.** The plan also reports whether an older install is present, so the button reads
   Install or Update. `serde_json`'s `preserve_order` feature is on, so `settings.json` keeps its key
   order. Claude Code must name the server `sodilaud`, since the command, skill and hook refer to
   `mcp__sodilaud__` tools.
10. **Context menu in Quick Notes only.** The main window has no editor context menu; there the
    toolbar button and the shortcut add comments.
11. **Replies are written in the panel**, under the agent's comment, rather than in the editor's
    composer.
12. **Agent highlight.** `doc-sync.js` applies remote updates one client's run at a time and calls
    `onRemote`, so only updates from client `agent` are highlighted. The vendored CodeMirror build
    now exports `gutter`.
13. **Page commands.** `comments_get`, `comment_add` (one `comment` argument), `comment_edit`,
    `comment_delete`, `comment_resolve`, `comment_resend`, `comments_send_review`,
    `comments_clear_resolved`, `coedit_get_state`, `coedit_set_hold` for both windows (each only for
    its own document kind), events `comments-changed` and `coedit-state`, and
    `coedit_integration_plan/install/remove` for Quick Notes.
14. **Merge integration fix.** The merge of project A into B left `files::agent_document` calling
    the removed `io::read`; it now reads with `io::read_bytes` and `io::decode_normalized`.
