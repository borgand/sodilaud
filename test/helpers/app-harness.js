// SPDX-License-Identifier: GPL-3.0-or-later

// Boots the real frontend against index.html with a stubbed Tauri bridge.
//
// main.js holds module-level state and runs its start-up sequence on import, so
// a process can only boot the app once: give every start-up scenario its own
// test file. Nothing here runs until bootApp is called.

import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as Diff from "diff";
import { polyfillLayout } from "./cm-dom.js";
import { EditorView } from "../../src/vendor/codemirror.js";

export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// `storage` seeds local storage before boot; `handlers` maps a Tauri command to
// the value it should resolve with, or throws to simulate a failing command.
// `instance` gives the module a distinct URL so a single process can boot the
// app more than once, which is what a two-launch test needs. `globals` installs
// globals jsdom does not implement -- `CSS.supports`, say, which the app uses to
// validate imported theme colours. `beforeBoot(dom)` runs just before main.js
// loads, to break a browser or Tauri API the app relies on.
export async function bootApp({ storage = {}, handlers = {}, instance = 1, windowApi = {}, globals = {}, platform, beforeBoot } = {}) {
  const html = await readFile(new URL("../../src/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });

  if (platform) {
    Object.defineProperty(dom.window.navigator, "platform", { value: platform, configurable: true });
  }

  const invocations = [];
  async function invoke(command, args) {
    invocations.push({ command, args });
    const handler = handlers[command];
    if (typeof handler === "function") return handler(args);
    if (command === "load_db_folders" || command === "load_db_trash") return [];
    return null;
  }

  const eventListeners = new Map();
  dom.window.__TAURI__ = {
    core: { invoke }, window: windowApi,
    event: { listen: async (name, handler) => {
      eventListeners.set(name, handler);
      return () => eventListeners.delete(name);
    } }
  };
  dom.window.Diff = Diff;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  // CodeMirror reads these as bare globals.
  for (const name of ["MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "Window"]) {
    globalThis[name] = dom.window[name];
  }
  polyfillLayout(dom.window);
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true
  });

  // main.js reads these as bare globals, so they have to land on globalThis as
  // well as on the window the app sees.
  Object.entries(globals).forEach(([name, value]) => {
    dom.window[name] = value;
    globalThis[name] = value;
  });

  Object.entries(storage).forEach(([key, value]) => {
    dom.window.localStorage.setItem(
      key,
      typeof value === "string" ? value : JSON.stringify(value)
    );
  });

  beforeBoot?.(dom);
  await import(`${new URL("../../src/main.js", import.meta.url).href}?boot=${instance}`);
  await settle();

  const editor = (pane = "primary") => EditorView.findFromDOM(dom.window.document.querySelector(
    pane === "primary" ? "#editor-host .cm-editor" : "#secondary-editor-host .cm-editor"
  ));

  return {
    dom,
    emit: (name, payload) => eventListeners.get(name)?.({ payload }),
    invocations,
    settle,
    storage: dom.window.localStorage,
    // Everything local storage holds, ready to seed the next launch.
    dumpStorage: () => {
      const contents = {};
      for (let index = 0; index < dom.window.localStorage.length; index += 1) {
        const key = dom.window.localStorage.key(index);
        contents[key] = dom.window.localStorage.getItem(key);
      }
      return contents;
    },
    editor,
    editorText: (pane = "primary") => editor(pane).state.doc.toString(),
    type: async (text) => {
      const view = editor();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
      await settle(600);
    },
    read: (key) => {
      const raw = dom.window.localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    },
    click: (id) => dom.window.document.getElementById(id).click(),
    sidebarTitles: () =>
      [...dom.window.document.querySelectorAll(".note-item-title")]
        .map((element) => element.textContent)
  };
}
