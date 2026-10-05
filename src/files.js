// SPDX-License-Identifier: GPL-3.0-or-later

// The files open in the main window, as plain data: which is active, where each
// stands against the Rust registry and the disk, and what happened to it on
// disk. The editor and Rust calls live in file-editor.js.

export const UNTITLED_BASE = "Untitled";

// `docId` names this opening of the file in the registry; events from an
// earlier opening of the same path are ignored. `text` and `version` are what
// the editor starts from (an untitled buffer
// keeps its text here). `latest` is the newest version the registry reported
// and `savedVersion` the newest one on disk. `external` is null, "conflict"
// (changed on disk while edited here) or "removed" (deleted or moved away).
function createBuffer(id, fields) {
  return {
    id,
    path: null,
    docId: null,
    name: `${UNTITLED_BASE}.md`,
    text: "",
    version: 0,
    latest: 0,
    savedVersion: 0,
    lineEnding: "lf",
    bom: false,
    external: null,
    error: null,
    editorState: null,
    ...fields
  };
}

const fromOpened = (opened) => ({
  docId: opened.docId,
  path: opened.path,
  name: opened.name,
  text: opened.text,
  version: opened.version,
  latest: opened.version,
  savedVersion: opened.savedVersion,
  lineEnding: opened.lineEnding,
  bom: opened.bom,
  external: opened.external ?? null
});

// `unsent`: the editor holds changes the registry has not confirmed yet.
export function isDirty(buffer, unsent = false) {
  if (buffer.path === null) return buffer.text !== "";
  return unsent || buffer.latest > buffer.savedVersion;
}

// An untitled buffer only matters once something was typed into it.
export function needsPrompt(buffer) {
  return buffer.path === null && buffer.text.trim() !== "";
}

export function createFilesModel({ newId = () => globalThis.crypto.randomUUID() } = {}) {
  const buffers = [];
  let activeId = null;

  const find = (id) => buffers.find((buffer) => buffer.id === id) ?? null;
  const byPath = (path) => buffers.find((buffer) => buffer.path === path) ?? null;
  const forEvent = (event) => {
    const buffer = byPath(event?.path);
    return buffer && buffer.docId === event.docId ? buffer : null;
  };

  function untitledName() {
    const taken = new Set(buffers.map((buffer) => buffer.name));
    for (let index = 1; ; index += 1) {
      const name = index === 1 ? `${UNTITLED_BASE}.md` : `${UNTITLED_BASE} ${index}.md`;
      if (!taken.has(name)) return name;
    }
  }

  return {
    list: () => [...buffers],
    get: find,
    byPath,
    active: () => find(activeId),
    paths: () => buffers.filter((buffer) => buffer.path !== null).map((buffer) => buffer.path),

    // Opens a file the registry opened, or switches to it if it is already open.
    openFile(opened) {
      const existing = byPath(opened.path);
      if (existing) {
        activeId = existing.id;
        return existing;
      }
      const buffer = createBuffer(newId(), fromOpened(opened));
      buffers.push(buffer);
      activeId = buffer.id;
      return buffer;
    },

    newUntitled() {
      const buffer = createBuffer(newId(), { name: untitledName() });
      buffers.push(buffer);
      activeId = buffer.id;
      return buffer;
    },

    activate(id) {
      if (find(id)) activeId = id;
      return find(activeId);
    },

    edit(id, text) {
      const buffer = find(id);
      if (buffer) buffer.text = text;
      return buffer;
    },

    // "needs-prompt" leaves the buffer open; `force` closes it regardless.
    close(id, { force = false } = {}) {
      const index = buffers.findIndex((buffer) => buffer.id === id);
      if (index === -1) return "closed";
      if (!force && needsPrompt(buffers[index])) return "needs-prompt";
      buffers.splice(index, 1);
      if (activeId === id) {
        const neighbor = buffers[index] ?? buffers[index - 1] ?? null;
        activeId = neighbor?.id ?? null;
      }
      return "closed";
    },

    // After Save As: the buffer now edits the file the registry just opened.
    adopt(id, opened) {
      const buffer = find(id);
      if (!buffer) return null;
      return Object.assign(buffer, fromOpened(opened), { editorState: null, error: null });
    },

    // Events from the registry: `{ docId, path, version }`.
    docUpdated(event) {
      const buffer = forEvent(event);
      if (buffer) buffer.latest = Math.max(buffer.latest, event.version);
      return buffer;
    },

    saved({ docId, path, version, error }) {
      const buffer = forEvent({ docId, path });
      if (!buffer) return null;
      buffer.savedVersion = Math.max(buffer.savedVersion, version);
      buffer.latest = Math.max(buffer.latest, buffer.savedVersion);
      buffer.error = error ?? null;
      return buffer;
    },

    // What an outside edit did: "applied", "merged", "conflict" or "removed".
    external({ docId, path, kind }) {
      const buffer = forEvent({ docId, path });
      if (!buffer) return null;
      buffer.external = kind === "conflict" || kind === "removed" ? kind : null;
      return buffer;
    },

    // The registry no longer has the history the editor needs: start over.
    reload(id, text, version) {
      const buffer = find(id);
      if (!buffer) return null;
      return Object.assign(buffer, { text, version, latest: Math.max(buffer.latest, version), editorState: null });
    }
  };
}
