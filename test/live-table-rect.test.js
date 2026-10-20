// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { installEditorDom } from "./helpers/cm-dom.js";
import { setupLive, settle } from "./helpers/live-editor.js";

// CodeMirror reads the platform once, when its module first loads, so this
// file runs as macOS (Mod = Cmd).
{
  const env = installEditorDom();
  Object.defineProperty(env.window.navigator, "platform", { value: "MacIntel", configurable: true });
  await import("../src/vendor/codemirror.js");
  env.cleanup();
}

const T = "x\n\n| a | b | c |\n|---|---|---|\n| 1 | **2** | 3 |\n| 4 | 5 \\| 6 | 7 |\n\ny";

const grid = await import("../src/editor-table-grid.js");

const posOf = (t, needle) => t.view.state.doc.toString().indexOf(needle);
const endOf = (t, needle) => posOf(t, needle) + needle.length;
const head = t => t.view.state.selection.main.head;
const text = t => t.view.state.doc.toString();
const selectedCells = t => t.view.contentDOM.querySelectorAll(".cm-lp-tcell-selected").length;
const rectTexts = t => grid.cellRect(t.view.state)?.cells.map(row => row.map(cell => cell.text)) ?? null;

async function drag(t, fromNeedle, toNeedle) {
  t.view.dispatch({ selection: { anchor: posOf(t, fromNeedle), head: endOf(t, toNeedle) }, userEvent: "select.pointer" });
  await settle();
}

async function key(t, name, init = {}) {
  const event = new t.env.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  t.view.contentDOM.dispatchEvent(event);
  await settle();
  return event;
}

function clipboardEvent(t, type) {
  const event = new t.env.window.Event(type, { bubbles: true, cancelable: true });
  const clipboardData = {
    data: {},
    setData(kind, value) { this.data[kind] = value; },
    clearData() { this.data = {}; }
  };
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  t.view.contentDOM.dispatchEvent(event);
  return { event, clipboardData };
}

function type(t, insert) {
  const at = head(t);
  t.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.type" });
}

test("a drag from one cell into another selects the rectangle between them", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "b", "5");
    const rect = t.view.state.field(grid.cellRectField);
    assert.deepEqual(rect.anchor, { row: 0, col: 1 });
    assert.deepEqual(rect.head, { row: 2, col: 1 });
    assert.deepEqual(rectTexts(t), [["b"], ["**2**"], ["5 \\| 6"]]);
    const { main } = t.view.state.selection;
    assert.ok(main.empty);
    assert.equal(main.head, endOf(t, "5 \\| 6"));
    assert.equal(selectedCells(t), 3);
  } finally { t.done(); }
});

test("a drag within one cell selects text in that cell", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "a", "a");
    const { main } = t.view.state.selection;
    assert.equal(main.from, posOf(t, "a"));
    assert.equal(main.to, endOf(t, "a"));
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(selectedCells(t), 0);
  } finally { t.done(); }
});

test("Shift+ArrowRight past a cell edge starts a rectangle and Shift+arrows grow it", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(endOf(t, "| 1"));
    // CodeMirror's own Shift+ArrowRight: the first press only reaches the
    // hidden padding before the pipe, the second crosses it.
    await key(t, "ArrowRight", { shiftKey: true });
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(t.view.state.selection.main.head, endOf(t, "| 1") + 1);
    await key(t, "ArrowRight", { shiftKey: true });
    let rect = t.view.state.field(grid.cellRectField);
    assert.deepEqual(rect.anchor, { row: 1, col: 0 });
    assert.deepEqual(rect.head, { row: 1, col: 1 });
    const event = await key(t, "ArrowDown", { shiftKey: true });
    assert.ok(event.defaultPrevented);
    rect = t.view.state.field(grid.cellRectField);
    assert.deepEqual(rect.head, { row: 2, col: 1 });
    assert.equal(grid.cellRect(t.view.state).cells.flat().length, 4);
    assert.equal(selectedCells(t), 4);
    assert.equal(head(t), endOf(t, "5 \\| 6"));
  } finally { t.done(); }
});

test("Shift+arrows keep the rectangle's head inside the table", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "2", "7");
    await key(t, "ArrowRight", { shiftKey: true });
    await key(t, "ArrowDown", { shiftKey: true });
    assert.deepEqual(t.view.state.field(grid.cellRectField).head, { row: 2, col: 2 });
  } finally { t.done(); }
});

