// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Annotation,
  ChangeSet,
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  Prec,
  StateField,
  Transaction
} from "./vendor/codemirror.js";
import { PencilWidget, isLive, isRawBlock, liveFocusField, liveTableAt } from "./editor-live-blocks.js";
import { commentComposer, commentsDiffer } from "./editor-comments.js";
import { pointToSource } from "./source-map.js";
import { cellAt, escapeCellText, snapToCell, tableGrid } from "./table-cells.js";

// Marks a transaction whose changes the grid built itself, so the edit filter
// leaves them as they are.
export const gridEdit = Annotation.define();

const gridOf = (state, table) => tableGrid(state.doc.sliceString(table.from, table.to), table.from);

const withinCell = (cell, from, to) => from >= cell.segFrom && to <= cell.segTo;

/**
 * The table Live shows as an editable grid: the editor has focus and the
 * selection lies in one cell of a rendered table that no composer covers.
 */
export function gridTable(state) {
  if (!isLive(state) || !state.field(liveFocusField, false)) return null;
  const { main } = state.selection;
  const table = liveTableAt(state, main.head);
  if (!table || isRawBlock(state, table.from)) return null;
  if (state.selection.ranges.some(range => range.from < table.from || range.to > table.to)) return null;
  const composer = commentComposer(state);
  if (composer && !composer.outside && composer.from >= table.from && composer.to <= table.to) return null;
  const grid = gridOf(state, table);
  const cell = cellAt(grid, main.head);
  if (!cell || !withinCell(grid.rows[cell.row].cells[cell.col], main.from, main.to)) return null;
  return { from: table.from, to: table.to, grid, cell };
}

export const focusedCell = gridded => gridded.grid.rows[gridded.cell.row].cells[gridded.cell.col];

const hidden = Decoration.replace({});
const rowLine = Decoration.line({ class: "cm-lp-trow" });
const headLine = Decoration.line({ class: "cm-lp-trow cm-lp-trow-head" });
const separatorLine = Decoration.line({ class: "cm-lp-trow cm-lp-trow-sep" });
// Inclusive, so the hidden pipes at a cell's edges render inside it.
const cellMark = Decoration.mark({ class: "cm-lp-tcell", inclusive: true });
const focusedCellMark = Decoration.mark({ class: "cm-lp-tcell cm-lp-tcell-focus", inclusive: true });

/**
 * The decorations that draw the table at `gridded` (from gridTable) as a grid.
 * Each cell's mark also covers the hidden pipe and padding around its text
 * (the last one up to the line end), so even an empty cell has a mark and a
 * row holds nothing but cells: anything left between them would become an
 * extra table cell.
 */
export function gridDecorations(state, gridded) {
  const { doc } = state;
  const { rows, separator } = gridded.grid;
  const ranges = [];
  const hide = (from, to) => {
    if (to > from) ranges.push(hidden.range(from, to));
  };
  rows.forEach((row, index) => {
    const line = doc.lineAt(row.from);
    ranges.push((index === 0 ? headLine : rowLine).range(line.from));
    let start = line.from;
    row.cells.forEach((cell, col) => {
      const last = col === row.cells.length - 1;
      const end = last ? line.to : cell.segTo;
      const focused = index === gridded.cell?.row && col === gridded.cell?.col;
      ranges.push((focused ? focusedCellMark : cellMark).range(start, end));
      hide(start, cell.from);
      hide(cell.to, end);
      start = end;
    });
    if (index === 0) {
      ranges.push(Decoration.widget({ widget: new PencilWidget(gridded.from, false), side: -1 }).range(line.to));
    }
  });
  if (rows.length) {
    const line = doc.lineAt(separator.from);
    ranges.push(separatorLine.range(line.from));
    hide(line.from, line.to);
  }
  return ranges;
}

// The grid's cells draw around every other mark (comments, links, search
// matches), so those split inside a cell instead of splitting the cell.
const gridField = StateField.define({
  create: state => gridSet(state),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.length && !tr.reconfigured && !commentsDiffer(tr.startState, tr.state)) return value;
    return gridSet(tr.state);
  },
  provide: field => Prec.lowest(EditorView.decorations.from(field))
});

function gridSet(state) {
  const gridded = gridTable(state);
  return gridded ? Decoration.set(gridDecorations(state, gridded), true) : Decoration.none;
}

// The selection with its main cursor moved into the nearest cell's text, when
// it rests in a rendered table outside every cell; otherwise null.
function snappedSelection(state, selection) {
  const { main } = selection;
  if (!main.empty) return null;
  const table = liveTableAt(state, main.head);
  if (!table || isRawBlock(state, table.from)) return null;
  const snapped = snapToCell(gridOf(state, table), main.head);
  return snapped === main.head ? null : selection.replaceRange(EditorSelection.cursor(snapped), selection.mainIndex);
}

const cellSnapFilter = EditorState.transactionFilter.of(tr => {
  if (!tr.selection || !isLive(tr.startState)) return tr;
  const selection = snappedSelection(tr.state, tr.selection);
  return selection ? [tr, { selection, sequential: true }] : tr;
});

