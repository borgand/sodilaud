// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";

// Linux and Windows keep the native title bar: no inset, no drag region.
test("Linux keeps the native title bar layout and still names the window after the file", async () => {
  const titles = [];
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    disk: { "/book/01.md": "# One\n" },
    windowApi: {
      getCurrentWindow: () => ({ label: "main", onCloseRequested: async () => () => {}, setTitle: async (text) => { titles.push(text); } })
    },
    handlers: {
      qn_get_config: () => ({ hotkey: "ctrl+shift+KeyN", requested: "ctrl+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: ["/book/01.md"], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => [],
      main_window_name: () => null
    }
  });
  const doc = app.dom.window.document;
  assert.ok(!doc.documentElement.classList.contains("platform-mac"));
  assert.equal(doc.querySelectorAll("[data-tauri-drag-region]").length, 0);
  [...doc.querySelectorAll(".open-file-name")].find((button) => button.textContent.startsWith("01.md")).click();
  await until(() => titles.at(-1) === "01.md");
  assert.equal(titles.at(-1), "01.md");
});
