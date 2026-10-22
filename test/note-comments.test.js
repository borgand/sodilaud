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

test("split-note Reading takes no comments, and leaving split re-renders the single preview", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    instance: 3,
    registry: { seed: { notes: NOTES, imported: true } },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  document.getElementById("split-note-btn").click();
  await app.settle();
  assert.ok(document.getElementById("comment-btn").disabled, "the Comment button is disabled in split Reading");
  assert.ok(!document.querySelector(".reading-composer"), "no Reading composer");
  document.getElementById("split-note-btn").click();
  await app.settle();
  assert.ok(!document.getElementById("comment-btn").disabled, "the Comment button is back");
  assert.ok(document.getElementById("markdown-preview").textContent.includes("Ship on Friday."), "the single preview is rendered again");
});

const TABLE_NOTES = [
  { id: "t", title: "Table", content: "# Table\n\n| Name | Note |\n|---|---|\n| alpha | first row |\n| beta | middle row |\n\nAfter.\n", updatedAt: 2, isTitleLocked: true },
  { id: "o", title: "Other", content: "Other note\n", updatedAt: 1, isTitleLocked: true }
];

async function showNote(app, id) {
  app.dom.window.document.querySelector(`.note-item[data-id="${id}"]`).click();
  await app.settle();
}

test("a Reading composer left in another note is gone after switching back in Live", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    instance: 4,
    registry: { seed: { notes: TABLE_NOTES, imported: true } },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  const { commentComposer } = await import("../src/editor-comments.js");
  await app.settle();
  await showNote(app, "t");
  app.click("mode-reading");
  await app.settle();
  const walker = document.createTreeWalker(document.querySelector("#markdown-preview table"), 4);
  let node = walker.nextNode();
  while (node && !node.nodeValue.includes("middle")) node = walker.nextNode();
  app.dom.window.getSelection().setBaseAndExtent(node, 0, node, 6);
  app.click("comment-btn");
  await app.settle();
  assert.ok(document.querySelector("#markdown-preview .reading-composer"), "the Reading composer opened");

  await showNote(app, "o");
  app.click("mode-live");
  await app.settle();
  await showNote(app, "t");
  const view = app.editor();
  assert.ok(commentComposer(view.state) === null, "the Reading composer did not come back");

  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("middle") } });
  await app.settle(100);
  assert.ok(!document.querySelector(".cm-comment-composer"), "no composer lingers");
  assert.ok(!view.contentDOM.querySelector(".cm-lp-table"), "the table reveals its source with the caret inside");
});

test("a Live composer left in another note is gone after switching back in Reading", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    instance: 5,
    registry: { seed: { notes: TABLE_NOTES, imported: true } },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  const { commentComposer } = await import("../src/editor-comments.js");
  await app.settle();
  await showNote(app, "t");
  const view = app.editor();
  const from = view.state.doc.toString().indexOf("After");
  view.focus();
  view.dispatch({ selection: { anchor: from, head: from + 5 } });
  view.contentDOM.blur();
  await app.settle();
  app.click("comment-btn");
  await app.settle(100);
  assert.ok(document.querySelector(".cm-comment-composer"), "the Live composer opened");

  await showNote(app, "o");
  app.click("mode-reading");
  await app.settle();
  await showNote(app, "t");
  assert.ok(commentComposer(app.editor().state) === null, "the Live composer did not come back");
  assert.ok(!document.querySelector(".cm-comment-composer"), "no composer lingers");
});

test("Reading re-renders a note that catches up on remote edits", async () => {
  let app = null;
  let hold = null;
  app = await bootApp({
    platform: "MacIntel",
    instance: 6,
    registry: { seed: { notes: NOTES, imported: true } },
    handlers: {
      // Holds the editor's catch-up pull so it lands after the page has re-rendered.
      doc_pull: async args => {
        if (!app) return { updates: [] };
        const gate = hold;
        hold = null;
        if (gate) await gate;
        return structuredClone(app.registry.commands.doc_pull(args));
      }
    },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  const preview = document.getElementById("markdown-preview");

  // Two remote updates the page only hears the second of.
  const target = app.registry.workspace().notes.find(note => note.id === "a");
  const intro = { clientID: "agent", changes: [[0, "Intro.", "", ""], target.content.length] };
  const edited = "Intro.\n\n" + target.content;
  const outro = { clientID: "agent", changes: [edited.length, [0, "Outro."]] };
  target.updates.push(intro, outro);
  target.content = edited + "Outro.";
  target.version = 2;
  let release;
  hold = new Promise(resolve => { release = resolve; });
  app.emit("notes-doc-updates", {
    collectionId: app.registry.state().collectionId,
    noteId: "a",
    from: 1,
    updates: [outro],
    version: 2,
    title: target.title,
    updatedAt: Date.now()
  });
  await app.settle();
  release();
  await app.until(() => app.editorText().includes("Outro."));
  await app.settle();

  const text = app.editorText();
  const paragraph = [...preview.querySelectorAll("p")].find(p => p.textContent.includes("Friday"));
  assert.ok(paragraph, "the preview shows the note");
  assert.ok(preview.textContent.includes("Intro."), "the preview shows the remote edit");
  assert.equal(Number(paragraph.getAttribute("data-src-from")), text.indexOf("Ship on Friday."));
});
