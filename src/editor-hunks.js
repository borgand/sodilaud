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

/**
 * Selects one line of a hunk's body, without its +, - or space marker and
 * leading indent, so a comment anchors to the code the reviewer pointed at.
 */
export function selectHunkLine(view, found, index) {
  if (found.bodyFrom === null) return false;
  const first = view.state.doc.lineAt(found.bodyFrom).number;
  const number = first + index;
  if (number > view.state.doc.lines) return false;
  const line = view.state.doc.line(number);
  if (line.to > found.to) return false;
  const text = line.text;
  const skip = /^[ +-]?\s*/.exec(text)[0].length;
  const from = skip < text.length ? line.from + skip : line.from;
  if (line.to === from) return false;
  view.dispatch({ selection: EditorSelection.single(from, line.to), scrollIntoView: true });
  return true;
}
