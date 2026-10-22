# Quieter Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quiet the main window's chrome (#59, clear-cut items only): an outline that wraps, is larger and marks the section in view; a lighter active-file indicator; a status bar where "Saved" fades, the path is a tooltip and "No comments" hides; and two background tones (sidebar and page).

**Architecture:** Pure outline helpers in `src/outline.js` wired into `src/file-editor.js` scroll handling; status-bar logic in `file-editor.js` and `src/comments-panel.js`; status-bar tone in `src/themes.js` `applyTheme`; everything else is CSS in `src/app.css` and `src/styles.css`.

**Tech Stack:** Vanilla ES modules, CodeMirror 6 (vendored), jsdom + `node:test`, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-10-18-quieter-chrome-design.md`

## Global Constraints

- Work only in `/Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome` (branch `feat/quieter-chrome`). Use absolute paths and `git -C <worktree>`. Never `cd` into `src/vendor` or `node_modules`. Do not run `npm ci` (`node_modules` is a symlink).
- Every JS test run uses exactly this guarded form (replace `<files>`), from the worktree root:
  `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test <files>`
- Sidebar changes are CSS plus the outline only. Do not change `renderSidebar()` in `src/file-editor.js` or the open-files markup in `src/index.html` (`feat/multi-window` owns them).
- No new settings and no new storage keys.
- New JS source files go into `check:js` in `package.json` (this plan adds none).
- Zero runtime egress; CSP unchanged.
- No em dashes anywhere (use `-`). No mention of AI, agents or Claude in code, commits, docs or PR text (the existing product terms "agent access" and "an agent is listening" are fine). Commit format `type(scope): description`. Code comments only where the why is non-obvious.
- Do not edit `RELEASE_NOTES.md`.
- Exact values: outline text `0.9rem`, link padding `6px 8px`, line-height `1.35`, indent `16px` per level, hanging indent `0.75em`; sidebar width `240px`; active-file bar `inset 2px 0 0 var(--accent-color)`; `SAVED_FADE_MS = 2000`; fade transition `opacity 0.6s`; current-section top slack `8px`; scrolled-to-end tolerance `2px`.
- The 4 MCP socket tests fail only inside the sandbox; that is expected.

## Review Focus

- Typing in a long file re-renders the outline every pause; the current mark must survive and the sidebar must not jump back to it. Pinned in Task 2 (re-render keeps `current`, `scrollIntoView` not called on re-render).
- A file that was "Saved" (and faded) then edited must show "Saving…" at full opacity at once. Pinned in Task 3.
- Switching between two clean files must not leave the second file's "Saved" invisible from the start. Pinned in Task 3 (key includes the file id).
- With an agent listening and no comments, the count must stay visible so Hold for review is reachable. Pinned in Task 4.
- Retro themes (Windows Classic, Mac OS 9 Platinum) must keep their sidebar-toned status bar. Pinned in Task 5.

---

### Task 1: Outline rows and active-file indicator styling

**Files:**
- Modify: `src/app.css` (`.files-sidebar` 231-238; `.open-file-item*` and `.open-file-name` 255-283; `.outline-item`, `.outline-link`, `.outline-progress` 456-489)
- Modify: `src/outline.js` `renderOutlineList` (64-89)
- Create: `test/chrome-styles.test.js`
- Test: `test/outline.test.js`

**Interfaces:**
- Produces: each `.outline-item` carries `data-outline-id="<entry.id>"`; `.outline-link` has no `title`. Class `current` on `.outline-item` is styled here and set by Task 2.

- [ ] **Step 1: Write the failing tests.** New `test/chrome-styles.test.js` reads `src/app.css` and `src/styles.css` as text, strips comments, and uses a `declarations(css, selector)` helper (copy the one in `test/editor-styles.test.js`, parameterised by stylesheet). Tests:
  - `"outline rows wrap with a hanging indent"`: `.outline-link` matches `/white-space:\s*normal/`, `/text-indent:\s*-0\.75em/`, `/font-size:\s*0\.9rem/`, and does not match `/text-overflow:\s*ellipsis/`; `.outline-item` matches `/calc\(var\(--outline-depth,\s*0\)\s*\*\s*16px\)/`.
  - `"the current outline row is marked by weight and an accent bar"`: `.outline-item.current` matches `/inset 2px 0 0 var\(--accent-color\)/`; `.outline-item.current .outline-link` matches `/font-weight:\s*600/`.
  - `"the active file is a lift with an accent bar, not the selection pill"`: `.open-file-item.active` matches `/var\(--bg-note-hover\)/` and `/inset 2px 0 0 var\(--accent-color\)/` and does not match `/--bg-note-active/`.
  - `"the files sidebar is 240px wide"`: `.files-sidebar` matches `/width:\s*240px/`.

  In `test/outline.test.js` add `"outline rows carry their heading id and no tooltip"`: build a JSDOM `ul`, call `renderOutlineList(list, [{ id: "a", level: 1, text: "Alpha", total: 0, reviewed: 0 }, { id: "b", level: 2, text: "Beta", total: 0, reviewed: 0 }], () => {})`, assert `[...list.children].map(li => li.dataset.outlineId)` deep-equals `["a", "b"]` and `list.querySelector(".outline-link").hasAttribute("title")` is `false`.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/chrome-styles.test.js test/outline.test.js`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - `renderOutlineList`: set `item.dataset.outlineId = entry.id`; remove `link.title = entry.text`.
  - `app.css`: `.files-sidebar` width `240px`. `.open-file-item.active`: `background: var(--bg-note-hover); box-shadow: inset 2px 0 0 var(--accent-color);`; add `.open-file-item.active .open-file-name { font-weight: 600; }`; keep the hover rule. `.outline-item`: `align-items: baseline; padding-left: calc(var(--outline-depth, 0) * 16px);`. `.outline-link`: `padding: 6px 8px 6px calc(8px + 0.75em); text-indent: -0.75em; font-size: 0.9rem; line-height: 1.35; color: var(--text-secondary); white-space: normal; overflow-wrap: anywhere;` and remove `overflow: hidden`, `text-overflow`, `white-space: nowrap`. Add `.outline-item.current { box-shadow: inset 2px 0 0 var(--accent-color); }` and `.outline-item.current .outline-link { color: var(--text-primary); font-weight: 600; }`.

