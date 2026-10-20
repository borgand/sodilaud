// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootApp } from "./helpers/app-harness.js";

const T = "intro\n\n| a | **b** |\n|---|---|\n| 1 | [l](https://x.y) |\n\nafter";

test("Quick Notes edits a table cell in the rendered grid", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    registry: { seed: { notes: [{ id: "a", title: "Table", content: T, updatedAt: 1, isTitleLocked: false }], imported: true } },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const view = app.editor();
  await app.settle();
  view.focus();
  const at = view.state.doc.toString().indexOf("1 |") + 1;
  view.dispatch({ selection: { anchor: at } });
  await app.settle();
  view.dispatch({ changes: { from: at, insert: "x" }, selection: { anchor: at + 1 }, userEvent: "input.type" });
  await app.settle(600);
  assert.ok(view.contentDOM.querySelectorAll(".cm-line.cm-lp-trow").length > 0, "the table is a grid");
  const [note] = await app.savedNotes();
  assert.ok(note.content.includes("| 1x |"), note.content);
});
