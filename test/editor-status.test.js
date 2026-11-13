// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { installEditorDom } from "./helpers/cm-dom.js";

installEditorDom();
const { EditorSelection, EditorState } = await import("../src/vendor/codemirror.js");
const { countsText, cursorText, createSavedFade } = await import("../src/editor-status.js");

const state = (doc, ranges) => EditorState.create({
  doc,
  selection: ranges && EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))),
  extensions: EditorState.allowMultipleSelections.of(true)
});

test("the counts are the document's totals while nothing is selected", () => {
  assert.equal(countsText(state("")), "0 words • 0 characters");
  assert.equal(countsText(state("alpha")), "1 word • 5 characters");
  assert.equal(countsText(state("alpha beta\ngamma", [[3, 3]])), "3 words • 16 characters");
});

test("the counts are the selection's while there is one", () => {
  assert.equal(countsText(state("alpha beta\ngamma", [[10, 0]])), "2 words • 10 characters selected");
  assert.equal(countsText(state("alpha beta\ngamma", [[0, 1]])), "1 word • 1 character selected");
  assert.equal(
    countsText(state("alpha beta\ngamma", [[0, 5], [11, 16]])),
    "2 words • 10 characters selected",
    "every range of a multiple selection counts"
  );
});

test("the cursor position names the selection head", () => {
  assert.deepEqual(cursorText(state("alpha\nbeta", [[0, 0]])), { text: "Ln 1, Col 1", title: "Line 1, column 1" });
  assert.deepEqual(cursorText(state("alpha\nbeta", [[0, 9]])), { text: "Ln 2, Col 4", title: "Line 2, column 4" });
});

test("Saved settles after the delay and any change brings it back", async () => {
  const { document } = new JSDOM("<span id=s>Saved</span>").window;
  const element = document.getElementById("s");
  const fade = createSavedFade(element, { delay: 20 });
  fade.update("a:Saved", true);
  assert.ok(!element.classList.contains("settled"));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(element.classList.contains("settled"));
  fade.update("a:Saved", true);
  assert.ok(element.classList.contains("settled"), "the same status stays settled");
  fade.update("a:Saving", false);
  assert.ok(!element.classList.contains("settled"));
  fade.update("b:Saved", true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(element.classList.contains("settled"));
  fade.update("b:Unsaved", false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(!element.classList.contains("settled"), "only Saved fades");
});
