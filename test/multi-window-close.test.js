// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";

function lists({ open = [], recent = [] } = {}) {
  return {
    qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open, recent }),
    file_set_open: ({ paths }) => { open = paths; },
    file_take_pending: () => []
  };
}

const doc = (app) => app.dom.window.document;
const key = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  doc(app).dispatchEvent(event);
  return event;
};
const typeAt = (app, from, insert) => app.editor().dispatch({ changes: { from, insert }, userEvent: "input.type" });
const closeDone = (app) => app.invocations.filter((call) => call.command === "main_window_close_done");

test("a close request saves the window's files and answers Rust", async () => {
  const app = await bootMainWindow({
    label: "main-2",
    platform: "MacIntel",
    disk: { "/docs/a.md": "a" },
    handlers: lists({ open: ["/docs/a.md"] })
  });
  typeAt(app, 1, "!");
  await app.emit("main-window-close-requested");
  await until(() => closeDone(app).length > 0);
  const saved = app.invocations.findIndex((call) => call.command === "file_doc_save" && call.args.path === "/docs/a.md");
  const done = app.invocations.findIndex((call) => call.command === "main_window_close_done");
  assert.ok(saved >= 0 && saved < done, "the file is saved before the window answers");
  assert.deepEqual(closeDone(app).map((call) => call.args), [{ ok: true }]);
  assert.equal(app.fileDocs.files.get("/docs/a.md"), "a!");
});

test("cancelling the unsaved-file question keeps the window open", async () => {
  const app = await bootMainWindow({
    instance: 2,
    label: "main-2",
    platform: "MacIntel",
    handlers: { ...lists(), file_confirm_discard: () => "cancel" }
  });
  key(app, { key: "n", code: "KeyN", metaKey: true });
  await app.settle();
  await app.type("draft");
  await app.emit("main-window-close-requested");
  await until(() => closeDone(app).length > 0);
  assert.deepEqual(closeDone(app).map((call) => call.args), [{ ok: false }]);
  assert.match(doc(app).getElementById("main-title").textContent, /^Untitled\.md/);
});

test("a failed save keeps the window open and says why", async () => {
  const app = await bootMainWindow({
    instance: 3,
    label: "main-2",
    platform: "MacIntel",
    disk: { "/docs/a.md": "a" },
    handlers: lists({ open: ["/docs/a.md"] })
  });
  app.fileDocs.failWrites("disk full");
  typeAt(app, 1, "!");
  await app.emit("main-window-close-requested");
  await until(() => closeDone(app).length > 0);
  assert.deepEqual(closeDone(app).map((call) => call.args), [{ ok: false }]);
  assert.equal(doc(app).getElementById("app-notification").textContent, "Could not save every file; the window stays open.");
});