// Remote changes skip transaction filters, so a caret they leave on a pipe is
// moved into its cell right after, before the browser paints the raw row.
const remoteSnap = EditorView.updateListener.of(update => {
  if (!isLive(update.state) || !update.transactions.some(tr => tr.annotation(Transaction.remote))) return;
  if (!snappedSelection(update.state, update.state.selection)) return;
  const { view } = update;
  queueMicrotask(() => {
    const selection = isLive(view.state) ? snappedSelection(view.state, view.state.selection) : null;
    if (selection) view.dispatch({ selection });
  });
});

// Where each escaped pipe (`\|`) in the cell's source starts.
function escapedPipes(doc, cell) {
  const text = doc.sliceString(cell.segFrom, cell.segTo);
  const starts = [];
  let backslashes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      backslashes++;
      continue;
    }
    if (text[i] === "|" && backslashes % 2 === 1) starts.push(cell.segFrom + i - 1);
    backslashes = 0;
  }
  return starts;
}

// A deletion that takes one character of a `\|` pair takes both.
function widenOverPairs(starts, from, to) {
  for (const at of starts) {
    if (from < at + 2 && to > at) {
      from = Math.min(from, at);
      to = Math.max(to, at + 2);
    }
  }
  return [from, to];
}

// What keeps the cell at from..to one cell: a backslash before each pipe the
// edit left unescaped, and a space after a trailing odd run of backslashes
// that would otherwise escape the closing pipe.
function cellRepairs(doc, from, to) {
  const text = doc.sliceString(from, to);
  const repairs = [];
  let backslashes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      backslashes++;
      continue;
    }
    if (text[i] === "|" && backslashes % 2 === 0) repairs.push({ from: from + i, insert: "\\" });
    backslashes = 0;
  }
  if (backslashes % 2 === 1 && doc.sliceString(to, to + 1) === "|") repairs.push({ from: to, insert: " " });
  return repairs;
}

// Typing, pasting and deleting in a grid cell stay inside that cell, and the
// cell's source stays one cell: pipes are stored escaped, an escaped pipe is
// deleted whole, and a trailing backslash never escapes the closing pipe.
const gridEditFilter = EditorState.transactionFilter.of(tr => {
  if (!tr.docChanged || tr.annotation(Transaction.remote) || tr.annotation(gridEdit)) return tr;
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return tr;
  const gridded = gridTable(tr.startState);
  if (!gridded?.cell) return tr;
  const start = tr.startState;
  const cell = focusedCell(gridded);
  const compose = tr.isUserEvent("input.type.compose");
  const pairs = tr.isUserEvent("delete") ? escapedPipes(start.doc, cell) : [];
  const specs = [];
  let rewritten = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    if (toA < cell.segFrom || fromA > cell.segTo) {
      rewritten = true;
      return;
    }
    let from = Math.max(fromA, cell.segFrom);
    let to = Math.min(toA, cell.segTo);
    if (to > from) [from, to] = widenOverPairs(pairs, from, to);
    const insert = compose ? text : escapeCellText(text);
    if (from !== fromA || to !== toA || insert !== text) rewritten = true;
    if (to > from || insert) specs.push({ from, to, insert });
  });
  if (!specs.length) return [];
  const changes = start.changes(specs);
  const doc = changes.apply(start.doc);
  const repairs = compose ? [] : cellRepairs(doc, changes.mapPos(cell.segFrom, -1), changes.mapPos(cell.segTo, 1));
  if (!rewritten && !repairs.length) return tr;
  const repaired = ChangeSet.of(repairs, doc.length);
  const selection = EditorSelection.create(
    start.selection.ranges.map(range => range.map(changes, 1).map(repaired, -1)),
    start.selection.mainIndex
  );
  return {
    changes: changes.compose(repaired),
    selection,
    scrollIntoView: tr.scrollIntoView,
    annotations: Transaction.userEvent.of(tr.annotation(Transaction.userEvent))
  };
});

const gridKeys = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== "Enter" && event.key !== "Tab") return false;
    if (event.isComposing || view.composing || event.metaKey || event.ctrlKey || event.altKey) return false;
    if (!gridTable(view.state)) return false;
    event.preventDefault();
    return true;
  }
}));

export function gridExtension() {
  return [gridField, cellSnapFilter, gridEditFilter, gridKeys, remoteSnap];
}

function caretPoint(doc, x, y) {
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/**
 * The document position a click in a rendered table at `tableFrom` lands on:
 * the clicked character of the clicked cell, or the cell's end.
 */
export function tableClickPos(wrapper, source, tableFrom, event) {
  const target = event.target;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  const cell = element?.closest("th, td");
  if (!cell || !wrapper.contains(cell)) return tableFrom;
  const from = Number(cell.getAttribute("data-src-from"));
  const to = Number(cell.getAttribute("data-src-to"));
  if (!Number.isInteger(from) || !Number.isInteger(to)) return tableFrom;
  let pos = to;
  const point = caretPoint(wrapper.ownerDocument, event.clientX, event.clientY);
  if (point && cell.contains(point.node)) {
    const mapped = pointToSource(wrapper, point.node, point.offset, "start", source);
    if (mapped !== null) pos = Math.min(Math.max(mapped, from), to);
  }
  return tableFrom + pos;
}