- [ ] **Step 4: Run the tests**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/chrome-styles.test.js test/outline.test.js test/file-editor.test.js`
Expected: PASS (the existing outline row test in `file-editor.test.js` reads `textContent`, which is unchanged).

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome add src/app.css src/outline.js test/chrome-styles.test.js test/outline.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome commit -m "feat(sidebar): larger wrapping outline rows and a lighter active file"
```

### Task 2: Mark the outline section in view

**Files:**
- Modify: `src/outline.js` (new exports after `nextUnreviewed`)
- Modify: `src/file-editor.js` (imports 21-29; state near 86; `renderOutline` 285-299; `render` 353-384; `setLayoutMode` 748-765; `attach` 829-865)
- Test: `test/outline.test.js`, `test/file-editor.test.js`

**Interfaces:**
- Consumes: `data-outline-id` on `.outline-item` and the `.current` styling (Task 1). `ANCHOR_ATTRIBUTE` from `src/anchors.js` (already imported in `outline.js`). The existing `TOP_SLACK_PX = 8` in `file-editor.js`.
- Produces (in `src/outline.js`):
  - `outlineIdAt(entries: {id: string, from: number}[], pos: number): string | null` - id of the last entry with `from <= pos`, else `null`.
  - `readingHeadingAt(root: Element, y: number): string | null` - over `root.children` that are `H1`-`H6`, carry `ANCHOR_ATTRIBUTE` and lack class `section-fold-hidden`, the anchor id of the last one whose `getBoundingClientRect().top <= y`, else `null`.
  - `isScrolledToEnd(scroller: {scrollTop, clientHeight, scrollHeight}): boolean` - `scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2`.
  - `markCurrentOutline(list: Element, id: string | null): Element | null` - toggles `current` on every `.outline-item` by `dataset.outlineId === id`; on the current row's `.outline-link` sets `aria-current="location"`, removes `aria-current` from the others; returns the current item or `null`.

