# Editing files

Main Sodilaud windows edit Markdown and plain-text files on disk: `.md`, `.markdown`, `.txt`,
`.csv` and `.tsv`. They use the same editor as Quick Notes (Live, Source and Reading modes, the
formatting toolbar, and the smart editing keys), but files and notes never mix: files do not appear in
Quick Notes, in search or in trash, and notes do not appear here. An agent can read or edit
a file only while it is open here, and only with the co-editing permissions on (see
[co-editing with an agent](coedit.md)).

## Opening and creating

| Action | Keys |
|---|---|
| New file | `Cmd/Ctrl+N` |
| Open a file | `Cmd/Ctrl+O` |
| Save | `Cmd/Ctrl+S` |
| Save As | `Cmd/Ctrl+Shift+S` |
| Close the file | `Cmd/Ctrl+W` |
| Show or hide the open files list | `Ctrl+Cmd+S` (`Ctrl+Alt+S` off macOS) |

The start page (shown when no file is open, or with **Sodilaud menu → Show Start Page**) has
**New File…** and **Open File…**, and lists the ten most recently opened files, newest first.
A recent file that is no longer on disk is shown struck through; clicking it removes it from
the list.

You can also open a file from Finder with **Open With → Sodilaud** or, once Sodilaud is the
default app for Markdown, by double-clicking it. On Windows and Linux, opening a file with
Sodilaud while it is already running hands the file to the running app instead of starting a
second one.

`.txt`, `.csv` and `.tsv` files open as plain text: no live preview and no Markdown keys (Enter
does not continue a list, Tab types a tab), and Reading shows the text as it is. `.md` and
`.markdown` files keep the full editor.

## Open from a terminal

On macOS and Linux, the `sodilaud` command opens files from a terminal:

```sh
sodilaud notes.md
sodilaud README.md docs/plan.md
```

It starts Sodilaud if it is not running, opens the files in the window you used last, and returns at
once. Relative paths are taken from the terminal's current folder. A file that does not exist
yet is created empty, but only in a folder that exists. Only `.md`, `.markdown`, `.txt`, `.csv`
and `.tsv` files are accepted; anything else is refused with a message and nothing is opened.

To install it, choose **Command Line Tool…** in the **Sodilaud menu** (on macOS also in the
application menu, under **About Sodilaud**). It writes a small script to
`~/.local/bin/sodilaud`; no administrator password is needed. If `~/.local/bin` is not on your
`PATH`, the dialog shows the line to add to your shell's startup file. Choose the same item
again to remove the command, or to update it after Sodilaud moved. A `~/.local/bin/sodilaud`
that Sodilaud did not write is never changed or removed.

On macOS, install it from Sodilaud in the Applications folder: the script opens that copy, the
same way Finder's **Open With** does. The command is not available on Windows.

Open files are listed in the sidebar; click one to switch to it, or its **×** to close it.
Each file keeps its own undo history while it is open. The files that were open when you quit
reopen at the next launch.

## Folders

**File → Open Folder…** (`Cmd+Shift+O`, `Ctrl+Shift+O` on Windows and Linux), the start page's
**Open Folder…**, and **Show Folder in Sidebar** (in the open files list's context menu for a
file) add a folder to the **Folders** section of the sidebar. Each window has its own folders;
they come back after a restart with the folders you had expanded. Remove a folder with its
**×** button ("Remove <name> from the sidebar"); nothing on disk changes.

A folder loads one level at a time, when you expand it. Click a file to open it. The tree shows
the five file types above and hides:

- names that start with a dot,
- `node_modules`,
- anything matched by a `.gitignore`, read from the top of the repository down to the folder.
  Matching covers the common patterns and is case-sensitive, so it is a subset of what Git
  itself understands.

Expanded folders update while they are open, so a file created or removed in a terminal shows
within about a second. At most 128 folders update live in all windows together. A folder with
more than 2,000 items lists the first 2,000 and shows "Some items are not shown." A folder that
was moved or deleted shows "Folder not found".

## Drafts

An agent can put a draft in front of you with `push_draft` (see [MCP](mcp.md)). It opens in the
window you used last with a **Draft** tag and a bar: "Draft from an agent. It stays in Sodilaud
until you save it." Edit it like any file, then choose:

- **Save As…** to give it a place on disk,
- **Save to Quick Notes** to move it into the **From agents** folder,
- **Discard** to delete it, after a confirmation.

