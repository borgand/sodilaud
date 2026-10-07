// SPDX-License-Identifier: GPL-3.0-or-later

// Review-book hunks in the editor's document: finding their fences and
// writing the reviewed mark. The document is the only store of that mark, so
// Reading mode, Live mode and the agent's read_document all see one value.

import { EditorSelection, ensureSyntaxTree, syntaxTree } from "./vendor/codemirror.js";
import { reviewHunkMeta, withReviewed } from "./diff-hunk.js";

const PARSE_TIMEOUT_MS = 200;

function fence(state, node) {
  const info = node.getChild("CodeInfo");
  if (!info) return null;
  const infoText = state.doc.sliceString(info.from, info.to);
  const meta = reviewHunkMeta(infoText);
  if (!meta) return null;
  const text = node.getChild("CodeText");
  return {
    from: node.from,
    to: node.to,
    infoFrom: info.from,
    infoTo: info.to,
    info: infoText,
    meta,
    bodyFrom: text?.from ?? null,
    body: text ? state.doc.sliceString(text.from, text.to) : ""
  };
}

/** The review hunk fence a FencedCode syntax node is, or null. */
export const reviewHunkFence = fence;

/** Every review hunk fence in document order. */
export function reviewHunkFences(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS) ?? syntaxTree(state);
  const fences = [];
  tree.iterate({
    enter: ref => {
      if (ref.name !== "FencedCode") return undefined;
      const found = fence(state, ref.node);
      if (found) fences.push(found);
      return false;
    }
  });
  return fences;
}

/** The review hunk fence that starts on the line at `pos`. */
export function hunkFenceAt(state, pos) {
  const line = state.doc.lineAt(pos);
  return reviewHunkFences(state).find(found => state.doc.lineAt(found.from).number === line.number) ?? null;
}

/**
 * Finds a hunk by id, or by its position among review hunks when it has no
 * valid id, and returns the change that sets its reviewed mark.
 */
export function reviewedChange(state, { hunk = null, index = -1 } = {}, reviewed) {
  const fences = reviewHunkFences(state);
  const target = hunk ? fences.find(found => found.meta.hunk === hunk) : fences[index];
  return target ? fenceReviewedChange(target, reviewed) : null;
}

function fenceReviewedChange(found, reviewed) {
  const info = withReviewed(found.info, reviewed);
  return info === found.info ? null : { from: found.infoFrom, to: found.infoTo, insert: info };
}

// The change sits inside the hunk's widget, so CodeMirror rebuilds it; for a
// moment the content is shorter and the browser clamps the scroll offset. The
// snapshot puts the reader back where they were once the widget is measured.
function dispatchChange(view, changes) {
  if (!changes) return false;
  view.dispatch({ changes, userEvent: "input", effects: view.scrollSnapshot() });
  return true;
}

export const setHunkReviewed = (view, target, reviewed) => dispatchChange(view, reviewedChange(view.state, target, reviewed));
export const setFenceReviewed = (view, found, reviewed) => dispatchChange(view, fenceReviewedChange(found, reviewed));

// Row `row` of a hunk's body as a document line, or null past its end.
function bodyLine(state, found, row) {
  if (found.bodyFrom === null || row < 0) return null;
  const number = state.doc.lineAt(found.bodyFrom).number + row;
  if (number > state.doc.lines) return null;
  const line = state.doc.line(number);
  return line.to <= found.bodyFrom + found.body.length ? line : null;
}

// The widget shows a code row without its +, - or space marker; "@@" headers
// and "\ No newline" notes are shown whole.
const markerWidth = text => (/^[ +-]/.test(text) ? 1 : 0);

/** A widget position {row, char} as a document offset. */
export function hunkPositionOffset(state, found, { row, char }) {
  const line = bodyLine(state, found, row);
  if (!line) return null;
  return Math.min(line.to, line.from + markerWidth(line.text) + Math.max(0, char));
}

/** A document offset inside the hunk's body as a widget position {row, char}. */
export function hunkOffsetPosition(state, found, pos) {
  const line = state.doc.lineAt(pos);
  const row = line.number - state.doc.lineAt(found.bodyFrom).number;
  return { row, char: Math.max(0, pos - line.from - markerWidth(line.text)) };
}

/** The document range of code selected in the widget, or null. */
export function hunkSpanRange(state, found, { start, end }) {
  const from = hunkPositionOffset(state, found, start);
  const to = hunkPositionOffset(state, found, end);
  return from !== null && to !== null && to > from ? { from, to } : null;
}

/**
 * The comment ranges that fall inside the hunk's body, as widget marks.
 * `ranges` are {from, to, id?, className}.
 */
export function hunkMarks(state, found, ranges) {
  if (found.bodyFrom === null) return [];
  const bodyTo = found.bodyFrom + found.body.length;
  return ranges.flatMap(range => {
    const from = Math.max(range.from, found.bodyFrom);
    const to = Math.min(range.to, bodyTo);
    if (from >= to) return [];
    return [{
      ...(range.id ? { id: range.id } : {}),
      className: range.className,
      start: hunkOffsetPosition(state, found, from),
      end: hunkOffsetPosition(state, found, to)
    }];
  });
}

/**
 * One line of a hunk's body without its +, - or space marker and leading
 * indent, so a comment anchors to the code the reviewer pointed at.
 */
export function hunkLineRange(state, found, index) {
  const line = bodyLine(state, found, index);
  if (!line) return null;
  const text = line.text;
  const skip = /^[ +-]?\s*/.exec(text)[0].length;
  const from = skip < text.length ? line.from + skip : line.from;
  return line.to === from ? null : { from, to: line.to };
}

/** Selects one line of a hunk's body, as hunkLineRange gives it. */
export function selectHunkLine(view, found, index) {
  const range = hunkLineRange(view.state, found, index);
  if (!range) return false;
  view.dispatch({ selection: EditorSelection.single(range.from, range.to), scrollIntoView: true });
  return true;
}
