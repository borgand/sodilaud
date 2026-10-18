// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";
import { foldedSections } from "../src/editor-folds.js";

const BOOK = {
  "/book/01.md": "# One\n\nfirst chapter\n",
  "/book/02.md": "# Intro\n\nopening words\n\n# Next\n\nmore\n"
};

function handlers({ open = ["/book/01.md", "/book/02.md"], pending = () => [], windows = [], move } = {}) {
  return {
    qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open, recent: [] }),
    file_set_open: ({ paths }) => { open = paths; },
    file_take_pending: pending,
    main_window_list: () => windows,
    main_window_move_file: move ?? (({ to }) => to ?? "main-2")
  };
}

const doc = (app) => app.dom.window.document;
const moveCalls = (app) => app.invocations.filter((call) => call.command === "main_window_move_file");
const moveArgs = (app) => moveCalls(app).at(-1).args;
const lastSetOpen = (app) => app.invocations.findLast((call) => call.command === "file_set_open").args;
const fileItem = (app, name) => [...doc(app).querySelectorAll(".open-file-item")]
  .find((item) => item.querySelector(".open-file-name").textContent.replace(" •", "") === name);
const listed = (app) => [...doc(app).querySelectorAll(".open-file-name")].map((button) => button.textContent.replace(" •", ""));
const menu = (app) => doc(app).getElementById("open-file-menu");
const menuItem = (app, text) => [...menu(app).querySelectorAll(".context-menu-item")]
  .find((item) => item.textContent.trim().startsWith(text));

async function openMenu(app, name) {
  const event = new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 });
  fileItem(app, name).dispatchEvent(event);
  await until(() => !menu(app).hidden);
  return event;
}

test("moving sends the last keystrokes first and never closes the document", async () => {
  const app = await bootMainWindow({ platform: "MacIntel", disk: BOOK, handlers: handlers() });
  fileItem(app, "01.md").querySelector(".open-file-name").click();
  await app.settle();
  app.editor().dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1 }, userEvent: "input.type" });
  const event = await openMenu(app, "01.md");
  assert.equal(event.defaultPrevented, true);
  assert.ok(!menuItem(app, "Move to Window"), "no other window, no submenu");
  menuItem(app, "Move to New Window").click();
  await until(() => moveCalls(app).length > 0);
  await until(() => listed(app).length === 1);

  const names = app.invocations.map((call) => call.command);
  assert.ok(names.lastIndexOf("file_doc_push") < names.indexOf("main_window_move_file"));
  assert.ok(!app.invocations.some((call) => call.command === "file_doc_close" && call.args.path === "/book/01.md"));
  assert.equal(app.fileDocs.text("/book/01.md").startsWith("x"), true);
  assert.equal(app.fileDocs.isOpen("/book/01.md"), true);
  assert.deepEqual(lastSetOpen(app).paths, ["/book/02.md"]);
  assert.equal(moveArgs(app).to, null);
  assert.deepEqual(Object.keys(moveArgs(app).view).sort(), ["folds", "previewTop", "selection", "top"]);
  assert.deepEqual(moveArgs(app).view.selection, { start: 1, end: 1 });
  assert.equal(menu(app).hidden, true);
  assert.deepEqual(listed(app), ["02.md"]);
});

test("the menu lists the other windows by number and file", async () => {
  const app = await bootMainWindow({
    instance: 2,
    platform: "MacIntel",
    disk: BOOK,
    handlers: handlers({ windows: [{ label: "main-2", number: 2, title: "notes.md" }, { label: "main-3", number: 3, title: "Start Page" }] })
  });
  await openMenu(app, "02.md");
  const entries = [...menu(app).querySelectorAll(".context-menu-submenu-content .context-menu-item")].map((item) => item.textContent);
  assert.deepEqual(entries, ["Window 2 - notes.md", "Window 3 - Start Page"]);
  assert.ok(doc(app).activeElement === menuItem(app, "Move to New Window"), "the first item has focus");
  menuItem(app, "Window 2 - notes.md").click();
  await until(() => moveCalls(app).length > 0);
  assert.equal(moveArgs(app).path, "/book/02.md");
  assert.equal(moveArgs(app).to, "main-2");
});

test("the menu works from the keyboard and Close closes the file", async () => {
  const app = await bootMainWindow({
    instance: 3,
    platform: "MacIntel",
    disk: BOOK,
    handlers: handlers({ windows: [{ label: "main-2", number: 2, title: "notes.md" }] })
  });
  const name = fileItem(app, "01.md").querySelector(".open-file-name");
  name.focus();
  name.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
  await until(() => !menu(app).hidden);
  const down = () => doc(app).activeElement.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  down();
  assert.ok(doc(app).activeElement === menuItem(app, "Move to Window"));
  down();
  assert.ok(doc(app).activeElement === menuItem(app, "Close"));
  doc(app).activeElement.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(menu(app).hidden, true);
  assert.ok(doc(app).activeElement === fileItem(app, "01.md").querySelector(".open-file-name"), "focus goes back");

  await openMenu(app, "01.md");
  menuItem(app, "Close").click();
  await until(() => listed(app).length === 1);
  assert.deepEqual(listed(app), ["02.md"]);
  assert.equal(moveCalls(app).length, 0);
});

