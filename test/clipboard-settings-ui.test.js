// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

const ok = (config) => ({ enabled: config.enabled, hotkey: config.hotkey, hotkeyError: null, accessibilityTrusted: false });

test("macOS shows the section, pushes stored settings at startup, and toggles", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: false, capacity: 99, ttlMinutes: 5, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const doc = app.dom.window.document;
  assert.equal(doc.getElementById("clipboard-history-menu-section").hidden, false);
  const startup = app.invocations.find(i => i.command === "clip_set_config");
  assert.deepEqual(startup.args.config, { enabled: false, capacity: 50, ttlMinutes: 5, hotkey: "super+shift+KeyV", autoPaste: false });

  app.click("clipboard-history-toggle-btn");
  await settle();
  assert.equal(app.invocations.findLast(i => i.command === "clip_set_config").args.config.enabled, true);
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).enabled, true);
  assert.equal(doc.getElementById("clipboard-history-toggle-btn").getAttribute("aria-pressed"), "true");
});

test("a rejected hotkey keeps the previous one and shows an error", async () => {
  const app = await bootApp({
    instance: 2,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: true, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => config.hotkey === "super+KeyB"
      ? { enabled: true, hotkey: "super+shift+KeyV", hotkeyError: "HotkeyUnavailable", accessibilityTrusted: false }
      : ok(config) }
  });
  const { document, KeyboardEvent } = app.dom.window;
  app.click("clipboard-settings-btn");
  app.click("clipboard-hotkey-btn");
  document.getElementById("clipboard-hotkey-btn").dispatchEvent(new KeyboardEvent("keydown", { metaKey: true, code: "KeyB", key: "b", bubbles: true }));
  await settle();
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).hotkey, "super+shift+KeyV");
  assert.equal(document.getElementById("clipboard-hotkey-btn").textContent, "⌘⇧V");
  assert.match(document.getElementById("clipboard-settings-status").textContent, /already in use/i);
});

test("auto-paste without Accessibility shows the grant row", async () => {
  const app = await bootApp({
    instance: 3,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  app.click("clipboard-settings-btn");
  app.click("clipboard-autopaste-toggle-btn");
  await settle();
  assert.equal(app.dom.window.document.getElementById("clipboard-accessibility-row").hidden, false);
  app.click("clipboard-accessibility-open-btn");
  await settle();
  assert.ok(app.invocations.some(i => i.command === "open_accessibility_settings"));
});

test("an unexpected stop turns the feature off and says so", async () => {
  const app = await bootApp({
    instance: 4,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: true, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  await app.emit("clipboard-history-stopped");
  await settle();
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).enabled, false);
  assert.match(app.dom.window.document.getElementById("clipboard-settings-status").textContent, /stopped unexpectedly/i);
});

test("other platforms hide the section and never call clipboard commands", async () => {
  const app = await bootApp({ instance: 5, platform: "Linux x86_64" });
  assert.equal(app.dom.window.document.getElementById("clipboard-history-menu-section").hidden, true);
  assert.ok(!app.invocations.some(i => i.command === "clip_set_config"));
});
