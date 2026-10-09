// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { readFileSync } from "node:fs";
import vm from "node:vm";

import { escapeHTML, highlightPreviewCode, highlightRanges } from "../src/syntax-highlighting.js";

function loadHighlighter() {
  const context = {};
  vm.runInNewContext(`${readFileSync(new URL("../src/vendor/highlight.min.js", import.meta.url), "utf8")};this.hljs = hljs;`, context);
  return context.hljs;
}

test("preview highlighting only processes supported, explicitly labeled fences", () => {
  const dom = new JSDOM(`
    <main>
      <pre><code class="language-js">const value = &lt;unsafe&gt;;</code></pre>
      <pre><code class="language-madeup">plain</code></pre>
      <pre><code>unlabeled</code></pre>
    </main>
  `);
  const calls = [];
  const highlighter = {
    getLanguage: (language) => language === "js",
    highlight: (code, options) => {
      calls.push({ code, options });
      return { value: '<span class="hljs-keyword">const</span> value = &lt;unsafe&gt;;' };
    }
  };
  const container = dom.window.document.querySelector("main");

  assert.equal(highlightPreviewCode(container, highlighter), 1);
  assert.deepEqual(calls, [{
    code: "const value = <unsafe>;",
    options: { language: "js", ignoreIllegals: true }
  }]);
  assert.equal(container.querySelector(".language-js").classList.contains("hljs"), true);
  assert.equal(container.querySelector(".hljs-keyword").textContent, "const");
  assert.equal(container.querySelector(".language-madeup").textContent, "plain");
});

test("escapeHTML escapes every markup-significant character", () => {
  assert.equal(escapeHTML(`<a href="x">Tom & 'Jerry'</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#039;Jerry&#039;&lt;/a&gt;");
});

test("highlight ranges point at the tokens in the original text, entities included", () => {
  const hljs = loadHighlighter();
  const code = 'const a = "<x>" && 1; // hi';
  const tokens = highlightRanges(code, "javascript", hljs).map(range => [range.className, code.slice(range.from, range.to)]);
  assert.deepEqual(tokens, [
    ["hljs-keyword", "const"],
    ["hljs-string", '"<x>"'],
    ["hljs-number", "1"],
    ["hljs-comment", "// hi"]
  ]);
});

test("highlight ranges are empty without a known language or a highlighter", () => {
  const hljs = loadHighlighter();
  assert.deepEqual(highlightRanges("x = 1", "madeup", hljs), []);
  assert.deepEqual(highlightRanges("x = 1", "", hljs), []);
  assert.deepEqual(highlightRanges("x = 1", "python", null), []);
  assert.deepEqual(highlightRanges("", "python", hljs), []);
});

test("highlight ranges are dropped when the output does not spell out the input", () => {
  const highlighter = {
    getLanguage: () => true,
    highlight: () => ({ value: '<span class="hljs-keyword">other</span>' })
  };
  assert.deepEqual(highlightRanges("let", "x", highlighter), []);
});
