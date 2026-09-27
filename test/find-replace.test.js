// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { undo } from "../src/vendor/codemirror.js";
import { bootApp } from "./helpers/app-harness.js";

const ORIGINAL_CONTENT = "İstanbul trip. Book a hotel, then book a flight.";

test("Replace and Replace All preserve offsets and undo in one step", async () => {
  const app = await bootApp({
    storage: {
      sodilaud_notes: [{
        id: "note-one",
        title: "Travel",
        content: ORIGINAL_CONTENT,
        updatedAt: 1,
        isTitleLocked: true
      }]
    },
    handlers: { load_workspace_preference: () => null }
  });
  const { document, Event, KeyboardEvent } = app.dom.window;
  const selectedText = () => {
    const { from, to } = app.editor().state.selection.main;
    return app.editorText().slice(from, to);
  };

  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true
  }));
  document.getElementById("find-toggle-replace").click();

  const findInput = document.getElementById("find-input");
  const replaceInput = document.getElementById("replace-input");
  findInput.value = "book";
  findInput.dispatchEvent(new Event("input", { bubbles: true }));
  replaceInput.value = "reserve";
  replaceInput.focus();

  document.getElementById("replace-one-btn").click();

  assert.ok(document.activeElement === replaceInput, "focus is on replaceInput");
  assert.equal(app.editorText(), "İstanbul trip. reserve a hotel, then book a flight.");
  assert.equal(app.editor().state.selection.main.from, 37);
  assert.equal(selectedText(), "book");
  assert.equal(document.getElementById("find-count").textContent, "1 of 1");

  assert.equal(undo(app.editor()), true);
  assert.equal(app.editorText(), ORIGINAL_CONTENT);
  assert.equal(document.getElementById("find-count").textContent, "1 of 2");

  const replaceAllButton = document.getElementById("replace-all-btn");
  replaceAllButton.focus();
  replaceAllButton.click();

  assert.ok(document.activeElement === replaceAllButton, "focus is on replaceAllButton");
  assert.equal(app.editorText(), "İstanbul trip. reserve a hotel, then reserve a flight.");
  assert.equal(app.editor().state.selection.main.head, app.editorText().length);
  assert.equal(document.getElementById("find-count").textContent, "0 of 0");

  await app.settle(600);
  assert.equal(
    app.read("sodilaud_notes")[0].content,
    "İstanbul trip. reserve a hotel, then reserve a flight."
  );

  assert.equal(undo(app.editor()), true);
  assert.equal(app.editorText(), ORIGINAL_CONTENT);
  assert.equal(document.getElementById("find-count").textContent, "1 of 2");
});
