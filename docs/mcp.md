# MCP agent access

Sodilaud includes an MCP stdio mode in the desktop executable. There is
no separate server executable or runtime to install. Open Quick Notes, then its menu
(top right) **→ Agent access → On** while the app is running. The main window's
**Sodilaud menu → Agent access…** opens it for you. Choose **MCP Configuration** to
copy connection values and select function permissions. Configuration is also
available while access is off; copying it does not start the server.

Sodilaud remembers whether access is on. If it was on when Sodilaud quit, it
starts again at launch, before any window opens, with the same function
permissions. If it cannot start (another application holds the port, say),
access stays off and MCP Configuration shows why. Access is off on a new
installation. Disabling it stops access and disconnects active MCP sessions.
Enable it before starting or reconnecting the client; clients do not all retry
a server that was unavailable at startup.
The accent-colored **MCP listening** indicator appears beside the save status
while access is enabled. It indicates that the server is listening, even when no
client is connected. Hover it to see the enabled read and write counts.

## Client compatibility

Use a client that supports launching a local MCP server over stdio. Enter the
values shown in the configuration dialog as follows:

| Client field | Value |
| --- | --- |
| Transport | stdio (sometimes called local or command) |
| Command | The displayed absolute path to the Sodilaud executable |
| Arguments | `--mcp-stdio`, as a single argument |
| Environment variables | None required |
| URL, headers, bearer token | None required |

The dialog provides copy buttons and a generic JSON example using the actual
executable path. A typical configuration has this shape; substitute the command
shown by your installation and adapt the surrounding keys to your client:

```json
{
  "mcpServers": {
    "sodilaud": {
      "command": "/Applications/Sodilaud.app/Contents/MacOS/sodilaud",
      "args": ["--mcp-stdio"]
    }
  }
}
```

The command is an executable path, without shell quoting or arguments appended
to it. On macOS, point to the executable inside the installed `.app`, not the
`.app` directory or `open`. On Windows, use the installed `.exe`; JSON requires
backslashes to be escaped (the copied example handles this). On Linux, use the
installed executable. For AppImage installations, the dialog uses the outer
`.AppImage` path when available, avoiding the temporary mounted executable.
Moving or reinstalling Sodilaud at a different location requires updating
the command.

The client launches a background instance of the same binary. This instance
does not open a window, load note storage, or automatically enable access. It
relays MCP messages to the running app, whose notes registry owns the open
collection. Agents therefore work whether or not the Quick Notes panel is on
screen, and even before its page has loaded.
Multiple clients can connect independently. Diagnostics go to stderr; stdout
contains only MCP messages. Closing the client's input or disabling access
ends the background instance. Reconnect the client after restarting Sodilaud
or re-enabling access.

This replaces the earlier Streamable HTTP configuration: remove the old URL
and authorization header and configure a local stdio server instead. Clients
that accept only remote URLs cannot use this mode. A cloud-hosted connector
cannot launch a local executable. Packaged `.mcpb` distribution is a separate
packaging task; this implementation does not generate a bundle.

## Read tools

| Tool | Result |
| --- | --- |
| `list_folders` | Folder ids, names, revisions, and assigned-note counts |
| `list_notes` | Note metadata, folder names, and short previews |
| `search_notes` | Literal, case-insensitive title and Markdown search |
| `get_note` | One character-addressed chunk of a note's Markdown content |
| `list_trash` | Deleted-note IDs, titles, original folder metadata, and deletion times |
| `list_documents` | Files open in the main window and notes with comments, with versions and waiting comments |
| `read_document` | The live text of an open file or a note, with its version, headings and comments |
| `get_pending_comments` | Your comments that wait for an agent, optionally waiting up to 30 minutes for one |

