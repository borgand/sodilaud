// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";

// CSS.supports("color", "var(--x)") is true in the webview because var() is
// validated only at computed-value time. Model that permissive answer so the
// check under test is isValidColor's own, not the stub's.
globalThis.CSS = { supports: () => true };
const { isValidColor } = await import("../src/theme-colors.js");
const { escapeHTML } = await import("../src/syntax-highlighting.js");

test("functional and url values are rejected as colours", () => {
  for (const bad of ["var(--x)", "url(https://example.test/p)", "image-set(x)", "attr(data-bg)", "red;padding:0"]) {
    assert.equal(isValidColor(bad), false, `${bad} must not be accepted`);
  }
});

test("real colours still pass", () => {
  for (const good of ["#fff", "#ffffff", "rgb(1 2 3)", "hsl(120 50% 50%)", "rebeccapurple"]) {
    assert.equal(isValidColor(good), true, `${good} must still be accepted`);
  }
});

test("an imported theme with a non-string name falls back to the file name", async () => {
  const { bootApp } = await import("./helpers/app-harness.js");
  const app = await bootApp({
    handlers: {
      import_file_native: () => ({
        title: "numbered_theme.json",
        content: JSON.stringify({ name: 5, background: "#101010", foreground: "#f0f0f0" })
      })
    }
  });
  app.click("theme-import-btn");
  await app.settle();

  const saved = app.read("scratchpad_custom_themes");
  assert.equal(saved.at(-1).name, "numbered theme");
});

test("escaping a non-string value does not throw", () => {
  assert.equal(escapeHTML(5), "5");
  assert.equal(escapeHTML(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;");
});
