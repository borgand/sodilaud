# Sodilaud Beta v0.7.9

This is the first security-hardened release of the sodilaud fork. It removes every outbound network path and tightens what the app window is allowed to do.

## Unreleased: Clipboard history (macOS)

- An optional, off-by-default clipboard history: press `⌘⇧V` to open a popup listing your
  recent copies and pick one back onto the clipboard, or paste it automatically.
- Entries live only in memory, expire after a configurable time, and are wiped on quit; the
  history and its settings never touch disk, the workspace database, or the network.
- Secret-shaped values, such as tokens, JWTs, and credentials in URLs, are masked in the
  popup until you reveal them.
- Sodilaud stays in the menu bar with a tray icon and menu (Show, Clipboard History…, Clear,
  Quit) while the app is open; closing the window hides the Dock icon instead of quitting.
- Clipboard history is macOS only and is never part of the MCP snapshot sent to agents. See
  [clipboard history](docs/clipboard-history.md) for the full write-up.

## Highlights

- No network access: the update check and its HTTP client are gone, and CI fails if network capability comes back.
- Links you click in the preview open only after a native dialog shows their real destination.
- Workspace files and preferences are readable by your user account only, and deleted note bodies are overwritten in workspace files.
- The fork has its own app identity, so it no longer shares a data directory or MCP token with an upstream Scratchpad install.

## No outbound requests

- The About panel no longer checks for updates, and the app links no HTTP client. New versions are published as releases in this repository.
- `npm run check:egress` scans shipped source for network APIs and remote URLs and runs in CI.

## A tighter app window

- The window can only show the bundled app. A script cannot navigate it to a website.
- External links go through a Rust command that accepts only `https`, `http` and `mailto` and asks before opening your browser. The window no longer has direct access to the system opener.
- Workspace commands only open database files you chose in the native dialog or that the app restored from its own preferences.
- Every application command now needs an explicit capability grant.
- The content security policy adds `base-uri`, `form-action`, `object-src` and `frame-src` limits and drops unused sources.
- Imported themes can no longer use `var()`, `url()` or other CSS functions as colors, and a theme with a non-text name no longer breaks rendering.

## Data at rest

- Workspace files and native preferences are set to mode `0600`.
- SQLite `secure_delete` is on for workspace files, and connecting or leaving a workspace compacts it once to remove older free pages.
- A workspace file the app cannot restrict (for example on a read-only disk, or owned by another user) no longer opens.

## Release pipeline

- Builds run with a read-only token; a separate job with no third-party code drafts the release.
- Beta releases can only be built from `main`, Cargo runs with `--locked`, CI installs npm packages without scripts, and Dependabot waits seven days before proposing new versions.

## Compatibility

- The app identifier is now `io.github.borgand.sodilaud`, so the first launch starts with an empty local collection. Upstream data is not copied or deleted. Reopen a workspace file to restore it.
- The app is renamed to Sodilaud. The executable is now `Sodilaud.app/Contents/MacOS/sodilaud`, the MCP server is named `sodilaud`, and the app creates a new MCP token, so reconfigure MCP clients from **Sodilaud menu → Agent access**. Preferences start from defaults.
- Builds are not production-signed; macOS and Windows may display a security warning.
