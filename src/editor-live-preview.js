// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Decoration,
  EditorSelection,
  EditorView,
  Facet,
  RectangleMarker,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType,
  layer,
  syntaxTree
} from "./vendor/codemirror.js";
import { syntaxHighlightingFacet } from "./editor-view.js";
import {
  PencilWidget,
  TABLE_CONTAINERS,
  fenceBody,
  fenceCaretFilter,
  fenceInfo,
  fenceOptions,
  fillsLines,
  headedFenceAt,
  isLive,
  isMermaidFence,
  isRawBlock,
  liveFocusField,
  mermaidFacet,
  pencilButton,
  pressPencil,
  rawBlockKeymap,
  rawBlocksField,
  setLiveFocus
} from "./editor-live-blocks.js";
import { focusedCell, gridExtension, gridTable, tableMouseStyle } from "./editor-table-grid.js";
import { isSafeMarkdownUrl, renderMarkdown, resolveLinkAction } from "./markdown.js";
import { scrollToAnchor } from "./editor-anchors.js";
import { buildHunkElement, languageForPath, reviewHunkMeta } from "./diff-hunk.js";
import { highlightRanges } from "./syntax-highlighting.js";
import { paintSourceMarks } from "./source-map.js";
import { paintDots, paintMarks, setHunkComposer } from "./hunk-comments.js";
import {
  hunkFenceAt,
  hunkLineRange,
  hunkMarks,
  hunkOffsetPosition,
  hunkSpanRange,
  reviewHunkFence,
  setFenceReviewed
} from "./editor-hunks.js";
import {
  activeComment,
  commentComposer,
  commentRanges,
  commentsDiffer,
  composerHost,
  createComposerElement,
  selectComment,
  shownComments,
  startCommentAt
} from "./editor-comments.js";

const TABLE_CACHE_LIMIT = 200;
const tableHtmlCache = new Map();

export function __tableCacheSize() {
  return tableHtmlCache.size;
}

function tableHtml(source) {
  let html = tableHtmlCache.get(source);
  if (html === undefined) {
    html = renderMarkdown(source, "", undefined, { positions: true });
    tableHtmlCache.set(source, html);
    if (tableHtmlCache.size > TABLE_CACHE_LIMIT) {
      tableHtmlCache.delete(tableHtmlCache.keys().next().value);
    }
  }
  return html;
}

function revealedLines(state, focused) {
  if (!focused) return [];
  return state.selection.ranges.map(range => [
    state.doc.lineAt(range.from).number,
    state.doc.lineAt(range.to).number
  ]);
}

function touchesRevealed(state, revealed, from, to) {
  if (!revealed.length) return false;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  return revealed.some(([start, end]) => start <= last && end >= first);
}

class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }

  eq(other) {
    return other.checked === this.checked;
  }

  toDOM() {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-lp-task";
    input.checked = this.checked;
    input.tabIndex = -1;
    return input;
  }

  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const hr = document.createElement("hr");
    hr.className = "cm-lp-hr-widget";
    return hr;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt) {
    super();
    this.src = src;
    this.alt = alt;
  }

  eq(other) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.alt = this.alt;
    img.src = this.src;
    return img;
  }
}

const MERMAID_TYPING_PAUSE_MS = 300;

const followFacet = Facet.define({ combine: values => values.find(Boolean) ?? null });

function followHref(view, href) {
  const follow = view.state.facet(followFacet);
  if (follow) follow(view, href);
}

const CLICK_SLOP_PX = 4;

// A press on a link follows it on release, unless the pointer travelled: then it
// is a drag that selects text, as it would anywhere else in the editor. A
// `style` (a CodeMirror mouse selection style) picks the selection for the drag.
function pressLink(view, event, href, style = null) {
  event.preventDefault();
  const doc = view.dom.ownerDocument;
  const start = { x: event.clientX, y: event.clientY };
  const link = eventElement(event)?.closest(".cm-lp-link, a[href]");
  let dragging = false;
  let anchor = null;
  const end = () => {
    doc.removeEventListener("mousemove", onMove, true);
    doc.removeEventListener("mouseup", onUp, true);
  };
  const onMove = move => {
    if (move.buttons === 0) {
      end();
      return;
    }
    if (!dragging) {
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) <= CLICK_SLOP_PX) return;
      dragging = true;
      view.focus();
      if (!style) anchor = view.posAtCoords(start) ?? view.posAtDOM(link);
    }
    const selection = style
      ? style.get(move, false, false)
      : EditorSelection.single(anchor, view.posAtCoords({ x: move.clientX, y: move.clientY }) ?? anchor);
    view.dispatch({ selection, userEvent: "select.pointer" });
  };
  const onUp = up => {
    end();
    if (!dragging && Math.hypot(up.clientX - start.x, up.clientY - start.y) <= CLICK_SLOP_PX) {
      followHref(view, href);
    }
  };
  doc.addEventListener("mousemove", onMove, true);
  doc.addEventListener("mouseup", onUp, true);
}

