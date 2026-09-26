// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";
import { PRESET_THEMES } from "../src/preset-themes.js";
import { deriveThemeSurfaceColors } from "../src/theme-colors.js";

const githubDark = PRESET_THEMES.find(theme => theme.id === "github-dark");

// Mirrors Rust: `hotkey` is the registered hotkey, empty while the feature is off.
const ok = (config) => ({ enabled: config.enabled, hotkey: config.enabled ? config.hotkey : "", hotkeyError: null, accessibilityTrusted: false });

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
  assert.ok(!app.invocations.some(i => i.command === "clip_set_theme"));
});

test("macOS sends the active theme's colours to the popup at setup and on every theme change", async () => {
  const app = await bootApp({
    instance: 13,
    platform: "MacIntel",
    storage: { sodilaud_active_theme: "github-dark" },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const themeCalls = app.invocations.filter(i => i.command === "clip_set_theme");
  assert.ok(themeCalls.length >= 2, "expected a call at setup and one after the theme applied");
  const theme = themeCalls.at(-1).args.theme;
  assert.equal(theme.background, "#0d1117");
  assert.equal(theme.text, "#c9d1d9");
  assert.equal(theme.accent, "#58a6ff");
  assert.equal(theme.border, "#30363d");
  // The surface must follow the custom theme too, not just the built-in
  // default: it has to equal the same hover tone the main window itself
  // shows for GitHub Dark (--bg-note-hover), not a variable the theme never
  // sets inline (--bg-input, which only the built-in light/dark rules define).
  const expectedSurface = deriveThemeSurfaceColors(githubDark)["--bg-note-hover"];
  assert.equal(theme.surface, expectedSurface);
});

test("other platforms never call clip_set_theme even with a saved theme", async () => {
  const app = await bootApp({
    instance: 14,
    platform: "Linux x86_64",
    storage: { sodilaud_active_theme: "github-dark" }
  });
  assert.ok(!app.invocations.some(i => i.command === "clip_set_theme"));
});

test("Escape closes the settings modal", async () => {
  const app = await bootApp({
    instance: 6,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const { document, KeyboardEvent } = app.dom.window;
  app.click("clipboard-settings-btn");
  const backdrop = document.getElementById("clipboard-settings-modal-backdrop");
  assert.equal(backdrop.style.display, "flex");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  assert.equal(backdrop.style.display, "none");
  assert.equal(backdrop.getAttribute("aria-hidden"), "true");
});

test("clicking the backdrop closes the settings modal", async () => {
  const app = await bootApp({
    instance: 7,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const { document, MouseEvent } = app.dom.window;
  app.click("clipboard-settings-btn");
  const backdrop = document.getElementById("clipboard-settings-modal-backdrop");
  assert.equal(backdrop.style.display, "flex");
  backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
  assert.equal(backdrop.style.display, "none");
});

test("a global shortcut keydown does not reach the app while the settings modal is open", async () => {
  const app = await bootApp({
    instance: 8,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const { document, KeyboardEvent } = app.dom.window;
  app.click("clipboard-settings-btn");
  const sidebar = document.getElementById("sidebar");
  assert.equal(sidebar.classList.contains("collapsed"), false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
  await settle();
  assert.equal(sidebar.classList.contains("collapsed"), false);
});

test("blurring the hotkey button while capturing restores the formatted label", async () => {
  const app = await bootApp({
    instance: 9,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const { document, Event } = app.dom.window;
  app.click("clipboard-settings-btn");
  app.click("clipboard-hotkey-btn");
  const hotkeyBtn = document.getElementById("clipboard-hotkey-btn");
  assert.equal(hotkeyBtn.textContent, "Press a shortcut…");
  hotkeyBtn.dispatchEvent(new Event("blur"));
  await settle();
  assert.equal(hotkeyBtn.textContent, "⌘⇧V");
});

test("a hotkey that never registered says none is active and keeps the request for a retry", async () => {
  const app = await bootApp({
    instance: 10,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: true, capacity: 10, ttlMinutes: 10, hotkey: "ctrl+alt+Digit1", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ({ enabled: config.enabled, hotkey: "", hotkeyError: "HotkeyUnavailable", accessibilityTrusted: false }) }
  });
  const { document } = app.dom.window;
  assert.equal(document.getElementById("clipboard-settings-status").textContent,
    "That shortcut could not be registered. No hotkey is active; choose another.");
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).hotkey, "ctrl+alt+Digit1");
  assert.equal(document.getElementById("clipboard-hotkey-btn").textContent, "⌃⌥1");

  document.getElementById("clipboard-ttl-input").value = "20";
  document.getElementById("clipboard-ttl-input").dispatchEvent(new app.dom.window.Event("change"));
  await settle();
  assert.equal(app.invocations.findLast(i => i.command === "clip_set_config").args.config.hotkey, "ctrl+alt+Digit1");
  assert.match(document.getElementById("clipboard-settings-status").textContent, /No hotkey is active/);
});

test("turning the feature off keeps the chosen hotkey", async () => {
  const app = await bootApp({
    instance: 11,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: false, capacity: 10, ttlMinutes: 10, hotkey: "ctrl+alt+Digit1", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).hotkey, "ctrl+alt+Digit1");
  assert.equal(app.dom.window.document.getElementById("clipboard-hotkey-btn").textContent, "⌃⌥1");
});

test("clearing a number field restores it instead of applying a minimum", async () => {
  const app = await bootApp({
    instance: 12,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: true, capacity: 10, ttlMinutes: 15, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const { document, Event } = app.dom.window;
  app.click("clipboard-settings-btn");
  const applied = () => app.invocations.filter(i => i.command === "clip_set_config").length;
  const before = applied();
  for (const [id, shown] of [["clipboard-capacity-input", "10"], ["clipboard-ttl-input", "15"]]) {
    for (const typed of ["", "  ", "abc"]) {
      const input = document.getElementById(id);
      input.value = typed;
      input.dispatchEvent(new Event("change"));
      await settle();
      assert.equal(input.value, shown, `${id} after ${JSON.stringify(typed)}`);
    }
  }
  assert.equal(applied(), before);
  assert.deepEqual(
    [JSON.parse(app.storage.getItem("clipboardHistory.settings")).capacity, JSON.parse(app.storage.getItem("clipboardHistory.settings")).ttlMinutes],
    [10, 15]
  );
});
