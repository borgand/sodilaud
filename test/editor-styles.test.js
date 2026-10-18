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

function declarations(selector) {
  return [...styles.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.replace(/\/\*[\s\S]*?\*\//g, "").split(",").map(s => s.trim()).includes(selector))
    .map(([, , body]) => body)
    .join("\n");
}

const HEADING_SIZES = ["2.25em", "1.7em", "1.3em", "1.1em", "1em", "0.9em"];

test("Live and Reading use the same heading scale", () => {
  HEADING_SIZES.forEach((size, index) => {
    const level = index + 1;
    const reading = declarations(`.markdown-preview h${level}`);
    const live = declarations(`.cm-mode-live .cm-lp-h${level}`);
    assert.match(reading, new RegExp(`font-size:\\s*${size.replace(".", "\\.")}\\b`), `Reading h${level}`);
    assert.match(live, new RegExp(`font-size:\\s*${size.replace(".", "\\.")}\\b`), `Live h${level}`);
  });
  for (const selector of [".markdown-preview h1", ".cm-mode-live .cm-lp-h1"]) {
    assert.ok(styles.includes(selector));
  }
  const shared = declarations(".cm-mode-live .cm-lp-h1");
  assert.match(shared, /font-weight:\s*700/);
  assert.match(shared, /line-height:\s*1\.25/);
  assert.match(shared, /letter-spacing:\s*-0\.02em/);
  assert.match(declarations(".markdown-preview h1"), /font-weight:\s*700/);
});

test("Live heading lines use padding, not margin", () => {
  const rules = [...styles.matchAll(/([^{}]*\.cm-mode-live \.cm-lp-(?:h[1-6]|heading-rule)[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0);
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(body, /(^|[\s;])margin/, selector.trim());
  }
});

test("only the last line of an H1 or H2 carries the rule in Live", () => {
  assert.match(declarations(".cm-mode-live .cm-lp-heading-rule"), /border-bottom:\s*1px solid var\(--preview-hr\)/);
  assert.doesNotMatch(declarations(".cm-mode-live .cm-lp-h1"), /border-bottom/);
});

test("Reading mode follows editor zoom and line spacing", () => {
  const body = declarations(".markdown-preview");
  assert.match(body, /font-size:\s*var\(--editor-font-size\)/);
  assert.match(body, /line-height:\s*var\(--editor-line-height\)/);
});

test("Reading nested lists and quote endings add no extra gap, and Live avoids :has()", () => {
  for (const selector of [".markdown-preview li > ul", ".markdown-preview li > ol", ".markdown-preview blockquote > :last-child"]) {
    assert.match(declarations(selector), /margin-bottom:\s*0/, selector);
  }
  assert.doesNotMatch(styles, /\.cm-lp-h[12]:has\(/);
});
