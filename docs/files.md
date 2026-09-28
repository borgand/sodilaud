# Editing files

The main Sodilaud window edits Markdown and plain-text files on disk: `.md`, `.markdown` and
`.txt`. It uses the same editor as Quick Notes (Live, Source and Reading modes, the formatting
toolbar, and the smart editing keys), but files and notes never mix: files do not appear in
Quick Notes, in search, in trash, or to agents, and notes do not appear here.

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

Open files are listed in the sidebar; click one to switch to it, or its **×** to close it.
Each file keeps its own undo history while it is open. The files that were open when you quit
reopen at the next launch.

## Saving

Once a file has a location, every change is saved automatically 400 ms after you stop typing.
`Cmd/Ctrl+S` saves at once. A new file is not saved until you give it a name with
`Cmd/Ctrl+S` or Save As; closing it, or quitting, with text in it asks whether to save it
first.

Saving writes a temporary file next to the original and renames it into place, so a crash
leaves either the old or the new version, never half of each. The file keeps its
permissions, its byte-order mark if it had one, and CRLF line endings if it used them
throughout. Nothing else about the file changes: Sodilaud does not reformat Markdown, trim
whitespace or add a final newline. A file that mixes LF and CRLF line endings is saved with
LF once you edit it.

If a save fails (for example, the disk is full or the file became read-only), a bar above the
editor says so with **Try again** and **Save As…**, the file stays marked as unsaved, and a
quit is cancelled until it is saved.

## Changes made elsewhere

Sodilaud checks the open files for changes about once a second.

- **A file you have not edited** is reloaded quietly.
- **A file you are editing** shows "changed on disk while you were editing it", with
  **Reload** (take the version on disk) and **Keep mine** (save yours over it). Nothing is
  saved until you choose.
- **A file that was deleted or moved** shows "no longer on disk", with **Save As…** and
  **Close**. Nothing is saved to the old location.

Sodilaud's own saves are recognized and never reported as outside changes.

## Limits

- Text must be UTF-8. A file in another encoding is refused with a message, not opened as
  garbled text.
- Files larger than 10 MB are not opened.
- Find and replace, split view and compare are Quick Notes features for now; they do not work
  on files yet.
- Folders cannot be opened yet; open files one at a time.

## Access and privacy

The main window can read and write only the files you chose: through the Open or Save dialog,
through Finder or a launch argument, or in an earlier session (the open and recent lists, kept
in `files.json` in the app's config directory, readable only by you). Every file command
checks the path, after resolving `..` and symbolic links, against those choices, so the page
cannot name an arbitrary path. The Quick Notes window cannot use the file commands at all,
and MCP agents cannot see files.