List and search calls accept `limit` and `offset` and return `nextOffset` when
another page exists. `get_note` returns at most 20,000 characters by default;
follow its `nextOffset` until `truncated` is false. These offsets count Unicode
characters, not UTF-8 bytes. The three co-editing reads are described in
[Co-editing documents](#co-editing-documents). `list_notes` and `search_notes` also accept an
optional `folderId`. Omit `folderId` to include every folder, pass a folder ID
to filter to that folder, or pass `null` to include only top-level notes.

### Function permissions

The Agent access section of the Quick Notes menu contains only the global
**Agent access On/Off** toggle and **MCP Configuration**. Configuration
is always available: while access is off, you can copy connection details without
starting the server. Permission controls become available when access is enabled.
Open Configuration to choose individual functions in the **Read** and **Write**
sections. Each section has a **Select all** checkbox; a partially selected
section shows a mixed state.

On a new installation, all eight read functions are enabled and all thirteen write
functions are disabled. Select specific write functions or **Select all write
functions** to allow them. Read functions can also be disabled individually.
Changes apply immediately to connected clients without reconnecting. Disabled
tools remain discoverable but reject calls. Failed permission updates restore
the previous choices and show an error in Configuration.

Sodilaud keeps your choices, and whether access is on, in `mcp.json` in its
app configuration directory (owner-only on macOS and Linux). They survive
disabling access and restarting the app. A function added in a later version
starts enabled if it reads and disabled if it writes. Content replacement and
permanent deletion are not exposed.

## Creating notes and folders

Both tools require `collectionId` from a current read result and a unique
`requestId` (1–128 characters). Reuse the **same request ID and arguments** when
retrying after a timeout or lost response. Successful retries return the original
result without creating another item. Reusing a key with different arguments
is rejected.

| Tool | Other arguments | Result |
| --- | --- | --- |
| `create_note` | Required `title`; optional `content` (empty by default), `folderId` (top level by default) | Saved `note`, including generated ID |
| `create_folder` | Required `name` | Saved `folder`, including generated ID |

Titles and folder names must contain 1–200 characters after trimming; content
is limited to 100,000 UTF-8 bytes, within the overall 256 KiB request limit.
Folder names follow the sidebar's whitespace, duplicate-name, and reserved-name
rules. Unknown folder IDs are rejected. Explicit note titles are locked against
automatic title generation; created notes start unpinned. New items appear in
the sidebar without changing the selected note or editor focus.

Example (replace the collection ID with one from `list_folders`):

```json
{
  "name": "create_note",
  "arguments": {
    "collectionId": "<current collection ID>",
    "requestId": "research-note-001",
    "title": "Research findings",
    "content": "# Findings\n\nFirst observation."
  }
}
```

### Persistence and concurrency

Every write is checked, saved to the workspace database and only then applied to
the collection, all in one step inside the app. A write that fails to save
changes nothing and returns an error; retry it with the same ID and arguments.
New items then appear in the sidebar. Writes and the user's edits are applied in
the order they reach the app, so neither overwrites the other.

A write for a collection that is no longer open is rejected. Disabling a
permission rejects later calls to that function. A response timeout does not
cancel a write: its outcome is unknown, so retry with the same ID and arguments.

Retry receipts are held for the current collection session, across client
reconnects and access toggles. Switching/opening a workspace (including a
cancelled switch attempt) or restarting the app changes `collectionId`; old
requests are rejected. Up to 1,000 distinct write requests are retained per
collection session. At that limit, new requests are rejected without evicting
old retry keys; reopen the collection to begin a new session. After a session
change, inspect existing notes before resubmitting an old write with an unknown outcome.

Write tools are marked idempotent and closed-world. Deletion tools have
`destructiveHint: true`; the other write tools have it set to false. All writes have
`readOnlyHint: false`. Each permission toggle applies to all authenticated local clients.

## Appending to existing notes

Select **MCP Configuration → Write → Append to note**. This permission is
independent of **Create note** and **Create folder** and is off until you
select it.

1. Call `get_note` and retain its `collectionId`, note `id`, and `revision`.
2. Call `append_to_note` with those values as `collectionId`, `noteId`, and
   `expectedRevision`, plus a unique `requestId` and the `content` to append.
3. Include your own separating newlines; the tool appends the supplied text
   exactly. Each append accepts 1–100,000 UTF-8 bytes.

```json
{
  "name": "append_to_note",
  "arguments": {
    "collectionId": "<from get_note>",
    "requestId": "meeting-followup-001",
    "noteId": "<note id>",
    "expectedRevision": "<from get_note>",
    "content": "\n\n## Follow-up\nNew observation."
  }
}
```

Revision tokens are opaque and cover the whole note: content, title,
modification time, pin state, title-lock state, and folder assignment. The
editor sends the user's typing to the app about 150 ms after it stops, so a
revision reflects everything typed until shortly before the read. Tokens stay
stable while the note is unchanged and expire across collection sessions. When
reading a note in chunks, restart the read if the revision changes between chunks.

The app checks the expected revision before applying any text. A conflict
changes nothing: reread the note and decide whether to submit a new append. The
append preserves the title and other metadata and advances the modification
time. Line breaks are stored as `\n`.

An accepted append reaches every editor showing the note as a change from
another writer, like a collaborator's: the user's cursor, selection, scroll
position and focus stay where they were, and typing that had not reached the app
yet is kept and placed around the appended text. Undo in the editor reverts only
the user's own changes, never the agent's. Success is returned after the note is
saved; the response includes the saved `note` metadata and its `revision`. Read
content through paginated `get_note` calls. Later user edits can make that
returned revision stale.

If saving fails, nothing is appended and the tool returns the error. Retry the
same `requestId` with identical arguments. A note deleted by the user is never
recreated by retrying an append. Successful retries return the original result.

## Renaming and moving

Enable each tool separately in **MCP Configuration → Write**, or select all write
functions. These permissions start off alongside the other write permissions.
All three tools require the current `collectionId`, a unique `requestId`, and an
`expectedRevision` read before making the change.

| Tool | Revision source | Other required arguments | Behavior |
| --- | --- | --- | --- |
| `rename_note` | `get_note` | `noteId`, `title` | Sets and locks the title against automatic generation |
| `move_note` | `get_note` | `noteId`, `folderId` | Moves to an existing folder; explicitly pass `null` for top level |
| `rename_folder` | `list_folders` | `folderId`, `name` | Changes the folder name while preserving its ID and assigned notes |

Renames accept 1–200 characters after trimming. Folder names follow the sidebar's
whitespace normalization, case-insensitive duplicate, and reserved-name rules.
Moving to a missing folder is rejected; the destination must be
supplied explicitly. Note changes preserve content, pin state, and selection,
and advance the modification time. Folder renames preserve note revisions and
folder order. Folder revisions cover the name, remain stable when membership
changes, and expire when the collection changes.

```json
{
  "name": "move_note",
  "arguments": {
    "collectionId": "<from get_note>",
    "requestId": "organize-note-001",
    "noteId": "<note id>",
    "expectedRevision": "<from get_note>",
    "folderId": null
  }
}
```

This example moves to the top level using JSON `null`, without quotes. To move
into a folder, replace `null` with a quoted destination ID from `list_folders`.
The schema requires `folderId` and accepts a string or null; omitting it is an
error, and the string `"null"` is not a top-level destination.

Revisions, permissions, target existence, destination existence, and folder-name
availability are checked before anything changes. Conflicts change nothing;
reread the target before deciding on a new request. Changes are saved in one
database transaction with folder-reference validation, then appear in the
sidebar; success is returned after saving.

Responses include saved `note` metadata or `folder` data plus the new `revision`.
If a save fails, nothing changes; retry identical arguments with the same request
ID. Deleted targets are never recreated by retries. Successful retries return the
original result; later edits may have made its revision stale. The same session
and retry limits as the other write tools apply.

## Deleting and recovering notes

`delete_note` moves a note to persistent trash. It requires `collectionId`, a
unique `requestId`, `noteId`, and the current `expectedRevision` from `get_note`.
`delete_folder` requires `collectionId`, `requestId`, `folderId`, and the current
`expectedRevision` from `list_folders`. Each has a separate permission that starts
off. Revisions and permissions are checked before anything changes.

Folder deletion through MCP is **empty-only**. Pinned notes still count as
members of their underlying folder. Move all assigned notes elsewhere first;
there is no cascading deletion. Empty folders are removed directly and can be
recreated. The existing sidebar folder-delete action continues to move its notes
to the top level.

A deleted note's trash entry retains its full Markdown, ID, title, pin and title
lock state, original folder ID/name, and deletion time. If the last active note
is deleted, Sodilaud creates a blank note at the top level. Sidebar and
right-click note deletion use the same recovery path as MCP.

A deletion commits active notes, folders, and trash in one database transaction,
so a note is always either active or in the trash. A failed deletion changes
nothing; retry the **same request ID and identical arguments**, including the
original revision. A retry never deletes a note that the user has subsequently
restored. The usual collection-session retry limits apply.

`delete_note` returns the deleted note's trash metadata under `trash`, including
the trash entry `id` and original `noteId`. `delete_folder` returns `folderId`.
`list_trash` returns `collectionId`, `collectionName`, a `trash` metadata array,
and `nextOffset`. It accepts `limit` (1–200, default 50) and `offset`, and lists
newest entries first. This read permission starts enabled along with the other
read functions. Trashed note bodies are not exposed through `list_trash`,
`get_note`, or search.

The **trash icon at the right of the status bar** opens a list with Restore
buttons. Restoration preserves content, title, pin and title-lock state and
returns the note to its original folder, or to the top level if that folder no
longer exists. It advances the modification time to invalidate old revisions.
It refuses to overwrite an active note with the same ID.

Right-click the trash icon (or use Shift+F10 while it is focused) and choose
**Empty Trash…** for a confirmation. Cancel is focused by default. Only the
entries present when confirmation opened are selected; notes deleted while it
is open are retained. Emptying trash is permanent. Trash is scoped to the local
notes or the connected workspace database and survives restarts. There is no
automatic expiry.

**MCP exposes no restore, empty, purge, or permanent-delete function.** Agents
can list trash metadata and move active notes into it; only the user can restore
notes or empty trash through the UI.

## Pushing a quick note

Select **MCP Configuration → Write → Push quick note**. `push_quick_note` puts a
note into Quick Notes for you to pick up later: a list of commands to run, or the
output of a chat that has no project to save into. It needs no earlier read and
no `collectionId`; the note goes into the collection open in Sodilaud.

| Argument | Rule |
| --- | --- |
| `requestId` | Required, 1-128 characters. Reuse the same ID and arguments when retrying |
| `title` | Required, 1-200 characters after trimming. Locked against automatic title generation |
| `content` | Optional Markdown, at most 100,000 UTF-8 bytes. Empty by default |
| `show` | Optional, `true` by default |

The note goes into a folder named **From agents**, below any pinned notes.
Sodilaud finds the folder by name, ignoring case, and creates it on the first
push, or again if you deleted or renamed it. Pushed notes do not expire.

With `show` left on, the Quick Notes panel appears with the new note selected.
It does not take keyboard focus: you keep typing in the app you were using. If
the panel is already showing, it only selects the note.

The result contains `note` (metadata without content), its `revision` and the
`collectionId`, so the agent can follow up with `append_to_note` if that
permission is also selected.

```json
{
  "name": "push_quick_note",
  "arguments": {
    "requestId": "build-steps-001",
    "title": "Build steps for plan 5",
    "content": "1. npm ci\n2. npm run tauri build"
  }
}
```

## Opening a file in the main window

Select **MCP Configuration → Write → Open document**. `open_document` takes one
argument, `path`: the absolute path to an existing `.md`, `.markdown` or `.txt`
file. Sodilaud opens it in the main window, as Finder's **Open With** does, and
brings the window forward. Opening a file that is already open switches to it.

The file editor's rules apply: the file must be UTF-8 text of at most 10 MB.
Relative paths, folders, missing files and other file types are rejected,
including a symbolic link whose target has another extension. The result is
`{ path, name, bytes }`: the resolved path, the file name and its size. It does
not contain the file's text. The resolved path follows symbolic links (on macOS,
`/tmp/x.md` comes back as `/private/tmp/x.md`); use it in later calls.

