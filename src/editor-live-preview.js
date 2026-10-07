// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Decoration,
  EditorSelection,
  EditorView,
  Facet,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType,
  syntaxTree
} from "./vendor/codemirror.js";
import { modeFacet } from "./editor-view.js";
import { isSafeMarkdownUrl, renderMarkdown, resolveLinkAction } from "./markdown.js";
import { scrollToAnchor } from "./editor-anchors.js";
import { buildHunkElement, reviewHunkMeta } from "./diff-hunk.js";
import { hunkFenceAt, selectHunkLine, setFenceReviewed } from "./editor-hunks.js";
import { startComment } from "./editor-comments.js";

const TABLE_CACHE_LIMIT = 200;
const tableHtmlCache = new Map();

export function __tableCacheSize() {
  return tableHtmlCache.size;
}

function tableHtml(source) {
  let html = tableHtmlCache.get(source);
  if (html === undefined) {
    html = renderMarkdown(source);
    tableHtmlCache.set(source, html);
    if (tableHtmlCache.size > TABLE_CACHE_LIMIT) {
      tableHtmlCache.delete(tableHtmlCache.keys().next().value);
    }
  }
  return html;
}

const isLive = state => state.facet(modeFacet) === "live";

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

const mermaidFacet = Facet.define({ combine: values => values.find(Boolean) ?? null });
const followFacet = Facet.define({ combine: values => values.find(Boolean) ?? null });

function followHref(view, href) {
  const follow = view.state.facet(followFacet);
  if (follow) follow(view, href);
}

function showMermaid(wrapper, view, widget) {
  const { renderer, source } = widget;
  wrapper.dataset.source = source;
  const hit = renderer.cached(source);
  if (hit) {
    renderer.fill(wrapper, hit);
    return;
  }
  renderer.render(source).then(result => {
    if (wrapper.dataset.source !== source || !wrapper.isConnected) return;
    renderer.fill(wrapper, result);
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
    showMermaid(wrapper, view, this);
    if (this.kind === "block") {
      wrapper.addEventListener("mousedown", event => {
        if (!isPrimaryClick(event, view)) return;
        event.preventDefault();
        view.dispatch({ selection: EditorSelection.cursor(view.posAtDOM(wrapper)) });
        view.focus();
      });
    }
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

class TableWidget extends WidgetType {
  constructor(source) {
    super();
    this.source = source;
  }

  eq(other) {
    return other.source === this.source;
  }

  toDOM(view) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-lp-table markdown-preview";
    wrapper.innerHTML = tableHtml(this.source);
    wrapper.addEventListener("mousedown", event => {
      const link = eventElement(event)?.closest("a[href]");
      if (link && isOpenLinkClick(event, view)) {
        event.preventDefault();
        followHref(view, link.getAttribute("href"));
        return;
      }
      if (!isPrimaryClick(event, view)) return;
      event.preventDefault();
      const anchor = view.posAtDOM(wrapper);
      view.dispatch({ selection: EditorSelection.cursor(anchor) });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }
}

// A review-book diff hunk. Its controls write to the document; clicking the
// path reveals the fence for editing.
class HunkWidget extends WidgetType {
  constructor(info, body) {
    super();
    this.info = info;
    this.body = body;
  }

  eq(other) {
    return other.info === this.info && other.body === this.body;
  }

  toDOM(view) {
    let element = null;
    const fenceHere = () => hunkFenceAt(view.state, view.posAtDOM(element));
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
        if (!found) return;
        view.focus();
        if (selectHunkLine(view, found, index)) startComment(view);
      },
      // Collapsing changes the widget's height behind CodeMirror's back.
      onToggleCollapsed: () => view.requestMeasure()
    });
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

const bulletWidget = Decoration.replace({ widget: new BulletWidget() });
const ruleWidget = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});
const codeMark = Decoration.mark({ class: "cm-lp-code" });
const blockedImageMark = Decoration.mark({ class: "cm-lp-image-blocked" });
const lineClasses = {};
for (const name of ["h1", "h2", "h3", "h4", "h5", "h6", "quote", "codeblock", "hr"]) {
  lineClasses[name] = Decoration.line({ class: `cm-lp-${name}` });
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

function buildInline(view, focused) {
  const { state } = view;
  const { doc } = state;
  const revealed = revealedLines(state, focused);
  const ranges = [];
  const lineDecorations = new Map();
  const handled = new Set();

  const isRevealed = (from, to) => touchesRevealed(state, revealed, from, to);
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
          return true;
        }

        switch (name) {
          case "Blockquote":
            markLines(from, to, "quote", rangeFrom, rangeTo);
            return true;
          case "FencedCode":
            markLines(from, to, "codeblock", rangeFrom, rangeTo);
            return false;
          case "HorizontalRule":
            markLines(from, to, "hr", rangeFrom, rangeTo);
            if (!seen && !isRevealed(from, to) && singleLine(from, to)) ranges.push(ruleWidget.range(from, to));
            return false;
          case "Table":
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

  for (const [pos, decoration] of lineDecorations) ranges.push(decoration.range(pos));
  return Decoration.set(ranges, true);
}

const inlinePreview = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = isLive(view.state) ? buildInline(view, view.hasFocus) : Decoration.none;
  }

  update(update) {
    const modeChanged = update.startState.facet(modeFacet) !== update.state.facet(modeFacet);
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (
      !modeChanged && !treeChanged && !update.docChanged && !update.selectionSet &&
      !update.viewportChanged && !update.focusChanged
    ) {
      return;
    }
    this.decorations = isLive(update.state) ? buildInline(update.view, update.view.hasFocus) : Decoration.none;
  }
}, { decorations: plugin => plugin.decorations });

