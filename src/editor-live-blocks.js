// SPDX-License-Identifier: GPL-3.0-or-later

import { EditorSelection, EditorState, Facet, syntaxTree } from "./vendor/codemirror.js";
import { modeFacet, plainTextFacet } from "./editor-view.js";
import { reviewHunkMeta } from "./diff-hunk.js";

export const isLive = state => state.facet(modeFacet) === "live" && !state.facet(plainTextFacet);

export const mermaidFacet = Facet.define({ combine: values => values.find(Boolean) ?? null });

export function isMermaidFence(state, node) {
  const info = node.getChild("CodeInfo");
  return info !== null && state.doc.sliceString(info.from, info.to).trim().toLowerCase() === "mermaid";
}

export function fenceInfo(state, node) {
  const info = node.getChild("CodeInfo");
  return info ? state.doc.sliceString(info.from, info.to) : "";
}

export function fenceBody(state, node) {
  const text = node.getChild("CodeText");
  return text ? state.doc.sliceString(text.from, text.to) : "";
}

function fencedCodeAt(state, pos) {
  const tree = syntaxTree(state);
  for (const side of [1, -1]) {
    for (let node = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "FencedCode") return node;
    }
  }
  return null;
}

// The fenced block around `pos` whose header Live draws as a label. `mermaid`
// is true when a diagram renderer is configured, which takes mermaid fences.
export function headedFenceAt(state, pos, { mermaid = false } = {}) {
  const node = fencedCodeAt(state, pos);
  if (!node || pos < node.from || pos > node.to) return null;
  if (reviewHunkMeta(fenceInfo(state, node)) !== null) return null;
  if (mermaid && isMermaidFence(state, node)) return null;
  const marks = node.getChildren("CodeMark");
  if (!marks.length) return null;
  const { doc } = state;
  const open = doc.lineAt(node.from);
  const close = marks.length > 1 ? doc.lineAt(marks.at(-1).from) : null;
  if (close && close.number === open.number) return null;
  const lastNumber = close ? close.number - 1 : doc.lineAt(node.to).number;
  if (lastNumber <= open.number) return null;
  return {
    from: node.from,
    to: node.to,
    open,
    close,
    first: doc.line(open.number + 1),
    last: doc.line(lastNumber)
  };
}

export const fenceOptions = state => ({ mermaid: state.facet(mermaidFacet) !== null });

// Whether deleting fromA..toA would remove a hidden fence line's text, or join
// a fence line onto code text that stays on the neighbouring line.
function breaksFence(fence, fromA, toA) {
  const { open, first, last, close } = fence;
  if (fromA < open.to && toA > open.from) return true;
  if (fromA < first.from && toA > open.to && toA < first.to) return true;
  if (!close) return false;
  if (fromA < close.to && toA > close.from) return true;
  return fromA > last.from && fromA <= last.to && toA > last.to;
}

// Moves a head that rests on a hidden fence line past it, then past any fence
// that starts or ends right behind it.
function skipHiddenFences(state, pos, backward, options) {
  const { doc } = state;
  for (let guard = 0; guard <= doc.lines; guard++) {
    const fence = headedFenceAt(state, pos, options);
    if (!fence) return pos;
    const line = doc.lineAt(pos);
    let next = pos;
    if (line.number === fence.open.number) {
      next = backward && line.number > 1 ? doc.line(line.number - 1).to : fence.first.from;
    } else if (fence.close && line.number === fence.close.number) {
      next = !backward && line.number < doc.lines ? doc.line(line.number + 1).from : fence.last.to;
    }
    if (next === pos) return pos;
    pos = next;
  }
  return pos;
}

export const fenceCaretFilter = EditorState.transactionFilter.of(tr => {
  if (!isLive(tr.startState)) return tr;
  const options = fenceOptions(tr.startState);
  const start = tr.startState;

  if (tr.isUserEvent("delete") && tr.docChanged) {
    const heads = start.selection.ranges.filter(range => range.empty).map(range => range.head);
    let blocked = false;
    let move = null;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (!heads.some(head => head >= fromA && head <= toA)) return;
      const before = headedFenceAt(start, fromA, options);
      if (before?.close && fromA === before.close.to && toA === fromA + 1) move = before.last.to;
      const after = headedFenceAt(start, toA, options);
      if (after && toA === after.open.from && fromA === toA - 1) move = after.first.from;
      for (const pos of [fromA, toA]) {
        const fence = headedFenceAt(start, pos, options);
        if (fence && breaksFence(fence, fromA, toA)) blocked = true;
      }
    });
    if (move !== null) {
      return start.selection.ranges.length > 1 ? [] : [{ selection: EditorSelection.cursor(move), userEvent: "select" }];
    }
    if (blocked) return [];
  }

  if (!tr.selection) return tr;
  const range = tr.selection.main;
  if (!range.empty) return tr;
  const target = skipHiddenFences(tr.state, range.head, start.selection.main.head > range.head, options);
  if (target === range.head) return tr;
  return [tr, { selection: EditorSelection.cursor(target), sequential: true }];
});
