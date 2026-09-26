# Clipboard history - design

Date: 2026-09-25
Status: approved in brainstorming, awaiting written-spec review
Branch: `feat/clipboard-history` (stacked on `chore/rebrand-sodilaud` until that merges)

## Intent

**What.** An opt-in, macOS-only, in-memory clipboard history inside Sodilaud. Every text copy
from any app is captured. A global hotkey opens a popup listing the last N entries; picking one
puts it on the system clipboard (and optionally pastes it). Entries expire a fixed time after
they were copied.

**Why.** Lookup workflows bounce between three to five values (a repo name, a token key, a
value) in arbitrary order. Re-copying each from its source slows the owner down.

**Primary constraint.** The owner copies live secrets. Clipboard values must never leak: no
disk, no localStorage, no workspace database, no logs, no MCP snapshot, no network. They live
only in Rust process memory and are wiped on expiry, deletion, disable, and quit.

**Threat model.** Single-user macOS machine, zero egress (see
`docs/security/2026-09-25-audit-findings.md`, F8). An attacker who can already read the
system pasteboard or the process memory is out of scope; the goal is that Sodilaud does not
widen or prolong exposure.

## Decisions

| Topic | Decision |
|---|---|
| Capture | Automatic, every text copy, including password-manager copies |
| Paste | Configurable; default copy-only (user presses Cmd+V); auto-paste is opt-in and needs Accessibility |
| Residency | Menu-bar icon always present on macOS; closing the main window hides it |
| Default | Clipboard history off by default |
| System clipboard | Cleared on expiry, delete, disable, and quit if it still holds that value; our writes are marked current-host-only and concealed/transient |
| Masking | Heuristic detection; masked entries show a hint; eye reveals; no per-entry override |
| Platforms | macOS only; not compiled on Windows or Linux, which keep today's behavior |
| TTL | Fixed from first copy; re-copy and picking do not extend it |
| Popup position | Fixed: horizontally centered, top edge at one third of screen height, on `NSScreen.mainScreen` |
| Architecture | In-process Rust store plus an isolated popup webview (approach A) |

## Architecture

### Rust: `src-tauri/src/clipboard/` (`#[cfg(target_os = "macos")]`)

- `store.rs` - `History`: `Mutex<VecDeque<Entry>>` with capacity N, newest first.
  `Entry { id: u64 (random), value: Zeroizing<String>, copied_at: Instant, mask: Mask }`.
  Operations: `push`, `get`, `remove`, `reap_expired(now)`, `set_capacity`, `clear`. Logic is
  written against an injected clock and a generic value type so it is unit-testable. Every
  removal path and `Drop` wipes the value.
- `detect.rs` - `classify(&str) -> Mask` (`None`, `Full { prefix }`, `Partial { ranges }`) and
  `hint(&str, &Mask) -> String`. Pure functions.
- `pasteboard.rs` - thin `objc2-app-kit` wrapper behind a `Pasteboard` trait:
  `change_count()`, `read_text()`, `write_text(value)`, `clear_if_equals(value)`.
  `write_text` calls `prepareForNewContentsWithOptions(.currentHostOnly)` and adds the
  `org.nspasteboard.ConcealedType`, `org.nspasteboard.TransientType`, and a private
  `io.github.borgand.sodilaud.clip` marker type. `clear_if_equals` compares in constant time
  (`subtle`).
- `watcher.rs` - one thread, running only while the feature is enabled. Every 250 ms: if
  `change_count` changed and the pasteboard does not carry our marker type, read text and
  `push`. Every tick: `reap_expired`, and `clear_if_equals` for each reaped value.
