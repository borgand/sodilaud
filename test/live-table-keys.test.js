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

const T = "above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nbelow";
const AFTER_T = T.indexOf("| 3 | 4 |") + "| 3 | 4 |".length + 1;

const posOf = (t, needle) => t.view.state.doc.toString().indexOf(needle);
const endOf = (t, needle) => posOf(t, needle) + needle.length;
const head = t => t.view.state.selection.main.head;
const text = t => t.view.state.doc.toString();

async function key(t, name, init = {}) {
  const event = new t.env.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  t.view.contentDOM.dispatchEvent(event);
  await settle();
  return event;
}

const at = (t, needle) => t.caret(endOf(t, needle));

async function gridded(t) {
  const { gridTable } = await import("../src/editor-table-grid.js");
  return gridTable(t.view.state) !== null;
}

test("Tab and Shift+Tab move between cells and rows", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| b");
    await key(t, "Tab");
    assert.equal(head(t), endOf(t, "| 1"));
    await key(t, "Tab", { shiftKey: true });
    assert.equal(head(t), endOf(t, "| b"));
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("Shift+Tab in the first header cell keeps the caret and the key", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| a");
    const event = await key(t, "Tab", { shiftKey: true });
    assert.ok(event.defaultPrevented);
    assert.equal(head(t), endOf(t, "| a"));
  } finally { t.done(); }
});

test("Tab in the last cell adds a row that one undo removes", async () => {
  const t = await setupLive(T);
  try {
    const { undo } = await import("../src/vendor/codemirror.js");
    await at(t, "| 4");
    await key(t, "Tab");
    assert.equal(text(t), T.replace("| 3 | 4 |", "| 3 | 4 |\n|  |  |"));
    assert.equal(head(t), posOf(t, "|  |  |") + 3);
    assert.ok(await gridded(t));
    undo(t.view);
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("Enter goes down a column and adds a row from the last", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| 1");
    await key(t, "Enter");
    assert.equal(head(t), endOf(t, "| 3"));
    await at(t, "| 4");
    await key(t, "Enter");
    assert.equal(text(t), T.replace("| 3 | 4 |", "| 3 | 4 |\n|  |  |"));
    assert.equal(head(t), posOf(t, "|  |  |") + 6);
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("Enter in an empty last row deletes it and leaves the table", async () => {
  const t = await setupLive(T.replace("| 3 | 4 |", "| 3 | 4 |\n|  |  |"));
  try {
    await t.caret(posOf(t, "|  |  |") + 3);
    await key(t, "Enter");
    assert.equal(text(t), T);
    assert.equal(head(t), AFTER_T);
  } finally { t.done(); }
});

test("Enter in an empty last row that ends the document adds a line after the table", async () => {
  const source = "above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |";
  const t = await setupLive(source);
  try {
    await t.caret(posOf(t, "|  |  |") + 3);
    await key(t, "Enter");
    assert.equal(text(t), "above\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    assert.equal(head(t), text(t).length);
  } finally { t.done(); }
});

test("Backspace in an empty row deletes it", async () => {
  const t = await setupLive(T.replace("| 1 | 2 |", "| 1 | 2 |\n|  |  |"));
  try {
    await t.caret(posOf(t, "|  |  |") + 3);
    await key(t, "Backspace");
    assert.equal(text(t), T);
    assert.equal(head(t), endOf(t, "| 1"));
    await t.caret(posOf(t, "| 3") + 2);
    const event = await key(t, "Backspace");
    assert.ok(event.defaultPrevented);
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("Delete at the end of a cell changes nothing", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| 4");
    const event = await key(t, "Delete");
    assert.ok(event.defaultPrevented);
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("Up and Down move by row and leave the table at its edges", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| a");
    await key(t, "ArrowUp");
    assert.equal(head(t), "above\n".length);
    await at(t, "| 4");
    await key(t, "ArrowDown");
    assert.equal(head(t), AFTER_T);
  } finally { t.done(); }
});

test("Down from the header row goes to the first body row", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| b");
    await key(t, "ArrowDown");
    assert.equal(head(t), endOf(t, "| 2"));
    await key(t, "ArrowUp");
    assert.equal(head(t), endOf(t, "| b"));
  } finally { t.done(); }
});

test("Left and Right cross cells only at the edges", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "| 2") + 2);
    await key(t, "ArrowLeft");
    assert.equal(head(t), endOf(t, "| 1"));
    await key(t, "ArrowRight");
    assert.equal(head(t), posOf(t, "| 2") + 2);
  } finally { t.done(); }
  const long = await setupLive(T.replace("| 1 |", "| 123 |"));
  try {
    const { cellKeyCommand } = await import("../src/editor-table-grid.js");
    await long.caret(posOf(long, "123") + 1);
    assert.equal(cellKeyCommand(long.view.state, "ArrowLeft"), null);
    assert.equal(cellKeyCommand(long.view.state, "ArrowRight"), null);
  } finally { long.done(); }
});

test("Escape puts the caret after the table, adding a line at the end of the document", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| 2");
    await key(t, "Escape");
    assert.equal(text(t), T);
    assert.equal(head(t), AFTER_T);
  } finally { t.done(); }
  const source = "above\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  const end = await setupLive(source);
  try {
    await end.caret(endOf(end, "| 2"));
    await key(end, "Escape");
    assert.equal(text(end), source + "\n");
    assert.equal(head(end), source.length + 1);
  } finally { end.done(); }
});

