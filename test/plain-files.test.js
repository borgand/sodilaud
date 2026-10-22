// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const A_TXT = "# Title\n- a\n\nsee [x](y)\n";
const N_MD = "# Title\n\nsee [x](y)\n";

function lists(open) {
  return {
    qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open, recent: [] }),
    file_set_open: () => null,
    file_take_pending: () => []
  };
}

const bootPlain = (instance, extra = {}) => bootMainWindow({
  instance,
  platform: "MacIntel",
  disk: { "/d/a.txt": A_TXT, "/d/t.tsv": "a\tb\n", "/d/m.tsv": "a\tb\n", "/d/n.md": N_MD },
  beforeBoot: (dom) => { dom.window.marked = marked; },
  handlers: { ...lists(["/d/a.txt", "/d/t.tsv", "/d/m.tsv", "/d/n.md"]), ...extra }
});

const doc = (app) => app.dom.window.document;
const keydown = (app, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  app.editor().contentDOM.dispatchEvent(event);
  return event;
};
const show = async (app, name) => {
  const item = [...doc(app).querySelectorAll(".open-file-name")].find((node) => node.textContent === name);
  item.click();
  await app.settle();
};
const moveTo = (app, anchor) => app.editor().dispatch({ selection: { anchor } });

test("a .txt file shows its Markdown source without live decorations", async () => {
  const app = await bootPlain(1);
  await show(app, "a.txt");
  moveTo(app, 0);
  assert.equal(app.editorText(), A_TXT);
  assert.ok(doc(app).querySelector("#editor-host .cm-lp-link") === null);
  await show(app, "n.md");
  moveTo(app, 0);
  assert.ok(doc(app).querySelector("#editor-host .cm-lp-link") !== null);
});

test("Enter after a list line in a .txt inserts only a newline", async () => {
  const app = await bootPlain(2);
  await show(app, "a.txt");
  moveTo(app, "# Title\n- a".length);
  keydown(app, { key: "Enter" });
  assert.equal(app.editorText(), "# Title\n- a\n\n\nsee [x](y)\n");
});

test("Tab in a .tsv inserts a tab character", async () => {
  const app = await bootPlain(3);
  await show(app, "t.tsv");
  moveTo(app, 4);
  const event = keydown(app, { key: "Tab" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.editorText(), "a\tb\n\t");
  assert.equal(app.editor().state.selection.main.head, 5);
});

test("Tab in a .tsv replaces a mid-line selection with a tab", async () => {
  const app = await bootPlain(8);
  await show(app, "m.tsv");
  app.editor().dispatch({ selection: { anchor: 0, head: 3 } });
  const event = keydown(app, { key: "Tab" });
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.editorText(), "\t\n");
  assert.equal(app.editor().state.selection.main.head, 1);
});

test("fold chevrons follow the switch between Markdown and plain text", async () => {
  const app = await bootPlain(9);
  const chevrons = () => doc(app).querySelectorAll("#editor-host .cm-heading-fold").length;
  await show(app, "n.md");
  const markdown = chevrons();
  assert.ok(markdown > 0, "a Markdown file shows fold chevrons");
  await show(app, "a.txt");
  assert.equal(chevrons(), 0);
  await show(app, "n.md");
  assert.equal(chevrons(), markdown);
});

test("a comment on a .txt file anchors to the selected text", async () => {
  const app = await bootPlain(10);
  await show(app, "a.txt");
  const from = A_TXT.indexOf("Title");
  app.editor().dispatch({ selection: { anchor: from, head: from + 5 } });
  doc(app).getElementById("comment-btn").click();
  await app.settle();
  const composer = doc(app).querySelector(".cm-comment-composer textarea");
  assert.ok(composer !== null);
  composer.value = "Rename this";
  doc(app).querySelector(".cm-comment-add").click();
  await app.settle(300);
  const [comment] = app.fileDocs.comments("/d/a.txt");
  assert.equal(comment.anchoredText, "Title");
  assert.equal(comment.body, "Rename this");
});

test("Reading mode shows plain text as preformatted text", async () => {
  const app = await bootPlain(4);
  await show(app, "a.txt");
  app.click("mode-reading");
  const pre = doc(app).querySelector("#markdown-preview .plain-text-preview");
  assert.ok(pre !== null);
  assert.equal(pre.textContent, A_TXT);
  assert.ok(doc(app).querySelector("#markdown-preview h1") === null);
});

test("the formatting toolbar is disabled and the outline empty for plain files", async () => {
  const app = await bootPlain(5);
  await show(app, "a.txt");
  assert.equal(doc(app).getElementById("format-bold").disabled, true);
  assert.equal(doc(app).getElementById("outline-section")?.hidden ?? true, true);
});

test("switching back to a .md file restores live preview and the toolbar", async () => {
  const app = await bootPlain(6);
  await show(app, "a.txt");
  await show(app, "n.md");
  assert.equal(doc(app).getElementById("format-bold").disabled, false);
  assert.equal(app.editor().dom.classList.contains("cm-plain"), false);
  moveTo(app, 0);
  assert.ok(doc(app).querySelector("#editor-host .cm-lp-link") !== null);
  await show(app, "a.txt");
  assert.equal(app.editor().dom.classList.contains("cm-plain"), true);
  assert.ok(doc(app).querySelector("#editor-host .cm-lp-link") === null);
});

test("Save As to .md turns a plain buffer into Markdown", async () => {
  let disk;
  const app = await bootPlain(7, {
    file_save_as_dialog: ({ text }) => {
      disk.set("/d/b.md", text);
      return { path: "/d/b.md", name: "b.md", hash: "h" };
    }
  });
  disk = app.fileDocs.files;
  await show(app, "a.txt");
  assert.equal(app.editor().dom.classList.contains("cm-plain"), true);
  doc(app).getElementById("menu-save-as-btn").click();
  await app.settle();
  assert.equal(doc(app).getElementById("main-title").textContent, "b.md");
  assert.equal(app.editor().dom.classList.contains("cm-plain"), false);
  assert.equal(doc(app).getElementById("format-bold").disabled, false);
});
