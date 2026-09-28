// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

// CodeMirror reads the platform once, when its module first loads, so every
// editor in this file runs as macOS (Mod = Cmd).
async function setup({ commands = true } = {}) {
  const env = installEditorDom();
  Object.defineProperty(env.window.navigator, "platform", { value: "MacIntel", configurable: true });
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const { markdownEditingCommands } = await import("../src/editor-commands.js");
  const { getFormatEdit } = await import("../src/markdown-format.js");
  const { undo } = await import("../src/vendor/codemirror.js");
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    extensions: commands ? [markdownEditingCommands()] : []
  });
  return {
    env, editor, getFormatEdit, undo,
    done() { editor.destroy(); env.cleanup(); }
  };
}

function dispatchKey(t, init) {
  const event = new t.env.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  let seenByDocument = false;
  const onDocumentKeydown = () => { seenByDocument = true; };
  t.env.document.addEventListener("keydown", onDocumentKeydown);
  try {
    t.editor.view.contentDOM.dispatchEvent(event);
  } finally {
    t.env.document.removeEventListener("keydown", onDocumentKeydown);
  }
  return { prevented: event.defaultPrevented, seenByDocument };
}

// The key values are what macOS WebKit reports on a US layout.
const macShortcuts = [
  ["Cmd-B", "bold", { key: "b", keyCode: 66, metaKey: true }],
  ["Cmd-I", "italic", { key: "i", keyCode: 73, metaKey: true }],
  ["Cmd-K", "link", { key: "k", keyCode: 75, metaKey: true }],
  ["Shift-Cmd-X", "strikethrough", { key: "x", keyCode: 88, metaKey: true, shiftKey: true }],
  ["Shift-Cmd-X (uppercase key)", "strikethrough", { key: "X", keyCode: 88, metaKey: true, shiftKey: true }],
  ["Cmd-E", "code", { key: "e", keyCode: 69, metaKey: true }],
  ["Alt-Cmd-1", "heading-1", { key: "¡", keyCode: 49, metaKey: true, altKey: true }],
  ["Alt-Cmd-2", "heading-2", { key: "™", keyCode: 50, metaKey: true, altKey: true }],
  ["Alt-Cmd-3", "heading-3", { key: "£", keyCode: 51, metaKey: true, altKey: true }],
  ["Alt-Cmd-4", "heading-4", { key: "¢", keyCode: 52, metaKey: true, altKey: true }],
  ["Alt-Cmd-5", "heading-5", { key: "∞", keyCode: 53, metaKey: true, altKey: true }],
  ["Alt-Cmd-6", "heading-6", { key: "§", keyCode: 54, metaKey: true, altKey: true }],
  ["Shift-Cmd-7", "numbered-list", { key: "&", keyCode: 55, metaKey: true, shiftKey: true }],
  ["Shift-Cmd-8", "bullet-list", { key: "*", keyCode: 56, metaKey: true, shiftKey: true }],
  ["Shift-Cmd-9", "task-list", { key: "(", keyCode: 57, metaKey: true, shiftKey: true }],
  ["Shift-Cmd-.", "quote", { key: ">", keyCode: 190, metaKey: true, shiftKey: true }],
  ["Alt-Cmd-C", "code-block", { key: "ç", keyCode: 67, metaKey: true, altKey: true }]
];

for (const [label, actionId, init] of macShortcuts) {
  test(`${label} runs ${actionId} as one undo step and stays in the editor`, async () => {
    const t = await setup();
    try {
      const text = "one two\nthree";
      t.editor.loadText(text);
      t.editor.setSelection(4, 7);
      const expected = t.getFormatEdit(text, 4, 7, actionId);

      const result = dispatchKey(t, init);
      assert.equal(result.prevented, true);
      assert.equal(result.seenByDocument, false);
      assert.equal(t.editor.getText(), expected.value);
      assert.equal(t.editor.getSelection().start, expected.selectionStart);
      assert.equal(t.editor.getSelection().end, expected.selectionEnd);

      assert.equal(t.undo(t.editor.view), true);
      assert.equal(t.editor.getText(), text);
    } finally { t.done(); }
  });
}

test("Alt-Cmd-2 on an H2 line removes the heading", async () => {
  const t = await setup();
  try {
    t.editor.loadText("## title");
    t.editor.setSelection(5, 5);
    dispatchKey(t, { key: "™", keyCode: 50, metaKey: true, altKey: true });
    assert.equal(t.editor.getText(), "title");
  } finally { t.done(); }
});

test("Ctrl-B on macOS is not the bold shortcut", async () => {
  const t = await setup();
  try {
    t.editor.loadText("one two");
    t.editor.setSelection(4, 7);
    dispatchKey(t, { key: "b", keyCode: 66, ctrlKey: true });
    assert.equal(t.editor.getText(), "one two");
  } finally { t.done(); }
});

test("Cmd-I no longer reaches CodeMirror's selectParentSyntax", async () => {
  const t = await setup({ commands: false });
  try {
    t.editor.loadText("# Title\n\nsome paragraph text");
    t.editor.setSelection(14, 14);
    dispatchKey(t, { key: "i", keyCode: 73, metaKey: true });
    assert.equal(t.editor.getSelection().start, 14);
    assert.equal(t.editor.getSelection().end, 14);
  } finally { t.done(); }
});

test("typing right after a formatting shortcut is a separate undo step", async () => {
  const t = await setup();
  try {
    t.editor.loadText("a ");
    t.editor.setSelection(2, 2);
    dispatchKey(t, { key: "b", keyCode: 66, metaKey: true });
    assert.equal(t.editor.getText(), "a ****");

    t.editor.view.dispatch({ changes: { from: 4, insert: "x" }, selection: { anchor: 5 }, userEvent: "input.type" });
    assert.equal(t.editor.getText(), "a **x**");

    t.undo(t.editor.view);
    assert.equal(t.editor.getText(), "a ****");
    t.undo(t.editor.view);
    assert.equal(t.editor.getText(), "a ");
  } finally { t.done(); }
});
