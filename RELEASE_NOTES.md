# Sodilaud v0.8.2

This release adds one new built-in theme.

## Unreleased: Live, Source, and Reading editor modes

- Replaces the Edit / Split / Preview layout with three modes, chosen from the toolbar: **Live**
  (default, Obsidian-style live preview - Markdown syntax shows only on the line you're editing,
  and headings, emphasis, links, task checkboxes, and tables render inline), **Source** (raw
  Markdown in a monospace editor), and **Reading** (rendered, read-only). The synced split preview
  is gone.
- Tables render as a formatted table until you click into one, then show the raw pipe source; no
  cell-grid editing.
- `Cmd/Ctrl`-click a link to open it through the existing confirmation dialog; a plain click just
  places the cursor. Remote images never load in any mode.
- Compare mode, two-note split view, find and replace, and smart editing keys (lists, tables,
  pair completion, and more) all still work the same as before.
- Compare mode now renders differences as CodeMirror decorations instead of a highlight layer
  behind the text area.

## Unreleased: Formatting shortcuts and toolbar

- Adds Markdown formatting shortcuts: `Cmd/Ctrl+B` bold, `Cmd/Ctrl+I` italic, `Cmd/Ctrl+Shift+X`
  strikethrough, `Cmd/Ctrl+E` inline code, `Cmd/Ctrl+K` link, `Cmd/Ctrl+Alt+1` to `6` headings,
  `Cmd/Ctrl+Shift+7`, `8`, and `9` numbered, bullet, and task lists, `Cmd/Ctrl+Shift+.` quote, and
  `Cmd/Ctrl+Alt+C` code block. Marks, headings, lists, and quotes toggle off when applied again.
- Adds a formatting button group left of the Live, Source, and Reading buttons, with a heading menu
  and table and horizontal-rule buttons. Buttons that do not fit move into a "»" menu. It acts on
  the pane you last worked in and is unavailable in Reading mode. The Live, Source, and Reading
  buttons are now compact icons.
- **Changed shortcut:** Toggle Sidebar moves from `Cmd/Ctrl+B` to `Ctrl+Cmd+S` on macOS
  (`Ctrl+Alt+S` on Windows and Linux), because `Cmd/Ctrl+B` now makes text bold.

## Highlights

- **Executive.** A new preset theme ported from the [Executive Typora theme](https://github.com/rgehrsitz/executive-typora-theme) (MIT): deep jade greens, brown borders, and warm parchment text on a dark surface. Pick it from the theme picker. Like every preset, the sidebar text tones and the active-note row are derived from its own colours and checked for readable contrast, so note previews stay legible.

## Compatibility

- No data or settings changes. Notes, workspaces, and preferences carry over from v0.8.1.
- If you previously imported Executive as a custom theme file, the built-in preset replaces it; delete the imported copy from the theme picker if you no longer want it.
- Builds are not production-signed; macOS and Windows may display a security warning.
