// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const PATH = "/docs/table.md";
const TEXT = "# T\n\nThe intro is vague.\n\n| Name | Note |\n|---|---|\n| alpha | first row |\n| beta | middle row |\n| gamma | last row |\n\nAfter.\n";

const handlers = () => ({
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
  file_lists: () => ({ open: [PATH], recent: [] }),
  file_set_open: () => null,
  file_take_pending: () => []
});

const HUNK_PATH = "/docs/hunk.md";
const HUNK_TEXT = "Intro.\n\n```diff path=a.js hunk=h1a2b3\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n same();\n```\n\nAfter.\n";

const boot = (instance, { path = PATH, text = TEXT } = {}) => bootMainWindow({
  platform: "MacIntel",
  instance,
  disk: { [path]: text },
  handlers: { ...handlers(), file_lists: () => ({ open: [path], recent: [] }) },
  beforeBoot: dom => { dom.window.marked = marked; }
});

function select(view, needle) {
  const from = view.state.doc.toString().indexOf(needle);
  view.dispatch({ selection: { anchor: from, head: from + needle.length } });
}

function textNode(app, root, needle) {
  const doc = app.dom.window.document;
  const walker = doc.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes(needle)) return node;
  }
  return null;
}

test("Live: ⌘⌥M on a middle table row keeps the composer open and focused", async () => {
  const app = await boot(1);
  const doc = app.dom.window.document;
  const view = app.editor();
  await app.settle();
  view.focus();
  select(view, "middle row");
  view.contentDOM.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "m", metaKey: true, altKey: true, bubbles: true, cancelable: true }));
  await app.settle(100);

  const input = doc.querySelector(".cm-comment-composer textarea");
  assert.ok(input, "the composer is still open");
  assert.ok(doc.activeElement === input, "focus is in the composer");
  assert.ok(view.contentDOM.querySelector(".cm-lp-table"), "the table is rendered");
  assert.equal(view.contentDOM.querySelector(".cm-lp-table .cm-comment-draft")?.textContent, "middle row");
  input.value = "Why middle?";
  doc.querySelector(".cm-comment-add").click();
  await app.until(() => app.fileDocs.comments(PATH).length === 1);
  assert.equal(app.fileDocs.comments(PATH)[0].anchoredText, "middle row");
  view.contentDOM.blur();
  await app.settle(100);
  assert.equal(view.contentDOM.querySelector(".cm-lp-table .cm-comment-owner")?.textContent, "middle row");
});

test("Live: the Comment button on a first row opens the composer under the rendered table", async () => {
  const app = await boot(2);
  const doc = app.dom.window.document;
  const view = app.editor();
  await app.settle();
  view.focus();
  select(view, "alpha");
  view.contentDOM.blur();
  await app.settle();
  app.click("comment-btn");
  await app.settle(100);

  const input = doc.querySelector(".cm-comment-composer textarea");
  assert.ok(input, "the composer opened");
  assert.ok(input.closest(".cm-lp-table"), "the composer is inside the rendered table");
  assert.ok(doc.activeElement === input, "focus is in the composer");
});

test("Reading: a selection in a table cell and in prose takes a comment", async () => {
  const app = await boot(3);
  const doc = app.dom.window.document;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  assert.equal(doc.getElementById("comment-btn").disabled, false, "the Comment button is enabled in Reading mode");

  const preview = doc.getElementById("markdown-preview");
  const comment = async (selector, needle, note, count) => {
    const node = [...preview.querySelectorAll(selector)].map(el => textNode(app, el, needle)).find(Boolean);
    assert.ok(node, `found "${needle}" in the preview`);
    const from = node.nodeValue.indexOf(needle);
    app.dom.window.getSelection().setBaseAndExtent(node, from, node, from + needle.length);
    app.click("comment-btn");
    await app.settle(100);
    const input = preview.querySelector(".reading-composer textarea");
    assert.ok(input, "the Reading composer opened");
    input.value = note;
    preview.querySelector(".cm-comment-add").click();
    await app.until(() => app.fileDocs.comments(PATH).length === count);
    return app.fileDocs.comments(PATH)[count - 1];
  };

  const cell = await comment("td", "beta", "Cell note", 1);
  assert.equal(cell.anchoredText, "beta");
  assert.equal(preview.querySelector(".cm-comment-owner")?.textContent, "beta");

  const prose = await comment("p", "vague", "Prose note", 2);
  assert.equal(prose.anchoredText, "vague");
});