test("copy gives tab-separated cells with escaped pipes undone", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "a", "5");
    assert.equal(grid.rectText(t.view.state), "a\tb\n1\t**2**\n4\t5 | 6");
    const { event, clipboardData } = clipboardEvent(t, "copy");
    assert.equal(clipboardData.data["text/plain"], "a\tb\n1\t**2**\n4\t5 | 6");
    assert.ok(event.defaultPrevented);
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("clearing a rectangle is one undo step", async () => {
  const t = await setupLive(T);
  try {
    const { undo } = await import("../src/vendor/codemirror.js");
    await drag(t, "2", "7");
    await key(t, "Backspace");
    assert.deepEqual(rectTexts(t), [["", ""], ["", ""]]);
    assert.ok(text(t).includes("| 1 |  |  |"));
    assert.ok(text(t).includes("| 4 |  |  |"));
    assert.ok(grid.cellRect(t.view.state));
    undo(t.view);
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("typing does nothing while a rectangle is selected", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "2", "7");
    type(t, "z");
    assert.equal(text(t), T);
    assert.ok(grid.cellRect(t.view.state));
  } finally { t.done(); }
});

test("cut copies and clears", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "2", "7");
    const { event, clipboardData } = clipboardEvent(t, "cut");
    assert.ok(event.defaultPrevented);
    assert.equal(clipboardData.data["text/plain"], "**2**\t3\n5 | 6\t7");
    assert.ok(text(t).includes("| 1 |  |  |"));
    assert.ok(text(t).includes("| 4 |  |  |"));
  } finally { t.done(); }
});

test("Escape drops the rectangle and keeps the caret in the head cell", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "b", "5");
    const event = await key(t, "Escape");
    assert.ok(event.defaultPrevented);
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(head(t), endOf(t, "5 \\| 6"));
    assert.ok(grid.gridTable(t.view.state));
    assert.equal(selectedCells(t), 0);
  } finally { t.done(); }
});

test("a plain arrow drops the rectangle without moving the caret", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "b", "5");
    await key(t, "ArrowLeft");
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(head(t), endOf(t, "5 \\| 6"));
  } finally { t.done(); }
});

test("Tab with a rectangle drops it and moves on from the head cell", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "b", "5");
    await key(t, "Tab");
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(head(t), endOf(t, "| 7"));
  } finally { t.done(); }
});

test("a drag from outside into the table shows the pipes, with no rectangle", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "x", "5");
    assert.equal(grid.cellRect(t.view.state), null);
    assert.ok(t.lineTexts().some(line => line.includes("|---")));
  } finally { t.done(); }
});

test("a mousedown on the widget starts CodeMirror's selection at the clicked cell", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(0);
    const cell = [...t.view.contentDOM.querySelectorAll(".cm-lp-table td")].find(td => td.textContent === "3");
    assert.ok(cell);
    t.mousedown(cell);
    t.mouseup(cell);
    await settle();
    assert.equal(head(t), endOf(t, "3"));
    assert.ok(grid.gridTable(t.view.state));
  } finally { t.done(); }
});

test("a mousedown in the table's composer leaves the selection alone", async () => {
  const t = await setupLive(T, { comments: true });
  try {
    t.editor.setSelection(posOf(t, "2"), endOf(t, "2"));
    await settle();
    t.commentsApi.startComment(t.view);
    await settle();
    const input = t.view.contentDOM.querySelector(".cm-lp-table .cm-lp-table-composer textarea");
    assert.ok(input);
    // Checked during the press: later, jsdom's DOM selection can move the
    // caret on its own.
    const dispatched = [];
    const dispatch = t.view.dispatch.bind(t.view);
    t.view.dispatch = (...specs) => {
      dispatched.push(specs);
      return dispatch(...specs);
    };
    const event = t.mousedown(input);
    delete t.view.dispatch;
    assert.equal(dispatched.length, 0);
    assert.ok(!event.defaultPrevented);
  } finally { t.done(); }
});

test("the widget's selection style follows the pointer from cell to cell", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(0);
    const tds = [...t.view.contentDOM.querySelectorAll(".cm-lp-table td")];
    const start = tds.find(td => td.textContent === "1");
    const end = tds.find(td => td.textContent === "7");
    const down = new t.env.window.MouseEvent("mousedown", { bubbles: true, button: 0 });
    Object.defineProperty(down, "target", { value: start });
    const style = grid.tableMouseStyle(t.view, down);
    assert.ok(style);
    const move = new t.env.window.MouseEvent("mousemove", { bubbles: true, buttons: 1 });
    Object.defineProperty(move, "target", { value: end });
    const selection = style.get(move, false, false);
    assert.equal(selection.main.anchor, endOf(t, "| 1"));
    assert.equal(selection.main.head, endOf(t, "| 7"));
    const modified = new t.env.window.MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey: true });
    Object.defineProperty(modified, "target", { value: start });
    assert.equal(grid.tableMouseStyle(t.view, modified), null);
  } finally { t.done(); }
});

