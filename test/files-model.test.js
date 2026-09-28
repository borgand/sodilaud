// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { canAutosave, createFilesModel, isDirty, needsPrompt } from "../src/files.js";

let counter = 0;
const model = () => createFilesModel({ newId: () => `id-${(counter += 1)}` });
const file = (path, text = "hello\n") => ({
  path, name: path.split("/").pop(), text, lineEnding: "lf", bom: false, hash: "h"
});

test("opening, editing and saving tracks unsaved changes", () => {
  const files = model();
  const buffer = files.openFile(file("/a/notes.md"));
  assert.equal(files.active().id, buffer.id);
  assert.equal(isDirty(buffer), false);
  files.edit(buffer.id, "hello world\n");
  assert.equal(isDirty(buffer), true);
  assert.equal(canAutosave(buffer), true);
  files.markSaved(buffer.id, { path: buffer.path, name: buffer.name, hash: "h2" }, "hello world\n");
  assert.equal(isDirty(buffer), false);
  assert.equal(canAutosave(buffer), false);
});

test("opening a file that is already open switches to it", () => {
  const files = model();
  const first = files.openFile(file("/a/one.md"));
  files.openFile(file("/a/two.md"));
  const again = files.openFile(file("/a/one.md", "stale"));
  assert.equal(again.id, first.id);
  assert.equal(files.list().length, 2);
  assert.equal(files.active().id, first.id);
});

test("an untitled buffer with text needs a prompt to close; an empty one does not", () => {
  const files = model();
  const empty = files.newUntitled();
  const typed = files.newUntitled();
  assert.deepEqual([empty.name, typed.name], ["Untitled.md", "Untitled 2.md"]);
  files.edit(typed.id, "draft");
  assert.equal(canAutosave(typed), false, "no path yet");
  assert.equal(needsPrompt(typed), true);
  assert.equal(files.close(typed.id), "needs-prompt");
  assert.equal(files.list().length, 2);
  assert.equal(files.close(empty.id), "closed");
  assert.equal(files.close(typed.id, { force: true }), "closed");
  assert.equal(files.active(), null);
});

test("closing the active file activates a neighbor", () => {
  const files = model();
  const one = files.openFile(file("/a/1.md"));
  const two = files.openFile(file("/a/2.md"));
  const three = files.openFile(file("/a/3.md"));
  files.activate(two.id);
  files.close(two.id);
  assert.equal(files.active().id, three.id);
  files.close(three.id);
  assert.equal(files.active().id, one.id);
});

test("an outside change reloads a clean file and conflicts with an edited one", () => {
  const files = model();
  const clean = files.openFile(file("/a/clean.md"));
  const edited = files.openFile(file("/a/edited.md"));
  files.edit(edited.id, "mine");
  assert.equal(files.externalChange("/a/clean.md", "modified").action, "reload");
  files.reload(clean.id, file("/a/clean.md", "theirs"));
  assert.equal(clean.text, "theirs");
  assert.equal(isDirty(clean), false);

  const { action } = files.externalChange("/a/edited.md", "modified");
  assert.equal(action, "conflict");
  assert.equal(canAutosave(edited), false, "autosave waits for the user's choice");
  files.keepMine(edited.id);
  assert.equal(canAutosave(edited), true, "keeping mine saves over theirs");
  assert.equal(edited.text, "mine");
});

test("a removed file is marked missing and not autosaved", () => {
  const files = model();
  const buffer = files.openFile(file("/a/gone.md"));
  files.edit(buffer.id, "more");
  assert.equal(files.externalChange("/a/gone.md", "removed").action, "missing");
  assert.equal(canAutosave(buffer), false);
  assert.equal(files.externalChange("/elsewhere.md", "modified").action, "ignore");
});
