// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { bootApp } from "./helpers/app-harness.js";

const NOTES = [
  {
    id: "note-one",
    title: "First",
    content: "Alpha first\nsecond alpha here\nALPHA",
    updatedAt: 2,
    isTitleLocked: true
  },
  {
    id: "note-two",
    title: "Second",
    content: "No result on this note",
    updatedAt: 1,
    isTitleLocked: true
  },
  {
    id: "note-three",
    title: "Third",
    content: "Remote alpha",
    updatedAt: 0,
    isTitleLocked: true
  }
];

test("Find All lists live matches and jumps to the selected result", async () => {
  const app = await bootApp({
    storage: { sodilaud_notes: NOTES }
  });
  const { document, Event, KeyboardEvent } = app.dom.window;
  app.dom.window.marked = marked;
  let scrolledPreviewMatch = null;
  const activeEditorMark = () => {
    const marks = [...document.querySelectorAll("#editor-host .cm-find-active")];
    return marks.map((mark) => mark.textContent).join("");
  };

  app.dom.window.HTMLElement.prototype.scrollIntoView = function () {
    if (this.matches?.("mark.find-preview-match")) {
      scrolledPreviewMatch = this.dataset.findIndex;
    }
  };

  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true
  }));

  const findInput = document.getElementById("find-input");
  findInput.value = "alpha";
  findInput.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(document.querySelectorAll("#editor-host .cm-find-match").length, 3);
  assert.equal(document.querySelectorAll("#editor-host .cm-find-active").length, 1);

  const caseToggle = document.getElementById("find-case-toggle");
  caseToggle.click();
  assert.equal(caseToggle.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("find-count").textContent, "1 of 1");
  caseToggle.click();
  assert.equal(document.getElementById("find-count").textContent, "1 of 3");

  const exactToggle = document.getElementById("find-exact-toggle");
  findInput.value = "alp";
  findInput.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(document.getElementById("find-count").textContent, "1 of 3");
  exactToggle.click();
  assert.equal(exactToggle.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("find-count").textContent, "0 of 0");
  assert.equal(document.querySelectorAll("#editor-host .cm-find-match").length, 0);
  exactToggle.click();
  findInput.value = "alpha";
  findInput.dispatchEvent(new Event("input", { bubbles: true }));

  const resultsToggle = document.getElementById("find-results-toggle");
  assert.equal(resultsToggle.disabled, false);
  resultsToggle.click();

  const resultsPane = document.getElementById("find-results-pane");
  assert.equal(resultsPane.style.display, "flex");
  assert.equal(document.getElementById("find-results-summary").textContent, "3 matches");
  assert.deepEqual(
    [...document.querySelectorAll(".find-result-location")].map((element) => element.textContent),
    ["Line 1", "Line 2", "Line 3"]
  );

  const allNotesToggle = document.getElementById("find-all-notes-toggle");
  allNotesToggle.click();
  assert.equal(allNotesToggle.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("find-results-summary").textContent, "4 matches in 2 notes");
  assert.deepEqual(
    [...document.querySelectorAll(".find-result-note")].map((element) => element.textContent),
    ["First", "First", "First", "Third"]
  );

  document.querySelector('[data-note-id="note-three"]').click();
  assert.equal(app.editorText(), "Remote alpha");
  assert.equal(app.editor().state.selection.main.from, 7);
  assert.equal(app.editor().state.selection.main.to, 12);
  assert.equal(activeEditorMark(), "alpha");
  assert.ok(document.querySelector('[data-id="note-three"]').classList.contains("active"));

  document.querySelector('[data-note-id="note-one"][data-match-start="0"]').click();
  allNotesToggle.click();
  assert.equal(document.getElementById("find-results-summary").textContent, "3 matches");
  assert.equal(app.editorText(), NOTES[0].content);
  assert.equal(activeEditorMark(), "Alpha");

  const view = app.editor();
  const scrollTargets = [];
  const dispatch = view.dispatch.bind(view);
  view.dispatch = (...specs) => {
    for (const spec of specs) {
      for (const effect of [spec?.effects ?? []].flat()) {
        if (effect?.value?.range && effect.value.y === "center") scrollTargets.push(effect.value.range);
      }
    }
    return dispatch(...specs);
  };

  const firstResult = document.querySelector('[data-match-index="0"]');
  firstResult.focus();
  firstResult.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowDown",
    bubbles: true
  }));
  assert.equal(document.activeElement.dataset.matchIndex, "1");

  scrollTargets.length = 0;
  document.activeElement.click();
  assert.equal(view.state.selection.main.from, 19);
  assert.equal(view.state.selection.main.to, 24);
  assert.deepEqual(
    scrollTargets.map((range) => [range.from, range.to]),
    [[19, 24]],
    "the selected match is scrolled into the centre of the editor"
  );
  assert.equal(activeEditorMark(), "alpha");
  assert.equal(document.querySelector("#editor-host .cm-find-active").closest(".cm-line").textContent, "second alpha here");
  assert.equal(document.getElementById("cursor-position").textContent, "Ln 2, Col 13");
  assert.ok(document.activeElement === view.contentDOM, "focus is on view.contentDOM");
  assert.equal(document.querySelector(".find-result-button.active").dataset.matchIndex, "1");

  document.getElementById("mode-reading").click();
  await app.settle(80);
  assert.equal(document.querySelectorAll("mark.find-preview-match").length, 3);
  assert.equal(
    document.querySelector("mark.find-preview-match.active-match").dataset.findIndex,
    "1"
  );

  document.querySelector('[data-match-index="2"]').click();
  assert.equal(
    document.querySelector("mark.find-preview-match.active-match").dataset.findIndex,
    "2"
  );
  assert.equal(scrolledPreviewMatch, "2");

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: "alpha only" },
    userEvent: "input.type"
  });
  await app.settle(200);
  assert.equal(document.querySelectorAll(".find-result-button").length, 1);
  assert.equal(document.querySelectorAll("mark.find-preview-match").length, 1);
  assert.equal(document.getElementById("find-results-summary").textContent, "1 match");
  assert.equal(document.querySelectorAll("#editor-host .cm-find-match").length, 1);

  document.querySelector('[data-id="note-two"]').click();
  assert.equal(document.querySelectorAll(".find-result-button").length, 0);
  assert.match(document.querySelector(".find-results-empty").textContent, /No matches/);
  assert.equal(document.querySelectorAll("#editor-host .cm-find-match").length, 0);

  document.querySelector('[data-id="note-one"]').click();
  assert.equal(document.querySelectorAll(".find-result-button").length, 1);

  document.getElementById("split-note-btn").click();
  assert.equal(resultsPane.style.display, "none");
  assert.equal(document.getElementById("secondary-pane-wrapper").style.display, "flex");

  resultsToggle.click();
  assert.equal(resultsPane.style.display, "flex");
  assert.equal(document.getElementById("secondary-pane-wrapper").style.display, "none");

  document.getElementById("find-close").click();
  assert.equal(document.querySelectorAll("#editor-host .cm-find-match").length, 0);
});
