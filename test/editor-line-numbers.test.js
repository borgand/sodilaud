// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";

function lineNumbers(document, hostId) {
  return [...document.querySelectorAll(`#${hostId} .cm-lineNumbers .cm-gutterElement`)]
    .filter((element) => element.style.visibility !== "hidden")
    .map((element) => element.textContent);
}

test("primary and secondary line-number gutters follow the note text", async () => {
  const app = await bootApp({
    storage: {
      sodilaud_editor_line_numbers: "true",
      sodilaud_notes: [
        {
          id: "primary-note",
          title: "Primary",
          content: "one\ntwo",
          updatedAt: 2,
          isTitleLocked: true
        },
        {
          id: "secondary-note",
          title: "Secondary",
          content: "alpha\nbeta\ngamma",
          updatedAt: 1,
          isTitleLocked: true
        }
      ]
    }
  });
  const { document } = app.dom.window;

  assert.equal(document.documentElement.classList.contains("editor-line-numbers-enabled"), true);
  assert.deepEqual(lineNumbers(document, "editor-host"), ["1", "2"]);

  await app.type("one\ntwo\nthree");
  assert.deepEqual(lineNumbers(document, "editor-host"), ["1", "2", "3"]);

  await app.type(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
  assert.deepEqual(
    lineNumbers(document, "editor-host"),
    Array.from({ length: 10 }, (_, index) => String(index + 1))
  );

  document.getElementById("split-note-btn").click();
  assert.deepEqual(lineNumbers(document, "secondary-editor-host"), ["1", "2", "3"]);
});

test("line numbers are off by default and follow the main window's toggle", async () => {
  const app = await bootApp({
    instance: 2,
    storage: {
      sodilaud_notes: [{
        id: "default-note",
        title: "Default",
        content: "one\ntwo",
        updatedAt: 1,
        isTitleLocked: true
      }]
    }
  });
  const { document } = app.dom.window;
  const toggle = async (enabled) => {
    app.storage.setItem("sodilaud_editor_line_numbers", String(enabled));
    await app.emit("prefs-changed", { key: "sodilaud_editor_line_numbers", source: "main" });
  };

  assert.equal(document.documentElement.classList.contains("editor-line-numbers-enabled"), false);
  assert.equal(document.getElementById("line-numbers-toggle"), null, "the toggle lives in the main window");
  assert.equal(document.querySelectorAll(".cm-lineNumbers").length, 0);

  await app.type("one\ntwo\nthree");
  assert.equal(document.querySelectorAll(".cm-lineNumbers").length, 0);

  await toggle(true);
  assert.deepEqual(lineNumbers(document, "editor-host"), ["1", "2", "3"]);
  assert.equal(document.querySelectorAll("#secondary-editor-host .cm-lineNumbers").length, 1);

  await toggle(false);
  assert.equal(document.querySelectorAll(".cm-lineNumbers").length, 0);
});

const BLOCKS_DOC = [
  "# Title",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```js",
  "let x = 1;",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "A-->B",
  "```",
  "",
  "end"
].join("\n");

async function blocksEditor() {
  const { setupLive, settle } = await import("./helpers/live-editor.js");
  const { createMermaidRenderer } = await import("../src/mermaid.js");
  const mermaid = document => createMermaidRenderer({
    document,
    load: async () => ({ initialize() {}, async render(id) { return { svg: `<svg id="${id}"></svg>` }; } })
  });
  const t = await setupLive(BLOCKS_DOC, { focused: false, mermaid });
  t.editor.setLineNumbers(true);
  t.editor.setSelection(BLOCKS_DOC.length, BLOCKS_DOC.length);
  await settle();
  await settle();
  const markers = () => [...t.view.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
    .filter(element => element.style.visibility !== "hidden")
    .map(element => element.textContent);
  return { t, settle, markers };
}

test("Live mode numbers each rendered block once, by its first source line", async () => {
  const { t, markers } = await blocksEditor();
  try {
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-table"), "the table renders as a widget");
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-codeblock-head"), "the code block renders in Live");
    assert.ok(t.view.contentDOM.querySelector(".cm-lp-mermaid-block"), "the diagram renders as a widget");
    assert.deepEqual(markers(), ["1", "2", "3", "6", "7", "8", "9", "10", "11", "15", "16"]);
  } finally { t.done(); }
});

test("Source mode keeps a number for every line", async () => {
  const { t, settle, markers } = await blocksEditor();
  try {
    t.editor.setMode("source");
    await settle();
    assert.equal(t.view.contentDOM.querySelector(".cm-lp-table"), null);
    assert.deepEqual(markers(), Array.from({ length: 16 }, (_, index) => String(index + 1)));
  } finally { t.done(); }
});

test("Live mode dims the line numbers; Source mode keeps their colour", async () => {
  const { readFile } = await import("node:fs/promises");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = styles.match(/\.cm-mode-live:not\(\.cm-plain\) \.cm-lineNumbers \.cm-gutterElement\s*\{([^}]*)\}/);
  assert.ok(rule, "styles.css has a Live-mode line-number rule");
  assert.match(rule[1], /color:/);
  assert.doesNotMatch(styles, /\.cm-mode-source \.cm-lineNumbers/);
});
