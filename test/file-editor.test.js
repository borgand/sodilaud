// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

// The page's file lists; file text lives in the fake registry (`disk`).
function lists({ open = [], recent = [] } = {}) {
  return {
    setRecent: (entries) => { recent = entries; },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open, recent }),
      file_set_open: ({ paths }) => { open = paths; },
      file_take_pending: () => []
    }
  };
}

const doc = (app) => app.dom.window.document;
const key = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  doc(app).dispatchEvent(event);
  return event;
};
const typeAt = (app, from, insert) => app.editor().dispatch({ changes: { from, insert }, userEvent: "input.type" });

test("Open File shows the file, lists it and Rust autosaves edits", async () => {
  const fake = lists();
  const app = await bootMainWindow({
    platform: "MacIntel",
    disk: { "/docs/plan.md": "# Plan\n" },
    handlers: { ...fake.handlers, file_open_dialog: () => "/docs/plan.md" }
  });
  app.click("start-open-file-btn");
  await app.settle();
  assert.equal(doc(app).getElementById("start-page").hidden, true);
  assert.equal(doc(app).getElementById("file-editor").hidden, false);
  assert.equal(app.editorText(), "# Plan\n");
  assert.equal(doc(app).getElementById("main-title").textContent, "plan.md");
  assert.deepEqual([...doc(app).querySelectorAll(".open-file-name")].map((item) => item.textContent), ["plan.md"]);
  assert.deepEqual(app.invocations.findLast((call) => call.command === "file_set_open").args, { paths: ["/docs/plan.md"], active: "/docs/plan.md" });

  typeAt(app, 7, "- ship it\n");
  assert.equal(doc(app).getElementById("main-title").textContent, "plan.md •", "unsaved at once");
  assert.match(doc(app).getElementById("file-status").textContent, /^Saving…/);
  await app.settle(700);
  assert.deepEqual(app.fileDocs.writes, [{ path: "/docs/plan.md", text: "# Plan\n- ship it\n" }]);
  assert.equal(doc(app).getElementById("main-title").textContent, "plan.md");
  const status = doc(app).getElementById("file-status");
  assert.equal(status.textContent, "Saved");
  assert.equal(status.title, "/docs/plan.md");
  assert.equal(doc(app).getElementById("file-status-path").textContent, "/docs/plan.md");
});

test("Saved fades after a moment and an edit brings the status back", async () => {
  const fake = lists({ open: ["/docs/a.md"] });
  const app = await bootMainWindow({ instance: 15, disk: { "/docs/a.md": "one\n" }, handlers: fake.handlers });
  const status = doc(app).getElementById("file-status");
  assert.equal(status.textContent, "Saved");
  assert.ok(!status.classList.contains("settled"));
  await app.until(() => status.classList.contains("settled"), 4000);
  assert.ok(status.classList.contains("settled"));
  typeAt(app, 0, "x");
  assert.match(status.textContent, /^Saving…/);
  assert.ok(!status.classList.contains("settled"));
  await app.settle(700);
  assert.equal(status.textContent, "Saved");
  assert.ok(!status.classList.contains("settled"));
});

test("switching files restarts the fade", async () => {
  const fake = lists({ open: ["/docs/a.md", "/docs/b.md"] });
  const app = await bootMainWindow({
    instance: 16,
    disk: { "/docs/a.md": "one\n", "/docs/b.md": "two\n" },
    handlers: fake.handlers
  });
  const status = doc(app).getElementById("file-status");
  await app.until(() => status.classList.contains("settled"), 4000);
  const names = [...doc(app).querySelectorAll(".open-file-name")];
  const other = names.find((item) => !item.closest(".open-file-item").classList.contains("active"));
  other.click();
  await app.settle();
  assert.equal(status.textContent, "Saved");
  assert.ok(!status.classList.contains("settled"));
});

