// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { setupLive as setup, settle } from "./helpers/live-editor.js";

function loadHighlighter() {
  const context = {};
  vm.runInNewContext(`${readFileSync(new URL("../src/vendor/highlight.min.js", import.meta.url), "utf8")};this.hljs = hljs;`, context);
  return context.hljs;
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

for (const [source, href] of [
  ["[a](<https://x.y/a b>)", "https://x.y/a b"],
  ["[c](https://x.y/\\(p\\))", "https://x.y/(p)"]
]) {
  test(`link data-href is the destination URL for ${source}`, async () => {
    const t = await setup(`${source}\nother`);
    try {
      await t.caret(t.editor.getText().length);
      assert.equal(t.view.contentDOM.querySelector(".cm-lp-link").getAttribute("data-href"), href);
    } finally { t.done(); }
  });
}

function setPlatform(t, platform) {
  Object.defineProperty(t.env.window.navigator, "platform", { value: platform, configurable: true });
}

// Each click starts from a fresh render with the caret on another line, so the
// link is still rendered (not revealed as raw Markdown) when it is clicked.
async function clickLink(t, init = {}) {
  await t.caret(t.editor.getText().length);
  const link = t.view.contentDOM.querySelector(".cm-lp-link");
  assert.ok(link, "the link renders while the caret is on another line");
  return t.mousedown(link, init);
}

const caretLine = t => t.view.state.doc.lineAt(t.view.state.selection.main.head).number;
const selectionStartLine = t => t.view.state.doc.lineAt(t.view.state.selection.main.from).number;

test("a plain click on a link follows it on mouse up and leaves the caret", async () => {
  const t = await setup("[l](https://x.y)\nother");
  try {
    const down = await clickLink(t, { clientX: 10, clientY: 10 });
    assert.equal(down.defaultPrevented, true);
    assert.deepEqual(t.opened, [], "nothing opens before the button is released");
    t.mouseup(t.env.document, { clientX: 10, clientY: 10 });
    assert.deepEqual(t.opened, ["https://x.y"]);
    assert.equal(caretLine(t), 2, "following a link leaves the caret where it was");
  } finally { t.done(); }
});

test("a press that drags off a link follows nothing", async () => {
  const t = await setup("[l](https://x.y)\nother");
  try {
    await clickLink(t, { clientX: 10, clientY: 10 });
    const drags = [];
    const dispatch = t.view.dispatch.bind(t.view);
    t.view.dispatch = (...specs) => {
      specs.forEach(spec => spec?.userEvent === "select.pointer" && drags.push(spec.selection));
      return dispatch(...specs);
    };
    t.mousemove(t.env.document, { clientX: 40, clientY: 10, buttons: 1 });
    t.mouseup(t.env.document, { clientX: 40, clientY: 10 });
    assert.deepEqual(t.opened, []);
    assert.ok(drags.length === 1, "the drag extends the selection");
    t.mouseup(t.env.document, { clientX: 10, clientY: 10 });
    assert.deepEqual(t.opened, [], "the listeners are gone after mouse up");
  } finally { t.done(); }
});

test("a lost mouse up leaves no phantom drag", async () => {
  const t = await setup("[l](https://x.y)\nother");
  try {
    await clickLink(t, { clientX: 10, clientY: 10 });
    const drags = [];
    const dispatch = t.view.dispatch.bind(t.view);
    t.view.dispatch = (...specs) => {
      specs.forEach(spec => spec?.userEvent === "select.pointer" && drags.push(spec));
      return dispatch(...specs);
    };
    t.mousemove(t.env.document, { clientX: 40, clientY: 10, buttons: 0 });
    t.mousemove(t.env.document, { clientX: 80, clientY: 10, buttons: 1 });
    assert.ok(drags.length === 0);
  } finally { t.done(); }
});

test("a double click on a link is left to the editor and follows nothing", async () => {
  const t = await setup("[l](https://x.y)\nother");
  try {
    await clickLink(t, { detail: 2 });
    t.mouseup(t.env.document, {});
    assert.deepEqual(t.opened, []);
    assert.ok(selectionStartLine(t) === 1);
  } finally { t.done(); }
});

test("a plain click on an ignored-scheme link in a table places the caret", async () => {
  const t = await setup("intro\n\n| [t](#) |\n|---|\n| 1 |\n\nafter");
  try {
    await t.caret(0);
    const link = t.view.contentDOM.querySelector(".cm-lp-table a[href]");
    assert.ok(link);
    t.mousedown(link);
    t.mouseup(link);
    assert.deepEqual(t.opened, []);
    assert.ok(t.view.state.selection.main.head > 0);
  } finally { t.done(); }
});

test("Cmd-click on a link places the caret in it", async () => {
  const t = await setup("[l](https://x.y)\nother");
  setPlatform(t, "MacIntel");
  try {
    await clickLink(t, { metaKey: true });
    t.mouseup(t.env.document, {});
    assert.deepEqual(t.opened, []);
    // jsdom has no layout, so CodeMirror maps the click to an approximate range;
    // what matters is that the selection now reaches into the link line.
    assert.equal(selectionStartLine(t), 1);
  } finally { t.done(); }
});

test("off macOS Ctrl-click on a link places the caret and Meta-click follows nothing", async () => {
  const t = await setup("[l](https://x.y)\nother");
  setPlatform(t, "Win32");
  try {
    await clickLink(t, { metaKey: true });
    t.mouseup(t.env.document, {});
    assert.deepEqual(t.opened, []);
    await clickLink(t, { ctrlKey: true });
    t.mouseup(t.env.document, {});
    assert.deepEqual(t.opened, []);
    assert.equal(selectionStartLine(t), 1);
  } finally { t.done(); }
});

test("on macOS Ctrl-click is a right-click and follows nothing", async () => {
  const t = await setup("[l](https://x.y)\nother");
  setPlatform(t, "MacIntel");
  try {
    await clickLink(t, { ctrlKey: true });
    t.mouseup(t.env.document, {});
    assert.deepEqual(t.opened, []);
  } finally { t.done(); }
});

test("a plain click on a link in a rendered table follows it", async () => {
  const t = await setup("intro\n\n| [t](https://t.y) |\n|---|\n| 1 |\n\nafter");
  try {
    await t.caret(0);
    const link = t.view.contentDOM.querySelector(".cm-lp-table a[href]");
    assert.ok(link);
    t.mousedown(link);
    t.mouseup(link);
    assert.deepEqual(t.opened, ["https://t.y"]);
  } finally { t.done(); }
});

test("hovering a link shows no follow button", async () => {
  const t = await setup("[l](https://x.y)\nother");
  try {
    await t.caret(t.editor.getText().length);
    const link = t.view.contentDOM.querySelector(".cm-lp-link");
    link.dispatchEvent(new t.env.window.MouseEvent("mouseover", { bubbles: true }));
    assert.ok(!t.view.dom.querySelector(".cm-lp-follow"));
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

for (const [label, platform, init] of [
  ["a right-click", "Win32", { button: 2 }],
  ["a middle-click", "Win32", { button: 1 }],
  ["a macOS Ctrl-click", "MacIntel", { ctrlKey: true }]
]) {
  test(`${label} leaves task checkboxes and table widgets alone`, async () => {
    const t = await setup("- [ ] t\n\n| a |\n|---|\n| 1 |\n\nother");
    setPlatform(t, platform);
    try {
      await t.caret(t.editor.getText().length);
      t.mousedown(t.view.contentDOM.querySelector("input.cm-lp-task"), init);
      assert.equal(t.editor.getText(), "- [ ] t\n\n| a |\n|---|\n| 1 |\n\nother");
      assert.deepEqual(t.changes, []);

      const caret = t.editor.getSelection().start;
      t.mousedown(t.view.contentDOM.querySelector(".cm-lp-table"), init);
      await settle();
      assert.equal(t.editor.getSelection().start, caret);
      assert.ok(t.view.contentDOM.querySelector(".cm-lp-table"));
    } finally { t.done(); }
  });
}

test("off macOS a Ctrl-click still toggles a task checkbox", async () => {
  const t = await setup("- [ ] t\nother");
  setPlatform(t, "Win32");
  try {
    await t.caret(t.editor.getText().length);
    t.mousedown(t.view.contentDOM.querySelector("input.cm-lp-task"), { ctrlKey: true });
    assert.equal(t.editor.getText(), "- [x] t\nother");
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
    assert.ok(!t.view.contentDOM.querySelector("img"), "expected no match");
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-image-blocked"));
    t.editor.loadText("![a](data:image/png;base64,iVBORw0KGgo=)\nother");
    await t.caret(t.editor.getText().length);
    const images = t.view.contentDOM.querySelectorAll("img.cm-lp-image");
    assert.equal(images.length, 1);
    assert.equal(images[0].getAttribute("alt"), "a");
  } finally { t.done(); }
});

test("tables render as an HTML widget until the caret enters them, then as a grid", async () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const t = await setup(`intro\n\n${table}\n\nafter`);
  try {
    await t.caret(0);
    assert.equal(t.view.contentDOM.querySelectorAll(".cm-lp-table table").length, 1);
    assert.ok(t.lineTexts().every(text => !text.includes("|---")));
    await t.caret(t.editor.getText().indexOf("| 1"));
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-table"), "expected no match");
    assert.equal(t.view.contentDOM.querySelectorAll(".cm-line.cm-lp-trow").length, 3);
    assert.ok(t.lineTexts().every(text => !text.includes("|")));
    assert.equal(t.editor.getSelection().start, t.editor.getText().indexOf("1 |"));
  } finally { t.done(); }
});

test("the Live table widget keeps short values whole and scrolls wide tables", async () => {
  const table = "| Date | Notes |\n|---|---|\n| 2026-09-30 | a long description |";
  const t = await setup(`intro\n\n${table}\n\nafter`);
  try {
    await t.caret(0);
    const widget = t.view.contentDOM.querySelector(".cm-lp-table");
    assert.ok(widget.querySelector("div.table-scroll > table"));
    assert.deepEqual([...widget.querySelectorAll("span.table-token")].map(span => span.textContent), ["2026-09-30"]);
  } finally { t.done(); }
});

test("clicking a table widget moves the caret into the table's grid", async () => {
  const t = await setup("intro\n\n| a |\n|---|\n| 1 |");
  try {
    await t.caret(0);
    t.mousedown(t.view.contentDOM.querySelector(".cm-lp-table"));
    await settle();
    assert.equal(t.editor.getSelection().start, 9);
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-table"), "expected no match");
    assert.equal(t.view.contentDOM.querySelectorAll(".cm-line.cm-lp-trow").length, 3);
  } finally { t.done(); }
});

// Never pass an editor DOM node to assert.equal: its cmTile property makes a
// failure message inspect the whole editor, which once took 150 GB.
const COMMENT_TABLE = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter";

function selectText(t, needle, end = needle) {
  const text = t.editor.getText();
  const from = text.indexOf(needle);
  t.editor.setSelection(from, text.indexOf(end) + end.length);
}

test("a composer inside a table keeps the table rendered and sits below it", async () => {
  const t = await setup(COMMENT_TABLE, { comments: true });
  try {
    selectText(t, "2 |", "2");
    await settle();
    assert.ok(t.commentsApi.startComment(t.view));
    await settle();
    const table = t.view.contentDOM.querySelector(".cm-lp-table");
    assert.ok(table);
    assert.equal(table.querySelector(".cm-comment-draft")?.textContent, "2");
    const composer = table.querySelector(".cm-lp-table-composer .cm-comment-composer");
    assert.ok(composer);
    const selection = t.editor.getSelection();
    const event = t.mousedown(composer.querySelector("textarea"));
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(t.editor.getSelection(), selection);
  } finally { t.done(); }
});

test("focus leaving for the composer does not rebuild the table", async () => {
  const t = await setup(COMMENT_TABLE, { comments: true });
  try {
    selectText(t, "2 |", "2");
    await settle();
    t.commentsApi.startComment(t.view);
    await settle();
    const table = t.view.contentDOM.querySelector(".cm-lp-table");
    const input = table.querySelector(".cm-comment-composer textarea");
    let updates = 0;
    const update = t.view.update.bind(t.view);
    t.view.update = transactions => {
      if (++updates > 20) throw new Error("the focus sync and the table keep updating each other");
      update(transactions);
    };
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    await settle();
    assert.ok(updates >= 1 && updates <= 3, `${updates} updates`);
    assert.ok(table.isConnected);
    assert.ok(input.isConnected);
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-table") === table, "the same table element");
  } finally { t.done(); }
});

test("an edit inside the table while composing keeps the text and focus", async () => {
  const t = await setup(COMMENT_TABLE, { comments: true });
  try {
    selectText(t, "2 |", "2");
    await settle();
    t.commentsApi.startComment(t.view);
    await settle();
    const input = t.view.contentDOM.querySelector(".cm-lp-table .cm-comment-composer textarea");
    input.value = "half typed";
    input.focus();
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    await settle();
    const one = t.editor.getText().indexOf("1 |");
    t.view.dispatch({ changes: { from: one, to: one + 1, insert: "9" } });
    await settle();
    await settle();
    const table = t.view.contentDOM.querySelector(".cm-lp-table");
    assert.ok(table, "the table is still rendered");
    assert.ok(table.textContent.includes("9"), "the table shows the edit");
    assert.ok(table.querySelector(".cm-comment-composer textarea") === input, "the same textarea");
    assert.equal(input.value, "half typed");
    assert.ok(t.env.document.activeElement === input, "the textarea keeps focus");
    assert.equal(table.querySelector(".cm-comment-draft")?.textContent, "2");
  } finally { t.done(); }
});

test("comments on table text are tinted in the widget", async () => {
  const t = await setup(COMMENT_TABLE, { comments: true });
  try {
    await t.caret(0);
    const from = t.editor.getText().indexOf("1 |");
    const { setComments } = t.commentsApi;
    t.view.dispatch({ effects: setComments.of([{ id: "c1", from, to: from + 1, author: "agent", state: "open", orphaned: false }]) });
    await settle();
    const table = t.view.contentDOM.querySelector(".cm-lp-table");
    const mark = table.querySelector('.cm-comment-agent[data-comment-id="c1"]');
    assert.equal(mark?.textContent, "1");
    const event = t.mousedown(mark);
    assert.ok(event.defaultPrevented);
    assert.deepEqual(t.selected, ["c1"]);
    assert.equal(t.editor.getSelection().start, 0);
    t.view.dispatch({ effects: setComments.of([]) });
    await settle();
    assert.ok(!table.querySelector(".cm-comment"), "no tint left");
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-table") === table, "the same table element");
  } finally { t.done(); }
});

test("a composer over a table and the line after keeps the table raw", async () => {
  const t = await setup(COMMENT_TABLE, { comments: true });
  try {
    selectText(t, "2 |", "after");
    await settle();
    t.commentsApi.startComment(t.view);
    await settle();
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-table"), "the table is raw");
    assert.ok(t.view.contentDOM.querySelector(".cm-comment-composer"));
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    await settle();
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-table"), "the table stays raw");
  } finally { t.done(); }
});

test("Source mode draws the plain composer for table text", async () => {
  const t = await setup(COMMENT_TABLE, { comments: true });
  try {
    t.editor.setMode("source");
    selectText(t, "2 |", "2");
    await settle();
    t.commentsApi.startComment(t.view);
    await settle();
    const composer = t.view.contentDOM.querySelector(".cm-comment-composer");
    assert.ok(composer);
    assert.ok(!composer.closest(".cm-lp-table"), "the composer is outside any table");
  } finally { t.done(); }
});

test("source mode shows raw Markdown with no live preview decorations", async () => {
  const t = await setup("# T\n**b** [l](https://x.y)\n- [ ] t\n---\n\n| a |\n|---|\n| 1 |\n\nend");
  try {
    await t.caret(t.editor.getText().length);
    assert.ok(t.view.contentDOM.querySelector("[class*='cm-lp-']"));
    t.editor.setMode("source");
    await settle();
    assert.ok(!t.view.contentDOM.querySelector("[class*='cm-lp-']"), "expected no match");
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
    assert.ok(lines[3].classList.contains("cm-lp-codeblock-head"));
    assert.equal(lines[3].textContent, "code");
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

async function mermaidSetup(text, options = {}) {
  const { createMermaidRenderer } = await import("../src/mermaid.js");
  const renders = [];
  let renderer;
  const t = await setup(text, {
    ...options,
    mermaid: document => {
      renderer = createMermaidRenderer({
        document,
        load: async () => ({
          initialize() {},
          async render(id, source) {
            renders.push(source);
            if (source.includes("oops")) throw new Error("Parse error on line 1");
            return { svg: `<svg id="${id}"><text>${source.trim()}</text></svg>` };
          }
        })
      });
      return renderer;
    }
  });
  return Object.assign(t, {
    renders,
    renderer: () => renderer,
    diagrams: () => [...t.view.contentDOM.querySelectorAll(".cm-lp-mermaid")]
  });
}

const flowchart = "```mermaid\ngraph TD\n  A-->B\n```";

test("a mermaid block renders as a diagram widget while the caret is outside it", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}\n\nafter`);
  try {
    await t.caret(0);
    await settle();
    const [diagram] = t.diagrams();
    assert.ok(diagram.classList.contains("cm-lp-mermaid-block"));
    assert.equal(diagram.querySelector("svg text").textContent, "graph TD\n  A-->B");
    assert.ok(t.lineTexts().every(text => !text.includes("```")));
  } finally { t.done(); }
});

test("with the pencil on, the source stays editable and the diagram renders below it", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}\n\nafter`);
  try {
    await t.caret(0);
    await settle();
    t.view.contentDOM.querySelector(".cm-lp-mermaid-block .cm-lp-pencil").click();
    await settle();
    assert.ok(t.lineTexts().includes("  A-->B"));
    const [diagram] = t.diagrams();
    assert.ok(diagram.classList.contains("cm-lp-mermaid-preview"));
    assert.ok(diagram.querySelector("svg"));
    const closing = t.lines().find(line => line.textContent === "```");
    assert.ok(closing.nextElementSibling === diagram, "diagram follows the closing fence");
  } finally { t.done(); }
});

