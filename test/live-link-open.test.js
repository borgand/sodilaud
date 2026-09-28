// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const app = await bootApp({
  platform: "MacIntel",
  storage: {
    sodilaud_notes: [{
      id: "links",
      title: "Links",
      content: "[bad](javascript:alert(1))\n[good](https://example.com/ok)\n<https://example.com/auto>",
      updatedAt: 1,
      isTitleLocked: true
    }]
  }
});
const { document, MouseEvent } = app.dom.window;

const cmdClick = (element) => element.dispatchEvent(new MouseEvent("mousedown", {
  bubbles: true, cancelable: true, button: 0, metaKey: true
}));
const opened = () => app.invocations
  .filter(({ command }) => command === "confirm_and_open_url")
  .map(({ args }) => args.url);

test("Cmd-click on a live-preview link opens it through the preview link policy", () => {
  const links = [...document.querySelectorAll("#editor-host .cm-lp-link")];
  const byHref = href => links.find(link => link.getAttribute("data-href") === href);

  cmdClick(byHref("javascript:alert(1)"));
  assert.deepEqual(opened(), [], "unsafe schemes are never handed to the OS");

  cmdClick(byHref("https://example.com/ok"));
  assert.deepEqual(opened(), ["https://example.com/ok"]);

  cmdClick(byHref("https://example.com/auto"));
  assert.deepEqual(opened(), ["https://example.com/ok", "https://example.com/auto"]);
});