// Selects `needle` in the first text node under `root` that holds it.
function selectIn(app, root, needle) {
  const node = textNode(app, root, needle);
  assert.ok(node, `found "${needle}"`);
  const from = node.nodeValue.indexOf(needle);
  app.dom.window.getSelection().setBaseAndExtent(node, from, node, from + needle.length);
}

test("Reading: a review hunk line number comments on that line", async () => {
  const app = await boot(4, { path: HUNK_PATH, text: HUNK_TEXT });
  const doc = app.dom.window.document;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  const preview = doc.getElementById("markdown-preview");
  const row = [...preview.querySelectorAll(".diff-hunk tr")].find(tr => tr.textContent.includes("const a = 2;"));
  assert.ok(row, "the added line is shown");
  row.querySelector(".diff-ln-button").click();
  await app.settle();
  const input = preview.querySelector(".diff-hunk tr.diff-composer-row textarea");
  assert.ok(input, "the composer opened under the line");
  input.value = "Why 2?";
  preview.querySelector(".cm-comment-add").click();
  await app.until(() => app.fileDocs.comments(HUNK_PATH).length === 1);
  assert.equal(app.fileDocs.comments(HUNK_PATH)[0].anchoredText, "const a = 2;");
});

test("changing mode closes an open composer", async () => {
  const app = await boot(5);
  const doc = app.dom.window.document;
  const { commentComposer } = await import("../src/editor-comments.js");
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  selectIn(app, doc.querySelector("#markdown-preview p"), "vague");
  app.click("comment-btn");
  await app.settle();
  assert.ok(doc.querySelector("#markdown-preview .reading-composer"), "the Reading composer opened");

  app.click("mode-live");
  await app.settle(100);
  assert.ok(!doc.querySelector(".cm-comment-composer"), "no composer is left after leaving Reading");
  assert.equal(commentComposer(app.editor().state), null);

  const view = app.editor();
  view.focus();
  select(view, "vague");
  view.contentDOM.blur();
  await app.settle();
  app.click("comment-btn");
  await app.settle(100);
  assert.ok(doc.querySelector(".cm-comment-composer"), "the Live composer opened");
  app.click("mode-reading");
  await app.settle(100);
  assert.ok(!doc.querySelector(".cm-comment-composer"), "no composer is left after entering Reading");
  assert.equal(commentComposer(app.editor().state), null);
});

test("Reading: the comments count and drawer show", async () => {
  const app = await boot(6);
  const doc = app.dom.window.document;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  assert.equal(doc.getElementById("comments-count-btn").hidden, true, "no comments, no agent: hidden");
  selectIn(app, doc.querySelector("#markdown-preview p"), "vague");
  app.click("comment-btn");
  await app.settle(100);
  doc.querySelector("#markdown-preview .reading-composer textarea").value = "Note";
  doc.querySelector("#markdown-preview .cm-comment-add").click();
  await app.until(() => app.fileDocs.comments(PATH).length === 1);
  await app.settle();
  assert.equal(doc.getElementById("comments-count-btn").hidden, false);
  assert.equal(doc.getElementById("comments-panel").hidden, false);
});

test("Reading: an agent edit while composing keeps the text and focus and moves the tint", async () => {
  const app = await boot(7);
  const doc = app.dom.window.document;
  await app.settle();
  app.click("mode-reading");
  await app.settle();
  const preview = doc.getElementById("markdown-preview");
  selectIn(app, preview.querySelector("table"), "beta");
  app.click("comment-btn");
  await app.settle(100);
  const input = preview.querySelector(".reading-composer textarea");
  assert.ok(input, "the Reading composer opened");
  input.value = "half typed";
  input.focus();
  input.setSelectionRange(4, 4);

  app.fileDocs.agentEdit(PATH, [5, [0, "An agent paragraph.", "", ""], TEXT.length - 5]);
  await app.until(() => app.editorText().includes("An agent paragraph."));
  await app.settle();
  assert.ok(preview.textContent.includes("An agent paragraph."), "the preview shows the edit");
  assert.ok(preview.querySelector(".reading-composer textarea") === input, "the composer survived");
  assert.equal(input.value, "half typed");
  assert.ok(doc.activeElement === input, "focus stayed in the composer");
  assert.deepEqual([input.selectionStart, input.selectionEnd], [4, 4]);
  assert.equal(preview.querySelector(".cm-comment-draft")?.textContent, "beta");

  preview.querySelector(".cm-comment-add").click();
  await app.until(() => app.fileDocs.comments(PATH).length === 1);
  assert.equal(app.fileDocs.comments(PATH)[0].anchoredText, "beta");
});

