# Review book: guided code review in Sodilaud

Date: 2026-10-07
Status: approved design, not built
Roadmap: items 10 to 14

## Problem

Agentic coding produces pull requests of 50 to 120 files (0.11.0: 137 files, 0.12.0: 127
files). Reading them as a diff in file order loses the thread of the change. The difit
workflow helps on small changes: its description says what and why, the diff shows how. On a
large change the reader still gets lost in the file list.

The reviewer wants to act as the tech lead of an expert outsourced team: stay stakeholder and
architect, not hands-on in the code, yet sign off every line as their own. That means three
things per change: trust every line, understand what the whole does, and judge whether the
layout is maintainable.

## Goal

After a feature is complete, the agent that wrote it presents the change as an interactive
book in Sodilaud: narrative and diagrams per functionality, followed by the diff hunks that
implement it, with links between functions and chapters. The reviewer reads in the order the
author intended, marks each hunk as reviewed, and discusses design choices with the agent in
anchored comment threads. The discussion is for understanding, not a change-request queue:
the agent explains why it chose a path, and changes code only when told to in the thread.

Coverage is enforced: every hunk of the diff belongs to exactly one chapter, and the review
cannot be signed off until every hunk is marked reviewed and every thread is resolved.

## Non-goals

- A symbol index or language server. Links are written by the agent.
- Opening the real source file from a hunk in an external editor.
- Commenting in Reading mode and on tables. That is roadmap item 9, built separately.
- A standalone viewer. The point of this design is to grow Sodilaud and dogfood it.
- Raw `details` and `summary` HTML in the sanitizer. Folding by heading covers the need.

## 1. Book format

The format is skill-side and independent of the viewer. Today's Sodilaud already renders it
as plain Markdown with colored diff fences; the rendering items below make it interactive.

### Location

`<repo>/.claude/review/<branch-slug>/`, excluded from git through `.git/info/exclude`. The
path is stable across re-generation, so Sodilaud's per-path comments and the reviewed marks
survive every re-push of the same review. The folder stays on disk until the branch is
deleted.

### Files

| File | Content |
|---|---|
| `00-overview.md` | Rationale (1 to 3 sentences, no heading). Approach and trade-offs. One Mermaid architecture diagram. Reading order: a numbered list linking the chapters. File map. Tests section. |
| `01-<topic>.md` to `0n-<topic>.md` | One chapter per functionality, in reading order. Narrative, optional sequence diagrams, and the hunks the chapter owns, in the order a reader should meet them. |
| `90-tests.md` | Owns every test hunk. Lists which chapter each test file exercises. Carries coverage numbers when the project has a coverage command. |
| `99-everything-else.md` | Owns every hunk no chapter claimed, grouped by file, one line of explanation each. Lockfiles, generated files and renames land here. |
| `manifest.json` | Machine-readable hunk list. Only the checker and the skill read it. |

The narrative follows the describe-changes skill's layered order and its quoting rules for
Mermaid.

### Hunk block

A hunk is a fenced `diff` block whose info string carries metadata:

````
```diff path=src-tauri/src/mcp.rs hunk=h3f2a lines=120-168
@@ -120,7 +120,30 @@ fn register_tools(
 ...
```
````

- `path`: path relative to the repository root. Required.
- `hunk`: `h` plus the first five hex characters of the SHA-256 of `path`, a newline, and the
  hunk body. An edited hunk gets a new id, which is what makes "changed since you read" fall
  out: a changed hunk is a new, unreviewed one. Required.
- `lines`: new-side line range. Required. For a deletion, the old-side range prefixed `old:`.
- `reviewed`: present when the reviewer has marked the hunk. Written only by Sodilaud's
  toggle. The generator never emits it, and re-generation of an unchanged hunk preserves it.

The body is a unified diff hunk with three lines of context, exactly as `git diff -U3`
prints it, including the `@@` header. Hunks show diffs, not the final code.

A file's hunks may be split across chapters. A hunk is owned by one chapter and may be
linked from any number of others.

### Links

- Headings get GitHub-style slugs (lowercase, spaces to hyphens, punctuation removed,
  duplicates suffixed `-1`, `-2`).
- Within a chapter: `[the merge engine](#merge-engine)`.
- To another chapter or hunk: `[register_tools()](01-mcp-tools.md#h3f2a)`.
- A hunk's anchor is its id.

### File map

A table in the overview with one row per changed file: path, status (added, modified,
deleted, renamed from), hunk count, owner chapters, referring chapters. Each chapter name
links to the chapter.

### Tests section

In the overview: test files added or changed, each mapped to the chapter it covers, and,
when the project exposes a coverage command, line coverage per changed non-test file. It
never explains test bodies.

### Manifest

```json
{
  "base": "<merge-base sha>",
  "head": "<worktree hash at generation>",
  "hunks": [
    {"id": "h3f2a", "path": "src-tauri/src/mcp.rs", "lines": "120-168",
     "owner": "01-mcp-tools.md", "refs": ["03-review-loop.md"]}
  ],
  "signedOff": null
}
```

### Checker

A script in the skill, run after generation and after every re-push. It fails when:

- a hunk of `git diff <base>` has no owner or more than one owner;
- a hunk block in the book no longer matches the working tree;
- a hunk block exists that the diff does not contain;
- a link points at a missing file or anchor;
- the `@@` header or `lines` of a block disagrees with the diff.

The agent cannot open the review until the checker passes.

## 2. Rendering primitives

Four generic editor features. Facts that shape them: the sanitizer strips `id`, `data-*`
and relative `href`; Marked keeps only the first word of a fence info string; Mermaid already
uses a Live widget plus a post-sanitize DOM pass in Reading mode; opening a file needs a
grant.

### Links and anchors

- Reading mode: heading ids are added in a post-sanitize pass over `h1` to `h6`, with the
  slug rules above. The sanitizer is not widened.
- Live mode: the target offset comes from the Lezer tree (ATX headings) and the editor
  scrolls with `scrollToRange`.
- `#slug` scrolls within the document.
- `chapter.md#slug` opens a sibling and then scrolls. The sanitizer keeps relative `href`
  values that have no scheme, no leading `/`, no `..` segment, and end in `.md`, `.markdown`
  or `.txt` before an optional `#fragment`. A new Rust command `file_doc_open_sibling(fromPath,
  relative)` resolves the target against the directory of the current granted file, requires
  that the canonical result stays inside that directory or below, exists, and is a text file,
  then grants and opens it the way `open_for_agent` does. Anything else is refused and the
  click does nothing.
- Click behaviour stays as today: plain click in Reading mode, Cmd-click in Live mode.
- Hunk widgets expose their id as an anchor.

### Diff hunk widget

A `diff` fence with a `path=` attribute renders as a widget. A `diff` fence without it stays
a plain highlighted block.

- Live mode: detected in `buildBlocks` from the fence info string like Mermaid. Raw when the
  cursor touches the block, widget otherwise.
- Reading mode: a Marked renderer override emits `<pre><code class="language-diff"
  data-path data-hunk data-lines data-reviewed>`. The sanitizer allows exactly these four
  attributes on `code`, with strict value patterns (`path`: no scheme, no `..`, printable;
  `hunk`: `^h[0-9a-f]{5}$`; `lines`: `^(old:)?\d+-\d+$`; `reviewed`: empty). A
  post-sanitize pass swaps the element for the widget.
- Widget: header with path, line range, Reviewed toggle, collapse toggle; body with old and
  new line-number gutters, add and delete backgrounds, and syntax highlighting from
  Highlight.js using the language chosen from the file extension, falling back to the diff
  grammar. Clicking a line number opens the comment composer anchored to that line's text in
  the fence (section 3).
- Copy-as-HTML and export emit a plain highlighted diff block with the path as a caption.
- Reviewed toggle: adds or removes the `reviewed` token in the fence info string through the
  registry, so it works from Reading mode too. The document is the only state store. A
  re-pushed hunk has a new id and no token, so it resets. The agent reads progress through
  `read_document`.
- Collapse state is per session and not written to the file.

### Section folding

A chevron on headings in Live and Reading mode folds the section up to the next heading of
the same or higher level. Fold state is per session.

### Outline panel

A collapsible sidebar section listing the active document's headings, click to scroll. A
heading whose section contains hunks shows reviewed over total. The status bar shows
"n/m reviewed" next to the comments count when the document has hunks.

## 3. Discussion threads

Today a thread is one level deep: the agent asks, the owner answers or resolves, and the
agent's only reply channel is the resolve note (`docs/comments.rs`, `docs/coedit.rs`).

### Model

- A thread is a root comment plus an ordered list of replies, any depth, any author.
  Replies share the root's anchor range. `reply_to` is kept and always points at the root.
- States stay: owner replies travel Held, Queued, Sent like root comments, so "Hold for
  review" batching works. Agent replies are Open.
- Resolve closes the whole thread, from either side. The agent resolves with a note; the
  owner resolves from the panel without one.
- The "only an open agent comment can be answered" rule becomes "any unresolved thread can
  be answered".

### MCP

- New write tool `reply_comment(commentId, body)`: posts an agent reply on an unresolved
  thread without resolving it. `commentId` may name the root or any reply. Added to
  `WRITE_TOOLS`.
- `get_pending_comments` returns queued owner comments including replies. Each item carries
  `thread`: the root and every reply so far, oldest first, as `{id, author, body,
  createdAt}`. `replyTo` stays for compatibility.
- `add_comment`, `resolve_comment` and `read_document` keep their shapes; `read_document`
  comments include replies.

### Skill rule

Discussion by default, change on request. The app does not decide this. The agent answers
questions in the thread with reasons, and touches code only when the owner says so in that
thread.

### UI

- The comments panel shows threads nested: root, then replies indented, with a reply box on
  every unresolved thread.
- A new agent reply gets an unread marker. The status bar count reads "3 comments, 1 new"
  until the thread is opened.
- Hunk widgets offer a per-line comment: clicking a line number opens the composer anchored
  to that line's text inside the fence, so no selection inside a widget is needed.
- Reviews run in Live mode until roadmap item 9 brings commenting to Reading mode. Reading
  mode still renders hunks, links and the Reviewed toggle.

