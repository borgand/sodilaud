// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow, until } from "./helpers/app-harness.js";
import { folderHandlers } from "./helpers/folder-fakes.js";
import { relativePath } from "../src/folder-tree.js";

const DISK = { "/r/docs/b.md": "# B\n", "/elsewhere/c.md": "# C\n" };
const FOLDERS = { "/r": ["/r/docs", "/r/a.md"], "/r/docs": ["/r/docs/b.md"] };

const doc = (app) => app.dom.window.document;
const menu = (app) => doc(app).getElementById("open-file-menu");
const menuItems = (app) => [...menu(app).querySelectorAll(".context-menu-item")];
const menuItem = (app, text) => menuItems(app).find((item) => item.textContent.trim() === text);
const fileItem = (app, name) => [...doc(app).querySelectorAll(".open-file-item")]
  .find((item) => item.querySelector(".open-file-name").textContent.replace(" •", "") === name);
const treeRow = (app, path) => doc(app).querySelector(`#folder-tree li[data-path="${path}"]`);

function stubClipboard(app) {
  const written = [];
  Object.defineProperty(app.dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { written.push(text); } }
  });
  return written;
}

async function rightClick(app, element) {
  const event = new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 });
  element.dispatchEvent(event);
  await until(() => !menu(app).hidden);
  return event;
}

async function boot(instance, options = {}) {
  const handlers = folderHandlers({
    folders: FOLDERS,
    roots: [{ path: "/r", name: "r" }],
    expanded: ["/r", "/r/docs"],
    open: ["/r/docs/b.md", "/elsewhere/c.md"],
    ...options
  });
  handlers.main_window_list = () => [];
  const app = await bootMainWindow({ instance, platform: "MacIntel", disk: DISK, handlers });
  return { app, written: stubClipboard(app) };
}

test("relativePath picks the innermost folder and keeps the stored separators", () => {
  assert.equal(relativePath("/r/docs/b.md", ["/r"]), "docs/b.md");
  assert.equal(relativePath("/r/docs/b.md", ["/r", "/r/docs"]), "b.md");
  assert.equal(relativePath("/r/docs/b.md", ["/r/docs", "/r"]), "b.md");
  assert.equal(relativePath("/rx/b.md", ["/r"]), null);
  assert.equal(relativePath("/r", ["/r"]), null);
  assert.equal(relativePath("/b.md", ["/"]), "b.md");
  assert.equal(relativePath("C:\\work\\notes\\a.md", ["C:\\work"]), "notes\\a.md");
  assert.equal(relativePath("C:\\a.md", ["C:\\"]), "a.md");
});

test("an open file inside a sidebar folder offers name, full and relative path", async () => {
  const { app, written } = await boot(1);
  await rightClick(app, fileItem(app, "b.md"));
  const texts = menuItems(app).map((item) => item.textContent.trim());
  assert.deepEqual(texts.filter((text) => text.startsWith("Copy")), ["Copy File Name", "Copy Full Path", "Copy Relative Path"]);
  menuItem(app, "Copy File Name").click();
  await until(() => written.length === 1);
  assert.equal(menu(app).hidden, true);
  await rightClick(app, fileItem(app, "b.md"));
  menuItem(app, "Copy Full Path").click();
  await until(() => written.length === 2);
  await rightClick(app, fileItem(app, "b.md"));
  menuItem(app, "Copy Relative Path").click();
  await until(() => written.length === 3);
  assert.deepEqual(written, ["b.md", "/r/docs/b.md", "docs/b.md"]);
});

test("an open file outside every sidebar folder has no relative path item", async () => {
  const { app, written } = await boot(2);
  await rightClick(app, fileItem(app, "c.md"));
  assert.ok(menuItem(app, "Copy Full Path"));
  assert.ok(!menuItem(app, "Copy Relative Path"));
  menuItem(app, "Copy Full Path").click();
  await until(() => written.length === 1);
  assert.deepEqual(written, ["/elsewhere/c.md"]);
});

test("an untitled file can copy its name but has no path to copy", async () => {
  const { app } = await boot(3, { open: [] });
  app.click("start-new-file-btn");
  await app.settle();
  await rightClick(app, fileItem(app, "Untitled.md"));
  assert.ok(menuItem(app, "Copy File Name"));
  assert.equal(menuItem(app, "Copy Full Path").disabled, true);
  assert.equal(menuItem(app, "Copy Full Path").title, "Save the file first");
  assert.ok(!menuItem(app, "Copy Relative Path"));
});

test("a selection of several files offers no copy items", async () => {
  const { app } = await boot(4);
  const click = (name, init) => fileItem(app, name).querySelector(".open-file-name")
    .dispatchEvent(new app.dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  click("b.md");
  await app.settle();
  click("c.md", { metaKey: true });
  await app.settle();
  await rightClick(app, fileItem(app, "c.md"));
  assert.ok(menuItem(app, "Close 2 Files"));
  assert.ok(!menuItems(app).some((item) => item.textContent.startsWith("Copy")));
});

test("a file in the folder tree has the same copy items", async () => {
  const { app, written } = await boot(5, { open: [] });
  const event = await rightClick(app, treeRow(app, "/r/docs/b.md"));
  assert.equal(event.defaultPrevented, true);
  const texts = menuItems(app).map((item) => item.textContent.trim());
  assert.deepEqual(texts, ["Copy File Name", "Copy Full Path", "Copy Relative Path"]);
  menuItem(app, "Copy Relative Path").click();
  await until(() => written.length === 1);
  assert.deepEqual(written, ["docs/b.md"]);
  assert.ok(doc(app).activeElement === treeRow(app, "/r/docs/b.md"), "focus goes back to the row");
});

test("a folder in the tree keeps the browser menu", async () => {
  const { app } = await boot(6, { open: [] });
  const event = new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  treeRow(app, "/r/docs").dispatchEvent(event);
  await app.settle();
  assert.equal(menu(app).hidden, true);
});

test("Shift+F10 on a tree file opens the menu from the keyboard", async () => {
  const { app } = await boot(7, { open: [] });
  const item = treeRow(app, "/r/a.md");
  item.focus();
  item.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
  await until(() => !menu(app).hidden);
  assert.ok(doc(app).activeElement === menuItem(app, "Copy File Name"));
});
