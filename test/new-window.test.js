// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";

const handlers = (extra = {}) => ({
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
  file_lists: () => ({ open: [], recent: [] }),
  file_set_open: () => null,
  file_take_pending: () => [],
  main_window_new: () => "main-2",
  ...extra
});
const newWindows = (app) => app.invocations.filter((call) => call.command === "main_window_new");
let instance = 0;
const boot = (extra) => bootMainWindow({ instance: ++instance, platform: "MacIntel", handlers: handlers(extra) });
const press = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  app.dom.window.document.dispatchEvent(event);
  return event;
};

test("New Window in the File menu asks Rust for a window", async () => {
  const app = await boot();
  app.dom.window.document.getElementById("menu-new-window-btn").click();
  await until(() => newWindows(app).length === 1);
  assert.equal(newWindows(app).length, 1);
});

test("Cmd+Alt+N opens a window even when Option+N is a dead key", async () => {
  const app = await boot();
  const event = press(app, { metaKey: true, altKey: true, key: "Dead", code: "KeyN" });
  await until(() => newWindows(app).length === 1);
  assert.equal(newWindows(app).length, 1);
  assert.ok(event.defaultPrevented);
});

test("Cmd+Shift+N is left to the Quick Notes hotkey", async () => {
  const app = await boot();
  press(app, { metaKey: true, shiftKey: true, key: "N", code: "KeyN" });
  await app.settle();
  assert.equal(newWindows(app).length, 0);
});

test("a failed New Window says so", async () => {
  const app = await boot({ main_window_new: () => { throw new Error("no"); } });
  press(app, { metaKey: true, altKey: true, key: "n", code: "KeyN" });
  await until(() => app.dom.window.document.getElementById("app-notification").textContent === "Could not open a new window");
});
