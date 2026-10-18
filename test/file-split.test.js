// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const A = "alpha one\n";
const B = "beta two\n";

function boot(instance, { open = ["/d/a.md", "/d/b.md"], disk = {}, handlers = {} } = {}) {
  let listed = open;
  return bootMainWindow({
    instance,
    platform: "MacIntel",
    disk: { "/d/a.md": A, "/d/b.md": B, ...disk },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: listed, recent: [] }),
      file_set_open: ({ paths }) => { listed = paths; },
      file_take_pending: () => [],
      ...handlers
    }
  });
}

const doc = (app) => app.dom.window.document;
const byId = (app, id) => doc(app).getElementById(id);
const fileItem = (app, name) => [...doc(app).querySelectorAll(".open-file-item")]
  .find((item) => item.querySelector(".open-file-name").textContent.replace(" •", "") === name);
const showFile = async (app, name) => {
  fileItem(app, name).querySelector(".open-file-name").click();
  await app.settle();
};
const splitShown = (app) => !byId(app, "secondary-editor-wrapper").hidden;
const choices = (app) => [...byId(app, "secondary-file-select").options].map((option) => option.value);
const choose = async (app, path) => {
  const select = byId(app, "secondary-file-select");
  select.value = path;
  select.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  await app.settle();
};
const keydown = (app, target, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const typeAt = (view, text) => view.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: text.length }, userEvent: "input.type" });
const find = (app, query) => {
  const input = byId(app, "find-input");
  input.value = query;
  input.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
};

async function bootSplit(instance, options) {
  const app = await boot(instance, options);
  await showFile(app, "a.md");
  app.click("split-file-btn");
  await app.settle();
  return app;
}

test("Split View shows another open file on the right", async () => {
  const app = await bootSplit(1);
  assert.equal(splitShown(app), true);
  assert.equal(byId(app, "file-editor").classList.contains("split-mode"), true);
  assert.equal(byId(app, "split-file-btn").getAttribute("aria-pressed"), "true");
  assert.equal(app.editorText("secondary"), B);
  assert.equal(app.editorText("primary"), A);
  assert.equal(byId(app, "secondary-file-select").value, "/d/b.md");

  byId(app, "close-secondary-btn").click();
  await app.settle();
  assert.equal(splitShown(app), false);
  assert.equal(byId(app, "file-editor").classList.contains("split-mode"), false);
  assert.equal(byId(app, "split-file-btn").getAttribute("aria-pressed"), "false");
});

test("an edit on the right reaches the registry and the left when both show one file", async () => {
  const app = await bootSplit(2);
  await choose(app, "/d/a.md");
  assert.equal(app.editorText("secondary"), A);
  typeAt(app.editor("secondary"), "right ");
  await app.until(() => app.fileDocs.text("/d/a.md")?.includes("right "));
  assert.equal(app.fileDocs.text("/d/a.md"), `right ${A}`);
  await app.until(() => app.editorText("primary").includes("right "));
  assert.equal(app.editorText("primary"), `right ${A}`);

  typeAt(app.editor("primary"), "left ");
  await app.until(() => app.editorText("secondary").startsWith("left "));
  assert.equal(app.editorText("secondary"), `left right ${A}`);
  await app.until(() => app.fileDocs.text("/d/a.md") === `left right ${A}`);
  assert.equal(app.fileDocs.text("/d/a.md"), `left right ${A}`);
});

test("the right pane starts from the registry's text while the left still has typing to send", async () => {
  const app = await boot(3);
  await showFile(app, "a.md");
  typeAt(app.editor("primary"), "typed ");
  app.click("split-file-btn");
  await choose(app, "/d/a.md");
  await app.until(() => app.editorText("secondary") === `typed ${A}`);
  assert.equal(app.editorText("secondary"), `typed ${A}`);
  await app.until(() => app.fileDocs.text("/d/a.md") === `typed ${A}`);
  await app.settle(300);
  assert.equal(app.fileDocs.text("/d/a.md"), `typed ${A}`);
  assert.equal(app.editorText("primary"), `typed ${A}`);
});

test("untitled files are not offered on the right", async () => {
  const app = await boot(4);
  app.click("menu-new-file-btn");
  await app.settle();
  app.click("split-file-btn");
  await app.settle();
  assert.deepEqual(choices(app), ["/d/a.md", "/d/b.md"]);
  assert.equal(app.editorText("secondary"), A);
});

