// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { installEditorDom } from "./helpers/cm-dom.js";

const PROSE = "Intro is vague here.\n\n| Name | Value |\n| --- | --- |\n| alpha | beta |\n\nAfter the table.\n";
const HUNK = "Intro.\n\n```diff path=a.js hunk=h1a2b3\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n same();\n```\n\nAfter.\n";

async function setup(text, { onSelect = () => {} } = {}) {
  const env = installEditorDom("<!doctype html><div id=host></div><div id=preview class=markdown-preview></div>");
  Object.defineProperty(env.window.navigator, "platform", { value: "MacIntel", configurable: true });
  env.window.marked = marked;
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const comments = await import("../src/editor-comments.js");
  const hunks = await import("../src/editor-hunks.js");
  const { renderMarkdown } = await import("../src/markdown.js");
  const { renderHunkWidgets } = await import("../src/diff-hunk.js");
  const { createReadingComments } = await import("../src/reading-comments.js");
  const { livePreview } = await import("../src/editor-live-preview.js");
  const preview = env.document.getElementById("preview");
  const submitted = [];
  const state = { enabled: true };
  let editor = null;
  const reading = createReadingComments({ preview, view: () => editor?.view ?? null, enabled: () => state.enabled });
  editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    extensions: [
      comments.commentsExtension({ onSubmit: async (view, comment) => { submitted.push(comment); }, onSelect }),
      reading.extension,
      livePreview({})
    ]
  });
  editor.loadText(text);
  const render = () => reading.renderWith(() => {
    preview.innerHTML = renderMarkdown(editor.view.state.doc.toString(), "", marked, { positions: true });
    renderHunkWidgets(preview, reading.hunkOptions());
  });
  render();
  const selectText = (node, from = 0, to = node.data.length) => {
    const range = env.document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = env.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const textNode = (root, text) => {
    const walker = env.document.createTreeWalker(root, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data.includes(text)) return node;
    return null;
  };
  return {
    env, preview, reading, comments, hunks, submitted, state, render, selectText, textNode,
    view: () => editor.view,
    done() {
      reading.destroy();
      editor.destroy();
      env.cleanup();
    }
  };
}

test("start maps a table cell selection and opens a hosted composer below the table", async () => {
  const t = await setup(PROSE);
  try {
    t.selectText(t.textNode(t.preview.querySelector("table"), "beta"));
    assert.equal(t.reading.start(), true);
    const composer = t.comments.commentComposer(t.view().state);
    const from = PROSE.indexOf("beta");
    assert.deepEqual([composer.from, composer.to, composer.hosted, composer.outside], [from, from + 4, true, true]);
    const box = t.preview.querySelector(".reading-composer");
    assert.ok(box);
    assert.ok(t.preview.querySelector(".table-scroll").nextElementSibling === box);
    assert.ok(box.querySelector(".cm-comment-composer"));
    assert.equal(t.preview.querySelector(".cm-comment-draft").textContent, "beta");
    assert.ok(!t.view().dom.querySelector(".cm-comment-composer"));
  } finally {
    t.done();
  }
});

test("submit sends the range and closing does not focus the hidden editor", async () => {
  const t = await setup(PROSE);
  try {
    let focused = 0;
    t.view().focus = () => { focused += 1; };
    t.selectText(t.textNode(t.preview.querySelector("table"), "beta"));
    t.reading.start();
    t.preview.querySelector(".reading-composer textarea").value = "Why beta?";
    t.preview.querySelector(".reading-composer .cm-comment-add").click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const from = PROSE.indexOf("beta");
    assert.deepEqual(t.submitted, [{ from, to: from + 4, body: "Why beta?" }]);
    assert.equal(focused, 0);
    assert.ok(!t.preview.querySelector(".reading-composer"));
    assert.equal(t.comments.commentComposer(t.view().state), null);
  } finally {
    t.done();
  }
});

test("comments are tinted and a click selects the thread", async () => {
  const selected = [];
  const t = await setup(PROSE, { onSelect: id => selected.push(id) });
  try {
    const from = PROSE.indexOf("vague");
    t.view().dispatch({
      effects: t.comments.setComments.of([{ id: "c1", author: "agent", from, to: from + 5, state: "open", body: "x" }])
    });
    const mark = t.env.document.querySelector("#preview .cm-comment-agent");
    assert.ok(mark);
    assert.equal(mark.textContent, "vague");
    assert.equal(mark.getAttribute("data-comment-id"), "c1");
    mark.click();
    assert.deepEqual(selected, ["c1"]);
  } finally {
    t.done();
  }
});

