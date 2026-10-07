// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import { installEditorDom } from "./helpers/cm-dom.js";
import {
  applyReadingFolds,
  outlineEntries,
  readingFoldsHiding,
  reviewProgress,
  reviewProgressText,
  sectionEnds
} from "../src/outline.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const hunk = (id, reviewed = false) =>
  `\`\`\`diff path=src/${id}.rs hunk=${id} lines=1-1${reviewed ? " reviewed" : ""}\n@@ -1 +1 @@\n-a\n+b\n\`\`\``;

const BOOK = [
  "# Book",
  "",
  "Intro",
  "",
  "## Merge engine",
  "",
  hunk("h00001", true),
  "",
  "### Details",
  "",
  hunk("h00002"),
  "",
  "## Comments",
  "",
  "Prose only.",
  "",
  "# Appendix",
  "",
  hunk("h00003", true)
].join("\n");

test("a section ends at the next heading of the same or a higher level", () => {
  const headings = [
    { from: 0, level: 1 }, { from: 10, level: 2 }, { from: 20, level: 3 },
    { from: 30, level: 2 }, { from: 40, level: 1 }
  ];
  assert.deepEqual(sectionEnds(headings, 50), [40, 30, 30, 40, 50]);
  assert.deepEqual(sectionEnds([], 5), []);
});

test("review progress counts reviewed hunks and reads n/m reviewed", () => {
  const hunks = [{ meta: { reviewed: true } }, { meta: { reviewed: false } }, { meta: { reviewed: true } }];
  assert.deepEqual(reviewProgress(hunks), { reviewed: 2, total: 3 });
  assert.equal(reviewProgressText(reviewProgress(hunks)), "2/3 reviewed");
  assert.equal(reviewProgressText(reviewProgress([])), "");
});

async function setup(text) {
  const env = installEditorDom();
  env.window.marked = marked;
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const { livePreview } = await import("../src/editor-live-preview.js");
  const folds = await import("../src/editor-folds.js");
  const { documentAnchors } = await import("../src/editor-anchors.js");
  const { reviewHunkFences } = await import("../src/editor-hunks.js");
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    extensions: [livePreview(), folds.sectionFolding()]
  });
  editor.view.focus = () => {};
  editor.loadText(text);
  editor.setSelection(0, 0);
  await settle();
  return {
    env, editor, folds, documentAnchors, reviewHunkFences,
    view: editor.view,
    done() { editor.destroy(); env.cleanup(); }
  };
}

test("the outline lists headings with reviewed over total for sections holding hunks", async () => {
  const t = await setup(BOOK);
  try {
    const entries = outlineEntries(t.documentAnchors(t.view.state), t.reviewHunkFences(t.view.state), t.view.state.doc.length);
    assert.deepEqual(entries.map(({ id, level, text, reviewed, total }) => ({ id, level, text, reviewed, total })), [
      { id: "book", level: 1, text: "Book", reviewed: 1, total: 2 },
      { id: "merge-engine", level: 2, text: "Merge engine", reviewed: 1, total: 2 },
      { id: "details", level: 3, text: "Details", reviewed: 0, total: 1 },
      { id: "comments", level: 2, text: "Comments", reviewed: 0, total: 0 },
      { id: "appendix", level: 1, text: "Appendix", reviewed: 1, total: 1 }
    ]);
  } finally { t.done(); }
});

test("fold ranges run from the line after a heading to the line before the next one", async () => {
  const t = await setup("# A\none\n## B\ntwo\n# C\nthree");
  try {
    const { doc } = t.view.state;
    const ranges = t.folds.sectionFoldRanges(t.view.state);
    assert.deepEqual(ranges.map(range => [range.id, doc.sliceString(range.from, range.to)]), [
      ["a", "one\n## B\ntwo"],
      ["b", "two"],
      ["c", "three"]
    ]);
  } finally { t.done(); }
});