- `commands.rs` - Tauri commands:
  - `clip_list() -> Vec<ListItem { id, preview: Option<String>, hint: Option<String>, masked, seconds_left, extra_lines }>`
    (plaintext preview only for unmasked entries; masked entries carry only `hint`)
  - `clip_reveal(id) -> String`
  - `clip_select(id)` - Rust writes to the pasteboard, hides the popup, restores focus,
    optionally auto-pastes
  - `clip_close()` - hides the popup (Esc, close button)
  - `clip_shown()` - the page has rendered and painted the list for a pending show; only
    then does Rust make the panel visible and key
  - `clip_start_drag()` - starts a native window drag of the calling popup window, so the
    header can move it without any `core:window` permission
  - `clip_delete(id)`
  - `clip_set_config(ClipConfig { enabled, capacity, ttl_minutes, hotkey, auto_paste }) -> ConfigStatus`
    (returns hotkey/Accessibility status, never entry data)
  - Errors are payload-free enum variants.
- `popup.rs` - creates the frameless, always-on-top `clipboard` window once, hidden and
  converted to a non-activating panel, when the feature is enabled (including at launch
  with the feature on). wry activates the app whenever it creates a webview, so the hotkey
  never creates one: it only shows and hides the panel (creating it lazily only if the
  creation at enable time failed). On show it records the frontmost app
  (`NSWorkspace.frontmostApplication`), moves the panel to the fixed position and resizes
  it for the current row count, orders it in fully transparent and click-through, and asks
  the page to render; the panel becomes opaque and key only when the page calls
  `clip_shown`. It hides the panel on blur, Esc, pick, the hotkey, `clip_close`, and
  disable, reactivates the recorded app only if Sodilaud became frontmost, and destroys the
  window only on disable and quit. Auto-paste posts Cmd+V with `CGEvent` after the hide,
  only if `AXIsProcessTrusted()`.
- `tray.rs` - tray icon (Tauri `tray-icon` feature), menu, hide/show, activation policy.

### Frontend

- `src/clipboard.html`, `src/clipboard.js`: standalone page. No imports. No use of
  `localStorage`, `sessionStorage`, `indexedDB`, `console`, or `fetch`. Talks only to the popup
  `clip_*` commands. Follows `prefers-color-scheme`. Rust drives it with two hooks through
  `eval`: `show()` fetches and renders the list, starts the 1 s refresh, and calls
  `clip_shown` after the next paint; `hide()` forgets the revealed values, the list, and
  the rows, and stops the refresh. An answer that arrives after a hide is dropped.
- `src/main.js`: a "Clipboard history" settings section (macOS only) persisted under
  `clipboardHistory.*` in localStorage (settings only), pushed to Rust via `clip_set_config`
  at startup and on change. The close handler becomes flush-then-hide on macOS.

### Capabilities

- `src-tauri/capabilities/clipboard.json`: window `clipboard`, permissions `allow-clip-list`,
  `allow-clip-reveal`, `allow-clip-select`, `allow-clip-delete`, `allow-clip-close`,
  `allow-clip-shown`, `allow-clip-start-drag`. No `core:*` permissions
  unless the popup cannot work without one; any added core permission is named in the guard
  test and justified in the PR body.
- `src-tauri/capabilities/default.json` (window `main`): gains only `allow-clip-set-config`.

### Data flow on a pick

1. Hotkey: Rust records the frontmost app and opens the popup.
2. Popup calls `clip_list`, renders rows.
3. User presses `2`: popup calls `clip_select(id)`.
4. Rust writes the value to the pasteboard with markers, empties the page and hides the
   popup, reactivates the previous app if needed, and posts Cmd+V if auto-paste is on and
   trusted.

Plaintext reaches JS only for unmasked previews and via `clip_reveal`.

## Popup UI

```
+--------------------------------------------------+
| Clipboard                         10 min TTL   x |
|--------------------------------------------------|
| 1  sodilaud-infra                        9m  [T] |
| 2  ghp_••••x9Qz (40)                 [o] 7m  [T] |
|>3  DATABASE_URL                          6m  [T] |
| 4  postgres://app:••••@db…          [o] 2m  [T] |
| 5  first line of a multi-line valu… +3   1m  [T] |
|--------------------------------------------------|
| 1-9,0 paste · ↑↓ Enter · Space reveal · ⌫ delete |
+--------------------------------------------------+
```

- Frameless, always on top, about 440 px wide, height fitted to rows. Horizontally centered,
  top edge at one third of the height of `NSScreen.mainScreen` (the screen with the key
  window). Grows downward.
