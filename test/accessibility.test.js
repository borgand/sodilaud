// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bootApp } from "./helpers/app-harness.js";

const parse = async (page) => new JSDOM(await readFile(new URL(`../src/${page}`, import.meta.url), "utf8")).window.document;
const notesDocument = await parse("notes.html");
const document = await parse("index.html");

test("interactive controls have an accessible name", () => {
  const unnamed = [notesDocument, document].flatMap(page => [...page.querySelectorAll("button, input, select, textarea")])
    .filter((element) => {
      const visibleText = element.textContent.trim();
      const hasLabel = [...(element.labels || [])].some(label => label.textContent.trim());
      return !visibleText && !hasLabel &&
        !element.getAttribute("aria-label")?.trim() &&
        !element.getAttribute("title")?.trim();
    })
    .map((element) => element.id || element.outerHTML);

  assert.deepEqual(unnamed, []);
});

test("both editors expose their content element with an accessible name", async () => {
  const app = await bootApp();
  assert.equal(app.editor().contentDOM.getAttribute("aria-label"), "Sodilaud content");
  assert.equal(app.editor("secondary").contentDOM.getAttribute("aria-label"), "Secondary scratchpad content");
  assert.ok(app.editor().contentDOM.matches(".cm-content"));
});

test("help, theme, about, MCP, clipboard, and trash overlays expose modal dialog semantics", () => {
  const ids = (page) => [...page.querySelectorAll("[role='dialog']")].map(dialog => dialog.id).sort();
  assert.deepEqual(ids(document), ["about-modal", "clipboard-settings-modal", "help-modal", "theme-modal"]);
  assert.deepEqual(ids(notesDocument), ["mcp-config-modal", "trash-modal"]);
  const dialogs = [document, notesDocument].flatMap(page => [...page.querySelectorAll("[role='dialog']")]);

  dialogs.forEach((dialog) => {
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.getAttribute("aria-label") || dialog.getAttribute("aria-labelledby"));
  });
});

test("help and reference documents current Markdown editing behavior", () => {
  const shortcuts = document.getElementById("pane-shortcuts").textContent;
  const markdown = document.getElementById("pane-markdown").textContent;
  const mcp = document.getElementById("pane-mcp").textContent;

  assert.match(shortcuts, /F1/);
  assert.match(shortcuts, /Deleting a folder from the sidebar returns its notes to the top level/);
  assert.match(shortcuts, /Compare.*removed source text on the left and added source text on the right/);
  assert.match(shortcuts, /Jump to List Content \/ Line Start/);
  assert.match(shortcuts, /Continue List, Quote, Fence, or Table/);
  assert.match(shortcuts, /Pasting a URL over selected text makes a link/);
  assert.match(shortcuts, /Live.*Source.*Reading/);
  assert.match(shortcuts, /In Live mode, Cmd-click a link to open it/);
  assert.match(markdown, /A language label enables syntax highlighting in Reading mode/);
  assert.match(markdown, /Sodilaud menu → Appearance/);
  assert.match(markdown, /Right-click in the editor/);
  assert.match(markdown, /empty generated row to exit the table/);
  assert.match(markdown, /Blockquotes/);
  assert.doesNotMatch(markdown, /Callouts|\[!NOTE\]/);
  assert.match(mcp, /list_folders/);
  assert.match(mcp, /list_notes/);
  assert.match(mcp, /search_notes/);
  assert.match(mcp, /get_note/);
  assert.match(mcp, /create_note/);
  assert.match(mcp, /create_folder/);
  assert.match(mcp, /append_to_note/);
  assert.match(mcp, /rename_note/);
  assert.match(mcp, /move_note/);
  assert.match(mcp, /rename_folder/);
  assert.match(mcp, /Only you can restore notes or empty trash/);
  assert.match(mcp, /Unicode characters, not bytes/);
});
