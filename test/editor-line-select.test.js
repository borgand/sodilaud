// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

const TEXT = "first line\n  second, indented\nthird";

async function setup() {
  const env = installEditorDom();
  const { createMarkdownEditor, lineSelection } = await import("../src/editor-view.js");
  const editor = createMarkdownEditor({ parent: env.document.getElementById("host"), ariaLabel: "t" });
  editor.setText(TEXT);
  return { env, editor, lineSelection, done() { editor.destroy(); env.cleanup(); } };
}

// jsdom has no layout, so the click's document position comes from a stub.
function tripleClick(t, at, drag = at) {
  const { view } = t.editor;
  let position = at;
  view.posAtCoords = () => position;
  const options = { bubbles: true, cancelable: true, button: 0, detail: 3, clientX: 1, clientY: 1 };
  view.contentDOM.dispatchEvent(new t.env.window.MouseEvent("mousedown", options));
  position = drag;
  t.env.document.dispatchEvent(new t.env.window.MouseEvent("mousemove", { ...options, buttons: 1, clientY: 2 }));
  t.env.document.dispatchEvent(new t.env.window.MouseEvent("mouseup", options));
  const { from, to, anchor, head } = view.state.selection.main;
  return { text: view.state.sliceDoc(from, to), anchor, head };
}

test("a triple-click selects the line's text without its line break", async () => {
  const t = await setup();
  try {
    assert.equal(tripleClick(t, 3).text, "first line");
    assert.equal(tripleClick(t, 15).text, "  second, indented");
    assert.equal(tripleClick(t, TEXT.length).text, "third");
  } finally {
    t.done();
  }
});

test("dragging after a triple-click extends by whole lines, still without the last break", async () => {
  const t = await setup();
  try {
    assert.deepEqual(tripleClick(t, 3, 15), { text: "first line\n  second, indented", anchor: 0, head: 29 });
    assert.deepEqual(tripleClick(t, 15, 3), { text: "first line\n  second, indented", anchor: 29, head: 0 });
  } finally {
    t.done();
  }
});

test("lineSelection keeps the anchor line whole in either direction", async () => {
  const t = await setup();
  try {
    const { state } = t.editor.view;
    assert.deepEqual([t.lineSelection(state, 15, 33).anchor, t.lineSelection(state, 15, 33).head], [11, 35]);
    assert.deepEqual([t.lineSelection(state, 33, 2).anchor, t.lineSelection(state, 33, 2).head], [35, 0]);
  } finally {
    t.done();
  }
});
