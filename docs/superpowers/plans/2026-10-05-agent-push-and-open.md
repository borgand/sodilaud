# Agent push and open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the MCP tools `push_quick_note` and `open_document`, and remember agent access and per-tool permissions across restarts.

**Architecture:** A small `mcp_config.rs` reads and writes `mcp.json` in the app config dir. `mcp.rs` loads it at start (setup starts the listener when saved on), writes it on every toggle or permission change, and gains two tools. `push_quick_note` is a registry write in `docs/agent.rs` (find-or-create "From agents", then create the note, in one draft/commit) and then shows the Quick Notes panel without taking key focus and selects the note by ID. `open_document` validates the path with the file editor's rules, grants it and goes through the same route as Finder "Open With".

**Tech Stack:** Rust (Tauri 2, rmcp, serde_json), vanilla JS (notes.js), node:test + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-05-agent-push-and-open-design.md`

## Global Constraints

- Persistence file: `mcp.json` in the app config dir, shape `{ "enabled": bool, "permissions": { "<tool>": bool } }`, owner-only on Unix (`crate::restrict_to_owner`).
- Absent or damaged file = today's defaults: access off; reads on, writes off. A tool missing from the saved map gets the default for its kind.
- `push_quick_note` args: `requestId` (1-128 chars, same retry rules), `title` (1-200 chars after trim), `content` (0-100,000 UTF-8 bytes, default empty), `show` (default `true`). No `collectionId`.
- Target folder "From agents", matched case-insensitively; recreated if missing. Note goes below pinned notes. Result `{ note, revision, collectionId }` (plus the usual `ok`, `requestId`).
- `open_document` args: `path` (absolute). Extensions `.md`, `.markdown`, `.txt` after resolving symlinks. Size and UTF-8 rules from `files::io::read`. Result `{ path, name, bytes }`, no content. No `requestId`.
- Both new tools are write permissions, off until selected.
- No new crates. No version bump, no RELEASE_NOTES.md edit. Never use em dashes in new text.

## Review Focus

1. Push while the page has not yet applied the workspace change: the focus-by-ID event can arrive first. Expected: the note still gets selected once it appears (Task 4 test: focus for an unknown ID, then state with that ID).
2. Push into a collapsed "From agents" folder in the sidebar. Expected: the folder expands so the selected note is visible (Task 4 test).
3. Re-enabling access in the same session after disabling it. Expected: saved permissions come back, not the read-only defaults (Task 2 Rust test on `start` config handling and JS test).
4. A permission change whose file save fails. Expected: the change is not applied in memory and the page reverts (Task 2: `set_mcp_permissions` saves before applying).
5. A path that is a symlink named `.md` pointing at a `.json` file, or a directory named `x.md`. Expected: rejected (Task 6 tests).

---

### Task 1: `mcp.json` read/write

**Files:**
- Create: `src-tauri/src/mcp_config.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod mcp_config;`)

**Interfaces:**
- Produces: `mcp_config::FILE_NAME: &str = "mcp.json"`, `McpConfig { enabled: bool, permissions: BTreeMap<String, bool> }` (Serialize, Deserialize, Default, Clone, Debug, PartialEq), `load(&Path) -> McpConfig`, `save(&Path, &McpConfig) -> Result<(), String>`.

- [ ] **Step 1: Write the failing tests** in `mcp_config.rs`:

```rust
#[test]
fn a_missing_or_damaged_file_gives_defaults() {
    let directory = scratch("defaults");
    let path = directory.join(FILE_NAME);
    assert_eq!(load(&path), McpConfig::default());
    fs::write(&path, b"{").unwrap();
    assert_eq!(load(&path), McpConfig::default());
}

