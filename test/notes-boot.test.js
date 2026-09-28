// SPDX-License-Identifier: GPL-3.0-or-later

// First launch of the Rust-owned collection: the page hands its local-storage
// notes to Rust once and leaves local storage alone, so an older release still
// finds them.

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const CURRENT = [
  { id: "local-1", title: "Set aside", content: "newer copy\r\nsecond line", updatedAt: 5, isTitleLocked: true, folderId: "work" },
  { id: "local-2", title: "Loose", content: "loose", updatedAt: 3, isTitleLocked: true, folderId: "gone" }
];
// Notes an early build set aside under their own key.
const STASHED = [
  { id: "local-1", title: "Set aside", content: "older copy", updatedAt: 1, isTitleLocked: true },
  { id: "local-3", title: "Only stashed", content: "stashed body", updatedAt: 2, isTitleLocked: true }
];
const TRASH = [
  { id: "t1", note: { id: "old", title: "Old", content: "deleted", updatedAt: 1, isTitleLocked: true }, deletedAt: 2, folderName: null }
];
const STORAGE = {
  sodilaud_notes: CURRENT,
  sodilaud_local_notes: STASHED,
  sodilaud_folders: [{ id: "work", name: "Work" }],
  sodilaud_trash: TRASH,
  sodilaud_active_db: "/old/workspace.db"
};

test("the local collection is imported once and local storage is left as it was", async () => {
  const app = await bootApp({ instance: 1, storage: STORAGE });
  const saved = await app.savedNotes();
  assert.deepEqual(saved.map(note => note.id).sort(), ["local-1", "local-2", "local-3"]);
  const kept = saved.find(note => note.id === "local-1");
  assert.equal(kept.content, "newer copy\nsecond line", "the newer copy wins, with \\n line breaks");
  assert.equal(kept.folderId, "work");
  assert.equal(saved.find(note => note.id === "local-2").folderId, null, "a missing folder is dropped");
  assert.deepEqual((await app.savedFolders()).map(folder => folder.name), ["Work"]);
  assert.deepEqual((await app.savedTrash()).map(entry => entry.id), ["t1"]);

  for (const key of ["sodilaud_notes", "sodilaud_local_notes", "sodilaud_folders", "sodilaud_trash"]) {
    assert.equal(app.storage.getItem(key), JSON.stringify(STORAGE[key]), `${key} is untouched`);
  }
  const boot = app.invocations.find(call => call.command === "notes_boot");
  assert.equal(boot.args.legacyPath, "/old/workspace.db", "Rust decides whether to adopt an old workspace path");
  assert.equal(app.storage.getItem("sodilaud_active_db"), null);
  assert.deepEqual(app.sidebarTitles().sort(), ["Loose", "Only stashed", "Set aside"]);
});

test("an imported default workspace is never imported again", async () => {
  const app = await bootApp({
    instance: 2,
    storage: STORAGE,
    registry: { seed: { imported: true, notes: [{ id: "rust", title: "In Rust", content: "x", updatedAt: 1, isTitleLocked: true }] } }
  });
  assert.equal(app.invocations.some(call => call.command === "notes_import_local"), false);
  assert.deepEqual(app.sidebarTitles(), ["In Rust"]);
});

test("a workspace Rust could not open is reported and the default one is used", async () => {
  const app = await bootApp({
    instance: 3,
    registry: { seed: { imported: true, notes: [{ id: "a", title: "A", content: "", updatedAt: 1, isTitleLocked: true }] }, fallback: "Workspace unavailable; using local notes" }
  });
  assert.equal(app.dom.window.document.getElementById("save-status").textContent, "Workspace unavailable; using local notes");
});
