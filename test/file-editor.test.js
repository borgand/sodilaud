// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const fileText = (path, text, extra = {}) => ({
  path, name: path.split("/").pop(), text, lineEnding: "lf", bom: false, hash: `h-${text.length}`, ...extra
});

// A fake disk: `file_read` and `file_write` see the same files.
function disk(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  let recent = [];
  let open = [];
  return {
    files,
    writes,
    setRecent: (entries) => { recent = entries; },
    setOpen: (paths) => { open = paths; },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open, recent }),
      file_set_open: ({ paths }) => { open = paths; },
      file_take_pending: () => [],
      file_read: ({ path }) => {
        if (!files.has(path)) throw { code: "NotFound", message: `${path} is no longer on disk.` };
        return fileText(path, files.get(path));
      },
      file_write: ({ path, text }) => {
        writes.push({ path, text });
        files.set(path, text);
        return `h-${text.length}`;
      }
    }
  };
}

const doc = (app) => app.dom.window.document;
const key = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  doc(app).dispatchEvent(event);
  return event;
};

test("Open File shows the file, lists it and autosaves edits", async () => {
  const fake = disk();
  const app = await bootMainWindow({
    platform: "MacIntel",
    handlers: { ...fake.handlers, file_open_dialog: () => fileText("/docs/plan.md", "# Plan\n") }
  });
  app.click("start-open-file-btn");
  await app.settle();
  assert.equal(doc(app).getElementById("start-page").hidden, true);
  assert.equal(doc(app).getElementById("file-editor").hidden, false);
  assert.equal(app.editorText(), "# Plan\n");
  assert.equal(doc(app).getElementById("main-title").textContent, "plan.md");
  assert.deepEqual([...doc(app).querySelectorAll(".open-file-name")].map((item) => item.textContent), ["plan.md"]);
  assert.deepEqual(app.invocations.findLast((call) => call.command === "file_set_open").args, { paths: ["/docs/plan.md"] });

  await app.type("# Plan\n- ship it\n");
  assert.deepEqual(fake.writes, [{ path: "/docs/plan.md", text: "# Plan\n- ship it\n" }]);
  assert.equal(doc(app).getElementById("main-title").textContent, "plan.md");
  assert.match(doc(app).getElementById("file-status").textContent, /^Saved · \/docs\/plan.md/);
});

test("an outside edit reloads a clean file and asks about an edited one", async () => {
  const fake = disk({ "/docs/a.md": "one\n" });
  fake.setOpen(["/docs/a.md"]);
  const app = await bootMainWindow({ instance: 2, handlers: { ...fake.handlers, file_write: () => new Promise(() => {}) } });
  assert.equal(app.editorText(), "one\n", "the file open at quit reopens");

  fake.files.set("/docs/a.md", "two\n");
  await app.emit("file-changed", { path: "/docs/a.md", kind: "modified" });
  await app.settle();
  assert.equal(app.editorText(), "two\n");
  assert.equal(doc(app).getElementById("file-banner").hidden, true);

  const view = app.editor();
  view.dispatch({ changes: { from: view.state.doc.length, insert: "mine\n" }, userEvent: "input.type" });
  fake.files.set("/docs/a.md", "three\n");
  await app.emit("file-changed", { path: "/docs/a.md", kind: "modified" });
  await app.settle();
  const banner = doc(app).getElementById("file-banner");
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /changed on disk/);
  assert.equal(app.editorText(), "two\nmine\n", "your edit stays until you choose");

  app.click("file-banner-primary-btn");
  await app.settle();
  assert.equal(app.editorText(), "three\n");
  assert.equal(banner.hidden, true);
});

test("Keep mine overwrites the outside change; a removed file offers Save As", async () => {
  const fake = disk({ "/docs/b.md": "base\n" });
  fake.setOpen(["/docs/b.md"]);
  const app = await bootMainWindow({ instance: 3, handlers: fake.handlers });
  const view = app.editor();
  view.dispatch({ changes: { from: 0, insert: "edit " }, userEvent: "input.type" });
  fake.files.set("/docs/b.md", "theirs\n");
  await app.emit("file-changed", { path: "/docs/b.md", kind: "modified" });
  await app.settle(20);
  assert.equal(fake.writes.length, 0, "no autosave while the conflict is open");
  app.click("file-banner-secondary-btn");
  await app.settle();
  assert.deepEqual(fake.writes.at(-1), { path: "/docs/b.md", text: "edit base\n" });

  await app.emit("file-changed", { path: "/docs/b.md", kind: "removed" });
  await app.settle();
  assert.match(doc(app).getElementById("file-banner").textContent, /no longer on disk/);
  assert.equal(doc(app).getElementById("file-banner-primary-btn").textContent, "Save As…");
});

test("Cmd+W closes files and the last one brings back the start page", async () => {
  const fake = disk({ "/docs/1.md": "1", "/docs/2.md": "2" });
  fake.setOpen(["/docs/1.md", "/docs/2.md"]);
  const app = await bootMainWindow({ instance: 4, platform: "MacIntel", handlers: fake.handlers });
  assert.equal(app.editorText(), "2");
  assert.equal(key(app, { key: "w", code: "KeyW", metaKey: true }).defaultPrevented, true);
  await app.settle();
  assert.equal(app.editorText(), "1");
  key(app, { key: "w", code: "KeyW", metaKey: true });
  await app.settle();
  assert.equal(doc(app).getElementById("start-page").hidden, false);
  assert.equal(doc(app).getElementById("files-sidebar").hidden, true);
  assert.deepEqual(app.invocations.findLast((call) => call.command === "file_set_open").args, { paths: [] });
});

