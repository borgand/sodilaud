// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

// CodeMirror picks Cmd or Ctrl once per process, so Linux gets its own file.
test("Ctrl+Alt+M comments on Linux and Windows", async () => {
  const path = "/docs/notes.md";
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    disk: { [path]: "alpha beta\n" },
    handlers: {
      qn_get_config: () => ({ hotkey: "ctrl+shift+KeyN", requested: "ctrl+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: [path], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => []
    }
  });
  await app.settle();
  const view = app.editor();
  view.dispatch({ selection: { anchor: 6, head: 10 } });
  const press = init => view.contentDOM.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  press({ key: "m", metaKey: true, altKey: true });
  await app.settle();
  assert.equal(app.dom.window.document.querySelector(".cm-comment-composer"), null, "Meta is not Mod here");
  press({ key: "m", ctrlKey: true, altKey: true });
  await app.settle();
  assert.ok(app.dom.window.document.querySelector(".cm-comment-composer"));
  app.click("comments-count-btn");
  await app.settle();
  assert.match(app.dom.window.document.getElementById("comments-panel").textContent, /Ctrl\+Alt\+M/);
});
