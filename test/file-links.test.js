// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const OVERVIEW = [
  "# Overview",
  "",
  "[tools](01-tools.md#register-tools) [down](#approach) [escape](../secret.md) [gone](missing.md)",
  "",
  "## Approach",
  "",
  "| Chapter |",
  "|---|",
  "| [the tools chapter](01-tools.md) |",
  ""
].join("\n");
const TOOLS = "# Tools\n\n## Register tools\n";

let instance = 0;
async function boot(platform = "MacIntel") {
  instance += 1;
  let open = ["/book/00-overview.md"];
  const scrolled = [];
  const app = await bootMainWindow({
    platform,
    instance,
    disk: { "/book/00-overview.md": OVERVIEW, "/book/01-tools.md": TOOLS },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open, recent: [] }),
      file_set_open: ({ paths }) => { open = paths; },
      file_take_pending: () => [],
      file_doc_open_sibling: ({ fromPath, relative }) => {
        if (fromPath === "/book/00-overview.md" && relative === "01-tools.md") {
          return { path: "/book/01-tools.md", name: "01-tools.md", bytes: TOOLS.length };
        }
        throw { code: "Unsupported", message: "refused" };
      }
    },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.Element.prototype.scrollIntoView = function () { scrolled.push(this); };
    }
  });
  return { app, scrolled, document: app.dom.window.document };
}

const linkTo = (root, href) => [...root.querySelectorAll("a")].find((link) => link.getAttribute("href") === href);
const siblingCalls = (app) => app.invocations.filter(({ command }) => command === "file_doc_open_sibling").map(({ args }) => args);

test("Reading mode scrolls to headings and opens sibling chapters at their anchor", async () => {
  const { app, scrolled, document } = await boot();
  app.click("mode-reading");
  const preview = document.getElementById("markdown-preview");

  linkTo(preview, "#approach").click();
  assert.equal(scrolled.at(-1).textContent, "Approach");

  linkTo(preview, "01-tools.md#register-tools").click();
  await app.settle();
  assert.deepEqual(siblingCalls(app), [{ fromPath: "/book/00-overview.md", relative: "01-tools.md" }]);
  assert.equal(document.getElementById("main-title").textContent, "01-tools.md");
  assert.equal(scrolled.at(-1).textContent, "Register tools");
  assert.equal(scrolled.at(-1).getAttribute("data-anchor"), "register-tools");
});

test("links Rust refuses or the sanitizer drops leave the shown file alone", async () => {
  const { app, document } = await boot();
  app.click("mode-reading");
  const preview = document.getElementById("markdown-preview");

  assert.equal(linkTo(preview, "../secret.md"), undefined, "the sanitizer drops a link out of the folder");
  linkTo(preview, "missing.md").click();
  await app.settle();
  assert.deepEqual(siblingCalls(app), [{ fromPath: "/book/00-overview.md", relative: "missing.md" }]);
  assert.equal(document.getElementById("main-title").textContent, "00-overview.md");
  assert.equal(app.invocations.some(({ command }) => command === "confirm_and_open_url"), false);
});

for (const [platform, modifier] of [["MacIntel", { metaKey: true }], ["Linux x86_64", { ctrlKey: true }]]) {
  test(`Live mode opens a sibling chapter on ${platform} with the link modifier`, async () => {
    const { app, document } = await boot(platform);
    const link = [...document.querySelectorAll("#editor-host .cm-lp-link")]
      .find((element) => element.getAttribute("data-href") === "01-tools.md#register-tools");
    link.dispatchEvent(new app.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...modifier }));
    await app.settle();
    assert.equal(document.getElementById("main-title").textContent, "01-tools.md");
  });
}

for (const [platform, modifier] of [["MacIntel", { metaKey: true }], ["Linux x86_64", { ctrlKey: true }]]) {
  test(`Live mode follows a link inside a table on ${platform} with the link modifier`, async () => {
    const { app, document } = await boot(platform);
    const link = document.querySelector('#editor-host .cm-lp-table a[href="01-tools.md"]');
    assert.ok(link, "the table renders its link");
    link.dispatchEvent(new app.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...modifier }));
    await app.settle();
    assert.equal(document.getElementById("main-title").textContent, "01-tools.md");
  });
}

