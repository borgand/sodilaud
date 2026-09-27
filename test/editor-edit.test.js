// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { getChangedRange } from "../src/editor-edit.js";

test("the changed range covers only the text between the common prefix and suffix", () => {
  assert.deepEqual(getChangedRange("one", "one\n- "), { start: 3, previousEnd: 3, replacement: "\n- " });
  assert.deepEqual(getChangedRange("before", "after"), { start: 0, previousEnd: 6, replacement: "after" });
  assert.deepEqual(
    getChangedRange("Book a hotel, then book", "Book a hotel, then reserve"),
    { start: 19, previousEnd: 23, replacement: "reserve" }
  );
});

test("a pure deletion or an unchanged value produces an empty replacement", () => {
  assert.deepEqual(getChangedRange("- item\n- ", "- item\n"), { start: 7, previousEnd: 9, replacement: "" });
  assert.deepEqual(getChangedRange("same", "same"), { start: 4, previousEnd: 4, replacement: "" });
});

test("a repeated character is not claimed by both the prefix and the suffix", () => {
  assert.deepEqual(getChangedRange("aa", "aaa"), { start: 2, previousEnd: 2, replacement: "a" });
  assert.deepEqual(getChangedRange("aaa", "a"), { start: 1, previousEnd: 3, replacement: "" });
});
