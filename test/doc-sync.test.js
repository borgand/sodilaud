// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

// One document per path, with the same accept-or-reject rule as the registry.
function authority(texts, applyUpdatesToText) {
  const docs = new Map(Object.entries(texts).map(([path, text]) => [path, { text, updates: [] }]));
  const listeners = [];
  const broadcast = (path, from, updates) => {
    const event = structuredClone({ path, from, updates, version: from + updates.length });
    setTimeout(() => listeners.forEach(listener => listener(event)), 0);
  };
  return {
    docs,
    listen: listener => listeners.push(listener),
    push: async ({ path }, version, updates) => {
      const doc = docs.get(path);
      if (version !== doc.updates.length) return { accepted: false, version: doc.updates.length };
      doc.text = applyUpdatesToText(doc.text, updates);
      doc.updates.push(...structuredClone(updates));
      broadcast(path, version, updates);
      return { accepted: true, version: doc.updates.length };
    },
    pull: async ({ path }, since) => ({ updates: structuredClone(docs.get(path).updates.slice(since)) }),
    outside(path, changes) {
      const doc = docs.get(path);
      const from = doc.updates.length;
      const updates = [{ clientID: "disk", changes }];
      doc.text = applyUpdatesToText(doc.text, updates);
      doc.updates.push(...updates);
      broadcast(path, from, updates);
    }
  };
}

test("a document client keeps local typing through an outside change and reports per document", async () => {
  const env = installEditorDom();
  try {
    const { EditorState, EditorView } = await import("../src/vendor/codemirror.js");
    const { applyUpdatesToText, createDocSync } = await import("../src/doc-sync.js");
    const server = authority({ "/a.md": "one\ntwo\n", "/b.md": "b" }, applyUpdatesToText);
    const sync = createDocSync({
      push: server.push,
      pull: server.pull,
      same: (doc, event) => doc.path === event.path,
      isGone: () => false,
      pushDelay: 5
    });
    server.listen(event => sync.receive(event));
    const view = new EditorView({
      state: EditorState.create({ doc: "one\ntwo\n", extensions: sync.extension({ path: "/a.md" }, 0) }),
      parent: env.document.getElementById("host")
    });
    view.dispatch({ changes: { from: 3, insert: "!" } });
    assert.equal(sync.pending(doc => doc.path === "/a.md"), true);
    assert.equal(sync.pending(doc => doc.path === "/b.md"), false);
    server.outside("/a.md", [8, [0, "three"]]);
    await settle(60);
    assert.equal(await sync.flush(), true);
    await settle();
    assert.equal(server.docs.get("/a.md").text, "one!\ntwo\nthree");
    assert.equal(view.state.doc.toString(), "one!\ntwo\nthree");
    assert.equal(sync.pending(), false);
    view.destroy();
  } finally { env.cleanup(); }
});

test("flush with a filter sends only the picked documents", async () => {
  const env = installEditorDom();
  try {
    const { EditorState, EditorView } = await import("../src/vendor/codemirror.js");
    const { applyUpdatesToText, createDocSync } = await import("../src/doc-sync.js");
    const server = authority({ "/a.md": "a", "/b.md": "b" }, applyUpdatesToText);
    const sync = createDocSync({
      push: server.push,
      pull: server.pull,
      same: (doc, event) => doc.path === event.path,
      isGone: () => false,
      pushDelay: 1000
    });
    const make = (path, text) => new EditorView({
      state: EditorState.create({ doc: text, extensions: sync.extension({ path }, 0) }),
      parent: env.document.getElementById("host")
    });
    const a = make("/a.md", "a");
    const b = make("/b.md", "b");
    a.dispatch({ changes: { from: 1, insert: "1" } });
    b.dispatch({ changes: { from: 1, insert: "2" } });
    assert.equal(await sync.flush(doc => doc.path === "/a.md"), true);
    assert.equal(server.docs.get("/a.md").text, "a1");
    assert.equal(sync.pending(doc => doc.path === "/b.md"), true);
    assert.equal(server.docs.get("/b.md").text, "b");
    assert.equal(await sync.flush(), true);
    assert.equal(server.docs.get("/b.md").text, "b2");
    a.destroy();
    b.destroy();
  } finally { env.cleanup(); }
});
