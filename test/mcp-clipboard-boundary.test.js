// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the snapshot sent to agents carries no workspace path", async () => {
  const main = await readFile("src/main.js", "utf8");
  const snapshot = main.slice(main.indexOf("function mcpSnapshotArguments"), main.indexOf("function mcpSnapshotArguments") + 900);
  assert.doesNotMatch(snapshot, /dbPath/);
});

test("clipboard content has no path into the agent snapshot", async () => {
  const mcp = await readFile("src-tauri/src/mcp.rs", "utf8");
  // The Snapshot struct must document, and the search tool must not reach, a clipboard store.
  assert.match(mcp, /clipboard items must never enter this snapshot/i);
});
