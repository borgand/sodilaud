// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((match) => match[1]);

const declared = (block, property) => block.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1].trim().replace(/['"]/g, "");

test("every @font-face source is a vendored file that exists", async () => {
  const urls = faces.flatMap((block) => [...block.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]));
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.match(url, /^vendor\/fonts\//);
    await access(new URL(`../src/${url}`, import.meta.url));
  }
});

test("no @font-face uses local() or a remote URL", () => {
  for (const block of faces) {
    assert.doesNotMatch(block, /local\(/);
    assert.doesNotMatch(block, /url\("?https?:/);
  }
});

test("IBM Plex Mono and Serif declare 400 and 700, upright and italic", () => {
  for (const family of ["IBM Plex Mono", "IBM Plex Serif"]) {
    const tuples = new Set(
      faces
        .filter((block) => declared(block, "font-family") === family)
        .map((block) => `${declared(block, "font-weight")}/${declared(block, "font-style")}`),
    );
    for (const tuple of ["400/normal", "400/italic", "700/normal", "700/italic"]) {
      assert.ok(tuples.has(tuple), `${family} is missing ${tuple}`);
    }
  }
});

test("each bundled family ships its OFL licence", async () => {
  for (const file of ["IBMPlexMono-OFL.txt", "IBMPlexSerif-OFL.txt"]) {
    const text = await readFile(new URL(`../src/vendor/fonts/${file}`, import.meta.url), "utf8");
    assert.match(text, /SIL Open Font License/i);
    assert.match(text, /Reserved Font Name "Plex"/);
  }
});