test("typing in the block keeps the last diagram until typing pauses", async () => {
  const t = await mermaidSetup(`${flowchart}\n\nafter`);
  try {
    const at = t.editor.getText().indexOf("B");
    await t.caret(at);
    await settle();
    const [before] = t.diagrams();
    t.view.dispatch({ changes: { from: at + 1, insert: "C" } });
    await settle();
    const [during] = t.diagrams();
    assert.ok(during === before, "the diagram element is reused");
    assert.match(during.querySelector("svg text").textContent, /A-->B$/);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.match(t.diagrams()[0].querySelector("svg text").textContent, /A-->BC$/);
    assert.deepEqual(t.renders, ["graph TD\n  A-->B", "graph TD\n  A-->BC"]);
  } finally { t.done(); }
});

test("a syntax error shows Mermaid's message in place of the diagram", async () => {
  const t = await mermaidSetup("```mermaid\noops\n```\n\nafter");
  try {
    await t.caret(t.editor.getText().length);
    await settle();
    const [diagram] = t.diagrams();
    assert.ok(diagram.classList.contains("mermaid-error"));
    assert.equal(diagram.querySelector("pre").textContent, "Parse error on line 1");
  } finally { t.done(); }
});

test("clicking a diagram leaves the caret where it was", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}`);
  try {
    await t.caret(0);
    await settle();
    t.mousedown(t.diagrams()[0]);
    await settle();
    assert.equal(t.editor.getSelection().start, 0);
    assert.ok(t.diagrams()[0].classList.contains("cm-lp-mermaid-block"));
  } finally { t.done(); }
});

test("the diagram's pencil shows the source with the diagram below", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}\n\nafter`);
  try {
    await t.caret(0);
    await settle();
    t.view.contentDOM.querySelector(".cm-lp-mermaid-block .cm-lp-pencil").click();
    await settle();
    assert.ok(t.lineTexts().includes("  A-->B"));
    assert.ok(t.diagrams()[0].classList.contains("cm-lp-mermaid-preview"));
    assert.equal(t.editor.getSelection().start, t.editor.getText().indexOf("graph TD"));
    const pressed = t.view.contentDOM.querySelector('.cm-lp-pencil[aria-pressed="true"]');
    assert.ok(pressed);
    pressed.click();
    await settle();
    assert.ok(t.diagrams()[0].classList.contains("cm-lp-mermaid-block"));
    assert.ok(t.diagrams()[0].querySelector(".cm-lp-pencil"));
  } finally { t.done(); }
});

