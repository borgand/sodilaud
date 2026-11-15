// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { bootMainWindow, until } from "./helpers/app-harness.js";

const DISK = { "/book/01.md": "# One\n", "/book/02.md": "# Two\n" };

async function boot(instance, { name = null } = {}) {
  let current = name;
  const titles = [];
  const app = await bootMainWindow({
    instance,
    platform: "MacIntel",
    disk: DISK,
    windowApi: {
      getCurrentWindow: () => ({
        label: "main",
        onCloseRequested: async () => () => {},
        setTitle: async (text) => { titles.push(text); }
      })
    },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: ["/book/01.md", "/book/02.md"], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => [],
      main_window_name: () => current,
      main_window_set_name: ({ name }) => { current = name.trim() || null; return current; }
    }
  });
  return Object.assign(app, { titles });
}

const doc = (app) => app.dom.window.document;
const byId = (app, id) => doc(app).getElementById(id);
const fileItem = (app, name) => [...doc(app).querySelectorAll(".open-file-name")]
  .find((button) => button.textContent.replace(" •", "") === name);

test("macOS gets the overlay title bar layout with a draggable toolbar row", async () => {
  const app = await boot(1);
  assert.ok(doc(app).documentElement.classList.contains("platform-mac"));
  const header = doc(app).querySelector(".main-topbar");
  assert.equal(header.getAttribute("data-tauri-drag-region"), "deep");
  const menus = [...doc(app).querySelectorAll(".main-topbar .format-menu, .main-topbar .dropdown-content")];
  assert.ok(menus.length >= 3);
  for (const menu of menus) {
    assert.equal(menu.getAttribute("data-tauri-drag-region"), "false", menu.id);
  }
});

test("the native title is the file name, and the window name joins it", async () => {
  const app = await boot(2, { name: "Book" });
  fileItem(app, "01.md").click();
  await until(() => app.titles.at(-1) === "01.md - Book");
  assert.equal(app.titles.at(-1), "01.md - Book");
  assert.equal(byId(app, "main-title").textContent, "01.md");
  assert.equal(byId(app, "main-window-name").textContent, "Book");
  assert.equal(byId(app, "main-window-name").hidden, false);

  fileItem(app, "02.md").click();
  await until(() => app.titles.at(-1) === "02.md - Book");
  assert.equal(app.titles.at(-1), "02.md - Book");
});

test("renaming the window updates the title row and the native title", async () => {
  const app = await boot(3);
  fileItem(app, "01.md").click();
  await until(() => app.titles.at(-1) === "01.md");
  assert.equal(app.titles.at(-1), "01.md");
  assert.equal(byId(app, "main-window-name").hidden, true);

  app.click("menu-name-window-btn");
  await until(() => byId(app, "window-name-modal-backdrop").style.display !== "none");
  byId(app, "window-name-input").value = "Review";
  byId(app, "window-name-form").dispatchEvent(new app.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await until(() => app.titles.at(-1) === "01.md - Review");
  assert.equal(app.titles.at(-1), "01.md - Review");
  assert.equal(byId(app, "main-window-name").textContent, "Review");
  assert.equal(byId(app, "main-window-name").hidden, false);
});

test("main windows are built with the overlay title bar on macOS", async () => {
  const [conf, source, capability] = await Promise.all([
    readFile("src-tauri/tauri.conf.json", "utf8").then(JSON.parse),
    readFile("src-tauri/src/main_window.rs", "utf8"),
    readFile("src-tauri/capabilities/default.json", "utf8").then(JSON.parse)
  ]);
  const main = conf.app.windows.find((window) => window.label === "main");
  assert.equal(main.titleBarStyle, "Overlay");
  assert.equal(main.hiddenTitle, true);
  assert.ok(main.trafficLightPosition);
  assert.match(source, /title_bar_style\(TitleBarStyle::Overlay\)/);
  assert.match(source, /hidden_title\(true\)/);
  assert.match(source, /traffic_light_position\(/);
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
  assert.ok(capability.permissions.includes("core:window:allow-set-title"));
});
