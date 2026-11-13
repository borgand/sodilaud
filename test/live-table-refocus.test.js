// SPDX-License-Identifier: GPL-3.0-or-later

// Hiding Quick Notes (or clicking away from the file editor) blurs the editor,
// which turns a grid table back into its widget; showing it again turns the
// widget back into one line per row. Both swaps replace measured heights with
// estimates, and CodeMirror's scroll anchor then "corrects" the scroll by the
// error, pushing the table out of view (#77). The swap must carry its own
// scroll target so the anchor correction never runs.
import test from "node:test";
import assert from "node:assert/strict";
import { setupLive, settle } from "./helpers/live-editor.js";

const T = "intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nafter";

const posOf = (t, needle) => t.view.state.doc.toString().indexOf(needle);

function recordTransactions(t) {
  const seen = [];
  const dispatch = t.view.dispatch.bind(t.view);
  t.view.dispatch = (...specs) => {
    const tr = specs.length === 1 && specs[0]?.state ? specs[0] : t.view.state.update(...specs);
    seen.push(tr);
    dispatch(tr);
  };
  return seen;
}

// CodeMirror's scroll-into-view effect carries a ScrollTarget.
const scrollTargets = tr => tr.effects.map(effect => effect.value).filter(value => value && value.range && "yMargin" in value);

function stubTableTop(t, offset) {
  const scrollerTop = 100;
  t.view.scrollDOM.getBoundingClientRect = () => ({ top: scrollerTop, bottom: scrollerTop + 400, left: 0, right: 600, width: 600, height: 400, x: 0, y: scrollerTop });
  Object.defineProperty(t.view, "documentTop", { get: () => scrollerTop + offset - t.view.lineBlockAt(posOf(t, "| a |")).top, configurable: true });
}

test("blurring a grid table keeps the table's top where it was on screen", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "3 |") + 1);
    const { gridTable } = await import("../src/editor-table-grid.js");
    assert.ok(gridTable(t.view.state), "grid mode");
    stubTableTop(t, -37);
    const seen = recordTransactions(t);
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    assert.ok(!gridTable(t.view.state), "the widget is back");
    const targets = seen.flatMap(scrollTargets);
    assert.equal(targets.length, 1, "one scroll target");
    assert.equal(targets[0].range.head, posOf(t, "| a |"));
    assert.equal(targets[0].y, "start");
    assert.equal(targets[0].yMargin, -37);
  } finally { t.done(); }
});

test("focus coming back to a table cell scrolls that cell into view", async () => {
  const t = await setupLive(T);
  try {
    const caret = posOf(t, "3 |") + 1;
    await t.caret(caret);
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    const { gridTable } = await import("../src/editor-table-grid.js");
    assert.ok(!gridTable(t.view.state), "the widget while blurred");
    const seen = recordTransactions(t);
    t.setFocus(true);
    t.view.dispatch({});
    await settle();
    assert.ok(gridTable(t.view.state), "grid mode again");
    const targets = seen.flatMap(scrollTargets);
    assert.equal(targets.length, 1, "one scroll target");
    assert.equal(targets[0].range.head, caret);
    assert.equal(targets[0].y, "nearest");
  } finally { t.done(); }
});

test("a focus change away from tables leaves the scroll to CodeMirror", async () => {
  const t = await setupLive(T);
  try {
    await t.caret(posOf(t, "after") + 1);
    const seen = recordTransactions(t);
    t.setFocus(false);
    t.view.dispatch({});
    await settle();
    t.setFocus(true);
    t.view.dispatch({});
    await settle();
    assert.equal(seen.flatMap(scrollTargets).length, 0);
  } finally { t.done(); }
});
