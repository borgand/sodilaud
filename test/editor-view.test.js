// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { installEditorDom } from "./helpers/cm-dom.js";

async function setup(options = {}) {
  const env = installEditorDom();
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const { undo } = await import("../src/vendor/codemirror.js");
  const changes = [];
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "Note text",
    onChange: text => changes.push(text),
    ...options
  });
  return {
    env, editor, changes, undo,
    done() { editor.destroy(); env.cleanup(); }
  };
}

test("loadText sets text and caret without onChange and starts a fresh history", async () => {
  const t = await setup();
  try {
    t.editor.loadText("first");
    t.editor.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    t.changes.length = 0;
    t.editor.loadText("hello");
    assert.equal(t.editor.getText(), "hello");
    assert.deepEqual(t.editor.getSelection(), { start: 0, end: 0, direction: "none" });
    assert.deepEqual(t.changes, []);
    assert.equal(t.undo(t.editor.view), false);
    assert.equal(t.editor.getText(), "hello");
  } finally { t.done(); }
});

test("a user transaction fires onChange with the full new text", async () => {
  const t = await setup();
  try {
    t.editor.loadText("abc");
    t.editor.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    assert.deepEqual(t.changes, ["xabc"]);
  } finally { t.done(); }
});

test("loading note B after editing note A never reports B as a user change", async () => {
  const t = await setup();
  try {
    t.editor.loadText("");
    t.editor.view.dispatch({ changes: { from: 0, insert: "A" }, userEvent: "input.type" });
    t.editor.loadText("B");
    assert.deepEqual(t.changes, ["A"]);
    assert.notEqual(t.changes.at(-1), "B");
    assert.equal(t.editor.getText(), "B");
  } finally { t.done(); }
});

test("setText appends externally, keeps the selection, and is not undoable", async () => {
  const t = await setup();
  try {
    t.editor.loadText("hello world");
    t.editor.setSelection(0, 5);
    t.editor.setText("hello world\nappended");
    assert.equal(t.editor.getText(), "hello world\nappended");
    const { start, end } = t.editor.getSelection();
    assert.deepEqual({ start, end }, { start: 0, end: 5 });
    assert.deepEqual(t.changes, []);
  } finally { t.done(); }
});

test("undo after a user edit and an external append removes only the user edit", async () => {
  const t = await setup();
  try {
    t.editor.loadText("hello world");
    t.editor.view.dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.type" });
    t.editor.setText("> hello world\nappended");
    assert.equal(t.undo(t.editor.view), true);
    assert.equal(t.editor.getText(), "hello world\nappended");
    assert.equal(t.undo(t.editor.view), false);
  } finally { t.done(); }
});

test("setDiff reconfigures the gutter only when its visibility changes", async () => {
  const { EditorView } = await import("../src/vendor/codemirror.js");
  let reconfigures = 0;
  const t = await setup({
    lineNumbers: false,
    extensions: [EditorView.updateListener.of(update => {
      reconfigures += update.transactions.filter(tr => tr.reconfigured).length;
    })]
  });
  try {
    t.editor.loadText("a\nb");
    const diff = { decorations: [], changedLines: [0] };
    t.editor.setDiff(null);
    assert.equal(reconfigures, 0);
    t.editor.setDiff(diff);
    assert.equal(reconfigures, 1);
    t.editor.setDiff(diff);
    assert.equal(reconfigures, 1);
    assert.ok(t.editor.view.dom.querySelector(".cm-gutterElement.cm-diff-line-added"));
    t.editor.setDiff(null);
    assert.equal(reconfigures, 2);
    t.editor.setLineNumbers(true);
    assert.equal(reconfigures, 3);
    t.editor.setDiff(diff);
    t.editor.setDiff(null);
    assert.equal(reconfigures, 3);
    assert.ok(t.editor.view.dom.querySelector(".cm-lineNumbers"));
  } finally { t.done(); }
});

test("applyEdit applies a pure edit as one undoable user change", async () => {
  const t = await setup();
  try {
    t.editor.loadText("a");
    assert.equal(t.editor.applyEdit({ value: "ab", selectionStart: 1, selectionEnd: 1 }), true);
    assert.equal(t.editor.getText(), "ab");
    const { start, end } = t.editor.getSelection();
    assert.deepEqual({ start, end }, { start: 1, end: 1 });
    assert.deepEqual(t.changes, ["ab"]);
    assert.equal(t.undo(t.editor.view), true);
    assert.equal(t.editor.getText(), "a");
    t.changes.length = 0;
    assert.equal(t.editor.applyEdit(null), false);
    t.editor.setSelection(1, 1);
    t.editor.applyEdit({ moveTo: 0 });
    assert.equal(t.editor.getSelection().start, 0);
    assert.deepEqual(t.changes, []);
  } finally { t.done(); }
});

