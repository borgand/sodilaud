// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { createFilesModel, isDirty, needsPrompt } from "../src/files.js";

let counter = 0;
const model = () => createFilesModel({ newId: () => `id-${(counter += 1)}` });
const opened = (path, text = "hello\n", fields = {}) => ({
  docId: `doc:${path}`, path, name: path.split("/").pop(), text, version: 0, savedVersion: 0, lineEnding: "lf", bom: false, external: null, ...fields
});

test("a file is dirty while changes are unsent or not yet on disk", () => {
  const files = model();
  const buffer = files.openFile(opened("/a/notes.md", "hello\n", { version: 3, savedVersion: 3 }));
  assert.equal(files.active().id, buffer.id);
  assert.equal(isDirty(buffer), false);
  assert.equal(isDirty(buffer, true), true, "typing not yet sent");
  const event = { docId: "doc:/a/notes.md", path: "/a/notes.md" };
  files.docUpdated({ ...event, version: 4 });
  assert.equal(isDirty(buffer), true, "sent, not yet saved");
  files.saved({ ...event, docId: "an earlier opening", version: 9, error: null });
  assert.equal(buffer.savedVersion, 3, "events from an earlier opening of the path are ignored");
  files.saved({ ...event, version: 4, error: null });
  assert.equal(isDirty(buffer), false);
  files.saved({ ...event, version: 3, error: "disk full" });
  assert.equal(buffer.savedVersion, 4, "a late event never moves the saved version back");
  assert.equal(buffer.error, "disk full");
});

test("opening a file that is already open switches to it", () => {
  const files = model();
  const first = files.openFile(opened("/a/one.md"));
  files.openFile(opened("/a/two.md"));
  const again = files.openFile(opened("/a/one.md", "stale"));
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
  assert.equal(isDirty(typed), true);
  assert.equal(needsPrompt(typed), true);
  assert.equal(files.close(typed.id), "needs-prompt");
  assert.equal(files.list().length, 2);
  assert.equal(files.close(empty.id), "closed");
  assert.equal(files.close(typed.id, { force: true }), "closed");
  assert.equal(files.active(), null);
});

test("closing the active file activates a neighbor", () => {
  const files = model();
  const one = files.openFile(opened("/a/1.md"));
  const two = files.openFile(opened("/a/2.md"));
  const three = files.openFile(opened("/a/3.md"));
  files.activate(two.id);
  files.close(two.id);
  assert.equal(files.active().id, three.id);
  files.close(three.id);
  assert.equal(files.active().id, one.id);
});

test("outside changes set and clear the file's disk state", () => {
  const files = model();
  const buffer = files.openFile(opened("/a/f.md"));
  const event = (path, kind) => ({ docId: `doc:${path}`, path, kind });
  assert.equal(files.external(event("/a/f.md", "conflict")), buffer);
  assert.equal(buffer.external, "conflict");
  files.external(event("/a/f.md", "applied"));
  assert.equal(buffer.external, null);
  files.external(event("/a/f.md", "removed"));
  assert.equal(buffer.external, "removed");
  files.external(event("/a/f.md", "merged"));
  assert.equal(buffer.external, null);
  assert.equal(files.external(event("/elsewhere.md", "conflict")), null);
});

test("Save As adopts the new file and a reload replaces the text", () => {
  const files = model();
  const buffer = files.newUntitled();
  files.edit(buffer.id, "draft");
  buffer.editorState = {};
  buffer.error = "denied";
  files.adopt(buffer.id, opened("/a/new.md", "draft", { version: 0 }));
  assert.equal(buffer.path, "/a/new.md");
  assert.equal(buffer.name, "new.md");
  assert.equal(buffer.editorState, null);
  assert.equal(buffer.error, null);
  assert.deepEqual(files.paths(), ["/a/new.md"]);
  files.reload(buffer.id, "fresh", 9);
  assert.equal(buffer.text, "fresh");
  assert.equal(buffer.version, 9);
  assert.equal(buffer.latest, 9);
});
