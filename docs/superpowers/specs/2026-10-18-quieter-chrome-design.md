# Quieter chrome

Issue #59, a discussion list ("Each item could become its own issue if accepted"). This branch
(`feat/quieter-chrome`, based on `feat/document-styling`) builds the items that are clear-cut
and lists the rest as not done, each with the reason it needs a decision. The pull request
says `Refs #59`, not `Closes #59`, because those items stay open.

## Intent

Next to Typora, the window around a Sodilaud document is busier than the document: four
background tones, a solid accent pill on the active file, a status bar that always spells out
"Saved · /full/path" and "No comments", and an outline that truncates long headings and does
not say where you are. The document itself was fixed by #54-#58. This change quiets the chrome
the same way, using the theme derivation those issues added, without new settings.

## Item triage

Done in this branch:

| Item | What ships |
| --- | --- |
| Highlight the section in view | The outline marks the heading of the section at the top of the view, in Live, Source and Reading mode, updated on scroll |
| Wrap long headings | Outline rows wrap with a hanging indent; no ellipsis |
| Larger outline rows | 0.9rem text, about 31px rows, 16px indent per level |
| Lighter active-file indicator | Hover tone plus a 2px accent bar instead of the selection-colour pill |
| Quieter status bar (part) | "Saved" fades after 2 s; the path moves to the hover tooltip; "No comments" is hidden unless the panel is open or an agent is listening |
| Fewer background tones | Status bar and line-number gutter take the page tone; sidebar and title bar keep the sidebar tone |

Not done, needs a decision:

- **Merge title bar and toolbar.** Needs a frameless or overlay title bar (`titleBarStyle`,
  traffic-light insets) per platform; Linux and Windows differ and the toolbar's fit logic
  (`format-toolbar-fit.js`) would change. Window-chrome risk outside a styling branch.
- **Floating formatting pill.** A second toolbar mode is a product choice (when it shows, how
  it is turned on) and new interaction code, not a restyle.
- **Open Files and Outline as tabs.** `feat/multi-window` is reworking the open-files list per
  window; a tab structure now would collide with it.
- **Focus mode hiding the status bar.** The main window has no focus mode (only Quick Notes
  does); adding one is a new feature.
- **Line-number gutter numbering in Live mode.** Each option (dim and align, current line only,
  hide in Live) changes what the setting means; none is obviously right. Only the gutter's own
  background band is removed here, under "fewer tones".
- **Soft line breaks reported as inconsistent.** Not reproduced; needs a sample and its own bug.
- **"MCP listening" as a smaller indicator.** It is already shown only while agent access is
  on, which is when it is relevant, and the security audit
  (`docs/security/2026-09-25-audit-findings.md`) relies on it being visible. Unchanged.

## Goals

- The outline says where the reader is and shows full heading text.
- The active file reads as selected without a coloured block.
- The status bar is quiet when nothing needs attention and speaks when something does
  (Saving, Unsaved, Not saved, comments, agent listening, review progress).
- Two surfaces in the main window: sidebar tone (sidebar, title bar) and page tone (editor,
  gutter, status bar), on every preset and imported theme.

## Non-goals

- Anything in the "Not done" list.
- Quick Notes' own status bar texts and its "Saved" indicator (`#save-status`). Quick Notes
  shares only the comment-count rule and the status bar tone.
- New settings. None of the changes is optional.
- The open-files list's structure or behaviour (owned by `feat/multi-window`): only CSS on
  `.open-file-item` changes.

## Decisions

Given (by the controller or the issue):

- Build only the clear-cut items; list the rest with one line each on why.
- Sidebar changes stay to styling and the outline so `feat/multi-window` merges cleanly.
- Fewer tones only if it works through the existing theme derivation without breaking presets.
- `Refs #59`.

My calls (Rulings):

1. **Current section = the last heading at or above the top edge of the view (8px slack).**
   Before the first heading nothing is marked. When the view is scrolled to its end
   (`scrollTop > 0` and within 2px of `scrollHeight`), the bottom edge is used instead, so a
   short final section can still be marked. Cost if wrong: a threshold tweak.
