// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { buildHunkElement, reviewHunkMeta } from "../src/diff-hunk.js";
import { charPoint, paintMarks, selectedSpan, setHunkComposer, spanText } from "../src/hunk-comments.js";
import { polyfillLayout } from "./helpers/cm-dom.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const { window } = dom;
const { document } = window;
polyfillLayout(window);

function loadHighlighter() {
  const context = {};
  const source = readFileSync(fileURLToPath(new URL("../src/vendor/highlight.min.js", import.meta.url)), "utf8");
  vm.runInNewContext(`${source};this.hljs = hljs;`, context);
  return context.hljs;
}
const hljs = loadHighlighter();

const BODY = [
  "@@ -10,3 +10,3 @@ fn main() {",
  " let a = 1;",
  "-let b = \"two\";",
  "+let b = \"three\";",
  "",
  " done();"
].join("\n");

function widget(options = {}) {
  const element = buildHunkElement(document, { meta: reviewHunkMeta("diff path=src/main.rs hunk=h3f2a1"), body: BODY, hljs, ...options });
  document.body.replaceChildren(element);
  return element;
}

const cell = (root, row) => root.querySelector(`tr.diff-row[data-index="${row}"]`).querySelector(".diff-code, .diff-meta");

function select(root, [startRow, startChar], [endRow, endChar]) {
  const from = charPoint(cell(root, startRow), startChar);
  const to = charPoint(cell(root, endRow), endChar);
  window.getSelection().setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  return window.getSelection();
}

test("a selection in one row maps to its row and characters without the marker", () => {
  const root = widget();
  const span = selectedSpan(root, select(root, [2, 4], [2, 5]));
  assert.deepEqual(span, { start: { row: 2, char: 4 }, end: { row: 2, char: 5 } });
  assert.equal(spanText(root, span), "b");
});

test("a selection across highlighted rows keeps character offsets through the colour spans", () => {
  const root = widget();
  assert.ok(cell(root, 3).querySelector("span"), "the row is highlighted");
  const span = selectedSpan(root, select(root, [2, 8], [3, 15]));
  assert.deepEqual(span, { start: { row: 2, char: 8 }, end: { row: 3, char: 15 } });
  assert.equal(spanText(root, span), "\"two\";\nlet b = \"three\"");
});

test("the @@ header row and an empty row are selectable rows too", () => {
  const root = widget();
  assert.deepEqual(selectedSpan(root, select(root, [0, 0], [0, 2])), { start: { row: 0, char: 0 }, end: { row: 0, char: 2 } });
  assert.deepEqual(selectedSpan(root, select(root, [3, 0], [5, 4])).end, { row: 5, char: 4 });
  assert.equal(charPoint(cell(root, 4), 0).node, cell(root, 4), "an empty row has no text to point into");
});

test("a collapsed selection or one outside the widget is no span", () => {
  const root = widget();
  assert.equal(selectedSpan(root, select(root, [1, 2], [1, 2])), null);
  const outside = document.createElement("p");
  outside.textContent = "elsewhere";
  document.body.append(outside);
  window.getSelection().selectAllChildren(outside);
  assert.equal(selectedSpan(root, window.getSelection()), null);
});

test("comment marks wrap exactly the commented code, across rows and colour spans", () => {
  const root = widget();
  paintMarks(root, [{ id: "c1", className: "cm-comment cm-comment-owner", start: { row: 2, char: 8 }, end: { row: 3, char: 7 } }]);
  const marks = [...root.querySelectorAll(".diff-mark[data-comment-id=c1]")];
  const text = row => marks.filter(mark => cell(root, row).contains(mark)).map(mark => mark.textContent).join("");
  assert.equal(text(2), "\"two\";");
  assert.equal(text(3), "let b =");
  assert.ok(marks.every(mark => mark.classList.contains("cm-comment-owner")));
  assert.equal(cell(root, 2).textContent, "let b = \"two\";", "marking leaves the text alone");

  paintMarks(root, [{ className: "cm-comment cm-comment-draft", start: { row: 1, char: 0 }, end: { row: 1, char: 3 } }]);
  assert.equal(root.querySelectorAll("[data-comment-id]").length, 0, "repainting removes earlier marks");
  assert.equal(root.querySelector(".diff-mark").textContent, "let");
});