Opening a file grants the main window access to that one file, like opening it
yourself, and makes it co-edited (see below). No MCP tool lists folders. Reading
the file's text needs the separate **Read document** permission.

## Co-editing documents

You and an agent can edit the same document at once: a file open in the main
window, or a note in Quick Notes. You select text and leave a comment; the
agent picks it up, edits the document while you keep typing, and resolves the
comment with a one-line note. See [Co-editing with an agent](coedit.md) for
the editor side.

Every co-editing tool names its document with exactly one of `path` (the
absolute path of a file open in Sodilaud) or `noteId` (a note in the open
collection). A file must be open: `open_document` is the way in.

| Tool | Kind | Arguments | Result |
| --- | --- | --- | --- |
| `list_documents` | read | none | `{ documents[{ path or noteId, name, version, coEdited, pendingComments }] }` |
| `read_document` | read | document, `offset`, `limit` (1-200,000 characters, default 200,000) | `{ version, content, totalLength, nextOffset, headings[{ level, text, offset }], comments[] }` |
| `apply_edit` | write | document, `baseVersion`, `requestId`, `edits[{ oldText, newText }]` (1-50) | `{ applied[index], conflicts[{ index, reason, currentText, matches?, hint }], version }` |
| `get_pending_comments` | read | document (optional), `waitSeconds` (0-1,800, default 0) | `{ comments[], timedOut }` |
| `add_comment` | write | document, `anchorText`, `occurrence` (from 1), `body` (1-2,000 characters), `requestId` | `{ comment }` |
| `resolve_comment` | write | `id`, `note` (1-500 characters) | `{ comment }` |

