// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

globalThis.CSS = { supports: () => true };

const { bootApp, bootMainWindow } = await import("./helpers/app-harness.js");
const { normalizeFontValue, resolveFonts } = await import("../src/document-fonts.js");

test("font values normalize per slot", () => {
  assert.equal(normalizeFontValue("ibm-plex-mono", "body"), "ibm-plex-mono");
  assert.equal(normalizeFontValue("ibm-plex-serif", "code"), "");
  assert.equal(normalizeFontValue("system:  Iosevka Term ", "code"), "system:Iosevka Term");
  for (const bad of ['system:Evil"; }', "system:url(x)", "system:a{b}", "system:", "comic"])
    assert.equal(normalizeFontValue(bad, "body"), "", bad);
});

test("fonts resolve user over theme over default, heading follows body", () => {
  const f = resolveFonts({ body: "ibm-plex-serif", heading: "", code: "" }, { fontCode: "ibm-plex-mono" });
  assert.match(f.body, /^'IBM Plex Serif'/);
  assert.equal(f.heading, f.body);
  assert.match(f.code, /^'IBM Plex Mono'/);
  assert.match(resolveFonts({ body: "", heading: "", code: "system:Iosevka" }).code, /^"Iosevka", 'JetBrains Mono'/);
});

test("a theme's font value cannot inject CSS into a stack", () => {
  const f = resolveFonts({}, { fontBody: 'system:x"; }', fontCode: "ibm-plex-serif" });
  assert.match(f.body, /^'Inter'/);
  assert.match(f.code, /^'JetBrains Mono'/);
});

test("choosing a font sets the root stacks, persists and reaches Quick Notes", async () => {
  const main = await bootMainWindow({ instance: 10 });
  const select = document.getElementById("font-body-select");
  assert.equal(select.options[0].textContent, "Theme default (Inter)");
  assert.deepEqual([...select.options].map(o => o.value), ["", "inter", "ibm-plex-serif", "jetbrains-mono", "ibm-plex-mono", "system"]);
  assert.deepEqual([...document.getElementById("font-code-select").options].map(o => o.value), ["", "jetbrains-mono", "ibm-plex-mono", "system"]);
  assert.equal(document.getElementById("font-heading-select").options[0].textContent, "Theme default (same as body)");

  select.value = "ibm-plex-mono";
  select.dispatchEvent(new main.dom.window.Event("change", { bubbles: true }));
  const root = document.documentElement;
  assert.match(root.style.getPropertyValue("--doc-font-body"), /^'IBM Plex Mono'/);
  assert.equal(main.storage.getItem("sodilaud_font_body"), "ibm-plex-mono");
  await main.settle();
  assert.ok(main.emitted.some(e => e.name === "prefs-changed" && e.payload.key === "sodilaud_font_body"));

  const quick = await bootApp({ instance: 11, storage: { sodilaud_font_body: "ibm-plex-mono" } });
  assert.match(document.documentElement.style.getPropertyValue("--doc-font-body"), /^'IBM Plex Mono'/);
  quick.storage.setItem("sodilaud_font_code", "system:Iosevka");
  await quick.emit("prefs-changed", { key: "sodilaud_font_code", source: "main" });
  assert.match(document.documentElement.style.getPropertyValue("--doc-font-code"), /^"Iosevka", 'JetBrains Mono'/);
});

test("an invalid system font name is not stored", async () => {
  const app = await bootMainWindow({ instance: 12 });
  const root = document.documentElement;
  const select = document.getElementById("font-body-select");
  const field = document.getElementById("font-body-system");
  const before = root.style.getPropertyValue("--doc-font-body");
  assert.equal(field.hidden, true);

  select.value = "system";
  select.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  assert.equal(field.hidden, false);
  assert.equal(document.activeElement, field);

  field.value = 'X"; color: red';
  field.dispatchEvent(new app.dom.window.Event("blur"));
  assert.equal(app.storage.getItem("sodilaud_font_body"), null);
  assert.equal(field.getAttribute("aria-invalid"), "true");
  assert.equal(root.style.getPropertyValue("--doc-font-body"), before);

  field.value = "Iosevka";
  field.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(app.storage.getItem("sodilaud_font_body"), "system:Iosevka");
  assert.equal(field.hasAttribute("aria-invalid"), false);
  assert.match(root.style.getPropertyValue("--doc-font-body"), /^"Iosevka", 'Inter'/);
});

test("committing an unchanged system font name does not store or broadcast again", async () => {
  const app = await bootMainWindow({ instance: 14 });
  const select = document.getElementById("font-body-select");
  const field = document.getElementById("font-body-system");
  select.value = "system";
  select.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  field.value = "Iosevka";
  field.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await app.settle();
  const count = () => app.emitted.filter(e => e.name === "prefs-changed" && e.payload.key === "sodilaud_font_body").length;
  assert.equal(count(), 1);
  field.dispatchEvent(new app.dom.window.Event("blur"));
  await app.settle();
  assert.equal(count(), 1);
  assert.equal(app.storage.getItem("sodilaud_font_body"), "system:Iosevka");
});

test("a theme's font suggestion applies until the user picks a font", async () => {
  let importFile;
  const app = await bootMainWindow({ instance: 13, handlers: { import_file_native: () => importFile } });
  const root = document.documentElement;
  const heading = () => root.style.getPropertyValue("--doc-font-heading");
  importFile = {
    title: "serif.json",
    content: JSON.stringify({ name: "Serif", background: "#111111", foreground: "#eeeeee", fontHeading: "ibm-plex-serif", fontCode: 'system:x"; }' })
  };
  app.click("theme-import-btn");
  await app.settle();
  const saved = app.read("sodilaud_custom_themes").at(-1);
  assert.equal(saved.fontHeading, "ibm-plex-serif");
  assert.equal("fontCode" in saved, false);

  [...document.querySelectorAll(".theme-card")].find(c => c.querySelector(".theme-card-name").textContent === "Serif").click();
  assert.match(heading(), /^'IBM Plex Serif'/);
  assert.equal(document.getElementById("font-heading-select").options[0].textContent, "Theme default (IBM Plex Serif)");

  const select = document.getElementById("font-heading-select");
  select.value = "inter";
  select.dispatchEvent(new app.dom.window.Event("change", { bubbles: true }));
  assert.match(heading(), /^'Inter'/);

  let blob;
  const windowUrl = app.dom.window.URL;
  windowUrl.createObjectURL = b => { blob = b; return "blob:test"; };
  windowUrl.revokeObjectURL = () => {};
  app.dom.window.HTMLAnchorElement.prototype.click = () => {};
  app.click("theme-export-btn");
  const exported = JSON.parse(await new Promise(resolve => {
    const reader = new app.dom.window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  }));
  assert.equal(exported.fontHeading, "ibm-plex-serif");
});
