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

const click = (element) => {
  for (const type of ["mousedown", "mouseup"]) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
};
const opened = () => app.invocations
  .filter(({ command }) => command === "confirm_and_open_url")
  .map(({ args }) => args.url);

test("Plain click on a live-preview link opens it through the preview link policy", () => {
  const byHref = href => [...document.querySelectorAll("#editor-host .cm-lp-link")]
    .find(link => link.getAttribute("data-href") === href);

  click(byHref("https://example.com/ok"));
  assert.deepEqual(opened(), ["https://example.com/ok"]);

  click(byHref("https://example.com/auto"));
  assert.deepEqual(opened(), ["https://example.com/ok", "https://example.com/auto"]);

  // Last: an unsafe link is not followed, so the click places the caret and reveals its source.
  click(byHref("javascript:alert(1)"));
  assert.deepEqual(opened(), ["https://example.com/ok", "https://example.com/auto"], "unsafe schemes are never handed to the OS");
});
