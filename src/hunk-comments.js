// SPDX-License-Identifier: GPL-3.0-or-later

// Selecting and commenting on code inside a review hunk widget. Rows are the
// fence body's lines in order (row 0 is the "@@" header); a position is a row
// and a character offset into that row's shown text, which is the line
// without its +, - or space marker. No CodeMirror import.

// An empty code cell holds a zero-width space so its row keeps its height.
const EMPTY = "​";
const ROW_CELL = ".diff-code, .diff-meta";

const rowsOf = root => [...root.querySelectorAll(".diff-hunk-body > tbody > tr.diff-row")];
const cellOf = tr => tr.querySelector(ROW_CELL);

function textNodes(cell) {
  const walker = cell.ownerDocument.createTreeWalker(cell, 4 /* NodeFilter.SHOW_TEXT */);
  const found = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node);
  return found;
}

const shown = text => text.replaceAll(EMPTY, "");

/** A row's text as the reader sees it. */
export function rowText(cell) {
  return shown(cell.textContent ?? "");
}

function charOffset(cell, node, offset) {
  const range = cell.ownerDocument.createRange();
  range.setStart(cell, 0);
  range.setEnd(node, offset);
  return shown(range.toString()).length;
}

/** The DOM point `char` characters into a cell's shown text. */
export function charPoint(cell, char) {
  let at = 0;
  for (const node of textNodes(cell)) {
    if (node.data === EMPTY) continue;
    if (char <= at + node.data.length) return { node, offset: char - at };
    at += node.data.length;
  }
  return { node: cell, offset: cell.childNodes.length };
}

/** A DOM point inside the widget as {row, char}; points outside a row's text clamp to its start. */
export function positionOf(root, node, offset) {
  const element = node.nodeType === 1 ? node : node.parentElement;
  const tr = element?.closest("tr.diff-row");
  if (!tr || !root.contains(tr)) return null;
  const row = Number(tr.dataset.index);
  const cell = cellOf(tr);
  if (!cell || !(cell === node || cell.contains(node))) return { row, char: 0 };
  return { row, char: charOffset(cell, node, offset) };
}

/** The selected code as {start, end} positions, or null when nothing in the widget is selected. */
export function selectedSpan(root, selection) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = positionOf(root, range.startContainer, range.startOffset);
  const end = positionOf(root, range.endContainer, range.endOffset);
  if (!start || !end || (start.row === end.row && start.char === end.char)) return null;
  return { start, end };
}

/** The selected code as plain text, one line per row, without markers or line numbers. */
export function spanText(root, { start, end }) {
  const rows = rowsOf(root);
  const lines = [];
  for (let row = start.row; row <= end.row; row++) {
    const text = rows[row] ? rowText(cellOf(rows[row])) : "";
    lines.push(text.slice(row === start.row ? start.char : 0, row === end.row ? end.char : undefined));
  }
  return lines.join("\n");
}

function wrapText(cell, from, to, mark) {
  let at = 0;
  for (const node of textNodes(cell)) {
    if (node.data === EMPTY) continue;
    const start = at;
    const end = at + node.data.length;
    at = end;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a >= b) continue;
    let target = node;
    if (b < end) target.splitText(b - start);
    if (a > start) target = target.splitText(a - start);
    const span = cell.ownerDocument.createElement("span");
    span.className = `diff-mark ${mark.className}`;
    if (mark.id) span.setAttribute("data-comment-id", mark.id);
    target.replaceWith(span);
    span.append(target);
  }
}

/**
 * Draws comment ranges on the code, replacing earlier marks. Each mark is
 * {id, className, start: {row, char}, end: {row, char}}.
 */
export function paintMarks(root, marks) {
  for (const old of root.querySelectorAll(".diff-mark")) old.replaceWith(...old.childNodes);
  const rows = rowsOf(root);
  rows.forEach(tr => cellOf(tr)?.normalize());
  for (const mark of marks) {
    for (let row = mark.start.row; row <= mark.end.row; row++) {
      const cell = rows[row] && cellOf(rows[row]);
      if (!cell) continue;
      wrapText(cell, row === mark.start.row ? mark.start.char : 0, row === mark.end.row ? mark.end.char : Infinity, mark);
    }
  }
}

/**
 * Shows a composer below `composer.row`, or removes it for null. `create`
 * builds the composer's element; an open one with the same key is kept.
 * Returns whether the widget's height changed.
 */
export function setHunkComposer(root, composer, create) {
  const existing = root.querySelector("tr.diff-composer-row");
  if (!composer) {
    existing?.remove();
    return Boolean(existing);
  }
  if (existing?.dataset.key === String(composer.key) && existing.dataset.row === String(composer.row)) return false;
  existing?.remove();
  const anchor = rowsOf(root)[composer.row];
  if (!anchor) return Boolean(existing);
  const document = root.ownerDocument;
  const tr = document.createElement("tr");
  tr.className = "diff-composer-row";
  tr.dataset.key = String(composer.key);
  tr.dataset.row = String(composer.row);
  const cell = document.createElement("td");
  cell.colSpan = 4;
  cell.append(create());
  tr.append(cell);
  anchor.after(tr);
  return true;
}

