# Clipboard history (macOS)

Clipboard history is an optional, macOS-only feature that keeps the last few things you
copied so you can pick one back up without re-copying it from its source. It is off by
default and never built on Windows or Linux.

When enabled, every text copy from any app is captured automatically, including copies
from password managers. Press the hotkey (`⌘⇧V` by default) to open a small popup listing
your recent copies, newest first. Pick one with `1`-`9`/`0`, or `↑`/`↓` and `Enter`, to put
it back on the system clipboard; press `⌘V` yourself to paste it, or turn on auto-paste in
settings to have Sodilaud post `⌘V` for you. Auto-paste only fires after Sodilaud
successfully reactivates the app that was frontmost when you pressed the hotkey and that
app is still frontmost about 120 ms later, and it never pastes into Sodilaud itself; if
either check fails, the value stays on the clipboard for a manual paste. Entries expire a
fixed time after they were copied, values that look like secrets are masked in the popup,
and the history lives only in memory: nothing is written to disk, to the workspace
database, or sent anywhere.

## Settings

| Setting | Range | Default |
|---|---|---|
| Enable clipboard history | on/off | off |
| History size | 1-50 | 10 |
| Expire after | 1-120 min | 10 |
| Hotkey | key capture + Reset | Cmd+Shift+V |
| Paste automatically after picking | on/off | off |

Open **Sodilaud menu → Clipboard History…** to change these. A rejected hotkey shows an
inline error and keeps the previous hotkey registered. Turning on auto-paste checks
Accessibility; without it, Sodilaud shows a "Grant Accessibility in System Settings" row
with an Open button and falls back to copy-only until you grant it and restart Sodilaud.
Lowering the history size evicts the oldest entries immediately. Changing the expiry time
applies to existing entries from their original copy time, not from the moment you changed
the setting. The settings dialog closes with Escape, a click on its backdrop, or its close
button.

## Privacy guarantees

- Clipboard values live only in Rust process memory (a `Zeroizing<String>` per entry) and
  are never written to disk, localStorage, the workspace database, logs, the MCP snapshot,
  or the network.
- History is wiped, and the system clipboard cleared if it still holds the value, on: entry
  expiry, entry deletion, lowering the history size below an entry's slot, disabling the
  feature, and quitting Sodilaud.
- Quitting from the tray or with `⌘Q` in the main window flushes any pending note saves
  first; a failed flush cancels the quit and shows an error, the same as today's close
  behavior. Once the flush succeeds, Sodilaud wipes the clipboard history and clears the
  system clipboard if it still holds a picked entry, then exits. System-initiated exits
  (logout, the Dock's Quit, or `terminate:`) skip the flush, as before this feature, but
  still wipe the history on the way out.
- Every write Sodilaud makes to the system clipboard is marked current-host-only and
  concealed/transient, and carries a private marker type so Sodilaud's own writes are never
  re-captured into history. This keeps picked values out of Universal Clipboard and out of
  third-party clipboard managers that respect those markers.
- The main Sodilaud window can only configure the feature (`clip_set_config`); it cannot
  list, reveal, select, or delete entries. Only the popup window holds the `clip_list`,
  `clip_reveal`, `clip_select`, and `clip_delete` permissions.
- Clipboard history is never reachable from MCP. The MCP snapshot sent to agents never
  includes it, by capability boundary as well as by code: the clipboard module is not
  referenced from the MCP server.

## Known residue

Some short-lived copies cannot be wiped because they are held by frameworks Sodilaud does
not control:

- The `NSString` returned by AppKit when reading the pasteboard.
- Tauri IPC buffers for `clip_list`/`clip_reveal` responses.
- The popup's JS heap, until the popup window is destroyed.

## Known limitations

- Clicking away to another app closes the popup and reactivates the app that was frontmost
  when the popup opened, not the app you clicked. On macOS 13 and earlier this can steal
  focus back from the app you actually clicked.
- The popup's height is fixed at the moment it opens; if the list grows while it is open,
  the list scrolls instead of the window resizing.

## Manual macOS checklist

Automated tests cover the store, masking, and the guard tests around the MCP and capability
boundaries. The following needs a human on a real Mac and was not run during
implementation:

- [ ] Enable, copy three values in another app, and press `⌘⇧V`. The popup appears centered
  at the top third of the focused screen. Repeat on a second monitor.
- [ ] Press `1`-`3` and `Enter` to pick, then paste with `⌘V`. Focus returns to the previous
  app.
- [ ] Re-copy an existing value. It moves to the top, and its time left is unchanged.
- [ ] Set the TTL to 1 min, copy a value, and wait. The row disappears, and `pbpaste` prints
  nothing.
- [ ] Copy `ghp_…`, a JWT, `postgres://u:p@h`, and `API_KEY=x`. Each is masked; Space and the
  eye icon reveal it, and reopening the popup masks it again.
- [ ] Trash a row. `pbpaste` prints nothing if that value was on the clipboard.
- [ ] Lower the size to 1. The oldest entries go.
- [ ] Disable the feature. The hotkey does nothing and the history is gone after
  re-enabling.
- [ ] Auto-paste without Accessibility falls back to copy-only and shows the grant row. With
  Accessibility granted and Sodilaud restarted, a pick pastes immediately.
- [ ] The tray shows Show, Clipboard History…, Clear, and Quit. Close the window: the Dock
  icon is gone and the tray icon stays. Quit exits. Pressing `⌘Q` while the popup is open
  closes only the popup.
- [ ] Set the TTL to 1 min, copy a value, sleep the Mac for 2 min, and wake it. The entry is
  gone within a second.
- [ ] Picked values do not appear on an iPhone through Universal Clipboard, and a
  third-party clipboard manager ignores them.
- [ ] Canary check: copy `sodilaud-canary-<random>`, use the popup, then quit. Then run:
  `grep -r "sodilaud-canary" ~/Library/Application\ Support/io.github.borgand.sodilaud ~/Library/WebKit ~/Library/Caches 2>/dev/null`
  and search your workspace `.db` file. Expected: no matches.
- [ ] On Windows or Linux (if available), the settings section is absent and closing the
  window quits.

The following were deferred during implementation for lack of a human tester and should be
checked before release, in addition to the items above:

- [ ] Popup position is correct on both a single monitor and a two-monitor setup.
- [ ] Focus returns to the previous app after picking an entry and after pressing Esc.
- [ ] `⌘⇧V` toggles the popup open and closed.
- [ ] Auto-paste works end to end with Accessibility granted, including after restarting
  Sodilaud so the grant takes effect.
- [ ] Every tray menu item (Show, Clipboard History…, Clear, Quit) does what its label says.
- [ ] Hiding and showing the app through the Dock and through the tray both work.
- [ ] Quit from the tray and `⌘Q` in the main window both flush, wipe, and exit.
- [ ] Pressing `⌘Q` while the popup is open closes only the popup, not the app.
