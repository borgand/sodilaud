// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { installEditorDom } from "./helpers/cm-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(text, { focused = true } = {}) {
  const env = installEditorDom();
  env.window.marked = marked;
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const live = await import("../src/editor-live-preview.js");
  const opened = [];
  const changes = [];
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    onChange: value => changes.push(value),
    extensions: [live.livePreview({ onOpenLink: href => opened.push(href) })]
  });
  let hasFocus = focused;
  Object.defineProperty(editor.view, "hasFocus", { get: () => hasFocus, configurable: true });
  editor.loadText(text);
  const t = {
    env, editor, opened, changes, live,
    view: editor.view,
    lines: () => [...editor.view.contentDOM.querySelectorAll(".cm-line")],
    lineTexts: () => t.lines().map(line => line.textContent),
    setFocus(value) { hasFocus = value; },
    async caret(pos) {
      editor.setSelection(pos, pos);
      await settle();
    },
    mousedown(target, init = {}) {
      const event = new env.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init });
      target.dispatchEvent(event);
      return event;
    },
    done() { editor.destroy(); env.cleanup(); }
  };
  return t;
}

test("headings hide their marks unless the caret line is revealed", async () => {
  const t = await setup("# Title\n\nbody");
  try {
    await t.caret(t.editor.getText().length);
    const first = t.view.contentDOM.querySelector(".cm-line");
    assert.ok(first.classList.contains("cm-lp-h1"));
    assert.equal(first.textContent, "Title");
    await t.caret(1);
    assert.equal(t.view.contentDOM.querySelector(".cm-line").textContent, "# Title");
    assert.ok(t.view.contentDOM.querySelector(".cm-line").classList.contains("cm-lp-h1"));
  } finally { t.done(); }
});

test("an unfocused editor renders every line, including the caret line", async () => {
  const t = await setup("# Title\n\n**b**", { focused: false });
  try {
    await t.caret(1);
    assert.deepEqual(t.lineTexts(), ["Title", "", "b"]);
  } finally { t.done(); }
});

test("emphasis and links render with a data-href on the link text", async () => {
  const t = await setup("**b** [l](https://x.y)\nother");
  try {
    await t.caret(t.editor.getText().length);
    assert.equal(t.lineTexts()[0], "b l");
    const link = t.view.contentDOM.querySelector('.cm-lp-link[data-href="https://x.y"]');
    assert.ok(link);
    assert.equal(link.textContent, "l");
  } finally { t.done(); }
});

function setPlatform(t, platform) {
  Object.defineProperty(t.env.window.navigator, "platform", { value: platform, configurable: true });
}

test("Cmd-mousedown on a link opens it, a plain mousedown does not", async () => {
  const t = await setup("[l](https://x.y)\nother");
  setPlatform(t, "MacIntel");
  try {
    await t.caret(t.editor.getText().length);
    const link = t.view.contentDOM.querySelector(".cm-lp-link");
    t.mousedown(link);
    assert.deepEqual(t.opened, []);
    const event = t.mousedown(t.view.contentDOM.querySelector(".cm-lp-link"), { metaKey: true });
    assert.deepEqual(t.opened, ["https://x.y"]);
    assert.equal(event.defaultPrevented, true);
  } finally { t.done(); }
});

test("on macOS Ctrl-click is a right-click, so only Cmd opens links", async () => {
  const t = await setup("[l](https://x.y)\nother");
  setPlatform(t, "MacIntel");
  try {
    await t.caret(t.editor.getText().length);
    const event = t.mousedown(t.view.contentDOM.querySelector(".cm-lp-link"), { ctrlKey: true });
    assert.deepEqual(t.opened, []);
    assert.equal(event.defaultPrevented, false);
  } finally { t.done(); }
});

test("off macOS Ctrl-click opens links and Meta-click does not", async () => {
  const t = await setup("[l](https://x.y)\nother");
  setPlatform(t, "Win32");
  try {
    await t.caret(t.editor.getText().length);
    t.mousedown(t.view.contentDOM.querySelector(".cm-lp-link"), { metaKey: true });
    assert.deepEqual(t.opened, []);
    const event = t.mousedown(t.view.contentDOM.querySelector(".cm-lp-link"), { ctrlKey: true });
    assert.deepEqual(t.opened, ["https://x.y"]);
    assert.equal(event.defaultPrevented, true);
  } finally { t.done(); }
});

test("task markers become checkboxes that toggle the Markdown", async () => {
  const t = await setup("- [ ] t\nother");
  try {
    await t.caret(t.editor.getText().length);
    const box = t.view.contentDOM.querySelector("input.cm-lp-task");
    assert.ok(box);
    assert.equal(box.checked, false);
    assert.equal(t.lineTexts()[0], " t");
    t.mousedown(box);
    assert.equal(t.editor.getText(), "- [x] t\nother");
    assert.deepEqual(t.changes, ["- [x] t\nother"]);
    assert.equal(t.view.contentDOM.querySelector("input.cm-lp-task").checked, true);
  } finally { t.done(); }
});

