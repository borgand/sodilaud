// SPDX-License-Identifier: GPL-3.0-or-later

import { HUNK_ID, addHeadingAnchors, decodeFragment, hunkIdFromInfo } from "./anchors.js";
import { HUNK_LINES, HUNK_PATH, reviewHunkMeta } from "./diff-hunk.js";
import { SOURCE_FROM, SOURCE_TO } from "./source-map.js";

const MARKDOWN_ALLOWED_TAGS = new Set([
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul"
]);

const MARKDOWN_DROP_CONTENT_TAGS = new Set([
  "audio", "base", "button", "canvas", "embed", "form", "iframe", "link",
  "math", "meta", "object", "script", "select", "style", "svg", "textarea",
  "video"
]);

const MARKDOWN_ALLOWED_ATTRIBUTES = {
  a: new Set(["href", "title"]),
  code: new Set(["class", "data-hunk", "data-path", "data-lines", "data-reviewed", "data-elided"]),
  img: new Set(["alt", "src", "title"]),
  input: new Set(["checked", "disabled", "type"]),
  ol: new Set(["start"]),
  td: new Set(["align"]),
  th: new Set(["align"])
};

const POSITION_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "table", "th", "td", "pre"]);

const CODE_DATA_PATTERNS = [
  ["data-hunk", HUNK_ID],
  ["data-path", HUNK_PATH],
  ["data-lines", HUNK_LINES],
  ["data-reviewed", /^$/],
  ["data-elided", /^$/]
];

export function isSafeMarkdownUrl(value, isImage = false) {
  const compact = value.trim().replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  if (!compact) return false;

  if (isImage) {
    return /^data:image\/(png|gif|jpe?g|webp);base64,/.test(compact);
  }

  return compact.startsWith("#") ||
    compact.startsWith("https://") ||
    compact.startsWith("http://") ||
    compact.startsWith("mailto:") ||
    parseSiblingHref(value) !== null;
}

const SIBLING_EXTENSION = /\.(md|markdown|txt)$/i;

// A link to another document next to this one, such as `02-merge.md#engine`:
// relative, no scheme, query or `..`, ending in a text extension. Returns the
// decoded path and fragment, or null for anything else.
export function parseSiblingHref(href) {
  if (typeof href !== "string") return null;
  const value = href.trim();
  if (!value || /[\u0000- \u007f\\?:]/.test(value)) return null;
  const hash = value.indexOf("#");
  let path;
  try {
    path = decodeURIComponent(hash === -1 ? value : value.slice(0, hash));
  } catch {
    return null;
  }
  if (!path || path.startsWith("/") || /[\u0000-\u001f\u007f\\:]/.test(path)) return null;
  if (path.split("/").some(segment => segment === ".." || segment === "")) return null;
  if (!SIBLING_EXTENSION.test(path)) return null;
  return { path, fragment: hash === -1 ? "" : decodeFragment(value.slice(hash + 1)) };
}

// Decides what clicking a link in the rendered preview should do. Kept apart
// from the DOM so the policy that hands URLs to the operating system can be
// tested on its own.
export function resolveLinkAction(href) {
  if (typeof href !== "string") return { kind: "ignore" };

  const value = href.trim();
  if (!value) return { kind: "ignore" };

  // In-document anchors scroll to a heading or hunk; they never reach the
  // operating system.
  if (value.startsWith("#")) {
    const fragment = decodeFragment(value.slice(1));
    return fragment ? { kind: "anchor", fragment } : { kind: "ignore" };
  }

  const sibling = parseSiblingHref(value);
  if (sibling) return { kind: "sibling", ...sibling };

  // Compare on the same stripped form the URL policy uses, so a scheme split
  // by control characters cannot slip past this check.
  const compact = value.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (/^(https?|mailto):/i.test(compact) && isSafeMarkdownUrl(value)) {
    return { kind: "external", url: value };
  }

  return { kind: "ignore" };
}

