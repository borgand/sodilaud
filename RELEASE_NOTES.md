# Sodilaud v0.16.0

Multiple windows, folders in the sidebar, tables you edit in their rendered form, comments in Reading mode, and documents styled by your theme.

## Highlights

- **Multiple windows.** Open another main window with **File → New Window** (Cmd+Alt+N, Ctrl+Alt+N on Windows and Linux), or right-click an open file and choose **Move to New Window** or **Move to Window**. Each window keeps its own open files, so a review book can stay in one window while you work in another. Unsaved edits, comments, the cursor and folded sections move with the file. Windows, their files and their positions come back after a restart.
- **Folders, CSV and drafts.** **Open Folder...** (Cmd+Shift+O) or **Show Folder in Sidebar** adds a folder to the sidebar's new Folders section, browsed one level at a time; hidden files, `node_modules` and anything in `.gitignore` stay out of the way. `.csv` and `.tsv` files open, and with `.txt` they open as plain text. Agents can push a draft for you to review with the new `push_draft` tool. Find and replace (Cmd+F), split view (Cmd+\\) and compare now work on files too.
- **Tables and code in their rendered form.** In Live mode, tables stay formatted while you type in a cell. Tab, Enter, the arrows and Escape move between cells, and Tab in the last cell or Enter in the last row adds a row. A Shift+arrow at a cell's edge, or a drag across cells, selects a rectangle you can copy (tab-separated), clear or comment on. Code blocks keep their header while you edit them, and Mermaid diagrams stay drawn when you click them. The pencil at a block's top right, or Cmd+Alt+E (Ctrl+Alt+E on Windows and Linux), shows its raw Markdown.
- **Comments on tables and in Reading mode.** Select text in any table cell and comment on it. In Reading mode, select text and press Cmd+Alt+M (Ctrl+Alt+M on Windows and Linux), use the Comment button, or click a review hunk's line number.
- **Documents styled by your theme.** Headings, code, tables, rules, links and muted text take their colours from the active theme, and themes can set them. Headings are larger, with a rule under H1 and H2. Appearance gains paragraph spacing, a readable column width, and body, heading and code fonts, with IBM Plex Serif and IBM Plex Mono bundled.
- **Quieter chrome.** The outline wraps long headings and marks the section you are reading. The active file has a thin accent bar. "Saved" fades after a moment, the file path shows on hover, the comment count appears only when there is something to show, and the status bar and gutter share the page background.

## Compatibility

- In Live mode a click on a link now opens it. Cmd-click (Ctrl-click on Windows and Linux) puts the cursor in the link to edit it.
- The readable column width is on by default, so wide windows show a centred text column. Turn it off in Appearance.
- Notes, files, settings and workspaces carry over unchanged.
- Builds are not production-signed; macOS and Windows may display a security warning.