function showMermaid(wrapper, view, widget) {
  const { renderer, source } = widget;
  wrapper.dataset.source = source;
  // fill replaces every child, the pencil included.
  const fill = result => {
    renderer.fill(wrapper, result);
    if (wrapper.pencil) wrapper.append(wrapper.pencil);
  };
  const hit = renderer.cached(source);
  if (hit) {
    fill(hit);
    return;
  }
  renderer.render(source).then(result => {
    if (wrapper.dataset.source !== source || !wrapper.isConnected) return;
    fill(result);
    view.requestMeasure();
  });
}

// "block" replaces the fenced block; "preview" sits under its revealed source.
class MermaidWidget extends WidgetType {
  constructor(source, renderer, kind) {
    super();
    this.source = source;
    this.renderer = renderer;
    this.kind = kind;
    this.generation = renderer.generation;
  }

  eq(other) {
    return other.source === this.source && other.kind === this.kind &&
      other.renderer === this.renderer && other.generation === this.generation;
  }

  toDOM(view) {
    const wrapper = document.createElement("div");
    wrapper.className = `cm-lp-mermaid cm-lp-mermaid-${this.kind}`;
    wrapper.dataset.generation = String(this.generation);
    if (!this.renderer.cached(this.source)) {
      const placeholder = document.createElement("div");
      placeholder.className = "cm-lp-mermaid-pending";
      placeholder.textContent = "Rendering diagram…";
      wrapper.append(placeholder);
    }
    if (this.kind === "block") {
      wrapper.pencil = pencilButton(view.dom.ownerDocument, false, () => pressPencil(view, view.posAtDOM(wrapper)));
    }
    showMermaid(wrapper, view, this);
    if (wrapper.pencil && !wrapper.pencil.isConnected) wrapper.append(wrapper.pencil);
    return wrapper;
  }

  // While typing in the block, keep the last diagram on screen and render once typing pauses.
  updateDOM(dom, view) {
    if (!dom.classList.contains(`cm-lp-mermaid-${this.kind}`)) return false;
    clearTimeout(dom.mermaidTimer);
    const themeChanged = dom.dataset.generation !== String(this.generation);
    dom.dataset.generation = String(this.generation);
    if (themeChanged || this.renderer.cached(this.source)) {
      showMermaid(dom, view, this);
    } else {
      dom.dataset.source = this.source;
      dom.mermaidTimer = setTimeout(() => showMermaid(dom, view, this), MERMAID_TYPING_PAUSE_MS);
    }
    return true;
  }

  destroy(dom) {
    clearTimeout(dom.mermaidTimer);
  }

  ignoreEvent() {
    return true;
  }
}

// Returns whether the composer appeared or went away, which changes the height.
function setTableComposer(dom, view, composer) {
  const existing = dom.querySelector(":scope > .cm-lp-table-composer");
  if (composer && existing?.dataset.key === String(composer.key)) return false;
  existing?.remove();
  if (!composer) return Boolean(existing);
  const row = dom.ownerDocument.createElement("div");
  row.className = "cm-lp-table-composer";
  row.dataset.key = String(composer.key);
  row.append(createComposerElement(view, composer.key));
  dom.append(row);
  return true;
}

function showTableReview(dom, view, widget) {
  paintSourceMarks(dom, widget.review.marks, widget.source);
  if (setTableComposer(dom, view, widget.review.composer)) view.requestMeasure();
}

// Like a hunk, a rendered table draws its own comment tints and hosts the
// composer for text in it, since a replacing widget hides CodeMirror's.
class TableWidget extends WidgetType {
  constructor(source, review) {
    super();
    this.source = source;
    this.review = review;
  }

  eq(other) {
    return other.source === this.source && sameReview(other.review, this.review);
  }

  // Neither focus moving into the composer nor an edit elsewhere in the table
  // may rebuild the composer: it would drop the half-typed text and focus.
  updateDOM(dom, view) {
    if (dom.tableSource !== this.source) {
      for (const child of [...dom.childNodes]) {
        if (!child.classList?.contains("cm-lp-table-composer") && !child.classList?.contains("cm-lp-pencil")) child.remove();
      }
      dom.insertAdjacentHTML("afterbegin", tableHtml(this.source));
      dom.tableSource = this.source;
    }
    showTableReview(dom, view, this);
    return true;
  }

  toDOM(view) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-lp-table markdown-preview";
    wrapper.innerHTML = tableHtml(this.source);
    wrapper.tableSource = this.source;
    showTableReview(wrapper, view, this);
    wrapper.append(pencilButton(view.dom.ownerDocument, false, () => pressPencil(view, view.posAtDOM(wrapper))));
    wrapper.addEventListener("mousedown", event => {
      const element = eventElement(event);
      if (element?.closest(".cm-lp-table-composer, .cm-lp-pencil")) return;
      const link = element?.closest("a[href]");
      if (link && isPlainClick(event) && resolveLinkAction(link.getAttribute("href")).kind !== "ignore") {
        pressLink(view, event, link.getAttribute("href"), tableMouseStyle(view, event));
        return;
      }
      if (!isPrimaryClick(event, view)) return;
      const marked = element?.closest("[data-comment-id]");
      if (marked) {
        event.preventDefault();
        selectComment(view, marked.getAttribute("data-comment-id"));
      }
    });
    return wrapper;
  }

  // A press on a cell goes to CodeMirror, whose mouse selection (see
  // tableMouseStyle) places the caret and drags out cell rectangles.
  ignoreEvent(event) {
    return event.type !== "mousedown" || Boolean(eventElement(event)?.closest(".cm-lp-table-composer, .cm-lp-pencil"));
  }
}