**Reading.** `read_document` returns the text as the editor shows it, including
typing from moments ago, and its `version`. Offsets count characters. It also
remembers that text (the last eight versions per document) as the base for
`apply_edit`, and makes the document co-edited. `comments` lists the comments
an agent may act on, with `id`, `author`, `state`, `anchoredText`,
`headingPath`, `offset`, `body` and the resolve `note`.

**Editing.** `apply_edit` takes replacements written against the text read at
`baseVersion`. Sodilaud finds each `oldText` in that text (exactly and once;
else ignoring how whitespace is laid out; else a window of lines at least 90%
alike), carries its place through everything typed since, and applies every edit
it can as one change, which open editors show with a short highlight. You win:
an edit whose text you changed since `baseVersion` is not applied. Each one that
did not apply comes back in `conflicts` with a `reason`:

| Reason | Meaning |
| --- | --- |
| `not_found` | `oldText` is not in the base text; `currentText` holds the closest lines in the document, or is empty when nothing is close |
| `ambiguous` | `oldText` matches more than one place; `matches` says how many when it is an exact repeat |
| `edited_by_owner` | The text was changed after `baseVersion`; `currentText` holds it as it is now |
| `overlaps_edit` | It overlaps an earlier edit in the same call |

Every conflict also has a `hint`, one sentence on how to retry. Partial success
is normal: reread and retry what conflicted. A `baseVersion`
Sodilaud no longer keeps fails with `STALE_BASE`; call `read_document` again.
Retrying with the same `requestId` and arguments returns the first result.

