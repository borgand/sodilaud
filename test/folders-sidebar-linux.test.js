// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";
import { folderHandlers } from "./helpers/folder-fakes.js";

// CodeMirror picks Cmd or Ctrl once per process, so Linux gets its own file.
test("Ctrl+Shift+O opens the folder dialog on Linux, Cmd+Shift+O does not", async () => {
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    handlers: folderHandlers({ folders: { "/r": [] } })
  });
  const doc = app.dom.window.document;
  const press = (init) => {
    const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "O", code: "KeyO", shiftKey: true, ...init });
    doc.dispatchEvent(event);
    return event;
  };
  const opened = () => app.invocations.filter((call) => call.command === "folder_open_dialog").length;
  press({ metaKey: true });
  await app.settle();
  assert.equal(opened(), 0);
  assert.equal(press({ ctrlKey: true }).defaultPrevented, true);
  await app.settle();
  assert.equal(opened(), 1);
  assert.equal(doc.getElementById("menu-open-folder-btn").title, "Open Folder (Ctrl+Shift+O)");
  const shortcuts = doc.getElementById("pane-shortcuts").textContent.replace(/\s+/g, " ");
  assert.match(shortcuts, /Open Folder Ctrl\+Shift\+O/);
});