// What a hunk widget shows of the comments: marks on commented code and the
// open composer, when it is for code in this hunk. CodeMirror's own comment
// decorations and composer cannot show inside a replacing widget.
function hunkReview(state, found) {
  const active = activeComment(state);
  const ranges = shownComments(state)
    .filter(comment => !comment.orphaned && comment.state !== "resolved" && comment.to > comment.from)
    .map(comment => ({
      id: comment.id,
      author: comment.author,
      from: comment.from,
      to: comment.to,
      className: `cm-comment cm-comment-${comment.author}${comment.id === active ? " cm-comment-active" : ""}`
    }));
  // One dot per row, for the earliest comment starting there, like the gutter.
  const dots = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    const [mark] = hunkMarks(state, found, [range]);
    if (mark && !dots.some(dot => dot.row === mark.start.row)) dots.push({ row: mark.start.row, id: range.id, author: range.author });
  }
  const composer = commentComposer(state);
  const hosted = composer?.hosted && !composer.outside ? hunkMarks(state, found, [{ ...composer, className: "cm-comment cm-comment-draft" }]) : [];
  return {
    marks: [...hunkMarks(state, found, ranges), ...hosted],
    dots,
    composer: hosted.length ? { key: composer.key, row: hunkOffsetPosition(state, found, composer.to).row } : null
  };
}

const sameReview = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const composerWithin = (composer, from, to) => composer.from >= from && composer.to <= to;

// The comments and the open composer a table widget at `from..to` shows, in
// offsets into the table's source.
function tableReview(state, from, to) {
  const active = activeComment(state);
  const marks = shownComments(state)
    .filter(comment => !comment.orphaned && comment.state !== "resolved" && comment.to > comment.from)
    .flatMap(comment => commentRanges(state, comment)
      .filter(range => range.from < to && range.to > from)
      .map(range => ({
        from: Math.max(range.from, from) - from,
        to: Math.min(range.to, to) - from,
        className: `cm-comment cm-comment-${comment.author}${comment.id === active ? " cm-comment-active" : ""}`,
        id: comment.id
      })));
  const composer = commentComposer(state);
  if (!composer || composer.outside || !composerWithin(composer, from, to)) return { marks, composer: null };
  for (const range of commentRanges(state, composer)) {
    marks.push({ from: range.from - from, to: range.to - from, className: "cm-comment cm-comment-draft" });
  }
  return { marks, composer: { key: composer.key } };
}

// A click in the editor's margin level with a hunk widget would put the cursor
// inside the fence and reveal it. Revealing is for the path click only.
function besideHunk(view, element, y) {
  if (element.closest(".cm-lp-hunk")) return false;
  for (const hunk of view.contentDOM.querySelectorAll(".cm-lp-hunk")) {
    const box = hunk.getBoundingClientRect();
    if (box.height > 0 && y >= box.top && y <= box.bottom) return true;
  }
  return false;
}

function showReview(dom, view, review) {
  paintMarks(dom, review.marks);
  paintDots(dom, review.dots);
  const resized = setHunkComposer(dom, review.composer, () => createComposerElement(view, review.composer.key));
  if (resized) view.requestMeasure();
}

// A review-book diff hunk. Its controls write to the document; clicking the
// path reveals the fence for editing. Code is selected inside the widget and
// commented on there, so reading a hunk never turns it back into source.
class HunkWidget extends WidgetType {
  constructor(info, body, review) {
    super();
    this.info = info;
    this.body = body;
    this.review = review;
  }

  eq(other) {
    return other.info === this.info && other.body === this.body && sameReview(other.review, this.review);
  }

  // Comments changing must not rebuild the widget: a rebuilt widget far above
  // the viewport moves the reader (see dispatchChange in editor-hunks.js).
  updateDOM(dom, view) {
    if (dom.hunkInfo !== this.info || dom.hunkBody !== this.body) return false;
    showReview(dom, view, this.review);
    return true;
  }

  toDOM(view) {
    let element = null;
    const fenceHere = () => hunkFenceAt(view.state, view.posAtDOM(element));
    const comment = range => {
      if (range) startCommentAt(view, range.from, range.to, { hosted: true });
    };
    element = buildHunkElement(view.dom.ownerDocument, {
      meta: reviewHunkMeta(this.info),
      body: this.body,
      hljs: view.dom.ownerDocument.defaultView?.hljs ?? null,
      onToggleReviewed: reviewed => {
        const found = fenceHere();
        if (found) setFenceReviewed(view, found, reviewed);
      },
      onLineComment: index => {
        const found = fenceHere();
        if (found) comment(hunkLineRange(view.state, found, index));
      },
      // Collapsing changes the widget's height behind CodeMirror's back.
      onToggleCollapsed: () => view.requestMeasure(),
      codeComments: {
        // A focused editor would take the selection as a caret at the widget
        // and reveal the fence.
        onStart: () => {
          if (view.hasFocus) view.contentDOM.blur();
        },
        onComment: span => {
          const found = fenceHere();
          if (found) comment(hunkSpanRange(view.state, found, span));
        },
        onMarkClick: id => selectComment(view, id)
      }
    });
    element.hunkInfo = this.info;
    element.hunkBody = this.body;
    showReview(element, view, this.review);
    element.classList.add("cm-lp-hunk");
    element.querySelector(".diff-hunk-path").addEventListener("mousedown", event => {
      if (!isPrimaryClick(event, view)) return;
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(element)) });
      view.focus();
    });
    return element;
  }

  ignoreEvent() {
    return true;
  }
}

