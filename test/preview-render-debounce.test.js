// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootApp } from "./helpers/app-harness.js";

function typeInto(app, pane, text) {
  const view = app.editor(pane);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
}

test("the primary reading preview renders at once and the secondary one after rapid edits", async () => {
  const app = await bootApp({
    storage: {
      sodilaud_layout_mode: "reading",
      sodilaud_notes: [{
        id: "render-note",
        title: "Render note",
        content: "initial",
        updatedAt: 2,
        isTitleLocked: true
      }, {
        id: "secondary-render-note",
        title: "Secondary render note",
        content: "secondary initial",
        updatedAt: 1,
        isTitleLocked: true
      }]
    },
    beforeBoot: (dom) => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  const preview = document.getElementById("markdown-preview");
  assert.ok(document.getElementById("app").classList.contains("mode-reading"));
  const initialPreview = preview.innerHTML;
  assert.match(initialPreview, /initial/);

  for (const value of ["first", "second", "# final"]) typeInto(app, "primary", value);

  assert.equal(preview.querySelector("h1").textContent, "final");
  assert.doesNotMatch(preview.textContent, /first|second/);

  document.getElementById("split-note-btn").click();
  const secondaryPreview = document.getElementById("secondary-markdown-preview");
  const initialSecondaryPreview = secondaryPreview.innerHTML;
  assert.match(initialSecondaryPreview, /secondary initial/);

  for (const value of ["secondary first", "secondary second", "## secondary final"]) {
    typeInto(app, "secondary", value);
  }

  assert.equal(secondaryPreview.innerHTML, initialSecondaryPreview);
  await app.settle(200);
  assert.equal(secondaryPreview.querySelector("h2").textContent, "secondary final");
});

test("typing outside Reading mode leaves the preview alone until the mode changes", async () => {
  const app = await bootApp({
    instance: 2,
    storage: {
      sodilaud_layout_mode: "live",
      sodilaud_notes: [{ id: "live-note", title: "Live note", content: "initial", updatedAt: 1, isTitleLocked: true }]
    },
    beforeBoot: (dom) => { dom.window.marked = marked; }
  });
  const { document } = app.dom.window;
  const preview = document.getElementById("markdown-preview");
  const before = preview.innerHTML;
  typeInto(app, "primary", "# typed");
  assert.equal(preview.innerHTML, before);
  await app.settle(200);
  assert.equal(preview.innerHTML, before);
  app.click("mode-reading");
  await app.settle();
  assert.equal(preview.querySelector("h1").textContent, "typed");
});
