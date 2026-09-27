// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

test("Tab edits the primary editor and follows the normal input path", async () => {
  const { dom, type, editor } = await bootApp();
  const view = editor();
  await type("alphaomega");
  view.dispatch({ selection: { anchor: 5 } });

  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(view.state.doc.toString(), "alpha\tomega");
  assert.equal(view.state.selection.main.head, 6);
  assert.equal(document.getElementById("save-status").textContent, "Saving...");

  await type("- parent\n- child");
  view.dispatch({ selection: { anchor: 11 } });
  const listEvent = new dom.window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(listEvent);

  assert.equal(listEvent.defaultPrevented, true);
  assert.equal(view.state.doc.toString(), "- parent\n\t- child");
  assert.equal(view.state.selection.main.head, 12);
});