**Comments.** `get_pending_comments` returns your comments that are waiting,
oldest first, and marks them sent. Each has `id`, `doc` (`{ path }` or
`{ noteId }`), `headingPath`, `anchoredText`, two lines of `contextBefore` and
`contextAfter`, `body` and `createdAt`; an answer to an agent's question also has
`replyTo: { id, body }`. With `waitSeconds` the call waits until a comment
arrives or the time is up (`timedOut: true`). While it waits, an **Agent
listening** dot shows in the editors. A client that disconnects while waiting
takes nothing. The agent's own comments never come back from this tool.

`add_comment` puts an agent comment on `anchorText`, which must occur exactly
once in the current text unless `occurrence` picks one. Use it to open a review:
you answer in place, and the answers arrive through `get_pending_comments`.
`resolve_comment` marks a comment addressed with a note shown in the comments
panel; resolving an answer also resolves the question.

Some clients stop a tool call after a fixed time. A client that cuts off a
30-minute wait earlier simply calls again; set its MCP tool timeout higher (in
Claude Code, the `MCP_TOOL_TIMEOUT` environment variable, in milliseconds) to
avoid the extra calls.

### Claude Code integration

**MCP Configuration → Claude Code integration → Install Claude Code
integration…** lists what it will change and writes nothing until you choose
**Install**:

