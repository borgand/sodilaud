// SPDX-License-Identifier: GPL-3.0-or-later

import { createDocSync } from "./doc-sync.js";

export { PUSH_DELAY_MS, applyUpdatesToText } from "./doc-sync.js";

// The note was trashed or its collection closed: nothing is left to send to.
const isGone = error => /No note exists|Collection changed/.test(String(error?.message ?? error));

/**
 * The collab client of every editor showing a note.
 *
 * @param {object} options
 * @param {(command: string, args?: object) => Promise<any>} options.invoke
 * @param {() => string} options.collectionId
 * @param {() => Promise<unknown>} [options.ready] resolves once structural writes
 *   that may create the note have been sent
 * @param {(status: {pending: boolean, failed: boolean}) => void} [options.onStatus]
 * @param {(noteId: string, text: string, version: number) => void} [options.onReload] the registry no longer has
 *   the history this client needs; reload the note from the collection
 * @param {string} [options.label] names this page in client IDs
 */
export function createNoteSync({ invoke, collectionId, onReload = () => {}, ...options }) {
  const sync = createDocSync({
    ...options,
    push: ({ collectionId, noteId }, version, updates) => invoke("doc_push", { collectionId, noteId, version, updates }),
    pull: ({ collectionId, noteId }, since) => invoke("doc_pull", { collectionId, noteId, since }),
    same: (doc, event) => doc.noteId === event.noteId && doc.collectionId === event.collectionId,
    isGone,
    onReload: (doc, text, version) => onReload(doc.noteId, text, version)
  });
  return {
    extension: (noteId, version) => sync.extension({ noteId, collectionId: collectionId() }, version),
    receive: sync.receive,
    flush: sync.flush,
    pending: () => sync.pending()
  };
}
