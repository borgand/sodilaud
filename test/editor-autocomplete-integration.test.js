// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

test("list autocomplete edits the editor and follows the normal input path", async () => {
  const { dom, type, editor } = await bootApp();
  const view = editor();
  await type("- first");
  view.dispatch({ selection: { anchor: view.state.doc.length } });

  const event = new dom.window.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(view.state.doc.toString(), "- first\n- ");
  assert.equal(view.state.selection.main.head, 10);
  assert.equal(document.getElementById("save-status").textContent, "Saving...");
});