test("a new file is saved with Save As, and closing an unsaved one asks first", async () => {
  const fake = disk();
  const answers = ["cancel", "discard"];
  const app = await bootMainWindow({
    instance: 5,
    platform: "MacIntel",
    handlers: {
      ...fake.handlers,
      file_save_as_dialog: ({ text }) => ({ path: "/docs/new.md", name: "new.md", hash: `h-${text.length}` }),
      file_confirm_discard: () => answers.shift()
    }
  });
  key(app, { key: "n", code: "KeyN", metaKey: true });
  await app.settle();
  assert.equal(doc(app).getElementById("main-title").textContent, "Untitled.md");
  await app.type("draft\n");
  assert.equal(fake.writes.length, 0, "a new file is not autosaved before it has a path");
  key(app, { key: "s", code: "KeyS", metaKey: true });
  await app.settle();
  assert.equal(app.invocations.findLast((call) => call.command === "file_save_as_dialog").args.text, "draft\n");
  assert.equal(doc(app).getElementById("main-title").textContent, "new.md");

  key(app, { key: "n", code: "KeyN", metaKey: true });
  await app.settle();
  await app.type("unsaved");
  key(app, { key: "w", code: "KeyW", metaKey: true });
  await app.settle();
  assert.match(doc(app).getElementById("main-title").textContent, /^Untitled\.md/, "Cancel keeps it open");
  key(app, { key: "w", code: "KeyW", metaKey: true });
  await app.settle();
  assert.equal(doc(app).getElementById("main-title").textContent, "new.md", "Don't Save closes it");
});

test("quitting saves open files and reports a failed save", async () => {
  const fake = disk({ "/docs/q.md": "q" });
  fake.setOpen(["/docs/q.md"]);
  let fail = true;
  const app = await bootMainWindow({
    instance: 6,
    handlers: {
      ...fake.handlers,
      file_write: (args) => {
        if (fail) throw { code: "Io", message: "disk full" };
        return fake.handlers.file_write(args);
      }
    }
  });
  const view = app.editor();
  view.dispatch({ changes: { from: 1, insert: "!" }, userEvent: "input.type" });
  await app.emit("sodilaud-quit-requested");
  await app.settle();
  assert.deepEqual(app.invocations.filter((call) => call.command === "quit_window_done").map((call) => call.args.ok), [false]);
  assert.match(doc(app).getElementById("file-banner").textContent, /Could not save q.md: disk full/);

  fail = false;
  await app.emit("sodilaud-quit-requested");
  await app.settle();
  assert.deepEqual(app.invocations.filter((call) => call.command === "quit_window_done").map((call) => call.args.ok), [false, true]);
  assert.equal(fake.files.get("/docs/q.md"), "q!");
});

test("the start page lists recent files and drops one that is gone", async () => {
  const fake = disk({ "/docs/here.md": "here" });
  fake.setRecent([
    { path: "/docs/here.md", name: "here.md", exists: true },
    { path: "/docs/gone.md", name: "gone.md", exists: false }
  ]);
  const app = await bootMainWindow({ instance: 7, handlers: { ...fake.handlers, file_forget_recent: () => null } });
  const buttons = [...doc(app).querySelectorAll("#recent-files-list .recent-file")];
  assert.deepEqual(buttons.map((button) => button.textContent), ["here.md", "gone.md"]);
  assert.equal(buttons[1].classList.contains("missing"), true);
  buttons[1].click();
  await app.settle();
  assert.deepEqual(app.invocations.findLast((call) => call.command === "file_forget_recent").args, { path: "/docs/gone.md" });
  buttons[0].click();
  await app.settle();
  assert.equal(app.editorText(), "here");
});

test("Reading mode renders the file and a file opened from Finder is shown", async () => {
  const fake = disk({ "/docs/r.md": "# Heading\n", "/docs/finder.md": "from finder" });
  fake.setOpen(["/docs/r.md"]);
  let pending = [];
  const app = await bootMainWindow({ instance: 8, beforeBoot: (dom) => { dom.window.marked = marked; }, handlers: { ...fake.handlers, file_take_pending: () => { const taken = pending; pending = []; return taken; } } });
  app.click("mode-reading");
  assert.equal(doc(app).getElementById("file-editor").classList.contains("mode-reading"), true);
  assert.match(doc(app).getElementById("markdown-preview").innerHTML, /<h1[^>]*>Heading<\/h1>/);
  await app.settle();
  assert.ok(app.emitted.some((event) => event.name === "prefs-changed" && event.payload.key === "sodilaud_layout_mode"));
  app.click("mode-live");

  pending = ["/docs/finder.md"];
  await app.emit("file-open-request");
  await app.settle();
  assert.equal(app.editorText(), "from finder");
  assert.equal(doc(app).querySelectorAll(".open-file-item").length, 2);
});
