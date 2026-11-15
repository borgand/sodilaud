// SPDX-License-Identifier: GPL-3.0-or-later

// The optional Vim keymap. Vim reads keys at default precedence, ahead of the
// editor's own default keymaps, so the app's Prec.high shortcuts (Cmd+Alt+M,
// Cmd+Alt+E, formatting) and a table cell's keys still come first.

import { EditorView, Prec, ViewPlugin, getCM, vim } from "./vendor/codemirror.js";
import { isMacLikePlatform } from "./platform-labels.js";

// Whether Vim is on and not inserting: plain keys are commands, not text.
export function vimCommandMode(view) {
  const state = getCM(view)?.state.vim;
  return Boolean(state) && !state.insertMode;
}

const plainKey = event => !event.metaKey && !event.ctrlKey && !event.altKey;
const ctrlF = event =>
  event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
const isMacView = view => isMacLikePlatform(view.dom.ownerDocument.defaultView?.navigator);

// Escape belongs to Vim while it inserts or selects, even in a table cell,
// whose own Escape would leave the table. Off macOS, Ctrl+F still finds text
// rather than paging: the editor keeps it from Vim, and the window's own
// shortcut handler opens the find bar.
const vimKeyGuard = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    const cm = getCM(view);
    const state = cm?.state.vim;
    if (!state || view.composing) return false;
    if (ctrlF(event) && !isMacView(view)) return true;
    if (event.key !== "Escape" || !plainKey(event) || !(state.insertMode || state.visualMode)) return false;
    return cm.state.vimPlugin.handleKey(event, view);
  }
}));

const modeReporter = (onMode) => ViewPlugin.fromClass(class {
  constructor(view) {
    this.cm = getCM(view);
    this.report = () => {
      const state = this.cm?.state.vim;
      if (state) onMode((state.mode || "normal").toUpperCase());
    };
    this.cm?.on("vim-mode-change", this.report);
    this.report();
  }

  update(update) {
    if (update.focusChanged && update.view.hasFocus) this.report();
  }

  destroy() {
    this.cm?.off("vim-mode-change", this.report);
  }
});

/** @param {{ onMode?: (mode: string) => void }} [options] */
export function vimKeys({ onMode } = {}) {
  return [vimKeyGuard, vim(), onMode ? modeReporter(onMode) : []];
}
