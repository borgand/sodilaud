---
name: review-book
description: Use when a feature you wrote is complete and tests pass, before opening the pull request, to present the change to the user as a review book in Sodilaud - chapters of narrative and diagrams followed by the diff hunks they own - and to discuss it with them until they sign off. Also use when the user asks to review a branch, a commit range or a pull request as a book, or to resume a review book.
---

# Review book

You present a finished change to the user as a book they read in Sodilaud: one chapter per
functionality, narrative and diagrams first, then the diff hunks that implement it. Every hunk
of the diff belongs to exactly one chapter, so reading the book means reading every line. The
user marks each hunk reviewed, asks about design choices in comment threads, and signs off.
You wrote the code, so you write the book.

The user acts as tech lead: they judge trust, intent and layout, not syntax. Write for that
reader. Explain why, show structure, and keep the hunks in the order that builds understanding.

## Tools

- `CHECK="node ~/.claude/skills/review-book/check-book.mjs"` (Node 18 or later). Run it from
  the repository root, or pass `--repo <dir>`.
  - `$CHECK hunks --base <ref> [--head <ref>]` prints every hunk of the diff as a ready-to-paste
    fenced block, grouped by file. Never compute hunk ids or line ranges by hand.
  - `$CHECK manifest <book> [--base <ref>] [--head <ref>]` writes `manifest.json` from the book.
  - `$CHECK check <book>` is the coverage checker. Exit 0 means the book is complete.
  - `$CHECK status <book>` prints reviewed over total per chapter and the open hunk ids.
  - `$CHECK signoff <book>` records the sign-off once everything is reviewed.
- Sodilaud MCP tools: `mcp__sodilaud__open_document`, `read_document`, `apply_edit`,
  `get_pending_comments`, `add_comment`, `resolve_comment`, and `reply_comment` when Sodilaud
  offers it.

