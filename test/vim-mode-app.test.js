// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootApp, bootMainWindow } from "./helpers/app-harness.js";

const PATH = "/d/t.md";
const T = "intro text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter";

const handlers = {
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
  file_lists: () => ({ open: [PATH], recent: [] }),
  file_set_open: () => null,
  file_take_pending: () => []
};

const keydown = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  app.editor().contentDOM.dispatchEvent(event);
  return event;
};
const indicator = app => app.dom.window.document.getElementById("vim-mode-indicator").textContent;
const vimOn = app => Boolean(app.editor().cm);

let boots = 0;
function bootFile(storage = {}) {
  return bootMainWindow({
    platform: "MacIntel",
    storage,
    instance: (boots += 1),
    disk: { [PATH]: T },
    beforeBoot: dom => { dom.window.marked = marked; },
    handlers
  });
}

test("the Vim keys toggle is off by default and turns Vim on in the open file", async () => {
  const app = await bootFile();
  const { document } = app.dom.window;
  await app.settle();
  const toggle = document.getElementById("vim-mode-toggle");
  assert.equal(toggle.textContent, "Off");
  assert.equal(vimOn(app), false);
  assert.equal(document.documentElement.classList.contains("editor-vim-enabled"), false);

  document.getElementById("actions-btn").click();
  toggle.click();
  assert.equal(toggle.textContent, "On");
  assert.equal(app.storage.getItem("sodilaud_editor_vim_mode"), "true");
  assert.equal(document.documentElement.classList.contains("editor-vim-enabled"), true);
  assert.equal(vimOn(app), true);
  assert.equal(indicator(app), "NORMAL");
  await app.settle();
  assert.ok(app.emitted.some(event => event.name === "prefs-changed" && event.payload.key === "sodilaud_editor_vim_mode"));

  app.editor().focus();
  keydown(app, { key: "i" });
  assert.equal(indicator(app), "INSERT");

  toggle.click();
  assert.equal(vimOn(app), false);
  assert.equal(document.documentElement.classList.contains("editor-vim-enabled"), false);
});

test("app shortcuts work in normal mode", async () => {
  const app = await bootFile({ sodilaud_editor_vim_mode: "true" });
  const { document } = app.dom.window;
  await app.settle();
  const view = app.editor();
  assert.equal(vimOn(app), true);
  view.focus();

  view.dispatch({ selection: { anchor: 0, head: 5 } });
  keydown(app, { key: "m", metaKey: true, altKey: true });
  await app.settle();
  assert.ok(document.querySelector(".cm-comment-composer textarea"), "Cmd+Alt+M opens the comment composer");
  document.querySelector(".cm-comment-composer textarea").dispatchEvent(
    new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
  );
  await app.settle();

  view.focus();
  keydown(app, { key: "f", code: "KeyF", metaKey: true });
  assert.equal(document.getElementById("find-bar").style.display, "flex", "Cmd+F opens the find bar");
  assert.equal(view.state.doc.toString(), T);
});

test("in a table cell, Escape first leaves insert mode, then the table", async () => {
  const app = await bootFile({ sodilaud_editor_vim_mode: "true" });
  await app.settle();
  const view = app.editor();
  const { gridTable } = await import("../src/editor-table-grid.js");
  view.focus();
  view.dispatch({ selection: { anchor: T.indexOf("1 |") + 1 } });
  await app.settle();
  assert.ok(gridTable(view.state));

  keydown(app, { key: "i" });
  assert.equal(indicator(app), "INSERT");
  keydown(app, { key: "Escape" });
  await app.settle();
  assert.equal(indicator(app), "NORMAL");
  assert.ok(gridTable(view.state), "the caret stays in the cell");

  keydown(app, { key: "Escape" });
  await app.settle();
  assert.equal(gridTable(view.state), null, "Escape in normal mode leaves the table");
  assert.equal(view.state.doc.toString(), T);
});

test("Quick Notes follows the main window's Vim keys setting", async () => {
  const app = await bootApp({
    instance: 99,
    registry: { seed: { notes: [{ id: "a", title: "Note", content: "abc", updatedAt: 1, isTitleLocked: false }], imported: true } }
  });
  const { document } = app.dom.window;
  assert.equal(document.getElementById("vim-mode-toggle"), null, "the toggle lives in the main window");
  assert.equal(vimOn(app), false);

  app.storage.setItem("sodilaud_editor_vim_mode", "true");
  await app.emit("prefs-changed", { key: "sodilaud_editor_vim_mode", source: "main" });
  assert.equal(vimOn(app), true);
  assert.ok(app.editor("secondary").cm, "the right pane edits with Vim too");
  assert.equal(indicator(app), "NORMAL");

  const view = app.editor();
  view.focus();
  view.dispatch({ selection: { anchor: 0 } });
  keydown(app, { key: "x" });
  assert.equal(app.editorText(), "bc");

  app.storage.setItem("sodilaud_editor_vim_mode", "false");
  await app.emit("prefs-changed", { key: "sodilaud_editor_vim_mode", source: "main" });
  assert.equal(vimOn(app), false);
});
