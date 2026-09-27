// SPDX-License-Identifier: GPL-3.0-or-later

import { EditorSelection, EditorView, Prec, isolateHistory, keymap } from "./vendor/codemirror.js";
import { getChangedRange } from "./editor-edit.js";
import { getIndentEdit } from "./editor-indent.js";
import { getMarkdownAutocompleteEdit } from "./editor-autocomplete.js";
import { getFormatEdit } from "./markdown-format.js";
import {
  getHomePosition,
  getListMoveEdit,
  getMarkdownPasteEdit,
  getSmartKeyEdit
} from "./editor-smart.js";

function isGuarded(event, view) {
  return Boolean(
    view.composing ||
    event.isComposing ||
    event.key === "Dead" ||
    event.keyCode === 229 ||
    view.state.selection.ranges.length > 1
  );
}

function getKeydownEdit(event, view) {
  const text = view.state.doc.toString();
  const { from, to } = view.state.selection.main;

  if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return getIndentEdit(text, from, to, event.shiftKey);
  }

  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.isComposing
  ) {
    const edit = getMarkdownAutocompleteEdit(text, from, to);
    if (edit) return edit;
  }

  if (event.metaKey || event.ctrlKey) return null;

  if (event.altKey) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
    return getListMoveEdit(text, from, to, event.key === "ArrowUp" ? -1 : 1);
  }

  if (event.key === "Home" && !event.shiftKey) {
    const position = getHomePosition(text, from, to);
    return position === null ? null : { moveTo: position };
  }

  return getSmartKeyEdit(text, from, to, event.key);
}

function keydown(event, view) {
  if (isGuarded(event, view)) return false;
  const edit = getKeydownEdit(event, view);
  if (!edit) return false;
  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.stopPropagation();
  }
  event.preventDefault();
  return applyPureEdit(view, edit);
}

function paste(event, view) {
  if (isGuarded(event, view)) return false;
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;
  const { from, to } = view.state.selection.main;
  const edit = getMarkdownPasteEdit(view.state.doc.toString(), from, to, text);
  if (!edit) return false;
  event.preventDefault();
  return applyPureEdit(view, edit);
}

export function applyPureEdit(view, edit, { isolate = false } = {}) {
  if (!edit) return false;

  if ("moveTo" in edit) {
    const clamp = position => Math.max(0, Math.min(Number(position) || 0, view.state.doc.length));
    view.dispatch({ selection: EditorSelection.cursor(clamp(edit.moveTo)), scrollIntoView: true });
    return true;
  }

  const change = getChangedRange(view.state.doc.toString(), edit.value);
  const length = edit.value.length;
  const bound = position => Math.max(0, Math.min(position, length));
  view.dispatch({
    changes: { from: change.start, to: change.previousEnd, insert: change.replacement },
    selection: EditorSelection.single(bound(edit.selectionStart), bound(edit.selectionEnd)),
    userEvent: "input",
    annotations: isolate ? isolateHistory.of("full") : [],
    scrollIntoView: true
  });
  return true;
}

export function runFormatAction(view, actionId) {
  if (view.composing || view.state.selection.ranges.length > 1) return false;
  const { from, to } = view.state.selection.main;
  const edit = getFormatEdit(view.state.doc.toString(), from, to, actionId);
  return applyPureEdit(view, edit, { isolate: true });
}

const FORMAT_KEYS = [
  ["Mod-b", "bold"],
  ["Mod-i", "italic"],
  ["Mod-k", "link"],
  ["Shift-Mod-x", "strikethrough"],
  ["Mod-e", "code"],
  ...[1, 2, 3, 4, 5, 6].map(level => [`Alt-Mod-${level}`, `heading-${level}`]),
  ["Shift-Mod-7", "numbered-list"],
  ["Shift-Mod-8", "bullet-list"],
  ["Shift-Mod-9", "task-list"],
  ["Shift-Mod-.", "quote"],
  ["Alt-Mod-c", "code-block"]
];

// CodeMirror falls back to the physical key when Shift or Alt changes event.key
// (Shift-Cmd-8 is "*", Alt-Cmd-1 is "¡" on macOS), so these match by keyCode too.
// Handled shortcuts stop propagating so app-level shortcuts such as Cmd-B never see them.
export function markdownFormattingKeymap() {
  return Prec.high(keymap.of(FORMAT_KEYS.map(([key, actionId]) => ({
    key,
    run: view => runFormatAction(view, actionId),
    preventDefault: true,
    stopPropagation: true
  }))));
}

export function markdownEditingCommands() {
  return [Prec.high(EditorView.domEventHandlers({ keydown, paste })), markdownFormattingKeymap()];
}
