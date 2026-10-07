# Sodilaud v0.14.0

Review a finished change as a book: chapters that explain it, with the diff hunks inside, marked reviewed one by one and discussed with the agent in threads.

## Highlights

- **Review book skill.** **Agent Access** now also installs the `review-book` skill for Claude Code. When a change is done, the agent writes a folder of Markdown chapters under `.claude/review/<branch>/`: an overview with a diagram, one chapter per functionality, and every diff hunk placed in exactly one chapter. A bundled checker confirms that the book covers the whole diff.
- **Diff hunks in place.** A ` ```diff path=... ` block shows as a diff with old and new line numbers and syntax highlighting by file type. Its header stays in view while you scroll. **Reviewed** marks a hunk done, and a hunk can be collapsed. Select code inside a hunk to comment on it, and **Next unreviewed** jumps ahead.
- **Discussion threads.** Comments become threads. Reply to the agent and the agent replies back, with a **New** marker on unread agent replies. The MCP server has a new `reply_comment` tool.
- **Links between files.** Headings get anchors. `#heading` links scroll, and `chapter.md#heading` links open a file next to the current one. Point at a link to get an arrow that follows it, also inside tables. **Back** and **Forward** in the title bar (`Cmd/Ctrl + [` and `]`, or a mouse's side buttons) return along the links you followed.
- **Folding and outline.** Fold a section by its heading in Live and Reading mode. The outline panel lists the headings with reviewed-over-total counts, and the status bar shows how many hunks are reviewed.
- **Files open at the top** and keep their scroll position when you switch between them. Triple-click selects a line without its line break.

## Limits

- Links to other files, Back and Forward, the outline and the reviewed count work in files, not in Quick Notes.
- Commenting by clicking a hunk's line number works in Live mode only.
- The review book needs Claude Code with Sodilaud's MCP server connected.

## Compatibility

- **Indent and outdent move** to `Cmd/Ctrl + Alt + ]` and `[`. `Cmd/Ctrl + [` and `]` now go back and forward.
- Folds are kept for the session only and never change the file. The **Reviewed** toggle writes a `reviewed` word into the hunk's fence line.
- Notes, files, settings and workspaces carry over unchanged.
- Builds are not production-signed; macOS and Windows may display a security warning.