test("the hidden path text follows the active file", async () => {
  const fake = lists({ open: ["/docs/a.md", "/docs/b.md"] });
  const app = await bootMainWindow({
    instance: 40,
    disk: { "/docs/a.md": "one\n", "/docs/b.md": "two\n" },
    handlers: fake.handlers
  });
  const path = doc(app).getElementById("file-status-path");
  const active = () => doc(app).getElementById("main-title").textContent;
  const first = active();
  assert.equal(path.textContent, `/docs/${first}`);
  const other = [...doc(app).querySelectorAll(".open-file-name")].find((item) => !item.closest(".open-file-item").classList.contains("active"));
  other.click();
  await app.settle();
  assert.notEqual(active(), first);
  assert.equal(path.textContent, `/docs/${active()}`);
});

test("a file open in another window is not reported as an error here", async () => {
  const fake = lists();
  const app = await bootMainWindow({
    instance: 13,
    platform: "MacIntel",
    handlers: {
      ...fake.handlers,
      file_open_dialog: () => "/docs/b.md",
      file_doc_open: () => { throw { code: "OpenElsewhere", message: "b.md is open in another window." }; }
    }
  });
  app.click("start-open-file-btn");
  await app.settle();
  assert.equal(doc(app).getElementById("app-notification").hidden, true);
  assert.equal(doc(app).getElementById("start-page").hidden, false);
});

test("the open list carries the active file", async () => {
  const fake = lists({ open: ["/docs/a.md"] });
  const app = await bootMainWindow({
    instance: 14,
    platform: "MacIntel",
    disk: { "/docs/a.md": "a", "/docs/plan.md": "# Plan\n" },
    handlers: { ...fake.handlers, file_open_dialog: () => "/docs/plan.md" }
  });
  app.click("start-open-file-btn");
  await app.settle();
  assert.deepEqual(
    app.invocations.findLast((call) => call.command === "file_set_open").args,
    { paths: ["/docs/a.md", "/docs/plan.md"], active: "/docs/plan.md" }
  );
});

test("a file handed over before the page started is shown", async () => {
  const fake = lists();
  const app = await bootMainWindow({
    instance: 43,
    disk: { "/docs/plan.md": "# Plan\n" },
    handlers: { ...fake.handlers, file_take_pending: () => [{ path: "/docs/plan.md", view: null }] }
  });
  assert.equal(doc(app).getElementById("start-page").hidden, true);
  assert.equal(app.editorText(), "# Plan\n");
});

test("outside edits apply to a clean file, merge with typing, and ask on a conflict", async () => {
  const fake = lists({ open: ["/docs/a.md"] });
  const app = await bootMainWindow({ instance: 2, disk: { "/docs/a.md": "one\ntwo\n" }, handlers: fake.handlers });
  assert.equal(app.editorText(), "one\ntwo\n", "the file open at quit reopens");

  app.editor().dispatch({ selection: { anchor: 2 } });
  app.fileDocs.outsideEdit("/docs/a.md", "one\ntwo\nthree\n");
  await app.settle();
  assert.equal(app.editorText(), "one\ntwo\nthree\n");
  assert.equal(app.editor().state.selection.main.head, 2, "the cursor stays put");
  assert.equal(doc(app).getElementById("file-banner").hidden, true);
  assert.equal(app.fileDocs.writes.length, 0, "a reload is not written back");

  typeAt(app, 0, "my ");
  await app.settle(250);
  app.fileDocs.outsideEdit("/docs/a.md", "one\ntwo\nTHREE\n", { merged: "my one\ntwo\nTHREE\n" });
  await app.settle();
  assert.equal(app.editorText(), "my one\ntwo\nTHREE\n");
  assert.equal(doc(app).getElementById("file-banner").hidden, true);
  const { undo } = await import("../src/vendor/codemirror.js");
  undo(app.editor());
  assert.equal(app.editorText(), "one\ntwo\nTHREE\n", "undo still takes back only my typing");
  typeAt(app, 0, "my ");
  await app.settle(700);
  assert.equal(app.fileDocs.files.get("/docs/a.md"), "my one\ntwo\nTHREE\n");

  typeAt(app, 0, "mine ");
  await app.settle(250);
  app.fileDocs.outsideEdit("/docs/a.md", "theirs\n");
  await app.settle();
  const banner = doc(app).getElementById("file-banner");
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /changed on disk/);
  assert.equal(app.editorText(), "mine my one\ntwo\nTHREE\n", "your edit stays until you choose");

  app.click("file-banner-primary-btn");
  await app.settle();
  assert.equal(app.editorText(), "theirs\n");
  assert.equal(banner.hidden, true);
  assert.equal(doc(app).getElementById("main-title").textContent, "a.md");
});