// The label a fenced code block shows in place of its opening fence.
class FenceLabelWidget extends WidgetType {
  constructor(label, from) {
    super();
    this.label = label;
    this.from = from;
  }

  eq(other) {
    return other.label === this.label && other.from === this.from;
  }

  toDOM(view) {
    const wrapper = view.dom.ownerDocument.createElement("span");
    wrapper.className = "cm-lp-fence-head";
    const label = view.dom.ownerDocument.createElement("span");
    label.className = "cm-lp-fence-label";
    label.textContent = this.label;
    label.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      const fence = headedFenceAt(view.state, view.posAtDOM(label), fenceOptions(view.state));
      if (!fence) return;
      event.preventDefault();
      view.dispatch({ selection: EditorSelection.cursor(fence.first.from), userEvent: "select" });
      view.focus();
    });
    wrapper.append(label, pencilButton(view.dom.ownerDocument, false, () => pressPencil(view, this.from)));
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }
}

const bulletWidget = Decoration.replace({ widget: new BulletWidget() });
const ruleWidget = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});
const codeMark = Decoration.mark({ class: "cm-lp-code" });
// Prose in Live keeps one style for all emphasis; a grid cell matches the
// rendered table instead.
const cellEmphasis = {
  StrongEmphasis: Decoration.mark({ class: "cm-lp-strong" }),
  Emphasis: Decoration.mark({ class: "cm-lp-em" }),
  Strikethrough: Decoration.mark({ class: "cm-lp-del" })
};
const blockedImageMark = Decoration.mark({ class: "cm-lp-image-blocked" });
const lineClasses = {};
for (const name of ["h1", "h2", "h3", "h4", "h5", "h6", "quote", "codeblock", "hr", "gap"]) {
  lineClasses[name] = Decoration.line({ class: `cm-lp-${name}` });
}
const headingLines = new Map();
const headingLine = classes => {
  if (!headingLines.has(classes)) headingLines.set(classes, Decoration.line({ class: classes }));
  return headingLines.get(classes);
};
for (const name of ["head", "foot", "highlighted"]) {
  lineClasses[`codeblock-${name}`] = Decoration.line({ class: `cm-lp-codeblock cm-lp-codeblock-${name}` });
}
lineClasses["codeblock-head-caret"] = Decoration.line({ class: "cm-lp-codeblock cm-lp-codeblock-head cm-lp-codeblock-caret" });

const FENCE_PATH = /(?:^|\s)(?:path|file|filename|title)=(?:"([^"]*)"|'([^']*)'|(\S+))/;

/**
 * What a fenced code block's header shows: the file named by `path=`, `file=`,
 * `filename=` or `title=`, else the language, else "code". `language` is the
 * Highlight.js language that colors it, from the info string or the file's
 * extension, or "" when there is none.
 */
export function codeFenceMeta(info, hljs = null) {
  const trimmed = info.trim();
  const first = trimmed.split(/\s+/, 1)[0];
  const named = first && !first.includes("=") ? first : "";
  const match = FENCE_PATH.exec(trimmed);
  const path = match ? match[1] ?? match[2] ?? match[3] : "";
  let language = named && hljs?.getLanguage?.(named) ? named : "";
  if (!language && path && hljs) {
    const fromPath = languageForPath(path, hljs);
    if (fromPath !== "diff") language = fromPath;
  }
  return { label: path || named || "code", language };
}

// Highlighting reruns whenever the live preview rebuilds, so keep the last few
// blocks' tokens rather than highlighting on every cursor move.
const HIGHLIGHT_CACHE_SIZE = 64;
const highlightCache = new Map();
const tokenMarks = new Map();

function fenceTokens(code, language, hljs) {
  const key = `${language}\n${code}`;
  let tokens = highlightCache.get(key);
  if (!tokens) {
    tokens = highlightRanges(code, language, hljs);
    if (highlightCache.size >= HIGHLIGHT_CACHE_SIZE) highlightCache.delete(highlightCache.keys().next().value);
    highlightCache.set(key, tokens);
  }
  return tokens;
}

function tokenMark(className) {
  let mark = tokenMarks.get(className);
  if (!mark) tokenMarks.set(className, mark = Decoration.mark({ class: className }));
  return mark;
}

const linkMark = href => Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": linkDestination(href) } });

