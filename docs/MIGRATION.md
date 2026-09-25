# Migrating from upstream Scratchpad

## The fork has its own app identifier

This fork uses the identifier `io.github.borgand.sodilaud` (Beta: `io.github.borgand.sodilaud.beta`)
instead of upstream's `io.github.crims0n.scratchpad`. The identifier names the directories where the
app keeps its state, so the first launch of this fork starts from an empty local collection:

| State | Upstream location (macOS) | Fork location (macOS) |
|---|---|---|
| Native preferences and MCP token | `~/Library/Application Support/io.github.crims0n.scratchpad` | `~/Library/Application Support/io.github.borgand.sodilaud` |
| Local notes (webview storage) | `~/Library/WebKit/io.github.crims0n.scratchpad` | `~/Library/WebKit/io.github.borgand.sodilaud` |

Nothing is copied or deleted. The upstream directories are left exactly as they were.

To bring your notes across:

- **Workspace files:** choose **Scratchpad menu → Open workspace** and pick the same `.db` or
  `.sqlite` file. Notes, folders and trash are restored from the file.
- **Local notes:** open upstream Scratchpad, connect an empty new workspace file (it is seeded with
  your local notes), then open that file in this fork as above.

The fork creates a new MCP token under its own identifier. Existing MCP client configurations keep
working, because `--mcp-stdio` reads the token from the running app's directory.

## Workspace files are owner-only

Workspace files and native preferences are set to mode `0600` whenever the fork opens them, and
SQLite `secure_delete` is on, so replaced and deleted note bodies are overwritten. Connecting or
leaving a workspace also compacts it once, which removes free pages written by older versions.
A workspace file on a read-only disk, or one owned by another user, can no longer be opened.