test("an untitled file cannot be moved", async () => {
  const app = await bootMainWindow({ instance: 4, platform: "MacIntel", disk: BOOK, handlers: handlers() });
  app.click("start-new-file-btn");
  await app.settle();
  await openMenu(app, "Untitled.md");
  const move = menuItem(app, "Move to New Window");
  assert.equal(move.disabled, true);
  assert.equal(move.title, "Save the file first");
  move.click();
  await app.settle();
  assert.equal(moveCalls(app).length, 0);
});

test("a file handed over with its view opens where it was", async () => {
  const view = { selection: { start: 4, end: 4 }, top: null, previewTop: 0, folds: ["intro"] };
  let pending = [{ path: "/book/02.md", view }];
  const app = await bootMainWindow({
    instance: 5,
    platform: "MacIntel",
    disk: BOOK,
    handlers: handlers({ open: ["/book/01.md"], pending: () => { const taken = pending; pending = []; return taken; } })
  });
  assert.equal(app.editorText(), BOOK["/book/02.md"]);
  assert.equal(app.editor().state.selection.main.head, 4);
  assert.ok(foldedSections(app.editor().state).has("intro"));
});

test("a moved file arrives with its unsaved text, not the disk's", async () => {
  let pending = [];
  const app = await bootMainWindow({
    instance: 6,
    platform: "MacIntel",
    disk: BOOK,
    handlers: handlers({ open: [], pending: () => { const taken = pending; pending = []; return taken; } })
  });
  // Window A opened the file and typed into it; nothing is on disk yet.
  app.fileDocs.commands.file_doc_open({ path: "/book/01.md" });
  app.fileDocs.agentEdit("/book/01.md", [[0, "draft "], BOOK["/book/01.md"].length]);
  pending = [{ path: "/book/01.md", view: { selection: { start: 6, end: 6 }, top: 0, previewTop: 0, folds: [] } }];
  await app.emit("file-open-request");
  await until(() => listed(app).length === 1);
  assert.equal(app.editorText(), `draft ${BOOK["/book/01.md"]}`);
  assert.equal(app.fileDocs.files.get("/book/01.md"), BOOK["/book/01.md"]);
  assert.equal(app.editor().state.selection.main.head, 6);
  assert.match(doc(app).getElementById("main-title").textContent, /^01\.md •$/);
});

test("a failed move keeps the file here", async () => {
  const app = await bootMainWindow({
    instance: 7,
    platform: "MacIntel",
    disk: BOOK,
    handlers: handlers({
      windows: [{ label: "main-2", number: 2, title: "notes.md" }],
      move: () => { throw { message: "That window is closed." }; }
    })
  });
  await openMenu(app, "02.md");
  menuItem(app, "Window 2 - notes.md").click();
  await until(() => doc(app).getElementById("app-notification").textContent !== "");
  assert.equal(doc(app).getElementById("app-notification").textContent, "That window is closed.");
  assert.deepEqual(listed(app), ["01.md", "02.md"]);
});

test("a window whose last file moves away stays open on its start page", async () => {
  const app = await bootMainWindow({ instance: 8, platform: "MacIntel", disk: BOOK, handlers: handlers({ open: ["/book/01.md"] }) });
  assert.equal(doc(app).getElementById("start-page").hidden, true);
  await openMenu(app, "01.md");
  menuItem(app, "Move to New Window").click();
  await until(() => listed(app).length === 0);
  assert.equal(doc(app).getElementById("start-page").hidden, false);
  assert.equal(doc(app).getElementById("file-editor").hidden, true);
  assert.deepEqual(lastSetOpen(app), { paths: [], active: null });
  assert.equal(app.fileDocs.isOpen("/book/01.md"), true);
  assert.ok(!app.invocations.some((call) => call.command === "main_window_close_done"));
});

test("focus stays in the open files list after a keyboard Close or Move", async () => {
  const app = await bootMainWindow({ instance: 9, platform: "MacIntel", disk: BOOK, handlers: handlers() });
  const keyboardMenu = async (name, choice) => {
    const button = fileItem(app, name).querySelector(".open-file-name");
    button.focus();
    button.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
    await until(() => !menu(app).hidden);
    menuItem(app, choice).click();
  };
  await keyboardMenu("01.md", "Close");
  await until(() => listed(app).length === 1);
  await app.settle();
  assert.ok(doc(app).activeElement === fileItem(app, "02.md").querySelector(".open-file-name"), "next file name has focus");
  await keyboardMenu("02.md", "Move to New Window");
  await until(() => listed(app).length === 0);
  await app.settle();
  assert.ok(doc(app).activeElement === doc(app).getElementById("start-page"), "start page has focus");
});

test("the ContextMenu key opens the menu once even when contextmenu follows", async () => {
  const app = await bootMainWindow({ instance: 10, platform: "MacIntel", disk: BOOK, handlers: handlers() });
  const button = fileItem(app, "01.md").querySelector(".open-file-name");
  button.focus();
  button.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
  await until(() => !menu(app).hidden);
  menuItem(app, "Close").focus();
  button.dispatchEvent(new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await app.settle();
  assert.ok(doc(app).activeElement === menuItem(app, "Close"), "the open menu was not rebuilt");
});
