# Co-editing with an agent

You and an agent can work on the same document at once: a Markdown or text file open in the
main window, or a note in Quick Notes. You read, type and leave comments on passages; the
agent picks the comments up, edits the document around your typing, checks the rest of the
document for places the change affects, and resolves each comment with a one-line note.
Nothing waits for turns: you keep editing while the agent works.

Co-editing needs [agent access](mcp.md) on, with the write functions **Apply edit**, **Add
comment** and **Resolve comment** selected in **MCP Configuration**. The read functions it
uses (**List documents**, **Read document**, **Get pending comments**) start on.

## Commenting

1. Select the text the comment is about.
2. Press `Cmd+Option+M` (`Ctrl+Alt+M` on Windows and Linux), click the comment button at the
   right of the toolbar, or, in Quick Notes, right-click and choose **Comment**.
3. Type the comment in the box that opens under the selection and press `Cmd+Enter`
   (`Ctrl+Enter`). `Esc` cancels.

The commented text is tinted and marked in the margin. You can keep typing anywhere while the
box is open, including before the commented text; the comment stays on its text. Comments
from the agent are shown in a different color.

## The comments panel

The count in the status bar ("3 comments") opens the comments panel. It lists each comment
with the text it is on, who wrote it, its state and the agent's note. Click a comment to jump
to its text.

| State | Meaning | You can |
|---|---|---|
| Held for review | Waiting for **Send review** | Edit, Delete |
| Waiting for an agent | Queued; the next agent that asks gets it | Edit, Delete |
| Sent to an agent | An agent took it | Resend, Resolve |
| Open | A question from the agent | Reply, Resolve |
| Resolved | Done; the agent's note says what changed | Clear resolved |
| Text gone | Its text was deleted; the comment and its snippet are kept | Delete |

- **Send as I go** (the default) gives each comment to the agent as soon as you add it.
  **Hold for review** keeps them until you choose **Send review (N)**, so you can read
  through a whole document first. The choice is remembered.
- **Resend** puts back a comment an agent took but never resolved.
- **Reply** answers a question the agent left on your document. Only your answer goes to the
  agent, together with its question. Resolving the answer resolves the question too.
- The green **Agent listening** dot shows while an agent is waiting for comments.

Comments are kept across restarts. Comments on notes are stored in the workspace file;
comments on files are stored in Sodilaud's app data folder, not beside the file. When a file
changed while Sodilaud was closed, each comment is placed on its text again, or near it under
the same heading, or shown as **Text gone**.

## What the agent's edits look like

An agent's edit appears in the open editor like your own typing, briefly highlighted, without
moving your cursor or touching your undo history. Your typing always wins: if you changed the
text an agent was about to replace, its edit is not applied and the agent is told to read the
document again.

## Claude Code

In Quick Notes, open **MCP Configuration** and choose **Install Claude Code integration…**.
It lists what it will add and changes nothing until you choose **Install**:

- the `/sodilaud` command,
- the `sodilaud` skill, which tells Claude Code when to show you a file, push a quick note,
  open a review or co-edit,
- a hook that stops Claude Code from editing a co-edited file with its own Edit or Write tools
  and points it at Sodilaud instead. Your `~/.claude/settings.json` is copied to
  `settings.json.bak` first; other settings and hooks are kept.

Add Sodilaud to Claude Code as an MCP server named `sodilaud` (see [MCP agent
access](mcp.md#client-compatibility)). Then:

- `/sodilaud /path/to/spec.md` opens the file in Sodilaud and waits for your comments. It
  handles each one as it arrives and stops after about 90 minutes without comments.
- To have the agent start the discussion, ask it to review a document it wrote: it opens the
  file, leaves its questions as comments, and waits for your replies.

**Remove** in the same place takes out exactly what was installed.
