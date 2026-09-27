// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { escapeHTML, highlightPreviewCode } from "../src/syntax-highlighting.js";

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
