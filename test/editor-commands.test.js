// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

async function setup(options = {}) {
  const env = installEditorDom();
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const { markdownEditingCommands } = await import("../src/editor-commands.js");
  const { undo } = await import("../src/vendor/codemirror.js");
  const changes = [];
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    onChange: text => changes.push(text),
    extensions: [markdownEditingCommands()],
    ...options
  });
  return {
    env, editor, changes, undo,
    done() { editor.destroy(); env.cleanup(); }
  };
}

function dispatchKey(t, init) {
  const event = new t.env.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  if ("keyCode" in init) {
    Object.defineProperty(event, "keyCode", { value: init.keyCode });
  }
  t.editor.view.contentDOM.dispatchEvent(event);
  return event;
}

function dispatchPaste(t, text) {
  const event = new t.env.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  t.editor.view.contentDOM.dispatchEvent(event);
  return event;
}

test("Tab indents and Shift-Tab outdents a list item like getIndentEdit", async () => {
  const t = await setup();
  try {
    const { getIndentEdit } = await import("../src/editor-indent.js");
    t.editor.loadText("- a");
    t.editor.setSelection(3, 3);

    const expectedIndent = getIndentEdit("- a", 3, 3, false);
    const tabEvent = dispatchKey(t, { key: "Tab" });
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(t.editor.getText(), expectedIndent.value);
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: expectedIndent.selectionStart, end: expectedIndent.selectionEnd }
    );

    const textAfterIndent = t.editor.getText();
    const caretAfterIndent = t.editor.getSelection().start;
    const expectedOutdent = getIndentEdit(textAfterIndent, caretAfterIndent, caretAfterIndent, true);
    dispatchKey(t, { key: "Tab", shiftKey: true });
    assert.equal(t.editor.getText(), expectedOutdent.value);
  } finally { t.done(); }
});

test("Enter on a list line continues it like getMarkdownAutocompleteEdit", async () => {
  const t = await setup();
  try {
    const { getMarkdownAutocompleteEdit } = await import("../src/editor-autocomplete.js");
    t.editor.loadText("- a");
    t.editor.setSelection(3, 3);
    const expected = getMarkdownAutocompleteEdit("- a", 3, 3);

    const event = dispatchKey(t, { key: "Enter" });
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.editor.getText(), expected.value);
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: expected.selectionStart, end: expected.selectionEnd }
    );
  } finally { t.done(); }
});

test("Enter in the last empty row of a table exits like getTableEnterEdit", async () => {
  const t = await setup();
  try {
    const { getMarkdownAutocompleteEdit } = await import("../src/editor-autocomplete.js");
    const value = "| A | B |\n| --- | --- |\n|  |  |";
    const rowStart = value.lastIndexOf("\n") + 1;
    const cursor = rowStart + 2;
    t.editor.loadText(value);
    t.editor.setSelection(cursor, cursor);
    const expected = getMarkdownAutocompleteEdit(value, cursor, cursor);

    const event = dispatchKey(t, { key: "Enter" });
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.editor.getText(), expected.value);
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: expected.selectionStart, end: expected.selectionEnd }
    );
  } finally { t.done(); }
});

test("a pairing key wraps the selection like getSmartKeyEdit", async () => {
  const t = await setup();
  try {
    const { getSmartKeyEdit } = await import("../src/editor-smart.js");
    t.editor.loadText("x");
    t.editor.setSelection(0, 1);
    const expected = getSmartKeyEdit("x", 0, 1, "(");

    const event = dispatchKey(t, { key: "(" });
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.editor.getText(), expected.value);
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: expected.selectionStart, end: expected.selectionEnd }
    );
  } finally { t.done(); }
});

test("Alt-ArrowDown on the first of two list items moves it like getListMoveEdit", async () => {
  const t = await setup();
  try {
    const { getListMoveEdit } = await import("../src/editor-smart.js");
    const text = "- first\n- second";
    t.editor.loadText(text);
    t.editor.setSelection(2, 2);
    const expected = getListMoveEdit(text, 2, 2, 1);
    assert.ok(expected);

    const event = dispatchKey(t, { key: "ArrowDown", altKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.editor.getText(), expected.value);
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: expected.selectionStart, end: expected.selectionEnd }
    );
  } finally { t.done(); }
});

test("pasting a URL over a selection wraps it like getMarkdownPasteEdit", async () => {
  const t = await setup();
  try {
    const { getMarkdownPasteEdit } = await import("../src/editor-smart.js");
    const text = "visit site now";
    const start = text.indexOf("site");
    const end = start + "site".length;
    t.editor.loadText(text);
    t.editor.setSelection(start, end);
    const expected = getMarkdownPasteEdit(text, start, end, "https://example.com");

    const event = dispatchPaste(t, "https://example.com");
    assert.equal(event.defaultPrevented, true);
    assert.equal(t.editor.getText(), expected.value);
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: expected.selectionStart, end: expected.selectionEnd }
    );
  } finally { t.done(); }
});

test("dead keys and IME composition are ignored", async () => {
  const t = await setup();
  try {
    t.editor.loadText("x");
    t.editor.setSelection(0, 1);

    const deadEvent = dispatchKey(t, { key: "Dead" });
    assert.equal(deadEvent.defaultPrevented, false);
    assert.equal(t.editor.getText(), "x");

    const imeEvent = dispatchKey(t, { key: "(", keyCode: 229 });
    assert.equal(imeEvent.defaultPrevented, false);
    assert.equal(t.editor.getText(), "x");

    t.editor.loadText("- a");
    t.editor.setSelection(3, 3);
    Object.defineProperty(t.editor.view, "composing", { get: () => true, configurable: true });
    const { getMarkdownAutocompleteEdit } = await import("../src/editor-autocomplete.js");
    const wouldContinue = getMarkdownAutocompleteEdit("- a", 3, 3);
    dispatchKey(t, { key: "Enter" });
    assert.notEqual(t.editor.getText(), wouldContinue.value);
  } finally { t.done(); }
});

test("undo after Enter-continuation restores the original text in one step", async () => {
  const t = await setup();
  try {
    t.editor.loadText("- a");
    t.editor.setSelection(3, 3);
    dispatchKey(t, { key: "Enter" });
    assert.notEqual(t.editor.getText(), "- a");

    assert.equal(t.undo(t.editor.view), true);
    assert.equal(t.editor.getText(), "- a");
    assert.deepEqual(
      { start: t.editor.getSelection().start, end: t.editor.getSelection().end },
      { start: 3, end: 3 }
    );
  } finally { t.done(); }
});