const setTableFocus = StateEffect.define();
const refreshMermaid = StateEffect.define();

const TABLE_CONTAINERS = new Set(["Document", "BulletList", "OrderedList", "ListItem"]);

function isMermaidFence(state, node) {
  const info = node.getChild("CodeInfo");
  return info !== null && state.doc.sliceString(info.from, info.to).trim().toLowerCase() === "mermaid";
}

function fenceInfo(state, node) {
  const info = node.getChild("CodeInfo");
  return info ? state.doc.sliceString(info.from, info.to) : "";
}

function fenceBody(state, node) {
  const text = node.getChild("CodeText");
  return text ? state.doc.sliceString(text.from, text.to) : "";
}

function buildBlocks(state, focused) {
  if (!isLive(state)) return Decoration.none;
  const { doc } = state;
  const mermaid = state.facet(mermaidFacet);
  const revealed = revealedLines(state, focused);
  const ranges = [];
  syntaxTree(state).iterate({
    enter: ref => {
      if (TABLE_CONTAINERS.has(ref.name)) return true;
      const isTable = ref.name === "Table";
      const isMermaid = mermaid && ref.name === "FencedCode" && isMermaidFence(state, ref.node);
      const hunkInfo = ref.name === "FencedCode" && !isMermaid ? fenceInfo(state, ref.node) : "";
      const isHunk = hunkInfo !== "" && reviewHunkMeta(hunkInfo) !== null;
      if (!isTable && !isMermaid && !isHunk) return false;
      const start = doc.lineAt(ref.from);
      const end = doc.lineAt(ref.to);
      const prefix = doc.sliceString(start.from, ref.from);
      if (!/^\s*$/.test(prefix) || ref.to !== end.to) return false;
      const inside = touchesRevealed(state, revealed, ref.from, ref.to);
      if (isTable) {
        if (!inside) {
          const source = doc.sliceString(ref.from, ref.to);
          ranges.push(Decoration.replace({ widget: new TableWidget(source), block: true }).range(start.from, end.to));
        }
        return false;
      }
      if (isHunk) {
        if (!inside) {
          const widget = new HunkWidget(hunkInfo, fenceBody(state, ref.node));
          ranges.push(Decoration.replace({ widget, block: true }).range(start.from, end.to));
        }
        return false;
      }
      const source = fenceBody(state, ref.node);
      if (inside) {
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
  create: state => ({ focused: false, decorations: buildBlocks(state, false) }),
  update(value, tr) {
    let { focused } = value;
    let refreshed = false;
    for (const effect of tr.effects) {
      if (effect.is(setTableFocus)) focused = effect.value;
      if (effect.is(refreshMermaid)) refreshed = true;
    }
    const changed = focused !== value.focused ||
      refreshed ||
      tr.docChanged ||
      tr.selection !== undefined ||
      tr.startState.facet(modeFacet) !== tr.state.facet(modeFacet) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!changed) return value;
    return { focused, decorations: buildBlocks(tr.state, focused) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

const blockFocusSync = EditorView.updateListener.of(update => {
  const { view } = update;
  if (update.state.field(blockField).focused === view.hasFocus) return;
  queueMicrotask(() => {
    const field = view.state.field(blockField, false);
    if (field && field.focused !== view.hasFocus) {
      view.dispatch({ effects: setTableFocus.of(view.hasFocus) });
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

// macOS turns Ctrl-click into a right-click, so the link modifier is Cmd there.
function isMacView(view) {
  return isMacNavigator(view.dom.ownerDocument.defaultView?.navigator ?? globalThis.navigator);
}

function isOpenLinkClick(event, view) {
  return isMacView(view) ? event.metaKey : event.ctrlKey;
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
 * @param {(href: string) => void} [options.onOpenLink] called when a link is followed: Cmd-click
 *   (Ctrl-click off macOS) or its hover button; `#anchor` links go to onFollowAnchor instead
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

      if (isOpenLinkClick(event, view)) {
        const link = element.closest(".cm-lp-link");
        if (link) {
          event.preventDefault();
          follow(view, link.getAttribute("data-href") ?? "");
          return true;
        }
      }
      return false;
    }
  });

  return [
    mermaidFacet.of(mermaid ?? null),
    followFacet.of(follow),
    blockField,
    blockFocusSync,
    mermaidThemeSync,
    inlinePreview,
    followButton,
    handlers
  ];
}

const FOLLOW_HIDE_DELAY_MS = 300;
const linkHref = link => link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";

// A plain click places the cursor and reveals a link's Markdown, so hovering a
// rendered link shows a button that follows it without touching the cursor.
// It sits outside the content DOM, where CodeMirror's own handlers never see it.
const followButton = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.link = null;
    this.hideTimer = null;
    const document = view.dom.ownerDocument;
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "cm-lp-follow";
    this.button.setAttribute("aria-label", "Follow link");
    this.button.hidden = true;
    this.button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8" /></svg>';
    this.button.addEventListener("mousedown", event => event.preventDefault());
    this.button.addEventListener("click", event => {
      event.preventDefault();
      const href = this.link ? linkHref(this.link) : "";
      this.hide();
      if (href) followHref(view, href);
    });
    this.button.addEventListener("mouseenter", () => clearTimeout(this.hideTimer));
    this.button.addEventListener("mouseleave", () => this.scheduleHide());
    this.onOver = event => this.over(event);
    this.onScroll = () => this.hide();
    this.onLeave = () => this.scheduleHide();
    view.dom.append(this.button);
    view.dom.addEventListener("mouseover", this.onOver);
    view.dom.addEventListener("mouseleave", this.onLeave);
    view.scrollDOM.addEventListener("scroll", this.onScroll);
  }

  over(event) {
    const element = eventElement(event);
    if (!element || this.button.contains(element)) return;
    const link = isLive(this.view.state) ? element.closest(".cm-lp-link, .cm-lp-table a[href]") : null;
    if (!link) {
      if (this.link) this.scheduleHide();
      return;
    }
    clearTimeout(this.hideTimer);
    if (link === this.link && !this.button.hidden) return;
    const href = linkHref(link);
    if (resolveLinkAction(href).kind === "ignore") return;
    this.link = link;
    const rects = link.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : link.getBoundingClientRect();
    const host = this.view.dom.getBoundingClientRect();
    this.button.style.left = `${rect.right - host.left + 2}px`;
    this.button.style.top = `${rect.top - host.top + (rect.height - 18) / 2}px`;
    this.button.title = `Follow link: ${href}`;
    this.button.hidden = false;
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), FOLLOW_HIDE_DELAY_MS);
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.link = null;
    this.button.hidden = true;
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) this.hide();
  }

  destroy() {
    clearTimeout(this.hideTimer);
    this.view.dom.removeEventListener("mouseover", this.onOver);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.button.remove();
  }
});
