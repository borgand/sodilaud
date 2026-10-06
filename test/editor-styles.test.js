// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const bundle = await readFile(new URL("../src/vendor/codemirror.js", import.meta.url), "utf8");

// [ids, classes and pseudo-classes, elements]; :is() counts its most specific argument.
function specificity(selector) {
  let rest = selector;
  let best = [0, 0, 0];
  rest = rest.replace(/:is\(([^)]*)\)/g, (_, args) => {
    const inner = args.split(",").map(arg => specificity(arg.trim()));
    inner.sort(compare).reverse();
    best = add(best, inner[0]);
    return " ";
  });
  const ids = (rest.match(/#[\w-]+/g) || []).length;
  const classes = (rest.match(/\.[^\s.#>+~:[]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const elements = (rest.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return add(best, [ids, classes, elements]);
}
const add = (a, b) => a.map((value, index) => value + b[index]);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

test("the editor selection colour outranks every CodeMirror base-theme selection rule", () => {
  const ours = [...styles.matchAll(/([^{}]*\.cm-selectionBackground[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /background-color/.test(body))
    .flatMap(([, selectors]) => selectors.split(/,(?![^(]*\))/).map(s => s.trim()));
  assert.ok(ours.length > 0, "styles.css styles the editor selection");

  const base = [...bundle.matchAll(/"([^"]*\.cm-selectionBackground[^"]*)"/g)]
    .map(([, selector]) => selector.replace(/&(light|dark)/g, ".scope.theme").replace(/&/g, ".scope"));
  assert.ok(base.some(selector => selector.includes("cm-focused")), "the focused base rule was found");

  for (const selector of ours) {
    for (const baseSelector of base) {
      assert.ok(
        compare(specificity(selector), specificity(baseSelector)) > 0,
        `${selector} must outrank ${baseSelector}`
      );
    }
  }
});

test("the Live table widget wraps cells between words, not anywhere", () => {
  const rules = [...styles.matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some(s => s.trim() === ".cm-mode-live .cm-lp-table.markdown-preview"))
    .map(([, , body]) => body)
    .join(";");

  assert.match(rules, /white-space:\s*normal/);
  assert.match(rules, /word-break:\s*normal/);
  assert.match(rules, /overflow-wrap:\s*normal/);
});
