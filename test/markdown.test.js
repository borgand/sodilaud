// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import {
  isSafeMarkdownUrl,
  keepTableValuesWhole,
  parseSiblingHref,
  renderMarkdown,
  resolveLinkAction,
  sanitizeMarkdownHtml
} from "../src/markdown.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.document = dom.window.document;

test("sanitizer removes active content and event handlers", () => {
  const html = sanitizeMarkdownHtml(
    '<p onclick="alert(1)">safe<script>alert(2)</script><iframe src="https://example.com">hidden</iframe></p>'
  );

  assert.equal(html, "<p>safe</p>");
});

test("sanitizer does not trust highlight markup from note content", () => {
  const html = sanitizeMarkdownHtml('<mark class="find-preview-match" data-find-index="0">safe</mark>');

  assert.equal(html, "safe");
});

test("sanitizer restricts links and isolates safe external links", () => {
  const unsafe = sanitizeMarkdownHtml('<a href="javascript:alert(1)">bad</a>');
  const safe = sanitizeMarkdownHtml('<a href="https://example.com">good</a>');

  assert.equal(unsafe, "<a>bad</a>");
  assert.match(safe, /href="https:\/\/example\.com"/);
  assert.match(safe, /target="_blank"/);
  assert.match(safe, /rel="noopener noreferrer"/);
});

test("remote images are blocked while supported embedded images remain", () => {
  const remote = sanitizeMarkdownHtml('<img src="https://example.com/tracker.png">');
  const embedded = sanitizeMarkdownHtml('<img src="data:image/png;base64,AA==" alt="embedded">');

  assert.equal(remote, "");
  assert.match(embedded, /^<img src="data:image\/png;base64,AA=="/);
});

test("checkboxes are always disabled", () => {
  const html = sanitizeMarkdownHtml('<input type="checkbox" checked>');
  assert.match(html, /disabled/);
});

test("task list items are marked so the preview can hide their bullet", () => {
  const html = renderMarkdown("- [ ] todo\n- normal", "", marked);

  assert.match(html, /<li class="task-list-item"><input[^>]+> todo<\/li>/);
  assert.match(html, /<li>normal<\/li>/);
});

test("a parent bullet remains when only its nested child is a task", () => {
  const html = renderMarkdown("- parent\n  - [ ] child", "", marked);

  assert.match(html, /<li>parent<ul>/);
  assert.match(html, /<li class="task-list-item"><input[^>]+> child<\/li>/);
});

test("rendered Markdown passes through the sanitizer", () => {
  const html = renderMarkdown('[unsafe](javascript:alert(1))\n\n<script>alert(2)</script>', "", marked);

  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /script/i);
});

test("preview links route external schemes to the browser", () => {
  assert.deepEqual(resolveLinkAction("https://example.com"), {
    kind: "external",
    url: "https://example.com"
  });
  assert.deepEqual(resolveLinkAction("http://example.com"), {
    kind: "external",
    url: "http://example.com"
  });
  assert.deepEqual(resolveLinkAction("mailto:someone@example.com"), {
    kind: "external",
    url: "mailto:someone@example.com"
  });
});

test("preview links scroll to in-document anchors", () => {
  assert.deepEqual(resolveLinkAction("#a-heading"), { kind: "anchor", fragment: "a-heading" });
  assert.deepEqual(resolveLinkAction("#caf%C3%A9"), { kind: "anchor", fragment: "café" });
  assert.deepEqual(resolveLinkAction("#"), { kind: "ignore" });
});

test("preview links open sibling documents by relative path", () => {
  assert.deepEqual(resolveLinkAction("01-mcp-tools.md#h3f2a1"), {
    kind: "sibling", path: "01-mcp-tools.md", fragment: "h3f2a1"
  });
  assert.deepEqual(resolveLinkAction("notes/Read%20me.TXT"), {
    kind: "sibling", path: "notes/Read me.TXT", fragment: ""
  });
  assert.deepEqual(resolveLinkAction("./b.markdown#x"), {
    kind: "sibling", path: "./b.markdown", fragment: "x"
  });
});

test("sibling links reject anything that could leave the folder or is not text", () => {
  const rejected = [
    "../secret.md",
    "a/../../b.md",
    "%2e%2e/secret.md",
    "a/%2e%2e/%2e%2e/b.md",
    "..%2fsecret.md",
    "/etc/notes.md",
    "//host/notes.md",
    "file:notes.md",
    "C:\\notes.md",
    "a\\b.md",
    "notes.md?x=1",
    "picture.png",
    "notes.md.exe",
    "notes",
    "a//b.md",
    "%ZZ.md",
    "notes .md"
  ];
  rejected.forEach(href => {
    assert.equal(parseSiblingHref(href), null, `expected ${href} to be rejected`);
    assert.equal(resolveLinkAction(href).kind, "ignore", `expected ${href} to be ignored`);
  });
});

test("sanitizer keeps sibling and anchor links without opening a new window", () => {
  const html = sanitizeMarkdownHtml('<a href="02-merge.md#engine">a</a><a href="#top">b</a><a href="../x.md">c</a>');
  assert.equal(html, '<a href="02-merge.md#engine">a</a><a href="#top">b</a><a>c</a>');
});

