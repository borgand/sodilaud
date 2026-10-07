// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const long = (title) => [`# ${title}`, "", ...Array.from({ length: 300 }, (_, i) => `Line ${i} of ${title}.`), ""].join("\n");

let instance = 0;
async function boot(disk, scrolled = []) {
  instance += 1;
  let open = Object.keys(disk);
  const app = await bootMainWindow({
    platform: "MacIntel",
    instance,
    disk,
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open, recent: [] }),
      file_set_open: ({ paths }) => { open = paths; },
      file_take_pending: () => []
    },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.Element.prototype.scrollIntoView = function () { scrolled.push(this); };
    }
  });
  const document = app.dom.window.document;
  const show = async (name) => {
    [...document.querySelectorAll(".open-file-name")].find((item) => item.textContent === name).click();
    await app.settle();
  };
  return { app, document, show, scroller: () => app.editor().scrollDOM };
}

test("a file shown for the first time starts at the top, not where the last file was scrolled", async () => {
  const { show, scroller } = await boot({ "/docs/a.md": long("A"), "/docs/b.md": long("B") });
  await show("a.md");
  scroller().scrollTop = 900;
  await show("b.md");
  assert.equal(scroller().scrollTop, 0);
});

test("going back to a file restores where it was left, and other files keep their own place", async () => {
  const { show, scroller } = await boot({ "/docs/a.md": long("A"), "/docs/b.md": long("B") });
  await show("b.md");
  await show("a.md");
  scroller().scrollTop = 900;
  await show("b.md");
  assert.equal(scroller().scrollTop, 0, "b was left at its top");
  scroller().scrollTop = 300;
  await show("a.md");
  assert.equal(scroller().scrollTop, 900);
  await show("b.md");
  assert.equal(scroller().scrollTop, 300);
});

test("Reading mode keeps a scroll position per file too", async () => {
  const { app, document, show } = await boot({ "/docs/a.md": long("A"), "/docs/b.md": long("B") });
  app.click("mode-reading");
  const preview = document.getElementById("markdown-preview");
  await show("a.md");
  preview.scrollTop = 700;
  await show("b.md");
  assert.equal(preview.scrollTop, 0);
  await show("a.md");
  assert.equal(preview.scrollTop, 700);
});

const fence = (id, reviewed = "") => `\`\`\`diff path=src/a.rs hunk=${id} lines=1-1${reviewed}\n@@ -1 +1 @@\n-a\n+b\n\`\`\``;
const BOOK = `# Book\n\n## Engine\n\n${fence("h00001", " reviewed")}\n\n${fence("h00002")}\n\n## Notes\n\n${fence("h00003")}\n`;

test("Next unreviewed jumps to a hunk not yet reviewed, unfolding its section, as a step Back can undo", async () => {
  const scrolled = [];
  const { app, document } = await boot({ "/docs/book.md": BOOK }, scrolled);
  const next = document.getElementById("review-next-btn");
  assert.equal(next.hidden, false);

  app.click("mode-reading");
  const preview = document.getElementById("markdown-preview");
  preview.querySelector("[data-anchor=engine] .heading-fold").click();
  next.click();
  await app.settle();
  const target = scrolled.at(-1);
  assert.equal(target.closest(".diff-hunk")?.dataset.hunk ?? target.dataset.hunk, "h00002", "the reviewed hunk is skipped");
  assert.equal(target.classList.contains("section-fold-hidden"), false, "its folded section opened");
  assert.equal(document.getElementById("nav-back-btn").disabled, false, "the jump is in the history");

  for (const button of preview.querySelectorAll(".diff-hunk-reviewed")) {
    if (!button.closest(".diff-hunk").classList.contains("diff-hunk-is-reviewed")) button.click();
  }
  await app.settle(200);
  assert.equal(next.hidden, true, "nothing left to review");
});

test("a file without review hunks shows no Next unreviewed button", async () => {
  const { document } = await boot({ "/docs/a.md": long("A") });
  assert.equal(document.getElementById("review-next-btn").hidden, true);
});
