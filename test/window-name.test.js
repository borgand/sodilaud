// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";

function boot(instance, { name = null, setName } = {}) {
  let current = name;
  return bootMainWindow({
    instance,
    platform: "MacIntel",
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: [], recent: [] }),
      main_window_name: () => current,
      main_window_set_name: setName ?? (({ name }) => { current = name.trim() || null; return current; })
    }
  });
}

const doc = (app) => app.dom.window.document;
const byId = (app, id) => doc(app).getElementById(id);
const shown = (app) => byId(app, "window-name-modal-backdrop").style.display !== "none";
const calls = (app, command) => app.invocations.filter((call) => call.command === command);

test("Name Window opens with the current name and saves a new one", async () => {
  const app = await boot(1, { name: "Book" });
  app.click("menu-name-window-btn");
  await until(() => shown(app));
  const input = byId(app, "window-name-input");
  assert.equal(input.value, "Book");
  assert.ok(doc(app).activeElement === input);
  input.value = "Review feat/x";
  byId(app, "window-name-form").dispatchEvent(new app.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => !shown(app));
  assert.deepEqual(calls(app, "main_window_set_name").at(-1).args, { name: "Review feat/x" });
});

test("a refused name keeps the dialog open with the reason", async () => {
  const app = await boot(2, { setName: () => { throw { message: "Another window is named \"Book\"." }; } });
  app.click("menu-name-window-btn");
  await until(() => shown(app));
  byId(app, "window-name-input").value = "book";
  byId(app, "window-name-save-btn").click();
  await until(() => byId(app, "window-name-error").textContent !== "");
  assert.equal(byId(app, "window-name-error").textContent, "Another window is named \"Book\".");
  assert.equal(shown(app), true);
});

test("Escape and Cancel close the dialog without saving", async () => {
  const app = await boot(3);
  app.click("menu-name-window-btn");
  await until(() => shown(app));
  assert.equal(byId(app, "window-name-input").value, "");
  byId(app, "window-name-input").dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(shown(app), false);
  app.click("menu-name-window-btn");
  await until(() => shown(app));
  byId(app, "window-name-cancel-btn").click();
  assert.equal(shown(app), false);
  assert.equal(calls(app, "main_window_set_name").length, 0);
});