test("closing the file shown on the right shows the next one or closes the split", async () => {
  const app = await bootSplit(5);
  assert.equal(byId(app, "secondary-file-select").value, "/d/b.md");
  fileItem(app, "b.md").querySelector(".open-file-close").click();
  await app.until(() => byId(app, "secondary-file-select").value === "/d/a.md");
  assert.equal(splitShown(app), true);
  assert.equal(app.editorText("secondary"), A);
  assert.deepEqual(choices(app), ["/d/a.md"]);

  fileItem(app, "a.md").querySelector(".open-file-close").click();
  await app.until(() => !splitShown(app));
  assert.equal(splitShown(app), false);
  assert.equal(byId(app, "file-editor").classList.contains("split-mode"), false);
  assert.equal(app.editorText("secondary"), "");
});

test("moving the file shown on the right lets go of it there", async () => {
  const app = await bootSplit(6, { handlers: { main_window_list: () => [], main_window_move_file: () => "main-2" } });
  const menu = byId(app, "open-file-menu");
  fileItem(app, "b.md").dispatchEvent(new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
  await app.until(() => !menu.hidden);
  [...menu.querySelectorAll(".context-menu-item")].find((item) => item.textContent.trim().startsWith("Move to New Window")).click();
  await app.until(() => byId(app, "secondary-file-select").value === "/d/a.md");
  assert.equal(app.editorText("secondary"), A);
  assert.deepEqual(choices(app), ["/d/a.md"]);
});

test("plain files stay plain on the right", async () => {
  const app = await boot(7, { open: ["/d/a.md", "/d/c.txt"], disk: { "/d/c.txt": "- a\n" } });
  await showFile(app, "a.md");
  app.click("split-file-btn");
  await app.settle();
  assert.equal(byId(app, "secondary-file-select").value, "/d/c.txt");
  assert.ok(doc(app).querySelector("#secondary-editor-host .cm-editor.cm-plain"));
  await choose(app, "/d/a.md");
  assert.ok(!doc(app).querySelector("#secondary-editor-host .cm-editor.cm-plain"));
});

test("Reading mode closes the split and disables the button", async () => {
  const app = await bootSplit(8);
  const button = byId(app, "split-file-btn");
  assert.equal(button.title, "Split View (Cmd+\\)");
  app.click("mode-reading");
  assert.equal(splitShown(app), false);
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Split view works in Live and Source");
  button.click();
  const event = keydown(app, doc(app).body, { key: "\\", code: "Backslash", metaKey: true });
  assert.equal(event.defaultPrevented, false);
  assert.equal(splitShown(app), false);

  app.click("mode-source");
  assert.equal(button.disabled, false);
  assert.equal(button.title, "Split View (Cmd+\\)");
  button.click();
  assert.equal(splitShown(app), true);
});

test("Cmd+\\ toggles split view", async () => {
  const app = await boot(9);
  await showFile(app, "a.md");
  const content = app.editor().contentDOM;
  const event = keydown(app, content, { key: "\\", code: "Backslash", metaKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(splitShown(app), true);
  assert.equal(keydown(app, content, { key: "|", code: "Backslash", metaKey: true, shiftKey: true }).defaultPrevented, true);
  assert.equal(splitShown(app), false);
  keydown(app, content, { key: "\\", code: "Backslash", ctrlKey: true });
  assert.equal(splitShown(app), false);
});

test("find searches the pane focused last", async () => {
  const app = await bootSplit(10);
  app.editor("secondary").focus();
  await app.settle();
  assert.equal(byId(app, "secondary-editor-wrapper").classList.contains("active-pane"), true);
  assert.equal(byId(app, "editor-wrapper").classList.contains("active-pane"), false);
  keydown(app, app.editor("secondary").contentDOM, { key: "f", code: "KeyF", metaKey: true });
  find(app, "beta");
  assert.equal(byId(app, "find-count").textContent, "1 of 1");
  assert.equal(doc(app).querySelectorAll("#secondary-editor-host .cm-find-match").length, 1);

  app.editor("primary").focus();
  await app.settle();
  assert.equal(byId(app, "editor-wrapper").classList.contains("active-pane"), true);
  assert.equal(byId(app, "find-count").textContent, "0 of 0");
  assert.equal(doc(app).querySelectorAll("#secondary-editor-host .cm-find-match").length, 0);
});
