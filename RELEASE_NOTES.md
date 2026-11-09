# Sodilaud v0.17.0

Keep files that belong together in a window of their own: move several open files at once, name windows, and let agents open files in a named window.

## Highlights

- **Move several files at once.** In the Open files list, Cmd-click (Ctrl-click on Windows and Linux) adds or removes a file and Shift-click selects a range. Right-click the selection and choose **Move N Files to New Window**, **Move N Files to Window** or **Close N Files**. The files land in one window together, with their unsaved edits, comments, cursor and folded sections, and the new window shows the file you were reading.
- **Named windows.** **File → Name Window…** gives the current window a name. It shows in the title bar and in other windows' **Move to Window** menu, and it comes back after a restart.
- **Agents pick the window.** The MCP tools `open_document` and `push_draft` take an optional `window` name. Files opened with the same name share one window, created on first use, and a file already open elsewhere moves there. The review-book skill uses this, so a review book opens in a window of its own.

## Compatibility

- Notes, files, settings, workspaces and open windows carry over unchanged.
- Agents that do not pass `window` see no change: files still open in the window you used last.
- Builds are not production-signed; macOS and Windows may display a security warning.
