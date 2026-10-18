// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const PATH = "/docs/table.md";
const TEXT = "# T\n\nThe intro is vague.\n\n| Name | Note |\n|---|---|\n| alpha | first row |\n| beta | middle row |\n| gamma | last row |\n\nAfter.\n";

const handlers = () => ({
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
  file_lists: () => ({ open: [PATH], recent: [] }),
  file_set_open: () => null,
  file_take_pending: () => []
});

const boot = instance => bootMainWindow({ platform: "MacIntel", instance, disk: { [PATH]: TEXT }, handlers: handlers() });

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

test("Live: ⌘⌥M on a middle table row keeps the composer open and focused", { todo: "item 9: fixed in Task 5" }, async () => {
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
  assert.equal(doc.activeElement, input, "focus is in the composer");
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

test("Live: the Comment button on a first row opens the composer under the rendered table", { todo: "item 9: fixed in Task 5" }, async () => {
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
  assert.equal(doc.activeElement, input, "focus is in the composer");
});

test("Reading: a selection in a table cell and in prose takes a comment", { todo: "item 9: fixed in Task 7" }, async () => {
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
