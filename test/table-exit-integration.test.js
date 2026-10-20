// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";
import { isRawBlock, pressPencil } from "../src/editor-live-blocks.js";

function pressKey(dom, view, key) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

// In Live a table with the caret in it is a grid; its rows are edited as pipes
// once the pencil shows the Markdown.
test("an empty generated table row in a raw table can be exited with Enter or Backspace", async () => {
  const { dom, type, editor } = await bootApp();
  const view = editor();
  const text = () => view.state.doc.toString();
  const populated = "| A | B |\n| --- | --- |\n| 1 | 2 |";

  await type(populated);
  pressPencil(view, 0);
  assert.ok(isRawBlock(view.state, 0));
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  assert.equal(pressKey(dom, view, "Enter").defaultPrevented, true);
  assert.equal(text(), `${populated}\n|  |  |`);

  assert.equal(pressKey(dom, view, "Enter").defaultPrevented, true);
  assert.equal(text(), `${populated}\n\n`);
  assert.equal(view.state.selection.main.head, text().length - 1);

  await type(`${populated}\n|  |  |`);
  pressPencil(view, 0);
  assert.ok(isRawBlock(view.state, 0));
  view.dispatch({ selection: { anchor: populated.length + 3 } });
  assert.equal(pressKey(dom, view, "Backspace").defaultPrevented, true);
  assert.equal(text(), `${populated}\n\n`);
  assert.equal(view.state.selection.main.head, text().length - 1);
});
