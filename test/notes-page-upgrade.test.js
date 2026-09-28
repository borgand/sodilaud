// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

// The panel must open the collection the old main window kept, untouched.
test("an upgrading user's local notes open in Quick Notes without a new welcome note", async () => {
  const notes = [
    { id: "a", title: "Groceries", content: "Groceries\n- milk", updatedAt: 2, isTitleLocked: false },
    { id: "b", title: "Plan", content: "Plan\n1. ship", updatedAt: 1, isTitleLocked: false }
  ];
  const app = await bootApp({
    storage: { sodilaud_notes: notes },
    handlers: { load_workspace_preference: () => null }
  });

  assert.deepEqual(app.sidebarTitles(), ["Groceries", "Plan"]);
  assert.deepEqual(app.read("sodilaud_notes").map((note) => note.content), notes.map((note) => note.content));
});
