// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installEditorDom } from "./helpers/cm-dom.js";

test("the vendored bundle exposes the pinned API and no dynamic code", async () => {
  const source = await readFile(new URL("../src/vendor/codemirror.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bnew Function\s*\(|\beval\s*\(/);
  const cm = await import("../src/vendor/codemirror.js");
  for (const name of ["EditorState", "EditorView", "Decoration", "WidgetType", "StateField", "StateEffect", "Compartment", "Language", "markdownParser", "GFM", "history", "lineNumbers", "HighlightStyle", "tags"]) {
    assert.ok(cm[name], `missing export ${name}`);
  }
});

test("a markdown editor mounts in jsdom and parses GFM tables and tasks", async () => {
  const env = installEditorDom();
  try {
    const cm = await import("../src/vendor/codemirror.js");
    const language = new cm.Language(cm.defineLanguageFacet(), cm.markdownParser.configure([cm.GFM]), [], "markdown");
    const view = new cm.EditorView({
      state: cm.EditorState.create({ doc: "| a |\n|---|\n| 1 |\n\n- [ ] t", extensions: [language] }),
      parent: env.document.getElementById("host")
    });
    const names = new Set();
    cm.syntaxTree(view.state).iterate({ enter: node => { names.add(node.name); } });
    assert.ok(names.has("Table") && names.has("TaskMarker"));
    view.destroy();
  } finally { env.cleanup(); }
});
