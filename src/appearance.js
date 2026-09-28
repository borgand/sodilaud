// SPDX-License-Identifier: GPL-3.0-or-later

// Editor appearance shared by both windows: zoom, line spacing, line numbers,
// syntax highlighting and sidebar preview lines. Each page applies the stored
// values; the page that has the controls (looked up by id, any may be missing)
// changes them and tells the other window.

import {
  DEFAULT_EDITOR_LINE_NUMBERS,
  DEFAULT_EDITOR_LINE_SPACING,
  DEFAULT_EDITOR_ZOOM,
  DEFAULT_NOTE_PREVIEW_LINES,
  DEFAULT_SYNTAX_HIGHLIGHTING,
  MAX_EDITOR_LINE_SPACING,
  MAX_EDITOR_ZOOM,
  MAX_NOTE_PREVIEW_LINES,
  MIN_EDITOR_LINE_SPACING,
  MIN_EDITOR_ZOOM,
  MIN_NOTE_PREVIEW_LINES,
  normalizeEditorLineNumbers,
  normalizeEditorLineSpacing,
  normalizeEditorZoom,
  normalizeNotePreviewLines,
  normalizeSyntaxHighlighting,
  stepEditorLineSpacing,
  stepEditorZoom,
  stepNotePreviewLines
} from "./view-preferences.js";

export const APPEARANCE_KEYS = {
  zoom: "sodilaud_editor_zoom",
  lineSpacing: "sodilaud_editor_line_spacing",
  previewLines: "sodilaud_note_preview_lines",
  lineNumbers: "sodilaud_editor_line_numbers",
  syntaxHighlighting: "sodilaud_syntax_highlighting"
};

function setToggle(button, enabled) {
  if (!button) return;
  button.textContent = enabled ? "On" : "Off";
  button.setAttribute("aria-pressed", String(enabled));
}

