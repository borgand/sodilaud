// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DOCUMENT_THEME_PROPERTIES } from "../src/theme-colors.js";

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

test("document-area rules use theme tokens, never colour literals", () => {
  const ALLOWED_BASE = ["--preview-bg", "--preview-text", "--editor-bg", "--editor-text", "--text-primary",
    "--text-secondary", "--text-muted", "--accent-color", "--accent-hover", "--border-color", "--bg-app"];
  const allowed = new Set([...DOCUMENT_THEME_PROPERTIES, ...ALLOWED_BASE]);
  const isDocument = selector =>
    /\.markdown-preview|\.cm-lp-|\.cm-mode-live|^\.cm-editor \.syntax-(heading|link|code)\b/.test(selector);
  const isExcluded = selector =>
    /\.diff-|\.mermaid-error|\.cm-comment|find-preview-match\.active-match|\.cm-find-active/.test(selector);
  const colourProperty = /^(color|background|background-color|border[\w-]*|box-shadow|outline[\w-]*|accent-color|text-decoration-color)$/;
  const literal = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

  const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders = [];
  let checked = 0;
  for (const [, selectorList, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = selectorList.split(/,(?![^(]*\))/).map(selector => selector.trim());
    if (!selectors.some(selector => isDocument(selector) && !isExcluded(selector))) continue;
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1);
      if (!colourProperty.test(property)) continue;
      checked += 1;
      const unknown = [...value.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]).filter(name => !allowed.has(name));
      if (literal.test(value) || unknown.length) {
        offenders.push(`${selectors[0]} { ${property}:${value.trim()} }`);
      }
    }
  }
  assert.ok(checked > 20, "the scan found document rules");
  assert.deepEqual(offenders, []);
});
