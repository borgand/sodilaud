// SPDX-License-Identifier: GPL-3.0-or-later

import { JSDOM } from "jsdom";

// jsdom has no layout. CM6 measures through Range rects, so give it empty ones.
export function polyfillLayout(window) {
  const rects = () => Object.assign([], { item: () => null });
  const box = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  window.Range.prototype.getClientRects = rects;
  window.Range.prototype.getBoundingClientRect = box;
  window.document.elementFromPoint ??= () => null;
}

export function installEditorDom(html = "<!doctype html><div id=host></div>") {
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  polyfillLayout(dom.window);
  const saved = {};
  for (const name of ["window", "document", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "KeyboardEvent", "ClipboardEvent", "Event", "MouseEvent"]) {
    saved[name] = globalThis[name];
    globalThis[name] = name === "window" ? dom.window : name === "document" ? dom.window.document : dom.window[name];
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  return {
    dom, window: dom.window, document: dom.window.document,
    cleanup() { Object.entries(saved).forEach(([k, v]) => { globalThis[k] = v; }); dom.window.close(); }
  };
}
