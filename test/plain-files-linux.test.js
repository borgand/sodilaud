// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const boot = (instance) => bootMainWindow({
  instance,
  platform: "Linux x86_64",
  disk: { "/d/t.tsv": "a\tb\n", "/d/a.txt": "word\n" },
  handlers: {
    qn_get_config: () => ({ hotkey: "ctrl+shift+KeyN", requested: "ctrl+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open: ["/d/t.tsv", "/d/a.txt"], recent: [] }),
    file_set_open: () => null,
    file_take_pending: () => []
  }
});

const keydown = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  app.editor().contentDOM.dispatchEvent(event);
  return event;
};

test("Tab in a .tsv inserts a tab character", async () => {
  const app = await boot(21);
  app.dom.window.document.querySelector(".open-file-name").click();
  await app.settle();
  app.editor().dispatch({ selection: { anchor: 4 } });
  const event = keydown(app, { key: "Tab" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.editorText(), "a\tb\n\t");
});

test("Ctrl+B does nothing in a plain file", async () => {
  const app = await boot(22);
  const names = [...app.dom.window.document.querySelectorAll(".open-file-name")];
  names.find((node) => node.textContent === "a.txt").click();
  await app.settle();
  app.editor().dispatch({ selection: { anchor: 0, head: 4 } });
  keydown(app, { key: "b", code: "KeyB", ctrlKey: true });
  assert.equal(app.editorText(), "word\n");
});