- `~/.claude/commands/sodilaud.md`: the `/sodilaud [path]` command. It opens the
  file, then waits for your comments and handles each one: read, edit through
  `apply_edit`, reread the whole document to fix every other place the change
  affects, and resolve with a note. It stops after three empty 30-minute waits.
- `~/.claude/skills/sodilaud/SKILL.md`: when to present a file, push a quick
  note, open a review with questions, or co-edit.
- A PreToolUse hook in `~/.claude/settings.json` for `Edit|Write|MultiEdit`,
  added after copying the file to `settings.json.bak`. Other settings and hooks
  are kept. The hook runs `sodilaud --pretooluse-hook`, which refuses a native
  edit of a co-edited file and tells Claude Code to use `read_document` and
  `apply_edit`. Any error lets the edit through.

Name the MCP server `sodilaud` in Claude Code, since the command and the hook
refer to its tools as `mcp__sodilaud__...`. Installing again updates the files
in place; **Remove** takes out exactly what was installed.

A file is co-edited from the moment an agent opens, reads or comments on it
until you close it; Sodilaud lists those files in `coedit.json` in its app data
folder for the hook, and empties the list when it quits. A note is co-edited
until it is trashed or the collection changes.

## Live data and privacy boundary

The app's notes registry owns the collection and serves MCP. A connected agent
can therefore read the local notes or an open portable workspace, and it sees
keystrokes about 150 ms after typing stops, once the editor has sent them.
Switching collections updates what the server exposes.

The background instance connects to an internal TCP channel on
`127.0.0.1:39393`. This is not an HTTP endpoint. Each connection must authenticate
before MCP messages are accepted. Sodilaud manages the secret in its app
configuration directory; clients do not need it in their configuration. On
Unix it is created with owner-only permissions. Authentication is bounded by a
timeout, and the app limits simultaneous connections and incoming messages
(256 KiB per message). The channel cannot be reached directly from another
computer, but processes running as your user can
still obtain local app data. The menu toggle grants access to local agents as
a group; there are no separate permissions per client.

Sodilaud itself does not send notes anywhere. The agent or MCP client you
connect can send tool results—including note contents—to its model provider.
Enable access only when needed and under a client's privacy terms you accept.

With **Open document** selected, an agent can make Sodilaud open any text file
you can read and learn its size. With **Read document** also on (it is a read
function, so it starts on), it can then read that file's text. Comments on files
are kept in Sodilaud's app data folder, not beside the file; comments on notes are
kept in the workspace file.

Agents can search the full text of every note in the open collection, so do not keep
tokens, passwords or other secrets in a collection you expose to them. The optional macOS
[clipboard history](../docs/clipboard-history.md) feature is never part of what MCP
serves: it is not referenced by the MCP server or the notes registry, and only the
clipboard popup window, never the main window or an agent, can read entry contents.

Sodilaud has no update checker and makes no outbound request. MCP does not
expose update-check or installation tools. See [Storage and privacy](../README.md#storage-and-privacy)
for the network behavior.