Without `--head` the book covers the merge base to the working tree, untracked files
included. Use `--head <commit>` to review a committed range (a merged pull request, someone
else's branch); the manifest remembers it.

## Location

- Book folder: `<repo root>/.claude/review/<branch-slug>/`. The slug is the branch name in
  lower case with every character outside `a-z 0-9 . _ -` replaced by `-` (`feat/review-book`
  becomes `feat-review-book`). For a detached range, use the head commit's short hash.
- Keep it out of git: if `$(git rev-parse --git-common-dir)/info/exclude` lacks the line
  `/.claude/review/`, append it.
- The path stays the same across regenerations, so Sodilaud keeps the user's comments and
  reviewed marks. Leave the folder in place until the branch is deleted.

## Generate

When the feature is done and its tests pass:

1. Base: `git merge-base HEAD <main branch>` unless the user named one.
2. `$CHECK hunks --base <base> > "$TMPDIR/hunks.md"` and read it. It lists every changed file
   with its status and its hunks as blocks.
3. Plan the chapters: one per functionality, in the order a reader should meet them (usually
   data model, then core logic, then the edges: commands, UI, wiring). A file's hunks may be
   split across chapters. Every non-test hunk goes to a topic chapter, `99-everything-else.md`
   only takes what no story needs (lockfiles, generated and vendored files, renames,
   formatting-only hunks).
4. Write the files below with Write (the book is not open in Sodilaud yet). Paste each block
   from the catalogue unchanged. Never add `reviewed`; only Sodilaud writes it.
5. `$CHECK manifest <book> --base <base>`, then `$CHECK check <book>`. Fix every problem and
   repeat until it passes. Do not open the book before it passes.
6. `mcp__sodilaud__open_document` on `00-overview.md`, then on every chapter in reading order,
   so the sidebar lists the book in that order. Then enter the loop.

## Files

| File | Content |
|---|---|
| `00-overview.md` | Rationale, approach, architecture diagram, reading order, file map, tests. |
| `01-<topic>.md` ... `0n-<topic>.md` | One chapter per functionality, in reading order. |
| `90-tests.md` | Owns every test hunk. Which chapter each test file exercises. |
| `99-everything-else.md` | Owns every hunk no chapter claimed, grouped by file, one line each. |
| `manifest.json` | Written by `$CHECK manifest`. Do not edit by hand. |

### Overview, in this order

Each layer adds detail to the last; a reader who stops after the first still has the point.

1. **Rationale**, 1 to 3 sentences, no heading above it: the problem, why now, the outcome.
2. `## Approach`: the chosen design and its main trade-off. Name alternatives only if they
   were seriously considered.
3. `## Architecture`: one Mermaid flowchart of the parts touched and how they relate.
4. `## Reading order`: a numbered list linking every chapter, with one line on what it covers.
5. `## File map`: a table with one row per changed file: path, status (added, modified,
   deleted, renamed from), hunk count, owner chapters, referring chapters. Chapter names link
   to the chapter. Files changed without hunks (binary, pure rename, mode change) must appear
   here; the checker requires every such path to be mentioned.
6. `## Tests`: test files added or changed, each mapped to the chapter it covers, and line
   coverage per changed non-test file when the project has a coverage command. Never explain
   test bodies.
7. `## Risks and follow-ups`: what deserves extra attention, deferred work.

### Chapters

- `# <Functionality>` as the title, then 2 to 5 sentences on what this part does and why it is
  shaped this way.
- Then `##` sections in reading order. Each heading names a purpose, not a file. Under it:
  a short paragraph, an optional Mermaid sequence or flow diagram, then the hunks it owns.
- Link instead of repeating: to a hunk in another chapter, to a heading, back to the overview.
- `90-tests.md` and `99-everything-else.md` group by file with a `##` heading per file and one
  line of explanation per hunk or group.

### Hunk blocks

A hunk is a fenced `diff` block whose info string carries `path=`, `hunk=` and `lines=`:

````
```diff path=src-tauri/src/mcp.rs hunk=h3f2a1 lines=120-168
@@ -120,7 +120,30 @@ fn register_tools(
...
```
````

- The body is the hunk exactly as `git diff -U3` prints it, `@@` header included. Hunks show
  diffs, not the final code.
- The id is `h` plus five hex characters of SHA-256 over the path and the hunk lines after the
  header. Any change to a hunk changes its id, which resets its reviewed mark; a hunk that only
  moved keeps its id, and only its header and `lines` need updating.
- The fence can be longer than three backticks when the hunk itself contains backticks. Keep
  whatever the catalogue printed.
- `elided`: the catalogue prints hunks over 20 000 characters with the header only and an
  `elided` token. Keep elided blocks only for generated, vendored, minified or lockfile
  content, and say next to them how the content was produced (the command, the source
  version). Hand-written code is never elided: split the story instead.

### Links

- Headings get GitHub-style anchors: lower case, spaces to hyphens, punctuation removed,
  duplicates suffixed `-1`, `-2`. `## The merge engine` is `#the-merge-engine`.
- Within a file: `[the merge engine](#the-merge-engine)`. To a hunk anywhere:
  `[register_tools()](01-mcp-tools.md#h3f2a1)`; a hunk's anchor is its id.
- Only relative links to `.md` files in the book folder, no `..`, no leading `/`.

### Mermaid

- Quote every label that is not a single plain word: `A["Merge engine: user wins"]`.
- Line breaks inside a quoted label are `\n`, never HTML.
- Multi-word subgraph titles: `subgraph id ["Title with spaces"]`.
- Edge labels: `A -->|label| B`; when the label has `|`, `]` or quotes, `A -- "label" --> B`.

## Read and discuss

From here the book is co-edited: change its files only with `apply_edit` (never Edit or
Write), and read with `read_document` first.

Keep an `empty` counter, starting at 0.

1. Call `mcp__sodilaud__get_pending_comments` with `waitSeconds: 1800`.
2. No comments: reply `IDLE`, add 1 to `empty`. At 3, stop with one line: `No comments for
   about 90 minutes - stopping. Run the review-book skill again to resume.` Otherwise go to 1.
3. Comments: set `empty` to 0. For each one, read the document it is on, then decide by
   content which kind it is:
   - **A question** ("why", "what if", "is this safe"): answer with the reasoning in the
     thread. When the answer belongs in the book (a missing why, a diagram that would have
     helped), also add it to the chapter with `apply_edit`. Do not change code.
   - **A change request** ("do it", "change this to", "fix"): make the code change, run the
     relevant tests, `$CHECK hunks` again, replace only the changed blocks in their owning
     chapters with `apply_edit` (keep `reviewed` on blocks whose id did not change, and update
     the header and `lines` of blocks that only moved), rewrite the narrative the change
     touches, `$CHECK manifest <book>` and `$CHECK check <book>` until it passes, then answer
     in the thread with links to the new hunk ids.
   - **A decision with no action** ("fine", "leave it"): resolve the thread with a one-line
     note.
4. Answering: when `mcp__sodilaud__reply_comment` exists, use it with the comment id, which
   keeps the thread open for the user's next message. Without it, answer with
   `mcp__sodilaud__resolve_comment` and put the answer in the `note` (500 characters at most;
   point to a book section for anything longer). The user can comment again to continue.
5. Go to 1.

Discussion is the default; code changes only on request. Never mark a hunk reviewed and
never remove a `reviewed` token from a block whose hunk did not change. Progress is the
user's: `$CHECK status <book>` or `read_document` shows it.

## Sign-off

When the user writes "sign off" (or plainly asks to finish) in a comment on the overview:

1. `$CHECK signoff <book>`. It fails when the checker fails or a hunk is not reviewed, and
   prints what is missing.
2. Read every book document with `read_document` and list unresolved comment threads other
   than the sign-off one.
3. Anything missing: answer in the thread with the open hunk ids (as links) and the open
   threads, and stay in the loop.
4. Nothing missing: resolve the thread with `Signed off at <head>`, then open the pull
   request with the overview's rationale and approach as its description.

## Resume

Running the skill again on a branch that has a book: read `manifest.json` for the base (and
`ref`), run `$CHECK check <book>`, and fix only what it reports: regenerate changed hunks,
place new ones, drop stale ones, keep every reviewed mark and thread that still applies. Then
`$CHECK manifest <book>`, open the documents again in reading order, and enter the loop.

## Rules

- Write in the user's language. No preamble in comments, one idea per reply.
- Never put secrets, tokens or credentials in the book.
- Paths in Sodilaud tools are absolute and come back with symbolic links resolved (`/tmp` is
  `/private/tmp`); reuse them as returned.
- Retries of write tools reuse the same `requestId` with identical arguments.
