// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const app = await bootApp({
  storage: {
    sodilaud_layout_mode: "split",
    sodilaud_notes: [
      { id: "one", title: "One", content: "", updatedAt: 2, isTitleLocked: true },
      { id: "two", title: "Two", content: "Second body", updatedAt: 1, isTitleLocked: true }
    ]
  }
});
const { document } = app.dom.window;

test("a legacy split layout boots as live and is rewritten in storage", () => {
  const container = document.getElementById("app");
  assert.equal(container.classList.contains("mode-live"), true);
  assert.equal(container.classList.contains("mode-split"), false);
  assert.equal(document.getElementById("mode-live").getAttribute("aria-pressed"), "true");
  assert.equal(app.storage.getItem("sodilaud_layout_mode"), "live");
});

test("switching notes inside the save debounce never writes the old text into the new note", async () => {
  const view = app.editor();
  assert.equal(document.querySelector(".note-item.active").dataset.id, "one");

  view.dispatch({ changes: { from: 0, insert: "A" }, userEvent: "input.type" });
  document.querySelector('.note-item[data-id="two"]').click();
  assert.equal(app.editorText(), "Second body");

  await app.settle(600);
  const saved = Object.fromEntries(app.read("sodilaud_notes").map(note => [note.id, note.content]));
  assert.equal(saved.one, "A");
  assert.equal(saved.two, "Second body");
  assert.equal(app.editorText(), "Second body");
});
