// SPDX-License-Identifier: GPL-3.0-or-later

// A stand-in for the file half of the Rust registry (src-tauri/src/docs/files.rs),
// so page tests run the real collab protocol for files. It keeps the same rules
// in a simpler form: an outside edit to a clean file is applied, and a test says
// what a merge of an edited file produces. The Rust tests cover the merge itself.

import { applyUpdatesToText } from "../../src/doc-sync.js";

export const SAVE_DELAY_MS = 400;

const name = (path) => path.split("/").pop();

// One replacement between the common prefix and suffix, in UTF-16 units.
function minimalChanges(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  const inserted = after.slice(start, after.length - end);
  const parts = [];
  if (start > 0) parts.push(start);
  parts.push(inserted ? [before.length - start - end, ...inserted.split("\n")] : [before.length - start - end]);
  if (end > 0) parts.push(end);
  return parts;
}

/**
 * @param {object} options
 * @param {(name: string, payload: unknown) => void} options.emit
 * @param {Record<string, string>} [options.disk] file text by path
 */
export function createFakeFileDocs({ emit, disk = {} }) {
  const files = new Map(Object.entries(disk));
  const docs = new Map();
  const writes = [];
  let failure = null;
  let opening = 0;
  const version = (doc) => doc.updates.length;

  const find = (path, docId) => {
    const doc = docs.get(path);
    if (!doc || (docId !== undefined && doc.docId !== docId)) throw { code: "NotOpen", message: `${name(path)} is not open in Sodilaud.` };
    return doc;
  };
  const savedEvent = (path, doc) => ({ docId: doc.docId, path, version: doc.savedVersion, hash: `h-${doc.synced.length}`, error: doc.error });

  function schedule(path, doc) {
    clearTimeout(doc.timer);
    doc.timer = setTimeout(() => {
      try { save(path); } catch { /* reported by the saved event */ }
    }, SAVE_DELAY_MS);
  }

  function save(path) {
    const doc = find(path);
    clearTimeout(doc.timer);
    if (doc.external || version(doc) === doc.savedVersion) return savedEvent(path, doc);
    if (failure) {
      doc.error = failure;
      emit("file-doc-saved", { ...savedEvent(path, doc), hash: null });
      throw { code: "Io", message: failure };
    }
    files.set(path, doc.text);
    writes.push({ path, text: doc.text });
    Object.assign(doc, { savedVersion: version(doc), synced: doc.text, error: null });
    const event = savedEvent(path, doc);
    emit("file-doc-saved", event);
    return event;
  }

  function replace(path, doc, text) {
    if (text === doc.text) return;
    const from = version(doc);
    const updates = [{ clientID: "disk", changes: minimalChanges(doc.text, text) }];
    doc.text = text;
    doc.updates.push(...updates);
    emit("file-doc-updates", { docId: doc.docId, path, from, updates, version: version(doc) });
  }

  function takeDisk(path, doc) {
    replace(path, doc, files.get(path));
    Object.assign(doc, { synced: doc.text, savedVersion: version(doc), external: null, error: null });
    clearTimeout(doc.timer);
    emit("file-doc-saved", savedEvent(path, doc));
    emit("file-doc-external", { docId: doc.docId, path, kind: "applied" });
  }

  const opened = (path, doc) => ({
    docId: doc.docId,
    path, name: name(path), text: doc.text, version: version(doc), lineEnding: "lf", bom: false,
    savedVersion: doc.savedVersion, external: doc.external
  });

  const commands = {
    file_doc_open: ({ path }) => {
      if (!docs.has(path)) {
        if (!files.has(path)) throw { code: "NotFound", message: `${name(path)} is no longer on disk.` };
        const text = files.get(path);
        docs.set(path, { docId: `doc-${(opening += 1)}`, text, synced: text, updates: [], savedVersion: 0, external: null, error: null, timer: null });
      }
      return opened(path, docs.get(path));
    },
    file_doc_push: ({ path, docId, version: base, updates }) => {
      const doc = find(path, docId);
      if (base !== version(doc)) return { accepted: false, version: version(doc) };
      if (updates.length === 0) return { accepted: true, version: base };
      doc.text = applyUpdatesToText(doc.text, updates);
      doc.updates.push(...updates);
      emit("file-doc-updates", { docId, path, from: base, updates, version: version(doc) });
      schedule(path, doc);
      return { accepted: true, version: version(doc) };
    },
    file_doc_pull: ({ path, docId, since }) => ({ updates: find(path, docId).updates.slice(since) }),
    file_doc_save: ({ path }) => save(path),
    file_doc_close: ({ path }) => {
      if (!docs.has(path)) return null;
      save(path);
      clearTimeout(docs.get(path).timer);
      docs.delete(path);
      return null;
    },
    file_doc_resolve: ({ path, keep }) => {
      const doc = find(path);
      if (keep === "disk") {
        takeDisk(path, doc);
        return null;
      }
      doc.external = null;
      emit("file-doc-external", { docId: doc.docId, path, kind: "applied" });
      save(path);
      return null;
    }
  };

  return {
    commands,
    files,
    writes,
    text: (path) => docs.get(path)?.text,
    isOpen: (path) => docs.has(path),
    /** Makes every write fail with `message` until called with null. */
    failWrites: (message) => { failure = message; },
    /** Another program wrote `text`. `merged` is what a clean 3-way merge gives; without it an edited file conflicts. */
    outsideEdit(path, text, { merged } = {}) {
      files.set(path, text);
      const doc = docs.get(path);
      if (!doc) return;
      if (doc.text === doc.synced) return takeDisk(path, doc);
      doc.synced = text;
      if (merged === undefined) {
        doc.external = "conflict";
        emit("file-doc-external", { docId: doc.docId, path, kind: "conflict" });
        return;
      }
      replace(path, doc, merged);
      emit("file-doc-external", { docId: doc.docId, path, kind: "merged" });
      schedule(path, doc);
    },
    /** What `file_save_as_dialog` does to a document open at the chosen path. */
    discard(path) {
      clearTimeout(docs.get(path)?.timer);
      docs.delete(path);
    },
    remove(path) {
      files.delete(path);
      const doc = docs.get(path);
      if (!doc) return;
      doc.external = "removed";
      emit("file-doc-external", { docId: doc.docId, path, kind: "removed" });
    }
  };
}