test("the diagram keeps its pencil after a re-render", async () => {
  const t = await mermaidSetup(`${flowchart}\n\nafter`);
  try {
    await t.caret(t.editor.getText().length);
    await settle();
    assert.ok(t.diagrams()[0].querySelector(".cm-lp-pencil"));
    t.renderer().setTheme?.({});
    await settle();
    assert.ok(t.diagrams()[0].querySelector(".cm-lp-pencil"));
  } finally { t.done(); }
});

test("arrowing onto a diagram goes past it", async () => {
  const F = "```";
  const t = await mermaidSetup(`a\n${F}mermaid\ngraph TD\n${F}\nb`);
  try {
    await t.caret(1);
    await settle();
    t.view.dispatch({ selection: { anchor: 2 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, t.editor.getText().indexOf("b"));
    t.view.dispatch({ selection: { anchor: t.editor.getText().indexOf("b") - 1 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, 1);
  } finally { t.done(); }
});

test("a programmatic selection inside the block still shows the source", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}\n\nafter`);
  try {
    await t.caret(0);
    t.view.dispatch({ selection: { anchor: t.editor.getText().indexOf("A-->B") } });
    await settle();
    assert.ok(t.lineTexts().includes("  A-->B"));
    assert.ok(t.diagrams()[0].classList.contains("cm-lp-mermaid-preview"));
  } finally { t.done(); }
});


test("a known diagram renders without a placeholder and without re-rendering", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}`);
  try {
    await t.caret(0);
    await settle();
    await t.caret(t.editor.getText().indexOf("A-->"));
    assert.ok(!t.view.contentDOM.querySelector(".cm-lp-mermaid-pending"), "expected no match");
    assert.equal(t.renders.length, 1);
  } finally { t.done(); }
});

test("a theme change re-renders the diagrams", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}`);
  try {
    await t.caret(0);
    await settle();
    t.renderer().setTheme({ darkMode: true });
    await settle();
    await settle();
    assert.equal(t.renders.length, 2);
    assert.ok(t.diagrams()[0].querySelector("svg"));
  } finally { t.done(); }
});

test("mermaid blocks stay code in source mode and without a renderer", async () => {
  const t = await mermaidSetup(`intro\n\n${flowchart}`);
  try {
    t.editor.setMode("source");
    await t.caret(0);
    assert.deepEqual(t.diagrams(), []);
    assert.ok(t.lineTexts().includes("```mermaid"));
  } finally { t.done(); }
  const plain = await setup(`intro\n\n${flowchart}`);
  try {
    await plain.caret(0);
    assert.ok(!plain.view.contentDOM.querySelector(".cm-lp-mermaid"), "expected no match");
    assert.ok(plain.lineTexts().includes("mermaid"), "a plain code block, labelled with its language");
  } finally { plain.done(); }
});