test("sanitizer gives headings GitHub-style anchors after sanitizing", () => {
  const html = sanitizeMarkdownHtml('<h1 id="evil" data-anchor="x">Merge engine</h1><h2>Merge engine</h2><h3>What’s new?</h3>');
  assert.equal(
    html,
    '<h1 data-anchor="merge-engine">Merge engine</h1><h2 data-anchor="merge-engine-1">Merge engine</h2><h3 data-anchor="whats-new">What’s new?</h3>'
  );
});

test("rendered review hunks carry their id and nothing forged survives", () => {
  const html = renderMarkdown("```diff path=src/a.rs hunk=h3f2a1 lines=1-2\n+x\n```\n\n```diff hunk=nope\n+y\n```", "", marked);
  assert.match(html, /<code data-hunk="h3f2a1" data-path="src\/a.rs" data-lines="1-2" class="language-diff">/);
  assert.doesNotMatch(html, /nope/);
  assert.equal(sanitizeMarkdownHtml('<code data-hunk="h12345x" data-path="../a">z</code>'), "<code>z</code>");
});

test("preview links never hand an unsupported scheme to the system", () => {
  const ignored = [
    "javascript:alert(1)",
    "java\nscript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "tel:+15550100",
    "",
    "   ",
    null,
    undefined
  ];

  ignored.forEach((href) => {
    assert.equal(resolveLinkAction(href).kind, "ignore", `expected ${href} to be ignored`);
  });
});

test("URL policy rejects obfuscated active schemes", () => {
  assert.equal(isSafeMarkdownUrl("java\nscript:alert(1)"), false);
  assert.equal(isSafeMarkdownUrl("https://example.com"), true);
  assert.equal(isSafeMarkdownUrl("https://example.com/image.png", true), false);
});

function renderTable(markdown) {
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(markdown, "", marked);
  return container;
}

const nowrapTexts = node => [...node.querySelectorAll("span.table-token")].map(span => {
  assert.match(span.getAttribute("style"), /white-space:\s*nowrap/);
  return span.textContent;
});

test("short table values with break characters are kept whole", () => {
  const container = renderTable(
    "| Date | ID | Notes |\n|---|---|---|\n| 2026-09-30 | LB-01 | a long description of the work |"
  );

  assert.deepEqual(nowrapTexts(container), ["2026-09-30", "LB-01"]);
  assert.equal(container.querySelector("tbody td:nth-child(3)").innerHTML, "a long description of the work");
});

test("a table value with spaces can still wrap between its words", () => {
  const cell = renderTable("| When |\n|---|\n| 2026-09-30 14:00 |").querySelector("td");

  assert.deepEqual(nowrapTexts(cell), ["2026-09-30", "14:00"]);
  assert.equal(cell.textContent, "2026-09-30 14:00");
  assert.equal(cell.childNodes[1].nodeValue, " ");
});

test("long tokens and CJK text in tables stay breakable", () => {
  const container = renderTable(
    "| Link | Text |\n|---|---|\n| https://example.com/a/long/path | 日本語、テスト |"
  );

  assert.deepEqual(nowrapTexts(container), []);
});

test("an 18-character token is the longest kept whole", () => {
  const container = renderTable("| A | B |\n|---|---|\n| 123456789-12345678 | 123456789-123456789 |");

  assert.deepEqual(nowrapTexts(container), ["123456789-12345678"]);
});

test("tokens inside inline markup in a cell are kept whole", () => {
  const container = renderTable("| A |\n|---|\n| `LB-01` and **2026-09-30** |");

  assert.deepEqual(nowrapTexts(container), ["LB-01", "2026-09-30"]);
  assert.equal(container.querySelector("code span.table-token").textContent, "LB-01");
});

test("each table scrolls horizontally inside its own box", () => {
  const container = renderTable("| a |\n|---|\n| 1 |\n\ntext\n\n| b |\n|---|\n| 2 |");
  const boxes = container.querySelectorAll("div.table-scroll");

  assert.equal(boxes.length, 2);
  boxes.forEach(box => {
    assert.match(box.getAttribute("style"), /overflow-x:\s*auto/);
    assert.equal(box.children.length, 1);
    assert.equal(box.firstElementChild.tagName, "TABLE");
  });
});

test("text outside tables is left alone", () => {
  const html = renderMarkdown("Due 2026-09-30 for LB-01.", "", marked);

  assert.equal(html.trim(), "<p>Due 2026-09-30 for LB-01.</p>");
});

test("note content cannot forge the table layout styles", () => {
  const html = sanitizeMarkdownHtml(
    '<div class="table-scroll" style="position:fixed">x</div><span class="table-token" style="color:red">y</span>'
  );

  assert.equal(html, "xy");
});

test("keeping table values whole twice changes nothing", () => {
  const container = renderTable("| Date | Notes |\n|---|---|\n| 2026-09-30 | done |");
  const once = container.innerHTML;

  keepTableValuesWhole(container);
  assert.equal(container.innerHTML, once);
  assert.equal(sanitizeMarkdownHtml(once), once);
});
