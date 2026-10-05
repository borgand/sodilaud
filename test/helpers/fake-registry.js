// SPDX-License-Identifier: GPL-3.0-or-later

// A stand-in for the Rust notes registry (src-tauri/src/docs), so page tests
// run the real collab and structure protocol. It follows the same rules as
// the Rust code; the Rust tests cover the registry itself.

import { applyUpdatesToText } from "../../src/note-sync.js";
import { autoTitle, UNTITLED_TITLE } from "../../src/note-title.js";

const DEFAULT_PATH = "/app-data/default.sqlite";

function workspace(seed = {}) {
  return {
    notes: (seed.notes ?? []).map(note => ({ ...note, content: String(note.content ?? "").replace(/\r\n?/g, "\n"), version: 0, rev: 1, updates: [] })),
    folders: (seed.folders ?? []).map(folder => ({ ...folder, rev: 1 })),
    trash: structuredClone(seed.trash ?? []),
    imported: seed.imported ?? false
  };
}

/**
 * @param {object} options
 * @param {(name: string, payload: unknown) => void} options.emit
 * @param {object} [options.seed] the default workspace: notes, folders, trash, imported
 * @param {Record<string, object>} [options.files] other workspaces by path
 * @param {string} [options.open] the path open at launch (default: the default workspace)
 * @param {string} [options.fallback] boot's fallback notice
 */
