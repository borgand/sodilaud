// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import {
  buildHunkElement,
  exportHunks,
  highlightRows,
  languageForPath,
  parseHunkBody,
  renderHunkWidgets,
  reviewHunkMeta,
  setHunkCollapsed,
  splitHighlightedLines,
  withReviewed
} from "../src/diff-hunk.js";
import { findReadingAnchor } from "../src/anchors.js";
import { renderMarkdown } from "../src/markdown.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const { document } = dom.window;
globalThis.document = document;

function loadHighlighter() {
  const context = {};
  const source = readFileSync(fileURLToPath(new URL("../src/vendor/highlight.min.js", import.meta.url)), "utf8");
  vm.runInNewContext(`${source};this.hljs = hljs;`, context);
  return context.hljs;
}
const hljs = loadHighlighter();

const BODY = [
  "@@ -10,4 +10,5 @@ fn main() {",
  " let a = 1;",
  "-let b = 2;",
  "+let b = 3;",
  "+let c = \"x\";",
  " }",
  "\\ No newline at end of file"
].join("\n");

const HUNK = "```diff path=src/main.rs hunk=h3f2a1 lines=10-14\n" + BODY + "\n```";

function preview(markdown) {
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(markdown, "", marked);
  return container;
}

test("a diff fence is a review hunk only with a valid path", () => {
  assert.deepEqual(reviewHunkMeta("diff path=src/a.rs hunk=h3f2a1 lines=1-2 reviewed"), {
    path: "src/a.rs", hunk: "h3f2a1", lines: "1-2", reviewed: true, elided: false
  });
  assert.deepEqual(reviewHunkMeta('diff path="docs/a b.md" hunk=h3f2a1 lines=old:3-9 elided'), {
    path: "docs/a b.md", hunk: "h3f2a1", lines: "old:3-9", reviewed: false, elided: true
  });
  assert.equal(reviewHunkMeta("diff"), null);
  assert.equal(reviewHunkMeta("rust path=a.rs"), null);
  for (const bad of ["/etc/passwd", "../x.rs", "a/../../x.rs", "https://x.y/a.rs", "javascript:alert(1)", ""]) {
    assert.equal(reviewHunkMeta(`diff path=${bad}`), null, bad);
  }
  const loose = reviewHunkMeta("diff path=a.rs hunk=XYZ lines=ten");
  assert.equal(loose.hunk, null);
  assert.equal(loose.lines, null);
});

test("the reviewed token is added and removed without touching other tokens", () => {
  const info = 'diff path="a reviewed.rs" hunk=h3f2a1 lines=1-2';
  const marked = withReviewed(info, true);
  assert.equal(marked, `${info} reviewed`);
  assert.equal(withReviewed(marked, true), marked);
  assert.equal(withReviewed(marked, false), info);
  assert.equal(withReviewed("diff path=a.rs reviewed elided", false), "diff path=a.rs elided");
  assert.equal(withReviewed("diff path=a.rs elided reviewed", false), "diff path=a.rs elided");
});

test("rows carry old and new line numbers from the @@ header", () => {
  const rows = parseHunkBody(BODY);
  assert.deepEqual(rows.map(row => [row.kind, row.old, row.new]), [
    ["header", null, null],
    ["ctx", 10, 10],
    ["del", 11, null],
    ["add", null, 11],
    ["add", null, 12],
    ["ctx", 12, 13],
    ["note", null, null]
  ]);
  assert.equal(rows[3].text, "let b = 3;");
  const restarted = parseHunkBody("@@ -1 +1 @@\n-a\n+b\n@@ -20,2 +20,2 @@\n c");
  assert.deepEqual(restarted.at(-1), { kind: "ctx", marker: " ", text: "c", old: 20, new: 20 });
});

test("languages follow the file extension and fall back to diff", () => {
  assert.equal(languageForPath("src/a.rs", hljs), "rust");
  assert.equal(languageForPath("src/a.test.mjs", hljs), "javascript");
  assert.equal(languageForPath("Makefile", hljs), "makefile");
  assert.equal(languageForPath("LICENSE", hljs), "diff");
  assert.equal(languageForPath("a.unknown", hljs), "diff");
});

