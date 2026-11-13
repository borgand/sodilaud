// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

async function setup({ doc = "", vim = true } = {}) {
  const env = installEditorDom();
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const { markdownEditingCommands } = await import("../src/editor-commands.js");
  const modes = [];
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    vimMode: vim,
    onVimStatus: (mode) => modes.push(mode),
    extensions: [markdownEditingCommands()]
  });
  editor.loadText(doc);
  return {
    env, editor, modes,
    view: editor.view,
    text: () => editor.getText(),
    done() { editor.destroy(); env.cleanup(); }
  };
}

function press(t, init) {
  const event = new t.env.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  t.view.contentDOM.dispatchEvent(event);
  return event;
}

// What the browser would insert after a dead key or an IME composition:
// every input handler declines, so CodeMirror inserts the text itself.
function inputHandled(t, text) {
  const { EditorView } = t.cm;
  const { head } = t.view.state.selection.main;
  return t.view.state.facet(EditorView.inputHandler).some(handler => handler(t.view, head, head, text, () => null));
}

test("Vim keys are off by default", async () => {
  const t = await setup({ doc: "abc", vim: false });
  try {
    assert.equal(t.view.cm, undefined);
    assert.equal(press(t, { key: "x" }).defaultPrevented, false);
    assert.equal(t.text(), "abc");
  } finally { t.done(); }
});

test("normal mode runs Vim commands and i enters insert mode", async () => {
  const t = await setup({ doc: "abc" });
  try {
    t.editor.setSelection(0, 0);
    assert.equal(press(t, { key: "x" }).defaultPrevented, true);
    assert.equal(t.text(), "bc");
    press(t, { key: "i" });
    assert.equal(t.modes.at(-1), "INSERT");
    assert.equal(press(t, { key: "q" }).defaultPrevented, false, "a letter in insert mode is typed text");
    press(t, { key: "Escape" });
    assert.equal(t.modes.at(-1), "NORMAL");
  } finally { t.done(); }
});

test("Markdown typing helpers stay out of normal mode and work in insert mode", async () => {
  const t = await setup({ doc: "- item" });
  try {
    t.editor.setSelection(6, 6);
    press(t, { key: "Enter" });
    assert.equal(t.text(), "- item", "Enter in normal mode continues no list");
    press(t, { key: "(" });
    assert.equal(t.text(), "- item", "( in normal mode pairs no brackets");
    press(t, { key: "A" });
    t.editor.setSelection(6, 6);
    press(t, { key: "Enter" });
    assert.equal(t.text(), "- item\n- ", "Enter in insert mode continues the list");
  } finally { t.done(); }
});

test("dead keys and composed letters type in insert mode", async () => {
  const t = await setup({ doc: "" });
  try {
    t.cm = await import("../src/vendor/codemirror.js");
    press(t, { key: "i" });
    const dead = press(t, { key: "Dead", code: "Quote" });
    assert.equal(dead.defaultPrevented, false, "the dead key reaches the browser");
    for (const letter of ["õ", "ä", "ö", "ü", "š", "ž"]) {
      assert.equal(inputHandled(t, letter), false, `${letter} is inserted as typed`);
    }
    const composed = press(t, { key: "Process", keyCode: 229, isComposing: true });
    assert.equal(composed.defaultPrevented, false);
  } finally { t.done(); }
});

test("Escape in insert mode returns to normal mode before anything else sees it", async () => {
  const t = await setup({ doc: "abc" });
  try {
    let seenByDocument = false;
    t.env.document.addEventListener("keydown", () => { seenByDocument = true; });
    press(t, { key: "i" });
    press(t, { key: "Escape" });
    assert.equal(t.modes.at(-1), "NORMAL");
    assert.equal(seenByDocument, false);
  } finally { t.done(); }
});

test("Cmd and Alt shortcuts pass through normal mode", async () => {
  const t = await setup({ doc: "abc" });
  try {
    let seen = 0;
    t.env.document.addEventListener("keydown", () => { seen += 1; });
    press(t, { key: "s", metaKey: true });
    press(t, { key: "f", metaKey: true });
    press(t, { key: "µ", code: "KeyM", metaKey: true, altKey: true });
    assert.equal(seen, 3);
    assert.equal(t.text(), "abc");
  } finally { t.done(); }
});

test("off macOS, Ctrl+F stays the find shortcut in normal mode", async () => {
  const t = await setup({ doc: "a\nb\nc" });
  try {
    let seenByDocument = false;
    t.env.document.addEventListener("keydown", () => { seenByDocument = true; });
    t.editor.setSelection(0, 0);
    press(t, { key: "f", ctrlKey: true });
    assert.equal(seenByDocument, true);
    assert.equal(t.view.state.selection.main.head, 0, "Vim does not page down");
  } finally { t.done(); }
});

test("Vim turns on and off live", async () => {
  const t = await setup({ doc: "abc", vim: false });
  try {
    t.editor.setVimMode(true);
    assert.ok(t.view.cm);
    assert.equal(t.modes.at(-1), "NORMAL");
    t.editor.setSelection(0, 0);
    press(t, { key: "x" });
    assert.equal(t.text(), "bc");
    t.editor.setVimMode(false);
    assert.equal(t.view.cm, undefined);
    assert.equal(press(t, { key: "x" }).defaultPrevented, false);
    t.editor.loadText("again");
    assert.equal(t.view.cm, undefined, "a newly loaded document keeps the setting");
    t.editor.setVimMode(true);
    t.editor.loadText("again");
    assert.ok(t.view.cm);
  } finally { t.done(); }
});
