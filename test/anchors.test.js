// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { JSDOM } from "jsdom";
import { installEditorDom } from "./helpers/cm-dom.js";
import {
  createSlugger,
  findReadingAnchor,
  hunkIdFromInfo,
  parseFenceInfo,
  slugify
} from "../src/anchors.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const BOOK = [
  "# Merge engine",
  "",
  "## The **merge** `engine`",
  "",
  "Setext *heading*",
  "---",
  "",
  "## Merge engine",
  "",
  "### [register_tools()](01-mcp.md#h3f2a1) & more!",
  "",
  "```diff path=src/mcp.rs hunk=h3f2a1 lines=120-168",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "```",
  "",
  "```diff hunk=H3F2A1",
  "+not an id",
  "```",
  "",
  "    # not a heading",
  ""
].join("\n");

test("slugs follow GitHub's rules", () => {
  assert.equal(slugify("Merge Engine"), "merge-engine");
  assert.equal(slugify("  What's new?  "), "whats-new");
  assert.equal(slugify("register_tools() & more!"), "register_tools--more");
  assert.equal(slugify("Ünïcode 日本語"), "ünïcode-日本語");
  assert.equal(slugify("a - b"), "a---b");
  assert.equal(slugify("The `merge` [engine](02-merge.md) <em>now</em>"), "the-merge-engine-now");
});

test("repeated slugs get numbered suffixes in document order", () => {
  const slug = createSlugger();
  assert.deepEqual(["A", "A", "a", "A-1", "B"].map(slug), ["a", "a-1", "a-2", "a-1-1", "b"]);
});

test("fence info strings expose a valid hunk id only", () => {
  assert.deepEqual(parseFenceInfo("diff path=a.rs hunk=h3f2a1 lines=1-2 reviewed"), {
    lang: "diff",
    attrs: { path: "a.rs", hunk: "h3f2a1", lines: "1-2", reviewed: "" }
  });
  assert.deepEqual(parseFenceInfo('diff path="a b.rs" hunk=h3f2a1').attrs, { path: "a b.rs", hunk: "h3f2a1" });
  assert.equal(hunkIdFromInfo("diff path=a.rs hunk=h3f2a1"), "h3f2a1");
  assert.equal(hunkIdFromInfo("diff hunk=H3F2A1"), null);
  assert.equal(hunkIdFromInfo("diff hunk=h3f2a101"), null);
  assert.equal(hunkIdFromInfo("js"), null);
  assert.equal(hunkIdFromInfo(undefined), null);
});

async function readingDom() {
  const dom = new JSDOM("<!doctype html><div id=root></div>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const { renderMarkdown } = await import("../src/markdown.js");
    const root = dom.window.document.getElementById("root");
    root.innerHTML = renderMarkdown(BOOK, "", marked);
    return root;
  } finally {
    globalThis.document = previous;
  }
}

async function liveAnchors() {
  const env = installEditorDom();
  try {
    const { createMarkdownEditor } = await import("../src/editor-view.js");
    const { documentAnchors } = await import("../src/editor-anchors.js");
    const editor = createMarkdownEditor({ parent: env.document.getElementById("host"), ariaLabel: "t" });
    editor.loadText(BOOK);
    const anchors = documentAnchors(editor.view.state);
    editor.destroy();
    return anchors;
  } finally { env.cleanup(); }
}

test("Reading and Live mode give every heading the same slug", async () => {
  const root = await readingDom();
  const reading = [...root.querySelectorAll("[data-anchor]")].map(element => element.getAttribute("data-anchor"));
  const live = (await liveAnchors()).filter(anchor => anchor.kind === "heading").map(anchor => anchor.id);
  assert.deepEqual(reading, ["merge-engine", "the-merge-engine", "setext-heading", "merge-engine-1", "register_tools--more"]);
  assert.deepEqual(live, reading);
});

test("Live mode lists hunk fences and heading levels as anchors", async () => {
  const anchors = await liveAnchors();
  assert.deepEqual(anchors.map(({ kind, id, level }) => [kind, id, level]), [
    ["heading", "merge-engine", 1],
    ["heading", "the-merge-engine", 2],
    ["heading", "setext-heading", 2],
    ["heading", "merge-engine-1", 2],
    ["heading", "register_tools--more", 3],
    ["hunk", "h3f2a1", undefined]
  ]);
  const hunk = anchors.at(-1);
  assert.equal(BOOK.slice(hunk.from, hunk.from + 3), "```");
});

test("Reading mode finds headings and hunks by fragment", async () => {
  const root = await readingDom();
  assert.equal(findReadingAnchor(root, "merge-engine-1").textContent, "Merge engine");
  assert.equal(findReadingAnchor(root, "h3f2a1").tagName, "PRE");
  assert.equal(findReadingAnchor(root, "missing"), null);
  assert.equal(findReadingAnchor(root, ""), null);
  assert.equal(findReadingAnchor(root, 'x"]'), null);
});

test("Cmd-click on an anchor link scrolls Live mode instead of opening it", async () => {
  const env = installEditorDom();
  env.window.marked = marked;
  Object.defineProperty(env.window.navigator, "platform", { value: "MacIntel", configurable: true });
  try {
    const { createMarkdownEditor } = await import("../src/editor-view.js");
    const live = await import("../src/editor-live-preview.js");
    const opened = [];
    const editor = createMarkdownEditor({
      parent: env.document.getElementById("host"),
      ariaLabel: "t",
      extensions: [live.livePreview({ onOpenLink: href => opened.push(href) })]
    });
    editor.loadText("[jump](#target) [next](02-b.md#x)\n\n# Target\n");
    const scrolled = [];
    const dispatch = editor.view.dispatch.bind(editor.view);
    editor.view.dispatch = (...specs) => {
      specs.forEach(spec => spec?.effects && scrolled.push(spec.effects));
      return dispatch(...specs);
    };
    await settle();
    const link = href => [...env.document.querySelectorAll(".cm-lp-link")].find(element => element.getAttribute("data-href") === href);
    const click = element => element.dispatchEvent(new env.window.MouseEvent("mousedown", {
      bubbles: true, cancelable: true, button: 0, metaKey: true
    }));
    click(link("#target"));
    assert.deepEqual(opened, []);
    assert.equal(scrolled.length, 1);
    click(link("02-b.md#x"));
    assert.deepEqual(opened, ["02-b.md#x"]);
    editor.destroy();
  } finally { env.cleanup(); }
});
