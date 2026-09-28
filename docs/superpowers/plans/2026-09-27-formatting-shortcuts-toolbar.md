# Formatting Shortcuts and Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Markdown formatting from the keyboard and from a formatting group in the top bar, in the CodeMirror editor on `feat/cm6-editor`.

**Architecture:** Formatting logic is pure `(value, selectionStart, selectionEnd) -> {value, selectionStart, selectionEnd} | null` functions in a new `src/markdown-format.js`, following the existing `editor-smart.js`/`markdown-insert.js` pattern. The editor applies them through `applyPureEdit` (`src/editor-commands.js`) from a `Prec.high` keymap. The top-bar buttons call the same functions on the active pane's editor. No new dependencies.

**Spec:** the user's decisions of 2026-09-27, recorded in Global Constraints below.

## Global Constraints

- Shortcuts (Mod = `⌘` on macOS, Ctrl elsewhere): Bold `Mod-b`, Italic `Mod-i`, Link `Mod-k`, Strikethrough `Shift-Mod-x`, Inline code `Mod-e`, Heading 1-6 `Alt-Mod-1`..`Alt-Mod-6` (pressing the current level's key again removes the heading), Numbered list `Shift-Mod-7`, Bullet list `Shift-Mod-8`, Task list `Shift-Mod-9`, Quote `Shift-Mod-.`, Code block `Alt-Mod-c`.
- The sidebar toggle moves from `⌘B` to `⌃⌘S` (Ctrl+Alt+S off macOS if Ctrl+Mod+S is the same chord; keep the existing platform label logic). Every user-visible mention of the old shortcut changes (tooltip, help modal, README).
- CodeMirror's `defaultKeymap` binding `Mod-i` (selectParentSyntax) must no longer fire. Remove any other `defaultKeymap` binding that collides with the shortcuts above.
- Toolbar: a separate button group in the main top bar, directly left of the Live/Source/Reading mode buttons (`.layout-controls`), grouped with them. Buttons: Bold, Italic, Strikethrough, Inline code, Link | Heading menu (H1-H6 and Paragraph), Bullet list, Numbered list, Task list, Quote | Code block, Table, Horizontal rule. Each has `aria-label` and a `title` with the shortcut (platform-correct via the existing `applyPlatformShortcutLabels` mechanism). The formatting group is disabled (not hidden) in Reading mode.
- Buttons act on the active pane's editor (`activePane`: primary or secondary). A click must not steal focus or lose the selection: prevent default on `mousedown`, then apply, then refocus that editor.
- Toggle semantics:
  - **Inline marks** (`**`, `*`, `~~`, `` ` ``): with a selection already wrapped by the marker (just inside or just outside the selection), unwrap. Otherwise wrap. With an empty selection inside a word, act on that word. With an empty selection outside a word, insert the marker pair and put the caret between.
  - **Link**: wrap the selection as `[selection](url)` with `url` selected. With an empty selection, reuse the `link` template from `markdown-insert.js`.
  - **Headings**: set every selected line to that level, or remove it if all are already at that level. Paragraph removes the heading.
  - **Lists and quote**: toggle the prefix on every selected line. Switching between list kinds replaces the prefix. Numbered lists are renumbered 1..n. Indentation is preserved.
  - **Code block, table and horizontal rule**: insert via `getMarkdownTemplateEdit`. Add a `horizontal-rule` template (`---`, block) if it is missing. Code block with a selection wraps the selected lines in a fence.
- Every formatting action is one undo step.
- Files start with `// SPDX-License-Identifier: GPL-3.0-or-later`. No em dashes. New `src/*.js` files go into `package.json` `check:js`.
- Tests: `node --test` + jsdom. Always run with a heap cap and a time cap: `NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 900; exec @ARGV' npm run check` (macOS has no `timeout`; an uncapped run once grew to 150 GB). Assertions compare strings, numbers or booleans, never DOM nodes.
- Commits: `type(editor): ...` ending with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`. Never push. npm, if needed: `npm_config_cache=$TMPDIR/npm-cache`.

## Review Focus

1. Shortcuts with Shift or Alt on macOS produce different `event.key` values (`&`, `*`, `(`, `>`, `¡`, `ç`). The keymap must still match by physical key. Pinned in Task 1 with KeyboardEvents that carry the real macOS `key` plus `keyCode`.
2. `⌘I` and `⌘B` no longer reach `selectParentSyntax` or the sidebar. Pinned in Task 1 (editor) and Task 2 (app boot test).
3. A toolbar click keeps the selection and applies to the pane that was last focused, including the secondary pane in split-note. Pinned in Task 2.
4. Toggling twice restores the original text for every action (round trip). Pinned in Task 1.
5. Multi-line selections: headings, lists and quotes apply per line. Blank lines inside a selection are left alone. Pinned in Task 1.

---

### Task 1: Formatting functions and editor keymap

**Files:** Create `src/markdown-format.js`, `test/markdown-format.test.js`. Modify `src/editor-commands.js` (add `markdownFormattingKeymap()` or extend `markdownEditingCommands()`), `src/editor-view.js` (drop the colliding `defaultKeymap` entries, same way the Alt-Arrow ones were filtered), `src/markdown-insert.js` (`horizontal-rule` template if missing), `test/editor-commands.test.js`, and `package.json` `check:js`.

**Produces:** `export const FORMAT_ACTIONS` (ids: `bold`, `italic`, `strikethrough`, `code`, `link`, `heading-1`..`heading-6`, `paragraph`, `bullet-list`, `numbered-list`, `task-list`, `quote`, `code-block`, `table`, `horizontal-rule`) and `export function getFormatEdit(value, selectionStart, selectionEnd, actionId) -> edit | null`. It also exports `export function runFormatAction(view, actionId): boolean` from `editor-commands.js`, and the keymap bound to the Global Constraints shortcuts.

Steps: write failing pure-function tests first. Cover every action and the Review Focus 4 and 5 cases, including wrap/unwrap for each inline mark, word-at-cursor, empty-selection insert, a link with and without a selection, heading set/change/remove across lines, list kind switching and renumbering, quote toggle, and a code block around a selection. Then write the keymap tests on a mounted editor (Review Focus 1 and 2, one undo step per action). Implement, then run `npm run check` capped and commit `feat(editor): Markdown formatting commands and shortcuts`.

### Task 2: Top-bar formatting group, sidebar shortcut, docs

**Files:** Modify `src/index.html` (button group before `.layout-controls`, heading menu, tooltips, help modal shortcut list), `src/main.js` (sidebar `⌃⌘S`; toolbar wiring through `runFormatAction` on the active pane's editor; disable the group in Reading mode; platform shortcut labels), `src/styles.css` (group styling, consistent with the existing `.layout-btn`/`.icon-btn` look and theme variables, and a narrow-window behavior: the group may wrap or collapse, but must not overlap), `README.md`, `RELEASE_NOTES.md` (Unreleased entry), and tests (a new `test/formatting-toolbar.test.js` app-boot test, plus updates to any test asserting `⌘B`/`Cmd+B` or the old help text).

Steps: write failing app tests first:
- A toolbar Bold click on a selection in the primary editor wraps it, with the selection kept and focus returned.
- After focusing the secondary pane in split-note, a Bullet list click applies there only.
- The group is disabled in Reading mode and enabled in Live and Source.
- `⌃⌘S` toggles the sidebar, and `⌘B` with the editor focused bolds without toggling the sidebar.
- The heading menu sets H2.

Implement, update the docs, run `npm run check` capped, and commit `feat(editor): formatting toolbar and sidebar shortcut on Ctrl-Cmd-S`.
