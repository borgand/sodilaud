// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import * as Diff from "diff";
import { bootApp, settle } from "./helpers/app-harness.js";

function typeInto(app, pane, text) {
  const view = app.editor(pane);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
}

function texts(document, selector) {
  return [...document.querySelectorAll(selector)].map((node) => node.textContent);
}

const NOTES = [
  {
    id: "note-one",
    title: "First",
    content: "First note",
    updatedAt: 2,
    isTitleLocked: true
  },
  {
    id: "note-two",
    title: "Second",
    content: "Second note",
    updatedAt: 1,
    isTitleLocked: true
  }
];

test("closing split view immediately clears its enabled notification", async () => {
  const app = await bootApp({
    storage: { sodilaud_notes: NOTES }
  });
  const { document } = app.dom.window;
  const splitButton = document.getElementById("split-note-btn");
  const closeButton = document.getElementById("close-secondary-btn");
  const saveStatus = document.getElementById("save-status");

  assert.equal(saveStatus.textContent, "Saved");

  splitButton.click();
  assert.equal(saveStatus.textContent, "Dual-Note Split View enabled");
  assert.equal(splitButton.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("note-title").parentElement.id, "primary-pane-header");
  assert.equal(document.getElementById("primary-pane-header").style.display, "flex");
  assert.equal(document.querySelector(".secondary-pane-header").children[0].id, "secondary-note-title");
  assert.equal(document.querySelector(".secondary-pane-header").children[1].id, "secondary-note-select");

  closeButton.click();
  assert.equal(saveStatus.textContent, "Saved");
  assert.equal(splitButton.getAttribute("aria-pressed"), "false");
  assert.equal(document.getElementById("secondary-pane-wrapper").style.display, "none");
  assert.equal(document.getElementById("note-title").parentElement.id, "topbar-left");
  assert.equal(document.getElementById("primary-pane-header").style.display, "none");
});

test("compare mode highlights live note differences and clears with split view", async () => {
  const app = await bootApp({
    instance: 2,
    storage: {
      sodilaud_syntax_highlighting: "true",
      sodilaud_editor_line_numbers: "true",
      sodilaud_notes: [
        { ...NOTES[0], content: "# Shared heading\nLeft old wording\nSame ending" },
        { ...NOTES[1], content: "# Shared heading\nRight new wording\nSame ending" }
      ]
    }
  });
  const { document } = app.dom.window;
  const splitButton = document.getElementById("split-note-btn");
  const compareButton = document.getElementById("compare-notes-btn");
  const compareCount = document.getElementById("compare-notes-count");
  const primary = document.getElementById("editor-host");
  const secondary = document.getElementById("secondary-editor-host");

  assert.equal(compareButton.hidden, true);
  splitButton.click();
  assert.equal(compareButton.hidden, false);
  assert.equal(compareButton.disabled, false);

  compareButton.click();
  assert.equal(compareButton.getAttribute("aria-pressed"), "true");
  assert.equal(compareCount.textContent, "1 changed line");
  assert.equal(texts(primary, ".cm-editor .diff-text-removed").join(" "), "Left old");
  assert.equal(texts(secondary, ".cm-editor .diff-text-added").join(" "), "Right new");
  assert.deepEqual(texts(primary, ".cm-line .diff-line-removed").join(""), "Left old wording");
  assert.deepEqual(texts(secondary, ".cm-line .diff-line-added").join(""), "Right new wording");
  assert.match(primary.querySelector(".syntax-heading").textContent, /Shared heading/);
  assert.deepEqual(texts(primary, ".cm-lineNumbers .cm-gutterElement.cm-diff-line-removed"), ["2"]);
  assert.deepEqual(texts(secondary, ".cm-lineNumbers .cm-gutterElement.cm-diff-line-added"), ["2"]);

  typeInto(app, "secondary", app.editorText("primary"));
  await settle(180);
  assert.equal(compareCount.textContent, "No differences");
  assert.equal(primary.querySelectorAll(".diff-line-removed").length, 0);
  assert.equal(secondary.querySelectorAll(".diff-line-added").length, 0);
  assert.equal(document.querySelectorAll(".cm-diff-line-removed, .cm-diff-line-added").length, 0);

  typeInto(app, "secondary", "Different again");
  await settle(180);
  assert.ok(primary.querySelectorAll(".diff-line-removed").length > 0);

  document.getElementById("close-secondary-btn").click();
  assert.equal(compareButton.hidden, true);
  assert.equal(compareButton.getAttribute("aria-pressed"), "false");
  assert.equal(primary.querySelectorAll(".diff-line-removed").length, 0);
  assert.equal(primary.querySelectorAll(".cm-diff-line-removed").length, 0);
  assert.ok(primary.querySelectorAll(".cm-lineNumbers").length > 0, "line numbers stay on after compare closes");
});

