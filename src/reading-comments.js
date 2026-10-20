// SPDX-License-Identifier: GPL-3.0-or-later

// Comments in Reading mode. The preview is a separate render, so comments are
// taken and kept in the hidden editor's state: a hosted composer, which
// CodeMirror leaves undrawn, is drawn here along with the tints.

import { EditorView } from "./vendor/codemirror.js";
import {
  activeComment,
  closeComposer,
  commentComposer,
  commentRanges,
  commentsDiffer,
  createComposerElement,
  selectComment,
  shownComments,
  startCommentAt
} from "./editor-comments.js";
import { findHunkFence, hunkLineRange, hunkMarks, hunkOffsetPosition, hunkSpanRange } from "./editor-hunks.js";
import { paintDots, paintMarks, selectedSpan, setHunkComposer } from "./hunk-comments.js";
import { isMacLikePlatform } from "./platform-labels.js";
import { blockForSource, paintSourceMarks, rangeToSource } from "./source-map.js";

const visible = comment => !comment.orphaned && comment.state !== "resolved" && comment.to > comment.from;
const DRAFT = "cm-comment cm-comment-draft";

const elementOf = node => (node?.nodeType === 1 ? node : node?.parentElement ?? null);

/**
 * Closes a composer a restored editor state brought back into a view that
 * cannot draw it: one taken in Reading shows only in the preview, any other
 * only in the editor.
 * @param {import("./vendor/codemirror.js").EditorView} view
 * @param {"editor" | "reading" | null} shown what the user sees for this view
 */
export function dropStrayComposer(view, shown) {
  const composer = commentComposer(view.state);
  if (composer && shown !== (composer.outside ? "reading" : "editor")) closeComposer(view);
}

/**
 * @param {object} options
 * @param {HTMLElement} options.preview the Reading preview
 * @param {() => import("./vendor/codemirror.js").EditorView | null} options.view the hidden editor
 * @param {() => boolean} options.enabled whether the preview is showing
 * @param {() => void} [options.onShortcut] the comment shortcut, which defaults to start
 */
