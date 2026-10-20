// SPDX-License-Identifier: GPL-3.0-or-later

import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  WidgetType,
  keymap,
  syntaxTree
} from "./vendor/codemirror.js";
import { modeFacet, plainTextFacet } from "./editor-view.js";
import { reviewHunkMeta } from "./diff-hunk.js";
import { tableGrid } from "./table-cells.js";

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

export const TABLE_CONTAINERS = new Set(["Document", "BulletList", "OrderedList", "ListItem"]);

// A block shown as a widget fills its lines: nothing before it on its first
// line, nothing after it on its last.
export function fillsLines(doc, ref) {
  const start = doc.lineAt(ref.from);
  return /^\s*$/.test(doc.sliceString(start.from, ref.from)) && ref.to === doc.lineAt(ref.to).to;
}

// The table around `pos` that Live draws as a widget.
export function liveTableAt(state, pos) {
  let found = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: ref => {
      if (found) return false;
      if (TABLE_CONTAINERS.has(ref.name)) return true;
      if (ref.name === "Table" && ref.from <= pos && pos <= ref.to && fillsLines(state.doc, ref)) {
        found = { from: ref.from, to: ref.to };
      }
      return false;
    }
  });
  return found;
}

export const fenceOptions = state => ({ mermaid: state.facet(mermaidFacet) !== null });

// A fence whose hidden lines the caret and deletes must respect: not one the
// pencil has switched to its raw Markdown.
function guardedFenceAt(state, pos, options) {
  const fence = headedFenceAt(state, pos, options);
  return fence && !isRawBlock(state, fence.from) ? fence : null;
}

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
    const fence = guardedFenceAt(state, pos, options);
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
      const before = guardedFenceAt(start, fromA, options);
      if (before?.close && fromA === before.close.to && toA === fromA + 1) move = before.last.to;
      const after = guardedFenceAt(start, toA, options);
      if (after && toA === after.open.from && fromA === toA - 1) move = after.first.from;
      for (const pos of [fromA, toA]) {
        const fence = guardedFenceAt(start, pos, options);
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

export const toggleRawBlock = StateEffect.define();

// The block around `pos` that carries a pencil. `stillPencilBlock` below is the
// one place that says whether the pencil still applies to the block at `from`.
export function pencilBlockAt(state, pos) {
  const table = liveTableAt(state, pos);
  if (table) return { ...table, kind: "table" };
  const fence = headedFenceAt(state, pos, fenceOptions(state));
  return fence ? { from: fence.from, to: fence.to, kind: "fence" } : null;
}

const stillPencilBlock = (state, from) => pencilBlockAt(state, from)?.from === from;

// Starts of the blocks shown as raw Markdown, kept only while the caret is in them.
export const rawBlocksField = StateField.define({
  create: () => [],
  update(value, tr) {
    let list = value;
    for (const effect of tr.effects) {
      if (effect.is(toggleRawBlock)) {
        list = list.includes(effect.value) ? list.filter(from => from !== effect.value) : [...list, effect.value];
      }
    }
    if (!list.length) return list.length === value.length ? value : list;
    const { state } = tr;
    const head = state.selection.main.head;
    const kept = [];
    for (const pos of list) {
      const from = tr.changes.mapPos(pos, 1);
      if (kept.includes(from) || !stillPencilBlock(state, from)) continue;
      const block = pencilBlockAt(state, from);
      if (head >= block.from && head <= block.to) kept.push(from);
    }
    return kept.length === value.length && kept.every((from, i) => from === value[i]) ? value : kept;
  }
});

export const isRawBlock = (state, from) => state.field(rawBlocksField, false)?.includes(from) ?? false;

export function pressPencil(view, from) {
  const { state } = view;
  const block = pencilBlockAt(state, from);
  if (!block || block.from !== from) return;
  const on = !isRawBlock(state, from);
  const spec = { effects: toggleRawBlock.of(from) };
  const head = state.selection.main.head;
  if (on && (head < block.from || head > block.to)) {
    const entry = block.kind === "table"
      ? tableGrid(state.doc.sliceString(block.from, block.to), block.from).rows[0].cells[0].to
      : headedFenceAt(state, from, fenceOptions(state)).first.from;
    spec.selection = EditorSelection.cursor(entry);
    spec.userEvent = "select";
  } else if (!on) {
    // Setting the selection again lets the fence filter move a head off a line that hides again.
    spec.selection = state.selection;
    spec.userEvent = "select";
  }
  view.dispatch(spec);
  view.focus();
}

export function toggleRawCommand(view) {
  if (!isLive(view.state)) return false;
  const block = pencilBlockAt(view.state, view.state.selection.main.head);
  if (!block) return false;
  pressPencil(view, block.from);
  return true;
}

export const rawBlockKeymap = Prec.high(keymap.of([{ key: "Mod-Alt-e", run: toggleRawCommand, preventDefault: true }]));

const SVG_NS = "http://www.w3.org/2000/svg";

export function pencilButton(document, pressed, onPress) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-lp-pencil";
  const label = pressed ? "Show rendered" : "Edit Markdown";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(pressed));
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M11.5 2.5l2 2L5 13l-2.8.8L3 11z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  button.append(svg);
  button.addEventListener("mousedown", event => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", onPress);
  return button;
}

export class PencilWidget extends WidgetType {
  constructor(from, pressed) {
    super();
    this.from = from;
    this.pressed = pressed;
  }

  eq(other) {
    return other.from === this.from && other.pressed === this.pressed;
  }

  toDOM(view) {
    return pencilButton(view.dom.ownerDocument, this.pressed, () => pressPencil(view, this.from));
  }

  ignoreEvent() {
    return true;
  }
}