test("a remote change that deletes a selected row drops the rectangle", async () => {
  const t = await setupLive(T);
  try {
    const { Transaction } = await import("../src/vendor/codemirror.js");
    t.view.dispatch({ selection: { anchor: posOf(t, "5"), head: endOf(t, "3") }, userEvent: "select.pointer" });
    await settle();
    assert.ok(grid.cellRect(t.view.state));
    const from = posOf(t, "\n| 4");
    const to = endOf(t, "| 7 |");
    t.view.dispatch({ changes: { from, to }, annotations: Transaction.remote.of(true) });
    await settle();
    assert.equal(t.view.state.field(grid.cellRectField), null);
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(selectedCells(t), 0);
  } finally { t.done(); }
});

test("a remote edit elsewhere keeps the rectangle, mapped", async () => {
  const t = await setupLive(T);
  try {
    const { Transaction } = await import("../src/vendor/codemirror.js");
    await drag(t, "2", "7");
    const before = t.view.state.field(grid.cellRectField);
    t.view.dispatch({ changes: { from: 0, insert: "intro " }, annotations: Transaction.remote.of(true) });
    await settle();
    const rect = t.view.state.field(grid.cellRectField);
    assert.ok(rect);
    assert.equal(rect.table, before.table + "intro ".length);
    assert.equal(grid.rectText(t.view.state), "**2**\t3\n5 | 6\t7");
  } finally { t.done(); }
});

test("a search match across a pipe stays a normal selection", async () => {
  const t = await setupLive(T);
  try {
    const from = posOf(t, "1 | **2");
    t.view.dispatch({ selection: { anchor: from, head: from + "1 | **2".length }, userEvent: "select.search" });
    await settle();
    assert.equal(grid.cellRect(t.view.state), null);
    const { main } = t.view.state.selection;
    assert.equal(main.from, from);
    assert.equal(main.to, from + "1 | **2".length);
  } finally { t.done(); }
});

test("a cross-cell selection keeps the transaction's own effects", async () => {
  const t = await setupLive(T);
  try {
    const { StateEffect, StateField } = await import("../src/vendor/codemirror.js");
    const mark = StateEffect.define();
    const seen = StateField.define({
      create: () => false,
      update: (value, tr) => value || tr.effects.some(effect => effect.is(mark))
    });
    t.view.dispatch({ effects: StateEffect.appendConfig.of(seen) });
    t.view.dispatch({ selection: { anchor: posOf(t, "b"), head: endOf(t, "5") }, effects: mark.of(null), userEvent: "select.pointer" });
    await settle();
    assert.ok(grid.cellRect(t.view.state));
    assert.ok(t.view.state.field(seen));
  } finally { t.done(); }
});

test("a drag from a link in the rendered table selects a rectangle from the link's cell", async () => {
  const t = await setupLive("x\n\n| a | [l](https://x.y) |\n|---|---|\n| 1 | 2 |\n\ny");
  try {
    await t.caret(0);
    const link = t.view.contentDOM.querySelector(".cm-lp-table a[href]");
    assert.ok(link);
    const target = [...t.view.contentDOM.querySelectorAll(".cm-lp-table td")].find(td => td.textContent === "1");
    t.mousedown(link, { clientX: 10, clientY: 10 });
    t.mousemove(target, { clientX: 40, clientY: 40, buttons: 1 });
    await settle();
    const rect = t.view.state.field(grid.cellRectField);
    assert.ok(rect);
    assert.deepEqual(rect.anchor, { row: 0, col: 1 });
    assert.deepEqual(rect.head, { row: 1, col: 0 });
    t.mouseup(t.view.contentDOM, { clientX: 40, clientY: 40 });
    await settle();
    assert.deepEqual(t.opened, []);
  } finally { t.done(); }
});

test("Mod-a drops the rectangle", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "b", "5");
    await key(t, "a", { metaKey: true, keyCode: 65 });
    assert.equal(grid.cellRect(t.view.state), null);
    assert.equal(t.view.state.selection.main.to - t.view.state.selection.main.from, T.length);
  } finally { t.done(); }
});

// CodeMirror's own copy handler then copies the selected text.
test("copy without a rectangle leaves the event to CodeMirror", async () => {
  const t = await setupLive(T);
  try {
    await drag(t, "**2", "**2");
    const { clipboardData } = clipboardEvent(t, "copy");
    assert.deepEqual(clipboardData.data, { "text/plain": "**2" });
    assert.equal(text(t), T);
  } finally { t.done(); }
});