const OTHER = "/docs/other.md";

const bootTwo = instance => bootMainWindow({
  platform: "MacIntel",
  instance,
  disk: { [PATH]: TEXT, [OTHER]: "Other file.\n" },
  handlers: { ...handlers(), file_lists: () => ({ open: [PATH, OTHER], recent: [] }) },
  beforeBoot: dom => { dom.window.marked = marked; }
});

async function showFile(app, path) {
  const name = path.split("/").pop();
  const button = [...app.dom.window.document.querySelectorAll(".open-file-name")].find(el => el.textContent.includes(name));
  assert.ok(button, `${name} is open`);
  button.click();
  await app.settle();
}

test("a Reading composer left in another file is gone after switching back in Live", async () => {
  const app = await bootTwo(8);
  const doc = app.dom.window.document;
  const { commentComposer } = await import("../src/editor-comments.js");
  await app.settle();
  await showFile(app, PATH);
  app.click("mode-reading");
  await app.settle();
  selectIn(app, doc.querySelector("#markdown-preview table"), "middle");
  app.click("comment-btn");
  await app.settle();
  assert.ok(doc.querySelector("#markdown-preview .reading-composer"), "the Reading composer opened");

  await showFile(app, OTHER);
  app.click("mode-live");
  await app.settle();
  await showFile(app, PATH);
  const view = app.editor();
  assert.ok(commentComposer(view.state) === null, "the Reading composer did not come back");

  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("middle") } });
  await app.settle(100);
  assert.ok(!doc.querySelector(".cm-comment-composer"), "no composer lingers");
  assert.ok(!view.contentDOM.querySelector(".cm-lp-table"), "the table widget gives way to the grid");
  assert.ok(view.contentDOM.querySelector(".cm-lp-trow"), "the table is a grid with the caret inside");
});

test("a Live composer left in another file is gone after switching back in Reading", async () => {
  const app = await bootTwo(9);
  const doc = app.dom.window.document;
  const { commentComposer } = await import("../src/editor-comments.js");
  await app.settle();
  await showFile(app, PATH);
  const view = app.editor();
  view.focus();
  select(view, "vague");
  view.contentDOM.blur();
  await app.settle();
  app.click("comment-btn");
  await app.settle(100);
  assert.ok(doc.querySelector(".cm-comment-composer"), "the Live composer opened");

  await showFile(app, OTHER);
  app.click("mode-reading");
  await app.settle();
  await showFile(app, PATH);
  assert.ok(commentComposer(app.editor().state) === null, "the Live composer did not come back");
  assert.ok(!doc.querySelector(".cm-comment-composer"), "no composer lingers");
});

test("Live: a table ignores a Reading composer and shows its grid around the caret", async () => {
  const app = await boot(10);
  const doc = app.dom.window.document;
  const { startCommentAt } = await import("../src/editor-comments.js");
  await app.settle();
  const view = app.editor();
  const from = TEXT.indexOf("middle");
  assert.equal(startCommentAt(view, from, from + 6, { outside: true }), true);
  view.focus();
  view.dispatch({ selection: { anchor: from } });
  await app.settle(100);
  assert.ok(!doc.querySelector(".cm-comment-composer"), "the Reading composer is not drawn in Live");
  assert.ok(!view.contentDOM.querySelector(".cm-lp-table"), "the table widget gives way to the grid");
  assert.ok(view.contentDOM.querySelector(".cm-lp-trow"), "the table is a grid with the caret inside");
});