test("find matches render as marks and map through edits", async () => {
  const t = await setup();
  try {
    t.editor.loadText("abcd");
    t.editor.setFindMatches([{ start: 0, end: 1 }, { start: 2, end: 3 }], 1);
    const content = t.editor.view.contentDOM;
    const marks = () => [...content.querySelectorAll(".cm-find-match")];
    assert.equal(marks().length, 2);
    assert.equal(content.querySelectorAll(".cm-find-match.cm-find-active").length, 1);
    assert.equal(content.querySelector(".cm-find-active").textContent, "c");
    t.editor.view.dispatch({ changes: { from: 0, insert: "zz" } });
    assert.deepEqual(marks().map(mark => mark.textContent), ["a", "c"]);
  } finally { t.done(); }
});

test("setDiff renders decorations and a gutter with added and removed line classes", async () => {
  const t = await setup({ lineNumbers: false });
  try {
    const { compareNoteText } = await import("../src/note-compare.js");
    const diffApi = await import("diff");
    const comparison = compareNoteText("same\nold", "same\nnew\nmore", diffApi);
    const root = t.editor.view.dom;

    t.editor.loadText("same\nnew\nmore");
    assert.equal(root.querySelector(".cm-lineNumbers"), null);
    t.editor.setDiff({ decorations: comparison.rightDecorations, changedLines: comparison.rightChangedLines });
    assert.ok(t.editor.view.contentDOM.querySelector(".diff-line-added"));
    assert.ok(root.querySelector(".cm-lineNumbers"));
    assert.equal(root.querySelectorAll(".cm-gutterElement.cm-diff-line-added").length, 2);
    assert.equal(root.querySelectorAll(".cm-diff-line-removed").length, 0);

    t.editor.loadText("same\nold");
    t.editor.setDiff({ decorations: comparison.leftDecorations, changedLines: comparison.leftChangedLines });
    assert.equal(root.querySelectorAll(".cm-gutterElement.cm-diff-line-removed").length, 1);

    t.editor.setDiff({ decorations: [{ start: 0, end: 1, className: "diff-text-added" }], changedLines: [] });
    assert.ok(t.editor.view.contentDOM.querySelector(".diff-text-added"));

    t.editor.setDiff(null);
    assert.equal(root.querySelector(".cm-lineNumbers"), null);
    assert.equal(t.editor.view.contentDOM.querySelector(".diff-text-added"), null);
  } finally { t.done(); }
});

test("setMode switches the mode class and keeps text and selection", async () => {
  const t = await setup();
  try {
    const { modeFacet } = await import("../src/editor-view.js");
    t.editor.loadText("# title");
    t.editor.setSelection(2, 4);
    assert.ok(t.editor.view.dom.classList.contains("cm-mode-live"));
    assert.equal(t.editor.view.state.facet(modeFacet), "live");
    t.editor.setMode("source");
    assert.ok(t.editor.view.dom.classList.contains("cm-mode-source"));
    assert.ok(!t.editor.view.dom.classList.contains("cm-mode-live"));
    assert.equal(t.editor.view.state.facet(modeFacet), "source");
    assert.equal(t.editor.getText(), "# title");
    const { start, end } = t.editor.getSelection();
    assert.deepEqual({ start, end }, { start: 2, end: 4 });
  } finally { t.done(); }
});

test("the content element carries the aria label and disables spellcheck", async () => {
  const t = await setup();
  try {
    const content = t.editor.view.contentDOM;
    assert.equal(content.getAttribute("aria-label"), "Note text");
    assert.equal(content.getAttribute("spellcheck"), "false");
  } finally { t.done(); }
});

test("list item text keeps the body color while its markers stay muted", async () => {
  const t = await setup({ mode: "source" });
  try {
    t.editor.loadText("- bullet item\n1. numbered item\n- **bold** item");
    const muted = [...t.env.document.querySelectorAll(".cm-content .syntax-punctuation")].map(el => el.textContent);
    assert.ok(muted.includes("-"), "bullet marker is muted");
    assert.ok(muted.includes("1."), "number marker is muted");
    assert.ok(!muted.some(text => /bullet|numbered|item/.test(text)), `item text is not muted: ${JSON.stringify(muted)}`);
    const emphasis = [...t.env.document.querySelectorAll(".cm-content .syntax-emphasis")].map(el => el.textContent);
    assert.ok(emphasis.includes("bold"), "inline styling inside a list item still applies");
  } finally { t.done(); }
});