test("Keep mine overwrites the outside change; a removed file offers Save As", async () => {
  const fake = lists({ open: ["/docs/b.md"] });
  const app = await bootMainWindow({ instance: 3, disk: { "/docs/b.md": "base\n" }, handlers: fake.handlers });
  typeAt(app, 0, "edit ");
  await app.settle(250);
  app.fileDocs.outsideEdit("/docs/b.md", "theirs\n");
  await app.settle(500);
  assert.equal(app.fileDocs.writes.length, 0, "no autosave while the conflict is open");
  app.click("file-banner-secondary-btn");
  await app.settle();
  assert.deepEqual(app.fileDocs.writes.at(-1), { path: "/docs/b.md", text: "edit base\n" });
  assert.equal(doc(app).getElementById("file-banner").hidden, true);

  app.fileDocs.remove("/docs/b.md");
  await app.settle();
  assert.match(doc(app).getElementById("file-banner").textContent, /no longer on disk/);
  assert.equal(doc(app).getElementById("file-banner-primary-btn").textContent, "Save As…");
});

test("Cmd+W closes files and the last one brings back the start page", async () => {
  const fake = lists({ open: ["/docs/1.md", "/docs/2.md"] });
  const app = await bootMainWindow({ instance: 4, platform: "MacIntel", disk: { "/docs/1.md": "1", "/docs/2.md": "2" }, handlers: fake.handlers });
  assert.equal(app.editorText(), "2");
  assert.equal(key(app, { key: "w", code: "KeyW", metaKey: true }).defaultPrevented, true);
  await app.settle();
  assert.equal(app.editorText(), "1");
  assert.equal(app.fileDocs.isOpen("/docs/2.md"), false, "closed in the registry");
  key(app, { key: "w", code: "KeyW", metaKey: true });
  await app.settle();
  assert.equal(doc(app).getElementById("start-page").hidden, false);
  assert.equal(doc(app).getElementById("files-sidebar").hidden, true);
  assert.deepEqual(app.invocations.findLast((call) => call.command === "file_set_open").args, { paths: [], active: null });
});

test("a new file is saved with Save As, then autosaved; closing an unsaved one asks first", async () => {
  const fake = lists();
  const answers = ["cancel", "discard"];
  let disk;
  const app = await bootMainWindow({
    instance: 5,
    platform: "MacIntel",
    handlers: {
      ...fake.handlers,
      file_save_as_dialog: ({ text }) => {
        disk.set("/docs/new.md", text);
        return { path: "/docs/new.md", name: "new.md", hash: `h-${text.length}` };
      },
      file_confirm_discard: () => answers.shift()
    }
  });
  disk = app.fileDocs.files;
  key(app, { key: "n", code: "KeyN", metaKey: true });
  await app.settle();
  assert.equal(doc(app).getElementById("main-title").textContent, "Untitled.md");
  await app.type("draft\n");
  assert.equal(app.invocations.some((call) => call.command === "file_doc_push"), false, "a new file has no document yet");
  key(app, { key: "s", code: "KeyS", metaKey: true });
  await app.settle();
  assert.equal(app.invocations.findLast((call) => call.command === "file_save_as_dialog").args.text, "draft\n");
  assert.equal(doc(app).getElementById("main-title").textContent, "new.md");
  typeAt(app, 6, "more\n");
  await app.settle(700);
  assert.deepEqual(app.fileDocs.writes, [{ path: "/docs/new.md", text: "draft\nmore\n" }]);

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
  const fake = lists({ open: ["/docs/q.md"] });
  const app = await bootMainWindow({ instance: 6, disk: { "/docs/q.md": "q" }, handlers: fake.handlers });
  app.fileDocs.failWrites("disk full");
  typeAt(app, 1, "!");
  await app.emit("sodilaud-quit-requested");
  await app.settle();
  assert.deepEqual(app.invocations.filter((call) => call.command === "quit_window_done").map((call) => call.args.ok), [false]);
  assert.match(doc(app).getElementById("file-banner").textContent, /Could not save q.md: disk full/);

  app.fileDocs.failWrites(null);
  await app.emit("sodilaud-quit-requested");
  await app.settle();
  assert.deepEqual(app.invocations.filter((call) => call.command === "quit_window_done").map((call) => call.args.ok), [false, true]);
  assert.equal(app.fileDocs.files.get("/docs/q.md"), "q!");
});

