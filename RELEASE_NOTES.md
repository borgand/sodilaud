# Sodilaud v0.18.0

More room for the document: focus mode and full width in the main window, sidebar tabs and resizable sidebars, a single title row on macOS, optional Vim keys, and `sodilaud --wait`.

## Highlights

- **Focus mode in the main window.** Cmd+Shift+F (Ctrl+Shift+F on Windows and Linux), or **Sodilaud menu → Focus Mode**, hides the sidebar, the formatting toolbar and the status bar, the same way Quick Notes does. Press it again to get your layout back.
- **Full Width.** A toolbar button turns the readable column width off, so wide tables and code use the whole window, and turns it back on. It is the same setting as **Appearance → Readable width**.
- **Sidebar tabs and widths.** The sidebar shows **Files** (open files and folders) and **Outline** as tabs, each with the full height; each window remembers its tab. Drag the edge of the sidebar or the comments panel to resize it, or focus the edge and use the arrow keys; a double-click puts back the default width.
- **One title row on macOS.** The toolbar is now the top strip of the window, with the file name small in it and the traffic lights at its left. Drag empty space in the row to move the window. Windows and Linux keep their native title bar.
- **Vim keys.** **Appearance → Vim keys** turns on Vim motions and commands in the file editor and Quick Notes, in Live and Source mode, with the mode shown in the status bar. App shortcuts keep working, and dead keys type as usual in insert mode. Off by default.
- **`sodilaud --wait`.** `sodilaud --wait FILE...` (or `-w`) returns only when every file it opened is closed in Sodilaud, for tools that wait for an editor. It needs Agent access On. Files without an extension Sodilaud opens, such as Git's `COMMIT_EDITMSG`, are not supported yet.
- **Copy a file's name or path.** Right-click a file in Open files or in the folder tree for **Copy File Name**, **Copy Full Path** and, inside a sidebar folder, **Copy Relative Path**.
- **Quick Notes matches the file editor.** Quick Notes gains an outline of the current note, and both windows count words and characters the same way: the totals, or the selection's while text is selected. "Saved" fades the same way in both.
- **Line numbers in Live mode** are dimmed, and a rendered table or diagram shows the number of its first source line instead of leaving a gap.

## Fixes

- A table in Live mode no longer jumps out of view or loses its column alignment when Quick Notes is hidden and shown again, or when focus leaves the editor and comes back.

## Compatibility

- Reinstall the command-line tool with **Command Line Tool…** to get `--wait`.
- The Outline in the main window is now a sidebar tab instead of a collapsible section under Open files.
- Notes, files, settings, workspaces and open windows carry over unchanged.
- Builds are not production-signed; macOS and Windows may display a security warning.