test("a fence label names the file, else the language, else says code", async () => {
  const { codeFenceMeta } = await import("../src/editor-live-preview.js");
  const hljs = loadHighlighter();
  assert.deepEqual(codeFenceMeta("js", hljs), { label: "js", language: "js" });
  assert.deepEqual(codeFenceMeta("python path=scripts/tool.py", hljs), { label: "scripts/tool.py", language: "python" });
  assert.deepEqual(codeFenceMeta('title="src/app.rs"', hljs), { label: "src/app.rs", language: "rust" });
  assert.deepEqual(codeFenceMeta("file=notes.txt", hljs), { label: "notes.txt", language: "" });
  assert.deepEqual(codeFenceMeta("madeup", hljs), { label: "madeup", language: "" });
  assert.deepEqual(codeFenceMeta("", hljs), { label: "code", language: "" });
  assert.deepEqual(codeFenceMeta("js", null), { label: "js", language: "" });
});

test("a fenced block keeps its header and hides its closing fence with the caret inside", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    await t.caret(text.indexOf("let a;") + 2);
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-fence-label")?.textContent, "js");
    assert.ok(t.lineTexts().every(line => !line.includes(F)));
    const lines = t.lines();
    assert.ok(lines[1].classList.contains("cm-lp-codeblock-head"));
    assert.ok(lines[4].classList.contains("cm-lp-codeblock-foot"));
  } finally { t.done(); }
});

