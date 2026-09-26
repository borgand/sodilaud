# Sodilaud Beta v0.8.0

This release adds clipboard history on macOS and completes the rename from Scratchpad to Sodilaud.

## Highlights

- **Clipboard history (macOS).** Press `⌘⇧V` in any app to open a small popup with your recent text copies, then pick one with a number key, the arrow keys, `j`/`k`, or the mouse. The history lives in memory only and entries expire on their own.
- **Always in the menu bar on macOS.** Sodilaud keeps a menu-bar icon while it runs. Closing the main window now hides it instead of quitting; quit from the menu-bar icon or with `⌘Q`.
- **Renamed to Sodilaud.** The app, window, package, MCP server, and release names now all say Sodilaud.

## Clipboard history

- Off by default. Turn it on in **Sodilaud menu → Clipboard history**, where you can also set how many entries to keep (1 to 50, default 10), how long they live (1 to 120 minutes, default 10), and the hotkey.
- Every text copy from any app is captured. Re-copying a value moves it to the top without extending its lifetime.
- Values that look like secrets, such as API tokens, JWTs, private keys, passwords in URLs, and `KEY=value` lines, are masked until you reveal them with `Space`, `h`, or the eye icon.
- Picking an entry puts it back on the clipboard. Optionally, Sodilaud pastes it into the app you came from; that needs the macOS Accessibility permission and is off by default.
- The popup opens over any app, including full-screen apps, without taking Sodilaud to the front or changing your `⌘Tab` order. Drag its header to move it. It follows your Sodilaud theme.
- Delete an entry with the trash icon, `⌫`, or `Delete`. Clear everything from the menu-bar icon.

### Privacy

- Entries exist only in the app's memory. They are never written to disk, local storage, or workspace files, never logged, never sent to agents over MCP, and never sent over the network.
- When an entry expires, is deleted, or history is turned off, and on quit, Sodilaud also clears the system clipboard if it still holds that value.
- Values Sodilaud puts back on the clipboard are marked as local to this Mac (no Universal Clipboard) and as concealed, so well-behaved clipboard managers skip them.
- The popup is excluded from screen sharing and screenshots where macOS allows it.
- See [clipboard history](docs/clipboard-history.md) and [SECURITY.md](SECURITY.md) for the full privacy boundary and the copies that the operating system keeps outside Sodilaud's control.

## Other changes

- Quitting from the menu-bar icon or with `⌘Q` saves pending note changes first; if saving fails, the quit is cancelled and you see an error.
- The About panel describes clipboard history.

## Compatibility

- **Local notes after the rename.** Local notes, folders, trash, and view preferences are stored under new `sodilaud_` keys, and nothing is migrated from the old `scratchpad_` keys. If you used local notes in v0.7.9, export the ones you need to keep before upgrading, or keep them in a workspace file, which is unaffected.
- **Workspace and MCP.** The remembered workspace and the MCP token file were renamed as well: reopen your workspace file once from **Sodilaud menu → Open workspace**, and reconfigure MCP clients from **Sodilaud menu → Agent access**.
- **Closing the window on macOS.** Closing the main window now keeps Sodilaud running in the menu bar. On Windows and Linux, closing the window still quits.
- Clipboard history is macOS only; the setting does not appear on Windows or Linux.
- Builds are not production-signed; macOS and Windows may display a security warning.