test("the start page lists recent files and drops one that is gone", async () => {
  const fake = lists();
  fake.setRecent([
    { path: "/docs/here.md", name: "here.md", exists: true },
    { path: "/docs/gone.md", name: "gone.md", exists: false }
  ]);
  const app = await bootMainWindow({ instance: 7, disk: { "/docs/here.md": "here" }, handlers: { ...fake.handlers, file_forget_recent: () => null } });
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

test("Reading mode renders the file and follows outside edits; a file opened from Finder is shown", async () => {
  const fake = lists({ open: ["/docs/r.md"] });
  let pending = [];
  const app = await bootMainWindow({
    instance: 8,
    disk: { "/docs/r.md": "# Heading\n", "/docs/finder.md": "from finder" },
    beforeBoot: (dom) => { dom.window.marked = marked; },
    handlers: { ...fake.handlers, file_take_pending: () => { const taken = pending; pending = []; return taken; } }
  });
  app.click("mode-reading");
  assert.equal(doc(app).getElementById("file-editor").classList.contains("mode-reading"), true);
  assert.match(doc(app).getElementById("markdown-preview").innerHTML, /<h1[^>]*>(?:<button[^>]*><\/button>)?Heading<\/h1>/);
  app.fileDocs.outsideEdit("/docs/r.md", "# Changed\n");
  await app.settle();
  assert.match(doc(app).getElementById("markdown-preview").innerHTML, /<h1[^>]*>(?:<button[^>]*><\/button>)?Changed<\/h1>/);
  assert.ok(app.emitted.some((event) => event.name === "prefs-changed" && event.payload.key === "sodilaud_layout_mode"));
  app.click("mode-live");

  pending = [{ path: "/docs/finder.md", view: null }];
  await app.emit("file-open-request");
  await app.settle();
  assert.equal(app.editorText(), "from finder");
  assert.equal(doc(app).querySelectorAll(".open-file-item").length, 2);
});

test("the Reviewed toggle in Reading mode writes the mark into the file", async () => {
  const fake = lists({ open: ["/docs/book.md"] });
  const fence = "```diff path=src/a.rs hunk=h3f2a1 lines=1-1";
  const app = await bootMainWindow({
    instance: 10,
    disk: { "/docs/book.md": `# Book\n\n${fence}\n@@ -1 +1 @@\n-a\n+b\n\`\`\`\n` },
    beforeBoot: (dom) => { dom.window.marked = marked; },
    handlers: fake.handlers
  });
  app.click("mode-reading");
  const widget = doc(app).querySelector("#markdown-preview .diff-hunk");
  assert.ok(widget);
  widget.querySelector(".diff-hunk-reviewed").click();
  assert.ok(app.editorText().includes(`${fence} reviewed\n`));
  await app.settle(700);
  assert.ok(app.fileDocs.writes.at(-1).text.includes(`${fence} reviewed\n`));
});

test("the outline lists headings with review progress and the status bar counts reviewed hunks", async () => {
  const fake = lists({ open: ["/docs/book.md"] });
  const fence = (id, reviewed = "") => `\`\`\`diff path=src/a.rs hunk=${id} lines=1-1${reviewed}\n@@ -1 +1 @@\n-a\n+b\n\`\`\``;
  const text = `# Book\n\nIntro\n\n## Engine\n\n${fence("h00001", " reviewed")}\n\n${fence("h00002")}\n\n## Notes\n\nDeep note\n`;
  const app = await bootMainWindow({
    instance: 11,
    disk: { "/docs/book.md": text },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    },
    handlers: fake.handlers
  });
  const page = doc(app);
  const rows = () => [...page.querySelectorAll(".outline-item")].map((item) => item.textContent);
  assert.equal(page.getElementById("outline-section").hidden, false);
  assert.deepEqual(rows(), ["Book1/2", "Engine1/2", "Notes"]);
  const status = page.getElementById("review-progress");
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "1/2 reviewed");

  app.click("mode-reading");
  page.querySelector("#markdown-preview [data-anchor=engine] .heading-fold").click();
  assert.equal(page.querySelector("#markdown-preview .diff-hunk").classList.contains("section-fold-hidden"), true);
  page.querySelectorAll(".diff-hunk-reviewed")[1].click();
  await app.until(() => status.textContent === "2/2 reviewed");
  assert.equal(status.textContent, "2/2 reviewed");
  assert.deepEqual(rows(), ["Book2/2", "Engine2/2", "Notes"]);
  assert.equal(page.querySelector("#markdown-preview .diff-hunk").classList.contains("section-fold-hidden"), true, "the fold survives the re-render");

  page.querySelector("#markdown-preview [data-anchor=book] .heading-fold").click();
  assert.equal(page.querySelector("#markdown-preview [data-anchor=notes]").classList.contains("section-fold-hidden"), true);
  page.querySelectorAll(".outline-link")[2].click();
  assert.equal(page.querySelector("#markdown-preview [data-anchor=notes]").classList.contains("section-fold-hidden"), false, "following the outline unfolds the section");

  app.click("mode-live");
  assert.ok(page.querySelector(".cm-section-folded"), "Live mode keeps the Engine fold");
  page.getElementById("outline-toggle-btn").click();
  assert.equal(page.getElementById("outline-list").hidden, true);
});

