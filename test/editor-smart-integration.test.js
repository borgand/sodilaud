// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

test("smart editing uses the normal editor input path", async () => {
  const { dom, type, editor } = await bootApp();
  const view = editor();
  await type("");
  view.dispatch({ selection: { anchor: 0 } });

  const pairEvent = new dom.window.KeyboardEvent("keydown", {
    key: "(",
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(pairEvent);

  assert.equal(pairEvent.defaultPrevented, true);
  assert.equal(view.state.doc.toString(), "()");
  assert.equal(view.state.selection.main.head, 1);
  assert.equal(document.getElementById("save-status").textContent, "Saving...");

  await type("OpenAI");
  view.dispatch({ selection: { anchor: 0, head: 6 } });
  const pasteEvent = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, "clipboardData", {
    value: { getData: () => "https://openai.com" }
  });
  view.contentDOM.dispatchEvent(pasteEvent);

  assert.equal(pasteEvent.defaultPrevented, true);
  assert.equal(view.state.doc.toString(), "[OpenAI](https://openai.com)");
});
