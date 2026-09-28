// SPDX-License-Identifier: GPL-3.0-or-later

// Connecting and disconnecting a workspace. Rust keeps each workspace in its own
// file, so a workspace session leaves the default one exactly where it was.

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const WORKSPACE = "/tmp/sodilaud-test-workspace.db";
const FRESH = "/tmp/sodilaud-fresh-workspace.db";
let chosen = WORKSPACE;

const app = await bootApp({
  registry: {
    seed: {
      imported: true,
      notes: [
        { id: "local-1", title: "Local one", content: "local one body", updatedAt: 1, isTitleLocked: true, folderId: "local-folder" },
        { id: "local-2", title: "Local two", content: "local two body", updatedAt: 2, isTitleLocked: true }
      ],
      folders: [{ id: "local-folder", name: "Local Folder" }]
    },
    files: {
      [WORKSPACE]: {
        notes: [{ id: "ws-1", title: "Workspace note", content: "workspace body", updatedAt: 9, isTitleLocked: true, folderId: "work-folder" }],
        folders: [{ id: "work-folder", name: "Workspace Folder" }]
      }
    }
  },
  handlers: {
    select_db_file: () => chosen,
    notes_vacuum: () => {
      throw new Error("disk is read-only");
    }
  }
});

const visibleFolders = () => [...document.querySelectorAll(".note-folder-name")].map((element) => element.textContent);
const replaceText = (text) => {
  const editor = app.editor();
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, userEvent: "input.type" });
};
const vacuums = () => app.invocations.filter(({ command }) => command === "notes_vacuum").length;

test("the default workspace loads on start-up", () => {
  assert.deepEqual(app.sidebarTitles(), ["Local one", "Local two"]);
  assert.equal(document.getElementById("workspace-menu-value").textContent, "Local notes");
});

test("connecting sends unsent typing first and leaves the default workspace alone", async () => {
  replaceText("Latest local body");
  app.click("db-connect-btn");
  await app.settle(100);

  assert.equal(app.registry.path(), WORKSPACE);
  assert.deepEqual(app.sidebarTitles(), ["Workspace note"], "the workspace takes over the editor");
  assert.deepEqual(visibleFolders(), ["Workspace Folder"]);
  assert.equal(document.getElementById("workspace-menu-value").textContent, "sodilaud-test-workspace.db");
  assert.equal(document.getElementById("db-disconnect-btn").textContent, "Return to local notes");
  const local = app.registry.workspace(app.registry.DEFAULT_PATH);
  assert.equal(local.notes[0].content, "Latest local body", "typing inside the push delay reached the default workspace");
  assert.equal(vacuums(), 1, "a failed compaction still connects");
});

test("editing and folders in a workspace stay in that workspace", async () => {
  await app.type("edited inside the workspace");
  app.click("new-folder-btn");
  const input = document.querySelector(".note-folder-input");
  input.value = "Workspace Empty Folder";
  input.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await app.settle();

  const workspace = app.registry.workspace(WORKSPACE);
  assert.equal(workspace.notes[0].content, "edited inside the workspace");
  assert.deepEqual(workspace.folders.map(folder => folder.name), ["Workspace Folder", "Workspace Empty Folder"]);
  const local = app.registry.workspace(app.registry.DEFAULT_PATH);
  assert.deepEqual(local.folders.map(folder => folder.name), ["Local Folder"]);
  assert.equal(local.notes[0].content, "Latest local body");
});

test("disconnecting sends unsent typing and returns the default workspace", async () => {
  replaceText("Latest workspace body");
  app.click("db-disconnect-btn");
  await app.settle(100);

  assert.equal(app.registry.workspace(WORKSPACE).notes[0].content, "Latest workspace body");
  assert.deepEqual(app.sidebarTitles(), ["Local one", "Local two"]);
  assert.deepEqual(visibleFolders(), ["Local Folder"]);
  assert.equal(document.getElementById("workspace-menu-value").textContent, "Local notes");
  assert.equal(app.editorText(), "Latest local body");
  assert.equal(vacuums(), 2);
});

test("connecting a new, empty file starts it with the open collection", async () => {
  chosen = FRESH;
  app.click("db-connect-btn");
  await app.settle(100);
  assert.deepEqual(app.sidebarTitles(), ["Local one", "Local two"]);
  assert.deepEqual(app.registry.workspace(FRESH).notes.map(note => note.id), ["local-1", "local-2"]);
  app.click("db-disconnect-btn");
  await app.settle(100);
});

test("preview links are opened through the system browser", async () => {
  const preview = app.dom.window.document.getElementById("markdown-preview");
  preview.innerHTML =
    '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>' +
    '<a href="javascript:alert(1)">unsafe</a>' +
    '<a href="#a-heading">anchor</a>';

  const click = (selector) => {
    app.invocations.length = 0;
    preview.querySelector(selector).dispatchEvent(
      new app.dom.window.MouseEvent("click", { bubbles: true, cancelable: true })
    );
    return app.settle(20);
  };

  await click('a[href^="https"]');
  assert.deepEqual(app.invocations, [
    { command: "confirm_and_open_url", args: { url: "https://example.com/docs" } }
  ]);

  await click('a[href^="javascript"]');
  assert.deepEqual(app.invocations, [], "an unsupported scheme never reaches the system");

  await click('a[href^="#"]');
  assert.deepEqual(app.invocations, [], "an in-document anchor never reaches the system");
});