test("a file without headings or hunks shows no outline and no review count", async () => {
  const fake = lists({ open: ["/docs/plain.md"] });
  const app = await bootMainWindow({ instance: 12, disk: { "/docs/plain.md": "just text\n" }, handlers: fake.handlers });
  assert.equal(doc(app).getElementById("outline-section").hidden, true);
  assert.equal(doc(app).getElementById("review-progress").hidden, true);
});

const BOOK_TEXT = "# Book\n\nIntro\n\n## Engine\n\nBody\n\n## Notes\n\nDeep\n";

test("the outline marks the section in view in Reading mode", async () => {
  const fake = lists({ open: ["/docs/book.md"] });
  let scrolls = 0;
  const app = await bootMainWindow({
    instance: 41,
    disk: { "/docs/book.md": BOOK_TEXT },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.HTMLElement.prototype.scrollIntoView = () => { scrolls += 1; };
    },
    handlers: fake.handlers
  });
  const page = doc(app);
  app.click("mode-reading");
  const preview = page.getElementById("markdown-preview");
  const rect = (top) => () => ({ top, bottom: top });
  preview.getBoundingClientRect = rect(0);
  const place = (book, engine, notes) => {
    page.querySelector("#markdown-preview [data-anchor=book]").getBoundingClientRect = rect(book);
    page.querySelector("#markdown-preview [data-anchor=engine]").getBoundingClientRect = rect(engine);
    page.querySelector("#markdown-preview [data-anchor=notes]").getBoundingClientRect = rect(notes);
  };
  const current = () => page.querySelector(".outline-item.current");
  place(-300, -20, 400);
  const before = scrolls;
  preview.dispatchEvent(new app.dom.window.Event("scroll"));
  assert.equal(current().dataset.outlineId, "engine");
  assert.equal(current().querySelector(".outline-link").getAttribute("aria-current"), "location");
  assert.equal(scrolls, before + 1);
  place(-300, -20, -5);
  preview.dispatchEvent(new app.dom.window.Event("scroll"));
  assert.equal(current().dataset.outlineId, "notes");
  const after = scrolls;
  preview.dispatchEvent(new app.dom.window.Event("scroll"));
  assert.equal(scrolls, after, "an unchanged section does not scroll the sidebar");
});