test("switching the secondary pane to the primary note stops comparison cleanly", async () => {
  const app = await bootApp({
    instance: 3,
    storage: { sodilaud_notes: NOTES }
  });
  const { document } = app.dom.window;
  const compareButton = document.getElementById("compare-notes-btn");
  const primary = document.getElementById("editor-host");
  const secondary = document.getElementById("secondary-editor-host");

  document.getElementById("split-note-btn").click();
  compareButton.click();
  assert.ok(primary.querySelectorAll(".diff-line-removed").length > 0);
  assert.ok(secondary.querySelectorAll(".cm-diff-line-added").length > 0);

  const secondarySelect = document.getElementById("secondary-note-select");
  secondarySelect.value = "note-one";
  secondarySelect.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));

  assert.equal(compareButton.disabled, true);
  assert.equal(compareButton.getAttribute("aria-pressed"), "false");
  assert.equal(app.editorText("secondary"), "First note");
  assert.equal(primary.querySelectorAll(".diff-line-removed").length, 0);
  assert.equal(secondary.querySelectorAll(".diff-line-added").length, 0);
  assert.equal(document.querySelectorAll(".cm-diff-line-removed, .cm-diff-line-added").length, 0);
});

test("compare shows a change rail for blank lines when line numbers are off", async () => {
  const app = await bootApp({
    instance: 4,
    storage: {
      sodilaud_notes: [
        { ...NOTES[0], content: "first\nlast" },
        { ...NOTES[1], content: "first\n\nlast" }
      ]
    }
  });
  const { document } = app.dom.window;
  const secondary = document.getElementById("secondary-editor-host");

  assert.equal(document.documentElement.classList.contains("editor-line-numbers-enabled"), false);
  document.getElementById("split-note-btn").click();
  assert.equal(secondary.querySelectorAll(".cm-lineNumbers").length, 0);
  document.getElementById("compare-notes-btn").click();

  assert.ok(secondary.querySelectorAll(".cm-lineNumbers").length > 0, "the gutter shows while comparing");
  assert.deepEqual(texts(secondary, ".cm-lineNumbers .cm-gutterElement.cm-diff-line-added"), ["2"]);
  assert.equal(document.getElementById("compare-notes-count").textContent, "1 changed line");

  document.getElementById("compare-notes-btn").click();
  assert.equal(secondary.querySelectorAll(".cm-lineNumbers").length, 0);
  assert.equal(document.querySelectorAll(".cm-lineNumbers").length, 0);
});

test("compare is unavailable when both panes show the same note", async () => {
  const app = await bootApp({
    instance: 5,
    storage: { sodilaud_notes: [NOTES[0]] }
  });
  const compareButton = app.dom.window.document.getElementById("compare-notes-btn");

  app.dom.window.document.getElementById("split-note-btn").click();
  assert.equal(compareButton.disabled, true);
  assert.equal(compareButton.title, "Choose a different note to compare");
  assert.equal(compareButton.getAttribute("aria-pressed"), "false");
});

