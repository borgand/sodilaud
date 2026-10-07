// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { createNavHistory } from "../src/nav-history.js";

const at = (path, top = 0, anchor) => (anchor ? { path, top, anchor } : { path, top });

test("going back restores where the reader left each place", () => {
  const history = createNavHistory();
  assert.equal(history.canBack(), false);
  history.visit(at("a.md", 40), at("a.md", 900, "approach"));
  history.visit(at("a.md", 950), at("b.md", 0, "tools"));
  assert.deepEqual(history.back(at("b.md", 120)), at("a.md", 950));
  assert.deepEqual(history.back(at("a.md", 950)), at("a.md", 40));
  assert.equal(history.canBack(), false);
  assert.deepEqual(history.forward(at("a.md", 40)), at("a.md", 950));
  assert.deepEqual(history.forward(at("a.md", 950)), at("b.md", 120));
  assert.equal(history.canForward(), false);
});

test("a new jump after going back drops the forward places", () => {
  const history = createNavHistory();
  history.visit(at("a.md"), at("b.md"));
  history.back(at("b.md"));
  history.visit(at("a.md"), at("a.md", 0, "approach"));
  assert.equal(history.canForward(), false);
  assert.deepEqual(history.back(at("a.md", 0, "approach")), at("a.md"));
});

test("a jump from a file reached some other way keeps both places", () => {
  const history = createNavHistory();
  history.visit(at("a.md"), at("b.md"));
  history.visit(at("c.md", 10), at("d.md"));
  assert.deepEqual(history.back(at("d.md")), at("c.md", 10));
  assert.deepEqual(history.back(at("c.md", 10)), at("b.md"));
});

test("jumps without a file are not recorded", () => {
  const history = createNavHistory();
  history.visit(null, at("a.md"));
  history.visit(at("a.md"), null);
  assert.equal(history.canBack(), false);
  assert.equal(history.canForward(), false);
});
