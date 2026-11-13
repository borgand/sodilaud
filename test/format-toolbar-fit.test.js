// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { getVisibleItemCount, roomBesideTitle } from "../src/format-toolbar-fit.js";

test("every item is visible when they all fit", () => {
  assert.equal(getVisibleItemCount(100, [30, 30, 40], 20), 3);
  assert.equal(getVisibleItemCount(500, [30, 30, 40], 20), 3);
});

test("overflowing keeps room for the overflow button", () => {
  assert.equal(getVisibleItemCount(99, [30, 30, 40], 20), 2);
  assert.equal(getVisibleItemCount(79, [30, 30, 40], 20), 1);
  assert.equal(getVisibleItemCount(49, [30, 30, 40], 20), 0);
  assert.equal(getVisibleItemCount(10, [30, 30, 40], 20), 0);
});

test("items are taken in priority order, so a narrow item after a wide one does not jump ahead", () => {
  assert.equal(getVisibleItemCount(74, [30, 40, 5], 20), 1);
});

test("without layout every item counts as visible", () => {
  assert.equal(getVisibleItemCount(0, [0, 0, 0], 0), 3);
  assert.equal(getVisibleItemCount(0, [30, 30], 20), 2);
  assert.equal(getVisibleItemCount(100, [0, 0], 0), 2);
  assert.equal(getVisibleItemCount(Number.NaN, [30], 20), 1);
});

test("non-finite widths count as zero", () => {
  assert.equal(getVisibleItemCount(50, [30, Number.NaN, 30], 10), 2);
});

test("a title squeezed below its minimum takes the shortfall from the toolbar", () => {
  assert.equal(roomBesideTitle(300, 40, 120), 220);
  assert.equal(roomBesideTitle(300, 0, 120), 180);
});

test("a title at or above its minimum leaves the toolbar its room", () => {
  assert.equal(roomBesideTitle(300, 120, 120), 300);
  assert.equal(roomBesideTitle(300, 400, 120), 300);
  assert.equal(roomBesideTitle(300, 0, 0), 300);
});

test("without a reserve or a measured width the room is unchanged", () => {
  assert.equal(roomBesideTitle(300, Number.NaN, 0), 300);
  assert.equal(roomBesideTitle(300, 50, Number.NaN), 300);
  assert.equal(roomBesideTitle(0, 0, 120), 0);
});

test("a laid-out toolbar never reads as unlaid, so everything overflows", () => {
  assert.equal(roomBesideTitle(60, 0, 120), 1);
  assert.equal(getVisibleItemCount(roomBesideTitle(60, 0, 120), [30, 30], 20), 0);
});
