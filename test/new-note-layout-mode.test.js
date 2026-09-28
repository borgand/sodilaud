// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const app = await bootApp({
  handlers: {
    import_file_native: () => ({ title: "Imported", content: "# Imported heading" })
  },
  storage: {
    sodilaud_layout_mode: "preview",
    sodilaud_notes: [
      { id: "written", title: "Written", content: "# Heading", updatedAt: 1, isTitleLocked: true }
    ]
  }
});

const appContainer = () => document.getElementById("app");
const mode = () => ["live", "source", "reading"]
  .filter(name => appContainer().classList.contains(`mode-${name}`))
  .join(" ");

test("a blank scratchpad opens in live mode instead of an empty reading view", () => {
  assert.equal(mode(), "reading", "the remembered legacy preview mode is restored as reading");

  document.getElementById("new-note-btn").click();

  assert.equal(mode(), "live");
  assert.equal(document.getElementById("mode-live").getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("mode-reading").getAttribute("aria-pressed"), "false");
  // The buttons and the remembered mode have to agree, or the next launch
  // reopens in a mode the toolbar was not showing.
  assert.equal(app.storage.getItem("sodilaud_layout_mode"), "live");
});

// Source still shows an editor, so a new scratchpad there is already typable and
// switching would discard a layout the user picked deliberately.
test("source mode is left alone", () => {
  document.getElementById("mode-source").click();
  document.getElementById("new-note-btn").click();

  assert.equal(mode(), "source");
  assert.equal(app.editor().dom.classList.contains("cm-mode-source"), true);
  assert.equal(app.editor("secondary").dom.classList.contains("cm-mode-source"), true);
  assert.equal(app.storage.getItem("sodilaud_layout_mode"), "source");
});

// An import arrives with Markdown worth rendering, so reading is the right view.
test("a scratchpad created with content keeps reading mode", async () => {
  document.getElementById("mode-reading").click();
  assert.equal(mode(), "reading");

  document.getElementById("import-btn").click();
  await app.settle();

  assert.equal(app.editorText(), "# Imported heading");
  assert.equal(mode(), "reading");
  assert.equal(app.storage.getItem("sodilaud_layout_mode"), "reading");
});
