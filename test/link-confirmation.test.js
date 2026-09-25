// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the renderer never opens a url without a native confirmation", async () => {
  const [main, capability] = await Promise.all([
    readFile("src/main.js", "utf8"),
    readFile("src-tauri/capabilities/default.json", "utf8")
  ]);
  assert.doesNotMatch(main, /plugin:opener\|open_url/);
  assert.match(main, /confirm_and_open_url/);
  assert.doesNotMatch(capability, /opener:allow-open-url/);
});
