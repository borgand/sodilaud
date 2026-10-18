// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const PATH = "/docs/linux.md";
const TEXT = "# T\n\nThe intro is vague.\n";

test("Linux: Ctrl+Alt+M comments in Reading or asks for a selection, Meta+Alt+M does not", async () => {
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    disk: { [PATH]: TEXT },
    handlers: {
      qn_get_config: () => ({ hotkey: "ctrl+shift+KeyN", requested: "ctrl+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: [PATH], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => []
    },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const { window } = app.dom;
  const doc = window.document;
  await app.settle();
  app.click("mode-reading");
  await app.settle();

  const preview = doc.getElementById("markdown-preview");
  const node = doc.createTreeWalker(preview.querySelector("p"), 4).nextNode();
  const from = node.nodeValue.indexOf("vague");
  const press = modifier => doc.body.dispatchEvent(new window.KeyboardEvent("keydown", {
    code: "KeyM", key: "m", altKey: true, [modifier]: true, bubbles: true, cancelable: true
  }));

  window.getSelection().removeAllRanges();
  press("ctrlKey");
  await app.settle();
  assert.ok(!preview.querySelector(".reading-composer"), "nothing selected opens no composer");
  assert.equal(doc.getElementById("app-notification").textContent, "Select the text to comment on first");

  window.getSelection().setBaseAndExtent(node, from, node, from + 5);
  press("metaKey");
  await app.settle();
  assert.ok(!preview.querySelector(".reading-composer"), "Meta+Alt+M does nothing on Linux");

  window.getSelection().setBaseAndExtent(node, from, node, from + 5);
  press("ctrlKey");
  await app.settle();
  assert.ok(preview.querySelector(".reading-composer"), "Ctrl+Alt+M opens the Reading composer");
});
