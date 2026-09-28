// SPDX-License-Identifier: GPL-3.0-or-later

// The files open in the main window, as plain data: which is active, what each
// holds, whether it has unsaved changes, and what happened to it on disk. The
// editor and Rust calls live in file-editor.js.

export const UNTITLED_BASE = "Untitled";

// `external` is null, "conflict" (changed on disk while edited here) or
// "missing" (deleted or moved away).
function createBuffer(id, fields) {
  return {
    id,
    path: null,
    name: `${UNTITLED_BASE}.md`,
    text: "",
    savedText: "",
    lineEnding: "lf",
    bom: false,
    hash: null,
    external: null,
    editorState: null,
    ...fields
  };
}

export function isDirty(buffer) {
  return buffer.text !== buffer.savedText;
}

// An untitled buffer only matters once something was typed into it.
export function needsPrompt(buffer) {
  return buffer.path === null && buffer.text.trim() !== "";
}

// Whether autosave may write this buffer now.
export function canAutosave(buffer) {
  return buffer.path !== null && buffer.external === null && isDirty(buffer);
}

export function createFilesModel({ newId = () => globalThis.crypto.randomUUID() } = {}) {
  const buffers = [];
  let activeId = null;

  const find = (id) => buffers.find((buffer) => buffer.id === id) ?? null;
  const byPath = (path) => buffers.find((buffer) => buffer.path === path) ?? null;

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

    // Opens `file` (from Rust), or switches to it if it is already open.
    openFile(file) {
      const existing = byPath(file.path);
      if (existing) {
        activeId = existing.id;
        return existing;
      }
      const buffer = createBuffer(newId(), {
        path: file.path,
        name: file.name,
        text: file.text,
        savedText: file.text,
        lineEnding: file.lineEnding,
        bom: file.bom,
        hash: file.hash
      });
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

    // `savedText` is what was written, which may trail `text` if typing went on.
    markSaved(id, { path, name, hash }, savedText) {
      const buffer = find(id);
      if (!buffer) return null;
      buffer.path = path ?? buffer.path;
      buffer.name = name ?? buffer.name;
      buffer.hash = hash;
      buffer.savedText = savedText;
      buffer.external = null;
      return buffer;
    },

    // Decides what an outside change to `path` means here.
    externalChange(path, kind) {
      const buffer = byPath(path);
      if (!buffer) return { buffer: null, action: "ignore" };
      if (kind === "removed") {
        buffer.external = "missing";
        return { buffer, action: "missing" };
      }
      if (isDirty(buffer)) {
        buffer.external = "conflict";
        return { buffer, action: "conflict" };
      }
      return { buffer, action: "reload" };
    },

    // Replaces the buffer with the file as it now is on disk.
    reload(id, file) {
      const buffer = find(id);
      if (!buffer) return null;
      Object.assign(buffer, {
        text: file.text,
        savedText: file.text,
        lineEnding: file.lineEnding,
        bom: file.bom,
        hash: file.hash,
        external: null,
        editorState: null
      });
      return buffer;
    },

    // "Keep mine": the next save overwrites the outside change.
    keepMine(id) {
      const buffer = find(id);
      if (!buffer) return null;
      buffer.external = null;
      buffer.savedText = null;
      return buffer;
    }
  };
}
