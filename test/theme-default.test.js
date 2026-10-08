// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { DEFAULT_THEME_ID, createThemes } from "../src/themes.js";
import { PRESET_THEMES } from "../src/preset-themes.js";

const executive = PRESET_THEMES.find(theme => theme.id === "executive");

function loadThemes(saved = {}) {
  const { window } = new JSDOM(`<!doctype html><html><body><div id="theme-grid"></div></body></html>`, { url: "http://localhost/" });
  const storage = window.localStorage;
  Object.entries(saved).forEach(([key, value]) => storage.setItem(key, value));
  const themes = createThemes({ document: window.document, storage, invoke: async () => null });
  themes.load();
  return { themes, storage, root: window.document.documentElement, document: window.document };
}

test("a new install starts on Executive", () => {
  assert.equal(DEFAULT_THEME_ID, "executive");

  const { themes, storage, root } = loadThemes();

  assert.equal(themes.activeThemeId(), "executive");
  assert.equal(storage.getItem("sodilaud_active_theme"), "executive");
  assert.equal(root.style.getPropertyValue("--bg-app"), executive.background);
  assert.ok(root.classList.contains("theme-dark"));
});

test("a saved Default Dark is kept", () => {
  const { themes, storage, root } = loadThemes({ sodilaud_active_theme: "default-dark" });

  assert.equal(themes.activeThemeId(), "default-dark");
  assert.equal(storage.getItem("sodilaud_active_theme"), "default-dark");
  assert.equal(root.style.getPropertyValue("--bg-app"), "");
  assert.ok(root.classList.contains("theme-dark"));
});

test("a saved Default Light is kept", () => {
  const { themes, root } = loadThemes({ sodilaud_active_theme: "default-light" });

  assert.equal(themes.activeThemeId(), "default-light");
  assert.ok(root.classList.contains("theme-light"));
});

test("an unknown saved theme falls back to Executive", () => {
  const { themes, storage } = loadThemes({ sodilaud_active_theme: "no-such-theme" });

  assert.equal(themes.activeThemeId(), "executive");
  assert.equal(storage.getItem("sodilaud_active_theme"), "executive");
});

test("deleting the active custom theme falls back to Executive", () => {
  const custom = { id: "custom_1", name: "Mine", background: "#101010", foreground: "#f0f0f0" };
  const { themes, storage, document } = loadThemes({
    sodilaud_active_theme: custom.id,
    sodilaud_custom_themes: JSON.stringify([custom])
  });
  assert.equal(themes.activeThemeId(), custom.id);

  document.querySelector(".theme-card-delete").click();

  assert.equal(themes.activeThemeId(), "executive");
  assert.equal(storage.getItem("sodilaud_active_theme"), "executive");
  assert.deepEqual(JSON.parse(storage.getItem("sodilaud_custom_themes")), []);
});
