# Quick Notes

Quick Notes is where your notes live. It is a floating panel with the whole notes collection
(the sidebar with folders, pins, search and trash, the formatting toolbar, find and replace,
split view and compare) that you show and hide with a global hotkey. The main Sodilaud window
is for Markdown files; notes never appear there, and files never appear in Quick Notes.

## Showing and hiding

| Action | Keys |
|---|---|
| Show or hide, from any app | `⌘⇧N` on macOS, `Ctrl+Shift+N` on Windows and Linux (configurable) |
| Hide | `Cmd/Ctrl+W`, or the **×** at the top right |

The panel is only hidden when you ask for it. Clicking another app leaves it open, so you can
keep a list of actions in view while you work there, and `Escape` never hides it (it still
closes menus, dialogs and the find bar inside the panel).

Drag the strip at the top of the panel to move it, and drag an edge or corner to resize it.
The panel reopens at the same size and place, on the note you had open. If the screen it was
on is gone, it opens centered on the screen with the pointer instead. The first time, it
opens at 720 by 520 points in the middle of that screen. The sidebar starts collapsed; show it
with the button at the top left or `Ctrl+Cmd+S` (`Ctrl+Alt+S` off macOS).

On macOS the panel is a non-activating floating panel: it takes your typing without bringing
Sodilaud to the front, so the app you were using stays active, the `⌘Tab` order does not
change, and the panel also opens over full-screen apps and on every Space. On Windows and
Linux it is an ordinary window that stays on top of other windows and has no taskbar entry.

The tray menu (macOS) has a **Quick Notes** item that shows or hides the panel too.

## Settings

Quick Notes settings are in the main window's **Sodilaud menu → Quick Notes**. Click the
hotkey and press the new chord. `Escape` cancels, and the reset button restores the default.
A chord that is invalid, or already taken by another app or by the clipboard history hotkey,
is refused with a message in the menu; the previous hotkey stays active. The requested chord is
remembered, so Sodilaud tries it again at the next launch.

Themes, editor zoom, line spacing, syntax highlighting, line numbers and the Live, Source or
Reading mode are shared by both windows. Change them in the main window's **Sodilaud menu →
Appearance**; the panel follows at once. `Cmd/Ctrl` with `+`, `-` or `0` zooms in either
window. The number of preview lines in the note list is set in the panel's own menu.

The panel's menu (top right) keeps what acts on notes: the workspace file, copying and
exporting the current note, importing a text file, sidebar preview lines, and agent access.
**Settings…** there, the help button, and `Cmd/Ctrl+/` open the main window.

## Storage

Notes, folders and trash are stored as before: in the webview's local storage, or in a portable
workspace file you open from the panel's menu. Upgrading keeps them exactly as they were, and
the first launch after upgrading shows a one-time note on the start page saying where your
notes went.

The panel's size and position, its hotkey, and which windows were open when you quit are kept
in `quicknotes.json` in the app's config directory, readable only by you. Deleting the file
resets them.

The panel keeps running while it is hidden, so autosave and agent requests work without it on
screen. Quitting asks both windows to save first. If Quick Notes cannot save, the quit is
cancelled and the panel is shown with the error.

## Agents

MCP agents read and change Quick Notes, so agent access is switched on in the panel's menu
(**Agent access**), not in the main window. The main window's **Sodilaud menu → Agent
access…** opens the panel with its menu. Agents keep working while the panel is hidden. See
[MCP](mcp.md).

## Manual test checklist (macOS)

Run these in a built app, since they depend on AppKit behavior the automated tests cannot see:

1. With another app frontmost, press the hotkey. The panel appears; the other app's menu bar
   stays, and `⌘Tab` does not list Sodilaud first.
2. Type in the panel, including `⌘C`, `⌘V`, `⌘X`, `⌘Z`, `⌘⇧Z` and `⌘A`, and dead keys on the
   US International layout (õ ä ö ü š ž) on a line where Live mode hides markup.
3. Click the other app. The panel stays visible above it.
4. Put an app in full screen, then press the hotkey there. The panel appears over it.
5. Move and resize the panel, hide it, quit, relaunch, and show it: same frame, same note.
6. Open a workspace file from the panel's menu; the dialog appears in front of the panel.
7. Upgrade from 0.9.x with existing notes: they appear in Quick Notes, and the start page shows
   the one-time banner.