export function createAppearance({
  document,
  storage,
  broadcast = () => {},
  onPreviewLines = () => {},
  onLineNumbers = () => {},
  onSyntaxHighlighting = () => {}
}) {
  const byId = (id) => document.getElementById(id);
  const root = document.documentElement;
  const controls = {
    zoomOut: byId("zoom-out-btn"),
    zoomReset: byId("zoom-reset-btn"),
    zoomIn: byId("zoom-in-btn"),
    lineSpacingDecrease: byId("line-spacing-decrease-btn"),
    lineSpacingValue: byId("line-spacing-value"),
    lineSpacingIncrease: byId("line-spacing-increase-btn"),
    previewLinesDecrease: byId("preview-lines-decrease-btn"),
    previewLinesValue: byId("preview-lines-value"),
    previewLinesIncrease: byId("preview-lines-increase-btn"),
    syntaxHighlighting: byId("syntax-highlighting-toggle"),
    lineNumbers: byId("line-numbers-toggle"),
    viewSettings: byId("view-settings")
  };
  const state = {
    zoom: DEFAULT_EDITOR_ZOOM,
    lineSpacing: DEFAULT_EDITOR_LINE_SPACING,
    previewLines: DEFAULT_NOTE_PREVIEW_LINES,
    lineNumbers: DEFAULT_EDITOR_LINE_NUMBERS,
    syntaxHighlighting: DEFAULT_SYNTAX_HIGHLIGHTING
  };

  function persist(name, value) {
    storage.setItem(APPEARANCE_KEYS[name], String(value));
    broadcast(APPEARANCE_KEYS[name]);
  }

  function applyZoom(value, { persist: save = true } = {}) {
    state.zoom = normalizeEditorZoom(value);
    root.style.setProperty("--editor-font-size", `${state.zoom}rem`);
    if (controls.zoomReset) controls.zoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
    if (controls.zoomOut) controls.zoomOut.disabled = state.zoom <= MIN_EDITOR_ZOOM;
    if (controls.zoomIn) controls.zoomIn.disabled = state.zoom >= MAX_EDITOR_ZOOM;
    if (save) persist("zoom", state.zoom);
  }

  function applyLineSpacing(value, { persist: save = true } = {}) {
    state.lineSpacing = normalizeEditorLineSpacing(value);
    root.style.setProperty("--editor-line-height", String(state.lineSpacing));
    if (controls.lineSpacingValue) controls.lineSpacingValue.textContent = `${state.lineSpacing.toFixed(1)}×`;
    if (controls.lineSpacingDecrease) controls.lineSpacingDecrease.disabled = state.lineSpacing <= MIN_EDITOR_LINE_SPACING;
    if (controls.lineSpacingIncrease) controls.lineSpacingIncrease.disabled = state.lineSpacing >= MAX_EDITOR_LINE_SPACING;
    if (save) persist("lineSpacing", state.lineSpacing);
  }

  function applyPreviewLines(value, { persist: save = true, render = true } = {}) {
    state.previewLines = normalizeNotePreviewLines(value);
    root.style.setProperty("--note-preview-lines", String(state.previewLines));
    if (controls.previewLinesValue) controls.previewLinesValue.textContent = String(state.previewLines);
    if (controls.previewLinesDecrease) controls.previewLinesDecrease.disabled = state.previewLines <= MIN_NOTE_PREVIEW_LINES;
    if (controls.previewLinesIncrease) controls.previewLinesIncrease.disabled = state.previewLines >= MAX_NOTE_PREVIEW_LINES;
    if (save) persist("previewLines", state.previewLines);
    if (render) onPreviewLines(state.previewLines);
  }

  function applyLineNumbers(value, { persist: save = true, render = true } = {}) {
    state.lineNumbers = normalizeEditorLineNumbers(value);
    root.classList.toggle("editor-line-numbers-enabled", state.lineNumbers);
    setToggle(controls.lineNumbers, state.lineNumbers);
    if (save) persist("lineNumbers", state.lineNumbers);
    if (render) onLineNumbers(state.lineNumbers);
  }

  function applySyntaxHighlighting(value, { persist: save = true, render = true } = {}) {
    state.syntaxHighlighting = normalizeSyntaxHighlighting(value);
    setToggle(controls.syntaxHighlighting, state.syntaxHighlighting);
    if (save) persist("syntaxHighlighting", state.syntaxHighlighting);
    if (render) onSyntaxHighlighting(state.syntaxHighlighting);
  }

  const stored = (name, fallback) => storage.getItem(APPEARANCE_KEYS[name]) ?? fallback;

  // Applies every stored value; `render: false` skips the page's hooks, for
  // start-up before the editors exist.
  function load({ render = true } = {}) {
    applyZoom(stored("zoom", DEFAULT_EDITOR_ZOOM), { persist: false });
    applyLineSpacing(stored("lineSpacing", DEFAULT_EDITOR_LINE_SPACING), { persist: false });
    applyPreviewLines(stored("previewLines", DEFAULT_NOTE_PREVIEW_LINES), { persist: false, render: false });
    applySyntaxHighlighting(stored("syntaxHighlighting", DEFAULT_SYNTAX_HIGHLIGHTING), { persist: false, render });
    applyLineNumbers(stored("lineNumbers", DEFAULT_EDITOR_LINE_NUMBERS), { persist: false, render });
  }

  // Re-reads one key another window changed. Returns whether it was ours.
  function reload(key) {
    switch (key) {
      case APPEARANCE_KEYS.zoom: applyZoom(stored("zoom", DEFAULT_EDITOR_ZOOM), { persist: false }); return true;
      case APPEARANCE_KEYS.lineSpacing: applyLineSpacing(stored("lineSpacing", DEFAULT_EDITOR_LINE_SPACING), { persist: false }); return true;
      case APPEARANCE_KEYS.previewLines: applyPreviewLines(stored("previewLines", DEFAULT_NOTE_PREVIEW_LINES), { persist: false }); return true;
      case APPEARANCE_KEYS.lineNumbers: applyLineNumbers(stored("lineNumbers", DEFAULT_EDITOR_LINE_NUMBERS), { persist: false }); return true;
      case APPEARANCE_KEYS.syntaxHighlighting: applySyntaxHighlighting(stored("syntaxHighlighting", DEFAULT_SYNTAX_HIGHLIGHTING), { persist: false }); return true;
      default: return false;
    }
  }

  function attachControls() {
    const on = (element, handler) => element?.addEventListener("click", handler);
    controls.viewSettings?.addEventListener("click", (event) => event.stopPropagation());
    on(controls.zoomOut, () => applyZoom(stepEditorZoom(state.zoom, -1)));
    on(controls.zoomReset, () => applyZoom(DEFAULT_EDITOR_ZOOM));
    on(controls.zoomIn, () => applyZoom(stepEditorZoom(state.zoom, 1)));
    on(controls.lineSpacingDecrease, () => applyLineSpacing(stepEditorLineSpacing(state.lineSpacing, -1)));
    on(controls.lineSpacingValue, () => applyLineSpacing(DEFAULT_EDITOR_LINE_SPACING));
    on(controls.lineSpacingIncrease, () => applyLineSpacing(stepEditorLineSpacing(state.lineSpacing, 1)));
    on(controls.previewLinesDecrease, () => applyPreviewLines(stepNotePreviewLines(state.previewLines, -1)));
    on(controls.previewLinesValue, () => applyPreviewLines(DEFAULT_NOTE_PREVIEW_LINES));
    on(controls.previewLinesIncrease, () => applyPreviewLines(stepNotePreviewLines(state.previewLines, 1)));
    on(controls.syntaxHighlighting, () => applySyntaxHighlighting(!state.syntaxHighlighting));
    on(controls.lineNumbers, () => applyLineNumbers(!state.lineNumbers));
  }

  // Cmd/Ctrl with +, - or 0 zooms, as in the notes editor before the split.
  function handleZoomShortcut(event) {
    const isMeta = event.metaKey || event.ctrlKey;
    if (!isMeta || event.altKey) return false;
    if (event.key === "+" || event.key === "=") applyZoom(stepEditorZoom(state.zoom, 1));
    else if (event.key === "-" || event.key === "_") applyZoom(stepEditorZoom(state.zoom, -1));
    else if (event.key === "0") applyZoom(DEFAULT_EDITOR_ZOOM);
    else return false;
    event.preventDefault();
    return true;
  }

  return {
    load,
    reload,
    attachControls,
    handleZoomShortcut,
    applyZoom,
    applyLineSpacing,
    applyPreviewLines,
    applyLineNumbers,
    applySyntaxHighlighting,
    get zoom() { return state.zoom; },
    get lineSpacing() { return state.lineSpacing; },
    get previewLines() { return state.previewLines; },
    get lineNumbers() { return state.lineNumbers; },
    get syntaxHighlighting() { return state.syntaxHighlighting; }
  };
}
