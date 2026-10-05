# Sodilaud

[![CI](https://github.com/borgand/sodilaud/actions/workflows/ci.yml/badge.svg)](https://github.com/borgand/sodilaud/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/borgand/sodilaud?include_prereleases)](https://github.com/borgand/sodilaud/releases)
[![License: GPL v3 or later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

Sodilaud is a lightweight, open-source, local-first desktop editor for notes, snippets, and Markdown. Your notes live in **Quick Notes**, a floating panel one hotkey away that stays on top while you work in other apps, and the main window edits Markdown and text files on disk. It runs on macOS, Windows, and Linux with no account, cloud service, or telemetry. On macOS it also keeps an in-memory clipboard history one hotkey away.

[Visit the Sodilaud website](https://borgand.github.io/sodilaud/) for an OS-aware download and SHA-256 checksums.

<p align="center">
  <img src="images/preview.png" alt="Sodilaud application preview" width="900">
</p>

## Install

Download the newest release from the [Sodilaud website](https://borgand.github.io/sodilaud/) or [GitHub Releases](https://github.com/borgand/sodilaud/releases):

- **macOS:** open the `.dmg` and drag Sodilaud to Applications.
- **Windows:** run the `.msi` or `.exe` installer.
- **Linux:** install the `.deb`, or make the `.AppImage` executable and run it.

Packages are not yet production-signed. macOS and Windows may show a security warning, so only install artifacts downloaded from this repository. Back up important workspace files before testing.

See [release notes](RELEASE_NOTES.md) for highlights and compatibility details.

## Quick Notes

New in v0.10: press `⌘⇧N` (`Ctrl+Shift+N` on Windows and Linux) in any app to show or hide Quick Notes, a floating panel with your whole notes collection: the sidebar with folders, pins, search, and trash, the formatting toolbar, find and replace, and side-by-side compare.

- **Stays in view.** The panel floats above other windows and stays open when you click another app, so a running list is always visible. Hide it with the hotkey, `Cmd/Ctrl+W`, or its **×** button.
- **Stays out of the way.** On macOS it opens over full-screen apps without bringing Sodilaud to the front or changing your `⌘Tab` order.
- **Picks up where you left off.** It reopens at its last size and position, on the note you had open, with the sidebar collapsed until you need it.
- **Separate from your files.** Notes are stored in Sodilaud's own workspace or a portable workspace file you choose, never mixed with the files you edit in the main window.

The main Sodilaud window opens on a start page that explains both halves of the app and links the Quick Notes Welcome note. Change the hotkey in **Sodilaud menu → Quick Notes**. See [Quick Notes](docs/quick-notes.md) for the details.

## Markdown files

New in v0.10: the main window edits `.md`, `.markdown`, and `.txt` files on disk with the same Live, Source, and Reading editor. Open one with `Cmd/Ctrl+O`, from the start page's Recent list, or from Finder with **Open With → Sodilaud**. Changes save automatically; new files are saved with `Cmd/Ctrl+S`.

- **Your file, unchanged.** Saves are atomic and keep the file's permissions, byte-order mark, and CRLF line endings. Sodilaud never reformats a file.
- **Outside edits handled.** A file changed by another app reloads if you have not edited it, and asks **Reload** or **Keep mine** if you have.
- **Scoped access.** The main window can reach only files you chose, and agents cannot see files at all.

See [editing files](docs/files.md) for the details and limits.

## Clipboard history (macOS)

New in v0.8: press `⌘⇧V` in any app to open your recent text copies, newest first. Pick one with `1`-`9`/`0`, the arrow keys, `j`/`k`, or the mouse to put it back on the clipboard. Press `⌘↵` to paste it into the app you came from, or turn on auto-paste to make every pick paste.

<p align="center">
  <img src="images/clipboard.png" alt="The Sodilaud clipboard history popup listing ten recent copies, with an API key and a database password masked and a GitHub token revealed" width="560">
</p>

- **Memory only.** Entries are never written to disk, local storage, workspace files, or logs, never sent to MCP agents, and never sent over the network. Quitting wipes them.
- **Secrets masked.** API tokens, JWTs, private keys, passwords in URLs, and `KEY=value` lines stay hidden until you reveal them with `Space`, `h`, or the eye icon.
- **Expires on its own.** Keep 1 to 50 entries for 1 to 120 minutes. When an entry goes, Sodilaud also clears the system clipboard if it still holds that value.
- **Stays out of the way.** The popup opens over full-screen apps without bringing Sodilaud to the front or changing your `⌘Tab` order.

Clipboard history is off by default. Turn it on in **Sodilaud menu → Clipboard history**. See [clipboard history](docs/clipboard-history.md) for every setting and the full privacy boundary.

## Features

- Quick Notes: a floating, always-on-top notes panel on a global hotkey that stays open while you work in other apps
- A Markdown file editor with autosave, recent files, Finder "Open With", and outside-edit detection
- Clipboard history on macOS: press `⌘⇧V` in any app to pick from your recent copies, with secrets masked, entries kept in memory only, and automatic expiry
- Optional local MCP agent access with five read tools, eight individually enabled write tools, and a live listening indicator
- Multiple notes with automatic saving, titles derived from the first line, and quick creation by double-clicking empty sidebar space
- Live, Source, and Reading editing modes, with inline Markdown rendering and per-line raw source in Live mode
- Optional Markdown editor coloring and language-aware fenced-code highlighting in Reading mode
- Optional, theme-aware source line numbers in either editor pane
- Markdown-aware continuation for lists, task lists, blockquotes, code fences, and tables
- Pair completion, selection wrapping, and smart URL or spreadsheet paste
- Right-click Markdown starter templates for tables, task lists, code blocks, and links
- Two-note side-by-side editing with drag-to-split and live source comparison
- Top-level pinned notes, collapsible sidebar folders with drag-and-drop organization, search, configurable note previews, manual ordering, word counts, and distraction-free Focus Mode
- Find and replace with case-sensitive, exact-match, and regular-expression modes, live highlighting, and results across one or every scratchpad
- Native text-file import and Markdown export
- Copy as Markdown or sanitized rendered HTML
- Optional portable workspace files that reopen automatically
- Recoverable note deletion with persistent trash, Restore actions, and user-confirmed Empty Trash
- Built-in and importable color themes with contrast-aware sidebar and active-note tones
- Persistent editor zoom and adjustable editor line spacing
- A sectioned Sodilaud menu, About panel, keyboard shortcut reference, and Markdown cheatsheet

## Storage and privacy

Sodilaud keeps its state under the app identifier `io.github.borgand.sodilaud`. Development builds (`npm run tauri dev`) use `io.github.borgand.sodilaud.dev` and appear as "Sodilaud Dev", so they never touch the data of an installed release. Workspace files and preferences are kept owner-only (`0600`), and deleted note bodies are overwritten in workspace files.

Sodilaud keeps the notes collection in the app, not in a window, so every window and agent edits the same copy. By default, notes, folders, and trash are stored in `default.sqlite` in the app data directory. Versions before 0.11 kept them in the desktop webview's local storage; the first launch of 0.11 copies them into `default.sqlite` once and leaves local storage as it was. The Quick Notes panel's size, position, and hotkey, and which windows were open at quit, are kept in `quicknotes.json` in the app's config directory. Sodilaud also supports optional portable workspace files for a durable collection of notes, folders, trash, pinned state, and sidebar order. Workspace files use SQLite internally and may have a `.db` or `.sqlite` extension. Notes without a folder remain at the top level of the sidebar; deleting a folder from the sidebar returns its notes there rather than deleting them. Agent folder deletion requires an empty folder.

Local notes and workspace notes are two separate collections, each in its own file with its own trash. While a workspace is connected, changes are written to that workspace and the local collection is left exactly as it was, so disconnecting returns the notes and trash you had before. Connecting an empty workspace seeds it with the active notes and folders already available in the app; local trash stays local. A workspace with existing notes, folders, or trash opens its own collection.

Hiding Quick Notes never interrupts saving. Every change is written to the database as soon as it reaches the app, about 150 ms after typing stops. Changes still on their way are sent before Sodilaud quits; if that save fails, Sodilaud cancels the quit and shows Quick Notes with the error. If a workspace cannot be opened at start-up, Sodilaud reports it and falls back to your local notes, leaving the workspace file untouched.

Sodilaud has no analytics, advertising, accounts, or sync service. Markdown is parsed on-device, rendered HTML is sanitized, and remote images never load, so viewing a note does not contact an image host. Rendered links open in your default browser rather than inside the app, after a confirmation dialog; following one is an explicit network action and may contact that destination.

This fork contains no update check and makes no outbound request of any kind: it links no HTTP client, and `npm run check:egress` fails the build if network capability reappears. New versions are published as releases in this repository; download them yourself when you choose to.

The optional [MCP agent access](docs/mcp.md) uses a stdio mode built into the
desktop executable and is off by default. While enabled, it can read the collection open
in Sodilaud, including edits that have not been saved yet. Individually enabled
write functions can create notes and folders, append text, rename notes and
folders, move notes between folders, move notes to recoverable trash, and delete
empty folders. Agents can list trash metadata; restoring and permanently
emptying trash are available only in the UI. Existing-item edits require revision
checks and support safe retries. A connected agent
may send returned note contents to its model provider.

Back up important workspace files like any other local document. Local-only notes remain tied to the app data stored by the operating system and may be lost if that data is cleared.

On macOS, an optional clipboard history feature keeps recent copies in Rust process memory
only. Entries are never written to disk, workspace files, local storage, or sent to
agents; they expire automatically and are wiped on quit. See
[clipboard history](docs/clipboard-history.md) for the settings, privacy guarantees, and a
manual test checklist.

## Agent access (MCP)

Agents work with your Quick Notes, so access is set there: open Quick Notes, open its menu (top right), and turn **Agent access** **On**. The main window's **Sodilaud menu → Agent access…** takes you there. Choose **MCP Configuration** to copy the executable path, `--mcp-stdio` argument, or generic JSON example into a client that supports local stdio MCP servers. Configuration stays available while access is off. Sodilaud must remain open, but the Quick Notes panel does not need to be visible; the accent-colored **MCP listening** indicator appears beside its save status while access is enabled.

Each time access starts, all five read permissions are on and all eight write permissions are off. Use the **Read** and **Write** checkboxes to choose individual functions or select all in a section. Changes apply to connected clients immediately and reset when access is restarted.

| Permission group | Functions |
| --- | --- |
| Read | List folders, list notes, search notes, read note content, list trash metadata |
| Write | Create note, create folder, append to note, rename note, move note, rename folder, delete note to trash, delete empty folder |

Writes to existing items check the current revision before changing anything. Request IDs make retries safe after a timeout or failed save. An agent's changes show up in an open editor without moving your cursor or losing what you are typing. Agents cannot replace an entire note, read trashed note bodies, restore notes, or empty trash. Access applies to all connected local clients and to the collection currently open in Sodilaud, including what you typed moments ago.

See the [MCP reference](docs/mcp.md) for client setup, tool arguments, limits, retry behavior, and the privacy boundary.

## Delete and recover notes

Use a note's sidebar delete button or right-click it and choose **Delete Note** to move it to trash. Click the **trash icon at the bottom right** to see deleted notes and choose **Restore**. Restoring preserves the note's content, title, and pin state, returning it to its original folder or the top level if that folder no longer exists.

Right-click the trash icon and choose **Empty Trash…**, then confirm to permanently remove the listed recovery copies. Keyboard users can focus the icon and press `Shift+F10` to open its menu. Trash survives restarts and has no automatic expiry. Only the user can restore notes or empty trash; MCP agents can list its metadata. See [storage and recovery details](docs/mcp.md#deleting-and-recovering-notes) for save-failure behavior.

## Keyboard shortcuts

The app displays `Cmd` on macOS and `Ctrl` on Windows or Linux.

| Shortcut | Action |
| --- | --- |
| `⌘⇧N` (`Ctrl + Shift + N` off macOS, configurable) | Show or hide Quick Notes from any app |
| `Cmd/Ctrl + W` (Quick Notes) | Hide Quick Notes |
| `Cmd/Ctrl + N` (Quick Notes) | Create a note |
| `Cmd/Ctrl + N` / `Cmd/Ctrl + O` (main window) | Create or open a file |
| `Cmd/Ctrl + S` / `Cmd/Ctrl + Shift + S` (main window) | Save, or Save As |
| `Cmd/Ctrl + W` (main window) | Close the active file |
| `⌘⇧V` (macOS, configurable) | Open the clipboard history popup |
| `⌘↵` (macOS, clipboard popup) | Paste the focused entry into the previous app |
| `Ctrl + Cmd + S` (`Ctrl + Alt + S` off macOS) | Toggle the sidebar |
| `Cmd/Ctrl + \` | Toggle two-note side-by-side editing |
| `Alt + ↑` / `Alt + ↓` | Move a list branch, or the active sidebar note outside a list |
| `Cmd/Ctrl + F` | Open or close Find |
| `Cmd/Ctrl + H` | Open Find and Replace |
| `Alt + C` | Toggle case-sensitive matching while Find is open |
| `Alt + W` | Toggle exact whole-word matching while Find is open |
| `Alt + R` | Toggle regular-expression mode while Find is open |
| `Enter` / `Shift + Enter` | Select the next or previous match |
| `Enter` | Continue a list or blockquote, close a new code fence, or extend a table |
| `Tab` / `Shift + Tab` | Nest or outdent a list, navigate table cells, or insert plain indentation |
| `Home` | Move to list-item content first, then the beginning of the line |
| `Cmd/Ctrl + +` / `Cmd/Ctrl + -` | Zoom the editor in or out |
| `Cmd/Ctrl + 0` | Reset editor zoom to 100% |
| `Cmd/Ctrl + Shift + F` | Toggle Focus Mode |
| `Cmd/Ctrl + B` / `I` / `E` | Toggle bold, italic, or inline code |
| `Cmd/Ctrl + Shift + X` | Toggle strikethrough |
| `Cmd/Ctrl + K` | Make the selection a link, or insert a link; inside an existing link, select its URL |
| `Cmd/Ctrl + Alt + 1` to `6` | Set heading level 1 to 6; the same level again removes it |
| `Cmd/Ctrl + Shift + 7` / `8` / `9` | Toggle a numbered, bullet, or task list |
| `Cmd/Ctrl + Shift + .` | Toggle a blockquote |
| `Cmd/Ctrl + Alt + C` | Insert a code block, or fence the selected lines |
| `Cmd/Ctrl + /` or `F1` | Open or close Help and Reference |
| `Tab` / `Shift + Tab` | Switch topics while Help is open |
| `Escape` | Close the active modal or Find bar, or leave Focus Mode; it never hides Quick Notes |

## Markdown editing

Sodilaud has three editing modes, chosen with the mode buttons in the toolbar (icons; hover one to see its name): **Live** (default), **Source**, and **Reading**. Live renders Markdown inline - headings, emphasis, links, task checkboxes, and tables display formatted - while the line your cursor or selection touches shows its raw Markdown. In Live mode, `Cmd`-click a link (`Ctrl`-click off macOS) to open it; a plain click just places the cursor. In Reading mode a plain click opens a link. Tables render as a formatted table until you click into one, which reveals the raw pipe source. Source mode shows raw Markdown in a monospace font with the same editing features as Live. Reading mode is a read-only rendered view. Remote images never load in any mode; only `data:` images render.

Sodilaud keeps its Markdown assistance lightweight and works directly in the native text editor:

- `Enter` preserves the marker and spacing of bullet lists, advances ordered-list numbering, and creates unchecked task items. An empty item outdents or exits its list.
- `Tab` at the start of a list item nests the complete item and its children; `Shift+Tab` outdents them. Elsewhere, Tab inserts indentation. Fenced code always receives literal indentation.
- Blockquotes continue at the same depth. Starting a fenced code block closes the fence and leaves the cursor between the markers.
- Parentheses, brackets, braces, quotes, and inline backticks pair automatically. Typing an existing closing character advances past it, and Backspace removes an empty pair. Selecting text before typing `*`, `_`, <code>`</code>, or `~` wraps the selection.
- Finishing a table header creates its separator and first row. `Enter` in the final cell or `Tab` past it adds a row; `Enter` or Backspace on an empty generated row exits the table.
- Pasting a URL over selected text makes a Markdown link. Pasting a rectangular tab-separated spreadsheet range makes a Markdown table; ragged or uniformly indented tab-separated text stays literal.
- The formatting buttons to the left of the mode buttons apply bold, italic, strikethrough, inline code, links, headings (from a menu, including **Paragraph** to remove one), bullet, numbered, and task lists, quotes, code blocks, tables, and horizontal rules to the pane you last worked in. Marks, headings, lists, and quotes toggle: applying one again removes it. Link inside an existing link selects its URL. Hover a button to see its shortcut. Buttons that do not fit the window move into the **»** (More formatting) menu. The buttons are unavailable in Reading mode.
- Right-click in either editor and choose **Insert** for a starter table, task list, fenced code block, inline link, or reference-style link. The first useful placeholder is selected so typing replaces it immediately.

Syntax highlighting is enabled by default. Open **Sodilaud menu → Appearance → Syntax highlighting** to toggle both the editor’s Markdown coloring and language-aware highlighting in Reading mode. Reading mode code highlighting requires a supported language after the opening fence, such as <code>```javascript</code>; unknown and unlabeled fences remain plain code.

Source line numbers are off by default. Open **Sodilaud menu → Appearance → Line numbers** to show a subtle, theme-aware gutter in both editor panes; the preference is remembered between launches.

Open two notes side by side, then choose **Compare** in the toolbar to highlight source differences without changing either note. Removed text is marked on the left, added text on the right, and related words receive contiguous substring detail. The toolbar reports the total number of changed lines across both notes. Comparison refreshes after a brief pause in typing, showing **Updating comparison…** while pending, and turns off when split view closes.

## Themes

Sodilaud includes Default Dark and Light, Dracula, Catppuccin Mocha, Nord, Tokyo Night, Monokai Pro, One Dark Pro, Solarized Dark and Light, Amber CRT, Green CRT, Pastel Daydream, Macintosh System 6, Mac OS 9 Platinum, Windows Classic, GitHub Dark, and Executive.

A custom JSON theme requires `background` and `foreground`. Other colors receive defaults when omitted:

```json
{
  "name": "Amber CRT",
  "background": "#120f08",
  "foreground": "#f6c453",
  "sidebar": "#1b160b",
  "accent": "#ffb000",
  "border": "#4a3814",
  "selection": "#5c4315"
}
```

Simple TOML/key-value theme files using the same names are also accepted. Imported colors are validated before they are stored or rendered. Opaque hex, RGB, HSL, named, and `color(srgb …)` values are measured against the theme's own surfaces so secondary text remains readable; translucent or wider-gamut values are preserved without being flattened into guessed colors.

## Development

### Prerequisites

- Node.js 20 or newer
- Rust 1.98.0 (also declared in `rust-toolchain.toml`)
- The dependencies in the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

### Run locally

```bash
git clone https://github.com/borgand/sodilaud.git
cd sodilaud
npm install
npm run tauri -- dev
```

The frontend is served directly from `src/`; there is no framework-specific development server.

### Validate changes

```bash
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

### Build locally

```bash
npm run tauri -- build --config src-tauri/tauri.release.conf.json
```

Without `--config`, the build uses the development identity (`Sodilaud Dev`).

Bundles and installers are written beneath `src-tauri/target/release/bundle/`.

## Releases

The **CI** workflow validates every push to `main` and every pull request. The manually triggered **Release** workflow validates the project, builds macOS, Windows, and Linux packages with `src-tauri/tauri.release.conf.json`, and attaches them to a draft release tagged `vX.Y.Z`.

Before triggering a release, update the version in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, both lockfiles, and the About panel in `src/index.html`. Update `RELEASE_NOTES.md`, the README, MCP reference, welcome note, and in-app Help for the final feature set. The validation command checks version consistency, and the workflow refuses to overwrite an existing release tag. Review the generated draft and its assets before publishing it. The website's download manifest is generated from published GitHub releases; do not point it at unbuilt packages.

Production distribution will also require platform signing and, on macOS, notarization credentials configured as repository secrets.

## Architecture

| Area | Implementation |
| --- | --- |
| Desktop runtime | Tauri v2 and Rust |
| Frontend | Vanilla HTML, CSS, and JavaScript |
| Markdown | Bundled Marked parser with an allowlist sanitizer |
| Syntax highlighting | Bundled Highlight.js for explicitly labeled fenced code blocks |
| Note comparison | Bundled jsdiff with line and word-level source comparison |
| External links | `tauri-plugin-opener`, scoped to `http`, `https`, and `mailto` |
| Note persistence | A Rust notes registry over bundled SQLite (`rusqlite`), for the default and portable workspaces |
| Editor sync | `@codemirror/collab` clients of the Rust registry |
| Agent integration | Toggleable stdio MCP access in the desktop binary through the official Rust MCP SDK |
| Native preferences | JSON in the platform app configuration directory |
| Themes | CSS custom properties with JSON and TOML/key-value import |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow. Please report suspected vulnerabilities privately using the process in [SECURITY.md](SECURITY.md).

## License

Sodilaud is free software licensed under [GPL-3.0-or-later](LICENSE). It is a hard fork of [Scratchpad](https://github.com/crims0n/scratchpad) by crims0n, used under the same license. The bundled Marked parser is provided under the MIT License; Highlight.js and jsdiff are provided under the BSD 3-Clause License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
