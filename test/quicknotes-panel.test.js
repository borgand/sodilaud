// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

const NOTES = [
  { id: "a", title: "Groceries", content: "Groceries", updatedAt: 3, isTitleLocked: false },
  { id: "b", title: "Welcome to Quick Notes", content: "Welcome to Quick Notes", updatedAt: 2, isTitleLocked: false },
  { id: "c", title: "Plan", content: "Plan", updatedAt: 1, isTitleLocked: false }
];

const app = await bootApp({
  platform: "MacIntel",
  storage: { sodilaud_notes: NOTES, sodilaud_quicknotes_active_note: "c" }
});
const { document, KeyboardEvent, MouseEvent } = app.dom.window;
const calls = (command) => app.invocations.filter(call => call.command === command);
const key = (init) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
};

test("the panel reopens the note that was open last, with the sidebar collapsed", () => {
  assert.equal(app.editorText(), "Plan");
  assert.equal(document.getElementById("sidebar").classList.contains("collapsed"), true);
  assert.equal(document.getElementById("toggle-sidebar").getAttribute("aria-expanded"), "false");
});

test("the close button and Cmd+W hide the panel; Escape does not", async () => {
  document.getElementById("quicknotes-close-btn").click();
  assert.equal(key({ key: "w", code: "KeyW", metaKey: true }).defaultPrevented, true);
  key({ key: "Escape", code: "Escape" });
  await app.settle();
  assert.equal(calls("qn_close").length, 2);
});

test("dragging the header moves the panel, but not from its button", async () => {
  const header = document.getElementById("quicknotes-header");
  header.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  document.getElementById("quicknotes-close-btn").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await app.settle();
  assert.equal(calls("qn_start_drag").length, 1);
});

test("help and settings open in the main window", async () => {
  key({ key: "/", code: "Slash", metaKey: true });
  document.getElementById("help-btn").click();
  document.getElementById("settings-menu-btn").click();
  await app.settle();
  assert.deepEqual(calls("show_main_window").map(call => call.args.section), ["help", "help", "settings"]);
  assert.equal(document.getElementById("help-modal-backdrop"), null);
});

test("the main window can select a note by title and open this menu", async () => {
  await app.emit("quicknotes-focus-note", { title: "Welcome to Quick Notes" });
  assert.equal(app.editorText(), "Welcome to Quick Notes");
  assert.equal(app.storage.getItem("sodilaud_quicknotes_active_note"), "b");

  await app.emit("quicknotes-focus-note", { title: "No such note" });
  assert.equal(app.editorText(), "Welcome to Quick Notes");

  await app.emit("quicknotes-open-menu");
  assert.equal(document.getElementById("actions-dropdown-content").classList.contains("show"), true);
});

test("a theme chosen in the main window is applied here", async () => {
  app.storage.setItem("sodilaud_active_theme", "default-light");
  await app.emit("prefs-changed", { key: "sodilaud_active_theme", source: "main" });
  assert.equal(document.documentElement.classList.contains("theme-light"), true);
  // Its own broadcasts are ignored.
  app.storage.setItem("sodilaud_active_theme", "default-dark");
  await app.emit("prefs-changed", { key: "sodilaud_active_theme", source: "quicknotes" });
  assert.equal(document.documentElement.classList.contains("theme-light"), true);
});
