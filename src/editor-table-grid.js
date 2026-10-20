// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Annotation,
  ChangeSet,
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  isolateHistory
} from "./vendor/codemirror.js";
import { PencilWidget, isLive, isRawBlock, liveFocusField, liveTableAt } from "./editor-live-blocks.js";
import { commentComposer, commentsDiffer } from "./editor-comments.js";
import { keepsWhole } from "./markdown.js";
import { pointToSource } from "./source-map.js";
import {
  cellAt,
  cellForColumn,
  escapeCellText,
  newRowText,
  rectCells,
  rowCells,
  snapToCell,
  tableGrid,
  unescapeCellText
} from "./table-cells.js";

// Marks a transaction whose changes the grid built itself, so the edit filter
// leaves them as they are.
export const gridEdit = Annotation.define();

const gridOf = (state, table) => tableGrid(state.doc.sliceString(table.from, table.to), table.from);

const withinCell = (cell, from, to) => from >= cell.segFrom && to <= cell.segTo;

const renderedTableAt = (state, pos) => {
  const table = liveTableAt(state, pos);
  return table && !isRawBlock(state, table.from) ? table : null;
};

/** Sets or clears the rectangle of grid cells: `{ table, anchor, head }` or null. */
export const setCellRect = StateEffect.define({
  map: (rect, mapping) => rect && { ...rect, table: mapping.mapPos(rect.table, 1) }
});

/**
 * The rectangle of selected cells, as the table's start and the anchor and
 * head cells (`{ row, col }`). Any other selection change drops it, and so
 * does the table going away.
 */
export const cellRectField = StateField.define({
  create: () => null,
  update(value, tr) {
    let rect = value && { ...value, table: tr.changes.mapPos(value.table, 1) };
    let set = false;
    for (const effect of tr.effects) {
      if (effect.is(setCellRect)) {
        rect = effect.value;
        set = true;
      }
    }
    if (!set && tr.selection) return null;
    if (rect && (!isLive(tr.state) || renderedTableAt(tr.state, rect.table)?.from !== rect.table)) return null;
    return rect;
  }
});

/**
 * The selected rectangle with its table's grid and cells (rows of cells), and
 * the source range from the top-left cell's start to the bottom-right cell's
 * end; null without one.
 */
export function cellRect(state) {
  const rect = state.field(cellRectField, false);
  if (!rect) return null;
  const table = renderedTableAt(state, rect.table);
  if (!table) return null;
  const grid = gridOf(state, table);
  const cells = rectCells(grid, rect.anchor, rect.head);
  return { table: table.from, grid, cells, from: cells[0][0].from, to: cells.at(-1).at(-1).to };
}

/** The rectangle's cells as text: tab-separated cells, one line per row. */
export function rectText(state) {
  const rect = cellRect(state);
  if (!rect) return "";
  return rect.cells.map(row => row.map(cell => unescapeCellText(cell.text)).join("\t")).join("\n");
}

