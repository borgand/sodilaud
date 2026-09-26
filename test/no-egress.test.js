// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("the egress gate passes against the repository as checked out", async () => {
  await run(process.execPath, ["scripts/check-no-egress.mjs"]);
});

test("the egress gate rejects a reintroduced fetch", async () => {
  const file = "src/egress-probe.js";
  await readFile(file).catch(() => null);
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(file, 'export const probe = () => fetch("http://127.0.0.1/none");\n');
  try {
    await assert.rejects(() => run(process.execPath, ["scripts/check-no-egress.mjs"]));
  } finally {
    await rm(file, { force: true });
  }
});

test("clipboard.js and clipboard.html never contain a URL-looking string", async () => {
  const [js, html] = await Promise.all([
    readFile("src/clipboard.js", "utf8"),
    readFile("src/clipboard.html", "utf8")
  ]);
  for (const source of [js, html]) {
    assert.doesNotMatch(source, /https?:\/\//, "the popup must not carry any allowance for a URL-looking string");
  }
});

test("no updater module or update command survives", async () => {
  const [lib, html, main] = await Promise.all([
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src/index.html", "utf8"),
    readFile("src/main.js", "utf8")
  ]);
  for (const source of [lib, html, main]) {
    assert.doesNotMatch(source, /check_for_updates|get_update_info|open_update_release|createUpdateUi|update-automatic/);
  }
  await assert.rejects(() => readFile("src/updates.js", "utf8"));
  await assert.rejects(() => readFile("src-tauri/src/updates.rs", "utf8"));
});

test("the egress gate ignores Rust test fixtures but not shipped Rust code", async () => {
  const { writeFile, rm } = await import("node:fs/promises");
  const file = "src-tauri/src/egress_probe.rs";
  try {
    await writeFile(file, 'fn shipped() {}\n#[cfg(test)]\nmod tests {\n    const FIXTURE: &str = "https://example.com/";\n}\n');
    await run(process.execPath, ["scripts/check-no-egress.mjs"]);
    await writeFile(file, 'const ENDPOINT: &str = "https://example.com/";\n#[cfg(test)]\nmod tests {}\n');
    await assert.rejects(() => run(process.execPath, ["scripts/check-no-egress.mjs"]));
  } finally {
    await rm(file, { force: true });
  }
});
