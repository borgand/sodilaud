// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const RUST_DIR = "src-tauri/src/clipboard";

async function rustSources() {
  const files = (await readdir(RUST_DIR)).filter(f => f.endsWith(".rs"));
  return Promise.all(files.map(async f => [f, await readFile(`${RUST_DIR}/${f}`, "utf8")]));
}

test("clipboard Rust code never logs", async () => {
  for (const [file, source] of await rustSources()) {
    assert.doesNotMatch(source, /\b(?:e?println!|e?print!|dbg!|log::|tracing::)/, `${file} must not log`);
  }
});

test("MCP code does not reach the clipboard module", async () => {
  const mcp = await readFile("src-tauri/src/mcp.rs", "utf8");
  assert.doesNotMatch(mcp, /clipboard::/);
});

test("only the popup page calls popup commands", async () => {
  const files = (await readdir("src")).filter(f => f.endsWith(".js") && f !== "clipboard.js");
  for (const file of files) {
    const source = await readFile(`src/${file}`, "utf8");
    const calls = source.match(/["'`]clip_[a-z_]+["'`]/g) ?? [];
    const allowed = ["clip_set_config", "clip_set_theme"];
    for (const call of calls) {
      assert.ok(allowed.includes(call.slice(1, -1)), `${file} must not call ${call}`);
    }
  }
});

test("popup page keeps values out of storage, logs, and the network", async () => {
  const source = await readFile("src/clipboard.js", "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB|console|fetch|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML)\b/);
});