test("a remote edit while composing keeps the text and focus", async () => {
  const t = await setup(PROSE);
  try {
    t.selectText(t.textNode(t.preview.querySelector("table"), "beta"));
    t.reading.start();
    const before = t.comments.commentComposer(t.view().state);
    const input = t.preview.querySelector(".reading-composer textarea");
    input.value = "half";
    input.focus();
    input.setSelectionRange(2, 3);
    t.view().dispatch({ changes: { from: 0, insert: "New line.\n\n" } });
    t.render();
    assert.ok(input.isConnected);
    assert.ok(t.preview.querySelector(".reading-composer textarea") === input);
    assert.ok(t.preview.querySelector(".table-scroll").nextElementSibling.classList.contains("reading-composer"));
    assert.equal(input.value, "half");
    assert.ok(t.env.document.activeElement === input);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 3]);
    const after = t.comments.commentComposer(t.view().state);
    assert.deepEqual([after.from, after.to], [before.from + 11, before.to + 11]);
    assert.equal(t.preview.querySelector(".cm-comment-draft").textContent, "beta");
  } finally {
    t.done();
  }
});

test("a hunk line number comments on that line", async () => {
  const t = await setup(HUNK);
  try {
    t.preview.querySelector(".diff-hunk .diff-ln-button").click();
    const state = t.view().state;
    const found = t.hunks.findHunkFence(state, { hunk: "h1a2b3", index: 0 });
    assert.ok(found);
    const expected = t.hunks.hunkLineRange(state, found, 1);
    const composer = t.comments.commentComposer(state);
    assert.deepEqual([composer.from, composer.to], [expected.from, expected.to]);
    assert.equal(state.doc.sliceString(composer.from, composer.to), "const a = 1;");
    const row = t.preview.querySelector(".diff-hunk tr.diff-composer-row");
    assert.ok(row);
    assert.ok(row.querySelector(".cm-comment-composer"));
    assert.ok(!t.preview.querySelector(".reading-composer"));
    assert.equal(t.preview.querySelector(".diff-hunk .cm-comment-draft").textContent, "const a = 1;");
    assert.ok(!t.view().dom.querySelector(".cm-comment-composer"));
  } finally {
    t.done();
  }
});

test("a remote edit while composing in a hunk keeps the text and focus", async () => {
  const t = await setup(HUNK);
  try {
    t.preview.querySelector(".diff-hunk .diff-ln-button").click();
    const before = t.comments.commentComposer(t.view().state);
    const input = t.preview.querySelector(".diff-hunk tr.diff-composer-row textarea");
    assert.ok(input);
    input.value = "half";
    input.focus();
    input.setSelectionRange(1, 3);
    t.view().dispatch({ changes: { from: 0, insert: "New line.\n\n" } });
    t.render();
    const after = t.preview.querySelector(".diff-hunk tr.diff-composer-row textarea");
    assert.ok(after === input);
    assert.equal(input.value, "half");
    assert.ok(t.env.document.activeElement === input);
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 3]);
    const moved = t.comments.commentComposer(t.view().state);
    assert.deepEqual([moved.from, moved.to], [before.from + 11, before.to + 11]);
    assert.equal(t.preview.querySelector(".diff-hunk .cm-comment-draft").textContent, "const a = 1;");
  } finally {
    t.done();
  }
});

test("nothing selected: start returns false", async () => {
  const t = await setup(PROSE);
  try {
    t.env.window.getSelection().removeAllRanges();
    assert.equal(t.reading.start(), false);
    assert.equal(t.comments.commentComposer(t.view().state), null);
  } finally {
    t.done();
  }
});

test("Mod-Alt-M in Reading starts a comment", async () => {
  const t = await setup(PROSE);
  try {
    const press = () => t.env.document.body.dispatchEvent(new t.env.window.KeyboardEvent("keydown", {
      code: "KeyM", key: "µ", metaKey: true, altKey: true, bubbles: true, cancelable: true
    }));
    t.selectText(t.textNode(t.preview, "vague"), 9, 14);
    t.state.enabled = false;
    press();
    assert.equal(t.comments.commentComposer(t.view().state), null);
    t.state.enabled = true;
    press();
    const composer = t.comments.commentComposer(t.view().state);
    const from = PROSE.indexOf("vague");
    assert.deepEqual([composer.from, composer.to], [from, from + 5]);
    assert.ok(t.preview.querySelector(".reading-composer"));
  } finally {
    t.done();
  }
});

test("the floating button comments on a mapped selection", async () => {
  const t = await setup(PROSE);
  try {
    t.selectText(t.textNode(t.preview, "vague"), 9, 14);
    t.preview.dispatchEvent(new t.env.window.MouseEvent("mouseup", { bubbles: true }));
    const button = t.preview.querySelector(".reading-comment-button");
    assert.ok(button);
    assert.equal(button.hidden, false);
    assert.equal(button.textContent, "Comment");
    button.click();
    assert.equal(button.hidden, true);
    const from = PROSE.indexOf("vague");
    const composer = t.comments.commentComposer(t.view().state);
    assert.deepEqual([composer.from, composer.to], [from, from + 5]);
  } finally {
    t.done();
  }
});
