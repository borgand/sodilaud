# Sodilaud v0.11.0

Agents can now work with you in Sodilaud: show you a file, drop a note into Quick Notes, and edit a document alongside you while you comment on it.

## Highlights

- **Co-edit with an agent.** Select text in a file or a note and press `⌘⌥M` (`Ctrl+Alt+M` on Windows and Linux) to leave a comment. An agent running `/sodilaud` picks it up, edits the document while you keep reading and typing, and resolves the comment with a note on what it changed. Your typing always wins: an agent edit to text you changed meanwhile is handed back to the agent, never applied over yours. Agent edits show with a short highlight.
- **Comments panel.** Comments stay anchored to their text as either of you edits, and are kept across restarts. Send them as you go, or switch to **Hold for review** and send a batch with **Send review**. **Resend** puts a comment back in the queue. A comment whose text is gone is marked, never dropped.
- **Agents can start the review.** An agent can open a document it wrote and leave its own questions. **Reply** answers one; only your answer goes to the agent, with its question attached.
- **Agent push.** An agent can put a note into Quick Notes, in a **From agents** folder, for throw-away output such as commands to run. The panel shows it without taking keyboard focus.
- **Agent open.** An agent can open a `.md`, `.markdown` or `.txt` file in the main window for you to read.
- **Outside edits merge.** When another program changes a file you have open, Sodilaud merges the change into the editor: your cursor, unsaved typing and undo history stay. Only when both of you changed the same lines does it keep your text and ask **Reload** or **Keep mine**.
- **Claude Code integration.** MCP Configuration can install a `/sodilaud` command, a `sodilaud` skill, and a hook that stops Claude Code's own Edit and Write on a co-edited file while Sodilaud runs with agent access on. **Remove** takes them out again.

## Changed

- Agent access and its permissions are remembered across restarts. If access was on when you quit, it is on again at launch with the same choices. A function added in a new release starts on if it reads and off if it writes.
- Both windows' menus have the same **Agent access** section: the On/Off toggle and **MCP Configuration…**. A change in one window shows in the other at once. The main window's status bar shows **MCP listening** too.
- Notes live in the app instead of the Quick Notes page, so agents work even before the panel has loaded, and an agent's edit reaches an open note without disturbing your typing.
- Notes are stored in `default.sqlite` in the app data directory. The first launch copies the notes from 0.10's local storage once and leaves local storage as it was.
- Sodilaud, not the window, autosaves open files.
- New MCP tools: `push_quick_note`, `open_document`, `list_documents`, `read_document`, `apply_edit`, `get_pending_comments`, `add_comment`, `resolve_comment`. The write tools start off; enable them in MCP Configuration.

## Limits

- The `/sodilaud` command and the hook expect the MCP server to be named `sodilaud` in Claude Code.
- The hook calls the Sodilaud you installed it from. After moving or reinstalling Sodilaud, choose **Update** in MCP Configuration.
- Find and replace, split view, and compare work in Quick Notes but not yet on files. Folders cannot be opened yet.

## Compatibility

- Notes, folders, trash, and workspaces carry over. A workspace file gains a `comments` table the first time 0.11 opens it.
- Going back to 0.10 finds the notes as they were before the upgrade; notes created or changed in 0.11 are not in 0.10's local storage.
- New files, readable only by you: `default.sqlite` and a `comments` folder in the app data directory, and `mcp.json` in the config directory. Also in the app data directory: `coedit.json`, the list of co-edited file paths that the Claude Code hook reads.
- Installing the Claude Code integration writes to `~/.claude` (`commands/sodilaud.md`, `skills/sodilaud/SKILL.md`, and a hook in `settings.json`, after saving `settings.json.bak`). Nothing is written there unless you choose Install.
- Builds are not production-signed; macOS and Windows may display a security warning.
