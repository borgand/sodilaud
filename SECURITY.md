# Security Policy

## Supported versions

Sodilaud is currently in beta. Security fixes are made against the latest published prerelease and the `main` branch.

## Agent access and recovery data

MCP agent access is optional and off on launch. When enabled, it exposes the open
collection, including unsaved edits, to authenticated local clients. All read
functions start enabled; write functions require individual opt-in. Permissions
apply to all connected clients and reset when access restarts. An agent may send
returned content to its model provider.

Notes deleted in v0.7.0 or later remain in persistent trash until the user empties
it. MCP can list trash metadata but cannot read trashed note bodies, restore
notes, or permanently empty trash. Local storage and workspace databases,
including their trash, are not encrypted by Sodilaud. Protect them and their
backups with the same care as active notes. Workspace files and native preferences
are set to mode 0600 when opened, and SQLite `secure_delete` overwrites replaced and
deleted note bodies. Local notes in webview storage get neither protection.

Agent access listens on 127.0.0.1:39393 and authenticates with a local token file. The
token proves nothing about the peer: any process running as your user can read the token
file or launch `sodilaud --mcp-stdio`, and a process that binds port 39393 before
Sodilaud does receives the token and can answer your agent with forged tool results.
Other user accounts are kept out by the token file's 0600 mode, not by the transport.
Do not enable agent access on a machine you do not control, and do not store clipboard
secrets in a collection you expose to agents. A Unix socket with a peer-UID check is the
planned fix.

## Clipboard history

Clipboard history is optional, off by default, and macOS only. It is not compiled into
Windows or Linux builds. Enabled, it captures every text copy into Rust process memory and
never writes it to disk, the workspace database, logs, or the network.

Trust boundary: only the clipboard popup window can list, reveal, select, or delete
entries. The main Sodilaud window can only turn the feature on or off and change its
settings; it has no permission to read entry contents. Clipboard history is never exposed
to MCP: the clipboard module is not referenced by the MCP server, so no entry can reach an
agent or its model provider.

Known residue that cannot be wiped: the `NSString` AppKit hands back when reading the
pasteboard, Tauri's IPC buffers for the popup's list and reveal responses, and the popup's
JS heap until that window is destroyed. History is wiped on expiry, deletion, disable, and
quit; quitting from the tray or `⌘Q` flushes pending note saves first, the same as closing
the main window today, and a failed flush cancels the quit rather than losing data.

Turning on auto-paste (paste automatically after picking an entry) requires granting
Sodilaud Accessibility permission in System Settings. That permission lets Sodilaud send
synthetic keystrokes to the frontmost app; Sodilaud uses it only to post `⌘V` after a pick,
and only into the app that was frontmost when the popup opened, never into itself. See
[clipboard history](docs/clipboard-history.md) for the full privacy guarantees and a manual
test checklist.

## Network access

This fork ships no HTTP client and makes no outbound request: there is no update check,
telemetry, or sync. `npm run check:egress` enforces this in CI. Links you click in the
preview open in your default browser.

See the [MCP reference](docs/mcp.md#live-data-and-privacy-boundary) for the local
authentication boundary, message limits, and client configuration.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's [private vulnerability reporting form](https://github.com/borgand/sodilaud/security/advisories/new) and include:

- the affected version and platform;
- steps to reproduce the issue;
- the potential impact; and
- any suggested mitigation, if known.

You should receive an acknowledgement within seven days. Please allow time for a fix and coordinated release before disclosing the issue publicly.
