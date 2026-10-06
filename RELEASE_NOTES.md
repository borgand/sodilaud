# Sodilaud v0.13.0

Open files from a terminal with `sodilaud notes.md`, and tables keep dates and IDs on one line.

## Highlights

- **`sodilaud` command.** Run `sodilaud notes.md` in a terminal to open a file in the main window. Sodilaud starts if it is not running, and the command returns at once. Relative paths resolve from the terminal's folder, and a missing `.md`, `.markdown` or `.txt` file is created empty. Install it from **Command Line Tool…** in the Sodilaud menu (on macOS also in the app menu).
- **Table columns that fit their values.** Short values such as dates, IDs and times (`2026-09-30`, `LB-01`, `14:00`) stay on one line, while long text columns wrap. This applies in Live mode, Reading mode and **Copy rendered HTML**.
- **Wide tables scroll.** A table too wide for the window scrolls sideways instead of breaking its values across lines.

## Limits

- The `sodilaud` command works on macOS and Linux. It has no `--wait` option yet, so it cannot be used as `$EDITOR` or as the editor for commit messages.
- On macOS the command can be installed only from Sodilaud.app in the Applications folder, not from a development build or a copy macOS still runs from a temporary location.
- If `~/.local/bin` is not on your PATH, the install dialog shows the line to add to your shell's startup file.
- Find in Reading mode does not match text that runs from a date or ID in a table into the text next to it.

## Compatibility

- Installing the command writes one file, `~/.local/bin/sodilaud`. **Command Line Tool…** also updates or removes it, and never changes a file there that Sodilaud did not install.
- Copied HTML wraps each table in a `div` and short table values in `span` elements, with inline styles so the layout holds when pasted elsewhere.
- Notes, files, settings and workspaces carry over unchanged.
- Builds are not production-signed; macOS and Windows may display a security warning.
