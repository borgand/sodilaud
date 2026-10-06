// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const status = (overrides = {}) => ({
  hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false, ...overrides
});

test("an upgrading user sees the banner once; Open dismisses it and shows Quick Notes", async () => {
  const app = await bootMainWindow({ handlers: { qn_get_config: () => status({ upgradeIntro: true }) } });
  const { document } = app.dom.window;
  const banner = document.getElementById("upgrade-banner");
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Your notes moved to Quick Notes \(⌘⇧N\)/);

  app.click("upgrade-banner-open-btn");
  await app.settle();
  assert.equal(banner.hidden, true);
  assert.equal(app.invocations.filter(call => call.command === "qn_dismiss_intro").length, 1);
  assert.ok(app.invocations.some(call => call.command === "qn_show"));
});

test("a fresh install shows no banner", async () => {
  const app = await bootMainWindow({ instance: 2, handlers: { qn_get_config: () => status() } });
  assert.equal(app.dom.window.document.getElementById("upgrade-banner").hidden, true);
});

test("the hotkey is recorded from the keyboard and a taken one shows an inline error", async () => {
  let current = "super+shift+KeyN";
  const app = await bootMainWindow({
    instance: 3,
    platform: "MacIntel",
    handlers: {
      qn_get_config: () => status(),
      qn_set_hotkey: ({ hotkey }) => {
        if (hotkey === "super+shift+KeyV") return status({ hotkey: current, requested: hotkey, hotkeyError: "HotkeyUnavailable" });
        current = hotkey;
        return status({ hotkey, requested: hotkey });
      }
    }
  });
  const { document, KeyboardEvent } = app.dom.window;
  const button = document.getElementById("quicknotes-hotkey-btn");
  const press = (init) => button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  button.click();
  assert.equal(button.textContent, "Press keys…");
  press({ key: "q", code: "KeyQ", metaKey: true, altKey: true });
  await app.settle();
  assert.deepEqual(app.invocations.findLast(call => call.command === "qn_set_hotkey").args, { hotkey: "super+alt+KeyQ" });
  assert.equal(button.textContent, "⌥⌘Q");
  assert.equal(document.getElementById("quicknotes-hotkey-label").textContent, "⌥⌘Q");

  button.click();
  press({ key: "v", code: "KeyV", metaKey: true, shiftKey: true });
  await app.settle();
  assert.equal(button.textContent, "⌥⌘Q", "the previous hotkey stays active");
  assert.match(document.getElementById("quicknotes-hotkey-status").textContent, /already in use/);

  button.click();
  press({ key: "Escape", code: "Escape" });
  assert.equal(button.textContent, "⌥⌘Q");

  app.click("quicknotes-hotkey-reset-btn");
  await app.settle();
  assert.deepEqual(app.invocations.findLast(call => call.command === "qn_set_hotkey").args, { hotkey: "super+shift+KeyN" });
});

test("the panel can open help or settings here", async () => {
  const app = await bootMainWindow({
    instance: 4,
    handlers: { qn_get_config: () => status() }
  });
  const { document } = app.dom.window;
  await app.emit("sodilaud-open-section", "help");
  assert.equal(document.getElementById("help-modal-backdrop").style.display, "flex");
  document.getElementById("close-help-btn").click();
  await app.emit("sodilaud-open-section", "settings");
  assert.equal(document.getElementById("actions-dropdown-content").classList.contains("show"), true);
});

test("the main window answers a quit request", async () => {
  const app = await bootMainWindow({ instance: 5, handlers: { qn_get_config: () => status() } });
  assert.ok(app.invocations.some(call => call.command === "quit_handler_ready"));
  await app.emit("sodilaud-quit-requested");
  await app.settle();
  assert.deepEqual(app.invocations.filter(call => call.command === "quit_window_done").map(call => call.args), [{ ok: true }]);
});