export function createFakeRegistry({ emit, seed = {}, files = {}, open = DEFAULT_PATH, fallback = null } = {}) {
  const stores = new Map([[DEFAULT_PATH, workspace(seed)], ...Object.entries(files).map(([path, value]) => [path, workspace(value)])]);
  let path = open;
  let id = `collection-${Math.random().toString(36).slice(2)}`;
  let nextRev = 100;
  let seq = 0;
  const failing = new Set();
  const current = () => stores.get(path);
  // Comments by note ID, in the simplest form the page can tell from Rust's.
  const comments = new Map();
  let commentCounter = 0;
  const commentsOf = noteId => comments.get(noteId) ?? [];
  const commentsEvent = noteId => ({ collectionId: id, noteId, version: note(noteId).version, comments: structuredClone(commentsOf(noteId)) });
  const changedComments = noteId => emit("comments-changed", commentsEvent(noteId));
  function addComment(noteId, fields) {
    const target = note(noteId);
    commentCounter += 1;
    const comment = { id: `c_${commentCounter}`, orphaned: false, headingPath: [], note: null, replyTo: null, createdAt: commentCounter, updatedAt: commentCounter, anchoredText: target.content.slice(fields.from, fields.to), ...fields };
    comments.set(noteId, [...commentsOf(noteId), comment]);
    changedComments(noteId);
    return comment;
  }

  const state = () => ({
    collectionId: id,
    name: path === DEFAULT_PATH ? "Local notes" : path.split("/").pop(),
    path,
    isDefault: path === DEFAULT_PATH,
    notes: current().notes.map(({ updates, ...note }) => ({ ...note })),
    folders: current().folders.map(folder => ({ ...folder })),
    trash: structuredClone(current().trash),
    seq: ++seq
  });
  const changed = () => emit("notes-workspace-changed", state());
  const check = collectionId => {
    if (collectionId !== id) throw new Error("Collection changed; reload the current collection before writing");
  };
  const fail = command => {
    if (failing.has(command)) throw new Error(`${command} failed`);
  };
  const pinnedFirst = notes => [...notes.filter(n => n.isPinned), ...notes.filter(n => !n.isPinned)];
  const note = noteId => {
    const found = current().notes.find(candidate => candidate.id === noteId);
    if (!found) throw new Error(`No note exists with id \`${noteId}\``);
    return found;
  };

  function applyUpdates(target, updates) {
    const from = target.version;
    target.content = applyUpdatesToText(target.content, updates);
    target.version += updates.length;
    target.rev = ++nextRev;
    target.updatedAt = Math.max(Date.now(), target.updatedAt + 1);
    if (!target.isTitleLocked) target.title = autoTitle(target.content);
    target.updates.push(...updates);
    emit("notes-doc-updates", { collectionId: id, noteId: target.id, from, updates, version: target.version, title: target.title, updatedAt: target.updatedAt, rev: target.rev });
  }

  function trashNote(noteId) {
    const ws = current();
    const index = ws.notes.findIndex(candidate => candidate.id === noteId);
    if (index < 0) throw new Error(`No note exists with id \`${noteId}\``);
    const [removed] = ws.notes.splice(index, 1);
    const { version, rev, updates, ...plain } = removed;
    const entry = { id: `trash-${++nextRev}`, note: plain, deletedAt: Date.now(), folderName: ws.folders.find(f => f.id === plain.folderId)?.name ?? null };
    ws.trash.push(entry);
    if (ws.notes.length === 0) {
      ws.notes.push({ id: `note_blank_${++nextRev}`, title: UNTITLED_TITLE, content: "", updatedAt: Date.now(), isTitleLocked: false, isPinned: false, folderId: null, version: 0, rev: ++nextRev, updates: [] });
    }
    return entry;
  }

  function syncStructure({ collectionId, notes, folders, deletedFolderIds = [] }) {
    check(collectionId);
    const ws = current();
    const deleted = new Set(deletedFolderIds);
    const listedFolders = new Set(folders.map(folder => folder.id));
    const nextFolders = [];
    for (const proposed of folders) {
      if (deleted.has(proposed.id)) continue;
      const existing = ws.folders.find(folder => folder.id === proposed.id);
      if (existing) {
        if (proposed.name && proposed.name !== existing.name) Object.assign(existing, { name: proposed.name, rev: ++nextRev });
        nextFolders.push(existing);
      } else if (proposed.name) nextFolders.push({ id: proposed.id, name: proposed.name, rev: ++nextRev });
    }
    ws.folders.forEach((folder, index) => {
      if (!listedFolders.has(folder.id) && !deleted.has(folder.id)) nextFolders.splice(Math.min(index, nextFolders.length), 0, folder);
    });
    ws.folders = nextFolders;

    const trashed = new Set(ws.trash.map(entry => entry.note.id));
    const listedNotes = new Set(notes.map(n => n.id));
    const nextNotes = [];
    for (const proposed of notes) {
      let existing = ws.notes.find(n => n.id === proposed.id);
      if (!existing) {
        if (trashed.has(proposed.id)) continue;
        const content = String(proposed.content ?? "").replace(/\r\n?/g, "\n");
        existing = { id: proposed.id, title: autoTitle(content), content, updatedAt: Date.now(), isTitleLocked: false, isPinned: false, folderId: null, version: 0, rev: 0, updates: [] };
      }
      const before = JSON.stringify(existing);
      if ("isTitleLocked" in proposed) existing.isTitleLocked = proposed.isTitleLocked;
      if ("title" in proposed) existing.title = proposed.title.trim() || UNTITLED_TITLE;
      if ("isPinned" in proposed) existing.isPinned = proposed.isPinned;
      if ("folderId" in proposed) existing.folderId = proposed.folderId;
      if (JSON.stringify(existing) !== before || existing.rev === 0) existing.rev = ++nextRev;
      nextNotes.push(existing);
    }
    ws.notes.forEach((n, index) => {
      if (!listedNotes.has(n.id)) nextNotes.splice(Math.min(index, nextNotes.length), 0, n);
    });
    const folderIds = new Set(ws.folders.map(folder => folder.id));
    nextNotes.forEach(n => { if (n.folderId && !folderIds.has(n.folderId)) n.folderId = null; });
    ws.notes = pinnedFirst(nextNotes);
  }

  function openPath(nextPath) {
    if (!stores.has(nextPath)) stores.set(nextPath, workspace());
    path = nextPath;
    id = `collection-${Math.random().toString(36).slice(2)}`;
    changed();
    return state();
  }

  const commands = {
    notes_boot: () => {
      fail("notes_boot");
      return { state: state(), needsLocalImport: !stores.get(DEFAULT_PATH).imported, fallback };
    },
    notes_import_local: ({ local }) => {
      fail("notes_import_local");
      const target = stores.get(DEFAULT_PATH);
      if (!target.imported) {
        const imported = workspace(local);
        const ids = new Set(imported.notes.map(n => n.id));
        target.notes = [...imported.notes, ...target.notes.filter(n => !ids.has(n.id))];
        target.folders = [...imported.folders, ...target.folders.filter(f => !imported.folders.some(i => i.id === f.id))];
        target.trash = [...imported.trash, ...target.trash];
        target.imported = true;
        if (path === DEFAULT_PATH) {
          id = `collection-${Math.random().toString(36).slice(2)}`;
          changed();
        }
      }
      return state();
    },
    notes_sync_structure: ({ structure }) => {
      fail("notes_sync_structure");
      syncStructure(structure);
      const result = state();
      changed();
      return result;
    },
    notes_trash: ({ collectionId, noteId }) => {
      check(collectionId);
      fail("notes_trash");
      const entry = trashNote(noteId);
      changed();
      return { id: entry.id, noteId: entry.note.id };
    },
    notes_restore: ({ collectionId, trashId }) => {
      check(collectionId);
      fail("notes_restore");
      const ws = current();
      const index = ws.trash.findIndex(entry => entry.id === trashId);
      if (index < 0) throw new Error("This note is no longer in the trash");
      const [entry] = ws.trash.splice(index, 1);
      const restored = { ...entry.note, updatedAt: Date.now(), version: 0, rev: ++nextRev, updates: [] };
      const firstUnpinned = ws.notes.findIndex(n => !n.isPinned);
      ws.notes.splice(firstUnpinned < 0 ? ws.notes.length : firstUnpinned, 0, restored);
      changed();
      return restored.id;
    },
    notes_empty_trash: ({ collectionId, ids }) => {
      check(collectionId);
      fail("notes_empty_trash");
      current().trash = current().trash.filter(entry => !ids.includes(entry.id));
      changed();
    },
    notes_connect: ({ dbPath }) => {
      fail("notes_connect");
      const target = stores.get(dbPath);
      if (!target || (target.notes.length === 0 && target.folders.length === 0 && target.trash.length === 0)) {
        stores.set(dbPath, workspace({ notes: current().notes.map(({ version, rev, updates, ...n }) => n), folders: current().folders }));
      }
      return openPath(dbPath);
    },
    notes_disconnect: () => openPath(DEFAULT_PATH),
    notes_vacuum: () => null,
    doc_push: ({ collectionId, noteId, version, updates }) => {
      check(collectionId);
      fail("doc_push");
      const target = note(noteId);
      if (version !== target.version) return { accepted: false, version: target.version };
      if (updates.length) applyUpdates(target, updates);
      return { accepted: true, version: target.version };
    },
    doc_pull: ({ collectionId, noteId, since }) => {
      check(collectionId);
      const target = note(noteId);
      return { updates: target.updates.slice(since) };
    },
    comments_get: ({ doc }) => {
      check(doc.collectionId);
      return commentsEvent(doc.noteId);
    },
    comment_add: ({ doc, version, from, to, body, replyTo }) => {
      check(doc.collectionId);
      if (replyTo) {
        const parent = commentsOf(doc.noteId).find(c => c.id === replyTo);
        return addComment(doc.noteId, { author: "owner", state: "queued", from: parent.from, to: parent.to, body, replyTo });
      }
      if (version !== note(doc.noteId).version) throw new Error("The selected text changed; select it again");
      return addComment(doc.noteId, { author: "owner", state: "queued", from, to, body });
    },
    comment_resolve: ({ doc, id: commentId }) => {
      check(doc.collectionId);
      const comment = commentsOf(doc.noteId).find(c => c.id === commentId);
      comment.state = "resolved";
      changedComments(doc.noteId);
    },
    coedit_get_state: () => ({ holdForReview: false, listening: false })
  };

  return {
    commands,
    state,
    path: () => path,
    workspace: nextPath => stores.get(nextPath ?? path),
    /** Makes a command throw until `recover` is called. */
    failOn: command => failing.add(command),
    recover: command => failing.delete(command),
    /** What an agent's append_to_note does to the registry. */
    agentAppend(noteId, text) {
      const target = note(noteId);
      const length = [...target.content].reduce((units, character) => units + character.length, 0);
      const lines = text.split("\n");
      applyUpdates(target, [{ clientID: "agent", changes: length ? [length, [0, ...lines]] : [[0, ...lines]] }]);
      changed();
    },
    agentCreate(noteData) {
      current().notes.push({ isTitleLocked: true, isPinned: false, folderId: null, updatedAt: Date.now(), ...noteData, version: 0, rev: ++nextRev, updates: [] });
      current().notes = pinnedFirst(current().notes);
      changed();
    },
    comments: commentsOf,
    agentComment(noteId, anchor, body) {
      const from = note(noteId).content.indexOf(anchor);
      return addComment(noteId, { author: "agent", state: "open", from, to: from + anchor.length, body });
    },
    agentTrash(noteId) {
      trashNote(noteId);
      changed();
    },
    DEFAULT_PATH
  };
}
