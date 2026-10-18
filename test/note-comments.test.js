// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootApp } from "./helpers/app-harness.js";

const NOTES = [
  { id: "a", title: "Plan", content: "# Plan\n\nShip on Friday.\n", updatedAt: 2, isTitleLocked: false },
  { id: "b", title: "Other", content: "Other note\n", updatedAt: 1, isTitleLocked: false }
];

test("notes take comments, from the shortcut or the context menu, and agent comments show in the agent's color", async () => {
  const app = await bootApp({ platform: "MacIntel", registry: { seed: { notes: NOTES, imported: true } } });
  const { document } = app.dom.window;
  const view = app.editor();
  await app.settle();
  assert.equal(document.getElementById("comments-count-btn").hidden, true);

  const from = view.state.doc.toString().indexOf("Friday");
  view.dispatch({ selection: { anchor: from, head: from + 6 } });
  view.contentDOM.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "m", metaKey: true, altKey: true }));
  await app.settle();
  const input = document.querySelector(".cm-comment-composer textarea");
  input.value = "Which Friday?";
  document.querySelector(".cm-comment-add").click();
  await app.settle(300);
  assert.deepEqual(app.registry.comments("a").map(c => [c.anchoredText, c.body]), [["Friday", "Which Friday?"]]);
  assert.equal(document.getElementById("comments-count-btn").textContent, "1 comment");
  assert.equal(document.getElementById("comments-count-btn").hidden, false);
  assert.equal(document.getElementById("comments-panel").hidden, false);

  app.registry.agentComment("a", "Ship", "Ship what, exactly?");
  await app.settle();
  assert.ok(view.dom.querySelector(".cm-comment-agent"), "the agent's comment is tinted in its color");
  assert.ok(view.dom.querySelector(".cm-comment-marker-agent"), "and marked in the gutter");
  const agentItem = document.querySelector(".comment-item.comment-agent");
  agentItem.querySelector(".comment-resolve").click();
  await app.settle();
  assert.equal(app.registry.comments("a").find(c => c.author === "agent").state, "resolved");

  // The context menu offers Comment on an editor selection.
  view.dispatch({ selection: { anchor: 2, head: 6 } });
  view.contentDOM.dispatchEvent(new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await app.settle();
  assert.equal(document.getElementById("ctx-comment").style.display, "flex");
  document.getElementById("ctx-comment").click();
  await app.settle();
  assert.ok(document.querySelector(".cm-comment-composer"));
});

test("a note takes a comment in Reading mode", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    instance: 2,
    registry: { seed: { notes: NOTES, imported: true } },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  const preview = document.getElementById("markdown-preview");
  const walker = document.createTreeWalker(preview, 4);
  let node = walker.nextNode();
  while (node && !node.nodeValue.includes("Friday")) node = walker.nextNode();
  assert.ok(node, "the preview shows the note");
  const from = node.nodeValue.indexOf("Friday");
  app.dom.window.getSelection().setBaseAndExtent(node, from, node, from + 6);
  app.click("comment-btn");
  await app.settle();
  const input = document.querySelector("#markdown-preview .reading-composer textarea");
  assert.ok(input, "the Reading composer opened");
  input.value = "Which Friday?";
  document.querySelector(".cm-comment-add").click();
  await app.settle(300);
  assert.deepEqual(app.registry.comments("a").map(c => [c.anchoredText, c.body]).at(-1), ["Friday", "Which Friday?"]);
});
