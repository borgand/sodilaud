// SPDX-License-Identifier: GPL-3.0-or-later

// The status bar both editors share: word and character counts, the cursor
// position, and a "Saved" that fades once it has been seen. Quick Notes and
// the file editor each own their elements and call in here.

// Counting words walks the whole document, so it trails typing; the cursor
// position stays immediate.
export const COUNTS_DELAY_MS = 150;
export const SAVED_FADE_MS = 2000;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const wordsIn = text => text.split(/\s+/).filter(Boolean).length;

/**
 * The document's word and character totals, or the selection's while there
 * is one ("… selected").
 * @param {import("@codemirror/state").EditorState} state
 */
export function countsText(state) {
  const selected = state.selection.ranges.filter(range => !range.empty);
  const texts = selected.length ? selected.map(range => state.sliceDoc(range.from, range.to)) : [state.doc.toString()];
  const words = texts.reduce((sum, text) => sum + wordsIn(text), 0);
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  return `${plural(words, "word")} • ${plural(chars, "character")}${selected.length ? " selected" : ""}`;
}

/** Where the main selection's head is, 1-based. */
export function cursorText(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const column = head - line.from + 1;
  return { text: `Ln ${line.number}, Col ${column}`, title: `Line ${line.number}, column ${column}` };
}

/**
 * Keeps `countsElement` and `cursorElement` in step with an editor view.
 * `schedule` moves the cursor at once and the counts after a pause in typing;
 * `update` does both now.
 */
export function createEditorStatus({ countsElement, cursorElement, delay = COUNTS_DELAY_MS }) {
  let timer = null;

  function cancel() {
    clearTimeout(timer);
    timer = null;
  }

  function showCursor(view) {
    const { text, title } = cursorText(view.state);
    cursorElement.textContent = text;
    cursorElement.title = title;
  }

  function update(view) {
    cancel();
    countsElement.textContent = countsText(view.state);
    showCursor(view);
  }

  function schedule(view) {
    showCursor(view);
    cancel();
    timer = setTimeout(() => {
      timer = null;
      countsElement.textContent = countsText(view.state);
    }, delay);
  }

  return { update, schedule, cancel };
}

/**
 * Fades a status once it has said "Saved" for `delay` ms. `key` names what is
 * shown (the document and its status): a new key shows the status again and,
 * when it is saved, starts the delay over.
 */
export function createSavedFade(element, { delay = SAVED_FADE_MS } = {}) {
  let shownKey;
  let timer = null;
  return {
    update(key, saved) {
      if (key === shownKey) return;
      shownKey = key;
      clearTimeout(timer);
      timer = null;
      element.classList.remove("settled");
      if (saved) timer = setTimeout(() => element.classList.add("settled"), delay);
    }
  };
}
