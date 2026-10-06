---
description: Co-edit a document with the user in Sodilaud - pick up their comments, edit, resolve (waits for comments, stops when idle)
argument-hint: "[absolute path to a .md, .markdown or .txt file]"
---

You are co-editing a document with the user in Sodilaud. The user reads, types and comments
in the same document while you work. Keep idle waits cheap: no narration between polls.

Path given: $ARGUMENTS

## Start

1. If a path was given, call `mcp__sodilaud__open_document` with it, then
   `mcp__sodilaud__read_document` with the same `path`. Without a path, call
   `mcp__sodilaud__list_documents` and work on the documents it lists.
2. Kickstart: if you wrote this document, or the user asked you to review it, call
   `mcp__sodilaud__add_comment` on each open question or weak passage (exact `anchorText`
   from the text you read, a short question as `body`, a fresh `requestId`). Then enter the loop.
   The user's answers arrive in the loop with `replyTo` naming your comment.

## Loop

Keep an `empty` counter, starting at 0.

1. Call `mcp__sodilaud__get_pending_comments` with `waitSeconds: 1800` (and the `path` if one
   was given). It returns as soon as the user leaves a comment, or after 30 minutes with
   `timedOut: true`.
2. If `comments` is empty: reply with the single word `IDLE`, add 1 to `empty`. When `empty`
   reaches 3, stop and reply on one line: `No comments for about 90 minutes - stopping. Run
   /sodilaud to resume.` Otherwise go to step 1.
3. Otherwise set `empty` to 0 and handle each comment in order:
   1. Call `mcp__sodilaud__read_document` for the comment's `doc` to get the live text and its
      `version`. Find the anchored text with `headingPath`, `contextBefore` and `contextAfter`.
      A comment with `replyTo` is the user's answer to your question `replyTo.body`: act on
      the answer.
   2. Make the change with `mcp__sodilaud__apply_edit`: `baseVersion` is that `version`, each
      `oldText` is copied exactly from the text you just read, and a fresh `requestId`.
   3. Read the whole document again and fix every other place the change affects:
      terminology, cross-references, numbering, summaries, tables of contents. Use
      `apply_edit` for these too.
   4. If `apply_edit` reports conflicts, the user changed that text meanwhile and the user
      wins. Read again and retry once with fresh text; if it still conflicts, leave it and
      say so in the note. Each conflict has a `hint`; `ambiguous` gives the number of
      `matches`, and `not_found` gives the closest text as `currentText` when there is one.
   5. Call `mcp__sodilaud__resolve_comment` with the comment `id` and a one-line `note` that
      names what changed, including the other places you changed.
   Then go back to step 1.

## Rules

- Text the user changed since your last read is intentional. Keep their wording unless the
  comment asks you to change it. If consistency requires undoing one of their changes, do
  it only when the comment calls for it, and say so in the resolve note ("replaced your
  'ROBOT' with 'widget' in Design to match Goals").
- Use paths exactly as Sodilaud returns them (symbolic links resolved, for example `/tmp`
  becomes `/private/tmp` on macOS).
- Never use Edit, Write or MultiEdit on a co-edited file. Sodilaud owns its text; edits go
  through `apply_edit` only.
- `STALE_BASE` means your `baseVersion` is too old: read the document again.
- Keep output minimal: no preamble, one-line resolve notes.
