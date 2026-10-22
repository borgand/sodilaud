// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";
import { PRESET_THEMES } from "../src/preset-themes.js";
import { DOCUMENT_THEME_PROPERTIES, deriveDocumentColors } from "../src/theme-colors.js";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

// The four palette blocks, in stylesheet order: :root (light), the dark media
// query's :root, then the explicit html.theme-light and html.theme-dark.
const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
const palettes = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /^\s*--preview-code-bg:/m.test(body))
  .map(([, selector, body]) => ({
    selector: selector.trim(),
    props: new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
  }));
const [rootLight, mediaDark, themeLight, themeDark] = palettes;

const themeNamed = id => PRESET_THEMES.find(theme => theme.id === id);
const pick = name => [...document.querySelectorAll(".theme-card")]
  .find(card => card.querySelector(".theme-card-name").textContent === name);
const documentValues = () => DOCUMENT_THEME_PROPERTIES.map(
  prop => [prop, document.documentElement.style.getPropertyValue(prop)]
);

await bootMainWindow();

test("the stylesheet has the four palette blocks in the expected order", () => {
  assert.deepEqual(palettes.map(p => p.selector), [":root", ":root", "html.theme-light", "html.theme-dark"]);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^{}]*--preview-code-bg:/);
});

test("no preset shows a Default Dark or Light colour in the document area", () => {
  for (const theme of PRESET_THEMES.filter(t => !t.id.startsWith("default-"))) {
    pick(theme.name).click();
    for (const [prop, value] of documentValues()) {
      assert.ok(value, `${theme.id} sets ${prop}`);
      assert.notEqual(value, themeDark.props.get(prop), `${theme.id} ${prop} leaks Default Dark`);
      assert.notEqual(value, themeLight.props.get(prop), `${theme.id} ${prop} leaks Default Light`);
    }
  }
});

test("Default Dark and Light declare the derived document colours in every palette block", () => {
  const expected = [
    ["default-light", [rootLight, themeLight]],
    ["default-dark", [mediaDark, themeDark]]
  ];
  for (const [id, blocks] of expected) {
    const derived = deriveDocumentColors(themeNamed(id));
    for (const block of blocks) {
      for (const prop of DOCUMENT_THEME_PROPERTIES) {
        assert.equal(block.props.get(prop), derived[prop], `${id} ${block.selector} ${prop}`);
      }
    }
  }
});

test("going back to Default Dark removes every document property from the root", () => {
  pick("Executive").click();
  assert.ok(documentValues().every(([, value]) => value), "Executive sets them all");

  pick("Default Dark").click();
  for (const [prop, value] of documentValues()) assert.equal(value, "", prop);
  pick("Default Light").click();
  for (const [prop, value] of documentValues()) assert.equal(value, "", prop);
});
