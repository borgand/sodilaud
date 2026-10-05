# Agent push and open - design

Date: 2026-10-05
Status: implemented
Branch: `feat/mcp-push-open`
Roadmap: item 3 (agent push) and the `open_document` part of item 4 in
[`ROADMAP.md`](../../../ROADMAP.md). Sibling specs:
[`2026-10-05-files-in-registry-design.md`](2026-10-05-files-in-registry-design.md),
[`2026-10-05-agent-coedit-design.md`](2026-10-05-agent-coedit-design.md).

## Intent

**What.** Two MCP tools and persistent agent-access settings:

1. `push_quick_note`: an agent drops a throw-away note into Quick Notes (a list of commands to
   run, the output of a chat that has no project to save into) and the panel shows it.
2. `open_document`: an agent opens an existing `.md`, `.markdown` or `.txt` file in the main
   window so the owner can read it there.
3. Agent access and per-tool permissions are remembered across restarts.

**Why.** The owner connects agents to Sodilaud daily. Presenting work in Sodilaud must not
need the owner to re-enable access and write tools after every start.

**Done.**

- An agent calls `push_quick_note`; the note appears in a "From agents" folder and the panel
  shows it without stealing keyboard focus from the app in front.
- An agent calls `open_document` with an absolute path; the main window opens or switches to it.
- After a restart, access is on again if it was on at quit, with the same permissions.
- Checks pass: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `npm run check`.

**Not done here.** Reading a file's text back through MCP, editing it, and comments (spec C).
MCP drafts (an agent's unsaved Markdown in a review window) stay on the roadmap.

## Decisions

| Topic | Decision |
|---|---|
| Persistence | `mcp.json` in the app config dir: `{ enabled, permissions: { tool: bool } }`, owner-only on Unix. Written whenever the toggle or a permission changes. Absent file = today's defaults (off; reads on, writes off) |
| Start-up | If `enabled`, Rust starts the listener during setup with the saved permissions, before any page loads. A bind failure leaves access off and shows the existing error in MCP Configuration |
| Tools added later | A tool missing from the saved map gets the default for its kind: reads on, writes off. Both tools here are writes, so they start off until selected |
| `push_quick_note` arguments | `requestId` (required, same retry rules as other writes), `title` (1-200 chars), `content` (0-100,000 bytes), `show` (default `true`). No `collectionId`: it always targets the open collection, so a chat agent with no prior read can call it |
| Target folder | "From agents", found by exact name (case-insensitive). Created on first push, or again if the owner deleted or renamed it. The note goes below pinned notes like `create_note`. No auto-expiry |
| Showing | `show: true` shows the panel non-activating (as the hotkey does) and selects the new note by ID. The panel already supports focus by title; this adds focus by ID so duplicate titles cannot pick the wrong note |
| Result | `{ note, revision, collectionId }`, so the agent can follow up with `append_to_note` |
| `open_document` arguments | `path` (absolute). Extension must be `.md`, `.markdown` or `.txt`, matching the Finder handler. Size limit and UTF-8 rule are the file editor's (`files::io`) |
| `open_document` behaviour | Canonicalize, grant (`Files::grant`), then the same route as Finder "Open With" (`open_from_system`): pending list, show main window, `file-open-request` event. Opening an already-open file switches to it |
| `open_document` result | `{ path, name, bytes }`. No content: reading is spec C's `read_document`, behind its own permission |
| `open_document` guard | Its write permission only, as decided 2026-10-05. Relative paths, directories, symlinks resolving to other extensions and missing files are rejected with the file editor's error text |
| Idempotency | `open_document` is naturally idempotent and takes no `requestId` |

## Module map

```
src-tauri/src/
  mcp.rs              two tools; permission persistence load/save; start at boot
  mcp_config.rs       mcp.json read/write (new, small; tests for missing/damaged file)
  docs/agent.rs       push_quick_note: find-or-create folder + create note in one draft/commit
  files/mod.rs        open_from_system split so MCP can call it and get the granted path back
  quicknotes/window.rs show(app, Focus::Id | Focus::Title)
  lib.rs              start MCP at setup when saved enabled
src/
  notes.js            focus-by-id event; permission UI lists the two new tools
  notes.html          two permission checkboxes
docs/mcp.md           new sections; "Access is off each time Sodilaud starts" rewritten
```

## Security

The audit (`docs/security/2026-09-25-audit-findings.md`) treated "off at every start" as a
mitigation. Remembering the toggle means a listener can be up without the owner having touched
it this session. Mitigations kept: localhost only, token auth, the visible **MCP listening**
indicator, every write tool off until chosen. `open_document` can make Sodilaud open any text
file the owner can read, but it returns no content; reading needs spec C's permission. The
audit file gets a dated addendum recording this change.

## Testing

- Rust: `mcp.json` round trip, damaged file gives defaults; permission set restored at start;
  push creates the folder once, reuses it, recreates it after deletion; retry with the same
  `requestId` returns the same note; open rejects relative, missing, wrong-extension paths.
- MCP socket test: `tools/list` includes both tools; both reject while their permission is off.
- JS: focus-by-id selects the right note when two notes share a title.
- Manual: push with the panel hidden, while typing in another app (focus must stay there).

## Changes made during implementation

1. **Page learns the state from Rust.** A new command, `get_mcp_state`, tells the Quick Notes
   page whether access is on, which functions are enabled and why a remembered start failed.
   `start_mcp_server` also returns the restored function list, so re-enabling access in the
   same session brings back the saved choices instead of the read-only defaults.
2. **Saving.** A permission change that cannot be written to `mcp.json` is refused and the
   page restores the previous choices. A failed write when access is toggled is logged and
   the toggle still takes effect.
3. **New error texts.** The file editor had no error for a relative path or a non-text
   extension, so `FileError` gained `Unsupported` with two messages for those cases. Missing
   files, folders, non-UTF-8 and oversized files keep the file editor's texts.
4. **Focus without key.** On macOS the panel is ordered in without becoming key. On Windows
   and Linux the panel is shown without `set_focus`; whether the window manager still
   activates it is up to the platform.
5. **Selecting the pushed note.** The ID can reach the page before the note does, so the page
   keeps the request until a state containing the note arrives. It also expands the note's
   folder if it was collapsed.
6. **Retries.** `show` is not part of a push's retry fingerprint: retrying with a different
   `show` returns the original note.
