// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const TEXT = "one two one\n";

const boot = (instance, open = ["/d/a.md"]) => bootMainWindow({
  instance,
  platform: "MacIntel",
  disk: { "/d/a.md": TEXT, "/d/b.md": "one\n" },
  beforeBoot: (dom) => { dom.window.marked = marked; },
  handlers: {
    qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open, recent: [] }),
    file_set_open: () => null,
    file_take_pending: () => []
  }
});

const doc = (app) => app.dom.window.document;
const keydown = (app, target, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const inEditor = (app, init) => keydown(app, app.editor().contentDOM, init);
const barOpen = (app) => doc(app).getElementById("find-bar").style.display === "flex";
const find = (app, query) => {
  const input = doc(app).getElementById("find-input");
  input.value = query;
  input.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
};
const count = (app) => doc(app).getElementById("find-count").textContent;
const selectionStart = (app) => app.editor().state.selection.main.from;

test("Cmd+F opens the find bar and counts matches in the file", async () => {
  const app = await boot(1);
  const event = inEditor(app, { key: "f", code: "KeyF", metaKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(barOpen(app), true);
  assert.ok(doc(app).activeElement === doc(app).getElementById("find-input"));
  find(app, "one");
  assert.equal(count(app), "1 of 2");
});

test("Enter and Shift+Enter move between matches", async () => {
  const app = await boot(2);
  inEditor(app, { key: "f", code: "KeyF", metaKey: true });
  find(app, "one");
  const input = doc(app).getElementById("find-input");
  keydown(app, input, { key: "Enter" });
  assert.equal(selectionStart(app), 8);
  assert.equal(count(app), "2 of 2");
  keydown(app, input, { key: "Enter", shiftKey: true });
  assert.equal(selectionStart(app), 0);
  assert.equal(count(app), "1 of 2");
});

test("Replace All changes every match in one undo step and saves", async () => {
  const { undo } = await import("../src/vendor/codemirror.js");
  const app = await boot(3);
  inEditor(app, { key: "ƒ", code: "KeyF", metaKey: true, altKey: true });
  find(app, "one");
  doc(app).getElementById("replace-input").value = "1";
  doc(app).getElementById("replace-all-btn").click();
  assert.equal(app.editorText(), "1 two 1\n");
  assert.equal(count(app), "0 of 0");
  await app.until(() => app.fileDocs.text("/d/a.md") === "1 two 1\n");
  assert.equal(app.fileDocs.text("/d/a.md"), "1 two 1\n");
  assert.equal(undo(app.editor()), true);
  assert.equal(app.editorText(), TEXT);
  assert.equal(count(app), "1 of 2");
});

test("Replace changes the current match and moves to the next one", async () => {
  const app = await boot(4);
  inEditor(app, { key: "ƒ", code: "KeyF", metaKey: true, altKey: true });
  find(app, "one");
  doc(app).getElementById("replace-input").value = "1";
  doc(app).getElementById("replace-one-btn").click();
  assert.equal(app.editorText(), "1 two one\n");
  assert.equal(count(app), "1 of 1");
  const { from, to } = app.editor().state.selection.main;
  assert.equal(app.editorText().slice(from, to), "one");
  assert.equal(from, 6);
});

test("Cmd+Alt+F opens the replace row even when Option+F is a dead key", async () => {
  const app = await boot(5);
  const event = inEditor(app, { key: "ƒ", code: "KeyF", metaKey: true, altKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(barOpen(app), true);
  assert.equal(doc(app).getElementById("replace-row").style.display, "flex");
  assert.ok(doc(app).activeElement === doc(app).getElementById("replace-input"));
});

test("Escape closes the bar and returns focus to the editor", async () => {
  const app = await boot(6);
  inEditor(app, { key: "f", code: "KeyF", metaKey: true });
  find(app, "one");
  keydown(app, doc(app).getElementById("find-input"), { key: "Escape" });
  assert.equal(barOpen(app), false);
  assert.ok(doc(app).activeElement === app.editor().contentDOM);
  assert.equal(doc(app).querySelectorAll("#editor-host .cm-find-match").length, 0);

  // Escape from elsewhere in the bar goes through the window's Escape handling.
  inEditor(app, { key: "f", code: "KeyF", metaKey: true });
  const next = doc(app).getElementById("find-next");
  next.focus();
  const event = keydown(app, next, { key: "Escape" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(barOpen(app), false);
  assert.ok(doc(app).activeElement === app.editor().contentDOM);
});

test("Reading mode highlights matches in the preview", async () => {
  const app = await boot(7);
  app.click("mode-reading");
  keydown(app, doc(app), { key: "f", code: "KeyF", metaKey: true });
  find(app, "one");
  assert.equal(doc(app).querySelectorAll("#markdown-preview .find-preview-match").length, 2);
  assert.equal(doc(app).querySelectorAll("#markdown-preview .find-preview-match.active-match").length, 1);
  keydown(app, doc(app).getElementById("find-input"), { key: "Escape" });
  assert.equal(doc(app).querySelectorAll("#markdown-preview .find-preview-match").length, 0);
});

test("find does nothing on the start page", async () => {
  const app = await boot(8, []);
  assert.equal(doc(app).getElementById("start-page").hidden, false);
  const event = keydown(app, doc(app).body, { key: "f", code: "KeyF", metaKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(barOpen(app), false);
  keydown(app, doc(app).body, { key: "ƒ", code: "KeyF", metaKey: true, altKey: true });
  assert.equal(barOpen(app), false);
});

test("the help lists Find and Find and Replace for files", async () => {
  const app = await boot(9);
  const rows = [...doc(app).querySelectorAll("#pane-shortcuts .shortcut-row")]
    .map((row) => row.textContent.replace(/\s+/g, " ").trim());
  assert.ok(rows.includes("Find Cmd+F"), rows.join(" | "));
  assert.ok(rows.includes("Find and Replace Cmd+Alt+F"), rows.join(" | "));
  assert.equal(doc(app).getElementById("find-toggle-replace").title, "Toggle Replace (Cmd+Alt+F)");
});

test("an edit from another client updates the open bar's count", async () => {
  const app = await boot(10);
  inEditor(app, { key: "f", code: "KeyF", metaKey: true });
  find(app, "one");
  app.fileDocs.agentEdit("/d/a.md", [[0, "one "], TEXT.length]);
  await app.until(() => app.editorText() === `one ${TEXT}`);
  assert.equal(app.editorText(), `one ${TEXT}`);
  assert.equal(count(app), "1 of 3");
});

test("switching files searches the file now shown", async () => {
  const app = await boot(11, ["/d/a.md", "/d/b.md"]);
  const show = async (name) => {
    [...doc(app).querySelectorAll(".open-file-name")].find((node) => node.textContent === name).click();
    await app.settle();
  };
  await show("a.md");
  inEditor(app, { key: "f", code: "KeyF", metaKey: true });
  find(app, "one");
  assert.equal(count(app), "1 of 2");
  await show("b.md");
  assert.equal(count(app), "1 of 1");
  assert.equal(doc(app).querySelectorAll("#editor-host .cm-find-match").length, 1);
  await show("a.md");
  assert.equal(count(app), "1 of 2");
  assert.equal(doc(app).querySelectorAll("#editor-host .cm-find-match").length, 2);
});