test("highlighted HTML splits into self-contained lines", () => {
  const lines = splitHighlightedLines('<span class="c">/* a\nb */</span> x\ny');
  assert.deepEqual(lines, ['<span class="c">/* a</span>', '<span class="c">b */</span> x', "y"]);
});

test("a multi-line comment keeps its colors on every row", () => {
  const rows = parseHunkBody("@@ -1,2 +1,3 @@\n /* start\n+middle\n  end */");
  const html = highlightRows(rows, "a.rs", hljs);
  assert.match(html[2], /hljs-comment/);
  assert.match(html[3], /hljs-comment/);
});

test("the sanitizer keeps hunk attributes only when their values are valid", () => {
  const code = preview(`${HUNK.replace("lines=10-14", "lines=10-14 reviewed elided")}`).querySelector("code");
  assert.equal(code.getAttribute("data-path"), "src/main.rs");
  assert.equal(code.getAttribute("data-hunk"), "h3f2a1");
  assert.equal(code.getAttribute("data-lines"), "10-14");
  assert.equal(code.getAttribute("data-reviewed"), "");
  assert.equal(code.getAttribute("data-elided"), "");

  const spaced = preview('```diff path="docs/a b.md" hunk=h3f2a1 lines=1-1\n+x\n```').querySelector("code");
  assert.equal(spaced.getAttribute("data-path"), "docs/a b.md");

  const forged = preview(
    '<pre><code class="language-diff" data-path="../../etc/passwd" data-hunk="nope" data-lines="1-x" data-reviewed="yes" data-elided="1" onclick="x()">a</code></pre>'
  ).querySelector("code");
  for (const name of ["data-path", "data-hunk", "data-lines", "data-reviewed", "data-elided", "onclick"]) {
    assert.equal(forged.hasAttribute(name), false, name);
  }
  assert.equal(preview("```diff\n+plain\n```").querySelector("code").hasAttribute("data-path"), false);
});

test("Reading mode swaps review hunks for widgets and leaves plain diffs alone", () => {
  const container = preview(`${HUNK}\n\n\`\`\`diff\n+plain\n\`\`\``);
  const toggles = [];
  assert.equal(renderHunkWidgets(container, { hljs, onToggleReviewed: (target, reviewed) => toggles.push([target, reviewed]) }), 1);
  const widget = container.querySelector(".diff-hunk");
  assert.equal(widget.querySelector(".diff-hunk-path").textContent, "src/main.rs");
  assert.equal(widget.querySelector(".diff-hunk-lines").textContent, "lines 10-14");
  assert.deepEqual(
    [...widget.querySelectorAll("tr")].map(row => [...row.querySelectorAll(".diff-ln")].map(cell => cell.textContent)),
    [[], ["10", "10"], ["11", ""], ["", "11"], ["", "12"], ["12", "13"], []]
  );
  assert.ok(widget.querySelector(".diff-row-add .diff-code .hljs-string"));
  assert.equal(widget.querySelector(".diff-row-note").textContent, "\\ No newline at end of file");
  assert.equal(container.querySelectorAll("pre > code.language-diff").length, 1);
  assert.equal(widget.querySelectorAll(".diff-ln-button").length, 0);

  const reviewed = widget.querySelector(".diff-hunk-reviewed");
  assert.equal(reviewed.getAttribute("aria-pressed"), "false");
  reviewed.click();
  assert.deepEqual(toggles, [[{ hunk: "h3f2a1", index: 0 }, true]]);
  assert.ok(widget.classList.contains("diff-hunk-is-reviewed"));
  assert.equal(reviewed.getAttribute("aria-pressed"), "true");
});

