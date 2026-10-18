// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bootApp, bootMainWindow } from "./helpers/app-harness.js";

const storage = {
  sodilaud_editor_zoom: "1.2",
  sodilaud_editor_line_spacing: "1.8",
  sodilaud_note_preview_lines: "2",
  sodilaud_syntax_highlighting: "true",
  sodilaud_editor_line_numbers: "true",
  sodilaud_notes: [{
    id: "preview-note",
    title: "Preview note",
    content: "# First detail\nSecond detail\nThird detail",
    updatedAt: 1,
    isTitleLocked: true
  }]
};

test("the main window's appearance settings are adjustable, persistent and shared", async () => {
  const app = await bootMainWindow({ storage });
  const root = document.documentElement;
  const actionsDropdown = document.getElementById("actions-dropdown-content");
  assert.deepEqual(
    [...document.querySelectorAll("#actions-dropdown-content > .dropdown-section > .dropdown-section-title")]
      .map(label => label.textContent),
    ["File", "Appearance", "Quick Notes", "Agent access", "Clipboard history", "Help"]
  );
  assert.equal(document.getElementById("theme-picker-btn").firstElementChild.textContent, "Color theme");
  assert.equal(document.getElementById("active-theme-menu-value").textContent, "Executive");
  assert.equal(document.getElementById("help-menu-btn").textContent, "Help & reference");
  assert.equal(document.getElementById("about-menu-btn").firstChild.textContent.trim(), "About Sodilaud");
  assert.equal(document.getElementById("actions-btn").getAttribute("aria-label"), "Open Sodilaud menu");
  assert.deepEqual(
    [...document.querySelectorAll("#view-settings .view-setting-label")].map(label => label.textContent),
    ["Editor zoom", "Line spacing", "Paragraph spacing", "Readable width", "Body font", "Heading font", "Code font", "Syntax highlighting", "Line numbers"]
  );
  assert.equal(root.style.getPropertyValue("zoom"), "", "the application UI is not scaled");
  assert.equal(root.style.getPropertyValue("--editor-font-size"), "1.2rem");
  assert.equal(root.style.getPropertyValue("--editor-line-height"), "1.8");
  assert.equal(document.getElementById("zoom-reset-btn").textContent, "120%");
  assert.equal(document.getElementById("line-spacing-value").textContent, "1.8×");
  assert.equal(document.getElementById("syntax-highlighting-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("line-numbers-toggle").textContent, "On");

  document.getElementById("actions-btn").click();
  document.getElementById("zoom-in-btn").click();
  document.getElementById("line-spacing-increase-btn").click();
  document.getElementById("syntax-highlighting-toggle").click();
  document.getElementById("line-numbers-toggle").click();

  assert.equal(actionsDropdown.classList.contains("show"), true, "view controls keep the menu open");
  assert.equal(root.style.getPropertyValue("--editor-font-size"), "1.3rem");
  assert.equal(root.style.getPropertyValue("--editor-line-height"), "1.9");
  assert.equal(app.storage.getItem("sodilaud_editor_zoom"), "1.3");
  assert.equal(app.storage.getItem("sodilaud_editor_line_spacing"), "1.9");
  assert.equal(app.storage.getItem("sodilaud_syntax_highlighting"), "false");
  assert.equal(app.storage.getItem("sodilaud_editor_line_numbers"), "false");
  assert.equal(document.getElementById("line-numbers-toggle").textContent, "Off");
  assert.equal(root.classList.contains("editor-line-numbers-enabled"), false);
  await app.settle();
  assert.deepEqual(
    app.emitted.filter(event => event.name === "prefs-changed").map(event => event.payload.key),
    ["sodilaud_editor_zoom", "sodilaud_editor_line_spacing", "sodilaud_syntax_highlighting", "sodilaud_editor_line_numbers"]
  );

  const zoomOutEvent = new app.dom.window.KeyboardEvent("keydown", { key: "-", ctrlKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(zoomOutEvent);
  assert.equal(zoomOutEvent.defaultPrevented, true);
  assert.equal(root.style.getPropertyValue("--editor-font-size"), "1.2rem");

  document.getElementById("zoom-reset-btn").click();
  assert.equal(app.storage.getItem("sodilaud_editor_zoom"), "1");
  document.getElementById("line-spacing-value").click();
  assert.equal(app.storage.getItem("sodilaud_editor_line_spacing"), "1.7");

  document.getElementById("theme-picker-btn").click();
  document.querySelector('[aria-label="Use Default Light theme"]').click();
  assert.equal(document.getElementById("active-theme-menu-value").textContent, "Default Light");
});

test("paragraph spacing is adjustable, persistent and shared", async () => {
  const app = await bootMainWindow({ storage, instance: 3 });
  const root = document.documentElement;
  const value = document.getElementById("paragraph-spacing-value");
  assert.equal(root.style.getPropertyValue("--paragraph-spacing"), "1");
  assert.equal(value.textContent, "1.0×");

  document.getElementById("actions-btn").click();
  document.getElementById("paragraph-spacing-increase-btn").click();
  assert.equal(root.style.getPropertyValue("--paragraph-spacing"), "1.1");
  assert.equal(value.textContent, "1.1×");
  assert.equal(app.storage.getItem("sodilaud_paragraph_spacing"), "1.1");
  await app.settle();
  assert.ok(app.emitted.some(event => event.name === "prefs-changed" && event.payload.key === "sodilaud_paragraph_spacing"));

  value.click();
  assert.equal(value.textContent, "1.0×");
  assert.equal(app.storage.getItem("sodilaud_paragraph_spacing"), "1");

  for (let index = 0; index < 8; index += 1) document.getElementById("paragraph-spacing-decrease-btn").click();
  assert.equal(value.textContent, "0.5×");
  assert.equal(document.getElementById("paragraph-spacing-decrease-btn").disabled, true);
});

test("readable width is on by default and can be turned off and resized", async () => {
  const app = await bootMainWindow({ storage, instance: 5 });
  const root = document.documentElement;
  const value = document.getElementById("content-width-value");
  const toggle = document.getElementById("readable-width-toggle");
  assert.equal(root.classList.contains("readable-width"), true);
  assert.equal(root.style.getPropertyValue("--content-width"), "80ch");
  assert.equal(value.textContent, "80ch");
  assert.equal(toggle.textContent, "On");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");

  document.getElementById("actions-btn").click();
  document.getElementById("content-width-increase-btn").click();
  assert.equal(value.textContent, "85ch");
  assert.equal(root.style.getPropertyValue("--content-width"), "85ch");
  assert.equal(app.storage.getItem("sodilaud_content_width"), "85");
  await app.settle();
  assert.ok(app.emitted.some(event => event.name === "prefs-changed" && event.payload.key === "sodilaud_content_width"));

  toggle.click();
  assert.equal(root.classList.contains("readable-width"), false);
  assert.equal(toggle.textContent, "Off");
  assert.equal(document.getElementById("content-width-decrease-btn").disabled, true);
  assert.equal(document.getElementById("content-width-increase-btn").disabled, true);
  assert.equal(app.storage.getItem("sodilaud_readable_width"), "false");
  await app.settle();
  assert.ok(app.emitted.some(event => event.name === "prefs-changed" && event.payload.key === "sodilaud_readable_width"));
});

test("Quick Notes follows readable width changed in the main window", async () => {
  const app = await bootApp({ storage, instance: 6 });
  const root = document.documentElement;
  assert.equal(root.classList.contains("readable-width"), true);
  app.storage.setItem("sodilaud_content_width", "100");
  await app.emit("prefs-changed", { key: "sodilaud_content_width", source: "main" });
  assert.equal(root.style.getPropertyValue("--content-width"), "100ch");
  app.storage.setItem("sodilaud_readable_width", "false");
  await app.emit("prefs-changed", { key: "sodilaud_readable_width", source: "main" });
  assert.equal(root.classList.contains("readable-width"), false);
});

test("Quick Notes follows paragraph spacing changed in the main window", async () => {
  const app = await bootApp({ storage, instance: 4 });
  const root = document.documentElement;
  assert.equal(root.style.getPropertyValue("--paragraph-spacing"), "1");
  app.storage.setItem("sodilaud_paragraph_spacing", "1.4");
  await app.emit("prefs-changed", { key: "sodilaud_paragraph_spacing", source: "main" });
  assert.equal(root.style.getPropertyValue("--paragraph-spacing"), "1.4");
});

test("Quick Notes applies the shared settings and keeps its own preview lines", async () => {
  const app = await bootApp({ storage, instance: 2 });
  const root = document.documentElement;
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.deepEqual(
    [...document.querySelectorAll("#actions-dropdown-content > .dropdown-section > .dropdown-section-title")]
      .map(label => label.textContent),
    ["Workspace", "Note", "Sidebar", "Agent access", "Sodilaud"]
  );
  assert.equal(document.getElementById("workspace-menu-value").textContent, "Local notes");
  assert.equal(document.getElementById("copy-html").textContent, "Copy rendered HTML");
  assert.equal(document.getElementById("import-btn").textContent, "Import text file");
  assert.equal(document.getElementById("export-btn").textContent, "Export Markdown file");
  assert.equal(document.getElementById("db-connect-btn").textContent, "Open workspace");
  assert.equal(document.getElementById("mcp-permissions-summary").textContent, "Off");
  assert.equal(document.getElementById("agent-access-toggle-btn").textContent, "Off");
  assert.equal(document.getElementById("agent-access-config-btn").textContent, "MCP Configuration…");
  assert.equal(document.getElementById("settings-menu-btn").textContent, "Settings…");
  assert.equal(document.getElementById("theme-picker-btn"), null, "themes are chosen in the main window");
  assert.equal(document.getElementById("zoom-in-btn"), null, "zoom is set in the main window");
  assert.match(
    styles,
    /\.editor-host \.cm-editor \.cm-content\s*\{[^}]*font-size:\s*var\(--editor-font-size\)[^}]*line-height:\s*var\(--editor-line-height\)/s
  );
  assert.equal(root.style.getPropertyValue("--editor-font-size"), "1.2rem");
  assert.equal(root.style.getPropertyValue("--editor-line-height"), "1.8");
  assert.equal(root.style.getPropertyValue("--note-preview-lines"), "2");
  assert.ok(document.querySelector("#editor-host .cm-content .syntax-heading"), "headings are highlighted");
  assert.equal(root.classList.contains("editor-line-numbers-enabled"), true);
  assert.ok(document.querySelector("#editor-host .cm-lineNumbers"));
  assert.ok(document.querySelector("#secondary-editor-host .cm-lineNumbers"));
  assert.deepEqual(
    [...document.querySelectorAll("#editor-host .cm-lineNumbers .cm-gutterElement")]
      .filter(element => element.style.visibility !== "hidden")
      .map(element => element.textContent),
    ["1", "2", "3"]
  );
  assert.equal(document.querySelector(".note-item-snippet").textContent, "First detail\nSecond detail");

  // The main window turned line numbers and highlighting off and zoomed in.
  app.storage.setItem("sodilaud_editor_line_numbers", "false");
  app.storage.setItem("sodilaud_syntax_highlighting", "false");
  app.storage.setItem("sodilaud_editor_zoom", "1.5");
  for (const key of ["sodilaud_editor_line_numbers", "sodilaud_syntax_highlighting", "sodilaud_editor_zoom"]) {
    await app.emit("prefs-changed", { key, source: "main" });
  }
  assert.equal(document.querySelector("#editor-host .cm-lineNumbers"), null);
  assert.equal(document.querySelector("#secondary-editor-host .cm-lineNumbers"), null);
  assert.equal(document.querySelector("#editor-host .cm-content .syntax-heading"), null);
  assert.equal(root.style.getPropertyValue("--editor-font-size"), "1.5rem");

  document.getElementById("actions-btn").click();
  document.getElementById("preview-lines-increase-btn").click();
  assert.equal(app.storage.getItem("sodilaud_note_preview_lines"), "3");
  assert.equal(document.querySelector(".note-item-snippet").textContent, "First detail\nSecond detail\nThird detail");
  for (let index = 0; index < 12; index += 1) {
    document.getElementById("preview-lines-increase-btn").click();
  }
  assert.equal(document.getElementById("preview-lines-value").textContent, "10");
  assert.equal(document.getElementById("preview-lines-increase-btn").disabled, true);
  document.getElementById("preview-lines-value").click();
  assert.equal(root.style.getPropertyValue("--note-preview-lines"), "2");

  // Zooming from the keyboard in Quick Notes is shared back.
  const zoomIn = new app.dom.window.KeyboardEvent("keydown", { key: "=", metaKey: true, bubbles: true, cancelable: true });
  document.dispatchEvent(zoomIn);
  assert.equal(app.storage.getItem("sodilaud_editor_zoom"), "1.6");
  await app.settle();
  assert.ok(app.emitted.some(event => event.name === "prefs-changed" && event.payload.key === "sodilaud_editor_zoom"));
});