/**
 * The table Live shows as an editable grid: the editor has focus and the
 * selection lies in one cell of a rendered table that no composer covers.
 * `rect` is the selected rectangle of cells (see cellRect), or null.
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
  return { from: table.from, to: table.to, grid, cell, rect: cellRect(state) };
}

export const focusedCell = gridded => gridded.grid.rows[gridded.cell.row].cells[gridded.cell.col];

const hidden = Decoration.replace({});
const rowLine = Decoration.line({ class: "cm-lp-trow" });
const headLine = Decoration.line({ class: "cm-lp-trow cm-lp-trow-head" });
const separatorLine = Decoration.line({ class: "cm-lp-trow cm-lp-trow-sep" });
// Inclusive, so the hidden pipes at a cell's edges render inside it.
const cellMark = Decoration.mark({ class: "cm-lp-tcell", inclusive: true });
const focusedCellMark = Decoration.mark({ class: "cm-lp-tcell cm-lp-tcell-focus", inclusive: true });
const selectedCellMark = Decoration.mark({ class: "cm-lp-tcell cm-lp-tcell-selected", inclusive: true });
const focusedSelectedCellMark = Decoration.mark({ class: "cm-lp-tcell cm-lp-tcell-focus cm-lp-tcell-selected", inclusive: true });
const wholeToken = Decoration.mark({ class: "cm-lp-ttoken" });

// The short values the rendered table keeps from breaking (see
// keepTableValuesWhole in markdown.js), so columns get the same widths.
function wholeTokens(cell, ranges) {
  let pos = cell.from;
  for (const part of cell.text.split(/(\s+)/)) {
    if (keepsWhole(part)) ranges.push(wholeToken.range(pos, pos + part.length));
    pos += part.length;
  }
}

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
  const selected = new Set(gridded.rect?.cells.flat().map(cell => cell.segFrom));
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
      const inRect = selected.has(cell.segFrom);
      const mark = focused ? (inRect ? focusedSelectedCellMark : focusedCellMark) : (inRect ? selectedCellMark : cellMark);
      ranges.push(mark.range(start, end));
      wholeTokens(cell, ranges);
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

// A user selection from one cell of a rendered table into another becomes a
// rectangle of cells, with the caret in the head cell.
const rectSelectionFilter = EditorState.transactionFilter.of(tr => {
  if (!tr.selection || tr.docChanged || !tr.isUserEvent("select") || !isLive(tr.state)) return tr;
  const { main } = tr.selection;
  if (main.empty) return tr;
  const table = renderedTableAt(tr.state, main.anchor);
  if (!table || renderedTableAt(tr.state, main.head)?.from !== table.from) return tr;
  const grid = gridOf(tr.state, table);
  const anchor = cellAt(grid, main.anchor);
  const head = cellAt(grid, main.head);
  if (!anchor || !head || (anchor.row === head.row && anchor.col === head.col)) return tr;
  return {
    selection: EditorSelection.cursor(grid.rows[head.row].cells[head.col].to),
    effects: setCellRect.of({ table: table.from, anchor, head }),
    userEvent: tr.annotation(Transaction.userEvent),
    scrollIntoView: tr.scrollIntoView
  };
});

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
  if (gridded.rect && tr.isUserEvent("input")) return [];
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

const cursor = pos => ({ selection: EditorSelection.cursor(pos) });

const columnIn = (row, col) => row.cells[Math.min(col, row.cells.length - 1)];

const gridChange = (changes, pos, userEvent) => ({
  changes,
  selection: EditorSelection.cursor(pos),
  annotations: [gridEdit.of(true), isolateHistory.of("full")],
  userEvent
});

// A new empty row after the last one, with the caret in its cell at `col`.
function addRow(state, gridded, col) {
  const { rows, columns } = gridded.grid;
  const last = rows[rows.length - 1];
  const text = newRowText(state.doc.lineAt(rows[0].from).text, columns);
  const row = { cells: rowCells(text, last.to + 1) };
  return gridChange({ from: last.to, insert: "\n" + text }, columnIn(row, col).to, "input");
}

// The caret at the start of the line after the table, adding that line when
// the table ends the document.
function leaveTable(state, tableTo) {
  const line = state.doc.lineAt(tableTo);
  if (line.number < state.doc.lines) return cursor(state.doc.line(line.number + 1).from);
  return gridChange({ from: tableTo, insert: "\n" }, tableTo + 1, "input");
}

const rowEmpty = row => row.cells.every(cell => cell.text === "");

const dropRect = { effects: setCellRect.of(null) };

const STEP = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

const clamp = (value, max) => Math.min(Math.max(value, 0), max);

function moveRectHead(grid, rect, key) {
  const [rowStep, colStep] = STEP[key];
  const row = clamp(rect.head.row + rowStep, grid.rows.length - 1);
  const col = clamp(rect.head.col + colStep, grid.rows[row].cells.length - 1);
  return { ...cursor(grid.rows[row].cells[col].to), effects: setCellRect.of({ ...rect, head: { row, col } }) };
}

// Empties every cell of the rectangle in one undo step and keeps it selected.
function clearRect(state, userEvent) {
  if (state.readOnly) return {};
  const value = state.field(cellRectField);
  const { grid, cells } = cellRect(state);
  const changes = state.changes(cells.flat().filter(cell => cell.to > cell.from).map(({ from, to }) => ({ from, to })));
  const head = columnIn(grid.rows[value.head.row], value.head.col);
  return { ...gridChange(changes, changes.mapPos(head.to), userEvent), effects: setCellRect.of(value) };
}

// With a rectangle, Shift+arrows move its head cell, plain arrows and Escape
// drop it, deleting empties its cells, and Tab and Enter drop it and act from
// the head cell.
function rectKeyCommand(state, gridded, key, shift) {
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
      return shift ? moveRectHead(gridded.grid, state.field(cellRectField), key) : dropRect;
    case "Escape":
      return dropRect;
    case "Backspace":
    case "Delete":
      return clearRect(state, "delete");
    default: {
      const spec = cellCommand(state, gridded, key, shift);
      return spec && { ...spec, effects: setCellRect.of(null) };
    }
  }
}

/**
 * What `key` does with the caret in a grid cell, as a transaction spec, or
 * null when the editor is not in grid mode or the key keeps its default.
 */
