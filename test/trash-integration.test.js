// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

const note = { id: "n", title: "Keep this", content: "Full body 📝", updatedAt: 1, isTitleLocked: true, isPinned: true, folderId: "f" };
const other = { id: "o", title: "Other", content: "other", updatedAt: 2, isTitleLocked: true };

test("deletions go to Rust's trash, restore from the trash UI, stay per workspace, and only the user empties them", async () => {
  const app = await bootApp({
    registry: {
      seed: { imported: true, notes: [note, other], folders: [{ id: "f", name: "Work" }] },
      files: { "/tmp/trash.db": { notes: [{ ...other, id: "w", title: "Workspace" }] } }
    },
    handlers: { select_db_file: () => "/tmp/trash.db" }
  });
  const rightClick = id => document.getElementById(id).dispatchEvent(new app.dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 700 }));
  const restore = async id => { document.querySelector(`[data-trash-id="${id}"]`).click(); await settle(); };

  // An agent's deletion reaches the sidebar and the trash list.
  app.registry.agentTrash("n");
  await settle();
  assert.deepEqual(app.sidebarTitles(), ["Other"]);
  const [entry] = await app.savedTrash();
  assert.deepEqual(entry.note, note);

  app.click("trash-btn");
  assert.equal(document.getElementById("trash-modal-backdrop").getAttribute("aria-hidden"), "false");
  assert.match(document.getElementById("trash-list").textContent, /Keep this/);
  app.registry.failOn("notes_restore");
  await restore(entry.id);
  assert.match(document.getElementById("trash-status").textContent, /Could not complete/);
  assert.equal((await app.savedTrash()).length, 1, "a failed restore keeps the entry");
  app.registry.recover("notes_restore");
  await restore(entry.id);
  const restored = (await app.savedNotes()).find(n => n.id === "n");
  assert.equal(restored.content, note.content);
  assert.equal(restored.isPinned, true);
  assert.deepEqual(await app.savedTrash(), []);
  assert.ok(app.sidebarTitles().includes("Keep this"));
  app.click("close-trash-btn");

  // The sidebar's delete button trashes through Rust too.
  document.querySelector('.note-item[data-id="n"] .note-item-delete').click();
  await settle();
  assert.equal((await app.savedNotes()).some(n => n.id === "n"), false);
  const localTrash = structuredClone(await app.savedTrash());
  assert.equal(localTrash.length, 1);

  // Each workspace has its own trash.
  app.click("db-connect-btn"); await settle(100);
  assert.deepEqual(await app.savedTrash(), []);
  document.querySelector('.note-item[data-id="w"] .note-item-delete').click();
  await settle();
  assert.equal(app.registry.workspace("/tmp/trash.db").trash.length, 1);
  assert.equal(app.sidebarTitles().length, 1, "deleting the last note leaves an empty scratchpad");

  // Emptying needs confirmation; cancelling or a failure keeps everything.
  rightClick("trash-btn");
  assert.equal(document.getElementById("trash-context-menu").style.display, "flex");
  assert.equal(document.getElementById("custom-context-menu").style.display, "none");
  app.click("trash-menu-empty");
  assert.equal(document.activeElement.id, "cancel-empty-trash-btn");
  assert.equal(document.getElementById("trash-empty-confirmation").hidden, false);
  app.click("cancel-empty-trash-btn");
  assert.equal(app.registry.workspace("/tmp/trash.db").trash.length, 1);
  app.click("close-trash-btn");
  rightClick("trash-btn"); app.click("trash-menu-empty");
  app.registry.failOn("notes_empty_trash");
  app.click("confirm-empty-trash-btn"); await settle(100);
  assert.equal(app.registry.workspace("/tmp/trash.db").trash.length, 1);
  assert.match(document.getElementById("trash-status").textContent, /Could not complete/);
  app.registry.recover("notes_empty_trash");
  app.click("confirm-empty-trash-btn"); await settle(100);
  assert.deepEqual(app.registry.workspace("/tmp/trash.db").trash, []);
  assert.deepEqual(app.registry.workspace(app.registry.DEFAULT_PATH).trash, localTrash, "emptying one workspace's trash leaves the other's");
});
