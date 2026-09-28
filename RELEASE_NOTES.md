# Sodilaud v0.9.0

This release replaces the editor. Notes are edited in place with Markdown rendered as you write, and formatting is available from the keyboard and a toolbar.

## Highlights

- **Live, Source, and Reading modes.** The Edit / Split / Preview layout is replaced by three modes, switched with the icon buttons in the top bar. **Live** is the new default: Markdown syntax shows only on the lines your cursor or selection touches, while headings, emphasis, links, task checkboxes, and tables render in place. **Source** shows raw Markdown in a monospace font. **Reading** is the rendered, read-only view. The synced split preview is gone.
- **Formatting shortcuts.** `Cmd/Ctrl+B` bold, `Cmd/Ctrl+I` italic, `Cmd/Ctrl+Shift+X` strikethrough, `Cmd/Ctrl+E` inline code, `Cmd/Ctrl+K` link, `Cmd/Ctrl+Alt+1` to `6` headings, `Cmd/Ctrl+Shift+7`, `8`, and `9` numbered, bullet, and task lists, `Cmd/Ctrl+Shift+.` quote, and `Cmd/Ctrl+Alt+C` code block. Marks, headings, lists, and quotes toggle off when applied again, and each action is one undo step.
- **Formatting toolbar.** A button group left of the mode buttons, with a heading menu and buttons for code blocks, tables, and horizontal rules. Buttons that do not fit the window move into a "»" menu. The toolbar acts on the pane you last worked in and is unavailable in Reading mode.
- **Tables and links in Live mode.** Tables render as a formatted table until you click into one, which shows the raw pipe source for editing. On macOS, `Cmd`-click opens a link through the usual confirmation dialog (`Ctrl`-click on Windows and Linux); a plain click places the cursor. In Reading mode a plain click opens a link, as before.
- **Everything else carries over.** Compare mode, the two-note split view, find and replace, zoom and line spacing, line numbers, and the smart editing keys for lists, tables, indentation, and pair completion all work as before.

## Changed

- **Toggle Sidebar** moves from `Cmd/Ctrl+B` to `Ctrl+Cmd+S` on macOS (`Ctrl+Alt+S` on Windows and Linux), because `Cmd/Ctrl+B` now makes text bold.
- Remote images still never load. In Live mode only embedded `data:` images render; other images stay visible as Markdown source.

## Compatibility

- No changes to notes or workspaces. Notes, workspaces, and preferences carry over from v0.8.2.
- The saved layout preference is converted once: Edit and Split open in Live, Preview opens in Reading.
- Builds are not production-signed; macOS and Windows may display a security warning.
