// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { installEditorDom } from "./helpers/cm-dom.js";
import { renderMarkdown } from "../src/markdown.js";
import { marked } from "marked";
import {
  alignText,
  blockForSource,
  paintSourceMarks,
  pointToSource,
  rangeToSource,
  sourceBlockOf,
  stripSourceAnnotations
} from "../src/source-map.js";

function mount(html) {
  const env = installEditorDom();
  const root = env.document.createElement("div");
  root.innerHTML = html;
  env.document.body.append(root);
  return { env, root, document: env.document };
}

test("alignText skips markup and marks unmatched characters", () => {
  assert.deepEqual(Array.from(alignText("bold", "**bold**")), [2, 3, 4, 5]);
  const aligned = alignText("a © b", "a &copy; b");
  assert.equal(aligned[2], -1);
  assert.equal(aligned[4], 9);
  assert.equal(alignText("a b", "a b")[1], 1);
});

test("selection over emphasis maps to the text, not the asterisks", () => {
  const { env, root, document } = mount('<p data-src-from="0" data-src-to="18">Some <strong>bold</strong> text</p>');
  try {
    const source = "Some **bold** text";
    const strong = root.querySelector("strong").firstChild;
    const range = document.createRange();
    range.setStart(strong, 0);
    range.setEnd(strong, 4);
    assert.deepEqual(rangeToSource(root, range, source), { from: 7, to: 11 });

    const first = root.querySelector("p").firstChild;
    const last = root.querySelector("p").lastChild;
    range.setStart(first, 5);
    range.setEnd(last, 0);
    assert.deepEqual(rangeToSource(root, range, source), { from: 7, to: 11 });
  } finally {
    env.cleanup();
  }
});

test("a point in a text node with no matched characters falls back to its neighbours", () => {
  const { env, root, document } = mount('<p data-src-from="0" data-src-to="12">ab<em>\u2665</em>cd</p>');
  try {
    const source = "ab&hearts;cd";
    const mid = root.querySelector("em").firstChild;
    const p = root.querySelector("p");
    const range = document.createRange();
    range.setStart(mid, 0);
    range.setEnd(p.lastChild, 2);
    assert.deepEqual(rangeToSource(root, range, source), { from: 10, to: 12 });
    range.setStart(p.firstChild, 0);
    range.setEnd(mid, 1);
    assert.deepEqual(rangeToSource(root, range, source), { from: 0, to: 2 });
  } finally {
    env.cleanup();
  }
});

test("a link maps from the label to the end of the following text", () => {
  const { env, root, document } = mount('<p data-src-from="0" data-src-to="30">See <a>docs</a> now</p>');
  try {
    const source = "See [docs](https://x.y/ab) now";
    const range = document.createRange();
    range.setStart(root.querySelector("a").firstChild, 0);
    range.setEnd(root.querySelector("p").lastChild, 4);
    assert.deepEqual(rangeToSource(root, range, source), { from: 5, to: 30 });
  } finally {
    env.cleanup();
  }
});

test("a selection in a table cell maps inside that cell's range", () => {
  const { env, root, document } = mount(
    '<table data-src-from="0" data-src-to="19"><tbody><tr>' +
    '<td data-src-from="2" data-src-to="5">one</td><td data-src-from="8" data-src-to="15">two *x*</td>' +
    "</tr></tbody></table>"
  );
  try {
    const source = "| one | two *x* |";
    const cell = root.querySelectorAll("td")[1].firstChild;
    const range = document.createRange();
    range.setStart(cell, 0);
    range.setEnd(cell, 3);
    const mapped = rangeToSource(root, range, source);
    assert.deepEqual(mapped, { from: 8, to: 11 });
    assert.equal(sourceBlockOf(root, cell), root.querySelectorAll("td")[1]);
  } finally {
    env.cleanup();
  }
});

test("points in skipped elements or outside annotated elements map to null", () => {
  const { env, root } = mount(
    '<p data-src-from="0" data-src-to="9">Hello <button>Go</button><span class="diff-hunk">hunk</span> you</p><div>outside</div>'
  );
  try {
    const source = "Hello you";
    const button = root.querySelector("button").firstChild;
    const hunk = root.querySelector(".diff-hunk").firstChild;
    const outside = root.querySelector("div").firstChild;
    assert.equal(pointToSource(root, button, 1, "start", source), null);
    assert.equal(pointToSource(root, hunk, 1, "end", source), null);
    assert.equal(pointToSource(root, outside, 1, "start", source), null);
    assert.equal(sourceBlockOf(root, button), null);
    assert.equal(sourceBlockOf(root, outside), null);
    const p = root.querySelector("p");
    assert.equal(pointToSource(root, p, 3, "end", source), 6);
  } finally {
    env.cleanup();
  }
});

