// SPDX-License-Identifier: GPL-3.0-or-later

// CodeMirror picks Cmd or Ctrl once per process, so Linux gets its own file.

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

test("Ctrl+\\ toggles split view off macOS and the button names Ctrl", async () => {
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    disk: { "/d/a.md": "alpha\n", "/d/b.md": "beta\n" },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: ["/d/a.md", "/d/b.md"], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => []
    }
  });
  const doc = app.dom.window.document;
  const wrapper = doc.getElementById("secondary-editor-wrapper");
  const button = doc.getElementById("split-file-btn");
  const keydown = (init, target = app.editor().contentDOM) => {
    const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(button.title, "Split View (Ctrl+\\)");

  // The editor's own Ctrl+Alt+\ indents the selection, so these go to the page.
  assert.equal(keydown({ key: "\\", code: "Backslash", metaKey: true }, doc.body).defaultPrevented, false);
  assert.equal(wrapper.hidden, true);
  assert.equal(keydown({ key: "\\", code: "Backslash", ctrlKey: true, altKey: true }, doc.body).defaultPrevented, false);
  assert.equal(wrapper.hidden, true);

  assert.equal(keydown({ key: "\\", code: "Backslash", ctrlKey: true }).defaultPrevented, true);
  assert.equal(wrapper.hidden, false);
  assert.equal(keydown({ key: "\\", code: "Backslash", ctrlKey: true }).defaultPrevented, true);
  assert.equal(wrapper.hidden, true);

  app.click("mode-reading");
  assert.equal(button.title, "Split view works in Live and Source");
  app.click("mode-live");
  assert.equal(button.title, "Split View (Ctrl+\\)");
});
