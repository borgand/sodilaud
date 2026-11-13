// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

function lists(open) {
  return {
    qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open, recent: [] }),
    file_set_open: () => {},
    file_take_pending: () => []
  };
}

const doc = (app) => app.dom.window.document;
const key = (app, init, target = doc(app)) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const focused = (app) => doc(app).getElementById("app").classList.contains("focus-mode");

// What the layout looks like apart from focus mode: the state the app keeps for
// the sidebar, toolbar, status bar and comments panel.
function layout(app) {
  const $ = (id) => doc(app).getElementById(id);
  return {
    sidebar: $("files-sidebar").hidden,
    sidebarToggle: $("toggle-files-sidebar").getAttribute("aria-expanded"),
    toolbar: $("file-toolbar").hidden,
    comments: $("comments-panel").hidden
  };
}

test("Cmd+Shift+F toggles focus mode and leaving it restores the layout, sidebar collapsed or not", async () => {
  const app = await bootMainWindow({
    instance: 1,
    platform: "MacIntel",
    disk: { "/docs/a.md": "# A\n", "/docs/b.md": "# B\n" },
    handlers: lists(["/docs/a.md", "/docs/b.md"])
  });
  const before = layout(app);
  assert.equal(before.sidebar, false);
  assert.equal(focused(app), false);

  const event = key(app, { key: "F", code: "KeyF", metaKey: true, shiftKey: true }, app.editor().contentDOM);
  assert.equal(event.defaultPrevented, true);
  assert.equal(focused(app), true);
  assert.equal(doc(app).getElementById("menu-focus-mode-btn").getAttribute("aria-pressed"), "true");

  key(app, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
  assert.equal(focused(app), false);
  assert.deepEqual(layout(app), before);

  // A collapsed sidebar stays collapsed after focus mode.
  key(app, { key: "s", code: "KeyS", metaKey: true, ctrlKey: true });
  const collapsed = layout(app);
  assert.equal(collapsed.sidebar, true);
  key(app, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
  assert.equal(focused(app), true);
  key(app, { key: "F", code: "KeyF", metaKey: true, shiftKey: true });
  assert.equal(focused(app), false);
  assert.deepEqual(layout(app), collapsed);
});

test("Escape does not leave focus mode; the menu item toggles it", async () => {
  const app = await bootMainWindow({
    instance: 2,
    platform: "MacIntel",
    disk: { "/docs/a.md": "# A\n" },
    handlers: lists(["/docs/a.md"])
  });
  const item = doc(app).getElementById("menu-focus-mode-btn");
  item.click();
  assert.equal(focused(app), true);
  assert.equal(doc(app).getElementById("actions-dropdown-content").classList.contains("show"), false, "the menu closes");

  key(app, { key: "Escape", code: "Escape" }, app.editor().contentDOM);
  assert.equal(focused(app), true, "Escape keeps focus mode");

  item.click();
  assert.equal(focused(app), false);
  assert.equal(item.getAttribute("aria-pressed"), "false");
});

test("off macOS Ctrl+Shift+F toggles focus mode and Help names it", async () => {
  const app = await bootMainWindow({
    instance: 3,
    platform: "Linux x86_64",
    disk: { "/docs/a.md": "# A\n" },
    handlers: lists(["/docs/a.md"])
  });
  key(app, { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true });
  assert.equal(focused(app), true);
  const shortcuts = doc(app).getElementById("pane-shortcuts").textContent.replace(/\s+/g, " ");
  assert.match(shortcuts, /Focus Mode \(this window\) Ctrl\+Shift\+F/);
  assert.match(doc(app).getElementById("menu-focus-mode-btn").title, /Ctrl\+Shift\+F/);
});

test("focus mode hides the sidebar, formatting toolbar and status bar", async () => {
  const css = await readFile(new URL("../src/app.css", import.meta.url), "utf8");
  for (const selector of [".files-sidebar", ".topbar-center", ".file-status"]) {
    assert.ok(new RegExp(`\\.main-window\\.focus-mode [^{]*${selector.replace(".", "\\.")}`).test(css), selector);
  }
});