function caretAt(document, x, y) {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

// The point in the code nearest to the pointer, clamped to the widget's rows.
// `target`, the element under the pointer when known, decides the row.
function pointAt(root, x, y, target = null) {
  const rows = rowsOf(root);
  if (rows.length === 0) return null;
  const hit = target?.closest?.("tr.diff-row");
  let tr = hit && root.contains(hit) ? hit : rows.find(row => {
    const box = row.getBoundingClientRect();
    return y >= box.top && y < box.bottom;
  });
  let edge = null;
  if (!tr) {
    const above = y < rows[0].getBoundingClientRect().top;
    tr = above ? rows[0] : rows.at(-1);
    edge = above ? "start" : "end";
  }
  const cell = cellOf(tr);
  const box = cell.getBoundingClientRect();
  if (!edge && box.width && x <= box.left) edge = "start";
  if (!edge && box.width && x >= box.right) edge = "end";
  if (edge === "start") return { node: cell, offset: 0 };
  if (edge !== "end") {
    const caret = caretAt(root.ownerDocument, x, y);
    if (caret && cell.contains(caret.node)) return caret;
  }
  return { node: cell, offset: cell.childNodes.length };
}

// Double-click selects a word, triple-click the row's whole text.
function unitAround(root, point, clicks) {
  const position = positionOf(root, point.node, point.offset);
  const cell = cellOf(rowsOf(root)[position.row]);
  const text = rowText(cell);
  let from = 0;
  let to = text.length;
  if (clicks === 2) {
    const word = /[\p{L}\p{N}_$]/u;
    from = position.char;
    to = position.char;
    while (from > 0 && word.test(text[from - 1])) from -= 1;
    while (to < text.length && word.test(text[to])) to += 1;
    if (from === to) to = Math.min(text.length, to + 1);
  }
  return [charPoint(cell, from), charPoint(cell, to)];
}

/**
 * Lets the reader select code inside the widget without the editor taking
 * the click, and offers a Comment button for the selection.
 *
 * @param {HTMLElement} root the widget
 * @param {object} handlers
 * @param {() => void} [handlers.onStart] a selection begins (the editor should let go of focus)
 * @param {(span: {start: {row: number, char: number}, end: {row: number, char: number}}) => void} handlers.onComment
 * @param {(id: string) => void} [handlers.onMarkClick] a comment's highlighted code was clicked
 */
export function enableCodeSelection(root, { onStart = () => {}, onComment, onMarkClick = () => {} }) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const selection = () => window.getSelection();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "diff-hunk-comment-button";
  button.textContent = "Comment";
  button.title = "Comment on the selected code";
  button.hidden = true;
  root.append(button);

  const onCopy = event => {
    const span = selectedSpan(root, selection());
    if (!span || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", spanText(root, span));
    event.preventDefault();
  };
  const onSelectionChange = () => {
    if (!selectedSpan(root, selection())) hide();
  };
  function hide() {
    button.hidden = true;
    document.removeEventListener("copy", onCopy, true);
    document.removeEventListener("selectionchange", onSelectionChange);
  }
  function show() {
    const current = selection();
    const span = selectedSpan(root, current);
    if (!span) {
      hide();
      return;
    }
    const rects = current.getRangeAt(0).getClientRects();
    const last = rects.length ? rects[rects.length - 1] : current.getRangeAt(0).getBoundingClientRect();
    const box = root.getBoundingClientRect();
    button.hidden = false;
    const width = button.offsetWidth || 80;
    const height = button.offsetHeight || 24;
    let top = last.bottom - box.top + 4;
    if (top + height > root.clientHeight) top = Math.max(0, last.top - box.top - height - 4);
    button.style.top = `${top}px`;
    button.style.left = `${Math.max(0, Math.min(last.right - box.left, root.clientWidth - width - 4))}px`;
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("selectionchange", onSelectionChange);
  }

  button.addEventListener("mousedown", event => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const span = selectedSpan(root, selection());
    hide();
    selection().removeAllRanges();
    if (span) onComment(span);
  });

  root.addEventListener("mousedown", event => {
    const target = event.target;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || !target?.closest) return;
    if (target.closest("button, .diff-hunk-header, .diff-composer-row, .diff-ln")) return;
    const tr = target.closest("tr.diff-row");
    if (!tr || !root.contains(tr)) return;
    event.preventDefault();
    event.stopPropagation();
    hide();
    onStart();
    const start = pointAt(root, event.clientX, event.clientY, target);
    if (!start) return;
    const select = (anchor, head) => selection().setBaseAndExtent(anchor.node, anchor.offset, head.node, head.offset);
    if (event.detail >= 2) {
      const [from, to] = unitAround(root, start, Math.min(event.detail, 3));
      select(from, to);
      show();
      return;
    }
    select(start, start);
    const move = moved => {
      const head = pointAt(root, moved.clientX, moved.clientY, moved.target);
      if (head) select(start, head);
    };
    const up = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      if (selectedSpan(root, selection())) {
        show();
        return;
      }
      const mark = target.closest("[data-comment-id]");
      if (mark) onMarkClick(mark.getAttribute("data-comment-id"));
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  });
  return { hide, show };
}
