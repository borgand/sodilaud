// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { EditorState, EditorView } from "../src/vendor/codemirror.js";
import { installEditorDom } from "./helpers/cm-dom.js";
import { applyUpdatesToText, createNoteSync } from "../src/note-sync.js";
import { createFakeRegistry } from "./helpers/fake-registry.js";

const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

function setup(seed) {
  const env = installEditorDom();
  const listeners = [];
  const registry = createFakeRegistry({
    seed: { imported: true, ...seed },
    emit: (name, payload) => setTimeout(() => listeners.forEach(listener => listener(name, structuredClone(payload))), 0)
  });
  const invoke = async (command, args) => structuredClone(registry.commands[command](structuredClone(args)));
  const collectionId = registry.state().collectionId;
  const sync = createNoteSync({ invoke, collectionId: () => collectionId, pushDelay: 5 });
  listeners.push((name, payload) => { if (name === "notes-doc-updates") sync.receive(payload); });
  const open = (noteId, text, version = 0) => new EditorView({
    state: EditorState.create({ doc: text, extensions: sync.extension(noteId, version) }),
    parent: env.document.getElementById("host")
  });
  return { env, registry, sync, open };
}

test("registry updates apply to plain text by UTF-16 offsets", () => {
  assert.equal(applyUpdatesToText("a😀b", [{ changes: [1, [2, "õ"], 1] }]), "aõb");
  assert.equal(applyUpdatesToText("", [{ changes: [[0, "x", "y"]] }]), "x\ny");
});

test("an editor replaced right after typing still sends its change, and nothing twice", async () => {
  const { env, registry, sync, open } = setup({ notes: [{ id: "n", title: "N", content: "abc", updatedAt: 1, isTitleLocked: true }] });
  try {
    const view = open("n", "abc");
    view.dispatch({ changes: { from: 3, insert: "d" } });
    view.setState(EditorState.create({ doc: "other" }));
    assert.equal(sync.pending(), true);
    assert.equal(await sync.flush(), true);
    await settle();
    assert.equal(registry.workspace().notes[0].content, "abcd");
    assert.equal(registry.workspace().notes[0].version, 1);
    view.destroy();
  } finally { env.cleanup(); }
});

test("two editors of one note converge on concurrent edits", async () => {
  const { env, registry, sync, open } = setup({ notes: [{ id: "n", title: "N", content: "middle", updatedAt: 1, isTitleLocked: true }] });
  try {
    const left = open("n", "middle");
    const right = open("n", "middle");
    left.dispatch({ changes: { from: 0, insert: "start " } });
    right.dispatch({ changes: { from: 6, insert: " end" } });
    registry.agentAppend("n", "!");
    await settle(100);
    assert.equal(await sync.flush(), true);
    await settle(100);
    const saved = registry.workspace().notes[0].content;
    assert.equal(left.state.doc.toString(), saved);
    assert.equal(right.state.doc.toString(), saved);
    // Both inserts landed at the old end; the agent's was accepted first.
    assert.equal(saved, "start middle! end");
    left.destroy();
    right.destroy();
  } finally { env.cleanup(); }
});

test("a client whose note was trashed gives up instead of retrying forever", async () => {
  const { env, registry, sync, open } = setup({ notes: [
    { id: "n", title: "N", content: "x", updatedAt: 1, isTitleLocked: true },
    { id: "m", title: "M", content: "y", updatedAt: 1, isTitleLocked: true }
  ] });
  try {
    const view = open("n", "x");
    registry.agentTrash("n");
    view.dispatch({ changes: { from: 1, insert: "z" } });
    await settle(50);
    assert.equal(sync.pending(), false);
    assert.equal(await sync.flush(), true);
    view.destroy();
  } finally { env.cleanup(); }
});
