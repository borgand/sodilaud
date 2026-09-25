# Security Policy

## Supported versions

Scratchpad is currently in beta. Security fixes are made against the latest published prerelease and the `main` branch.

## Agent access and recovery data

MCP agent access is optional and off on launch. When enabled, it exposes the open
collection, including unsaved edits, to authenticated local clients. All read
functions start enabled; write functions require individual opt-in. Permissions
apply to all connected clients and reset when access restarts. An agent may send
returned content to its model provider.

Notes deleted in v0.7.0 or later remain in persistent trash until the user empties
it. MCP can list trash metadata but cannot read trashed note bodies, restore
notes, or permanently empty trash. Local storage and workspace databases,
including their trash, are not encrypted by Scratchpad. Protect them and their
backups with the same care as active notes. Workspace files and native preferences
are set to mode 0600 when opened, and SQLite `secure_delete` overwrites replaced and
deleted note bodies. Local notes in webview storage get neither protection.

Agent access listens on 127.0.0.1:39393 and authenticates with a local token file. The
token proves nothing about the peer: any process running as your user can read the token
file or launch `scratchpad --mcp-stdio`, and a process that binds port 39393 before
Scratchpad does receives the token and can answer your agent with forged tool results.
Other user accounts are kept out by the token file's 0600 mode, not by the transport.
Do not enable agent access on a machine you do not control, and do not store clipboard
secrets in a collection you expose to agents. A Unix socket with a peer-UID check is the
planned fix.

## Network access

This fork ships no HTTP client and makes no outbound request: there is no update check,
telemetry, or sync. `npm run check:egress` enforces this in CI. Links you click in the
preview open in your default browser.

See the [MCP reference](docs/mcp.md#live-data-and-privacy-boundary) for the local
authentication boundary, message limits, and client configuration.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's [private vulnerability reporting form](https://github.com/crims0n/scratchpad/security/advisories/new) and include:

- the affected version and platform;
- steps to reproduce the issue;
- the potential impact; and
- any suggested mitigation, if known.

You should receive an acknowledgement within seven days. Please allow time for a fix and coordinated release before disclosing the issue publicly.