test("compare debounces changed text and reuses cached results for redraws", async () => {
  const app = await bootApp({
    instance: 6,
    storage: {
      sodilaud_notes: [
        { ...NOTES[0], content: "Shared\nLeft wording" },
        { ...NOTES[1], content: "Shared\nRight wording" }
      ]
    }
  });
  const { document } = app.dom.window;
  let diffCalls = 0;
  app.dom.window.Diff = {
    ...Diff,
    diffLines(...args) {
      diffCalls += 1;
      return Diff.diffLines(...args);
    }
  };
  const primary = document.getElementById("editor-host");

  document.getElementById("split-note-btn").click();
  document.getElementById("compare-notes-btn").click();
  assert.equal(diffCalls, 1);
  assert.ok(primary.querySelectorAll(".diff-line-removed").length > 0);

  for (const value of ["Shared\nFirst edit", "Shared\nSecond edit", "Shared\nFinal edit"]) {
    typeInto(app, "primary", value);
  }

  assert.equal(diffCalls, 1);
  assert.equal(document.getElementById("compare-notes-count").textContent, "Updating comparison…");
  await settle(30);
  assert.equal(diffCalls, 1);
  assert.equal(app.editorText("primary"), "Shared\nFinal edit");
  assert.equal(document.querySelectorAll(".diff-line-removed, .diff-line-added").length, 0);
  assert.equal(document.querySelectorAll(".cm-diff-line-removed, .cm-diff-line-added").length, 0);

  await settle(180);
  assert.equal(diffCalls, 2);
  assert.notEqual(document.getElementById("compare-notes-count").textContent, "Updating comparison…");
  assert.ok(primary.querySelectorAll(".diff-line-removed").length > 0);

  const findInput = document.getElementById("find-input");
  findInput.value = "Shared";
  findInput.dispatchEvent(new app.dom.window.Event("input", { bubbles: true }));
  assert.equal(diffCalls, 2);

  for (const value of ["Shared\nAnother edit", "Shared\nFinal secondary edit"]) {
    typeInto(app, "secondary", value);
  }
  assert.equal(diffCalls, 2);
  await settle(180);
  assert.equal(diffCalls, 3);
});

test("closing compare cancels a pending comparison", async () => {
  const app = await bootApp({
    instance: 7,
    storage: { sodilaud_notes: NOTES }
  });
  const { document } = app.dom.window;
  let diffCalls = 0;
  app.dom.window.Diff = {
    ...Diff,
    diffLines(...args) {
      diffCalls += 1;
      return Diff.diffLines(...args);
    }
  };

  document.getElementById("split-note-btn").click();
  document.getElementById("compare-notes-btn").click();
  assert.equal(diffCalls, 1);

  typeInto(app, "primary", "Pending edit");
  document.getElementById("close-secondary-btn").click();

  await settle(180);
  assert.equal(diffCalls, 1);
  assert.equal(document.getElementById("compare-notes-btn").getAttribute("aria-pressed"), "false");
  assert.equal(document.querySelectorAll(".diff-line-removed, .diff-line-added").length, 0);
  assert.equal(document.querySelectorAll(".cm-diff-line-removed, .cm-diff-line-added").length, 0);
});

test("reverting an edit inside the compare debounce restores the diff marks", async () => {
  const app = await bootApp({
    instance: 8,
    storage: {
      sodilaud_notes: [
        { ...NOTES[0], content: "Shared\nLeft wording" },
        { ...NOTES[1], content: "Shared\nRight wording" }
      ]
    }
  });
  const { document } = app.dom.window;
  const primary = document.getElementById("editor-host");
  const secondary = document.getElementById("secondary-editor-host");
  const count = document.getElementById("compare-notes-count");

  document.getElementById("split-note-btn").click();
  document.getElementById("compare-notes-btn").click();
  assert.equal(count.textContent, "1 changed line");
  assert.ok(primary.querySelectorAll(".diff-line-removed").length > 0);

  typeInto(app, "primary", "Shared\nLeft wordingX");
  assert.equal(count.textContent, "Updating comparison…");
  typeInto(app, "primary", "Shared\nLeft wording");
  await settle(180);

  assert.equal(count.textContent, "1 changed line");
  assert.ok(primary.querySelectorAll(".diff-line-removed").length > 0);
  assert.ok(secondary.querySelectorAll(".diff-line-added").length > 0);
  assert.deepEqual(texts(primary, ".cm-lineNumbers .cm-gutterElement.cm-diff-line-removed"), ["2"]);
  assert.deepEqual(texts(secondary, ".cm-lineNumbers .cm-gutterElement.cm-diff-line-added"), ["2"]);
});