- Newest first. Slot numbers 1-9, then 0 for slot 10; slots beyond 10 have no digit key.
- Preview: one line, truncated to about 50 characters, newlines and tabs shown as `⏎` and `⇥`,
  multi-line values show `+N lines`. Masked rows show the Rust-built hint.
- Time left in whole minutes, seconds under one minute; rows under 60 s are dimmed.
- Eye (masked rows only) and trash icons, clickable.
- Keys: `1`-`9`/`0` pick; `↑`/`↓` + `Enter` pick focused; `Space` reveal/re-mask focused
  (wraps to 4 lines, then scrolls); `⌫`/`Delete` trash focused; `Esc` or blur closes;
  hotkey while open closes; Cmd+Q in the popup closes the popup only.
- The header ("Clipboard" and the TTL) drags the popup. The position is not kept: every
  open returns to the fixed spot.
- Every open starts fully masked: the window is reused, and every hide empties the page
  (revealed values, list, rows, refresh timer) before the panel is ordered out.
- Empty state: "Nothing copied yet. Entries expire after N min."
- Trash is immediate, no confirmation: wipes the value and clears the system clipboard if it
  still holds it.

## Settings, tray, lifecycle

### Settings (macOS only)

| Setting | Range | Default |
|---|---|---|
| Enable clipboard history | on/off | off |
| History size | 1-50 | 10 |
| Expire after | 1-120 min | 10 |
| Hotkey | key capture + Reset | Cmd+Shift+V |
| Paste automatically after picking | on/off | off |

- A rejected hotkey shows an inline error; the previous hotkey stays registered.
- Enabling auto-paste checks `AXIsProcessTrusted`; if untrusted, shows "Grant Accessibility in
  System Settings" with an Open button and a restart hint. Picks fall back to copy-only until
  trusted.
- Disable: stop watcher, unregister hotkey, wipe all entries, clear system clipboard if it holds
  one.
- Lower capacity: evict oldest with wipe and clipboard clear.
- TTL change applies to existing entries from their original copy time.

### Tray (always on macOS)

- Monochrome template icon.
- Menu: Show Sodilaud; Clipboard History… (shows hotkey; enabled only when feature on);
  Clear Clipboard History (same); separator; Quit Sodilaud.
- Click opens the menu; it does not toggle the window.

### Window lifecycle (macOS)

- Closing the main window: existing flush (`src/main.js` `onCloseRequested`), then hide and
  switch to `ActivationPolicy::Accessory` (no Dock icon). A failed flush cancels the hide and
  reports the error, as today.
- Show Sodilaud: `ActivationPolicy::Regular`, show and focus the window.
- Quit (tray or Cmd+Q in the main window): existing flush; on failure abort as today; on
  success wipe history, clear system clipboard if it holds an entry, exit.
- Windows and Linux: no tray, no feature, closing quits as today.

## Masking heuristic

Bias: when in doubt, mask. First matching rule wins.

1. **Known token formats** mask the whole entry (hint keeps the prefix): `ghp_`, `gho_`,
   `ghu_`, `ghs_`, `ghr_`, `github_pat_`, `glpat-`, `sk-`, `sk-ant-`, `sk-proj-`,
   `xox[abprs]-`, `AKIA`/`ASIA` + 16 `[A-Z0-9]`, `AIza`, `npm_`, `pypi-`, `hvs.`, `dop_v1_`,
   `SG.`, JWT (`eyJ` + two `.`-separated base64url segments), `-----BEGIN … PRIVATE KEY-----`.
   In multi-line values, any matching line masks the whole entry.
2. **URL with credentials** (`scheme://user:pass@…`): mask only the password.
3. **Secret-named assignment**, single line: name contains `KEY`, `TOKEN`, `SECRET`, `PASS`,
   `PWD`, or `AUTH` (case-insensitive), followed by `=` or `:`, optional `export` and quotes.
   Mask only the value.
4. **Generic random value**: single line, no whitespace, not identifier-like (split on
   `- _ . /`; all pieces alphabetic words or all numeric), not a plain URL or email, and either
   - length ≥ 16 and Shannon entropy ≥ 3.5 bits/char, or
   - length 8-15 with at least 3 of 4 character classes (lower, upper, digit, symbol).