function linkDestination(raw) {
  const trimmed = raw.trim();
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

function headingLevel(name) {
  const match = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function buildInline(view) {
  const { state } = view;
  const { doc } = state;
  const revealed = revealedLines(state, state.field(liveFocusField));
  const ranges = [];
  const lineDecorations = new Map();
  const handled = new Set();
  const gridded = gridTable(state);
  const cell = gridded && focusedCell(gridded);

  // In a grid table only the focused cell shows its Markdown.
  const isRevealed = (from, to) => gridded && from >= gridded.from && to <= gridded.to
    ? from <= cell.segTo && to >= cell.segFrom
    : touchesRevealed(state, revealed, from, to);
  const singleLine = (from, to) => to > from && !doc.sliceString(from, to).includes("\n");
  const hide = (from, to) => {
    if (singleLine(from, to)) ranges.push(hidden.range(from, to));
  };
  const markLines = (from, to, kind, rangeFrom, rangeTo) => {
    let pos = Math.max(from, rangeFrom);
    const end = Math.min(to, rangeTo);
    while (pos <= end) {
      const line = doc.lineAt(pos);
      if (!lineDecorations.has(line.from)) lineDecorations.set(line.from, lineClasses[kind]);
      pos = line.to + 1;
    }
  };
  const followingSpace = to => (doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  const hljs = state.facet(syntaxHighlightingFacet) ? view.dom.ownerDocument.defaultView?.hljs ?? null : null;

  // The opening fence turns into a header naming the file or language, the
  // closing one into the block's bottom edge, each until the cursor is on it.
  function handleFence(node, rangeFrom, rangeTo) {
    const info = fenceInfo(state, node);
    // Diagrams and review hunks are block widgets; their source shows as is.
    if (reviewHunkMeta(info) !== null || (state.facet(mermaidFacet) && isMermaidFence(state, node))) {
      markLines(node.from, node.to, "codeblock", rangeFrom, rangeTo);
      return;
    }
    const meta = codeFenceMeta(info, hljs);
    const text = node.getChild("CodeText");
    markLines(node.from, node.to, meta.language ? "codeblock-highlighted" : "codeblock", rangeFrom, rangeTo);
    const marks = node.getChildren("CodeMark");
    if (!marks.length) return;
    const open = doc.lineAt(node.from);
    const raw = isRawBlock(state, node.from);
    lineDecorations.set(open.from, lineClasses[isRevealed(node.from, node.to) ? "codeblock-head-caret" : "codeblock-head"]);
    const headed = !raw && headedFenceAt(state, node.from, fenceOptions(state)) !== null;
    let close = marks.length > 1 ? doc.lineAt(marks.at(-1).from) : null;
    if (close && (close.from === open.from || raw || (!headed && isRevealed(close.from, close.to)))) close = null;
    if (close) lineDecorations.set(close.from, lineClasses["codeblock-foot"]);
    if (handled.has(`fence:${node.from}`)) return;
    handled.add(`fence:${node.from}`);
    if (raw) {
      ranges.push(Decoration.widget({ widget: new PencilWidget(node.from, true), side: 1 }).range(open.to));
    } else if (headed || !isRevealed(open.from, open.to)) {
      ranges.push(Decoration.replace({ widget: new FenceLabelWidget(meta.label, node.from) }).range(marks[0].from, open.to));
    }
    if (close) hide(marks.at(-1).from, marks.at(-1).to);
    if (text && meta.language) {
      for (const token of fenceTokens(doc.sliceString(text.from, text.to), meta.language, hljs)) {
        ranges.push(tokenMark(token.className).range(text.from + token.from, text.from + token.to));
      }
    }
  }

  function handleLink(node) {
    const marks = node.getChildren("LinkMark");
    const url = node.getChild("URL");
    if (marks.length < 2 || !url) return;
    const textFrom = marks[0].to;
    const textTo = marks[1].from;
    if (isRevealed(node.from, node.to)) return;
    if (!singleLine(node.from, node.to)) return;
    hide(marks[0].from, marks[0].to);
    if (textTo > textFrom) {
      ranges.push(linkMark(doc.sliceString(url.from, url.to)).range(textFrom, textTo));
    }
    hide(marks[1].from, node.to);
  }

  function handleImage(node) {
    const url = node.getChild("URL");
    const src = url ? doc.sliceString(url.from, url.to).trim() : "";
    const safe = src && isSafeMarkdownUrl(src, true) && src.toLowerCase().startsWith("data:image/");
    if (!safe) {
      ranges.push(blockedImageMark.range(node.from, node.to));
      return;
    }
    if (isRevealed(node.from, node.to) || !singleLine(node.from, node.to)) return;
    const marks = node.getChildren("LinkMark");
    const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
    ranges.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
  }

  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from: rangeFrom,
      to: rangeTo,
      enter: ref => {
        const { name, from, to } = ref;
        const key = `${name}:${from}:${to}`;
        const seen = handled.has(key);
        handled.add(key);

        const level = headingLevel(name);
        if (level) {
          const underline = name.startsWith("Setext") ? ref.node.getChild("HeaderMark") : null;
          const textEnd = underline ? doc.lineAt(underline.from).from - 1 : to;
          markLines(from, textEnd, `h${level}`, rangeFrom, rangeTo);
          const first = doc.lineAt(from).number;
          const last = doc.lineAt(textEnd).number;
          for (let n = Math.max(first, doc.lineAt(rangeFrom).number); n <= Math.min(last, doc.lineAt(rangeTo).number); n++) {
            const line = doc.line(n);
            const existing = lineDecorations.get(line.from);
            const quoted = existing === lineClasses.quote;
            if (existing !== lineClasses[`h${level}`] && !quoted) continue;
            const classes = [`cm-lp-h${level}`];
            if (quoted) classes.push("cm-lp-quote");
            if (level <= 2 && n === last) classes.push("cm-lp-heading-rule");
            if (n > first) classes.push("cm-lp-heading-cont");
            if (n < last) classes.push("cm-lp-heading-more");
            if (classes.length > 1) lineDecorations.set(line.from, headingLine(classes.join(" ")));
          }
          return true;
        }

        switch (name) {
          case "Blockquote":
            markLines(from, to, "quote", rangeFrom, rangeTo);
            return true;
          case "FencedCode":
            handleFence(ref.node, rangeFrom, rangeTo);
            return false;
          case "HorizontalRule":
            markLines(from, to, "hr", rangeFrom, rangeTo);
            if (!seen && !isRevealed(from, to) && singleLine(from, to)) ranges.push(ruleWidget.range(from, to));
            return false;
          case "Table":
            return gridded?.from === from;
          case "CodeBlock":
          case "HTMLBlock":
            return false;
        }

        if (seen) return name !== "Image";

        switch (name) {
          case "HeaderMark": {
            const parent = ref.node.parent;
            if (!parent || isRevealed(parent.from, parent.to)) return false;
            if (parent.name.startsWith("Setext")) {
              hide(from, to);
            } else if (to === parent.to && from > parent.from && doc.sliceString(from - 1, from) === " ") {
              hide(from - 1, to);
            } else {
              hide(from, followingSpace(to));
            }
            return false;
          }
          case "QuoteMark":
            if (!isRevealed(from, to)) hide(from, followingSpace(to));
            return false;
          case "EmphasisMark":
          case "StrikethroughMark": {
            const parent = ref.node.parent;
            if (parent && !isRevealed(parent.from, parent.to)) hide(from, to);
            return false;
          }
          case "InlineCode": {
            if (isRevealed(from, to)) return false;
            const marks = ref.node.getChildren("CodeMark");
            if (marks.length >= 2 && singleLine(from, to)) {
              hide(marks[0].from, marks[0].to);
              if (marks[1].from > marks[0].to) ranges.push(codeMark.range(marks[0].to, marks[1].from));
              hide(marks[1].from, marks[1].to);
            }
            return false;
          }
          case "StrongEmphasis":
          case "Emphasis":
          case "Strikethrough":
            if (gridded && from >= gridded.from && to <= gridded.to && !isRevealed(from, to)) {
              ranges.push(cellEmphasis[name].range(from, to));
            }
            return true;
          case "Link":
            handleLink(ref.node);
            return true;
          case "Image":
            handleImage(ref.node);
            return false;
          case "Autolink": {
            const url = ref.node.getChild("URL");
            if (url && !isRevealed(from, to)) {
              ranges.push(linkMark(doc.sliceString(url.from, url.to)).range(url.from, url.to));
            }
            return false;
          }
          case "URL": {
            const parentName = ref.node.parent?.name;
            if (parentName !== "Link" && parentName !== "Image" && parentName !== "Autolink" && !isRevealed(from, to)) {
              ranges.push(linkMark(doc.sliceString(from, to)).range(from, to));
            }
            return false;
          }
          case "ListMark": {
            if (isRevealed(from, to)) return false;
            const item = ref.node.parent;
            const task = item?.getChild("Task");
            if (task) {
              hide(from, task.from);
            } else if (item?.parent?.name === "BulletList") {
              ranges.push(bulletWidget.range(from, to));
            }
            return false;
          }
          case "TaskMarker": {
            if (isRevealed(from, to)) return false;
            const checked = /^\[[xX]\]$/.test(doc.sliceString(from, to));
            ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to));
            return false;
          }
        }
        return true;
      }
    });
  }

  const verbatim = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "Table"]);
  for (const { from: rangeFrom, to: rangeTo } of view.visibleRanges) {
    for (let n = doc.lineAt(rangeFrom).number; n <= doc.lineAt(rangeTo).number; n++) {
      const line = doc.line(n);
      if (lineDecorations.has(line.from) || line.text.trim() !== "") continue;
      let inside = false;
      for (let node = syntaxTree(state).resolveInner(line.from, 1); node; node = node.parent) {
        if (verbatim.has(node.name)) { inside = true; break; }
      }
      if (!inside) lineDecorations.set(line.from, lineClasses.gap);
    }
  }

  for (const [pos, decoration] of lineDecorations) ranges.push(decoration.range(pos));
  return Decoration.set(ranges, true);
}

const inlinePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = isLive(view.state) ? buildInline(view) : Decoration.none;
  }

  update(update) {
    const modeChanged = isLive(update.startState) !== isLive(update.state);
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const highlightingChanged = update.startState.facet(syntaxHighlightingFacet) !== update.state.facet(syntaxHighlightingFacet);
    if (
      !modeChanged && !treeChanged && !highlightingChanged && !update.docChanged && !update.selectionSet &&
      !update.viewportChanged &&
      update.startState.field(rawBlocksField) === update.state.field(rawBlocksField) &&
      update.startState.field(liveFocusField) === update.state.field(liveFocusField) &&
      commentComposer(update.startState) === commentComposer(update.state)
    ) {
      return;
    }
    this.decorations = isLive(update.state) ? buildInline(update.view) : Decoration.none;
  }
}, { decorations: plugin => plugin.decorations });

const refreshMermaid = StateEffect.define();

// Whether the composer's whole range lies in one table that renders as a widget.
function tableHostsComposer(state, composer) {
  let hosted = false;
  syntaxTree(state).iterate({
    enter: ref => {
      if (hosted) return false;
      if (TABLE_CONTAINERS.has(ref.name)) return true;
      if (ref.name === "Table" && fillsLines(state.doc, ref) && composerWithin(composer, ref.from, ref.to)) hosted = true;
      return false;
    }
  });
  return hosted;
}