// `positionKey` names the one-render attribute suffix the position renderer
// used; only attributes carrying it become data-src-*, so positions written in
// the document can never be mistaken for real ones.
export function sanitizeMarkdownHtml(html, positionKey = null) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const elements = Array.from(template.content.querySelectorAll("*"));
  elements.forEach(element => {
    const tag = element.tagName.toLowerCase();

    if (MARKDOWN_DROP_CONTENT_TAGS.has(tag)) {
      element.remove();
      return;
    }
    if (!MARKDOWN_ALLOWED_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes);
      return;
    }

    const fromKey = positionKey && element.getAttribute(`${SOURCE_FROM}-${positionKey}`);
    const toKey = positionKey && element.getAttribute(`${SOURCE_TO}-${positionKey}`);
    const allowedAttributes = MARKDOWN_ALLOWED_ATTRIBUTES[tag] || new Set();
    Array.from(element.attributes).forEach(attribute => {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
      }
    });

    if (POSITION_TAGS.has(tag) && /^\d+$/.test(fromKey ?? "") && /^\d+$/.test(toKey ?? "") && Number(fromKey) <= Number(toKey)) {
      element.setAttribute(SOURCE_FROM, fromKey);
      element.setAttribute(SOURCE_TO, toKey);
    }

    if (tag === "a") {
      const href = element.getAttribute("href");
      if (!href || !isSafeMarkdownUrl(href)) {
        element.removeAttribute("href");
      } else if (resolveLinkAction(href).kind === "external") {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }

    if (tag === "img") {
      const src = element.getAttribute("src");
      if (!src || !isSafeMarkdownUrl(src, true)) {
        element.remove();
        return;
      }
      element.setAttribute("loading", "lazy");
      element.setAttribute("referrerpolicy", "no-referrer");
    }

    if (tag === "input") {
      if (element.getAttribute("type") !== "checkbox") {
        element.remove();
        return;
      }
      element.setAttribute("disabled", "");
    }

    if ((tag === "td" || tag === "th") && element.hasAttribute("align")) {
      const align = element.getAttribute("align").toLowerCase();
      if (!["left", "center", "right"].includes(align)) {
        element.removeAttribute("align");
      }
    }

    if (tag === "code") {
      for (const [name, valid] of CODE_DATA_PATTERNS) {
        if (element.hasAttribute(name) && !valid.test(element.getAttribute(name))) element.removeAttribute(name);
      }
    }

    if (tag === "code" && element.hasAttribute("class")) {
      const safeClasses = element.className
        .split(/\s+/)
        .filter(className => /^language-[a-z0-9_-]+$/i.test(className));
      if (safeClasses.length > 0) {
        element.className = safeClasses.join(" ");
      } else {
        element.removeAttribute("class");
      }
    }
  });

  template.content.querySelectorAll("li").forEach(listItem => {
    const firstChild = listItem.firstElementChild;
    const checkbox = firstChild?.matches('input[type="checkbox"]')
      ? firstChild
      : firstChild?.tagName === "P"
        ? firstChild.firstElementChild
        : null;

    if (checkbox?.matches('input[type="checkbox"]')) {
      listItem.classList.add("task-list-item");
    }
  });

  keepTableValuesWhole(template.content);
  addHeadingAnchors(template.content);
  return template.innerHTML;
}

const TABLE_TOKEN_MAX_LENGTH = 18;
const BREAKABLE_CHARACTER = /[^\p{L}\p{N}\p{M}]/u;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SHOW_TEXT = 4;

function keepsWhole(token) {
  const length = [...token].length;
  return length > 1 && length <= TABLE_TOKEN_MAX_LENGTH &&
    BREAKABLE_CHARACTER.test(token) && !CJK_CHARACTER.test(token);
}

function wrapCellTokens(cell) {
  const doc = cell.ownerDocument;
  const walker = doc.createTreeWalker(cell, SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  textNodes.forEach(textNode => {
    if (textNode.parentElement?.classList.contains("table-token")) return;
    const parts = textNode.nodeValue.split(/(\s+)/);
    if (!parts.some(keepsWhole)) return;

    const fragment = doc.createDocumentFragment();
    parts.forEach(part => {
      if (!part) return;
      if (keepsWhole(part)) {
        const span = doc.createElement("span");
        span.className = "table-token";
        span.setAttribute("style", "white-space: nowrap");
        span.textContent = part;
        fragment.append(span);
      } else {
        fragment.append(doc.createTextNode(part));
      }
    });
    textNode.replaceWith(fragment);
  });
}

// Browsers break after hyphens and slashes, so a long prose column can squeeze
// a date or ID column until `2026-09-30` splits. Keeping each short token whole
// makes the column's minimum width its longest such token; a box per table
// scrolls when those minimums do not fit. Inline styles keep this working in
// copied HTML. Runs after sanitizing, so note content cannot forge it.
export function keepTableValuesWhole(root) {
  root.querySelectorAll("table").forEach(table => {
    const parent = table.parentNode;
    if (!(parent?.nodeType === 1 && parent.classList.contains("table-scroll"))) {
      const box = table.ownerDocument.createElement("div");
      box.className = "table-scroll";
      box.setAttribute("style", "overflow-x: auto");
      table.replaceWith(box);
      box.append(table);
    }
    table.querySelectorAll("th, td").forEach(wrapCellTokens);
  });
}

const escapeAttribute = value => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// Marked keeps only the first word of a fence's info string; a review-book
// hunk also needs its id, path, line range and reviewed mark on the element.
function hunkRenderer(markedApi) {
  if (typeof markedApi.Renderer !== "function") return null;
  const renderer = new markedApi.Renderer();
  const code = renderer.code;
  renderer.code = function (token) {
    const html = code.call(this, token);
    const attributes = [];
    const hunk = hunkIdFromInfo(token.lang);
    if (hunk) attributes.push(`data-hunk="${hunk}"`);
    const meta = reviewHunkMeta(token.lang);
    if (meta) {
      attributes.push(`data-path="${escapeAttribute(meta.path)}"`);
      if (meta.lines) attributes.push(`data-lines="${meta.lines}"`);
      if (meta.reviewed) attributes.push("data-reviewed");
      if (meta.elided) attributes.push("data-elided");
    }
    return attributes.length ? html.replace("<code", `<code ${attributes.join(" ")}`) : html;
  };
  return renderer;
}

export function tableCellRanges(raw) {
  const lines = [];
  let lineStart = 0;
  while (lineStart <= raw.length) {
    let lineEnd = raw.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = raw.length;
    lines.push(lineCellRanges(raw, lineStart, lineEnd));
    lineStart = lineEnd + 1;
  }
  if (lines.length > 1) lines[1] = [];
  if (lines.length && lines[lines.length - 1].length === 0 && raw.endsWith("\n")) lines.pop();
  return lines;
}

function lineCellRanges(raw, start, end) {
  const segments = [];
  let segStart = start;
  let backslashes = 0;
  for (let i = start; i < end; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === "|" && backslashes % 2 === 0) {
      segments.push([segStart, i]);
      segStart = i + 1;
    }
    backslashes = 0;
  }
  segments.push([segStart, end]);

  const blank = ([from, to]) => raw.slice(from, to).trim() === "";
  if (segments.length > 1 && blank(segments[0])) segments.shift();
  if (segments.length > 1 && blank(segments[segments.length - 1])) segments.pop();

  return segments.map(([from, to]) => {
    while (from < to && (raw[from] === " " || raw[from] === "\t")) from++;
    while (to > from && (raw[to - 1] === " " || raw[to - 1] === "\t")) to--;
    return { from, to };
  });
}