test("a cursor moved onto the header goes past it in the direction of travel", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    const open = t.view.state.doc.line(2);
    const first = t.view.state.doc.line(3);
    await t.caret(first.from);
    t.view.dispatch({ selection: { anchor: open.from + 2 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, 5);
    t.view.dispatch({ selection: { anchor: open.from + 2 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, first.from);
  } finally { t.done(); }
});

test("a cursor moved onto the closing fence goes past it", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    const last = doc.line(4);
    const close = doc.line(5);
    await t.caret(last.to);
    t.view.dispatch({ selection: { anchor: close.from + 1 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, doc.line(6).from);
    t.view.dispatch({ selection: { anchor: close.from + 1 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, last.to);
  } finally { t.done(); }
});

test("a fence at the start of the document keeps an upward cursor on its first code line", async () => {
  const text = "```js\nx\n```";
  const t = await setup(text);
  try {
    await t.caret(6);
    t.view.dispatch({ selection: { anchor: 1 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, 6);
  } finally { t.done(); }
});

test("a click on the label puts the caret on the first code line", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    await t.caret(text.length);
    t.mousedown(t.view.contentDOM.querySelector(".cm-lp-fence-label"));
    assert.equal(t.view.state.selection.main.head, t.view.state.doc.line(3).from);
  } finally { t.done(); }
});

test("Backspace at the first code line and Delete at the last leave the fences intact", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    const first = doc.line(3);
    const last = doc.line(4);
    await t.caret(first.from);
    t.view.dispatch({ changes: { from: first.from - 1, to: first.from }, userEvent: "delete.backward" });
    assert.equal(t.view.state.doc.toString(), text);
    await t.caret(last.to);
    t.view.dispatch({ changes: { from: last.to, to: last.to + 1 }, userEvent: "delete.forward" });
    assert.equal(t.view.state.doc.toString(), text);

    t.view.dispatch({ selection: { anchor: 0, head: first.from + 4 } });
    t.view.dispatch({ changes: { from: 0, to: first.from + 4 }, userEvent: "delete" });
    assert.equal(t.view.state.doc.toString(), text.slice(first.from + 4));
  } finally { t.done(); }
});

test("Backspace after the closing fence and Delete before the header move the caret instead of joining", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    await t.caret(doc.line(6).from);
    t.view.dispatch({ changes: { from: doc.line(6).from - 1, to: doc.line(6).from }, userEvent: "delete.backward" });
    assert.equal(t.view.state.doc.toString(), text);
    assert.equal(t.view.state.selection.main.head, doc.line(4).to);
    await t.caret(doc.line(1).to);
    t.view.dispatch({ changes: { from: doc.line(1).to, to: doc.line(2).from }, userEvent: "delete.forward" });
    assert.equal(t.view.state.doc.toString(), text);
    assert.equal(t.view.state.selection.main.head, doc.line(3).from);
  } finally { t.done(); }
});

