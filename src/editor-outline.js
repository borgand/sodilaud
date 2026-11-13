// SPDX-License-Identifier: GPL-3.0-or-later

// The outline sidebar section both editors show: one row per heading of the
// shown document, the section in view marked, a click jumps to the heading.
// The owner says which view and preview it follows and how to jump.

import { documentAnchors } from "./editor-anchors.js";
import { reviewHunkFences } from "./editor-hunks.js";
import { isScrolledToEnd, markCurrentOutline, outlineEntries, outlineIdAt, readingHeadingAt, renderOutlineList } from "./outline.js";

// The outline reparses the whole document, so it waits for typing to pause.
export const OUTLINE_DELAY_MS = 150;
// A heading or hunk this close below the top of the view counts as the one
// being read, so one a jump just scrolled to is not skipped for the next.
export const TOP_SLACK_PX = 8;

/**
 * @param {{
 *   section: HTMLElement, list: HTMLElement, toggle?: HTMLElement, empty?: HTMLElement,
 *   view: () => import("@codemirror/view").EditorView,
 *   preview: HTMLElement,
 *   isReading: () => boolean,
 *   onSelect: (id: string) => void
 * }} options
 */
export function createOutlinePanel({ section, list, toggle, empty, view, preview, isReading, onSelect, delay = OUTLINE_DELAY_MS }) {
  let shown = [];
  let currentId = null;
  let timer = null;

  function updateCurrent() {
    if (section.hidden) return;
    let id;
    if (isReading()) {
      const box = preview.getBoundingClientRect();
      id = readingHeadingAt(preview, isScrolledToEnd(preview) ? box.bottom : box.top + TOP_SLACK_PX);
    } else {
      const editorView = view();
      const box = editorView.scrollDOM.getBoundingClientRect();
      const edge = isScrolledToEnd(editorView.scrollDOM) ? box.bottom : box.top + TOP_SLACK_PX;
      id = outlineIdAt(shown, editorView.lineBlockAtHeight(edge - editorView.documentTop).from);
    }
    if (id === currentId) return;
    currentId = id;
    markCurrentOutline(list, id)?.scrollIntoView?.({ block: "nearest" });
  }

  /**
   * Rebuilds the outline from the view's document, or empties it when
   * `enabled` is false. Returns the document's review hunks.
   */
  function render(enabled = true) {
    clearTimeout(timer);
    timer = null;
    const { state } = view();
    const hunks = enabled ? reviewHunkFences(state) : [];
    shown = enabled ? outlineEntries(documentAnchors(state), hunks, state.doc.length) : [];
    section.hidden = shown.length === 0;
    if (empty) empty.hidden = shown.length > 0;
    if (shown.length) {
      renderOutlineList(list, shown, onSelect);
      markCurrentOutline(list, currentId);
      updateCurrent();
    } else currentId = null;
    return hunks;
  }

  // `run` is the owner's full render, which may do more than the outline.
  function schedule(run = render) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  function toggleList() {
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(expanded));
    list.hidden = !expanded;
  }

  function attach() {
    view().scrollDOM.addEventListener("scroll", updateCurrent, { passive: true });
    preview.addEventListener("scroll", updateCurrent, { passive: true });
    toggle?.addEventListener("click", toggleList);
  }

  return {
    attach,
    render,
    schedule,
    updateCurrent,
    // Scrolls the marked row into view, e.g. when its sidebar tab is shown.
    revealCurrent: () => markCurrentOutline(list, currentId)?.scrollIntoView?.({ block: "nearest" }),
    // Another document is shown: nothing is current until it is measured.
    reset: () => { currentId = null; },
    cancel: () => { clearTimeout(timer); timer = null; }
  };
}
