// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { installEditorDom } from "./helpers/cm-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const FENCE = "```diff path=src/main.rs hunk=h3f2a1 lines=10-11";
const BODY = "@@ -10,2 +10,2 @@\n let a = 1;\n-let b = 2;\n+let b = 3;";
const DOC = `# Chapter\n\nIntro\n\n${FENCE}\n${BODY}\n\`\`\`\n\nOutro`;

async function setup(text) {
  const env = installEditorDom();
  env.window.marked = marked;
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const { livePreview } = await import("../src/editor-live-preview.js");
  const { commentsExtension } = await import("../src/editor-comments.js");
  const hunks = await import("../src/editor-hunks.js");
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    extensions: [livePreview(), commentsExtension({ onSubmit: () => {} })]
  });
  let hasFocus = true;
  Object.defineProperty(editor.view, "hasFocus", { get: () => hasFocus, configurable: true });
  editor.view.focus = () => {};
  editor.loadText(text);
  const end = text.length;
  editor.setSelection(end, end);
  await settle();
  return {
    env, editor, hunks,
    view: editor.view,
    widget: () => editor.view.contentDOM.querySelector(".cm-lp-hunk"),
    done() { editor.destroy(); env.cleanup(); }
  };
}

test("a review hunk renders as a widget in Live mode and as source under the caret", async () => {
  const t = await setup(DOC);
  try {
    const widget = t.widget();
    assert.ok(widget);
    assert.equal(widget.getAttribute("data-hunk"), "h3f2a1");
    assert.equal(widget.querySelectorAll(".diff-row-add").length, 1);
    const inside = DOC.indexOf("let a");
    t.editor.setSelection(inside, inside);
    await settle();
    assert.equal(t.widget(), null);
    assert.ok(t.view.contentDOM.textContent.includes(FENCE));
  } finally { t.done(); }
});

test("a diff fence without a path stays a code block", async () => {
  const t = await setup("```diff\n+plain\n```\n\nafter");
  try {
    assert.equal(t.widget(), null);
  } finally { t.done(); }
});

test("a fence of four backticks is a hunk too", async () => {
  const t = await setup("````diff path=a.md hunk=h3f2a1 lines=1-1\n@@ -1 +1 @@\n+```js\n````\n\nafter");
  try {
    assert.ok(t.widget());
    assert.equal(t.widget().querySelector(".diff-row-add .diff-code").textContent, "```js");
  } finally { t.done(); }
});

test("the Reviewed toggle writes the token into the fence and back out", async () => {
  const t = await setup(DOC);
  try {
    t.widget().querySelector(".diff-hunk-reviewed").click();
    await settle();
    assert.ok(t.editor.getText().includes(`${FENCE} reviewed\n`));
    assert.ok(t.widget().classList.contains("diff-hunk-is-reviewed"));
    t.widget().querySelector(".diff-hunk-reviewed").click();
    await settle();
    assert.equal(t.editor.getText(), DOC);
  } finally { t.done(); }
});

// The toggle rebuilds the widget; in a browser the content shrinks for a
// moment, the scroll offset is clamped, and a tall hunk scrolled far into
// would leave the reader thousands of pixels away without a snapshot.
test("the Reviewed toggle keeps the reader's place with a scroll snapshot", async () => {
  const t = await setup(DOC);
  try {
    const snapshot = t.view.scrollSnapshot();
    t.view.scrollSnapshot = () => snapshot;
    const dispatched = [];
    const dispatch = t.view.dispatch.bind(t.view);
    t.view.dispatch = (...specs) => { dispatched.push(...specs); return dispatch(...specs); };
    t.widget().querySelector(".diff-hunk-reviewed").click();
    await settle();
    const toggle = dispatched.find(spec => spec.changes);
    assert.ok(toggle, "the toggle dispatched a change");
    assert.deepEqual([toggle.effects].flat(), [snapshot]);
  } finally { t.done(); }
});

test("Reading mode toggles find the hunk by id, or by position without one", async () => {
  const second = "```diff path=b.rs\n@@ -1 +1 @@\n+x\n```";
  const t = await setup(`${DOC}\n\n${second}\n`);
  try {
    assert.equal(t.hunks.setHunkReviewed(t.view, { hunk: "h3f2a1", index: 0 }, true), true);
    assert.ok(t.editor.getText().includes(`${FENCE} reviewed`));
    assert.equal(t.hunks.setHunkReviewed(t.view, { hunk: "h3f2a1", index: 0 }, true), false);
    assert.equal(t.hunks.setHunkReviewed(t.view, { hunk: null, index: 1 }, true), true);
    assert.ok(t.editor.getText().includes("```diff path=b.rs reviewed\n"));
    assert.equal(t.hunks.setHunkReviewed(t.view, { hunk: "h00000", index: 0 }, true), false);
  } finally { t.done(); }
});

test("clicking a line number selects that line's code and opens the comment composer", async () => {
  const t = await setup(DOC);
  try {
    const added = t.widget().querySelector(".diff-row-add .diff-ln-button");
    assert.equal(added.textContent, "11");
    added.click();
    await settle();
    const { from, to } = t.view.state.selection.main;
    assert.equal(t.view.state.doc.sliceString(from, to), "let b = 3;");
    assert.ok(t.view.dom.querySelector(".cm-comment-composer"));
  } finally { t.done(); }
});