- [ ] **Step 1: Write the failing unit tests** in `test/outline.test.js`:
  - `"outlineIdAt picks the last heading at or above a position"`: entries `[{id:"a",from:0},{id:"b",from:10},{id:"c",from:20}]`; `pos 15 -> "b"`, `pos 20 -> "c"`, `pos 0 -> "a"`; entries starting at 5 with `pos 2 -> null`; `[]` -> `null`.
  - `"readingHeadingAt skips folded headings and returns the last one above the line"`: JSDOM root with `<h1 data-anchor="a">`, `<p>`, `<h2 data-anchor="b" class="section-fold-hidden">`, `<h2 data-anchor="c">` (use the attribute name from `ANCHOR_ATTRIBUTE`); stub each heading's `getBoundingClientRect` to tops `0`, `50`, `100`; assert `y=60 -> "a"`, `y=100 -> "c"`, `y=-1 -> null`.
  - `"isScrolledToEnd needs a scrolled view at its bottom"`: `{0,100,100} -> false`; `{50,100,150} -> true`; `{49,100,152} -> false`; `{47,100,149} -> true`.
  - `"markCurrentOutline moves the mark and aria-current"`: render two entries with `renderOutlineList`, `markCurrentOutline(list, "b")` returns the second `li`, which has class `current` and its link `aria-current === "location"`; then `markCurrentOutline(list, null)` returns `null` and no row has `current` or `aria-current`.

- [ ] **Step 2: Write the failing integration tests** in `test/file-editor.test.js` (new boot instances 13 and 14; reuse `lists()` and the `beforeBoot` from the existing outline test that sets `dom.window.marked` and stubs `scrollIntoView`; in instance 13 make the stub count calls):
  - `"the outline marks the section in view in Reading mode"`: file `# Book\n\nIntro\n\n## Engine\n\nBody\n\n## Notes\n\nDeep\n`. `app.click("mode-reading")`. Stub `getBoundingClientRect` on `#markdown-preview` (top 0) and on its `[data-anchor=book]`, `[data-anchor=engine]`, `[data-anchor=notes]` headings (tops `-300`, `-20`, `400`). Dispatch `new Event("scroll")` on `#markdown-preview`. Assert the `.outline-item.current` has `dataset.outlineId === "engine"` and its link `aria-current === "location"`; assert the scrollIntoView counter increased by 1. Change the stubs so `notes` is at `-5`, dispatch scroll, assert `notes` is current. Dispatch scroll again with no change: the counter does not increase.
  - `"the outline mark follows Live scrolling and survives a re-render"`: same file, Live mode. Set `app.editor().lineBlockAtHeight = () => ({ from: <index of "## Notes"> })` on the instance, dispatch `scroll` on `app.editor().scrollDOM`, assert `notes` is current. Record the scrollIntoView counter, type a character at the end of the document (`userEvent: "input.type"`), `await app.settle(250)` (outline delay is 150 ms), assert `notes` is still current and the counter did not change.

- [ ] **Step 3: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/outline.test.js test/file-editor.test.js`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement the four exports in `src/outline.js`** per the Interfaces block.

- [ ] **Step 5: Wire it in `src/file-editor.js`.**
  - State: `let outlineShown = [];` and `let currentOutlineId = null;`. Move `TOP_SLACK_PX` above its first use if needed.
  - `renderOutline()`: store `outlineShown = entries`; after `renderOutlineList(...)` call `markCurrentOutline(outlineList, currentOutlineId)` (no scroll), then `updateCurrentOutline()`.
  - `updateCurrentOutline()`: return if `outlineSection.hidden`. Reading: `const box = preview.getBoundingClientRect(); const y = isScrolledToEnd(preview) ? box.bottom : box.top + TOP_SLACK_PX; id = readingHeadingAt(preview, y)`. Live/Source: `const { view } = editor; const box = view.scrollDOM.getBoundingClientRect(); const edge = isScrolledToEnd(view.scrollDOM) ? box.bottom : box.top + TOP_SLACK_PX; id = outlineIdAt(outlineShown, view.lineBlockAtHeight(edge - view.documentTop).from)`. If `id !== currentOutlineId`: set it, then `markCurrentOutline(outlineList, id)?.scrollIntoView?.({ block: "nearest" })`.
  - Call `updateCurrentOutline()` at the end of `render()` and of `setLayoutMode()`.
  - `attach()`: `editor.view.scrollDOM.addEventListener("scroll", updateCurrentOutline, { passive: true })` and the same on `preview`.

- [ ] **Step 6: Run the tests**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/outline.test.js test/file-editor.test.js test/file-scroll.test.js test/file-links.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome add src/outline.js src/file-editor.js test/outline.test.js test/file-editor.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome commit -m "feat(outline): highlight the section in view"
```

