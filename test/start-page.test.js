// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

test("a fresh main window shows the start page with the Quick Notes hotkey", async () => {
  const app = await bootMainWindow({
    handlers: { qn_get_config: () => ({ hotkey: "super+shift+KeyN", hotkeyError: null }) }
  });
  const doc = app.dom.window.document;

  assert.equal(doc.getElementById("start-page").hidden, false);
  assert.equal(doc.getElementById("quicknotes-hotkey-label").textContent, "⌘⇧N");
  assert.equal(doc.getElementById("start-actions").hidden, true);
  assert.equal(doc.getElementById("recent-files").hidden, true);

  app.click("open-quicknotes-btn");
  app.click("open-welcome-note-link");
  await app.settle();
  const shows = app.invocations.filter((call) => call.command === "qn_show").map((call) => call.args.focusNoteTitle);
  assert.deepEqual(shows, [null, "Welcome to Quick Notes"]);
});