test("bullet list marks become bullets, ordered marks stay text", async () => {
  const t = await setup("- a\n1. b\nother");
  try {
    await t.caret(t.editor.getText().length);
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-bullet"));
    assert.equal(t.lineTexts()[1], "1. b");
  } finally { t.done(); }
});

test("remote images never render, data images do", async () => {
  const t = await setup("![a](https://evil.example/x.png)\nother");
  try {
    await t.caret(t.editor.getText().length);
    assert.equal(t.view.contentDOM.querySelector("img"), null);
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-image-blocked"));
    t.editor.loadText("![a](data:image/png;base64,iVBORw0KGgo=)\nother");
    await t.caret(t.editor.getText().length);
    const images = t.view.contentDOM.querySelectorAll("img.cm-lp-image");
    assert.equal(images.length, 1);
    assert.equal(images[0].getAttribute("alt"), "a");
  } finally { t.done(); }
});

test("tables render as an HTML widget until the caret enters them", async () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const t = await setup(`intro\n\n${table}\n\nafter`);
  try {
    await t.caret(0);
    assert.equal(t.view.contentDOM.querySelectorAll(".cm-lp-table table").length, 1);
    assert.ok(t.lineTexts().every(text => !text.includes("|---")));
    await t.caret(t.editor.getText().indexOf("| 1"));
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-table"), null);
    assert.ok(t.lineTexts().some(text => text.includes("|---")));
  } finally { t.done(); }
});

test("clicking a table widget moves the caret into the table", async () => {
  const t = await setup("intro\n\n| a |\n|---|\n| 1 |");
  try {
    await t.caret(0);
    t.mousedown(t.view.contentDOM.querySelector(".cm-lp-table"));
    await settle();
    assert.equal(t.editor.getSelection().start, 7);
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-table"), null);
  } finally { t.done(); }
});

test("source mode shows raw Markdown with no live preview decorations", async () => {
  const t = await setup("# T\n**b** [l](https://x.y)\n- [ ] t\n---\n\n| a |\n|---|\n| 1 |\n\nend");
  try {
    await t.caret(t.editor.getText().length);
    assert.ok(t.view.contentDOM.querySelector("[class*='cm-lp-']"));
    t.editor.setMode("source");
    await settle();
    assert.equal(t.view.contentDOM.querySelector("[class*='cm-lp-']"), null);
    assert.deepEqual(t.lineTexts().slice(0, 4), ["# T", "**b** [l](https://x.y)", "- [ ] t", "---"]);
    assert.ok(t.lineTexts().includes("|---|"));
  } finally { t.done(); }
});

test("quotes, inline code, strikethrough, rules and fenced code get live styling", async () => {
  const t = await setup("> q\n`c` ~~s~~\n---\n```\nx\n```\nend");
  try {
    await t.caret(t.editor.getText().length);
    const lines = t.lines();
    assert.ok(lines[0].classList.contains("cm-lp-quote"));
    assert.equal(lines[0].textContent, "q");
    assert.equal(lines[1].textContent, "c s");
    assert.ok(lines[1].querySelector(".cm-lp-code"));
    assert.ok(lines[2].classList.contains("cm-lp-hr"));
    assert.ok(lines[2].querySelector("hr.cm-lp-hr-widget"));
    assert.ok(lines[3].classList.contains("cm-lp-codeblock"));
    assert.equal(lines[3].textContent, "```");
  } finally { t.done(); }
});

test("a 5,000-line note with 200 tables stays responsive and bounds the table cache", { timeout: 5000 }, async () => {
  const blocks = [];
  for (let i = 0; i < 200; i += 1) {
    blocks.push(`\n| h${i} | b |\n|---|---|\n| ${i} | x |\n`);
    for (let j = 0; j < 20; j += 1) blocks.push(`line ${i}.${j} with **bold** and [a](https://x.y/${j})`);
  }
  const text = blocks.join("\n");
  assert.ok(text.split("\n").length >= 5000);
  const t = await setup(text);
  try {
    for (let i = 0; i < 50; i += 1) {
      const pos = Math.floor((text.length / 50) * i);
      t.editor.setSelection(pos, pos);
    }
    await settle();
    assert.equal(t.editor.getSelection().start, Math.floor((text.length / 50) * 49));
    assert.ok(t.live.__tableCacheSize() <= 200);
    for (let i = 0; i < 210; i += 1) {
      t.editor.loadText(`| t${i} |\n|---|\n| ${i} |\n\nend`);
      assert.ok(t.view.contentDOM.querySelector(".cm-lp-table"));
    }
    assert.equal(t.live.__tableCacheSize(), 200);
  } finally { t.done(); }
});
