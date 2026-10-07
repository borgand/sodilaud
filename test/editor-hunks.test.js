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
  const comments = await import("../src/editor-comments.js");
  const hunks = await import("../src/editor-hunks.js");
  const submitted = [];
  const selected = [];
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    extensions: [livePreview(), comments.commentsExtension({
      onSubmit: async (view, comment) => { submitted.push(comment); },
      onSelect: id => selected.push(id)
    })]
  });
  let hasFocus = true;
  Object.defineProperty(editor.view, "hasFocus", { get: () => hasFocus, configurable: true });
  editor.view.focus = () => {};
  editor.loadText(text);
  const end = text.length;
  editor.setSelection(end, end);
  await settle();
  return {
    env, editor, hunks, comments, submitted, selected,
    setFocus(value) { hasFocus = value; },
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

test("clicking a line number opens the comment composer for that line's code inside the widget", async () => {
  const t = await setup(DOC);
  try {
    const before = t.view.state.selection.main;
    const added = t.widget().querySelector(".diff-row-add .diff-ln-button");
    assert.equal(added.textContent, "11");
    added.click();
    await settle();
    const composer = t.comments.commentComposer(t.view.state);
    assert.equal(t.view.state.doc.sliceString(composer.from, composer.to), "let b = 3;");
    assert.deepEqual(t.view.state.selection.main, before, "the selection stays, so the fence is not revealed");
    assert.ok(t.widget(), "the hunk is still a widget");
    assert.ok(t.widget().querySelector(".diff-composer-row .cm-comment-composer"));
    assert.equal(t.widget().querySelector(".cm-comment-draft").textContent, "let b = 3;");
  } finally { t.done(); }
});

test("a comment on selected code is made from inside the widget and anchors to the fence text", async () => {
  const t = await setup(DOC);
  try {
    const widget = t.widget();
    const before = t.view.state.selection.main;
    let blurred = 0;
    t.view.contentDOM.blur = () => { blurred += 1; t.setFocus(false); };
    const row = widget.querySelector('tr.diff-row[data-index="2"] .diff-code');
    row.dispatchEvent(new t.env.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 3 }));
    assert.equal(blurred, 1, "selecting code lets go of the editor's focus");
    const button = widget.querySelector(".diff-hunk-comment-button");
    assert.equal(button.hidden, false);
    button.click();
    await settle();
    assert.equal(t.widget(), widget, "opening the composer updates the widget in place");
    const composerRow = widget.querySelector(".diff-composer-row");
    assert.equal(composerRow.previousElementSibling.dataset.index, "2");
    composerRow.querySelector("textarea").value = "Why two?";
    composerRow.querySelector(".cm-comment-add").click();
    await settle();
    await settle();
    assert.equal(t.submitted.length, 1);
    const { from, to, body } = t.submitted[0];
    assert.equal(t.view.state.doc.sliceString(from, to), "let b = 2;");
    assert.equal(body, "Why two?");
    assert.deepEqual(t.view.state.selection.main, before);
    assert.equal(t.widget(), widget, "closing the composer updates the widget in place");
    assert.equal(widget.querySelector(".diff-composer-row"), null);
  } finally { t.done(); }
});

test("comments on fence text show as marks in the widget, and clicking one selects its thread", async () => {
  const t = await setup(DOC);
  try {
    const widget = t.widget();
    const from = DOC.indexOf("let b = 3");
    t.view.dispatch({ effects: t.comments.setComments.of([
      { id: "c1", author: "agent", state: "open", from, to: from + 9, body: "?" },
      { id: "c2", author: "owner", state: "resolved", from, to: from + 5, body: "done" },
      { id: "c3", author: "owner", state: "queued", from: DOC.indexOf("Intro"), to: DOC.indexOf("Intro") + 5, body: "prose" }
    ]) });
    await settle();
    assert.equal(t.widget(), widget, "comments change the widget in place, never rebuild it");
    const marks = [...widget.querySelectorAll(".diff-mark")];
    assert.deepEqual(marks.map(mark => mark.getAttribute("data-comment-id")), ["c1"]);
    assert.equal(marks[0].textContent, "let b = 3");
    assert.ok(marks[0].classList.contains("cm-comment-agent"));

    marks[0].dispatchEvent(new t.env.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    t.env.document.dispatchEvent(new t.env.window.MouseEvent("mouseup", { bubbles: true }));
    assert.deepEqual(t.selected, ["c1"]);

    t.view.dispatch({ effects: t.comments.setActiveComment.of("c1") });
    await settle();
    assert.ok(widget.querySelector(".diff-mark").classList.contains("cm-comment-active"));
  } finally { t.done(); }
});