## 4. Review session

A skill named `review-book`, with its checker script, lives in `src-tauri/resources/claude/`
and is installed by the Agent Access menu next to the `/sodilaud` command, through
`integration.rs`.

### Generate

When a feature is done and tests pass, before opening a PR:

1. Compute the diff from the merge base to the working tree, split it into hunks, assign ids.
2. Write the overview and chapters. The agent that wrote the code writes the book.
3. Run the checker. Fix until it passes.
4. Open the overview with `open_document`, then every chapter in order, so the sidebar shows
   the book in reading order.

### Read and discuss

The agent waits on `get_pending_comments` with the long poll and stays in the loop until
sign-off. Three kinds of owner messages, told apart by content:

- A question: reply in the thread with the reasoning. Add a diagram or paragraph to the
  chapter when the answer belongs in the book.
- A change request ("do it"): edit the code, run the relevant tests, regenerate only the
  hunks that changed, rewrite the owning chapters with `apply_edit`, re-run the checker,
  update the manifest, and reply in the thread with links to the new hunk ids.
- A decision with no action ("fine, leave it"): resolve the thread with a one-line note.

### Progress

The agent never marks anything reviewed. The owner toggles each hunk; the outline and status
bar show the counts; the agent reads them with `read_document`.

### Sign-off

When the owner writes "sign off" in a comment on the overview, the agent checks that every
hunk in the manifest is reviewed and every thread resolved. If not, it replies with what is
missing. If so, it writes `signedOff` with the head hash into the manifest, resolves the
thread, and moves on to the PR, using the overview's rationale and approach as the PR
description.

### Idle and recovery

The loop ends after three empty long polls (about 90 minutes), like the co-edit loop.
Re-running the skill on the same branch reads the manifest, diffs it against the current
tree, regenerates only changed hunks, and keeps every reviewed mark and thread that still
applies.

## 5. Phasing

### Branch strategy

Decided 2026-10-07: the whole feature is built on a long-running branch, `feat/review-book`,
so the decision whether it belongs in Sodilaud is made at the end, with the complete thing in
hand, before anything reaches `main`.

- `feat/review-book` is created from the roadmap branch (item 9) so items 9 to 14 line up.
  This spec is its first commit.
- Each item below is a short-lived branch and pull request targeting `feat/review-book`,
  squash-merged there as usual. Checks run on every PR.
- `main` is merged into `feat/review-book` after each release on `main`, so the final diff
  stays small.
- The final PR to `main` uses a merge commit, not squash, so the five item commits survive.
  No release happens before that merge.

### Items

Build order. Each is usable on its own.

1. **Item 10, review book skill.** The `review-book` skill and checker, installed by the
   Agent Access menu. Acceptance: generate the book for PR #25's diff, open it in today's
   Sodilaud, read it. Hunks show as colored diff fences, links are dead, threads are one
   level. This alone shows whether chapters beat file order.
2. **Item 11, links and anchors.** Heading ids, in-document and sibling links,
   `file_doc_open_sibling` with the directory restriction.
3. **Item 12, diff hunk widget.** Live and Reading rendering, Reviewed toggle, per-line
   comment affordance, export output.
4. **Item 13, discussion threads.** Thread model, `reply_comment`, pending comments with
   thread context, nested panel, unread badge.
5. **Item 14, folding and outline.** Section folding, outline panel with reviewed counts,
   status bar progress.

Roadmap item 9 (comments on tables and in Reading mode) stays separate and can slot in
anywhere after item 13.

## 6. Testing

- Node tests for the renderer: slug generation, sanitizer attribute rules, relative-link
  acceptance and rejection, widget DOM, export output, fold ranges, outline entries.
- Rust tests for the thread state machine (reply on both authors, resolve closes the thread,
  held and queued replies) and for `file_doc_open_sibling` (inside, outside, `..`, missing,
  non-text).
- MCP tests for `reply_comment` and the `thread` field of `get_pending_comments`.
- Checker fixtures: zero owner, two owners, stale hunk, extra hunk, dead link, wrong `lines`.
- Project rules apply: capped node test memory, `cargo fmt` before clippy, a Linux-simulated
  run for platform-dependent tests.
- Acceptance for the series: one real Sodilaud feature reviewed entirely in the book, ending
  in a sign-off.

## 7. Rejected alternatives

- **Generated static HTML book.** Simplest and needs no install, but no two-way discussion.
  Threads are the core of the pairing feel, and Sodilaud already has them.
- **Standalone local viewer, difit-style.** Best diff UX, but a second codebase duplicating
  Sodilaud's comment and MCP plumbing, and no dogfooding.
- **Extend difit.** Its description pane is static and it is an external tool.
- **Curated story without coverage.** Cannot claim every line was read.
- **Tool-computed symbol links.** A real subsystem, language-dependent. Agent-written links
  first; the anchor scheme stays compatible with a later index.
- **Agent marks hunks reviewed, or scroll-based "seen".** Sign-off must be the reviewer's
  explicit act per hunk.
- **Reviewed state in app data.** The document is the state store so re-generation, the
  agent's `read_document` and plain-text inspection all see the same thing.
