// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { setupLive, settle } from "./helpers/live-editor.js";

const T = "intro\n\n| a | **b** |\n|---|---|\n| 1 | [l](https://x.y) |\n\nafter";

const posOf = (t, needle) => t.view.state.doc.toString().indexOf(needle);
const rowLines = t => [...t.view.contentDOM.querySelectorAll(".cm-line.cm-lp-trow")];
const focusedCell = t => t.view.contentDOM.querySelector(".cm-lp-tcell-focus");
const head = t => t.view.state.selection.main.head;
const text = t => t.view.state.doc.toString();

function type(t, insert, userEvent = "input.type") {
  const at = head(t);
  t.view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent });
}

async function gridded(t) {
  const { gridTable } = await import("../src/editor-table-grid.js");
  return gridTable(t.view.state) !== null;
}

test("a caret in a cell keeps the table rendered as a grid", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-table"), "no widget");
    const rows = rowLines(t);
    assert.equal(rows.length, 3);
    assert.equal(rows.filter(row => row.classList.contains("cm-lp-trow-head")).length, 1);
    assert.equal(rows.filter(row => row.classList.contains("cm-lp-trow-sep")).length, 1);
    const body = rows.at(-1).textContent;
    assert.ok(!body.includes("|"), body);
    assert.ok(!body.includes("https"), body);
    assert.equal(rows[0].querySelectorAll(".cm-lp-tcell").length, 2);
    assert.equal(rows.at(-1).querySelectorAll(".cm-lp-tcell").length, 2);
    assert.equal(focusedCell(t).textContent.trim(), "1");
  } finally { t.done(); }
});

test("the focused cell shows its Markdown and the others stay rendered", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "**b**") + 3);
    assert.ok(focusedCell(t).textContent.includes("**b**"));
    await t.caret(posOf(t, "1 |") + 1);
    assert.ok(!rowLines(t)[0].textContent.includes("**"));
  } finally { t.done(); }
});

test("typing in a cell changes its source and keeps the caret there", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    type(t, "x");
    await settle();
    assert.ok(text(t).includes("| 1x |"));
    assert.ok(await gridded(t));
    assert.equal(head(t), posOf(t, "1x") + 2);
  } finally { t.done(); }
});

test("a typed pipe is stored escaped; pasted newlines become spaces", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    type(t, "|");
    assert.ok(text(t).includes("| 1\\| |"));
    type(t, "a\nb|c", "input.paste");
    assert.ok(text(t).includes("| 1\\|a b\\|c |"));
    assert.equal(head(t), posOf(t, "b\\|c") + 4);
  } finally { t.done(); }
});

test("an edit cannot reach past the cell's pipes", async () => {
  const t = await setupLive(T);
  try {
    const one = posOf(t, "1 |");
    await t.caret(one + 1);
    const segFrom = one - 1;
    t.view.dispatch({ changes: { from: segFrom - 1, to: segFrom }, userEvent: "delete.backward" });
    assert.equal(text(t), T);
    t.view.dispatch({ changes: { from: segFrom - 1, to: one + 1 }, userEvent: "delete.backward" });
    assert.equal(text(t), T.replace("| 1 |", "| |"));
  } finally { t.done(); }
});

test("composed text in a cell is inserted as typed", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    type(t, "é", "input.type.compose");
    assert.ok(text(t).includes("| 1é |"));
  } finally { t.done(); }
});