### Task 3: "Saved" fades and the path moves to a tooltip

**Files:**
- Modify: `src/file-editor.js` (`statusText`/`renderTitle` 175-188; constants near 36-38)
- Modify: `src/app.css` (`.file-status-text` 384-389)
- Test: `test/file-editor.test.js`, `test/chrome-styles.test.js`

**Interfaces:**
- Produces: `#file-status` text is exactly `statusText(buffer)` (no path); `#file-status.title` is the file path or `""`; class `settled` on `#file-status` after `SAVED_FADE_MS = 2000` ms of "Saved".

- [ ] **Step 1: Write the failing tests.**
  - In the first test of `test/file-editor.test.js` ("Open File shows the file..."), replace the last assertion with `assert.equal(status.textContent, "Saved")` and `assert.equal(status.title, "/docs/plan.md")` where `status = doc(app).getElementById("file-status")`.
  - New test (instance 15) `"Saved fades after a moment and an edit brings the status back"`: open `/docs/a.md` (`lists({ open: ["/docs/a.md"] })`), assert text `"Saved"` and no `settled`; `await app.until(() => status.classList.contains("settled"), 4000)` and assert it has `settled`; type a character (`input.type`), assert synchronously text matches `/^Saving…/` and `settled` is gone; `await app.settle(700)` then text `"Saved"` without `settled`.
  - New test (instance 16) `"switching files restarts the fade"`: open two files, wait for `settled`, click the other `.open-file-name`, assert `"Saved"` without `settled`.
  - In `test/chrome-styles.test.js`: `"a settled status fades and returns on hover"`: `.file-status-text.settled` matches `/opacity:\s*0\b/`; `.file-status:hover .file-status-text.settled` matches `/opacity:\s*1\b/`; `.file-status-text` matches `/transition:\s*opacity 0\.6s/`; the stylesheet contains a `prefers-reduced-motion` block whose body contains `.file-status-text` and `transition: none`.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-editor.test.js test/chrome-styles.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `renderTitle()`: `status.textContent = buffer ? statusText(buffer) : ""; status.title = buffer?.path ?? "";`. Track `let statusKey = null; let fadeTimer = null;` - key is `buffer ? \`${buffer.id}:${text}\` : null`; when it changes, `clearTimeout(fadeTimer)`, remove `settled`, and if the text is `"Saved"` start `fadeTimer = setTimeout(() => status.classList.add("settled"), SAVED_FADE_MS)`. CSS in `app.css`: `.file-status-text { transition: opacity 0.6s; }`, `.file-status-text.settled { opacity: 0; }`, `.file-status:hover .file-status-text.settled { opacity: 1; }`, `@media (prefers-reduced-motion: reduce) { .file-status-text { transition: none; } }`.