test("a chevron folds a section in Live mode and the folded text leaves the editor", async () => {
  const t = await setup(BOOK);
  try {
    const chevrons = t.view.contentDOM.querySelectorAll(".cm-heading-fold");
    assert.equal(chevrons.length, 5);
    const merge = chevrons[1];
    merge.dispatchEvent(new t.env.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual([...t.folds.foldedSections(t.view.state)], ["merge-engine"]);
    assert.ok(t.view.contentDOM.querySelector(".cm-section-folded"));
    assert.ok(!t.view.contentDOM.textContent.includes("Details"), "the subsection is folded too");
    assert.ok(t.view.contentDOM.textContent.includes("Comments"), "the next section stays");
    assert.equal(t.view.contentDOM.querySelectorAll(".cm-heading-fold.is-folded").length, 1);
    assert.equal(t.view.state.doc.toString(), BOOK, "folding never edits the file");

    t.view.contentDOM.querySelector(".cm-section-folded")
      .dispatchEvent(new t.env.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(t.folds.foldedSections(t.view.state).size, 0);
    assert.ok(t.view.contentDOM.textContent.includes("Details"));
  } finally { t.done(); }
});

test("following an anchor into a folded section unfolds it", async () => {
  const t = await setup(BOOK);
  try {
    t.folds.setFoldedSections(t.view, ["book", "comments"]);
    assert.equal(t.folds.revealAnchor(t.view, "comments"), true);
    assert.deepEqual([...t.folds.foldedSections(t.view.state)], ["comments"], "only the enclosing fold opens");
    t.folds.setFoldedSections(t.view, ["merge-engine"]);
    assert.equal(t.folds.revealAnchor(t.view, "h00002"), true, "a hunk id works too");
    assert.equal(t.folds.foldedSections(t.view.state).size, 0);
    assert.equal(t.folds.revealAnchor(t.view, "book"), false);
  } finally { t.done(); }
});

test("a fold follows edits and survives a section holding a hunk widget", async () => {
  const t = await setup(BOOK);
  try {
    t.folds.setFoldedSections(t.view, ["appendix"]);
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-hunk[data-hunk=h00003]"));
    t.view.dispatch({ changes: { from: 0, insert: "Preface\n\n" } });
    await settle();
    assert.deepEqual([...t.folds.foldedSections(t.view.state)], ["appendix"]);
    assert.ok(t.view.contentDOM.querySelector(".cm-section-folded"));
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-hunk[data-hunk=h00003]"));
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-hunk[data-hunk=h00001]"));
  } finally { t.done(); }
});

function readingRoot(html) {
  const dom = new JSDOM(`<!doctype html><div id=root>${html}</div>`);
  return dom.window.document.getElementById("root");
}

const READING = `
<h1 data-anchor="book">Book</h1><p>Intro</p>
<h2 data-anchor="merge-engine">Merge engine</h2><pre data-x="1"><code data-hunk="h00001"></code></pre>
<h3 data-anchor="details">Details</h3><p id="deep">Deep</p>
<h2 data-anchor="comments">Comments</h2><p>Prose</p>
<h1 data-anchor="appendix">Appendix</h1>`;

test("Reading mode folds hide a section up to the next heading of the same or a higher level", () => {
  const root = readingRoot(READING);
  const toggles = [];
  applyReadingFolds(root, new Set(["merge-engine"]), (id, folded) => toggles.push([id, folded]));
  const hidden = [...root.querySelectorAll(".section-fold-hidden")].map(element => element.textContent || element.tagName);
  assert.deepEqual(hidden, ["PRE", "Details", "Deep"]);
  assert.equal(root.querySelectorAll(".heading-fold").length, 5);
  const merge = root.querySelector("[data-anchor=merge-engine] .heading-fold");
  assert.equal(merge.getAttribute("aria-expanded"), "false");
  merge.click();
  assert.deepEqual(toggles, [["merge-engine", false]]);

  applyReadingFolds(root, new Set(), () => {});
  assert.equal(root.querySelectorAll(".section-fold-hidden").length, 0);
  assert.equal(root.querySelectorAll(".heading-fold").length, 5, "running again adds no second chevron");
});

test("Reading mode names the folds that hide an anchor target", () => {
  const root = readingRoot(READING);
  const deep = root.querySelector("#deep");
  assert.deepEqual(readingFoldsHiding(root, deep, new Set(["book", "merge-engine", "details", "comments"])), ["details", "merge-engine", "book"]);
  const hunkTarget = root.querySelector("code[data-hunk]");
  assert.deepEqual(readingFoldsHiding(root, hunkTarget, new Set(["merge-engine"])), ["merge-engine"]);
  assert.deepEqual(readingFoldsHiding(root, root.querySelector("[data-anchor=comments]"), new Set(["comments", "book"])), ["book"]);
  assert.deepEqual(readingFoldsHiding(root, deep, new Set()), []);
});

test("the next unreviewed hunk is the first one after the reading position, wrapping round", async () => {
  const { nextUnreviewed } = await import("../src/outline.js");
  const hunks = [
    { id: "h00001", reviewed: false, at: 10 },
    { id: "h00002", reviewed: true, at: 20 },
    { id: "h00003", reviewed: false, at: 30 }
  ];
  assert.equal(nextUnreviewed(hunks, 0), "h00001");
  assert.equal(nextUnreviewed(hunks, 10), "h00003", "the hunk being read is not picked again");
  assert.equal(nextUnreviewed(hunks, 30), "h00001", "past the last one it wraps");
  assert.equal(nextUnreviewed(hunks.map(hunk => ({ ...hunk, reviewed: true })), 0), null);
});