test("the outline mark follows Live scrolling and survives a re-render", async () => {
  const fake = lists({ open: ["/docs/book.md"] });
  let scrolls = 0;
  const app = await bootMainWindow({
    instance: 42,
    disk: { "/docs/book.md": BOOK_TEXT },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.HTMLElement.prototype.scrollIntoView = () => { scrolls += 1; };
    },
    handlers: fake.handlers
  });
  const page = doc(app);
  const view = app.editor();
  view.lineBlockAtHeight = () => ({ from: BOOK_TEXT.indexOf("## Notes") });
  view.scrollDOM.dispatchEvent(new app.dom.window.Event("scroll"));
  const current = () => page.querySelector(".outline-item.current");
  assert.equal(current().dataset.outlineId, "notes");
  const before = scrolls;
  typeAt(app, BOOK_TEXT.length, "x");
  await app.settle(250);
  assert.equal(current().dataset.outlineId, "notes");
  assert.equal(scrolls, before, "a re-render does not scroll the sidebar");
});

test("switching files forgets the marked section", async () => {
  const fake = lists({ open: ["/docs/a.md", "/docs/b.md"] });
  let scrolls = 0;
  const app = await bootMainWindow({
    instance: 17,
    disk: { "/docs/a.md": BOOK_TEXT, "/docs/b.md": BOOK_TEXT },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.HTMLElement.prototype.scrollIntoView = () => { scrolls += 1; };
    },
    handlers: fake.handlers
  });
  const page = doc(app);
  app.editor().lineBlockAtHeight = () => ({ from: BOOK_TEXT.indexOf("## Notes") });
  app.editor().scrollDOM.dispatchEvent(new app.dom.window.Event("scroll"));
  assert.equal(page.querySelector(".outline-item.current").dataset.outlineId, "notes");
  const before = scrolls;
  const other = [...page.querySelectorAll(".open-file-name")]
    .find((item) => !item.closest(".open-file-item").classList.contains("active"));
  other.click();
  await app.settle();
  assert.equal(page.querySelector(".outline-item.current").dataset.outlineId, "notes");
  assert.ok(scrolls > before, "the sidebar follows the new file's current row");
});

test("Save As onto the file's own path right after typing keeps every change", async () => {
  const fake = lists({ open: ["/docs/s.md"] });
  let disk;
  let app;
  const errors = [];
  app = await bootMainWindow({
    instance: 9,
    platform: "MacIntel",
    disk: { "/docs/s.md": "s" },
    beforeBoot: (dom) => { dom.window.console.error = (...args) => errors.push(args); },
    handlers: {
      ...fake.handlers,
      file_save_as_dialog: ({ text }) => {
        app.fileDocs.discard("/docs/s.md");
        disk.set("/docs/s.md", text);
        return { path: "/docs/s.md", name: "s.md", hash: `h-${text.length}` };
      }
    }
  });
  disk = app.fileDocs.files;
  const consoleError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    typeAt(app, 1, "1");
    key(app, { key: "s", code: "KeyS", metaKey: true, shiftKey: true });
    await app.settle(300);
    typeAt(app, 2, "2");
    await app.settle(2300);
    assert.equal(app.fileDocs.files.get("/docs/s.md"), "s12");
    assert.deepEqual(errors, []);
  } finally {
    console.error = consoleError;
  }
});