- [ ] **Step 4: Run the tests**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-editor.test.js test/chrome-styles.test.js test/file-comments.test.js test/agent-access-main.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome add src/file-editor.js src/app.css test/file-editor.test.js test/chrome-styles.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome commit -m "feat(status-bar): fade Saved and show the path on hover"
```

### Task 4: Comment count only when relevant

**Files:**
- Modify: `src/comments-panel.js` `render()` (343-352)
- Test: `test/file-comments.test.js` (lines 39-40), `test/note-comments.test.js` (line 18)

**Interfaces:**
- Consumes: `coedit.listening`, `open`, `all`, `editor` already in `render()`.
- Produces: `countButton.hidden = !editor || (all.length === 0 && !open && !coedit.listening)`.

- [ ] **Step 1: Update the tests to the new rule.**
  - `test/file-comments.test.js`: replace the two assertions at 39-40 with `assert.equal($("comments-count-btn").hidden, true, "no comments, no agent: hidden")`; after the first comment (where the test asserts `"1 comment"`) add `assert.equal($("comments-count-btn").hidden, false)`. Add a second test (boot `instance: 2`, same `handlers`) `"the count shows No comments while an agent listens"`: `app.emit("coedit-state", { holdForReview: false, listening: true })`, `await app.settle()`, assert `hidden === false`, text `"No comments"`, class `listening`; emit `listening: false`, settle, assert `hidden === true`.
  - `test/note-comments.test.js`: replace line 18 with `assert.equal(document.getElementById("comments-count-btn").hidden, true)`; after the `"1 comment"` assertion add `hidden === false`.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-comments.test.js test/note-comments.test.js`
Expected: FAIL on the hidden assertions.

- [ ] **Step 3: Implement** the `hidden` rule from Interfaces in `render()`.

- [ ] **Step 4: Run the tests**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/file-comments.test.js test/file-comments-linux.test.js test/note-comments.test.js test/hunk-comments.test.js test/coedit-integration-ui.test.js`
Expected: PASS. `file-comments-linux.test.js` clicks `comments-count-btn` while it is now hidden (no comment exists yet); jsdom still dispatches the click and the empty panel shows the Ctrl+Alt+M hint, so leave that test unchanged and add `assert.equal(app.dom.window.document.getElementById("comments-count-btn").hidden, true)` before the click to document it.

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome add src/comments-panel.js test/file-comments.test.js test/note-comments.test.js test/file-comments-linux.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome commit -m "feat(comments): hide the count when there is nothing to show"
```

### Task 5: Two surfaces - status bar and gutter take the page tone

**Files:**
- Modify: `src/themes.js` `applyTheme` (line 178)
- Modify: `src/styles.css` (default palette `--statusbar-bg` at 367, 421, 473, 526; `.editor-host .cm-editor .cm-gutters` 1785-1792)
- Create: `test/theme-surfaces.test.js`
- Test: `test/chrome-styles.test.js`

**Interfaces:**
- Produces: `--statusbar-bg` = `theme.background`, or `theme.sidebar || theme.background` when `theme.uiStyle` is set. `--topbar-bg`, `--sidebar-bg`, `--bg-sidebar` unchanged.

