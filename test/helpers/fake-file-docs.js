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
  let hold = false;
  let commentCounter = 0;
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

  // Comments, in the simplest form the page can tell apart from Rust's: no
  // mapping through edits (the Rust tests cover that), only states and events.
  const commentsEvent = (path, doc) => ({ path, docId: doc.docId, version: version(doc), comments: structuredClone(doc.comments) });
  const changedComments = (path, doc) => emit("comments-changed", commentsEvent(path, doc));
  const commentOf = ({ doc: { path, docId }, id }) => {
    const doc = find(path, docId);
    const comment = doc.comments.find(c => c.id === id);
    if (!comment) throw new Error("This comment no longer exists");
    return { path, doc, comment };
  };
  function addComment(path, doc, { from, to, body, author = "owner", replyTo = null }) {
    const comment = {
      id: `c_${(commentCounter += 1)}`, author, state: author === "agent" ? "open" : hold ? "held" : "queued", orphaned: false,
      from, to, anchoredText: doc.text.slice(from, to), headingPath: [], body, note: null, replyTo, unread: author === "agent", createdAt: commentCounter, updatedAt: commentCounter
    };
    doc.comments.push(comment);
    changedComments(path, doc);
    return comment;
  }
  const rootOf = (doc, id) => {
    const comment = doc.comments.find(c => c.id === id);
    return doc.comments.find(c => c.id === (comment?.replyTo ?? id));
  };
  const resolveThread = (doc, comment, note = null) => {
    const root = comment.replyTo ?? comment.id;
    if (note) comment.note = note;
    doc.comments.filter(c => (c.replyTo ?? c.id) === root).forEach(c => { c.state = "resolved"; });
  };
  const commentCommands = {
    comments_get: ({ doc: { path, docId } }) => commentsEvent(path, find(path, docId)),
    comment_add: ({ doc: { path, docId }, comment: { version: at, from, to, body, replyTo } }) => {
      const doc = find(path, docId);
      if (replyTo) {
        const root = rootOf(doc, replyTo);
        if (!root || root.state === "resolved") throw new Error("This thread is resolved; it can no longer be answered");
        return addComment(path, doc, { from: root.from, to: root.to, body, replyTo: root.id });
      }
      if (at !== version(doc)) throw new Error("The selected text changed; select it again");
      return addComment(path, doc, { from, to, body });
    },
    comment_edit: (args) => { const { path, doc, comment } = commentOf(args); comment.body = args.body; changedComments(path, doc); },
    comment_delete: (args) => { const { path, doc, comment } = commentOf(args); doc.comments = doc.comments.filter(c => c !== comment); changedComments(path, doc); },
    comment_resolve: (args) => {
      const { path, doc, comment } = commentOf(args);
      resolveThread(doc, comment);
      changedComments(path, doc);
    },
    comment_mark_read: (args) => {
      const { path, doc, comment } = commentOf(args);
      const root = comment.replyTo ?? comment.id;
      doc.comments.filter(c => (c.replyTo ?? c.id) === root).forEach(c => { c.unread = false; });
      changedComments(path, doc);
    },
    comment_resend: (args) => { const { path, doc, comment } = commentOf(args); comment.state = "queued"; changedComments(path, doc); },
    comments_send_review: ({ doc: { path, docId } }) => {
      const doc = find(path, docId);
      const held = doc.comments.filter(c => c.state === "held");
      held.forEach(c => { c.state = "queued"; });
      changedComments(path, doc);
      return held.length;
    },
    comments_clear_resolved: ({ doc: { path, docId } }) => {
      const doc = find(path, docId);
      doc.comments = doc.comments.filter(c => c.state !== "resolved");
      changedComments(path, doc);
    },
    coedit_get_state: () => ({ holdForReview: hold, listening: false }),
    coedit_set_hold: ({ hold: next }) => { hold = next; return { holdForReview: hold, listening: false }; }
  };

  const commands = {
    ...commentCommands,
    file_doc_open: ({ path }) => {
      if (!docs.has(path)) {
        if (!files.has(path)) throw { code: "NotFound", message: `${name(path)} is no longer on disk.` };
        const text = files.get(path);
        docs.set(path, { docId: `doc-${(opening += 1)}`, text, synced: text, updates: [], savedVersion: 0, external: null, error: null, timer: null, comments: [] });
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
    comments: (path) => docs.get(path)?.comments ?? [],
    /** An agent's apply_edit landing: one update from client `agent`. */
    agentEdit(path, changes) {
      const doc = docs.get(path);
      const from = version(doc);
      const updates = [{ clientID: "agent", changes }];
      doc.text = applyUpdatesToText(doc.text, updates);
      doc.updates.push(...updates);
      emit("file-doc-updates", { docId: doc.docId, path, from, updates, version: version(doc) });
    },
    agentComment(path, anchor, body) {
      const doc = docs.get(path);
      const from = doc.text.indexOf(anchor);
      return addComment(path, doc, { from, to: from + anchor.length, body, author: "agent" });
    },
    agentReply(path, id, body) {
      const doc = docs.get(path);
      const root = rootOf(doc, id);
      return addComment(path, doc, { from: root.from, to: root.to, body, author: "agent", replyTo: root.id });
    },
    /** An agent took the queued comments. */
    take(path) {
      const doc = docs.get(path);
      const taken = doc.comments.filter(c => c.state === "queued");
      taken.forEach(c => { c.state = "sent"; });
      changedComments(path, doc);
      return taken;
    },
    resolveAsAgent(path, id, note) {
      const doc = docs.get(path);
      const comment = doc.comments.find(c => c.id === id);
      resolveThread(doc, comment, note);
      changedComments(path, doc);
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