function buildBlocks(state) {
  if (!isLive(state)) return Decoration.none;
  const { doc } = state;
  const mermaid = state.facet(mermaidFacet);
  const revealed = revealedLines(state, state.field(liveFocusField));
  const gridFrom = gridTable(state)?.from;
  const opened = commentComposer(state);
  // A Reading composer is drawn in the preview, never in a table here.
  const composer = opened?.outside ? null : opened;
  const ranges = [];
  syntaxTree(state).iterate({
    enter: ref => {
      if (TABLE_CONTAINERS.has(ref.name)) return true;
      const isTable = ref.name === "Table";
      const isMermaid = mermaid && ref.name === "FencedCode" && isMermaidFence(state, ref.node);
      const hunkInfo = ref.name === "FencedCode" && !isMermaid ? fenceInfo(state, ref.node) : "";
      const isHunk = hunkInfo !== "" && reviewHunkMeta(hunkInfo) !== null;
      if (!isTable && !isMermaid && !isHunk) return false;
      if (!fillsLines(doc, ref)) return false;
      const start = doc.lineAt(ref.from);
      const end = doc.lineAt(ref.to);
      const inside = touchesRevealed(state, revealed, ref.from, ref.to);
      if (isTable && isRawBlock(state, ref.from)) {
        ranges.push(Decoration.widget({ widget: new PencilWidget(ref.from, true), side: 1 }).range(start.to));
        return false;
      }
      if (isTable) {
        // A composer reaching past the table is drawn under its last line,
        // which a widget would hide.
        const hosts = composer !== null && composerWithin(composer, ref.from, ref.to);
        const partial = composer !== null && !hosts && composer.from < ref.to && composer.to > ref.from;
        if (!hosts && (partial || gridFrom === ref.from)) return false;
        if (!inside || hosts) {
          const source = doc.sliceString(ref.from, ref.to);
          const widget = new TableWidget(source, tableReview(state, ref.from, ref.to));
          ranges.push(Decoration.replace({ widget, block: true }).range(start.from, end.to));
        }
        return false;
      }
      if (isHunk) {
        if (!inside) {
          const review = hunkReview(state, reviewHunkFence(state, ref.node));
          const widget = new HunkWidget(hunkInfo, fenceBody(state, ref.node), review);
          ranges.push(Decoration.replace({ widget, block: true }).range(start.from, end.to));
        }
        return false;
      }
      const source = fenceBody(state, ref.node);
      const raw = isRawBlock(state, ref.from);
      if (inside || raw) {
        if (raw) ranges.push(Decoration.widget({ widget: new PencilWidget(ref.from, true), side: 1 }).range(start.to));
        ranges.push(Decoration.widget({ widget: new MermaidWidget(source, mermaid, "preview"), block: true, side: 1 }).range(end.to));
      } else {
        ranges.push(Decoration.replace({ widget: new MermaidWidget(source, mermaid, "block"), block: true }).range(start.from, end.to));
      }
      return false;
    }
  });
  return Decoration.set(ranges, true);
}

const blockField = StateField.define({
  create: state => buildBlocks(state),
  update(value, tr) {
    const refreshed = tr.effects.some(effect => effect.is(refreshMermaid));
    const changed = tr.startState.field(liveFocusField) !== tr.state.field(liveFocusField) ||
      refreshed ||
      tr.docChanged ||
      tr.selection !== undefined ||
      commentsDiffer(tr.startState, tr.state) ||
      tr.startState.field(rawBlocksField) !== tr.state.field(rawBlocksField) ||
      isLive(tr.startState) !== isLive(tr.state) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!changed) return value;
    return buildBlocks(tr.state);
  },
  provide: field => EditorView.decorations.from(field)
});