5. Otherwise unmasked.

Hints (built in Rust):
- Known prefix: `ghp_••••x9Qz (40)`.
- Generic: `••••x9Qz (32)`; values shorter than 12 characters show no tail: `•••••••• (9)`.
- Partial masks replace only the masked range with `••••`.
- A hint never exposes more than the prefix plus 4 characters.

## Error handling

| Situation | Behavior |
|---|---|
| Non-text, empty, or whitespace-only clipboard | Ignored |
| Value > 64 KiB | Not captured; limit stated in settings |
| Re-copy of existing value | Moves to top, TTL unchanged |
| Our own pasteboard write | Skipped via marker type |
| Hotkey taken | Inline error; previous hotkey kept |
| Hotkey while popup open | Closes popup |
| Auto-paste without Accessibility | Copy-only fallback; grant hint in settings |
| Watcher panic | History wiped, feature off, settings shows "Clipboard history stopped unexpectedly" |
| Pick/delete of expired id | No-op; popup refreshes |

## Memory hygiene

- Values are `Zeroizing<String>` allocated at exact size and never mutated; wiped on every
  removal path, `Drop`, disable, and quit.
- Detection and hint building borrow slices; no intermediate owned copies.
- Best-effort `mlock` per entry buffer; failure is silently ignored (macOS swap is encrypted).
- `RLIMIT_CORE = 0` while the feature is enabled.
- No logging macros (`println!`, `eprintln!`, `log`, `dbg!`) in the clipboard module.
- Known, documented residue that cannot be wiped: the `NSString` returned by AppKit, Tauri IPC
  buffers for `clip_list`/`clip_reveal`, and freed memory in the popup's WebContent process.
  The popup window lives from enable to disable or quit; its page drops every reference to
  entries on each hide, but freed JS heap memory is not zeroed and may hold previews or
  revealed values until it is reused.

## Testing

1. Rust unit tests: store (capacity eviction, dedupe, fixed TTL with injected clock, `clear`,
   wipe-on-remove via a `Drop`-recording test type); detection table (~50 cases: each prefix,
   near-misses, identifier-like values, UUID, hex, base64, short passwords, URL userinfo, env
   assignments, PEM, non-ASCII) including a hint-exposure bound; `clear_if_equals` against a
   fake `Pasteboard`.
2. Guard tests in `test/` (pattern of `test/mcp-clipboard-boundary.test.js`):
   - `default.json` contains no `clip_*` permission except `allow-clip-set-config`.
   - `clipboard.json` contains only the four popup `clip_*` permissions (plus any core permission explicitly allowlisted in the test).
   - `clipboard.js` has no imports and no `localStorage`, `sessionStorage`, `indexedDB`,
     `console`, or `fetch`.
   - `mcp.rs` does not reference the clipboard module; `main.js` references only
     `clip_set_config`.
   - The Rust clipboard module contains no logging macros.
3. Manual macOS checklist in `docs/clipboard-history.md`: capture, dedupe, expiry and
   `pbpaste` after expiry, trash, masking cases, keys, fixed position on two monitors, focus
   return, auto-paste with and without Accessibility, tray actions, hide/show, Quit, and a
   canary check (`grep -r` for a unique copied value over the app-data directory and the
   workspace DB finds nothing).

## Definition of done

1. Implemented on `feat/clipboard-history`.
2. `cargo test`, `cargo clippy`, `npm test`, and existing CI checks pass locally.
3. Security review of the diff completed; every finding fixed or justified in the PR body.
4. README (Features; Storage and privacy), SECURITY.md (residue, trust boundary),
   RELEASE_NOTES, and `docs/clipboard-history.md` updated.
5. Branch committed with PR title and body ready, including the manual checklist. The owner
   pushes and opens the PR.

## Out of scope

Windows and Linux support; images, files, and rich text; persistence across restarts; search or
pinning in the popup; per-entry mask override; pause toggle; theming the popup to Sodilaud
themes; pushing or merging the PR.
