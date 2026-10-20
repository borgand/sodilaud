// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const F = "```";
const PATH = "/docs/p.md";
const TEXT = `intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${F}js\nlet a;\n${F}\nafter`;
const FENCE_FROM = TEXT.indexOf(`${F}js`);

const handlers = () => ({
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
  file_lists: () => ({ open: [PATH], recent: [] }),
  file_set_open: () => null,
  file_take_pending: () => []
});

test("Live: Ctrl-Alt-E toggles the raw fence on Linux, Cmd-Alt-E does not", async () => {
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    instance: 1,
    disk: { [PATH]: TEXT },
    handlers: handlers(),
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const view = app.editor();
  await app.settle();
  view.focus();
  const body = TEXT.indexOf("let a;") + 2;
  view.dispatch({ selection: { anchor: body } });
  const { isRawBlock } = await import("../src/editor-live-blocks.js");
  const press = init => view.contentDOM.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "e", code: "KeyE", keyCode: 69, altKey: true, bubbles: true, cancelable: true, ...init }));

  press({ metaKey: true });
  await app.settle(50);
  assert.ok(!isRawBlock(view.state, FENCE_FROM));
  press({ ctrlKey: true });
  await app.settle(50);
  assert.ok(isRawBlock(view.state, FENCE_FROM));
});

test("Live: Ctrl-Alt-E on the line above a rendered diagram toggles its pencil", async () => {
  const text = `a\n${F}mermaid\ngraph TD\n${F}\nb`;
  const app = await bootMainWindow({
    platform: "Linux x86_64",
    instance: 2,
    disk: { [PATH]: text },
    handlers: handlers(),
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  const view = app.editor();
  await app.settle();
  view.focus();
  view.dispatch({ selection: { anchor: 1 } });
  const { isRawBlock } = await import("../src/editor-live-blocks.js");
  view.contentDOM.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "e", code: "KeyE", keyCode: 69, altKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
  await app.settle(50);
  assert.ok(isRawBlock(view.state, 2));
});
