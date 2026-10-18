// SPDX-License-Identifier: GPL-3.0-or-later

// Compare for two side-by-side editors: marks what differs between them and
// keeps the marks current while either side is edited. Quick Notes and the
// file editor both use it; they own the button and say when the panes change.

import { compareNoteText, emptyNoteComparison } from "./note-compare.js";

export const COMPARE_DELAY_MS = 150;

/**
 * @param {object} options
 * @param {() => object | null} options.left the left editor, or null
 * @param {() => object | null} options.right the right editor, or null
 * @param {() => object} options.diffApi the jsdiff API (`window.Diff`), read at each run
 * @param {number} [options.delay]
 * @param {(state: { changedLineCount: number, pending: boolean }) => void} [options.onResult]
 */
export function createPaneCompare({ left, right, diffApi, delay = COMPARE_DELAY_MS, onResult = () => {} }) {
  let enabled = false;
  let comparison = emptyNoteComparison();
  let source = null;
  let timer = null;
  let pending = false;

  const texts = () => [left()?.getText() ?? "", right()?.getText() ?? ""];
  const matches = ([leftText, rightText]) => source?.leftText === leftText && source?.rightText === rightText;

  function cancel() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  }

  function notify() {
    onResult({ changedLineCount: pending ? 0 : comparison.changedLineCount, pending });
  }

  // While a run waits, the old marks would point at text that moved: none show.
  function render() {
    const shown = pending ? emptyNoteComparison() : comparison;
    left()?.setDiff(enabled ? { decorations: shown.leftDecorations, changedLines: shown.leftChangedLines } : null);
    right()?.setDiff(enabled ? { decorations: shown.rightDecorations, changedLines: shown.rightChangedLines } : null);
  }

  // Compares now unless both texts are the ones compared last.
  function run() {
    if (enabled) {
      const current = texts();
      cancel();
      if (!matches(current)) {
        comparison = compareNoteText(current[0], current[1], diffApi());
        source = { leftText: current[0], rightText: current[1] };
      }
      notify();
    }
    render();
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled) {
      cancel();
      comparison = emptyNoteComparison();
      source = null;
      render();
      notify();
      return;
    }
    run();
  }

  function schedule() {
    if (!enabled) return;
    if (matches(texts())) {
      cancel();
      notify();
      render();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    const wasPending = pending;
    pending = true;
    notify();
    if (!wasPending) render();
    timer = setTimeout(() => {
      timer = null;
      pending = false;
      if (enabled) run();
    }, delay);
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    isPending: () => pending,
    // Whether the marks shown are for the texts both sides hold now.
    isCurrent: () => matches(texts()),
    schedule,
    // A pane showed other text: compare it now, or redraw the cached result.
    refresh: run,
    destroy: () => setEnabled(false)
  };
}
