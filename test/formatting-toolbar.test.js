// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

const NOTES = [
  { id: "note-one", title: "First", content: "First note", updatedAt: 2, isTitleLocked: true },
  { id: "note-two", title: "Second", content: "Second note", updatedAt: 1, isTitleLocked: true }
];

const app = await bootApp({
  platform: "MacIntel",
  storage: { sodilaud_notes: NOTES },
  handlers: { load_workspace_preference: () => null }
});
const { document, MouseEvent, KeyboardEvent } = app.dom.window;

function load(pane, text, from, to = from) {
  const view = app.editor(pane);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: from, head: to },
    userEvent: "input.type"
  });
}

function selection(pane) {
  const { from, to } = app.editor(pane).state.selection.main;
  return [from, to];
}

// A real click: mousedown first, whose default would move focus to the button.
function press(id) {
  const button = document.getElementById(id);
  const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  button.dispatchEvent(mousedown);
  button.click();
  return mousedown.defaultPrevented;
}

function countFocus(pane) {
  const view = app.editor(pane);
  const original = view.focus;
  const counter = { calls: 0, restore: () => { view.focus = original; } };
  view.focus = () => { counter.calls += 1; original.call(view); };
  return counter;
}

function setMode(mode) {
  document.getElementById(`mode-${mode}`).click();
}

function sidebarCollapsed() {
  return document.getElementById("sidebar").classList.contains("collapsed");
}

test("the formatting group sits directly left of the mode buttons", () => {
  const group = document.getElementById("format-controls");
  assert.equal(group.nextElementSibling.className, "layout-controls");
  assert.equal(group.getAttribute("role"), "group");
  const ids = [...group.querySelectorAll("button[data-format], #format-heading-btn")]
    .filter(button => !button.closest("[role='menu']"))
    .map(button => button.dataset.format ?? "heading-menu");
  assert.deepEqual(ids, [
    "bold", "italic", "strikethrough", "code", "link",
    "heading-menu", "bullet-list", "numbered-list", "task-list", "quote",
    "code-block", "table", "horizontal-rule"
  ]);
});

test("every formatting button has a label and a title", () => {
  const unnamed = [...document.querySelectorAll("#format-controls button")]
    .filter(button => !button.getAttribute("aria-label")?.trim() || !button.getAttribute("title")?.trim())
    .map(button => button.id || button.dataset.format);
  assert.deepEqual(unnamed, []);
  assert.equal(document.getElementById("format-bold").getAttribute("title"), "Bold (Cmd+B)");
  assert.equal(document.getElementById("format-bullet-list").getAttribute("title"), "Bullet list (Cmd+Shift+8)");
});

test("Bold wraps the primary selection, keeps it, and refocuses the editor", () => {
  setMode("live");
  load("primary", "hello world", 0, 5);
  const focus = countFocus("primary");
  try {
    const prevented = press("format-bold");
    assert.equal(prevented, true);
    assert.equal(app.editorText("primary"), "**hello** world");
    assert.deepEqual(selection("primary"), [2, 7]);
    assert.equal(focus.calls, 1);
  } finally {
    focus.restore();
  }
});