// Code blocks get their background from a layer under the selection's, since a
// background on the lines themselves would paint over the selection and hide it.
// Blocks shown as a widget (diagrams, review hunks) draw their own.
const codeBlockLayer = layer({
  above: false,
  class: "cm-lp-codeblock-layer",
  update: update =>
    update.docChanged || update.viewportChanged || update.focusChanged ||
    isLive(update.startState) !== isLive(update.state) ||
    update.startState.field(blockField) !== update.state.field(blockField),
  markers(view) {
    if (!isLive(view.state)) return [];
    const line = view.contentDOM.querySelector(".cm-line");
    if (!line) return [];
    const scroller = view.scrollDOM.getBoundingClientRect();
    const box = line.getBoundingClientRect();
    const left = box.left - scroller.left + view.scrollDOM.scrollLeft;
    const top = view.documentTop - scroller.top + view.scrollDOM.scrollTop;
    const widgets = view.state.field(blockField);
    const markers = [];
    const drawn = new Set();
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: ref => {
          if (ref.name !== "FencedCode") return true;
          if (drawn.has(ref.from)) return false;
          drawn.add(ref.from);
          let shownAsWidget = false;
          widgets.between(ref.from, ref.to, (start, end) => {
            if (end > start) shownAsWidget = true;
          });
          if (shownAsWidget) return false;
          const first = view.lineBlockAt(ref.from);
          const last = view.lineBlockAt(ref.to);
          markers.push(new RectangleMarker("cm-lp-codeblock-bg", left, top + first.top, box.width, last.bottom - first.top));
          return false;
        }
      });
    }
    return markers;
  }
});

const blockFocusSync = EditorView.updateListener.of(update => {
  const { view } = update;
  if (update.state.field(liveFocusField) === view.hasFocus) return;
  queueMicrotask(() => {
    const focused = view.state.field(liveFocusField, false);
    if (focused !== undefined && focused !== view.hasFocus) {
      view.dispatch({ effects: setLiveFocus.of(view.hasFocus) });
    }
  });
});

const mermaidThemeSync = ViewPlugin.fromClass(class {
  constructor(view) {
    const renderer = view.state.facet(mermaidFacet);
    this.unsubscribe = renderer?.onChange(() => view.dispatch({ effects: refreshMermaid.of(null) }));
  }

  destroy() {
    this.unsubscribe?.();
  }
});

function eventElement(event) {
  const target = event.target;
  return target && target.nodeType === 1 ? target : target?.parentElement ?? null;
}

function isMacNavigator(nav) {
  const platform = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// macOS turns Ctrl-click into a right-click.
function isMacView(view) {
  return isMacNavigator(view.dom.ownerDocument.defaultView?.navigator ?? globalThis.navigator);
}

function isPlainClick(event) {
  return event.button === 0 && event.detail < 2 && !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey);
}

function isPrimaryClick(event, view) {
  return event.button === 0 && !(event.ctrlKey && isMacView(view));
}

/**
 * Obsidian-style live preview: Markdown syntax is hidden and rendered inline,
 * except on lines the selection touches while the editor has focus. Inert
 * unless the mode facet is "live".
 *
 * @param {object} [options]
 * @param {(href: string) => void} [options.onOpenLink] called when a link is followed by a plain
 *   click; Cmd-click (Ctrl-click off macOS) places the caret instead. `#anchor` links go to
 *   onFollowAnchor instead
 * @param {(fragment: string) => void} [options.onFollowAnchor] called for `#anchor` links; without
 *   one, the editor scrolls to the anchor itself
 * @param {object} [options.mermaid] a renderer from createMermaidRenderer; without one,
 *   mermaid blocks stay code blocks
 */
export function livePreview({ onOpenLink, onFollowAnchor, mermaid } = {}) {
  const follow = (view, href) => {
    const action = resolveLinkAction(href);
    if (action.kind === "anchor") {
      if (onFollowAnchor) onFollowAnchor(action.fragment);
      else scrollToAnchor(view, action.fragment);
    } else if (action.kind !== "ignore") {
      onOpenLink?.(href);
    }
  };
  const handlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!isLive(view.state)) return false;
      const element = eventElement(event);
      if (!element) return false;

      if (isPrimaryClick(event, view) && besideHunk(view, element, event.clientY)) {
        event.preventDefault();
        return true;
      }

      const task = element.closest(".cm-lp-task");
      if (task) {
        if (!isPrimaryClick(event, view)) return false;
        const from = view.posAtDOM(task);
        const marker = view.state.doc.sliceString(from, from + 3);
        if (/^\[[ xX]\]$/.test(marker)) {
          const checked = marker !== "[ ]";
          view.dispatch({
            changes: { from, to: from + 3, insert: checked ? "[ ]" : "[x]" },
            userEvent: "input"
          });
        }
        event.preventDefault();
        return true;
      }

      const link = element.closest(".cm-lp-link");
      if (link && isPlainClick(event)) {
        const href = link.getAttribute("data-href") ?? "";
        if (resolveLinkAction(href).kind === "ignore") return false;
        pressLink(view, event, href);
        return true;
      }
      return false;
    }
  });

  return [
    mermaidFacet.of(mermaid ?? null),
    liveFocusField,
    fenceCaretFilter,
    rawBlocksField,
    gridExtension(),
    rawBlockKeymap,
    followFacet.of(follow),
    composerHost.of((state, composer) => isLive(state) && tableHostsComposer(state, composer)),
    blockField,
    codeBlockLayer,
    blockFocusSync,
    mermaidThemeSync,
    inlinePreview,
    handlers
  ];
}