test("an empty or inverted selection maps to null", () => {
  const { env, root, document } = mount('<p data-src-from="0" data-src-to="4">text</p>');
  try {
    const range = document.createRange();
    range.setStart(root.firstChild.firstChild, 2);
    range.setEnd(root.firstChild.firstChild, 2);
    assert.equal(rangeToSource(root, range, "text"), null);
  } finally {
    env.cleanup();
  }
});

test("paintSourceMarks wraps the matching characters and repaints cleanly", () => {
  const { env, root } = mount('<p data-src-from="0" data-src-to="18">Some <strong>bold</strong> text</p>');
  try {
    const source = "Some **bold** text";
    paintSourceMarks(root, [{ from: 7, to: 11, className: "cm-comment", id: "c1" }], source);
    let spans = root.querySelectorAll("span.source-mark");
    assert.equal(spans.length, 1);
    assert.equal(spans[0].textContent, "bold");
    assert.ok(spans[0].classList.contains("cm-comment"));
    assert.equal(spans[0].getAttribute("data-comment-id"), "c1");

    paintSourceMarks(root, [{ from: 5, to: 15, className: "cm-comment-draft" }], source);
    spans = root.querySelectorAll("span.source-mark");
    assert.equal(spans.length, 2);
    assert.deepEqual(Array.from(spans, (s) => s.textContent), ["bold", " t"]);
    assert.equal(spans[0].hasAttribute("data-comment-id"), false);
    assert.equal(root.textContent, "Some bold text");
  } finally {
    env.cleanup();
  }
});

test("paintSourceMarks never wraps the whitespace between table rows and cells", () => {
  const source = "| Name | Note |\n|---|---|\n| alpha | first row |\n| beta | middle row |";
  const { env, root } = mount("");
  try {
    root.innerHTML = renderMarkdown(source, "", marked, { positions: true });
    const from = source.indexOf("middle row");
    paintSourceMarks(root, [{ from, to: from + "middle row".length, className: "cm-comment" }], source);
    const spans = Array.from(root.querySelectorAll("span.source-mark"));
    assert.deepEqual(spans.map((s) => s.textContent), ["middle row"]);
    assert.equal(spans[0].parentElement.tagName, "TD");
  } finally {
    env.cleanup();
  }
});

test("blockForSource returns the innermost annotated element", () => {
  const { env, root } = mount(
    '<table data-src-from="0" data-src-to="19"><tbody><tr>' +
    '<td data-src-from="2" data-src-to="5">one</td><td data-src-from="8" data-src-to="17">two</td>' +
    "</tr></tbody></table>"
  );
  try {
    assert.equal(blockForSource(root, 8), root.querySelectorAll("td")[1]);
    assert.equal(blockForSource(root, 6), root.querySelector("table"));
    assert.equal(blockForSource(root, 40), null);
  } finally {
    env.cleanup();
  }
});

test("stripSourceAnnotations removes every trace but keeps the text", () => {
  const { env, root } = mount(
    '<p data-src-from="0" data-src-to="18">Some <strong>bold</strong> text</p>' +
    '<div class="reading-composer">draft</div><button class="reading-comment-button">Comment</button>'
  );
  try {
    paintSourceMarks(root, [{ from: 7, to: 11, className: "cm-comment" }], "Some **bold** text");
    stripSourceAnnotations(root);
    assert.equal(root.querySelectorAll("[data-src-from], [data-src-to], .source-mark, .reading-composer, .reading-comment-button").length, 0);
    assert.equal(root.textContent, "Some bold text");
    assert.equal(root.querySelector("p").childNodes.length, 3);
  } finally {
    env.cleanup();
  }
});

test("rangeToSource maps a selection inside a rendered table cell", () => {
  const source = "| h |\n|---|\n| left middle right |\n";
  const { root, document } = mount("");
  root.innerHTML = renderMarkdown(source, "", marked, { positions: true });
  const text = root.querySelector("td").firstChild;
  const start = text.nodeValue.indexOf("middle");
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + 6);
  const from = source.indexOf("middle");
  assert.deepEqual(rangeToSource(root, range, source), { from, to: from + 6 });
});
