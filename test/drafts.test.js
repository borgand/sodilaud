// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const DRAFT = "/data/drafts/0b1/Plan.md";

// The fake file registry, with the draft flag and the draft commands Rust adds.
async function bootWithDraft({ instance, handlers = {} }) {
  let open = [];
  let pending = [];
  let drafts = [{ path: DRAFT, name: "Plan.md", createdAt: 1 }];
  let app = null;
  const forgetDraft = (path) => {
    app.fileDocs.discard(path);
    app.fileDocs.files.delete(path);
    drafts = drafts.filter((draft) => draft.path !== path);
  };
  app = await bootMainWindow({
    instance,
    platform: "MacIntel",
    disk: { [DRAFT]: "# Plan\n" },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open, recent: [], drafts: structuredClone(drafts) }),
      file_set_open: ({ paths }) => { open = paths; },
      file_take_pending: () => pending.splice(0),
      file_doc_open: (args) => ({ ...app.fileDocs.commands.file_doc_open(args), draft: args.path.startsWith("/data/drafts/") }),
      draft_discard: ({ path }) => { forgetDraft(path); return true; },
      draft_save_to_notes: ({ path }) => { forgetDraft(path); return { noteId: "n1" }; },
      ...handlers
    }
  });
  const openDraft = async () => {
    pending = [{ path: DRAFT, view: null }];
    app.emit("file-open-request", {});
    await app.settle();
  };
  return { app, openDraft, drafts: () => drafts };
}

const doc = (app) => app.dom.window.document;
const byId = (app, id) => doc(app).getElementById(id);
const key = (app, init) => {
  doc(app).dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
};
const typeAt = (app, from, insert) => app.editor().dispatch({ changes: { from, insert }, userEvent: "input.type" });
const called = (app, command) => app.invocations.filter((call) => call.command === command);
const lastIndex = (app, command) => app.invocations.findLastIndex((call) => call.command === command);

test("a draft opens with the Draft tag and the draft bar", async () => {
  const { app, openDraft } = await bootWithDraft({ instance: 1 });
  assert.equal(byId(app, "draft-bar").hidden, true);
  await openDraft();
  assert.equal(app.editorText(), "# Plan\n");
  assert.equal(byId(app, "draft-bar").hidden, false);
  assert.equal(byId(app, "draft-bar").textContent.includes("Draft from an agent. It stays in Sodilaud until you save it."), true);
  const row = doc(app).querySelector(".open-file-item");
  assert.equal(row.querySelector(".open-file-tag").textContent, "Draft");
  assert.deepEqual([...row.children].map((child) => child.className), ["open-file-name", "open-file-tag", "open-file-close"]);
  assert.equal(byId(app, "menu-browse-folder-btn").disabled, true);
});

test("Cmd+S on a draft asks where to save it", async () => {
  const { app, openDraft } = await bootWithDraft({ instance: 2, handlers: { file_save_as_dialog: () => null } });
  await openDraft();
  key(app, { key: "s", code: "KeyS", metaKey: true });
  await app.settle();
  assert.equal(called(app, "file_save_as_dialog").length, 1);
  assert.equal(called(app, "file_doc_save").length, 0);
  assert.equal(called(app, "draft_discard").length, 0, "a cancelled Save As keeps the draft");
  assert.equal(byId(app, "draft-bar").hidden, false);
});

test("saving a draft as a file discards the draft", async () => {
  let disk;
  const { app, openDraft } = await bootWithDraft({
    instance: 3,
    handlers: {
      file_save_as_dialog: ({ text }) => {
        disk.set("/d/plan.md", text);
        return { path: "/d/plan.md", name: "plan.md", hash: `h-${text.length}` };
      }
    }
  });
  disk = app.fileDocs.files;
  await openDraft();
  app.click("draft-save-as-btn");
  await app.settle();
  assert.deepEqual(called(app, "draft_discard").map((call) => call.args), [{ path: DRAFT, ask: false }]);
  assert.equal(disk.get("/d/plan.md"), "# Plan\n");
  assert.equal(byId(app, "main-title").textContent, "plan.md");
  assert.equal(byId(app, "draft-bar").hidden, true);
  assert.ok(!doc(app).querySelector(".open-file-tag"));
  assert.deepEqual([...doc(app).querySelectorAll(".open-file-name")].map((item) => item.title), ["/d/plan.md"]);
  assert.equal(byId(app, "menu-browse-folder-btn").disabled, false);
});

test("Save to Quick Notes sends the last keystrokes first and closes the draft", async () => {
  const { app, openDraft } = await bootWithDraft({ instance: 4 });
  await openDraft();
  typeAt(app, 7, "- ship it\n");
  app.click("draft-save-notes-btn");
  await app.settle();
  const pushed = lastIndex(app, "file_doc_push");
  assert.ok(pushed !== -1);
  assert.ok(pushed < lastIndex(app, "draft_save_to_notes"));
  assert.deepEqual(called(app, "draft_save_to_notes").map((call) => call.args), [{ path: DRAFT }]);
  assert.equal(called(app, "file_doc_close").length, 0, "Rust already dropped the document");
  assert.equal(doc(app).querySelectorAll(".open-file-item").length, 0);
  assert.equal(byId(app, "start-page").hidden, false);
  assert.equal(byId(app, "drafts-section").hidden, true);
  assert.ok(doc(app).activeElement !== doc(app).body, "focus does not fall to the page");
});

test("Discard asks and keeps the draft when cancelled", async () => {
  let answer = false;
  const { app } = await bootWithDraft({
    instance: 5,
    handlers: { draft_discard: () => answer }
  });
  // Opened from the start page's Drafts list.
  doc(app).querySelector("#drafts-list .start-link").click();
  await app.settle();
  assert.equal(byId(app, "draft-bar").hidden, false);

  app.click("draft-discard-btn");
  await app.settle();
  assert.deepEqual(called(app, "draft_discard").map((call) => call.args), [{ path: DRAFT, ask: true }]);
  assert.equal(doc(app).querySelectorAll(".open-file-item").length, 1, "cancelled: still open");
  assert.equal(byId(app, "draft-bar").hidden, false);

  answer = true;
  app.click("draft-discard-btn");
  await app.settle();
  assert.equal(doc(app).querySelectorAll(".open-file-item").length, 0);
  assert.equal(called(app, "file_doc_close").length, 0);
  assert.equal(byId(app, "start-page").hidden, false);
  assert.ok(doc(app).activeElement !== doc(app).body, "focus does not fall to the page");
});

test("closing a draft keeps it on the start page", async () => {
  const { app, openDraft, drafts } = await bootWithDraft({ instance: 6 });
  assert.equal(byId(app, "drafts-section").hidden, false, "listed at start-up");
  await openDraft();
  key(app, { key: "w", code: "KeyW", metaKey: true });
  await app.settle();
  assert.equal(called(app, "file_save_as_dialog").length, 0, "closing does not ask where to save");
  assert.deepEqual(called(app, "file_doc_close").map((call) => call.args), [{ path: DRAFT }]);
  assert.equal(drafts().length, 1);
  assert.equal(byId(app, "start-page").hidden, false);
  assert.equal(byId(app, "drafts-section").hidden, false);
  const links = [...doc(app).querySelectorAll("#drafts-list .start-link")];
  assert.deepEqual(links.map((link) => link.textContent), ["Plan.md"]);

  links[0].click();
  await app.settle();
  assert.equal(app.editorText(), "# Plan\n");
  assert.equal(byId(app, "draft-bar").hidden, false);
});