#[test]
fn saves_and_loads_owner_only() {
    let path = scratch("round-trip").join(FILE_NAME);
    let config = McpConfig { enabled: true, permissions: [("create_note".to_string(), true)].into() };
    save(&path, &config).unwrap();
    assert_eq!(load(&path), config);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
```

- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml mcp_config` - fails (module empty).
- [ ] **Step 3: Implement** following `files/store.rs` (`load` = read + `serde_json::from_slice(...).ok()` + `unwrap_or_default`; `save` = create parent dir, `to_vec_pretty`, `fs::write`, `crate::restrict_to_owner`). Fields carry `#[serde(default)]`.
- [ ] **Step 4:** rerun, PASS.
- [ ] **Step 5: Commit** `feat(mcp): read and write mcp.json`.

### Task 2: Remember access and permissions

**Files:**
- Modify: `src-tauri/src/mcp.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/quicknotes.json`, `src/notes.js`, `src/notes.html`
- Test: `src-tauri/src/mcp.rs` tests, `test/command-permissions.test.js`, `test/mcp-permissions.test.js`, new `test/mcp-remembered.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `fn saved_permissions(config: &McpConfig) -> HashSet<String>`: every READ/WRITE tool, value from the map or `READ_TOOLS.contains(tool)`.
  - `fn permission_map(enabled: &HashSet<String>) -> BTreeMap<String, bool>` over all tools.
  - `pub(crate) async fn start(app: &AppHandle) -> Result<McpConnectionInfo, String>` used by the command and by boot; it loads `mcp.json`, applies `saved_permissions`, binds, then saves `{ enabled: true, permissions }`.
  - `pub(crate) fn start_saved(app: &AppHandle)`: if `load(...).enabled`, `tauri::async_runtime::block_on(start(app))`; on error store it in `McpState.start_error` and print it.
  - `start_mcp_server` returns `McpStarted { #[serde(flatten)] connection, tools: Vec<String> }`.
  - `stop_mcp_server(app, state)` saves `enabled: false`, keeping the map.
  - `set_mcp_permissions(app, state, tools)` saves first, then applies.
  - New command `get_mcp_state() -> McpStatus { enabled: bool, tools: Vec<String>, error: Option<String> }` (camelCase).
  - JS: init calls `get_mcp_state`; toggle-on uses `tools` from `start_mcp_server`.

- [ ] **Step 1: Failing Rust test** in `mcp.rs`:

```rust
#[test]
fn saved_permissions_restore_choices_and_default_new_tools() {
    let defaults = saved_permissions(&McpConfig::default());
    assert_eq!(defaults, read_permissions());
    let config = McpConfig {
        enabled: true,
        permissions: [("get_note".into(), false), ("create_note".into(), true), ("unknown".into(), true)].into(),
    };
    let restored = saved_permissions(&config);
    assert!(!restored.contains("get_note"));
    assert!(restored.contains("create_note"));
    assert!(restored.contains("list_notes"), "a read missing from the map starts on");
    assert!(!restored.contains("append_to_note"), "a write missing from the map starts off");
    assert!(!restored.contains("unknown"));
    assert_eq!(saved_permissions(&McpConfig { enabled: true, permissions: permission_map(&restored) }), restored);
}
```

- [ ] **Step 2: Failing JS tests.** Add `"get_mcp_state"` to `NOTE_COMMANDS` in `test/command-permissions.test.js`. In `test/mcp-permissions.test.js` make `start_mcp_server` return `tools: reads` and change the final assertion's message to "reenabling access restores the tools Rust reports". New `test/mcp-remembered.test.js`:

```js
test("access that Rust started at launch shows as on with the saved permissions", async () => {
  const app = await bootApp({ handlers: {
    get_mcp_state: () => ({ enabled: true, tools: ["list_notes", "create_note"], error: null }),
    get_mcp_connection_info: () => ({ command: "/sodilaud", args: ["--mcp-stdio"] })
  } });
  assert.equal(document.getElementById("mcp-status").hidden, false);
  app.click("agent-access-config-btn");
  await settle();
  const selected = [...document.querySelectorAll("[data-mcp-tool]:checked")].map(i => i.dataset.mcpTool);
  assert.deepEqual(selected, ["list_notes", "create_note"]);
  assert.equal(document.getElementById("mcp-permission-create_note").disabled, false);
});
```

and a second file `test/mcp-start-failed.test.js` booting with `get_mcp_state: () => ({ enabled: false, tools: [], error: "Could not enable agent access on port 39393" })`, asserting the status stays hidden and opening Configuration shows the error text in `#mcp-permission-status`.

- [ ] **Step 3:** run both suites; they fail.
- [ ] **Step 4: Implement** Rust (as in Interfaces; `McpState` gains `start_error: std::sync::Mutex<Option<String>>`; `config_path(app)` = `app_config_dir().join(mcp_config::FILE_NAME)`); register `get_mcp_state` in `lib.rs`, `build.rs`, `capabilities/quicknotes.json`; call `mcp::start_saved(app.handle())` in setup after `docs::commands::start`. JS: in `init` after the workspace boot,

```js
async function loadMcpState() {
  try {
    const state = await invoke("get_mcp_state");
    mcpStartError = state?.error ?? null;
    if (!state?.enabled) return;
    isMcpEnabled = true;
    mcpPermissions = permissionsFrom(state.tools);
  } catch (error) {
    console.error("Could not read agent access state", error);
  } finally {
    updateMcpUiState();
  }
}
const permissionsFrom = tools => Object.fromEntries([...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS].map(tool => [tool, tools.includes(tool)]));
```

`openMcpConfigModal` shows `mcpStartError` while access is off. Toggle-on uses `permissionsFrom(connection.tools ?? [])`, clears `mcpStartError`, and keeps the existing notification when no write is enabled, else `Agent access enabled with ${n} write functions allowed`. `notes.html` permission description: "Changes apply immediately and are remembered, along with whether access is on. A new function starts off for writes and on for reads."
- [ ] **Step 5:** rerun `cargo test mcp::` and the JS suite; PASS.
- [ ] **Step 6: Commit** `feat(mcp): remember agent access and permissions across restarts`.

### Task 3: Registry push into "From agents"

**Files:**
- Modify: `src-tauri/src/docs/agent.rs`

**Interfaces:**
- Produces: `OPERATIONS` gains `"push_quick_note"`; `pub(crate) const AGENT_FOLDER: &str = "From agents"`. `Registry::agent_write("push_quick_note", args)` ignores `collectionId` and targets the open collection; returns `{ note (metadata, no content), revision, ok, collectionId, requestId }`.

- [ ] **Step 1: Failing test:**

```rust
#[test]
fn push_files_notes_under_from_agents_and_recreates_the_folder() {
    let (registry, _, path, id) = registry_with(&[note("a", "x", 1)]);
    let push = |request: &str, title: &str| registry.agent_write("push_quick_note",
        &json!({"requestId": request, "title": title, "content": "- run it"}));
    let first = push("p1", "Build steps").unwrap();
    assert_eq!(first["collectionId"], json!(id));
    assert!(first["note"].get("content").is_none());
    let state = registry.state().unwrap();
    assert_eq!(state.folders.len(), 1);
    assert_eq!(state.folders[0].name, AGENT_FOLDER);
    let created = state.notes.iter().find(|n| n.note.id == first["note"]["id"]).unwrap();
    assert_eq!(created.note.folder_id.as_deref(), Some(state.folders[0].id.as_str()));
    assert_eq!(first["revision"], json!(created.rev.to_string()));
    assert_eq!(push("p1", "Build steps").unwrap(), first);
    assert!(push("p1", "Other").unwrap_err().contains("different arguments"));
    push("p2", "Second").unwrap();
    assert_eq!(registry.state().unwrap().folders.len(), 1, "the folder is reused");
    // Owner renames it: the next push makes a new one.
    let folder = registry.state().unwrap().folders[0].clone();
    registry.agent_write("rename_folder", &json!({"collectionId": id, "requestId": "r",
        "folderId": folder.id, "expectedRevision": folder.rev.to_string(), "name": "Mine"})).unwrap();
    push("p3", "Third").unwrap();
    let names: Vec<_> = registry.state().unwrap().folders.iter().map(|f| f.name.clone()).collect();
    assert_eq!(names, vec!["Mine".to_string(), AGENT_FOLDER.to_string()]);
    std::fs::remove_file(path).unwrap();
}
```

plus a case-insensitive match (an existing folder "from agents" is reused) and pinned ordering (`insert_below_pinned`).
- [ ] **Step 2:** run, FAIL.
- [ ] **Step 3: Implement**: in `agent_write`, `let collection_id = if operation == "push_quick_note" { workspace.id.clone() } else { workspace.check(&collection_id)?; collection_id }`. In `apply`, a `"push_quick_note"` arm: draft, rev, find folder whose lowercased name equals `AGENT_FOLDER.to_lowercase()` or push a new `FolderEntry`, build the note like `create_note` with `folder_id: Some(...)`, `insert_below_pinned`, commit, return `json!({ "note": metadata(&note), "revision": rev.to_string() })`.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(notes): file agent pushes under a From agents folder`.

### Task 4: Show the panel quietly and select a note by ID

**Files:**
- Modify: `src-tauri/src/quicknotes/window.rs`, `src-tauri/src/quicknotes/commands.rs`, `src-tauri/src/platform/panel.rs`, `src/notes.js`
- Test: `test/quicknotes-panel.test.js`

**Interfaces:**
- Produces: `pub enum Focus { Title(String), Id(String) }`; `show(app, Option<Focus>)` (hotkey and `qn_show`, unchanged behaviour); `pub fn reveal(app, Focus)` shows the panel if hidden without making it key, then emits `quicknotes-focus-note` with `{ id }` or `{ title }`. macOS: `panel::order_front_passive(window) -> bool` (orderFrontRegardless, opaque, clickable, no makeKeyWindow). Elsewhere: `window.show()` without `set_focus`.
- JS: the focus listener selects by `payload.id` when present, else by title; an unknown ID is kept as `pendingFocusNoteId` and applied after the next workspace state that contains it; the note's folder is expanded.

- [ ] **Step 1: Failing JS test** appended to `test/quicknotes-panel.test.js` (two notes titled "Twin", ids `t1` and `t2`, are seeded in `NOTES` with `t2` in folder `f`, collapsed via `sodilaud_collapsed_folders`):

```js
test("an agent push selects its note by ID even when titles repeat or it arrives later", async () => {
  await app.emit("quicknotes-focus-note", { id: "t2" });
  assert.equal(app.storage.getItem("sodilaud_quicknotes_active_note"), "t2");
  await app.emit("quicknotes-focus-note", { id: "late" });
  assert.equal(app.storage.getItem("sodilaud_quicknotes_active_note"), "t2");
  app.registry.addNote({ id: "late", title: "Late", content: "Late" });
  await app.settle();
  assert.equal(app.storage.getItem("sodilaud_quicknotes_active_note"), "late");
});
```

(If the fake registry has no `addNote`, add one that inserts a note and calls `changed()`.)
- [ ] **Step 2:** FAIL. **Step 3: Implement** Rust and JS as above. **Step 4:** PASS (`cargo build`, JS suite).
- [ ] **Step 5: Commit** `feat(quicknotes): select a note by ID and show the panel without taking focus`.

### Task 5: `push_quick_note` MCP tool

**Files:**
- Modify: `src-tauri/src/mcp.rs`, `src/notes.html`, `src/notes.js`, `test/mcp-permissions.test.js`

**Interfaces:**
- Consumes: Tasks 2-4.
- Produces: `SodilaudServer { app: Option<tauri::AppHandle>, .. }`; `serve_local_connections` takes the `Option<AppHandle>`. `PushQuickNoteArgs { request_id, title, content: String (default), show: Option<bool> }`. WRITE_TOOLS gains `push_quick_note` and `open_document`. JS `MCP_WRITE_TOOLS` gains both; `notes.html` gets their checkboxes.

- [ ] **Step 1: Failing tests** in `mcp.rs`:

```rust
#[tokio::test]
async fn push_quick_note_is_gated_and_validated() {
    let (server, permissions, path) = server();
    let call = |args: serde_json::Value| server.push_quick_note(Parameters(serde_json::from_value(args).unwrap()));
    let off = call(json!({"requestId": "p", "title": "T"})).await.unwrap();
    assert_eq!(off.is_error, Some(true));
    permissions.write().unwrap().insert("push_quick_note".into());
    assert!(call(json!({"requestId": "", "title": "T"})).await.is_err());
    assert!(call(json!({"requestId": "p", "title": "  "})).await.is_err());
    assert!(call(json!({"requestId": "p", "title": "T", "content": "x".repeat(100_001)})).await.is_err());
    let pushed = call(json!({"requestId": "p", "title": "T", "show": false})).await.unwrap();
    assert_eq!(pushed.is_error, Some(false));
    std::fs::remove_file(path).unwrap();
}
```

and in the stdio socket test extend the tool-name list with `push_quick_note` and `open_document` and check both return `isError` while off. JS: add both tools to `writes` in `test/mcp-permissions.test.js`.
- [ ] **Step 2:** FAIL. **Step 3: Implement** the tool: permission check, requestId 1-128, title 1-200 after trim, content <= 100,000 bytes; `registry.agent_write("push_quick_note", ...)`; if `show != Some(false)` and `app` is set, `app.run_on_main_thread(move || window::reveal(&app, Focus::Id(id)))`. Update `get_info` instructions. `start` passes `Some(app.clone())`; tests pass `None`.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(mcp): add push_quick_note`.

### Task 6: `open_document` MCP tool

**Files:**
- Modify: `src-tauri/src/files/mod.rs`, `src-tauri/src/mcp.rs`

**Interfaces:**
- Produces in `files`: `FileErrorCode::Unsupported`; `FileError::not_absolute(path)`, `FileError::not_text(path)`; `pub fn agent_document(path: &str) -> Result<(PathBuf, u64), FileError>` (absolute check, canonicalize, extension of the resolved path, `io::read` for size and UTF-8, returns canonical path and byte length); `fn present_pending(app, Vec<String>)` split out of `open_from_system`; `pub fn open_for_agent(app, path: &str) -> Result<OpenedDocument, FileError>` returning `OpenedDocument { path, name, bytes }` (camelCase Serialize). Must present on the main thread.

- [ ] **Step 1: Failing tests** in `files/mod.rs`:

```rust
#[test]
fn an_agent_can_open_only_existing_absolute_text_files() {
    let directory = scratch("agent");
    let note = directory.join("Plan.md");
    fs::write(&note, "# Plan\n").unwrap();
    let (path, bytes) = agent_document(note.to_str().unwrap()).unwrap();
    assert_eq!((path, bytes), (note.canonicalize().unwrap(), 7));
    assert_eq!(agent_document("Plan.md").unwrap_err().code, FileErrorCode::Unsupported);
    assert_eq!(agent_document(directory.join("missing.md").to_str().unwrap()).unwrap_err().code, FileErrorCode::NotFound);
    let json = directory.join("data.json");
    fs::write(&json, "{}").unwrap();
    assert_eq!(agent_document(json.to_str().unwrap()).unwrap_err().code, FileErrorCode::Unsupported);
    fs::create_dir(directory.join("folder.md")).unwrap();
    assert_eq!(agent_document(directory.join("folder.md").to_str().unwrap()).unwrap_err().code, FileErrorCode::NotFound);
    #[cfg(unix)]
    {
        let link = directory.join("link.md");
        std::os::unix::fs::symlink(&json, &link).unwrap();
        assert_eq!(agent_document(link.to_str().unwrap()).unwrap_err().code, FileErrorCode::Unsupported);
    }
}
```

and in `mcp.rs` a gated test: `open_document` with permission off returns `is_error`; with permission on and `app: None` and a relative path returns `is_error` with the not-absolute text.
- [ ] **Step 2:** FAIL. **Step 3: Implement.** The tool checks permission, then `files::agent_document` (error -> `tool_error(message)`), then with an app: `files::open_for_agent`. Without an app: tool error "Opening documents needs the Sodilaud app". `open_for_agent` grants via `Files::grant`, then on the main thread runs the pending/show/emit steps shared with `open_from_system`.
- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(mcp): add open_document`.

### Task 7: Documentation

**Files:**
- Modify: `docs/mcp.md`, `README.md`, `ROADMAP.md`, `src/index.html` (Help, MCP pane), `docs/security/2026-09-25-audit-findings.md`, the spec (Status line and "Changes made during implementation").

- [ ] **Step 1:** `docs/mcp.md`: rewrite "Access is off each time Sodilaud starts" and the "Function permissions" defaults; add sections "Pushing a quick note" and "Opening a file in the main window". README: feature list counts, permissions paragraph, line 44 ("agents can ask the main window to open a file but cannot read files"). ROADMAP item 3 status and item 4 bullet. Help pane: defaults paragraph and two cards. Audit addendum dated 2026-10-05.
- [ ] **Step 2:** run the JS suite (help-menu and accessibility tests read `index.html`). **Step 3: Commit** `docs(mcp): document push_quick_note, open_document and remembered access`.

### Task 8: Mirror CI

- [ ] `npm run check`; `cargo fmt --check`; `cargo clippy --locked --all-targets -- -D warnings`; `cargo test --locked` (socket tests unsandboxed); `npm run check:egress`; JS suite with the Linux navigator preload. Fix and commit anything found (`fix(...)`/`style(...)`).