test("the heading menu sets H2", () => {
  load("primary", "Title\nbody", 2);
  const trigger = document.getElementById("format-heading-btn");
  const menu = document.getElementById("format-heading-menu");
  assert.equal(menu.hidden, true);
  press("format-heading-btn");
  assert.equal(menu.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  const items = [...menu.querySelectorAll("button")].map(button => button.dataset.format);
  assert.deepEqual(items, ["heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6", "paragraph"]);

  press("format-heading-2");
  assert.equal(app.editorText("primary"), "## Title\nbody");
  assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("the formatting group is disabled in Reading mode and enabled in Live and Source", () => {
  const disabledStates = () => [...document.querySelectorAll("#format-controls button")].map(button => button.disabled);
  const allEqual = (values, expected) => values.length > 0 && values.every(value => value === expected);

  setMode("reading");
  assert.equal(allEqual(disabledStates(), true), true);
  assert.equal(document.getElementById("format-controls").getAttribute("aria-disabled"), "true");
  assert.equal(document.getElementById("format-controls").hidden, false);

  load("primary", "text", 0, 4);
  document.getElementById("format-bold").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  document.getElementById("format-bold").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(app.editorText("primary"), "text");

  setMode("source");
  assert.equal(allEqual(disabledStates(), false), true);
  assert.equal(document.getElementById("format-controls").getAttribute("aria-disabled"), "false");

  setMode("live");
  assert.equal(allEqual(disabledStates(), false), true);
});

test("Ctrl-Cmd-S toggles the sidebar and Cmd-B in the editor bolds without toggling it", () => {
  const before = sidebarCollapsed();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  assert.equal(sidebarCollapsed(), !before);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  assert.equal(sidebarCollapsed(), before);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", metaKey: true, bubbles: true, cancelable: true }));
  assert.equal(sidebarCollapsed(), before);

  // jsdom does not mirror CodeMirror's selection into the DOM, so a focused
  // editor would read a collapsed DOM selection back on keydown.
  app.editor("primary").contentDOM.blur();
  load("primary", "word", 0, 4);
  const event = new KeyboardEvent("keydown", { key: "b", code: "KeyB", metaKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { value: 66 });
  app.editor("primary").contentDOM.dispatchEvent(event);
  assert.equal(app.editorText("primary"), "**word**");
  assert.equal(sidebarCollapsed(), before);
});

test("the sidebar button and help list the new shortcut", () => {
  assert.equal(document.getElementById("toggle-sidebar").getAttribute("title"), "Toggle Sidebar (Ctrl+Cmd+S)");
  const shortcuts = document.getElementById("pane-shortcuts").textContent.replace(/\s+/g, " ");
  assert.match(shortcuts, /Toggle Sidebar Ctrl\+Cmd\+S/);
  assert.doesNotMatch(shortcuts, /Toggle Sidebar Cmd\+B/);
  assert.match(shortcuts, /Bold Cmd\+B/);
});

test("after focusing the secondary pane, Bullet list applies there only", async () => {
  document.getElementById("split-note-btn").click();
  await settle();
  load("primary", "left", 0, 4);
  load("secondary", "right", 0, 5);
  app.editor("secondary").focus();
  await settle();

  const focus = countFocus("secondary");
  try {
    press("format-bullet-list");
    assert.equal(app.editorText("secondary"), "- right");
    assert.equal(app.editorText("primary"), "left");
    assert.equal(focus.calls, 1);
  } finally {
    focus.restore();
  }
});

// Runs last: a second boot replaces the globals the tests above rely on.
test("off macOS the sidebar shortcut is Ctrl+Alt+S and labels say so", async () => {
  const other = await bootApp({ instance: 2, platform: "Win32", handlers: { load_workspace_preference: () => null } });
  const doc = other.dom.window.document;
  const collapsed = () => doc.getElementById("sidebar").classList.contains("collapsed");
  const key = init => doc.dispatchEvent(new other.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  assert.equal(doc.getElementById("toggle-sidebar").getAttribute("title"), "Toggle Sidebar (Ctrl+Alt+S)");
  assert.equal(doc.getElementById("format-bold").getAttribute("title"), "Bold (Ctrl+B)");
  assert.match(doc.getElementById("pane-shortcuts").textContent.replace(/\s+/g, " "), /Toggle Sidebar Ctrl\+Alt\+S/);

  const before = collapsed();
  key({ key: "s", code: "KeyS", ctrlKey: true, altKey: true });
  assert.equal(collapsed(), !before);
  key({ key: "ś", code: "KeyS", ctrlKey: true, altKey: true });
  assert.equal(collapsed(), !before);
  key({ key: "b", code: "KeyB", ctrlKey: true });
  assert.equal(collapsed(), !before);
});
