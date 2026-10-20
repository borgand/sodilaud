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

const fenceOptions = state => ({ mermaid: state.facet(mermaidFacet) !== null });

export const fenceCaretFilter = EditorState.transactionFilter.of(tr => {
  if (!isLive(tr.startState)) return tr;
  const options = fenceOptions(tr.startState);

  if (tr.isUserEvent("delete") && tr.docChanged && tr.startState.selection.main.empty) {
    let touches = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      for (const pos of [fromA, toA]) {
        const fence = headedFenceAt(tr.startState, pos, options);
        if (!fence) continue;
        if (fromA < fence.first.from && toA > fence.open.from) touches = true;
        if (fence.close && fromA < fence.close.to && toA > fence.last.to) touches = true;
      }
    });
    if (touches) return [];
  }

  if (!tr.selection) return tr;
  const range = tr.selection.main;
  if (!range.empty) return tr;
  const fence = headedFenceAt(tr.state, range.head, options);
  if (!fence) return tr;
  const { doc } = tr.state;
  const line = doc.lineAt(range.head);
  let target = null;
  if (line.number === fence.open.number) {
    const backward = tr.startState.selection.main.head > range.head;
    target = backward && fence.open.number > 1 ? doc.line(fence.open.number - 1).to : fence.first.from;
  } else if (fence.close && line.number === fence.close.number) {
    const forward = tr.startState.selection.main.head < range.head;
    target = forward && fence.close.number < doc.lines ? doc.line(fence.close.number + 1).from : fence.last.to;
  }
  if (target === null) return tr;
  return [tr, { selection: EditorSelection.cursor(target), sequential: true }];
});
