// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { PRESET_THEMES } from "../src/preset-themes.js";
import { bootMainWindow } from "./helpers/app-harness.js";

const handlers = {
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false })
};
const theme = id => PRESET_THEMES.find(preset => preset.id === id);
const prop = (app, name) => app.dom.window.document.documentElement.style.getPropertyValue(name);

test("the status bar takes the page tone and the title bar keeps the sidebar tone", async () => {
  const githubDark = theme("github-dark");
  const app = await bootMainWindow({ instance: 1, storage: { sodilaud_active_theme: "github-dark" }, handlers });
  assert.equal(prop(app, "--statusbar-bg"), githubDark.background);
  assert.equal(prop(app, "--topbar-bg"), githubDark.sidebar);
});

test("a retro theme keeps a sidebar-toned status bar", async () => {
  const classic = theme("windows-classic");
  const app = await bootMainWindow({ instance: 2, storage: { sodilaud_active_theme: "windows-classic" }, handlers });
  assert.equal(prop(app, "--statusbar-bg"), classic.sidebar);
});
