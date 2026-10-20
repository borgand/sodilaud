// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { installEditorDom } from "./helpers/cm-dom.js";
import { setupLive, settle } from "./helpers/live-editor.js";

// CodeMirror reads the platform once, when it is first imported.
const probe = installEditorDom();
Object.defineProperty(probe.window.navigator, "platform", { value: "MacIntel", configurable: true });
await import("../src/vendor/codemirror.js");
probe.cleanup();

const F = "```";
const TEXT = `intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n${F}js\nlet a;\n${F}\nafter`;
const FENCE_FROM = TEXT.indexOf(`${F}js`);
const BODY = TEXT.indexOf("let a;");

const blocks = () => import("../src/editor-live-blocks.js");
const query = (t, selector) => t.view.contentDOM.querySelector(selector);

const setup = () => setupLive(TEXT);

test("rendered tables and fence headers carry an Edit Markdown pencil", async () => {
  const t = await setup();
  try {
    await t.caret(0);
    for (const selector of [".cm-lp-table .cm-lp-pencil", ".cm-lp-codeblock-head .cm-lp-pencil"]) {
      const pencil = query(t, selector);
      assert.ok(pencil, selector);
      assert.equal(pencil.title, "Edit Markdown");
      assert.equal(pencil.getAttribute("aria-label"), "Edit Markdown");
      assert.equal(pencil.getAttribute("aria-pressed"), "false");
    }
  } finally { t.done(); }
});

test("the fence pencil shows the raw fences and keeps the caret; pressed again shows the header", async () => {
  const t = await setup();
  try {
    await t.caret(BODY + 2);
    query(t, ".cm-lp-codeblock-head .cm-lp-pencil").click();
    await settle();
    assert.ok(t.lineTexts().includes(`${F}js`));
    assert.ok(t.lineTexts().includes(F));
    assert.equal(t.view.state.selection.main.head, BODY + 2);
    const pressed = query(t, '.cm-lp-pencil[aria-pressed="true"]');
    assert.ok(pressed);
    assert.equal(pressed.title, "Show rendered");
    pressed.click();
    await settle();
    assert.ok(query(t, ".cm-lp-fence-label"));
  } finally { t.done(); }
});

test("the table pencil shows the pipes and puts the caret in the table", async () => {
  const t = await setup();
  try {
    await t.caret(0);
    query(t, ".cm-lp-table .cm-lp-pencil").click();
    await settle();
    const { liveTableAt } = await blocks();
    assert.ok(t.lineTexts().some(text => text.includes("|---")));
    assert.ok(liveTableAt(t.view.state, t.view.state.selection.main.head) !== null);
  } finally { t.done(); }
});

const modAltE = t => t.view.contentDOM.dispatchEvent(new t.env.window.KeyboardEvent("keydown", {
  key: "´", code: "KeyE", keyCode: 69, metaKey: true, altKey: true, bubbles: true, cancelable: true
}));

test("Mod-Alt-E toggles the block under the caret", async () => {
  const t = await setup();
  try {
    const { isRawBlock } = await blocks();
    await t.caret(BODY + 2);
    modAltE(t);
    await settle();
    assert.ok(isRawBlock(t.view.state, FENCE_FROM));
    modAltE(t);
    await settle();
    assert.ok(!isRawBlock(t.view.state, FENCE_FROM));
    await t.caret(2);
    modAltE(t);
    await settle();
    assert.ok(!isRawBlock(t.view.state, FENCE_FROM));
    assert.ok(query(t, ".cm-lp-fence-label"));
  } finally { t.done(); }
});

test("the raw view ends when the caret leaves the block", async () => {
  const t = await setup();
  try {
    const { isRawBlock, toggleRawBlock } = await blocks();
    await t.caret(BODY + 2);
    t.view.dispatch({ effects: toggleRawBlock.of(FENCE_FROM) });
    assert.ok(isRawBlock(t.view.state, FENCE_FROM));
    await t.caret(TEXT.length);
    assert.ok(!isRawBlock(t.view.state, FENCE_FROM));
    assert.ok(query(t, ".cm-lp-fence-label"));
  } finally { t.done(); }
});

test("an edit above a raw block keeps it raw", async () => {
  const t = await setup();
  try {
    const { isRawBlock, toggleRawBlock } = await blocks();
    await t.caret(BODY + 2);
    t.view.dispatch({ effects: toggleRawBlock.of(FENCE_FROM) });
    t.view.dispatch({ changes: { from: 0, insert: "x\n" }, userEvent: "input.type" });
    assert.ok(isRawBlock(t.view.state, FENCE_FROM + 2));
    assert.ok(t.lineTexts().includes(`${F}js`));
  } finally { t.done(); }
});