test("collapse state lasts for the session and survives a re-render", () => {
  const first = preview(HUNK);
  renderHunkWidgets(first);
  first.querySelector(".diff-hunk-collapse").click();
  assert.ok(first.querySelector(".diff-hunk").classList.contains("diff-hunk-is-collapsed"));
  const again = preview(HUNK);
  renderHunkWidgets(again);
  assert.ok(again.querySelector(".diff-hunk").classList.contains("diff-hunk-is-collapsed"));
  setHunkCollapsed({ hunk: "h3f2a1" }, false);
});

test("collapsing tells the host the widget's height changed", () => {
  const toggles = [];
  const widget = buildHunkElement(document, {
    meta: reviewHunkMeta("diff path=src/main.rs hunk=h3f2a2"),
    body: BODY,
    onToggleCollapsed: collapsed => toggles.push(collapsed)
  });
  document.body.append(widget);
  widget.querySelector(".diff-hunk-collapse").click();
  widget.querySelector(".diff-hunk-collapse").click();
  assert.deepEqual(toggles, [true, false]);
  widget.remove();
});
test("an elided hunk says so instead of showing an empty diff", () => {
  const container = preview("```diff path=package-lock.json hunk=h45751 lines=1044-2215 elided reviewed\n@@ -1040,6 +1044,1172 @@\n```");
  renderHunkWidgets(container);
  const widget = container.querySelector(".diff-hunk");
  assert.ok(widget.querySelector(".diff-hunk-elided"));
  assert.ok(widget.classList.contains("diff-hunk-is-reviewed"));
});

test("links still reach a hunk once the widget replaced it", () => {
  const container = preview(HUNK);
  renderHunkWidgets(container);
  assert.equal(findReadingAnchor(container, "h3f2a1"), container.querySelector(".diff-hunk"));
});

test("line numbers become comment buttons when a handler is given", () => {
  const lines = [];
  const widget = buildHunkElement(document, {
    meta: reviewHunkMeta("diff path=a.rs hunk=h3f2a1"),
    body: BODY,
    onLineComment: index => lines.push(index)
  });
  widget.querySelectorAll(".diff-row-add .diff-ln-button")[1].click();
  assert.deepEqual(lines, [4]);
});

test("copy-as-HTML turns widgets and raw hunks into captioned diff blocks", () => {
  const container = preview(`${HUNK}\n\n\`\`\`diff path=b.js lines=old:1-2\n-gone\n\`\`\``);
  renderHunkWidgets(container);
  const copy = container.cloneNode(true);
  assert.equal(exportHunks(copy, hljs), 2);
  const figures = [...copy.querySelectorAll("figure.diff-hunk-export")];
  assert.equal(figures.length, 2);
  assert.equal(copy.querySelector(".diff-hunk"), null);
  assert.equal(figures[0].querySelector("figcaption").textContent, "src/main.rs (lines 10-14)");
  assert.equal(figures[1].querySelector("figcaption").textContent, "b.js (deleted, old lines 1-2)");
  const code = figures[0].querySelector("pre > code.language-diff");
  assert.equal(code.textContent, BODY);
  assert.ok(code.querySelector(".hljs-addition"));
  assert.ok(!copy.innerHTML.includes("data-source"));

  const raw = preview(HUNK);
  assert.equal(exportHunks(raw), 1);
  assert.equal(raw.querySelector("figure pre code").textContent, BODY);
});

// The book Sodilaud's own review-book skill wrote for #25, when this checkout
// (or the repository holding this worktree) has one.
const BOOK = ["../.claude/review/feat-mermaid-diagrams/", "../../../review/feat-mermaid-diagrams/"]
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
  .find(path => existsSync(path)) ?? "";

test("a generated review book renders every hunk as a widget", { skip: !BOOK && "no local review book" }, () => {
  for (const name of readdirSync(BOOK).filter(file => file.endsWith(".md"))) {
    const text = readFileSync(`${BOOK}${name}`, "utf8");
    const fences = (text.match(/^`{3,}diff path=/gm) ?? []).length;
    const container = preview(text);
    assert.equal(renderHunkWidgets(container, { hljs }), fences, name);
  }
});