Closing a draft does not lose it: it stays under **Drafts** on the start page until you save or
discard it. Drafts are kept in the app's data folder, readable only by you, and survive a
restart.

## Find, split view and compare

- **Find**: `Cmd/Ctrl+F`. **Find and replace**: `Cmd+Alt+F` on macOS, `Ctrl+H` on Windows and
  Linux.
- **Split view**: `Cmd/Ctrl+\` (or the toolbar button) opens a second file in a right pane. The
  same file may be open in both panes. Split view is not available in Reading mode.
- **Compare**: with two different files side by side, choose **Compare** in the toolbar to
  highlight removed text on the left and added text on the right.

In split view, Save, Save As and Close act on the pane that has focus.

## Windows

**File → New Window** (`Cmd+Alt+N`, `Ctrl+Alt+N` on Windows and Linux) opens another main
window, the same size as the current one and a little down and to the right. Each open file
belongs to one window, so a review book can stay in one window while you work in another.

To move a file, right-click it in the open files list (or press the Menu key, or `Shift+F10`)
and choose **Move to New Window**, or **Move to Window** and then a window. A file that has not
been saved yet must be saved first. Unsaved edits, comments, the cursor, the scroll position
and folded sections move with the file. The undo history does not.

Files opened from Finder, the `sodilaud` command or an agent open in the window you used last.
A file that is already open in another window is not opened twice: that window comes to the
front instead.

Closing a window saves its files and closes them; a file with a name that cannot be saved, or
an unsaved new file you do not discard, keeps the window open. Closing the last window works as
before. After a restart the windows come back with their files and positions.

## Saving

Once a file has a location, every change is saved automatically 400 ms after you stop typing.
`Cmd/Ctrl+S` saves at once. Saving happens in the app itself, not in the window, so a change
that reached it is written even if the window is busy. A new file is not saved until you give it a name with
`Cmd/Ctrl+S` or Save As; closing it, or quitting, with text in it asks whether to save it
first.

Saving writes a temporary file next to the original and renames it into place, so a crash
leaves either the old or the new version, never half of each. The file keeps its
permissions, its byte-order mark if it had one, and its line endings (LF or CRLF). Nothing
else about the file changes: Sodilaud does not reformat Markdown, trim whitespace or add a
final newline. A file that mixes LF and CRLF line endings is saved with the one most of its
lines use, and only once you edit it; opening a file never writes it.

Save As starts a fresh undo history for the file under its new name. When a file that already
had a name is saved under another one, edits made just before are saved to the old file too.

If a save fails (for example, the disk is full or the file became read-only), a bar above the
editor says so with **Try again** and **Save As…**, the file stays marked as unsaved, and a
quit is cancelled until it is saved.

## Changes made elsewhere

Sodilaud checks the open files for changes about once a second.

- **A file without unsaved changes** takes the new text quietly. Only the lines that changed
  are replaced, so the cursor, the scroll position and your undo history stay.
- **A file with unsaved changes** gets the outside edit merged in when the two touched
  different lines: both changes stay, and the result is saved. Your typing is never lost or
  undone, and undo takes back only your own changes.
- **A file where both sides changed the same lines** keeps your text and shows "changed on
  disk while you were editing it", with **Reload** (take the version on disk) and **Keep mine**
  (save yours over it). Nothing is saved until you choose.
- **A file that was deleted or moved** shows "no longer on disk", with **Save As…** and
  **Close**. Nothing is saved to the old location.

Sodilaud's own saves are recognized and never reported as outside changes.

## Limits

- Text must be UTF-8. A file in another encoding is refused with a message, not opened as
  garbled text.
- Files larger than 10 MB are not opened.
- A folder lists at most 2,000 items, and at most 128 folders update live.

## Access and privacy

A main window can read and write only the files you chose: through the Open or Save dialog,
through Finder or a launch argument, or in an earlier session (the open and recent lists, kept
in `files.json` in the app's config directory, readable only by you). Every file command
checks the path, after resolving `..` and symbolic links, against those choices, so the page
cannot name an arbitrary path. The Quick Notes window cannot use the file commands at all,
and MCP agents cannot see files.

A window may list the folders in its own sidebar. No MCP function lists folders. A file in a
folder is granted when you open it from the tree, with the same checks as any other file.