export function cellKeyCommand(state, key, { shift = false } = {}) {
  const gridded = gridTable(state);
  if (!gridded) return null;
  return gridded.rect ? rectKeyCommand(state, gridded, key, shift) : cellCommand(state, gridded, key, shift);
}

function cellCommand(state, gridded, key, shift) {
  const { rows } = gridded.grid;
  const { row, col } = gridded.cell;
  const cells = rows[row].cells;
  const cell = cells[col];
  const lastRow = row === rows.length - 1;
  const { main } = state.selection;
  const { doc } = state;
  switch (key) {
    case "Tab":
      if (shift) {
        if (col > 0) return cursor(cells[col - 1].to);
        return row > 0 ? cursor(rows[row - 1].cells.at(-1).to) : {};
      }
      if (col < cells.length - 1) return cursor(cells[col + 1].to);
      return lastRow ? addRow(state, gridded, 0) : cursor(rows[row + 1].cells[0].to);
    case "Enter": {
      if (!lastRow) return cursor(columnIn(rows[row + 1], col).to);
      if (row === 0 || !rowEmpty(rows[row])) return addRow(state, gridded, col);
      const line = doc.lineAt(rows[row].from);
      const insert = line.to === doc.length ? "\n" : "";
      return gridChange({ from: line.from - 1, to: line.to, insert }, line.from, "delete");
    }
    case "ArrowUp":
    case "ArrowDown": {
      if (shift) return null;
      if (key === "ArrowUp") {
        if (row > 0) return cursor(columnIn(rows[row - 1], col).to);
        const line = doc.lineAt(gridded.from);
        return line.number > 1 ? cursor(doc.line(line.number - 1).to) : null;
      }
      if (!lastRow) return cursor(columnIn(rows[row + 1], col).to);
      const line = doc.lineAt(gridded.to);
      return line.number < doc.lines ? cursor(doc.line(line.number + 1).from) : null;
    }
    case "ArrowLeft":
      if (shift || main.head > cell.from) return null;
      if (col > 0) return cursor(cells[col - 1].to);
      return row > 0 ? cursor(rows[row - 1].cells.at(-1).to) : null;
    case "ArrowRight":
      if (shift || main.head < cell.to) return null;
      if (col < cells.length - 1) return cursor(cells[col + 1].from);
      return lastRow ? null : cursor(rows[row + 1].cells[0].from);
    case "Escape":
      return leaveTable(state, gridded.to);
    case "Backspace": {
      if (!main.empty || main.head !== cell.from) return null;
      if (row === 0 || !rowEmpty(rows[row])) return {};
      const line = doc.lineAt(rows[row].from);
      return gridChange({ from: line.from - 1, to: line.to }, columnIn(rows[row - 1], col).to, "delete");
    }
    case "Delete":
      return main.empty && main.head === cell.to ? {} : null;
    default:
      return null;
  }
}