function codeContentRange(token, from) {
  const raw = token.raw;
  if (!/^ {0,3}(`{3,}|~{3,})/.test(raw)) return { from, to: from + raw.length };
  const firstBreak = raw.indexOf("\n");
  if (firstBreak === -1) return { from: from + raw.length, to: from + raw.length };
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lastStart = body.lastIndexOf("\n") + 1;
  const closed = lastStart > firstBreak && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(body.slice(lastStart));
  return { from: from + firstBreak + 1, to: from + (closed ? lastStart : raw.length) };
}

function annotateTokens(tokens, source) {
  let cursor = 0;
  for (const token of tokens) {
    let at = source.startsWith(token.raw, cursor) ? cursor : source.indexOf(token.raw, cursor);
    if (at === -1) return;
    cursor = at + token.raw.length;
    const range = token.type === "code"
      ? codeContentRange(token, at)
      : { from: at, to: cursor };
    token.srcFrom = range.from;
    token.srcTo = range.to;

    if (token.type === "list") {
      let itemCursor = at;
      for (const item of token.items) {
        const itemAt = source.indexOf(item.raw, itemCursor);
        if (itemAt === -1) break;
        item.srcFrom = itemAt;
        item.srcTo = itemAt + item.raw.length;
        itemCursor = item.srcTo;
      }
    } else if (token.type === "table") {
      const lines = tableCellRanges(token.raw);
      const place = (cell, range) => {
        if (!range) return;
        cell.srcFrom = at + range.from;
        cell.srcTo = at + range.to;
      };
      token.header.forEach((cell, i) => place(cell, lines[0]?.[i]));
      token.rows.forEach((row, r) => row.forEach((cell, i) => place(cell, lines[r + 2]?.[i])));
    }
  }
}

function withSourceAttributes(html, token, key) {
  if (!Number.isInteger(token.srcFrom) || !Number.isInteger(token.srcTo)) return html;
  return html.replace(/^(\s*<[a-z0-9]+)/i, `$1 ${SOURCE_FROM}-${key}="${token.srcFrom}" ${SOURCE_TO}-${key}="${token.srcTo}"`);
}

function positionRenderer(renderer, key) {
  for (const name of ["paragraph", "heading", "blockquote", "list", "listitem", "table", "tablecell", "code"]) {
    const original = renderer[name];
    renderer[name] = function (token) {
      return withSourceAttributes(original.call(this, token), token, key);
    };
  }
  return renderer;
}

export function renderMarkdown(rawText, emptyFallback = "", markedApi = globalThis.window?.marked, { positions = false } = {}) {
  if (!markedApi) return "";
  const source = rawText || emptyFallback;
  if (typeof markedApi.parse === "function") {
    let renderer = hunkRenderer(markedApi);
    if (positions && rawText && renderer && typeof markedApi.lexer === "function" && typeof markedApi.parser === "function") {
      const tokens = markedApi.lexer(source);
      annotateTokens(tokens, source);
      const key = Math.random().toString(36).slice(2) + Date.now().toString(36);
      renderer = positionRenderer(renderer, key);
      return sanitizeMarkdownHtml(markedApi.parser(tokens, { renderer }), key);
    }
    return sanitizeMarkdownHtml(renderer ? markedApi.parse(source, { renderer }) : markedApi.parse(source));
  }
  if (typeof markedApi === "function") {
    return sanitizeMarkdownHtml(markedApi(source));
  }
  throw new Error("Markdown parser is unavailable");
}
