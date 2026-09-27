// SPDX-License-Identifier: GPL-3.0-or-later

import {
  Decoration,
  EditorSelection,
  EditorView,
  StateEffect,
  StateField,
  ViewPlugin,
  WidgetType,
  syntaxTree
} from "./vendor/codemirror.js";
import { modeFacet } from "./editor-view.js";
import { isSafeMarkdownUrl, renderMarkdown } from "./markdown.js";

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

const bulletWidget = Decoration.replace({ widget: new BulletWidget() });
const ruleWidget = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});
const codeMark = Decoration.mark({ class: "cm-lp-code" });
const blockedImageMark = Decoration.mark({ class: "cm-lp-image-blocked" });
const lineClasses = {};
for (const name of ["h1", "h2", "h3", "h4", "h5", "h6", "quote", "codeblock", "hr"]) {
  lineClasses[name] = Decoration.line({ class: `cm-lp-${name}` });
}

const linkMark = href => Decoration.mark({ class: "cm-lp-link", attributes: { "data-href": href } });

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

const TABLE_CONTAINERS = new Set(["Document", "BulletList", "OrderedList", "ListItem"]);

function buildTables(state, focused) {
  if (!isLive(state)) return Decoration.none;
  const { doc } = state;
  const revealed = revealedLines(state, focused);
  const ranges = [];
  syntaxTree(state).iterate({
    enter: ref => {
      if (TABLE_CONTAINERS.has(ref.name)) return true;
      if (ref.name !== "Table") return false;
      const start = doc.lineAt(ref.from);
      const end = doc.lineAt(ref.to);
      const prefix = doc.sliceString(start.from, ref.from);
      if (/^\s*$/.test(prefix) && ref.to === end.to && !touchesRevealed(state, revealed, ref.from, ref.to)) {
        const source = doc.sliceString(ref.from, ref.to);
        ranges.push(Decoration.replace({ widget: new TableWidget(source), block: true }).range(start.from, end.to));
      }
      return false;
    }
  });
  return Decoration.set(ranges);
}

const tableField = StateField.define({
  create: state => ({ focused: false, decorations: buildTables(state, false) }),
  update(value, tr) {
    let { focused } = value;
    for (const effect of tr.effects) {
      if (effect.is(setTableFocus)) focused = effect.value;
    }
    const changed = focused !== value.focused ||
      tr.docChanged ||
      tr.selection !== undefined ||
      tr.startState.facet(modeFacet) !== tr.state.facet(modeFacet) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (!changed) return value;
    return { focused, decorations: buildTables(tr.state, focused) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations)
});

const tableFocusSync = EditorView.updateListener.of(update => {
  const { view } = update;
  if (update.state.field(tableField).focused === view.hasFocus) return;
  queueMicrotask(() => {
    const field = view.state.field(tableField, false);
    if (field && field.focused !== view.hasFocus) {
      view.dispatch({ effects: setTableFocus.of(view.hasFocus) });
    }
  });
});

function eventElement(event) {
  const target = event.target;
  return target && target.nodeType === 1 ? target : target?.parentElement ?? null;
}

/**
 * Obsidian-style live preview: Markdown syntax is hidden and rendered inline,
 * except on lines the selection touches while the editor has focus. Inert
 * unless the mode facet is "live".
 *
 * @param {object} [options]
 * @param {(href: string) => void} [options.onOpenLink] called on Cmd/Ctrl-click of a link
 */
export function livePreview({ onOpenLink } = {}) {
  const handlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!isLive(view.state)) return false;
      const element = eventElement(event);
      if (!element) return false;

      const task = element.closest(".cm-lp-task");
      if (task) {
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

      if (event.metaKey || event.ctrlKey) {
        const link = element.closest(".cm-lp-link");
        if (link) {
          event.preventDefault();
          onOpenLink?.(link.getAttribute("data-href") ?? "");
          return true;
        }
      }
      return false;
    }
  });

  return [tableField, tableFocusSync, inlinePreview, handlers];
}
