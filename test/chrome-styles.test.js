// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, "");
const app = strip(await readFile(new URL("../src/app.css", import.meta.url), "utf8"));
const styles = strip(await readFile(new URL("../src/styles.css", import.meta.url), "utf8"));

function declarations(css, selector) {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").map(s => s.trim()).includes(selector))
    .map(([, , body]) => body)
    .join("\n");
}

test("outline rows wrap with a hanging indent", () => {
  const link = declarations(app, ".outline-link");
  assert.match(link, /white-space:\s*normal/);
  assert.match(link, /text-indent:\s*-0\.75em/);
  assert.match(link, /font-size:\s*0\.9rem/);
  assert.doesNotMatch(link, /text-overflow:\s*ellipsis/);
  assert.match(declarations(app, ".outline-item"), /calc\(var\(--outline-depth,\s*0\)\s*\*\s*16px\)/);
});

test("the current outline row is marked by weight and an accent bar", () => {
  assert.match(declarations(app, ".outline-item.current"), /inset 2px 0 0 var\(--accent-color\)/);
  assert.match(declarations(app, ".outline-item.current .outline-link"), /font-weight:\s*600/);
});

test("the active file is a lift with an accent bar, not the selection pill", () => {
  const active = declarations(app, ".open-file-item.active");
  assert.match(active, /var\(--bg-note-hover\)/);
  assert.match(active, /inset 2px 0 0 var\(--accent-color\)/);
  assert.doesNotMatch(active, /--bg-note-active/);
});

test("the files sidebar is 240px wide", () => {
  assert.match(declarations(app, ".files-sidebar"), /width:\s*240px/);
});

test("a settled status fades and returns on hover", () => {
  assert.match(declarations(app, ".file-status-text.settled"), /opacity:\s*0\b/);
  assert.match(declarations(app, ".file-status:hover .file-status-text.settled"), /opacity:\s*1\b/);
  assert.match(declarations(app, ".file-status:focus-within .file-status-text.settled"), /opacity:\s*1\b/);
  assert.match(declarations(app, ".file-status-text"), /transition:\s*opacity 0\.6s/);
  const reduced = app.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?\}\s*)\}/);
  assert.ok(reduced, "a reduced-motion block exists");
  assert.match(reduced[1], /\.file-status-text/);
  assert.match(reduced[1], /transition:\s*none/);
});
