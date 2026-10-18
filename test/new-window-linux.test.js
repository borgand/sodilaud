// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";

// CodeMirror picks Cmd or Ctrl once per process, so Linux gets its own file.
test("Ctrl+Alt+N opens a window on Linux and Windows, Cmd+Alt+N does not", async () => {
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    handlers: {
      qn_get_config: () => ({ hotkey: "ctrl+shift+KeyN", requested: "ctrl+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: [], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => [],
      main_window_new: () => "main-2"
    }
  });
  const doc = app.dom.window.document;
  const press = (init) => doc.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "KeyN", key: "n", ...init }));
  const opened = () => app.invocations.filter((call) => call.command === "main_window_new").length;
  press({ metaKey: true, altKey: true });
  await app.settle();
  assert.equal(opened(), 0);
  press({ ctrlKey: true, altKey: true });
  await until(() => opened() === 1);
  assert.equal(opened(), 1);
  assert.equal(doc.getElementById("menu-new-window-btn").title, "New Window (Ctrl+Alt+N)");
  const shortcuts = doc.getElementById("pane-shortcuts").textContent.replace(/\s+/g, " ");
  assert.match(shortcuts, /New Window Ctrl\+Alt\+N/);
});