- [ ] **Step 1: Write the failing tests.**
  - New `test/theme-surfaces.test.js` with `bootMainWindow` (`qn_get_config` handler as in `test/file-editor.test.js`'s `lists()`):
    - instance 1, `storage: { sodilaud_active_theme: "github-dark" }`: root `--statusbar-bg` equals the GitHub Dark preset's `background`, `--topbar-bg` equals its `sidebar` (look both up from `PRESET_THEMES`).
    - instance 2, `"windows-classic"`: `--statusbar-bg` equals that preset's `sidebar`.
  - In `test/chrome-styles.test.js`:
    - `"default palettes give the status bar the page tone"`: for every `{...}` block in `styles.css` that declares `--bg-app:`, the `--statusbar-bg` value equals the `--bg-app` value (expect 4 blocks).
    - `"the line-number gutter has no band of its own"`: `.editor-host .cm-editor .cm-gutters` matches `/background-color:\s*var\(--editor-bg\)/` and `/border-right:\s*none/`, and does not match `/--preview-code-bg/`.

- [ ] **Step 2: Run to see them fail**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/theme-surfaces.test.js test/chrome-styles.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** `themes.js` line 178 per Interfaces. `styles.css`: light blocks `--statusbar-bg: #f8fafc;`, dark blocks `--statusbar-bg: #090d16;`; gutter rule `background-color: var(--editor-bg); border-right: none;` (keep font, size, line-height, colour).

- [ ] **Step 4: Run the theme and editor suites**

Run: `RSS_GUARD_MB=4096 NODE_OPTIONS="--max-old-space-size=2048 --import=/Users/laas/proged/sodilaud/.claude/worktrees/_handoff/rss-guard.mjs" perl -e 'alarm 300; exec @ARGV' node --test test/theme-surfaces.test.js test/chrome-styles.test.js test/theme-apply.test.js test/theme-default.test.js test/theme-switch.test.js test/theme-document-colors.test.js test/theme-unmeasurable.test.js test/theme-non-hex.test.js test/editor-styles.test.js test/editor-line-numbers.test.js test/split-view.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome add src/themes.js src/styles.css test/theme-surfaces.test.js test/chrome-styles.test.js
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome commit -m "feat(themes): status bar and gutter share the page tone"
```

### Task 6: Documentation, full CI mirror and PR body

**Files:**
- Modify: `README.md` (feature list near line 73-86; Line numbers paragraph near 208)
- Modify: `docs/coedit.md` (line 27), `docs/files.md` (near line 55)
- Modify: `ROADMAP.md` (append an item)
- Create (uncommitted, not staged): `.pr-body.md`

- [ ] **Step 1: User docs.** README feature list: extend the review-books line's "an outline with review progress" to "an outline that wraps long headings, marks the section you are reading, and shows review progress". Line-numbers paragraph: say the gutter now sits on the page background. `docs/coedit.md` line 27: the count appears once a file has comments or while an agent is listening. `docs/files.md`: add one sentence that the status bar shows the save state ("Saved" fades after a moment) and the file's path on hover.

- [ ] **Step 2: ROADMAP.md.** Append the next numbered item after the last one, "Quieter chrome", with `Status: partly done, to ship in the next release (#59) (spec [docs/superpowers/specs/2026-10-18-quieter-chrome-design.md](docs/superpowers/specs/2026-10-18-quieter-chrome-design.md))`, one sentence on what shipped, and the "Not done, needs a decision" list from the spec, one line each.

- [ ] **Step 3: Full CI mirror** from the worktree root:

```bash
NODE_OPTIONS=--max-old-space-size=2048 perl -e 'alarm 900; exec @ARGV' npm run check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo fmt --manifest-path src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
CARGO_TARGET_DIR=/Users/laas/proged/sodilaud/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run check:egress
```

Expected: all pass; only the 4 MCP socket tests may fail inside the sandbox. Then `git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome diff main --stat -- README.md ROADMAP.md docs src test | cat` and `grep -rn "$(printf '\342\200\224')" docs/superpowers/specs/2026-10-18-quieter-chrome-design.md docs/superpowers/plans/2026-10-18-quieter-chrome.md README.md ROADMAP.md docs/coedit.md docs/files.md src/outline.js src/app.css test/chrome-styles.test.js test/theme-surfaces.test.js`: expect no matches from this branch's lines.

- [ ] **Step 4: Write `.pr-body.md`** in the worktree root (do not stage it; check `git status` shows it untracked). Contents: a short summary of the six shipped changes; `Refs #59` (not `Closes`); a "Still open in #59" list copied from the spec's "Not done, needs a decision" (merged title bar and toolbar, floating formatting pill, Open Files/Outline tabs, focus mode hiding the status bar, line-number numbering in Live mode, soft line breaks report, smaller MCP indicator), one line each with the reason; testing notes (new `test/chrome-styles.test.js`, `test/theme-surfaces.test.js`, outline and status tests); and the release-notes paragraph: "Quieter window chrome: the outline wraps long headings, uses larger rows and marks the section you are reading as you scroll. The active file is marked with a thin accent bar instead of a coloured block. In the status bar, Saved fades after a moment, the file path shows on hover, and the comment count appears only when there are comments or an agent is listening. The status bar and line-number gutter now share the page background."

- [ ] **Step 5: Commit**

```bash
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome add README.md ROADMAP.md docs/coedit.md docs/files.md
git -C /Users/laas/proged/sodilaud/.claude/worktrees/quieter-chrome commit -m "docs(chrome): document the quieter sidebar and status bar"
```