test("the cursor skips chains of back-to-back fences in both directions", async () => {
  const F = "```";
  const text = `${F}a\nx\n${F}\n${F}b\ny\n${F}\n${F}c\nz\n${F}`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    const go = pos => t.view.dispatch({ selection: { anchor: pos }, userEvent: "select" });
    await t.caret(doc.line(2).to);
    go(doc.line(3).from + 1);
    assert.equal(t.view.state.selection.main.head, doc.line(5).from);
    await t.caret(doc.line(5).from);
    go(doc.line(4).from + 1);
    assert.equal(t.view.state.selection.main.head, doc.line(2).to);
    await t.caret(doc.line(5).to);
    go(doc.line(6).from + 1);
    assert.equal(t.view.state.selection.main.head, doc.line(8).from);
    await t.caret(doc.line(8).from);
    go(doc.line(7).from + 1);
    assert.equal(t.view.state.selection.main.head, doc.line(5).to);
    await t.caret(doc.line(2).to);
    go(doc.line(3).from + 1);
    go(doc.line(6).from + 1);
    assert.ok(![3, 4, 6, 7].includes(doc.lineAt(t.view.state.selection.main.head).number));
  } finally { t.done(); }
});

test("deleting the last code line whole leaves the fences intact and applies", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    const last = doc.line(4);
    await t.caret(last.from + 1);
    t.view.dispatch({ changes: { from: last.from, to: last.to + 1 }, userEvent: "delete.line" });
    assert.equal(t.view.state.doc.toString(), `intro\n${F}js\nlet a;\n${F}\nafter`);
    const first = t.view.state.doc.line(3);
    await t.caret(first.from);
    t.view.dispatch({ changes: { from: first.from, to: first.to + 1 }, userEvent: "delete.line" });
    assert.equal(t.view.state.doc.toString(), `intro\n${F}js\n${F}\nafter`);
  } finally { t.done(); }
});