// The table a vertical move from `from` to `to` enters: one containing `to`,
// or one lying wholly between the two.
function tableEntered(state, from, to, forward) {
  const { doc } = state;
  const contains = table => table && !isRawBlock(state, table.from) && (forward ? table.from > from : table.to < from);
  const target = liveTableAt(state, to);
  if (contains(target)) return target;
  const a = doc.lineAt(from).number;
  const b = doc.lineAt(to).number;
  for (let n = Math.min(a, b) + 1; n < Math.max(a, b); n++) {
    const table = liveTableAt(state, doc.line(n).from);
    if (contains(table)) return table;
  }
  return null;
}

/**
 * Where ArrowDown (`forward`) or ArrowUp from outside every grid table puts
 * the caret when the move enters a rendered table: its first or last row, in
 * the cell under the caret's column. Null when the move enters no table.
 */
export function enterTableSpec(view, forward) {
  const { state } = view;
  if (!isLive(state) || gridTable(state)) return null;
  const { main } = state.selection;
  const next = view.moveVertically(main, forward);
  const table = tableEntered(state, main.head, next.head, forward);
  if (!table) return null;
  const { rows } = gridOf(state, table);
  const row = forward ? rows[0] : rows[rows.length - 1];
  const column = main.head - state.doc.lineAt(main.head).from;
  const cell = cellForColumn(row, column);
  return cursor(Math.min(Math.max(row.from + column, cell.from), cell.to));
}

const CELL_KEYS = new Set(["Tab", "Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape", "Backspace", "Delete"]);

const gridKeys = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    if (!CELL_KEYS.has(event.key)) return false;
    if (event.isComposing || view.composing || event.keyCode === 229) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const shift = event.shiftKey;
    let spec = cellKeyCommand(view.state, event.key, { shift });
    if (!spec && !shift && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      spec = enterTableSpec(view, event.key === "ArrowDown");
    }
    if (!spec) return false;
    event.preventDefault();
    view.dispatch({ ...spec, scrollIntoView: true });
    return true;
  },
  copy: (event, view) => copyRect(event, view, false),
  cut: (event, view) => copyRect(event, view, true)
}));

function copyRect(event, view, cut) {
  if (!cellRect(view.state) || !event.clipboardData) return false;
  event.clipboardData.setData("text/plain", rectText(view.state));
  event.preventDefault();
  if (cut) view.dispatch(clearRect(view.state, "delete.cut"));
  return true;
}

function tableWidgetAt(view, event) {
  const target = event.target;
  const element = target?.nodeType === 1 ? target : target?.parentElement;
  const wrapper = element?.closest(".cm-lp-table");
  if (!wrapper || !view.contentDOM.contains(wrapper)) return null;
  return element.closest(".cm-lp-table-composer, .cm-lp-pencil") ? null : wrapper;
}

const widgetClickPos = (view, wrapper, event) => tableClickPos(wrapper, wrapper.tableSource, view.posAtDOM(wrapper), event);

/**
 * CodeMirror's selection style for a plain press on a rendered table: it
 * starts at the pressed cell and follows the pointer, through the widget and,
 * once the grid replaces it, through the document.
 */
export function tableMouseStyle(view, event) {
  if (!isLive(view.state) || event.button !== 0) return null;
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
  const wrapper = tableWidgetAt(view, event);
  if (!wrapper) return null;
  let anchor = widgetClickPos(view, wrapper, event);
  return {
    get(cur) {
      const over = tableWidgetAt(view, cur);
      const head = over ? widgetClickPos(view, over, cur) : view.posAtCoords({ x: cur.clientX, y: cur.clientY }) ?? anchor;
      return EditorSelection.single(anchor, head);
    },
    update(update) {
      anchor = update.changes.mapPos(anchor);
      return false;
    }
  };
}

export function gridExtension() {
  return [
    cellRectField,
    gridField,
    rectSelectionFilter,
    cellSnapFilter,
    gridEditFilter,
    gridKeys,
    remoteSnap,
    EditorView.mouseSelectionStyle.of(tableMouseStyle)
  ];
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
