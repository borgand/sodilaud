// SPDX-License-Identifier: GPL-3.0-or-later

// Where the trash lived before 0.11 moved it into Rust. Read once, for the
// import into the default workspace.
export const LOCAL_TRASH_KEY = "sodilaud_trash";

// Fail closed on unreadable recovery data: it is left in local storage.
export function readTrash(raw) {
  const entries = JSON.parse(raw || "[]");
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id.trim()
    || !entry.note || typeof entry.note.id !== "string" || typeof entry.note.content !== "string"
    || typeof entry.note.title !== "string" || !Number.isFinite(entry.note.updatedAt) || !Number.isFinite(entry.deletedAt))
    || new Set(entries.map(entry => entry.id)).size !== entries.length) {
    throw new Error("Trash data is unreadable");
  }
  return entries;
}
