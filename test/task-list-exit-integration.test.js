// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

function pressEnter(dom, view) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function typeOverSelection(view, text) {
  view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.type" });
}

test("an inserted task list continues once and exits from its empty task", async () => {
  const { dom, editor: editorView } = await bootApp({
    storage: {
      sodilaud_notes: [{
        id: "task-note",
        title: "Tasks",
        content: "",
        updatedAt: 1,
        isTitleLocked: true
      }]
    }
  });
  const view = editorView();
  const text = () => view.state.doc.toString();
  const selected = () => text().slice(view.state.selection.main.from, view.state.selection.main.to);

  view.contentDOM.dispatchEvent(new dom.window.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true
  }));
  document.getElementById("ctx-insert").click();
  document.querySelector('[data-markdown-template="task-list"]').click();

  assert.equal(text(), "- [ ] Task");
  assert.equal(selected(), "Task");

  typeOverSelection(view, "Buy milk");
  assert.equal(pressEnter(dom, view).defaultPrevented, true);
  assert.equal(text(), "- [ ] Buy milk\n- [ ] ");

  assert.equal(pressEnter(dom, view).defaultPrevented, true);
  assert.equal(text(), "- [ ] Buy milk\n\n");
  assert.equal(view.state.selection.main.head, text().length - 1);

  typeOverSelection(view, "Notes");
  assert.equal(text(), "- [ ] Buy milk\nNotes\n");
});