test("a multi-cursor delete is blocked when any empty cursor would break a fence", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;\n${F}\nafter`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    const first = doc.line(3);
    const { EditorSelection, EditorState, StateEffect } = await import("../src/vendor/codemirror.js");
    t.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
    t.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(first.from)], 0) });
    t.view.dispatch({
      changes: [{ from: 1, to: 2 }, { from: first.from - 1, to: first.from }],
      userEvent: "delete.backward"
    });
    assert.equal(t.view.state.doc.toString(), text);
  } finally { t.done(); }
});

test("an unterminated fence keeps its header and the cursor skips it", async () => {
  const F = "```";
  const text = `intro\n${F}js\nlet a;\nlet b;`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    await t.caret(doc.line(3).from);
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-fence-label")?.textContent, "js");
    t.view.dispatch({ selection: { anchor: doc.line(2).from + 1 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, doc.line(1).to);
  } finally { t.done(); }
});

test("a fence in a list item skips its hidden lines", async () => {
  const F = "```";
  const text = `- item\n  ${F}js\n  let a;\n  ${F}\n- next`;
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    await t.caret(doc.line(3).to);
    t.view.dispatch({ selection: { anchor: doc.line(4).from + 3 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, doc.line(5).from);
    await t.caret(doc.line(3).from);
    t.view.dispatch({ selection: { anchor: doc.line(2).from + 3 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, doc.line(1).to);
  } finally { t.done(); }
});

test("a fence ending the document keeps a downward cursor on its last code line", async () => {
  const text = "intro\n```js\nlet a;\n```";
  const t = await setup(text);
  try {
    const { doc } = t.view.state;
    await t.caret(doc.line(3).from);
    t.view.dispatch({ selection: { anchor: doc.line(4).from + 1 }, userEvent: "select" });
    assert.equal(t.view.state.selection.main.head, doc.line(3).to);
  } finally { t.done(); }
});

test("an empty fenced block shows its fences when the caret is on them", async () => {
  const F = "```";
  const text = `a\n${F}\n${F}\nb`;
  const t = await setup(text);
  try {
    await t.caret(text.indexOf(F) + 1);
    assert.equal(t.lineTexts()[1], F);
  } finally { t.done(); }
});

test("code in a fence with a known language is highlighted while syntax highlighting is on", async () => {
  const text = "```python\ndef main():\n    return 42\n```\n\n```madeup\ndef x\n```\nend";
  const t = await setup(text, { hljs: loadHighlighter() });
  try {
    await t.caret(text.length);
    const tokens = () => [...t.view.contentDOM.querySelectorAll(".cm-lp-codeblock [class*='hljs-']")].map(element => element.textContent);
    assert.deepEqual(tokens(), ["def", "main", "return", "42"]);
    assert.ok(t.lines()[1].classList.contains("cm-lp-codeblock-highlighted"));
    assert.equal(t.lines()[6].classList.contains("cm-lp-codeblock-highlighted"), false);

    t.editor.setSyntaxHighlighting(false);
    await settle();
    assert.deepEqual(tokens(), []);
    t.editor.setSyntaxHighlighting(true);
    await settle();
    assert.equal(tokens().length, 4);
  } finally { t.done(); }
});

test("code blocks draw their background under the selection, not on their lines", async () => {
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = /\.cm-mode-live \.cm-lp-codeblock \{([^}]*)\}/.exec(styles);
  assert.ok(rule, "the live code block rule exists");
  assert.doesNotMatch(rule[1], /background/, "a line background would paint over the selection layer");
  assert.match(/\.cm-lp-codeblock-bg \{([^}]*)\}/.exec(styles)?.[1] ?? "", /background-color/);

  const text = "```js\na\n```\n\n```diff path=a.js hunk=h1 lines=1-1\n@@ -1 +1 @@\n-a\n+b\n```\n\n```\nb\n```\nend";
  const t = await setup(text);
  try {
    await t.caret(text.length);
    await new Promise(resolve => setTimeout(resolve, 50));
    const layer = t.view.dom.querySelector(".cm-lp-codeblock-layer");
    assert.ok(layer, "the background layer is mounted");
    assert.equal(layer.querySelectorAll(".cm-lp-codeblock-bg").length, 2, "one per code block; the review hunk draws its own");
    const selection = t.view.dom.querySelector(".cm-selectionLayer");
    assert.ok(Number(layer.style.zIndex) < Number(selection.style.zIndex), "the backgrounds sit under the selection");
  } finally { t.done(); }
});

test("H1 and H2 carry a rule on their last text line, H3 does not", async () => {
  const t = await setup("# One\n\n## Two\n\n### Three\n\nSetext\nheading\n===\n\nbody", { focused: false });
  const ruled = t.lines().filter(l => l.classList.contains("cm-lp-heading-rule")).map(l => l.textContent);
  assert.deepEqual(ruled, ["One", "Two", "heading"]);
});

test("a heading inside a quote keeps the quote line class", async () => {
  const t = await setup("> # Title\n\nbody", { focused: false });
  const line = t.lines().find(l => l.textContent === "Title");
  for (const name of ["cm-lp-quote", "cm-lp-h1", "cm-lp-heading-rule"]) assert.ok(line.classList.contains(name), name);
});

test("only setext continuation lines are marked as continuations", async () => {
  const t = await setup("# A\n# B\n\nSetext\nheading\n===\n\nbody", { focused: false });
  const by = text => t.lines().find(l => l.textContent === text).classList;
  assert.ok(!by("A").contains("cm-lp-heading-cont") && !by("B").contains("cm-lp-heading-cont"));
  assert.ok(!by("A").contains("cm-lp-heading-more"));
  assert.ok(by("Setext").contains("cm-lp-heading-more") && !by("Setext").contains("cm-lp-heading-cont"));
  assert.ok(by("heading").contains("cm-lp-heading-cont") && by("heading").contains("cm-lp-heading-rule"));
});

test("a setext heading inside a quote keeps quote and heading classes", async () => {
  const t = await setup("> Setext\n> heading\n> ===\n\nbody", { focused: false });
  const line = t.lines().find(l => l.textContent.includes("heading") && !l.textContent.includes("==="));
  for (const name of ["cm-lp-quote", "cm-lp-h1", "cm-lp-heading-rule", "cm-lp-heading-cont"]) assert.ok(line.classList.contains(name), name);
});

test("blank lines between blocks are gaps, blank lines in code are not", async () => {
  const t = await setup("para\n\npara\n\n```\na\n\nb\n```", { focused: false });
  try {
    const gaps = t.lines().map(line => line.classList.contains("cm-lp-gap"));
    assert.deepEqual(gaps, [false, true, false, true, false, false, false, false, false]);
  } finally {
    t.done();
  }
}
);
