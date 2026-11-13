// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const NOTES = [
  { id: "book", title: "Book", content: "# Book\n\nIntro\n\n## Engine\n\nBody\n", updatedAt: 2, isTitleLocked: true },
  { id: "plain", title: "Plain", content: "no headings here\n", updatedAt: 1, isTitleLocked: true }
];

const app = await bootApp({
  storage: { sodilaud_notes: NOTES },
  beforeBoot: dom => { dom.window.HTMLElement.prototype.scrollIntoView = () => {}; }
});
const { document } = app.dom.window;
const $ = id => document.getElementById(id);
const rows = () => [...document.querySelectorAll("#outline-list .outline-item")].map(item => item.textContent);

test("Saved fades after a moment and an edit brings it back", async () => {
  const status = $("save-status");
  await app.until(() => status.textContent.startsWith("Saved"));
  await app.until(() => status.classList.contains("settled"), 4000);
  assert.ok(status.classList.contains("settled"));
  const view = app.editor();
  view.dispatch({ changes: { from: view.state.doc.length, insert: "x" }, userEvent: "input.type" });
  await app.settle(0);
  assert.ok(!status.classList.contains("settled"), "Saving shows at once");
  await app.until(() => status.textContent.startsWith("Saved"));
  assert.ok(!status.classList.contains("settled"), "a fresh Saved is shown before it fades");
});

test("the outline lists the current note's headings and follows edits", async () => {
  assert.equal($("outline-section").hidden, false);
  assert.deepEqual(rows(), ["Book", "Engine"]);
  const view = app.editor();
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n## Notes\n" }, userEvent: "input.type" });
  await app.until(() => rows().length === 3);
  assert.deepEqual(rows(), ["Book", "Engine", "Notes"]);
});

test("clicking an outline row scrolls the editor to the heading", () => {
  const view = app.editor();
  const dispatched = [];
  const dispatch = view.dispatch;
  view.dispatch = (...args) => {
    dispatched.push(args[0]);
    return dispatch.apply(view, args);
  };
  try {
    document.querySelectorAll("#outline-list .outline-link")[1].click();
  } finally {
    delete view.dispatch;
  }
  assert.equal(dispatched.length, 1);
  assert.ok(dispatched[0].effects, "the jump scrolls the heading into view");
});

test("switching notes swaps the outline and a note without headings hides it", async () => {
  document.querySelector('.note-item[data-id="plain"]').click();
  await app.until(() => $("outline-section").hidden);
  assert.equal($("outline-section").hidden, true);
  document.querySelector('.note-item[data-id="book"]').click();
  await app.until(() => !$("outline-section").hidden);
  assert.deepEqual(rows(), ["Book", "Engine", "Notes"]);
});
