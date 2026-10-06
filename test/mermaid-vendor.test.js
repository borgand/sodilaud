// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vendorDir = fileURLToPath(new URL("../src/vendor/mermaid/", import.meta.url));
const chunkDir = join(vendorDir, "chunks/mermaid.esm.min");

async function vendoredFiles() {
  const chunks = (await readdir(chunkDir)).filter(name => name.endsWith(".mjs")).map(name => join(chunkDir, name));
  return [join(vendorDir, "mermaid.esm.min.mjs"), ...chunks];
}

test("the vendored Mermaid matches the pinned package version", async () => {
  const { devDependencies } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const entry = await readFile(join(vendorDir, "mermaid.esm.min.mjs"), "utf8");
  assert.match(entry, new RegExp(`from mermaid ${devDependencies.mermaid.replace(/\./g, "\\.")}\\.`));
});

test("the vendored Mermaid leaves out ELK and source maps", async () => {
  for (const file of await vendoredFiles()) {
    assert.doesNotMatch(file, /[\\/]elk-[^\\/]*$/);
    assert.doesNotMatch(await readFile(file, "utf8"), /sourceMappingURL/, file);
  }
});

test("every relative import in the vendored Mermaid resolves, except the ELK layout", async () => {
  const missing = [];
  for (const file of await vendoredFiles()) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+\.mjs)"/g)) {
      const target = join(dirname(file), match[1]);
      if (!existsSync(target)) missing.push(match[1]);
    }
  }
  assert.ok(missing.length > 0 && missing.every(path => /\/elk-[^/]+\.mjs$/.test(path)), `unexpected missing imports: ${missing}`);
});
