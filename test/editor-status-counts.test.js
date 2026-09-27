// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const app = await bootApp({
  storage: {
    sodilaud_notes: [{ id: "n", title: "N", content: "alpha", updatedAt: 1, isTitleLocked: true }]
  }
});
const { document } = app.dom.window;
const text = id => document.getElementById(id).textContent;

test("the cursor position follows every change while word counts trail typing", async () => {
  const view = app.editor();
  assert.equal(text("word-char-count"), "1 word • 5 characters");

  view.dispatch({ changes: { from: 5, insert: " beta\ngamma" }, selection: { anchor: 16 }, userEvent: "input.type" });
  assert.equal(text("cursor-position"), "Ln 2, Col 6", "the cursor position is immediate");
  assert.equal(text("word-char-count"), "1 word • 5 characters", "the word count waits for a pause");

  await app.settle(200);
  assert.equal(text("word-char-count"), "3 words • 16 characters");

  view.dispatch({ selection: { anchor: 10, head: 0 } });
  assert.equal(text("cursor-position"), "Ln 1, Col 1", "a backward selection reports its head");
  await app.settle(200);
  assert.equal(text("selection-count"), "2 words • 10 characters selected");
});
