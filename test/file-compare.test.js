// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";
import { COMPARE_DELAY_MS } from "../src/pane-compare.js";

const A = "one\ntwo\n";
const B = "one\n2\n";

function boot(instance, { open = ["/d/a.md", "/d/b.md"], disk = {} } = {}) {
  let listed = open;
  return bootMainWindow({
    instance,
    platform: "MacIntel",
    disk: { "/d/a.md": A, "/d/b.md": B, ...disk },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: listed, recent: [] }),
      file_set_open: ({ paths }) => { listed = paths; },
      file_take_pending: () => []
    }
  });
}

const doc = (app) => app.dom.window.document;
const byId = (app, id) => doc(app).getElementById(id);
const count = (app, selector) => doc(app).querySelectorAll(selector).length;
const removed = (app) => count(app, "#editor-host .cm-lineNumbers .cm-gutterElement.cm-diff-line-removed");
const added = (app) => count(app, "#secondary-editor-host .cm-lineNumbers .cm-gutterElement.cm-diff-line-added");
const showFile = async (app, name) => {
  [...doc(app).querySelectorAll(".open-file-item .open-file-name")]
    .find((item) => item.textContent.replace(" •", "") === name).click();
  await app.settle();
};
const choose = async (app, path) => {
  const select = byId(app, "secondary-file-select");
  select.value = path;
  select.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  await app.settle();
};
const typeAt = (view, from, text) => view.dispatch({ changes: { from, insert: text }, userEvent: "input.type" });

async function bootCompare(instance, options) {
  const app = await boot(instance, options);
  await showFile(app, "a.md");
  app.click("split-file-btn");
  await app.settle();
  return app;
}

test("Compare highlights the differences between the two files", async () => {
  const app = await bootCompare(1);
  const button = byId(app, "compare-files-btn");
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(removed(app), 0);

  button.click();
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(byId(app, "file-editor").classList.contains("compare-mode"), true);
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");
  assert.ok(removed(app) > 0);
  assert.ok(added(app) > 0);

  button.click();
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(byId(app, "file-editor").classList.contains("compare-mode"), false);
  assert.equal(byId(app, "compare-files-count").textContent, "");
  assert.equal(count(app, ".cm-diff-line-removed, .cm-diff-line-added"), 0);
});

test("an edit recomputes after the delay", async () => {
  const app = await bootCompare(2);
  byId(app, "compare-files-btn").click();
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");

  typeAt(app.editor("secondary"), 0, "zero\n");
  assert.equal(byId(app, "compare-files-count").textContent, "Updating comparison…");
  await app.settle(COMPARE_DELAY_MS + 50);
  assert.equal(byId(app, "compare-files-count").textContent, "2 changed lines");
  assert.equal(added(app), 2);

  typeAt(app.editor("primary"), 0, "zero\n");
  await app.settle(COMPARE_DELAY_MS + 50);
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");
  assert.equal(removed(app), 1);
});

test("an edit from outside recomputes the comparison", async () => {
  const app = await bootCompare(3);
  byId(app, "compare-files-btn").click();
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");

  app.fileDocs.agentEdit("/d/b.md", [4, [1, "two"], 1]);
  await app.until(() => app.editorText("secondary") === A);
  await app.settle(COMPARE_DELAY_MS + 50);
  assert.equal(byId(app, "compare-files-count").textContent, "No differences");
  assert.equal(count(app, ".cm-diff-line-removed, .cm-diff-line-added"), 0);
});

test("Compare is hidden when both panes show the same file and off when split closes", async () => {
  const app = await bootCompare(4, { open: ["/d/a.md", "/d/b.md", "/d/c.md"], disk: { "/d/c.md": "one\ntwo\nthree\n" } });
  const button = byId(app, "compare-files-btn");
  button.click();
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");

  await choose(app, "/d/c.md");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");
  assert.equal(added(app), 1);
  assert.equal(removed(app), 0);

  await choose(app, "/d/a.md");
  assert.equal(button.hidden, true);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(count(app, ".cm-diff-line-removed, .cm-diff-line-added"), 0);

  await choose(app, "/d/b.md");
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  button.click();
  assert.ok(removed(app) > 0);
  typeAt(app.editor("primary"), 0, "pending ");
  byId(app, "close-secondary-btn").click();
  await app.settle(COMPARE_DELAY_MS + 50);
  assert.equal(button.hidden, true);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(byId(app, "file-editor").classList.contains("compare-mode"), false);
  assert.equal(count(app, ".cm-diff-line-removed, .cm-diff-line-added"), 0);
});

test("showing another file on the left recomputes the comparison", async () => {
  const app = await bootCompare(5, { open: ["/d/a.md", "/d/b.md", "/d/c.md"], disk: { "/d/c.md": "one\n2\nthree\n" } });
  byId(app, "compare-files-btn").click();
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");
  await showFile(app, "c.md");
  assert.equal(byId(app, "compare-files-btn").getAttribute("aria-pressed"), "true");
  assert.equal(byId(app, "compare-files-count").textContent, "1 changed line");
  assert.equal(removed(app), 1);
  assert.equal(added(app), 0);

  byId(app, "close-secondary-btn").click();
  await showFile(app, "a.md");
  assert.equal(count(app, ".cm-diff-line-removed, .cm-diff-line-added"), 0, "a file shown again keeps no old marks");
});
