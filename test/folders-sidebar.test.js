// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";
import { folderHandlers } from "./helpers/folder-fakes.js";

const sample = () => ({ "/r": ["/r/docs", "/r/a.md"], "/r/docs": ["/r/docs/b.md"] });
const doc = (app) => app.dom.window.document;
const calls = (app, command) => app.invocations.filter((call) => call.command === command).map((call) => call.args);
const rows = (app) => [...doc(app).querySelectorAll("#folder-tree li")].map((item) => item.dataset.path);
const row = (app, path) => doc(app).querySelector(`#folder-tree li[data-path="${path}"]`);
const clickRow = (app, path) => row(app, path).querySelector(".folder-name").click();
const focusedPath = (app) => doc(app).activeElement?.closest("li")?.dataset.path ?? null;
const press = (app, init, target = doc(app)) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

test("Open Folder adds a root, lists it and shows the sidebar with no file open", async () => {
  const app = await bootMainWindow({ instance: 1, platform: "MacIntel", handlers: folderHandlers({ folders: sample() }) });
  assert.equal(doc(app).getElementById("files-sidebar").hidden, true);
  assert.equal(doc(app).getElementById("folders-section").hidden, true);
  app.click("menu-open-folder-btn");
  await app.settle();
  assert.equal(doc(app).getElementById("files-sidebar").hidden, false);
  assert.equal(doc(app).getElementById("folders-section").hidden, false);
  assert.equal(doc(app).getElementById("toggle-files-sidebar").hidden, false);
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/a.md"]);
  assert.deepEqual([...doc(app).querySelectorAll("#folder-tree .folder-name")].map((name) => name.textContent), ["r", "docs", "a.md"]);
  assert.equal(row(app, "/r").getAttribute("aria-expanded"), "true");
  assert.equal(row(app, "/r/docs").getAttribute("aria-expanded"), "false");
  assert.equal(row(app, "/r/a.md").hasAttribute("aria-expanded"), false);
  assert.equal(row(app, "/r/docs").getAttribute("aria-level"), "2");
  assert.equal(row(app, "/r").querySelector(".folder-remove").getAttribute("aria-label"), "Remove r from the sidebar");
  assert.deepEqual(calls(app, "folder_list"), [{ path: "/r" }]);
});

test("expanding a folder lists it once and reports the expanded set", async () => {
  const app = await bootMainWindow({
    instance: 2,
    handlers: folderHandlers({ folders: sample(), roots: [{ path: "/r", name: "r" }], expanded: ["/r"] })
  });
  clickRow(app, "/r/docs");
  await app.settle();
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/docs/b.md", "/r/a.md"]);
  assert.deepEqual(calls(app, "folder_list").filter((args) => args.path === "/r/docs"), [{ path: "/r/docs" }]);
  assert.deepEqual(calls(app, "folder_set_expanded").at(-1), { paths: ["/r", "/r/docs"] });
  clickRow(app, "/r/docs");
  await app.settle();
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/a.md"]);
  assert.deepEqual(calls(app, "folder_list").filter((args) => args.path === "/r/docs"), [{ path: "/r/docs" }]);
  assert.deepEqual(calls(app, "folder_set_expanded").at(-1), { paths: ["/r"] });
});

test("a file in the tree opens through folder_open_file", async () => {
  const app = await bootMainWindow({
    instance: 3,
    disk: { "/r/a.md": "# A\n" },
    handlers: folderHandlers({ folders: sample(), roots: [{ path: "/r", name: "r" }], expanded: ["/r"] })
  });
  clickRow(app, "/r/a.md");
  await app.settle();
  assert.deepEqual(calls(app, "folder_open_file"), [{ path: "/r/a.md" }]);
  assert.deepEqual(calls(app, "file_doc_open").at(-1), { path: "/r/a.md" });
  assert.equal(app.editorText(), "# A\n");
  assert.equal(row(app, "/r/a.md").classList.contains("active"), true);
  assert.equal(row(app, "/r/a.md").getAttribute("aria-selected"), "true");
  app.click("menu-start-page-btn");
  await app.settle();
  assert.equal(row(app, "/r/a.md").classList.contains("active"), false);
});

test("a file the tree cannot open is reported", async () => {
  const handlers = folderHandlers({ folders: sample(), roots: [{ path: "/r", name: "r" }], expanded: ["/r"] });
  handlers.folder_open_file = () => { throw { code: "NotGranted", message: "a.md is not in a folder of this window." }; };
  const app = await bootMainWindow({ instance: 4, handlers });
  clickRow(app, "/r/a.md");
  await app.settle();
  assert.equal(doc(app).getElementById("app-notification").textContent, "a.md is not in a folder of this window.");
  assert.equal(calls(app, "file_doc_open").length, 0);
});

test("folder-changed relists a visible folder and only that one", async () => {
  const folders = sample();
  const app = await bootMainWindow({
    instance: 5,
    handlers: folderHandlers({ folders, roots: [{ path: "/r", name: "r" }], expanded: ["/r", "/r/docs"] })
  });
  const before = calls(app, "folder_list").length;
  folders["/r"] = ["/r/docs", "/r/a.md", "/r/new.md"];
  await app.emit("folder-changed", { path: "/r" });
  await app.settle();
  assert.deepEqual(calls(app, "folder_list").slice(before), [{ path: "/r" }]);
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/docs/b.md", "/r/a.md", "/r/new.md"]);

  const listed = calls(app, "folder_list").length;
  await app.emit("folder-changed", { path: "/elsewhere" });
  await app.settle();
  assert.equal(calls(app, "folder_list").length, listed, "a folder the tree does not show is not listed");
});