export function createReadingComments({ preview, view, enabled, onShortcut }) {
  const document = preview.ownerDocument;
  const selection = () => document.getSelection();
  let cached = null;
  let shownActive = null;

  const widgets = () => [...preview.querySelectorAll(".diff-hunk")];
  const targetOf = (widget, index = widgets().indexOf(widget)) => ({ hunk: widget.dataset.hunk ?? null, index });

  function composerElement(current, key) {
    if (cached?.key !== key) {
      const wrapper = document.createElement("div");
      wrapper.className = "reading-composer";
      cached = { key, wrapper, element: createComposerElement(current, key, { refocus: false }) };
    }
    return cached;
  }

  // The selection as a document range, and whether it is inside a hunk.
  function mapSelection(current) {
    const chosen = selection();
    if (!current || !chosen || chosen.rangeCount === 0 || chosen.isCollapsed) return null;
    const anchor = chosen.anchorNode;
    if (!anchor || !preview.contains(anchor)) return null;
    const widget = elementOf(anchor)?.closest(".diff-hunk");
    if (widget && preview.contains(widget)) {
      const span = selectedSpan(widget, chosen);
      const found = span && findHunkFence(current.state, targetOf(widget));
      const range = found ? hunkSpanRange(current.state, found, span) : null;
      return range && { range, hunk: true };
    }
    const range = rangeToSource(preview, chosen.getRangeAt(0), current.state.doc.toString());
    return range && { range, hunk: false };
  }

  function open(current, range) {
    if (!current || !range) return false;
    return startCommentAt(current, range.from, range.to, { outside: true });
  }

  function start() {
    const current = view();
    const mapped = mapSelection(current);
    if (!mapped || !open(current, mapped.range)) return false;
    hideButton();
    selection()?.removeAllRanges();
    return true;
  }

  function topLevelChild(element) {
    let child = element;
    while (child && child.parentElement !== preview) child = child.parentElement;
    return child;
  }

  function placeComposer(current, composer) {
    const { wrapper, element } = composerElement(current, composer.key);
    if (element.parentElement !== wrapper) wrapper.append(element);
    const block = blockForSource(preview, composer.to);
    const after = block && block !== preview ? topLevelChild(block) : null;
    // Moving a focused element would blur it, so leave it where it already is.
    if (after ? after.nextElementSibling === wrapper : wrapper.parentElement === preview && !wrapper.nextElementSibling) return;
    if (after) after.after(wrapper);
    else preview.append(wrapper);
  }

  function paint() {
    const current = view();
    if (!current) return;
    const { state } = current;
    const active = activeComment(state);
    const ranges = shownComments(state).filter(visible).flatMap(comment => commentRanges(state, comment).map(range => ({
      id: comment.id,
      author: comment.author,
      from: range.from,
      to: range.to,
      className: `cm-comment cm-comment-${comment.author}${comment.id === active ? " cm-comment-active" : ""}`
    })));
    const opened = commentComposer(state);
    const composer = opened?.outside ? opened : null;
    const draft = composer ? commentRanges(state, composer).map(range => ({ ...range, className: DRAFT })) : [];

    paintSourceMarks(preview, [...ranges, ...draft], state.doc.toString());

    let inHunk = false;
    widgets().forEach((widget, index) => {
      const found = findHunkFence(state, targetOf(widget, index));
      if (!found) return;
      const drafted = hunkMarks(state, found, draft);
      paintMarks(widget, [...hunkMarks(state, found, ranges), ...drafted]);
      // One dot per row, for the earliest comment starting there, like the gutter.
      const dots = [];
      for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
        const [mark] = hunkMarks(state, found, [range]);
        if (mark && !dots.some(dot => dot.row === mark.start.row)) dots.push({ row: mark.start.row, id: range.id, author: range.author });
      }
      paintDots(widget, dots);
      const hosting = drafted.length > 0 && !inHunk;
      inHunk ||= hosting;
      setHunkComposer(
        widget,
        hosting ? { key: composer.key, row: hunkOffsetPosition(state, found, composer.to).row } : null,
        () => composerElement(current, composer.key).element
      );
    });

    if (composer && !inHunk) placeComposer(current, composer);
    else cached?.wrapper.remove();
    if (!composer) cached = null;

    if (active !== shownActive) {
      shownActive = active;
      const mark = active === null ? null : [...preview.querySelectorAll("[data-comment-id]")]
        .find(element => element.getAttribute("data-comment-id") === active);
      mark?.scrollIntoView?.({ block: "nearest" });
    }
  }

  // The preview shows the text it was rendered from; after an edit it is
  // stale until the host renders it again through renderWith.
  const extension = EditorView.updateListener.of(update => {
    if (!update.docChanged && enabled() && commentsDiffer(update.startState, update.state)) paint();
  });

  function renderWith(fn) {
    const input = cached?.element.querySelector("textarea");
    const focused = input && document.activeElement === input
      ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
      : null;
    hideButton();
    fn();
    paint();
    if (focused && input.isConnected) {
      input.focus();
      input.setSelectionRange(focused.start, focused.end, focused.direction);
    }
  }

  function hunkOptions() {
    const openOn = (target, toRange) => {
      const current = view();
      const found = current && findHunkFence(current.state, target);
      return open(current, found && toRange(current.state, found));
    };
    return {
      onLineComment: (target, index) => openOn(target, (state, found) => hunkLineRange(state, found, index)),
      codeComments: target => ({
        onStart: hideButton,
        onComment: span => openOn(target, (state, found) => hunkSpanRange(state, found, span)),
        onMarkClick: id => {
          const current = view();
          if (current) selectComment(current, id);
        }
      })
    };
  }

  let button = null;

  function hideButton() {
    if (button) button.hidden = true;
  }

  function showButton() {
    const chosen = selection();
    const mapped = enabled() ? mapSelection(view()) : null;
    if (!mapped || mapped.hunk) {
      hideButton();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "reading-comment-button";
      button.textContent = "Comment";
      button.title = "Comment on the selection";
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        start();
        hideButton();
      });
    }
    if (button.parentElement !== preview) preview.append(button);
    const range = chosen.getRangeAt(0);
    const rects = range.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const box = preview.getBoundingClientRect();
    button.hidden = false;
    button.style.top = `${last.bottom - box.top + preview.scrollTop + 4}px`;
    button.style.left = `${Math.max(0, last.left - box.left + preview.scrollLeft)}px`;
  }

  const onMouseUp = event => {
    if (event.target?.closest?.(".reading-comment-button, .reading-composer")) return;
    showButton();
  };
  const onClick = event => {
    const mark = event.target?.closest?.(".source-mark[data-comment-id]");
    const current = view();
    if (mark && current && preview.contains(mark)) selectComment(current, mark.getAttribute("data-comment-id"));
  };
  const onSelectionChange = () => {
    const chosen = selection();
    if (!chosen || chosen.isCollapsed || !preview.contains(chosen.anchorNode)) hideButton();
  };
  const onKeyDown = event => {
    if (event.defaultPrevented || !enabled()) return;
    if (!(isMacLikePlatform() ? event.metaKey : event.ctrlKey) || !event.altKey || event.code !== "KeyM") return;
    if (event.target?.closest?.("textarea, input")) return;
    event.preventDefault();
    (onShortcut ?? start)();
  };

  preview.addEventListener("mouseup", onMouseUp);
  preview.addEventListener("click", onClick);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKeyDown);

  return {
    extension,
    start,
    renderWith,
    hunkOptions,
    close() {
      const current = view();
      if (current) closeComposer(current);
    },
    destroy() {
      preview.removeEventListener("mouseup", onMouseUp);
      preview.removeEventListener("click", onClick);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      button?.remove();
    }
  };
}