test("an agent edit in the same table keeps the caret in the cell and the typed text", async () => {
  const t = await setupLive(T);
  try {
    const { Transaction } = await import("../src/vendor/codemirror.js");
    await t.caret(posOf(t, "1 |") + 1);
    type(t, "x");
    t.view.dispatch({ changes: { from: posOf(t, "1x"), insert: "R" }, annotations: Transaction.remote.of(true) });
    t.view.dispatch({ changes: { from: posOf(t, "a |"), insert: "Z" }, annotations: Transaction.remote.of(true) });
    await settle();
    assert.ok(text(t).includes("R1x"));
    assert.ok(text(t).includes("Za"));
    assert.equal(head(t), posOf(t, "R1x") + 3);
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("undo removes a typing burst in one step", async () => {
  const t = await setupLive(T);
  try {
    const { undo } = await import("../src/vendor/codemirror.js");
    await t.caret(posOf(t, "1 |") + 1);
    type(t, "x");
    type(t, "y");
    type(t, "|");
    assert.ok(text(t).includes("1xy\\|"));
    undo(t.view);
    assert.equal(text(t), T);
  } finally { t.done(); }
});

test("a click on a rendered cell puts the caret in that cell", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(0);
    t.setFocus(true);
    const cell = [...t.view.contentDOM.querySelectorAll(".cm-lp-table td")].find(td => td.textContent === "1");
    assert.ok(cell);
    t.mousedown(cell);
    await settle();
    assert.equal(head(t), posOf(t, "1 |") + 1);
    assert.ok(await gridded(t));
    assert.ok(rowLines(t).length === 3);
  } finally { t.done(); }
});

test("a selection from outside into the table shows the pipes", async () => {
  const t = await setupLive(T);
  try {
    t.editor.setSelection(1, posOf(t, "1 |") + 1);
    await settle();
    assert.ok(t.lineTexts().some(line => line.includes("|---")));
    assert.equal(rowLines(t).length, 0);
  } finally { t.done(); }
});

test("blurring the editor shows the scrolling widget again", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    assert.equal(rowLines(t).length, 3);
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-table div.table-scroll"));
    assert.equal(rowLines(t).length, 0);
  } finally { t.done(); }
});

test("an empty cell takes the caret and typed text", async () => {
  const source = "x\n\n| a |  |\n|---|---|\n||  b |\n\ny";
  const t = await setupLive(source);
  try {
    await t.caret(posOf(t, "|  |") + 3);
    type(t, "z");
    await settle();
    assert.ok(text(t).includes("| a |  z|"));
    assert.equal(focusedCell(t).textContent.trim(), "z");
    const body = rowLines(t).at(-1);
    const cells = [...body.querySelectorAll(".cm-lp-tcell")];
    assert.equal(cells.length, 2);
    assert.equal(cells[0].tagName, "SPAN");
    assert.equal(cells[0].textContent, "");
  } finally { t.done(); }
});

test("Source mode shows plain pipes with the caret in a table", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    assert.equal(rowLines(t).length, 3);
    t.editor.setMode("source");
    await settle();
    assert.equal(rowLines(t).length, 0);
    assert.ok(t.lineTexts().includes("|---|---|"));
  } finally { t.done(); }
});

test("toggling the pencil with the caret in a cell switches between grid and pipes", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    t.view.contentDOM.querySelector(".cm-lp-trow-head .cm-lp-pencil").click();
    await settle();
    assert.equal(rowLines(t).length, 0);
    assert.ok(t.lineTexts().includes("|---|---|"));
    t.view.contentDOM.querySelector('.cm-lp-pencil[aria-pressed="true"]').click();
    await settle();
    assert.equal(rowLines(t).length, 3);
  } finally { t.done(); }
});

test("a grid row holds only its cells, even with a comment over part of a cell", async () => {
  const t = await setupLive(T, { comments: true });
  try {
    await t.caret(posOf(t, "1 |") + 1);
    const from = posOf(t, "**b**") + 2;
    t.view.dispatch({ effects: t.commentsApi.setComments.of([{ id: "c1", from, to: from + 1, author: "agent", state: "open", orphaned: false }]) });
    await settle();
    const [header, , body] = rowLines(t);
    for (const row of [header, body]) {
      const children = [...row.childNodes];
      assert.equal(children.length, 2);
      assert.ok(children.every(child => child.classList?.contains("cm-lp-tcell")));
    }
    assert.equal(header.querySelector(".cm-comment-agent")?.textContent, "b");
    assert.ok(header.querySelector(".cm-lp-tcell:last-child .cm-lp-pencil"), "the pencil sits in the last header cell");
  } finally { t.done(); }
});

const cellCount = async (t, needle) => {
  const { tableGrid } = await import("../src/table-cells.js");
  const { liveTableAt } = await import("../src/editor-live-blocks.js");
  const table = liveTableAt(t.view.state, posOf(t, needle));
  assert.ok(table, "still a table");
  const grid = tableGrid(t.view.state.doc.sliceString(table.from, table.to), table.from);
  const row = grid.rows.find(r => r.from <= posOf(t, needle) && posOf(t, needle) <= r.to);
  return row.cells.length;
};

