// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_NOTES_BACKUP_KEY,
  LOCAL_NOTES_KEY,
  readStoredFolders,
  readStoredNotes
} from "../src/storage.js";

test("the legacy set-aside key is distinct from the local collection", () => {
  assert.notEqual(LOCAL_NOTES_BACKUP_KEY, LOCAL_NOTES_KEY);
});

test("stored notes and folders are read back when there is content", () => {
  const notes = [{ id: "note-1", title: "One", content: "Hello" }];
  const folders = [{ id: "work", name: "Work" }, { id: "empty", name: "Empty" }];
  assert.deepEqual(readStoredNotes(JSON.stringify(notes)), notes);
  assert.deepEqual(readStoredFolders(JSON.stringify(folders)), folders);
  assert.deepEqual(readStoredFolders("not json"), []);
});

test("nothing worth preserving reads back as null", () => {
  assert.equal(readStoredNotes(null), null, "missing value");
  assert.equal(readStoredNotes(""), null, "empty value");
  assert.equal(readStoredNotes("[]"), null, "empty collection");
  assert.equal(readStoredNotes("{\"id\":\"note-1\"}"), null, "not a collection");
  assert.equal(readStoredNotes("{ truncated"), null, "unparsable value");
});
