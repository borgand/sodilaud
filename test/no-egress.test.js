// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripNonNetworkIdentifiers } from "../scripts/check-no-egress.mjs";

const run = promisify(execFile);
const REMOTE_URL = /https?:\/\/\S/;

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

test("stripNonNetworkIdentifiers removes only the exact SVG namespace identifier", () => {
  assert.equal(
    REMOTE_URL.test(stripNonNetworkIdentifiers('const SVG_NS = "http://www.w3.org/2000/svg";')),
    false,
    "a line with only the allowed identifier must no longer match the remote-url rule"
  );
});

test("stripNonNetworkIdentifiers leaves another url on the same line intact", () => {
  const line = 'const x = "http://www.w3.org/2000/svg" + "https://evil.example/";';
  assert.equal(
    REMOTE_URL.test(stripNonNetworkIdentifiers(line)),
    true,
    "a different url on the same line must still match the remote-url rule"
  );
});

test("stripNonNetworkIdentifiers leaves near-miss identifiers intact", () => {
  for (const line of [
    'const x = "http://www.w3.org/2000/svg-evil";',
    'const x = "https://www.w3.org/2000/svg";'
  ]) {
    assert.equal(
      REMOTE_URL.test(stripNonNetworkIdentifiers(line)),
      true,
      `near-miss line must still match the remote-url rule: ${line}`
    );
  }
});

test("the egress gate allows a line with only the SVG namespace identifier", async () => {
  const file = "src/egress-probe.js";
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(file, 'export const SVG_NS = "http://www.w3.org/2000/svg";\n');
  try {
    await run(process.execPath, ["scripts/check-no-egress.mjs"]);
  } finally {
    await rm(file, { force: true });
  }
});

test("the egress gate still rejects the SVG namespace identifier plus another remote url on the same line", async () => {
  const file = "src/egress-probe.js";
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(file, 'export const x = "http://www.w3.org/2000/svg" + "https://evil.example/";\n');
  try {
    await assert.rejects(() => run(process.execPath, ["scripts/check-no-egress.mjs"]));
  } finally {
    await rm(file, { force: true });
  }
});

test("the egress gate still rejects near-miss identifiers that only look like the SVG namespace", async () => {
  const file = "src/egress-probe.js";
  const { writeFile, rm } = await import("node:fs/promises");
  await writeFile(
    file,
    'export const a = "http://www.w3.org/2000/svg-evil";\nexport const b = "https://www.w3.org/2000/svg";\n'
  );
  try {
    await assert.rejects(() => run(process.execPath, ["scripts/check-no-egress.mjs"]));
  } finally {
    await rm(file, { force: true });
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
