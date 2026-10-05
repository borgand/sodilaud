// SPDX-License-Identifier: GPL-3.0-or-later

// Boots the real frontend against notes.html with a stubbed Tauri bridge.
//
// notes.js holds module-level state and runs its start-up sequence on import, so
// a process can only boot the app once: give every start-up scenario its own
// test file. Nothing here runs until bootApp is called.

import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as Diff from "diff";
import { polyfillLayout } from "./cm-dom.js";

export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// `storage` seeds local storage before boot; `handlers` maps a Tauri command to
// the value it should resolve with, or throws to simulate a failing command.
// `instance` gives the module a distinct URL so a single process can boot the
// app more than once, which is what a two-launch test needs. `globals` installs
// globals jsdom does not implement -- `CSS.supports`, say, which the app uses to
// validate imported theme colours. `beforeBoot(dom)` runs just before notes.js
// loads, to break a browser or Tauri API the app relies on.
export function bootApp(options = {}) {
  return bootPage({ ...options, page: "notes.html", script: "notes.js", label: "quicknotes" });
}

// The main window: start page, Sodilaud menu and file editor.
export function bootMainWindow(options = {}) {
  return bootPage({ ...options, page: "index.html", script: "app.js", label: "main" });
}

// `registry` seeds the fake Rust notes registry: `{ seed, files, open, fallback }`
// (see fake-registry.js). Unless `seed.imported` is set, the page imports what
// `storage` holds under the old local-storage keys, as a first launch of 0.11 does.
// `disk` seeds the fake file registry (fake-file-docs.js): file text by path.
async function bootPage({ page, script, label, storage = {}, handlers = {}, registry: registryOptions = {}, disk = {}, instance = 1, windowApi = {}, globals = {}, platform, beforeBoot } = {}) {
  const html = await readFile(new URL(`../../src/${page}`, import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });

  if (platform) {
    Object.defineProperty(dom.window.navigator, "platform", { value: platform, configurable: true });
  }

  const eventListeners = new Map();
  let registry;
  let fileDocs;

  const invocations = [];
  async function invoke(command, args) {
    invocations.push({ command, args });
    const handler = handlers[command];
    if (typeof handler === "function") return handler(args);
    // Comment commands exist for notes and files alike; each window has its own.
    const [first, second] = label === "main" ? [fileDocs, registry] : [registry, fileDocs];
    const fake = first.commands[command] ?? second.commands[command];
    if (fake) return structuredClone(fake(structuredClone(args ?? {})) ?? null);
    return null;
  }

  const emitted = [];
  dom.window.__TAURI__ = {
    core: { invoke },
    window: { getCurrentWindow: () => ({ label, onCloseRequested: async () => () => {} }), ...windowApi },
    event: {
      listen: async (name, handler) => {
        eventListeners.set(name, handler);
        return () => eventListeners.delete(name);
      },
      emit: async (name, payload) => { emitted.push({ name, payload }); }
    }
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

  // notes.js reads these as bare globals, so they have to land on globalThis as
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
  // CodeMirror reads navigator.platform once, when its module first loads, to
  // pick Cmd or Ctrl for Mod. Load it, and the fake registry that imports it,
  // only after the booted navigator is in place, or it reports the host OS
  // instead of the `platform` asked for.
  const { EditorView } = await import("../../src/vendor/codemirror.js");
  const { createFakeRegistry } = await import("./fake-registry.js");
  const { createFakeFileDocs } = await import("./fake-file-docs.js");
  // Tauri delivers events asynchronously, after the command that caused them.
  const deliver = (name, payload) => setTimeout(() => eventListeners.get(name)?.({ payload: structuredClone(payload) }), 0);
  registry = createFakeRegistry({ ...registryOptions, emit: deliver });
  fileDocs = createFakeFileDocs({ disk, emit: deliver });
  await import(`${new URL(`../../src/${script}`, import.meta.url).href}?boot=${instance}`);
  await settle();

  const editor = (pane = "primary") => EditorView.findFromDOM(dom.window.document.querySelector(
    pane === "primary" ? "#editor-host .cm-editor" : "#secondary-editor-host .cm-editor"
  ));

  return {
    dom,
    emit: (name, payload) => eventListeners.get(name)?.({ payload }),
    emitted,
    invocations,
    registry,
    fileDocs,
    // What Rust has saved, once pending writes and events have settled.
    savedNotes: async () => {
      await settle();
      return registry.workspace().notes.map(({ updates, version, rev, ...note }) => note);
    },
    savedFolders: async () => {
      await settle();
      return registry.workspace().folders.map(({ rev, ...folder }) => folder);
    },
    savedTrash: async () => {
      await settle();
      return registry.workspace().trash;
    },
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