test("a plain click on a table link still places the cursor in the table", async () => {
  const { app, document } = await boot();
  const link = document.querySelector('#editor-host .cm-lp-table a[href="01-tools.md"]');
  link.dispatchEvent(new app.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  await app.settle();
  assert.equal(document.getElementById("main-title").textContent, "00-overview.md");
  assert.equal(siblingCalls(app).length, 0);
});

test("hovering a Live link shows a button that follows it without a modifier", async () => {
  const { app, document } = await boot();
  const button = document.querySelector("#editor-host .cm-lp-follow");
  assert.equal(button.hidden, true);
  assert.equal(button.getAttribute("aria-label"), "Follow link");

  const link = [...document.querySelectorAll("#editor-host .cm-lp-link")]
    .find((element) => element.getAttribute("data-href") === "01-tools.md#register-tools");
  link.dispatchEvent(new app.dom.window.MouseEvent("mouseover", { bubbles: true }));
  assert.equal(button.hidden, false);

  const pressed = new app.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  button.dispatchEvent(pressed);
  assert.equal(pressed.defaultPrevented, true, "pressing the button never moves the cursor");
  button.click();
  await app.settle();
  assert.equal(document.getElementById("main-title").textContent, "01-tools.md");
  assert.equal(button.hidden, true);
});

test("hovering a table link shows the follow button too", async () => {
  const { app, document } = await boot();
  const link = document.querySelector('#editor-host .cm-lp-table a[href="01-tools.md"]');
  link.dispatchEvent(new app.dom.window.MouseEvent("mouseover", { bubbles: true }));
  const button = document.querySelector("#editor-host .cm-lp-follow");
  assert.equal(button.hidden, false);
  button.click();
  await app.settle();
  assert.equal(document.getElementById("main-title").textContent, "01-tools.md");
});

function pressShortcut(app, key) {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, metaKey: true });
  app.dom.window.document.body.dispatchEvent(event);
  return event;
}

test("Back and Forward return along followed links, from buttons, shortcuts and mouse buttons", async () => {
  const { app, document } = await boot();
  const title = () => document.getElementById("main-title").textContent;
  const back = document.getElementById("nav-back-btn");
  const forward = document.getElementById("nav-forward-btn");
  assert.equal(back.hidden, false);
  assert.equal(back.disabled, true);
  assert.equal(forward.disabled, true);

  app.click("mode-reading");
  const preview = document.getElementById("markdown-preview");
  linkTo(preview, "#approach").click();
  await app.settle();
  linkTo(preview, "01-tools.md#register-tools").click();
  await app.settle();
  assert.equal(title(), "01-tools.md");
  assert.equal(back.disabled, false);

  back.click();
  await app.settle();
  assert.equal(title(), "00-overview.md");
  assert.equal(forward.disabled, false);

  assert.equal(pressShortcut(app, "]").defaultPrevented, true);
  await app.settle();
  assert.equal(title(), "01-tools.md");
  assert.equal(forward.disabled, true);

  pressShortcut(app, "[");
  await app.settle();
  assert.equal(title(), "00-overview.md");

  document.getElementById("file-editor").dispatchEvent(new app.dom.window.MouseEvent("mouseup", { bubbles: true, button: 4 }));
  await app.settle();
  assert.equal(title(), "01-tools.md");
  document.getElementById("file-editor").dispatchEvent(new app.dom.window.MouseEvent("mouseup", { bubbles: true, button: 3 }));
  await app.settle();
  assert.equal(title(), "00-overview.md");
});

test("following a new link after going back drops the forward entries", async () => {
  const { app, document } = await boot();
  app.click("mode-reading");
  const preview = () => document.getElementById("markdown-preview");
  linkTo(preview(), "01-tools.md#register-tools").click();
  await app.settle();
  document.getElementById("nav-back-btn").click();
  await app.settle();
  linkTo(preview(), "#approach").click();
  await app.settle();
  assert.equal(document.getElementById("nav-forward-btn").disabled, true);
  assert.equal(document.getElementById("nav-back-btn").disabled, false);
});
