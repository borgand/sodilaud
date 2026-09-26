// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const SETTINGS_KEY = "clipboardHistory.settings";

function assertNotesLoaded(app) {
  assert.ok(app.sidebarTitles().length > 0, "the note list renders");
  assert.notEqual(app.dom.window.document.getElementById("save-status").textContent, "Startup error");
}

test("a full storage neither stops the app from starting nor breaks the settings", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ({ enabled: config.enabled, hotkey: config.enabled ? config.hotkey : "", hotkeyError: null, accessibilityTrusted: false }) },
    beforeBoot: (dom) => {
      const setItem = dom.window.Storage.prototype.setItem;
      dom.window.Storage.prototype.setItem = function (key, value) {
        if (key === SETTINGS_KEY) throw new dom.window.DOMException("full", "QuotaExceededError");
        return setItem.call(this, key, value);
      };
    }
  });
  assertNotesLoaded(app);
  app.click("clipboard-history-toggle-btn");
  await app.settle();
  const toggle = app.dom.window.document.getElementById("clipboard-history-toggle-btn");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.textContent, "On");
});

test("a clipboard event listener that fails to register does not stop the app from starting", async () => {
  const app = await bootApp({
    instance: 2,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ({ enabled: config.enabled, hotkey: "", hotkeyError: null, accessibilityTrusted: false }) },
    beforeBoot: (dom) => {
      const event = dom.window.__TAURI__.event;
      const listen = event.listen;
      event.listen = (name, handler) => name === "clipboard-history-stopped"
        ? Promise.reject(new Error("listen failed"))
        : listen(name, handler);
    }
  });
  assertNotesLoaded(app);
});
