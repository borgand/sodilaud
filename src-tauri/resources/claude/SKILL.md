---
name: sodilaud
description: Use when presenting a Markdown or text document to the user in Sodilaud, dropping throw-away output into Quick Notes, starting a review of a document with questions, or co-editing a document the user has open in Sodilaud (the mcp__sodilaud__ tools). Never edit a co-edited file with Edit or Write.
---

# Working with the user in Sodilaud

Sodilaud is the user's Markdown editor. Its MCP server is named `sodilaud`; each function
needs its permission in Sodilaud's MCP Configuration (write functions start off).

## Which tool

| Goal | Tool |
|---|---|
| Show the user a file you wrote or changed | `open_document` with its absolute path |
| Hand over throw-away output (commands to run, a summary with no project to save into) | `push_quick_note` |
| Start a review of a document with your open questions | `add_comment` on each passage, then the `/sodilaud` loop |
| Work on a document together, comment by comment | the `/sodilaud` command (`/sodilaud <path>`) |
| See which documents are open and have waiting comments | `list_documents` |

## Co-editing rules

- `read_document` returns the live text (including what the user typed seconds ago) and a
  `version`. It makes the document co-edited.
- Change a co-edited document only with `apply_edit`: `oldText`/`newText` pairs written
  against that `version`. The user's typing wins: an edit whose text they changed comes back
  as a conflict with its `currentText`. Partial success is normal.
- Never use Edit, Write or MultiEdit on a co-edited file. A hook refuses them and points
  here.
- After addressing a comment, reread the whole document and fix every other place the change
  affects, then `resolve_comment` with a one-line note that names those places.
- Your own comments never come back from `get_pending_comments`; the user's answers do, with
  `replyTo` holding your question.
- Retries: reuse the same `requestId` with identical arguments.
