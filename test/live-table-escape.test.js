// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import { bootApp, bootMainWindow } from "./helpers/app-harness.js";

const T = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter";
const AFTER = T.indexOf("\n\nafter") + 1;

const keydown = (app, target, init) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const barOpen = app => app.dom.window.document.getElementById("find-bar").style.display === "flex";

// Opens the find bar, then puts the caret back in a table cell and presses
// Escape there.
async function escapeInCell(app) {
  const view = app.editor();
  await app.settle();
  view.focus();
  keydown(app, view.contentDOM, { key: "f", code: "KeyF", metaKey: true });
  assert.equal(barOpen(app), true);
  view.focus();
  view.dispatch({ selection: { anchor: T.indexOf("1 |") + 1 } });
  await app.settle();
  const { gridTable } = await import("../src/editor-table-grid.js");
  assert.ok(gridTable(view.state));
  keydown(app, view.contentDOM, { key: "Escape" });
  await app.settle();
}

test("Escape in a table cell leaves the table and keeps the find bar open", async () => {
  const app = await bootMainWindow({
    platform: "MacIntel",
    disk: { "/d/t.md": T },
    beforeBoot: dom => { dom.window.marked = marked; },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: ["/d/t.md"], recent: [] }),
      file_set_open: () => null,
      file_take_pending: () => []
    }
  });
  await escapeInCell(app);
  assert.equal(app.editor().state.selection.main.head, AFTER);
  assert.equal(barOpen(app), true);
});

test("Quick Notes: Escape in a table cell leaves the table and keeps the find bar open", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    instance: 2,
    registry: { seed: { notes: [{ id: "a", title: "Table", content: T, updatedAt: 1, isTitleLocked: false }], imported: true } },
    beforeBoot: dom => { dom.window.marked = marked; }
  });
  await escapeInCell(app);
  assert.equal(app.editor().state.selection.main.head, AFTER);
  assert.equal(barOpen(app), true);
});
