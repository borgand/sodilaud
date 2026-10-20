// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { installEditorDom } from "./helpers/cm-dom.js";
import { setupLive, settle } from "./helpers/live-editor.js";

// CodeMirror reads the platform once, when its module first loads, so this
// file runs as macOS (Mod = Cmd).
{
  const env = installEditorDom();
  Object.defineProperty(env.window.navigator, "platform", { value: "MacIntel", configurable: true });
  await import("../src/vendor/codemirror.js");
  env.cleanup();
}

const T = "x\n\n| a | b | c |\n|---|---|---|\n| 1 | **2** | 3 |\n| 4 | 5 \\| 6 | 7 |\n\ny";

const posOf = (t, needle) => t.view.state.doc.toString().indexOf(needle);
const endOf = (t, needle) => posOf(t, needle) + needle.length;
const widget = t => t.view.contentDOM.querySelector(".cm-lp-table");
const texts = (root, selector) => [...(root?.querySelectorAll(selector) ?? [])].map(element => element.textContent);

async function drag(t, fromNeedle, toNeedle) {
  t.view.dispatch({ selection: { anchor: posOf(t, fromNeedle), head: endOf(t, toNeedle) }, userEvent: "select.pointer" });
  await settle();
}

async function commentKey(t) {
  const event = new t.env.window.KeyboardEvent("keydown", { key: "m", metaKey: true, altKey: true, bubbles: true, cancelable: true });
  t.view.contentDOM.dispatchEvent(event);
  await settle();
}

async function withComment(t, comment) {
  t.view.dispatch({ effects: t.commentsApi.setComments.of([{ id: "c1", author: "owner", state: "open", ...comment }]) });
  await settle();
}

test("Mod-Alt-M on a rectangle opens one composer drafted on its cells only", async () => {
  const t = await setupLive(T, { comments: true });
  try {
    await drag(t, "b", "5");
    await commentKey(t);
    const composer = t.commentsApi.commentComposer(t.view.state);
    assert.equal(composer?.cells, true);
    assert.equal(composer.from, posOf(t, "b"));
    assert.equal(composer.to, endOf(t, "5 \\| 6"));
    assert.ok(widget(t), "the table is rendered");
    assert.ok(widget(t).querySelector(".cm-comment-composer"), "the table hosts the composer");
    assert.deepEqual(texts(widget(t), ".cm-comment-draft"), ["b", "2", "5 | 6"]);
  } finally { t.done(); }
});

test("submit sends cells", async () => {
  const t = await setupLive(T, { comments: true });
  try {
    await drag(t, "b", "5");
    await commentKey(t);
    widget(t).querySelector(".cm-comment-input").value = "Why these?";
    widget(t).querySelector(".cm-comment-add").click();
    await settle();
    assert.equal(t.submitted.length, 1);
    assert.deepEqual(t.submitted[0], { from: posOf(t, "b"), to: endOf(t, "5 \\| 6"), body: "Why these?", cells: true });
  } finally { t.done(); }
});

test("a plain selection still submits without cells", async () => {
  const t = await setupLive("Some prose.\n", { comments: true });
  try {
    t.editor.setSelection(0, 4);
    await settle();
    await commentKey(t);
    assert.equal(t.commentsApi.commentComposer(t.view.state)?.cells, false);
  } finally { t.done(); }
});

test("a cell comment is tinted on its cells only, in the widget and in the grid", async () => {
  const t = await setupLive(T, { comments: true });
  try {
    await withComment(t, { from: posOf(t, "b"), to: endOf(t, "5 \\| 6"), cellText: "b\n**2**\n5 | 6" });
    await t.caret(0);
    assert.deepEqual(texts(widget(t), '[data-comment-id="c1"]'), ["b", "2", "5 | 6"]);

    await t.caret(posOf(t, "a"));
    assert.ok(!widget(t), "the table is a grid");
    const marks = texts(t.view.contentDOM, ".cm-comment").join("|");
    assert.ok(marks.includes("b") && marks.includes("2") && marks.includes("6"), marks);
    assert.ok(!marks.includes("1") && !marks.includes("4") && !marks.includes("c"), marks);
  } finally { t.done(); }
});

test("an ordinary comment across cells is still one range", async () => {
  const t = await setupLive(T, { comments: true });
  try {
    const from = posOf(t, "b");
    const to = endOf(t, "5 \\| 6");
    await withComment(t, { from, to });
    assert.deepEqual(t.commentsApi.commentRanges(t.view.state, t.commentsApi.shownComments(t.view.state)[0]), [{ from, to }]);
    await t.caret(0);
    const tinted = texts(widget(t), '[data-comment-id="c1"]');
    assert.ok(tinted.includes("c") && tinted.includes("1"), tinted.join("|"));
  } finally { t.done(); }
});