test("a backslash typed before a pipe keeps the cell whole", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    type(t, "\\");
    type(t, "|");
    assert.ok(text(t).includes("| 1\\\\\\| |"), text(t));
    assert.equal(await cellCount(t, "1\\"), 2);
    assert.equal(head(t), posOf(t, "1\\") + 5);
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("a backslash at the end of an unpadded cell does not escape the closing pipe", async () => {
  const t = await setupLive("x\n\n|a|b|\n|-|-|\n|1|2|\n\ny");
  try {
    await t.caret(posOf(t, "a|") + 1);
    type(t, "\\");
    assert.ok(text(t).includes("|a\\ |b|"), text(t));
    assert.equal(await cellCount(t, "a\\"), 2);
    assert.equal(head(t), posOf(t, "a\\") + 2);
    assert.ok(await gridded(t));
    assert.equal(rowLines(t).length, 3);
  } finally { t.done(); }
});

test("Backspace or Delete on either half of an escaped pipe removes the pair", async () => {
  const source = "x\n\n| a | b |\n|---|---|\n| 1\\|2 | c |\n\ny";
  const t = await setupLive(source);
  try {
    const pipe = posOf(t, "\\|2") + 1;
    await t.caret(pipe);
    t.view.dispatch({ changes: { from: pipe - 1, to: pipe }, userEvent: "delete.backward" });
    assert.ok(text(t).includes("| 12 | c |"), text(t));
    assert.equal(await cellCount(t, "12"), 2);
    assert.equal(head(t), posOf(t, "12") + 1);
    assert.ok(await gridded(t));

    t.editor.loadText(source);
    await t.caret(pipe);
    t.view.dispatch({ changes: { from: pipe, to: pipe + 1 }, userEvent: "delete.forward" });
    assert.ok(text(t).includes("| 12 | c |"), text(t));
    assert.equal(head(t), posOf(t, "12") + 1);
  } finally { t.done(); }
});

test("a remote edit that leaves the caret on a pipe puts it back in a cell", async () => {
  const t = await setupLive(T);
  try {
    const { Transaction } = await import("../src/vendor/codemirror.js");
    const one = posOf(t, "1 |");
    await t.caret(one);
    t.view.dispatch({ changes: { from: one - 2, to: one + 1 }, annotations: Transaction.remote.of(true) });
    await settle();
    assert.ok(text(t).includes("\n | [l]"), text(t));
    assert.ok(await gridded(t));
    assert.equal(rowLines(t).length, 3);
  } finally { t.done(); }
});

test("emphasis in a rendered cell is bold or italic like the widget's", async () => {
  const t = await setupLive("x\n\n| **a** | *b* |\n|---|---|\n| 1 | 2 |\n\ny");
  try {
    await t.caret(posOf(t, "1 |"));
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-tcell .cm-lp-strong")?.textContent, "a");
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-tcell .cm-lp-em")?.textContent, "b");
  } finally { t.done(); }
});

test("grid cells keep the short values whole that the rendered table keeps whole", async () => {
  const t = await setupLive("x\n\n| Date | Notes |\n|---|---|\n| 2026-09-30 | a long description |\n\ny");
  try {
    await t.caret(posOf(t, "a long"));
    assert.deepEqual([...t.view.contentDOM.querySelectorAll(".cm-lp-ttoken")].map(span => span.textContent), ["2026-09-30"]);
  } finally { t.done(); }
});

test("typing words at the end of a cell keeps each space before the caret", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    for (const ch of "x y z") {
      type(t, ch);
      await settle();
      if (ch === " ") assert.ok(focusedCell(t).textContent.endsWith(" "), "the typed space shows");
    }
    assert.ok(text(t).includes("| 1x y z |"), text(t));
    assert.equal(head(t), posOf(t, "1x y z") + "1x y z".length);
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("typing words into an empty cell keeps each space before the caret", async () => {
  const t = await setupLive("intro\n\n| a | b |\n|---|---|\n|  | 2 |\n\nafter");
  try {
    await t.caret(posOf(t, "|  |") + 2);
    for (const ch of "p q") {
      type(t, ch);
      await settle();
    }
    const cell = text(t).split("\n")[4].split("|")[1];
    assert.equal(cell.trim(), "p q");
    assert.equal(head(t), posOf(t, "p q") + 3);
    assert.ok(await gridded(t));
  } finally { t.done(); }
});

test("deleting back to a space at the end of a cell keeps the caret after it", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "1 |") + 1);
    for (const ch of " y") type(t, ch);
    const at = head(t);
    t.view.dispatch({ changes: { from: at - 1, to: at }, selection: { anchor: at - 1 }, userEvent: "delete.backward" });
    type(t, "w");
    assert.ok(text(t).includes("| 1 w |"), text(t));
  } finally { t.done(); }
});