test("a composer row opens under its row and is kept while its key stays", () => {
  const root = widget();
  let built = 0;
  const create = () => {
    built += 1;
    return document.createElement("textarea");
  };
  assert.equal(setHunkComposer(root, { key: 1, row: 2 }, create), true);
  const row = root.querySelector("tr.diff-composer-row");
  assert.equal(row.previousElementSibling.dataset.index, "2");
  assert.equal(setHunkComposer(root, { key: 1, row: 2 }, create), false);
  assert.equal(built, 1);
  assert.equal(setHunkComposer(root, null, create), true);
  assert.equal(root.querySelector("tr.diff-composer-row"), null);
});

function mouse(target, type, init = {}) {
  target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

test("selecting code offers a Comment button that reports the span", () => {
  const spans = [];
  let started = 0;
  const root = widget({ codeComments: { onStart: () => { started += 1; }, onComment: span => spans.push(span) } });
  const button = root.querySelector(".diff-hunk-comment-button");
  assert.equal(button.hidden, true);

  const code = cell(root, 3).querySelector("span") ?? cell(root, 3);
  mouse(code, "mousedown", { detail: 3 });
  assert.equal(started, 1);
  assert.equal(String(window.getSelection()), "let b = \"three\";");
  assert.equal(button.hidden, false);

  button.click();
  assert.deepEqual(spans, [{ start: { row: 3, char: 0 }, end: { row: 3, char: 16 } }]);
  assert.equal(button.hidden, true);
  assert.equal(window.getSelection().rangeCount, 0);
});

test("the Comment button hides when the selection leaves the widget", () => {
  const root = widget({ codeComments: { onComment: () => {} } });
  mouse(cell(root, 1), "mousedown", { detail: 3 });
  const button = root.querySelector(".diff-hunk-comment-button");
  assert.equal(button.hidden, false);
  window.getSelection().removeAllRanges();
  document.dispatchEvent(new window.Event("selectionchange"));
  assert.equal(button.hidden, true);
});

test("a click on commented code without dragging selects the thread", () => {
  const selected = [];
  const root = widget({ codeComments: { onComment: () => {}, onMarkClick: id => selected.push(id) } });
  paintMarks(root, [{ id: "c9", className: "cm-comment cm-comment-agent", start: { row: 1, char: 4 }, end: { row: 1, char: 5 } }]);
  const mark = root.querySelector("[data-comment-id=c9]");
  mouse(mark, "mousedown", { detail: 1 });
  mouse(document, "mouseup");
  assert.deepEqual(selected, ["c9"]);
});

test("clicks on the header and line numbers are left to their buttons", () => {
  let started = 0;
  const root = widget({ onLineComment: () => {}, codeComments: { onStart: () => { started += 1; }, onComment: () => {} } });
  mouse(root.querySelector(".diff-hunk-path"), "mousedown");
  mouse(root.querySelector(".diff-ln-button"), "mousedown");
  assert.equal(started, 0);
});

test("line-number buttons say they comment on their line", () => {
  const root = widget({ onLineComment: () => {} });
  const button = root.querySelector(".diff-row-add .diff-ln-button");
  assert.equal(button.title, "Comment on this line");
  assert.equal(button.getAttribute("aria-label"), "Comment on line 11");
});

test("copying selected code gives the code without markers or line numbers", () => {
  const root = widget({ codeComments: { onComment: () => {} } });
  mouse(cell(root, 2), "mousedown", { detail: 3 });
  let copied = null;
  const event = new window.Event("copy", { bubbles: true, cancelable: true });
  event.clipboardData = { setData: (type, text) => { copied = [type, text]; } };
  document.body.dispatchEvent(event);
  assert.deepEqual(copied, ["text/plain", "let b = \"two\";"]);
  assert.equal(event.defaultPrevented, true);
});
