// SPDX-License-Identifier: GPL-3.0-or-later

// An agent writes to the collection Rust owns while the user types. Its
// changes reach every editor showing the note as collab updates: the user's
// typing, cursor and undo history survive, and nothing is applied twice.

import assert from "node:assert/strict";
import test from "node:test";
import { undo } from "../src/vendor/codemirror.js";
import { bootApp, settle } from "./helpers/app-harness.js";

const app = await bootApp({
  registry: {
    seed: {
      imported: true,
      notes: [
        { id: "n", title: "Original", content: "Original text", updatedAt: 1, isTitleLocked: true },
        { id: "other", title: "Other", content: "Other body", updatedAt: 2, isTitleLocked: false },
        { id: "free", title: "Free title", content: "Free title", updatedAt: 3, isTitleLocked: false }
      ]
    }
  }
});
const view = app.editor();
const text = () => view.state.doc.toString();

test("an agent's append lands while the user's unsent typing, selection and undo survive", async () => {
  view.focus();
  view.dispatch({ changes: { from: 0, insert: "Typed " }, userEvent: "input.type" });
  view.dispatch({ selection: { anchor: 2, head: 5 } });
  // The agent writes before this editor has sent its change.
  app.registry.agentAppend("n", "\n\nAppended 📝");
  await settle(400);

  assert.equal(text(), "Typed Original text\n\nAppended 📝");
  assert.equal(app.registry.workspace().notes[0].content, text(), "Rust holds the same text");
  assert.equal(view.state.selection.main.anchor, 2);
  assert.equal(view.state.selection.main.head, 5);
  assert.equal(document.activeElement, view.contentDOM);
  assert.equal(document.getElementById("note-title").value, "Original");
  assert.equal(text().match(/Appended/g).length, 1);

  assert.equal(undo(view), true);
  assert.equal(text(), "Original text\n\nAppended 📝", "undo removes the user's edit and keeps the agent's");
  await settle(400);
  assert.equal(app.registry.workspace().notes[0].content, "Original text\n\nAppended 📝");
});

test("the other pane on the same note follows both writers", async () => {
  document.getElementById("split-note-btn").click();
  const select = document.getElementById("secondary-note-select");
  select.value = "n";
  select.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  await settle();
  const secondary = app.editor("secondary");
  assert.equal(secondary.state.doc.toString(), text());

  view.dispatch({ changes: { from: text().length, insert: " + primary" }, userEvent: "input.type" });
  app.registry.agentAppend("n", " + agent");
  await settle(400);
  assert.equal(secondary.state.doc.toString(), text());
  assert.equal(app.registry.workspace().notes[0].content, text());
  assert.match(text(), /\+ primary/);
  assert.match(text(), /\+ agent/);
  document.getElementById("close-secondary-btn").click();
});

test("an agent's change to a note that is not open refreshes the sidebar and retitles it", async () => {
  app.registry.agentAppend("free", " grows");
  await settle(500);
  assert.ok(app.sidebarTitles().includes("Free title grows"));
  document.querySelector('.note-item[data-id="free"]').click();
  assert.equal(text(), "Free title grows");
  assert.equal(document.getElementById("note-title").value, "Free title grows");
});

test("an agent's new note appears without taking the editor", async () => {
  const active = document.querySelector(".note-item.active").dataset.id;
  app.registry.agentCreate({ id: "agent-note", title: "From the agent", content: "hello" });
  await settle();
  assert.ok(app.sidebarTitles().includes("From the agent"));
  assert.equal(document.querySelector(".note-item.active").dataset.id, active);
});

test("switching notes right after typing still sends the typing, once", async () => {
  document.querySelector('.note-item[data-id="n"]').click();
  view.dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
  document.querySelector('.note-item[data-id="other"]').click();
  assert.equal(text(), "Other body");
  document.querySelector('.note-item[data-id="n"]').click();
  assert.ok(text().startsWith("X"), "switching back shows the unsent typing");
  await settle(500);
  const saved = app.registry.workspace().notes.find(note => note.id === "n").content;
  assert.ok(saved.startsWith("XOriginal"));
  assert.equal(saved, text());
  assert.equal(undo(view), true, "undo history came back with the note");
});
