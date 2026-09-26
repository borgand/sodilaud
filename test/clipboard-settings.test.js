// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIPBOARD_SETTINGS_KEY, DEFAULT_CLIPBOARD_SETTINGS, acceleratorFromKeyEvent, formatAccelerator,
  isMacPlatform, loadClipboardSettings, normalizeClipboardSettings, saveClipboardSettings
} from "../src/clipboard-settings.js";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

test("defaults match the spec", () => {
  assert.deepEqual(DEFAULT_CLIPBOARD_SETTINGS, { enabled: false, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false });
});

test("normalizes corrupt stored settings", () => {
  assert.deepEqual(normalizeClipboardSettings({ enabled: "yes", capacity: "lots", ttlMinutes: -5, hotkey: 42, autoPaste: 1 }), { ...DEFAULT_CLIPBOARD_SETTINGS, ttlMinutes: 1 });
  assert.equal(normalizeClipboardSettings({ capacity: 9999 }).capacity, 50);
  assert.equal(normalizeClipboardSettings({ ttlMinutes: 0 }).ttlMinutes, 1);
  assert.equal(normalizeClipboardSettings({ capacity: 7.6 }).capacity, 8);
  assert.deepEqual(loadClipboardSettings(memoryStorage({ [CLIPBOARD_SETTINGS_KEY]: "{not json" })), DEFAULT_CLIPBOARD_SETTINGS);
  assert.deepEqual(loadClipboardSettings(memoryStorage()), DEFAULT_CLIPBOARD_SETTINGS);
});

test("saves only the settings fields", () => {
  const storage = memoryStorage();
  saveClipboardSettings(storage, { ...DEFAULT_CLIPBOARD_SETTINGS, enabled: true, extra: "value" });
  assert.deepEqual(Object.keys(JSON.parse(storage.map.get(CLIPBOARD_SETTINGS_KEY))).sort(), ["autoPaste", "capacity", "enabled", "hotkey", "ttlMinutes"]);
});

test("captures accelerators that include a non-Shift modifier", () => {
  assert.equal(acceleratorFromKeyEvent({ metaKey: true, shiftKey: true, code: "KeyV" }), "super+shift+KeyV");
  assert.equal(acceleratorFromKeyEvent({ ctrlKey: true, altKey: true, code: "Digit1" }), "ctrl+alt+Digit1");
  assert.equal(acceleratorFromKeyEvent({ shiftKey: true, code: "KeyV" }), null);
  assert.equal(acceleratorFromKeyEvent({ metaKey: true, code: "ShiftLeft" }), null);
  assert.equal(acceleratorFromKeyEvent({ metaKey: true, code: "F5" }), "super+F5");
});

test("formats accelerators with macOS symbols", () => {
  assert.equal(formatAccelerator("super+shift+KeyV"), "⌘⇧V");
  assert.equal(formatAccelerator("ctrl+alt+Digit1"), "⌃⌥1");
});

test("detects macOS", () => {
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ platform: "Linux x86_64" }), false);
});
