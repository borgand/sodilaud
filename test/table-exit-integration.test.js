// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

function pressKey(dom, view, key) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

test("an empty generated table row can be exited with Enter or Backspace", async () => {
  const { dom, type, editor } = await bootApp();
  const view = editor();
  const text = () => view.state.doc.toString();
  const populated = "| A | B |\n| --- | --- |\n| 1 | 2 |";

  await type(populated);
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.equal(pressKey(dom, view, "Enter").defaultPrevented, true);
  assert.equal(text(), `${populated}\n|  |  |`);

  assert.equal(pressKey(dom, view, "Enter").defaultPrevented, true);
  assert.equal(text(), `${populated}\n\n`);
  assert.equal(view.state.selection.main.head, text().length - 1);

  await type(`${populated}\n|  |  |`);
  view.dispatch({ selection: { anchor: populated.length + 3 } });
  assert.equal(pressKey(dom, view, "Backspace").defaultPrevented, true);
  assert.equal(text(), `${populated}\n\n`);
  assert.equal(view.state.selection.main.head, text().length - 1);
});
