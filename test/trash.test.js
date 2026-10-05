// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readTrash } from "../src/trash.js";

const note = { id: "n", title: "Keep me", content: "Full content 📝", updatedAt: 1, isTitleLocked: true, isPinned: true, folderId: "work" };

test("valid local trash reads back for the import", () => {
  const entries = [{ id: "t", note, deletedAt: 2, folderName: "Work" }];
  assert.deepEqual(readTrash(JSON.stringify(entries)), entries);
  assert.deepEqual(readTrash(null), []);
});

test("corrupt trash is refused, so the import leaves it where it is", () => {
  for (const raw of ["broken", "{}", '[{"id":"bad"}]', JSON.stringify([{ id: "t", note, deletedAt: 1 }, { id: "t", note, deletedAt: 2 }])]) {
    assert.throws(() => readTrash(raw));
  }
});
