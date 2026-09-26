# Sodilaud v0.8.1

This release refines clipboard history on macOS.

## Highlights

- **Paste with `⌘↵`.** In the clipboard popup, `⌘↵` picks the focused entry and pastes it into the app you came from, even with auto-paste off. `Enter` still only copies, unless auto-paste is on.
- **Asks for Accessibility when it needs it.** Pasting needs the macOS Accessibility permission. When it is missing, Sodilaud now opens the macOS dialog to grant it instead of silently copying only. Restart Sodilaud after granting it.
- **Masked entries show more context.** When a copy holds ordinary text before a secret, such as a note that ends with `API_TOKEN=…` or a `curl` command with a bearer token, the popup row shows that text from the first line, then the masked secret and its last 4 characters. Multi-line masked entries show their line count. A bare password or token looks the same as before, and no row shows more than the last 4 characters of a secret.
- **Wider popup.** The popup is half again as wide and shows up to 80 characters of each entry.

## Compatibility

- No data or settings changes. Notes, workspaces, and clipboard settings carry over from v0.8.0.
- **Accessibility after upgrading.** macOS treats each new unsigned build as a new app, so an existing Sodilaud entry under **System Settings → Privacy & Security → Accessibility** may stop applying. If pasting stops working, remove the old entry, grant the permission again when asked, and restart Sodilaud.
- Clipboard history is macOS only; the setting does not appear on Windows or Linux.
- Builds are not production-signed; macOS and Windows may display a security warning.