test("ArrowDown from the line above enters the first row at the nearest column", async () => {
  const source = "above line\n| a | b |\n|---|---|\n| 1 | 2 |\n\nbelow";
  const t = await setupLive(source);
  try {
    const { EditorSelection } = await import("../src/vendor/codemirror.js");
    const { enterTableSpec } = await import("../src/editor-table-grid.js");
    await t.caret(6);
    const tableStart = posOf(t, "| a");
    const stub = { state: t.view.state, moveVertically: () => EditorSelection.cursor(tableStart) };
    const spec = enterTableSpec(stub, true);
    assert.equal(spec.selection.head, posOf(t, "b |"));

    t.view.moveVertically = () => EditorSelection.cursor(tableStart);
    const event = await key(t, "ArrowDown");
    assert.ok(event.defaultPrevented);
    assert.equal(head(t), posOf(t, "b |"));
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("keys during composition are left to the input method", async () => {
  const t = await setupLive(T);
  try {
    await at(t, "| 4");
    await key(t, "Enter", { isComposing: true });
    assert.equal(text(t), T);
    await key(t, "Enter", { keyCode: 229 });
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("keys with Cmd, Ctrl or Alt keep their usual meaning", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "| 2") + 2);
    await key(t, "ArrowLeft", { metaKey: true });
    assert.notEqual(head(t), endOf(t, "| 1"));
  } finally { t.done(); }
});

const WIDE = "above\n\n| ab | cd |\n|---|---|\n| ef gh | ij kl |\n\nbelow";

test("Home and End go to the focused cell's start and end", async () => {
  const t = await setupLive(WIDE);
  try {
    await t.caret(posOf(t, "ij kl") + 3);
    await key(t, "Home");
    assert.equal(head(t), posOf(t, "ij kl"));
    await key(t, "End");
    assert.equal(head(t), endOf(t, "ij kl"));
    await t.caret(posOf(t, "ef gh") + 3);
    await key(t, "End");
    assert.equal(head(t), endOf(t, "ef gh"));
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("Shift+Home and Shift+End select to the focused cell's start and end", async () => {
  const t = await setupLive(WIDE);
  try {
    const mid = posOf(t, "ij kl") + 3;
    await t.caret(mid);
    await key(t, "Home", { shiftKey: true });
    assert.deepEqual([t.view.state.selection.main.anchor, head(t)], [mid, posOf(t, "ij kl")]);
    assert.ok(await gridded(t));
    await t.caret(posOf(t, "ef gh") + 3);
    await key(t, "End", { shiftKey: true });
    assert.deepEqual([t.view.state.selection.main.anchor, head(t)], [posOf(t, "ef gh") + 3, endOf(t, "ef gh")]);
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("Cmd+Backspace deletes to the cell's start and no further", async () => {
  const t = await setupLive(WIDE);
  try {
    await t.caret(posOf(t, "ij kl") + 3);
    await key(t, "Backspace", { metaKey: true });
    assert.ok(text(t).includes("| ef gh | kl |"), text(t));
    assert.equal(head(t), posOf(t, "kl |"));
    await key(t, "Backspace", { metaKey: true });
    assert.ok(text(t).includes("| ef gh | kl |"), text(t));
    assert.ok(await gridded(t));
  } finally { t.done(); }
});