test("removing a root calls folder_remove and hides the section", async () => {
  const app = await bootMainWindow({
    instance: 6,
    handlers: folderHandlers({ folders: sample(), roots: [{ path: "/r", name: "r" }], expanded: ["/r"] })
  });
  assert.equal(doc(app).getElementById("files-sidebar").hidden, false);
  row(app, "/r").querySelector(".folder-remove").click();
  await app.settle();
  assert.deepEqual(calls(app, "folder_remove"), [{ path: "/r" }]);
  assert.deepEqual(calls(app, "folder_set_expanded").at(-1), { paths: [] });
  assert.deepEqual(rows(app), []);
  assert.equal(doc(app).getElementById("folders-section").hidden, true);
  assert.equal(doc(app).getElementById("files-sidebar").hidden, true);
});

test("roots and expanded folders come back from file_lists", async () => {
  const app = await bootMainWindow({
    instance: 7,
    handlers: folderHandlers({ folders: sample(), roots: [{ path: "/r", name: "r" }], expanded: ["/r", "/r/docs"] })
  });
  assert.deepEqual(calls(app, "folder_list"), [{ path: "/r" }, { path: "/r/docs" }]);
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/docs/b.md", "/r/a.md"]);
  assert.equal(doc(app).getElementById("files-sidebar").hidden, false);
});

test("Show Folder in Sidebar roots the shown file's folder", async () => {
  const app = await bootMainWindow({
    instance: 8,
    disk: { "/r/a.md": "a" },
    handlers: folderHandlers({ folders: sample(), open: ["/r/a.md"] })
  });
  assert.equal(doc(app).getElementById("folders-section").hidden, true);
  assert.equal(doc(app).getElementById("menu-browse-folder-btn").disabled, false);
  app.click("menu-browse-folder-btn");
  await app.settle();
  assert.deepEqual(calls(app, "folder_browse"), [{ path: "/r/a.md" }]);
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/a.md"]);
  assert.equal(row(app, "/r/a.md").classList.contains("active"), true);
  app.click("menu-start-page-btn");
  await app.settle();
  assert.equal(doc(app).getElementById("menu-browse-folder-btn").disabled, true);
});

test("arrow keys move through the tree and Right expands", async () => {
  const app = await bootMainWindow({
    instance: 9,
    handlers: folderHandlers({ folders: sample(), roots: [{ path: "/r", name: "r" }], expanded: ["/r"] })
  });
  const tabbable = [...doc(app).querySelectorAll("#folder-tree li")].filter((item) => item.tabIndex === 0).map((item) => item.dataset.path);
  assert.deepEqual(tabbable, ["/r"], "one row is in the tab order");
  row(app, "/r").focus();
  const step = async (key) => {
    press(app, { key }, doc(app).activeElement);
    await app.settle();
    return focusedPath(app);
  };
  assert.equal(await step("ArrowDown"), "/r/docs");
  assert.equal(await step("ArrowRight"), "/r/docs");
  assert.equal(row(app, "/r/docs").getAttribute("aria-expanded"), "true");
  assert.equal(await step("ArrowRight"), "/r/docs/b.md");
  assert.equal(await step("ArrowLeft"), "/r/docs");
  assert.equal(await step("ArrowLeft"), "/r/docs");
  assert.equal(row(app, "/r/docs").getAttribute("aria-expanded"), "false");
  assert.equal(await step("End"), "/r/a.md");
  assert.equal(row(app, "/r/a.md").tabIndex, 0);
  assert.equal(await step("Home"), "/r");
  assert.equal(await step(" "), "/r");
  assert.equal(row(app, "/r").getAttribute("aria-expanded"), "false");
  assert.deepEqual(calls(app, "folder_set_expanded").at(-1), { paths: [] });
  await step("Enter");
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/a.md"]);
  await step("End");
  await step("Enter");
  assert.deepEqual(calls(app, "folder_open_file"), [{ path: "/r/a.md" }]);
});

test("Cmd+Shift+O opens the folder dialog", async () => {
  const app = await bootMainWindow({ instance: 10, platform: "MacIntel", handlers: folderHandlers({ folders: sample() }) });
  const event = press(app, { key: "O", code: "KeyO", metaKey: true, shiftKey: true });
  await app.settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls(app, "folder_open_dialog").length, 1);
  assert.equal(calls(app, "file_open_dialog").length, 0);
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/a.md"]);
  assert.equal(doc(app).getElementById("menu-open-folder-btn").title, "Open Folder (Cmd+Shift+O)");
});

test("the start page opens a folder", async () => {
  const app = await bootMainWindow({ instance: 11, handlers: folderHandlers({ folders: sample() }) });
  app.click("start-open-folder-btn");
  await app.settle();
  assert.deepEqual(rows(app), ["/r", "/r/docs", "/r/a.md"]);
});

test("a root that cannot be listed shows Folder not found", async () => {
  const app = await bootMainWindow({
    instance: 12,
    handlers: folderHandlers({ folders: {}, roots: [{ path: "/gone", name: "gone" }], expanded: ["/gone"] })
  });
  await app.settle();
  assert.deepEqual(calls(app, "folder_list"), [{ path: "/gone" }], "listed once, not again and again");
  assert.deepEqual(rows(app), ["/gone"]);
  assert.match(row(app, "/gone").textContent, /Folder not found/);
  assert.ok(row(app, "/gone").querySelector(".folder-remove"));
  assert.equal(doc(app).getElementById("app-notification").hidden, true);
});