2. **Scroll handling is synchronous, no `requestAnimationFrame`.** Browsers already deliver at
   most one scroll event per frame; the work is one `lineBlockAtHeight` (Live/Source) or one
   pass over top-level headings (Reading), and the DOM is touched only when the id changes.
3. **The marked outline row scrolls into view (`block: "nearest"`) only when the current
   section changes**, never on the outline's re-render after typing, so a sidebar the user
   scrolled by hand stays put while they type.
4. **Outline sizes:** text 0.9rem, link padding 6px 8px, line-height 1.35, indent 16px per
   level below the top level (was 12px), hanging indent 0.75em. The current row: text-primary,
   weight 600, a 2px inset accent bar; other rows: `--text-secondary`. The sidebar widens from
   220px to 240px so wrapped headings stay readable.
5. **Active file:** background `--bg-note-hover` with `box-shadow: inset 2px 0 0
   var(--accent-color)`; the name weight 600. Hover on an inactive row keeps `--bg-note-hover`
   without the bar. `--bg-note-active` (the theme's selection colour) is no longer used here;
   Quick Notes' note list keeps it.
6. **Only "Saved" fades.** Opacity goes to 0 over 0.6s, 2000 ms after the status becomes
   "Saved" for a file; hovering the status bar shows it again. Every other status stays
   visible. A switch to another file restarts the delay. `prefers-reduced-motion` drops the
   transition, not the fade.
7. **The path is the status text's tooltip (`title`) and is no longer in the text.** The title
   bar already has it as a tooltip too; the text was the only place it showed without hovering,
   which the issue asks to remove.
8. **The comment count is hidden when there are no threads at all (open or resolved), the
   panel is closed and no agent is listening.** With an agent listening it shows "No comments"
   with the dot, so the panel (and Hold for review) stays reachable when it matters. Without an
   agent, the first comment opens the panel as today. Applies to both windows (shared
   `comments-panel.js`). Cost: the empty panel's shortcut hint (Ctrl/Cmd+Alt+M) is reachable
   only while an agent listens; the Help modal still lists the shortcut. If wrong: one condition.
9. **Status bar tone = page tone, except retro themes.** `applyTheme` sets `--statusbar-bg` to
   the theme background; a theme with `uiStyle` (Mac OS 9 Platinum, Windows Classic) keeps the
   sidebar tone, because their bevelled chrome is the point of those themes. `--topbar-bg` stays
   the sidebar tone: the title bar and sidebar form one L-shaped chrome surface, which is the
   "sidebar" of "sidebar and page". The Default Dark/Light palette blocks set `--statusbar-bg`
   to their `--bg-app` value. Muted status text was already floored at 4.5:1 against the
   background, so contrast holds.
10. **Gutter tone = page tone.** `.cm-gutters` background becomes `var(--editor-bg)` (opaque,
    because the sticky gutter covers horizontally scrolled text) and loses its right border.
    Compare mode's change rail is drawn with `box-shadow` on gutter elements and is unaffected.

## Architecture

### Outline (`src/outline.js`, `src/file-editor.js`, `src/app.css`)

New pure exports in `outline.js`:

- `outlineIdAt(entries, pos): string | null` - id of the last entry with `from <= pos`.
- `readingHeadingAt(root, y): string | null` - among `root`'s top-level `H1`-`H6` children with
  the anchor attribute and without `section-fold-hidden`, the id of the last one whose
  `getBoundingClientRect().top <= y`.
- `isScrolledToEnd(scroller): boolean` - `scrollTop > 0 && scrollTop + clientHeight >=
  scrollHeight - 2`.
- `markCurrentOutline(list, id): HTMLElement | null` - toggles class `current` on every
  `.outline-item` by `data-outline-id`, sets `aria-current="location"` on the current row's
  link and removes it elsewhere; returns the current item.

`renderOutlineList` sets `item.dataset.outlineId = entry.id` and drops the link's `title`
(the text is now shown in full).

`file-editor.js` keeps `outlineShown` (the last entries) and `currentOutlineId`.
`updateCurrentOutline()` computes the id (Rulings 1-2) and, when it changes, marks and scrolls
the row into view (Ruling 3). It runs on scroll of `editor.view.scrollDOM` and `preview`, at
the end of `render()` and `setLayoutMode()`. `renderOutline()` re-marks `currentOutlineId`
without scrolling, then calls `updateCurrentOutline()`.

### Status bar (`src/file-editor.js`, `src/comments-panel.js`, `src/app.css`)

`renderTitle()` sets `status.textContent = statusText(buffer)` and `status.title =
buffer.path ?? ""`. A `statusKey` (`${buffer.id}:${text}`) tracks the last shown state; on a
change it clears the fade timer and the `settled` class, and if the text is "Saved" starts a
2000 ms timer (`SAVED_FADE_MS`) that adds `settled`. CSS fades `.file-status-text.settled` and
restores it on `.file-status:hover`.

`comments-panel.js` `render()`: `countButton.hidden = !editor || (all.length === 0 && !open &&
!coedit.listening)`.

### Tones (`src/themes.js`, `src/styles.css`)

`applyTheme`: `--statusbar-bg` = `theme.uiStyle ? (theme.sidebar || theme.background) :
theme.background`. `styles.css`: the four default palette blocks' `--statusbar-bg` become
`#f8fafc` (light) and `#090d16` (dark); `.editor-host .cm-editor .cm-gutters` gets
`background-color: var(--editor-bg); border-right: none`.

## Edge cases

- Document without headings: outline hidden, nothing to mark; scroll handler returns early.
- Folded section in Live: `lineBlockAtHeight` returns the fold's block, whose `from` is in the
  folding heading's section, so that heading is marked. In Reading, hidden headings are
  skipped.
- Outline collapsed: rows still get marked; no visible effect.
- Typing re-renders the outline every 150 ms pause: the mark survives, the sidebar does not
  scroll (Ruling 3).
- Switching files: `render()` recomputes; the new file starts at its own scroll position.
- A file that is "Saved" and then edited: "Saving…" appears at full opacity at once.
- Untitled file: no path, empty tooltip; "New file" / "Not saved yet" never fade.
- Comments: resolving the last open thread keeps the count visible (a resolved thread exists)
  until "Clear resolved" and the panel is closed.
- Imported theme with an unmeasurable background: `--statusbar-bg` is the raw background
  string, as `--editor-bg` already is.

## Testing

- `test/outline.test.js`: `outlineIdAt`, `readingHeadingAt` (stubbed rects, folded heading
  skipped), `isScrolledToEnd`, `markCurrentOutline`, `data-outline-id` and no `title`.
- `test/file-editor.test.js`: current section in Reading (stubbed rects + scroll event) and Live
  (stubbed `lineBlockAtHeight` + scroll event), mark survives an outline re-render; status text
  is "Saved" with the path as title and gains `settled` after 2 s, loses it on an edit.
- `test/file-comments.test.js`, `test/note-comments.test.js`: count hidden with no comments,
  shown after the first, shown as "No comments" while an agent listens.
- New `test/chrome-styles.test.js` (static CSS scan, like `editor-styles.test.js`): outline
  link wraps (`white-space: normal`, negative `text-indent`), indent 16px per level, active
  file uses `--bg-note-hover` and an accent inset bar and not `--bg-note-active`, gutter uses
  `--editor-bg`, default palettes' `--statusbar-bg` equal their `--bg-app`, settled fade rule
  and hover restore exist.
- New `test/theme-surfaces.test.js`: applying GitHub Dark sets `--statusbar-bg` to its
  background and `--topbar-bg` to its sidebar; Windows Classic keeps `--statusbar-bg` at its
  sidebar.
- Manual: cycle presets in the app, scroll a long document in each mode, watch the outline;
  check the status bar fade and hover.
