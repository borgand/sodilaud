// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createSidebarResizer, readStoredWidth } from "../src/sidebar-resize.js";

function memoryStorage(seed = {}) {
  const items = new Map(Object.entries(seed));
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key)
  };
}

function setup({ side = "left", seed = {}, innerWidth = 1200 } = {}) {
  const dom = new JSDOM(`<!doctype html><div id="row"><aside id="panel"></aside><main id="editor"></main></div>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  Object.defineProperty(dom.window, "innerWidth", { value: innerWidth, configurable: true });
  const panel = document.getElementById("panel");
  if (side === "right") document.getElementById("row").append(panel);
  const storage = memoryStorage(seed);
  const resizer = createSidebarResizer({
    document,
    panel,
    side,
    storage,
    storageKey: "width_key",
    defaultWidth: 240,
    min: 180,
    maxFraction: 0.5,
    label: "Resize the panel"
  });
  const fire = (type, init = {}) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    Object.defineProperty(event, "pointerId", { value: 1 });
    resizer.handle.dispatchEvent(event);
  };
  const key = (name, init = {}) =>
    resizer.handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  return { dom, document, panel, storage, resizer, fire, key };
}

const cssWidth = (panel) => panel.style.getPropertyValue("--sidebar-width");

test("the handle is a focusable vertical separator on the editor side of the panel", () => {
  const left = setup();
  assert.ok(left.panel.nextElementSibling === left.resizer.handle);
  assert.equal(left.resizer.handle.getAttribute("role"), "separator");
  assert.equal(left.resizer.handle.getAttribute("aria-orientation"), "vertical");
  assert.equal(left.resizer.handle.getAttribute("aria-label"), "Resize the panel");
  assert.equal(left.resizer.handle.tabIndex, 0);
  assert.equal(left.resizer.handle.getAttribute("aria-valuenow"), "240");
  assert.equal(left.resizer.handle.getAttribute("aria-valuemin"), "180");
  assert.equal(left.resizer.handle.getAttribute("aria-valuemax"), "600");

  const right = setup({ side: "right" });
  assert.ok(right.panel.previousElementSibling === right.resizer.handle);
});

test("dragging the edge of a left panel widens it and persists on release", () => {
  const { panel, storage, fire } = setup();
  fire("pointerdown", { clientX: 240 });
  fire("pointermove", { clientX: 340 });
  assert.equal(cssWidth(panel), "340px");
  assert.equal(storage.getItem("width_key"), null);
  fire("pointerup", { clientX: 340 });
  assert.equal(storage.getItem("width_key"), "340");
});

test("dragging the edge of a right panel to the left widens it", () => {
  const { panel, storage, fire } = setup({ side: "right" });
  fire("pointerdown", { clientX: 900 });
  fire("pointermove", { clientX: 800 });
  fire("pointerup", { clientX: 800 });
  assert.equal(cssWidth(panel), "340px");
  assert.equal(storage.getItem("width_key"), "340");
});

test("the width stays between the minimum and half the window", () => {
  const { panel, fire } = setup();
  fire("pointerdown", { clientX: 240 });
  fire("pointermove", { clientX: 10 });
  assert.equal(cssWidth(panel), "180px");
  fire("pointermove", { clientX: 1100 });
  assert.equal(cssWidth(panel), "600px");
  fire("pointerup", { clientX: 1100 });
});

test("arrow keys move the edge, Home and End jump to the limits", () => {
  const left = setup();
  left.key("ArrowRight");
  assert.equal(cssWidth(left.panel), "250px");
  left.key("ArrowLeft", { shiftKey: true });
  assert.equal(cssWidth(left.panel), "200px");
  left.key("End");
  assert.equal(left.storage.getItem("width_key"), "600");
  left.key("Home");
  assert.equal(left.resizer.handle.getAttribute("aria-valuenow"), "180");

  const right = setup({ side: "right" });
  right.key("ArrowLeft");
  assert.equal(cssWidth(right.panel), "250px");
});

test("double-click and Enter reset to the default width", () => {
  const { panel, storage, resizer, fire, key } = setup({ seed: { width_key: "400" } });
  assert.equal(cssWidth(panel), "400px");
  fire("dblclick");
  assert.equal(cssWidth(panel), "");
  assert.equal(storage.getItem("width_key"), null);
  assert.equal(resizer.handle.getAttribute("aria-valuenow"), "240");
  key("ArrowRight");
  key("Enter");
  assert.equal(cssWidth(panel), "");
});

test("the handle hides with its panel", async () => {
  const { panel, resizer } = setup();
  panel.hidden = true;
  await Promise.resolve();
  assert.equal(resizer.handle.hidden, true);
  panel.hidden = false;
  await Promise.resolve();
  assert.equal(resizer.handle.hidden, false);
});

test("stored widths below the minimum or unreadable are ignored", () => {
  assert.equal(readStoredWidth("320", 180), 320);
  assert.equal(readStoredWidth("120", 180), null);
  assert.equal(readStoredWidth("wide", 180), null);
  assert.equal(readStoredWidth(null, 180), null);
});
