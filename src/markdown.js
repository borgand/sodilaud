// SPDX-License-Identifier: GPL-3.0-or-later

import { HUNK_ID, addHeadingAnchors, decodeFragment, hunkIdFromInfo } from "./anchors.js";

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
  code: new Set(["class", "data-hunk"]),
  img: new Set(["alt", "src", "title"]),
  input: new Set(["checked", "disabled", "type"]),
  ol: new Set(["start"]),
  td: new Set(["align"]),
  th: new Set(["align"])
};

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

export function sanitizeMarkdownHtml(html) {
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

    const allowedAttributes = MARKDOWN_ALLOWED_ATTRIBUTES[tag] || new Set();
    Array.from(element.attributes).forEach(attribute => {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
      }
    });

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

    if (tag === "code" && element.hasAttribute("data-hunk") && !HUNK_ID.test(element.getAttribute("data-hunk"))) {
      element.removeAttribute("data-hunk");
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

// Marked keeps only the first word of a fence's info string; a review-book
// hunk also needs its id on the element so links can reach it.
function hunkRenderer(markedApi) {
  if (typeof markedApi.Renderer !== "function") return null;
  const renderer = new markedApi.Renderer();
  const code = renderer.code;
  renderer.code = function (token) {
    const html = code.call(this, token);
    const hunk = hunkIdFromInfo(token.lang);
    return hunk ? html.replace("<code", `<code data-hunk="${hunk}"`) : html;
  };
  return renderer;
}

export function renderMarkdown(rawText, emptyFallback = "", markedApi = globalThis.window?.marked) {
  if (!markedApi) return "";
  const source = rawText || emptyFallback;
  if (typeof markedApi.parse === "function") {
    const renderer = hunkRenderer(markedApi);
    return sanitizeMarkdownHtml(renderer ? markedApi.parse(source, { renderer }) : markedApi.parse(source));
  }
  if (typeof markedApi === "function") {
    return sanitizeMarkdownHtml(markedApi(source));
  }
  throw new Error("Markdown parser is unavailable");
}
