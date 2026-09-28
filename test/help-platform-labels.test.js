// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

test("off macOS the help reference names Ctrl shortcuts", async () => {
  const app = await bootMainWindow({ platform: "Win32" });
  const shortcuts = app.dom.window.document.getElementById("pane-shortcuts").textContent.replace(/\s+/g, " ");
  assert.match(shortcuts, /Toggle Sidebar Ctrl\+Alt\+S/);
  assert.doesNotMatch(shortcuts, /Cmd\+/);
});
