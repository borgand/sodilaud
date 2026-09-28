# Sodilaud v0.10.0

Sodilaud now has two halves: Quick Notes, a floating notepad one hotkey away, and a Markdown editor for the files on your disk.

## Highlights

- **Quick Notes.** Press `⌘⇧N` (`Ctrl+Shift+N` on Windows and Linux) in any app to show or hide your notes in a floating panel. It stays on top while you work in other apps and closes only when you ask: the hotkey again, `Cmd/Ctrl+W`, or its **×** button. On macOS it opens over full-screen apps without bringing Sodilaud to the front or changing your `⌘Tab` order. It reopens at the same size and place, on the note you had open. Everything your notes had carries over: folders, pins, search, trash, find and replace, split view, and compare.
- **Edit Markdown files.** The main window opens `.md`, `.markdown`, and `.txt` files with the same Live, Source, and Reading editor and formatting toolbar. Changes save automatically once a file has a name, and each open file keeps its own undo history. Open files from the start page, with `Cmd/Ctrl+O`, or from Finder with **Open With → Sodilaud**. Open files reopen at the next launch.
- **Your files, unchanged.** Saves are atomic and keep the file's permissions, byte-order mark, and CRLF line endings. Sodilaud never reformats a file. A file changed by another app reloads if you have not edited it, and asks **Reload** or **Keep mine** if you have.
- **A start page.** With no file open, the main window explains both halves of the app, offers New File and Open File, lists recent files, and links the Quick Notes Welcome note.

## Changed

- Notes moved from the main window to Quick Notes. The first launch after upgrading shows where they went.
- Agent access is turned on in the Quick Notes menu; the main window's **Sodilaud menu → Agent access…** takes you there. Agents keep working while the panel is hidden, and they cannot see your files.
- Themes, zoom, line spacing, syntax highlighting, and line numbers are set in the main window's menu and apply to both windows. Sidebar preview lines stay in the Quick Notes menu.
- `Cmd/Ctrl+N` creates a note in Quick Notes and a file in the main window. Help (`Cmd/Ctrl+/`) opens in the main window.
- On Windows and Linux, closing the main window quits Sodilaud after saving, since there is no menu-bar icon to keep it running. Opening a file while Sodilaud runs hands it to the running app.

## Limits

- Files must be UTF-8 text of at most 10 MB. A file that mixes LF and CRLF line endings is saved with LF once edited.
- Find and replace, split view, and compare work in Quick Notes but not yet on files. Folders cannot be opened yet.

## Compatibility

- Notes, folders, trash, and workspaces carry over unchanged.
- New settings files in the app's config directory, readable only by you: `quicknotes.json` (panel size and position, hotkey, windows open at quit) and `files.json` (open and recent files).
- Builds are not production-signed; macOS and Windows may display a security warning.
