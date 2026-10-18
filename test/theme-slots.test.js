// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

// The webview accepts any colour form here; var() and url() are rejected by
// isValidColor itself.
globalThis.CSS = { supports: () => true };

const { bootMainWindow } = await import("./helpers/app-harness.js");
const { PRESET_THEMES } = await import("../src/preset-themes.js");
const {
  DOCUMENT_THEME_PROPERTIES,
  contrastRatio,
  deriveDocumentColors,
  mix,
  parseColor,
  toHex
} = await import("../src/theme-colors.js");

const ratio = (a, b) => contrastRatio(parseColor(a), parseColor(b));
const themeNamed = id => PRESET_THEMES.find(theme => theme.id === id);
const base = { background: "#181e21", foreground: "#fdc78e", accent: "#1e959d" };

let importFile;
const app = await bootMainWindow({ handlers: { import_file_native: () => importFile } });
const root = document.documentElement;
const style = prop => root.style.getPropertyValue(prop);
const pick = name => [...document.querySelectorAll(".theme-card")]
  .find(card => card.querySelector(".theme-card-name").textContent === name);
const importTheme = async (title, content) => {
  importFile = { title, content };
  app.click("theme-import-btn");
  await app.settle();
  return app.read("sodilaud_custom_themes").at(-1);
};

test("a slot replaces its derived value and feeds the values that depend on it", () => {
  const c = deriveDocumentColors({ ...base, codeBackground: "#202020", heading: "#f2946c" });
  assert.equal(c["--preview-code-bg"], "#202020");
  assert.equal(c["--preview-heading"], "#f2946c");
  assert.equal(c["--preview-quote-border"], toHex(mix(parseColor("#181e21"), parseColor("#f2946c"), 0.6)));
  assert.ok(ratio(c["--syntax-code"], "#202020") >= 4.5);
});

test("a low-contrast heading slot is floored to 4.5:1", () => {
  const c = deriveDocumentColors({ ...base, heading: "#1a2024" });
  assert.notEqual(c["--preview-heading"], "#1a2024");
  assert.ok(ratio(c["--preview-heading"], "#181e21") >= 4.5);
});

test("surface slots are used verbatim, and unmeasurable themes honour slots too", () => {
  const c = deriveDocumentColors({ ...base, tableBorder: "rgb(1 2 3)", rule: "#abc" });
  assert.equal(c["--preview-table-border"], "rgb(1 2 3)");
  assert.equal(c["--preview-hr"], "#abc");

  const u = deriveDocumentColors({ background: "rgb(10 10 10)", foreground: "rgb(240 240 240)", codeBackground: "#202020", link: "#ff8800" });
  assert.equal(u["--preview-code-bg"], "#202020");
  assert.equal(u["--preview-link"], "#ff8800");
  assert.match(u["--preview-code-border"], /^color-mix\(.*#202020/);
});

test("JSON import keeps valid slots and drops invalid ones", async () => {
  const saved = await importTheme("s.json", JSON.stringify({
    name: "S", background: "#111111", foreground: "#eeeeee",
    heading: "#ff8800", codeBackground: "url(x)", tableBorder: "var(--x)", rule: "#333333"
  }));
  assert.equal(saved.heading, "#ff8800");
  assert.equal(saved.rule, "#333333");
  assert.equal("codeBackground" in saved, false);
  assert.equal("tableBorder" in saved, false);
});

// The key-value parser treats '#' as a comment start, so hex values cannot be
// written in a TOML theme; rgb() carries the colours here.
test("TOML import accepts lowercase and snake_case slot names", async () => {
  const saved = await importTheme("t.toml", [
    'name = "T"', 'background = "rgb(17, 17, 17)"', 'foreground = "rgb(238, 238, 238)"',
    'code_background = "rgb(34, 34, 34)"', 'tableheaderbackground = "rgb(51, 51, 51)"', 'rule = "var(--x)"'
  ].join("\n"));
  assert.equal(saved.codeBackground, "rgb(34, 34, 34)");
  assert.equal(saved.tableHeaderBackground, "rgb(51, 51, 51)");
  assert.equal("rule" in saved, false);
});

test("export writes the slots the active theme sets", async () => {
  let blob;
  const windowUrl = app.dom.window.URL;
  const original = windowUrl.createObjectURL;
  const originalRevoke = windowUrl.revokeObjectURL;
  const originalClick = app.dom.window.HTMLAnchorElement.prototype.click;
  windowUrl.createObjectURL = b => { blob = b; return "blob:test"; };
  windowUrl.revokeObjectURL = () => {};
  app.dom.window.HTMLAnchorElement.prototype.click = () => {};
  const read = () => new Promise(resolve => {
    const reader = new app.dom.window.FileReader();
    reader.onload = () => resolve(JSON.parse(reader.result));
    reader.readAsText(blob);
  });
  try {
    pick("Executive").click();
    app.click("theme-export-btn");
    const exec = await read();
    assert.equal(exec.heading, "#f2946c");
    assert.equal(exec.codeBackground, "#1f2629");
    assert.equal(exec.rule, "#3a4346");

    pick("Nord").click();
    app.click("theme-export-btn");
    const nord = await read();
    for (const slot of ["heading", "codeBackground", "codeBorder", "tableHeaderBackground", "tableBorder", "rule", "mutedText", "link"]) {
      assert.equal(slot in nord, false, slot);
    }
  } finally {
    windowUrl.createObjectURL = original;
    windowUrl.revokeObjectURL = originalRevoke;
    app.dom.window.HTMLAnchorElement.prototype.click = originalClick;
  }
});

test("switching from Executive to Nord leaves no Executive slot value behind", () => {
  pick("Executive").click();
  assert.equal(style("--preview-heading"), "#f2946c");

  pick("Nord").click();
  const expected = deriveDocumentColors(themeNamed("nord"));
  for (const prop of DOCUMENT_THEME_PROPERTIES) assert.equal(style(prop), expected[prop], prop);
});

test("a mutedText slot sets --text-muted, floored against the sidebar", async () => {
  await importTheme("m.json", JSON.stringify({
    name: "Muted", background: "#181e21", foreground: "#fdc78e", sidebar: "#242e2e", mutedText: "#2a3234"
  }));
  pick("Muted").click();
  const muted = style("--text-muted");
  assert.notEqual(muted, "#2a3234");
  assert.ok(ratio(muted, "#181e21") >= 4.5);
  assert.ok(ratio(muted, "#242e2e") >= 4.5);

  await importTheme("m2.json", JSON.stringify({
    name: "Muted OK", background: "#181e21", foreground: "#fdc78e", sidebar: "#242e2e", mutedText: "#a0b0b4"
  }));
  pick("Muted OK").click();
  assert.equal(style("--text-muted"), "#a0b0b4");

  pick("Nord").click();
  assert.notEqual(style("--text-muted"), "#a0b0b4");
});

test("Executive headings are warm and its table header is neutral", () => {
  const exec = themeNamed("executive");
  assert.equal(exec.heading, "#f2946c");
  assert.equal(exec.tableHeaderBackground, "#222a2d");
});
