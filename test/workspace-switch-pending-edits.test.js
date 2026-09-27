// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const LOCAL_NOTES = [
  { id: "local", title: "Local", content: "Original local body", updatedAt: 1, isTitleLocked: true }
];
let workspaceNotes = [];

const app = await bootApp({
  storage: { sodilaud_notes: LOCAL_NOTES },
  handlers: {
    select_db_file: () => "/tmp/pending-edits.db",
    load_db_notes: () => workspaceNotes,
    load_db_folders: () => [],
    save_workspace_db: ({ notes }) => { workspaceNotes = notes; }
  }
});

test("connecting and disconnecting flush edits that are still inside the debounce window", async () => {
  const replaceText = (text) => {
    const editor = app.editor();
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, userEvent: "input.type" });
  };
  replaceText("Latest local body");

  app.click("db-connect-btn");
  await app.settle(100);
  assert.equal(workspaceNotes[0].content, "Latest local body");
  assert.equal(app.read("sodilaud_notes")[0].content, "Latest local body");

  replaceText("Latest workspace body");
  app.click("db-disconnect-btn");
  await app.settle(100);

  assert.equal(workspaceNotes[0].content, "Latest workspace body");
  assert.equal(app.editorText(), "Latest local body");
});
