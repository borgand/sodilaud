// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const boot = (instance) => bootMainWindow({
  instance,
  platform: "Linux x86_64",
  disk: { "/d/a.txt": "one two one\n" },
  handlers: {
    qn_get_config: () => ({ hotkey: "ctrl+shift+KeyN", requested: "ctrl+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open: ["/d/a.txt"], recent: [] }),
    file_set_open: () => null,
    file_take_pending: () => []
  }
});

const doc = (app) => app.dom.window.document;
const keydown = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  app.editor().contentDOM.dispatchEvent(event);
  return event;
};
const barOpen = (app) => doc(app).getElementById("find-bar").style.display === "flex";
const replaceOpen = (app) => doc(app).getElementById("replace-row").style.display === "flex";

test("Ctrl+F opens the find bar in a plain text file", async () => {
  const app = await boot(1);
  const event = keydown(app, { key: "f", code: "KeyF", ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(barOpen(app), true);
  assert.equal(replaceOpen(app), false);
  const input = doc(app).getElementById("find-input");
  input.value = "one";
  input.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  assert.equal(doc(app).getElementById("find-count").textContent, "1 of 2");
});

test("Ctrl+H opens the replace row", async () => {
  const app = await boot(2);
  const event = keydown(app, { key: "h", code: "KeyH", ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(barOpen(app), true);
  assert.equal(replaceOpen(app), true);
});

test("AltGr with H is not the replace shortcut", async () => {
  const app = await boot(3);
  keydown(app, { key: "h", code: "KeyH", ctrlKey: true, modifierAltGraph: true });
  assert.equal(barOpen(app), false);
});

test("the help names Ctrl for Find and Find and Replace", async () => {
  const app = await boot(4);
  const rows = [...doc(app).querySelectorAll("#pane-shortcuts .shortcut-row")]
    .map((row) => row.textContent.replace(/\s+/g, " ").trim());
  assert.ok(rows.includes("Find Ctrl+F"), rows.join(" | "));
  assert.ok(rows.includes("Find and Replace Ctrl+H"), rows.join(" | "));
  assert.equal(doc(app).getElementById("find-toggle-replace").title, "Toggle Replace (Ctrl+H)");
});
