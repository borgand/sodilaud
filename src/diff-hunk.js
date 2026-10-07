// SPDX-License-Identifier: GPL-3.0-or-later

// Review-book diff hunks: a `diff` fence whose info string names the file,
// e.g. "diff path=src/mcp.rs hunk=h3f2a1 lines=120-168 reviewed". Shared by
// Reading mode, the Live widget and copy-as-HTML. No CodeMirror import.

import { HUNK_ID, parseFenceInfo } from "./anchors.js";
import { enableCodeSelection } from "./hunk-comments.js";
import { escapeHTML } from "./syntax-highlighting.js";

// Repository-relative: no scheme, no leading slash or space, no `..` segment,
// no control characters. Spaces are allowed; the fence quotes such a path.
export const HUNK_PATH = /^(?![a-z][a-z0-9+.-]*:)(?![/\s])(?!(?:.*\/)?\.\.(?:\/|$))[^\u0000-\u001f\u007f"]+$/i;
export const HUNK_LINES = /^(old:)?\d+-\d+$/;

/** The hunk's metadata, or null when the fence is not a review hunk. */
export function reviewHunkMeta(info) {
  const { lang, attrs } = parseFenceInfo(info);
  if (lang.toLowerCase() !== "diff" || !HUNK_PATH.test(attrs.path ?? "")) return null;
  return {
    path: attrs.path,
    hunk: HUNK_ID.test(attrs.hunk ?? "") ? attrs.hunk : null,
    lines: HUNK_LINES.test(attrs.lines ?? "") ? attrs.lines : null,
    reviewed: Object.hasOwn(attrs, "reviewed"),
    // The generator left out a huge body, such as minified vendor code.
    elided: Object.hasOwn(attrs, "elided")
  };
}

// The same tokens parseFenceInfo reads, so a quoted path is one token.
const INFO_TOKEN = /[^\s"=]+="[^"]*"|\S+/g;

/** The info string with the `reviewed` token added or removed, other tokens untouched. */
export function withReviewed(info, reviewed) {
  const text = String(info);
  let without = "";
  let at = 0;
  let first = true;
  for (const match of text.matchAll(INFO_TOKEN)) {
    if (!first && /^reviewed(=|$)/.test(match[0])) {
      without += text.slice(at, match.index).replace(/\s+$/, "");
      at = match.index + match[0].length;
    }
    first = false;
  }
  without += text.slice(at);
  return reviewed ? `${without.trimEnd()} reviewed` : without;
}

/**
 * Splits a unified diff hunk into rows with old and new line numbers taken
 * from its `@@` headers.
 * @returns {{ kind: "header" | "add" | "del" | "ctx" | "note", marker: string, text: string, old: number | null, new: number | null }[]}
 */
export function parseHunkBody(body) {
  const text = String(body ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (!text) return [];
  let oldLine = null;
  let newLine = null;
  return text.split("\n").map(line => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      return { kind: "header", marker: "", text: line, old: null, new: null };
    }
    const marker = line[0] ?? "";
    if (marker === "\\") return { kind: "note", marker: "", text: line, old: null, new: null };
    const take = which => {
      if (which === "old" && oldLine !== null) return oldLine++;
      if (which === "new" && newLine !== null) return newLine++;
      return null;
    };
    if (marker === "+") return { kind: "add", marker, text: line.slice(1), old: null, new: take("new") };
    if (marker === "-") return { kind: "del", marker, text: line.slice(1), old: take("old"), new: null };
    const rest = marker === " " ? line.slice(1) : line;
    return { kind: "ctx", marker: " ", text: rest, old: take("old"), new: take("new") };
  });
}

const EXTENSION_LANGUAGES = {
  rs: "rust", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp",
  m: "objectivec", mm: "objectivec", css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", plist: "xml", json: "json",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", md: "markdown",
  markdown: "markdown", sh: "bash", bash: "bash", zsh: "bash", sql: "sql", rb: "ruby",
  php: "php", lua: "lua", pl: "perl", pm: "perl", r: "r", graphql: "graphql", gql: "graphql"
};

/** The Highlight.js language for a file, or "diff" when there is none. */
export function languageForPath(path, hljs) {
  const name = String(path).split("/").pop() ?? "";
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const language = name === "Makefile" ? "makefile" : EXTENSION_LANGUAGES[extension];
  return language && (!hljs || hljs.getLanguage?.(language)) ? language : "diff";
}

/** Splits highlighted HTML into lines, closing and reopening spans at each break. */
export function splitHighlightedLines(html) {
  const lines = [];
  const open = [];
  let current = "";
  for (const part of String(html).split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else {
      if (part.startsWith("<span")) open.push(part);
      else if (part === "</span>") open.pop();
      current += part;
    }
  }
  lines.push(current);
  return lines;
}

function highlightSide(texts, language, hljs) {
  // An added or deleted file has no lines on one side; highlighting "" would yield one line.
  if (texts.length === 0) return [];
  try {
    const html = hljs.highlight(texts.join("\n"), { language, ignoreIllegals: true }).value;
    const lines = splitHighlightedLines(html);
    return lines.length === texts.length ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Each row's code as HTML. The old and new sides are highlighted as whole
 * texts, so a comment or string that spans lines keeps its colors.
 */
export function highlightRows(rows, path, hljs) {
  const plain = rows.map(row => escapeHTML(row.text));
  const language = hljs ? languageForPath(path, hljs) : "diff";
  // The rows already show + and - as backgrounds; the diff grammar adds nothing to bare code.
  if (language === "diff") return plain;
  const oldRows = rows.filter(row => row.kind === "ctx" || row.kind === "del");
  const newRows = rows.filter(row => row.kind === "ctx" || row.kind === "add");
  const oldHtml = highlightSide(oldRows.map(row => row.text), language, hljs);
  const newHtml = highlightSide(newRows.map(row => row.text), language, hljs);
  if (!oldHtml || !newHtml) return plain;
  const byRow = new Map();
  newRows.forEach((row, index) => byRow.set(row, newHtml[index]));
  oldRows.forEach((row, index) => { if (!byRow.has(row)) byRow.set(row, oldHtml[index]); });
  return rows.map((row, index) => byRow.get(row) ?? plain[index]);
}

// Fold state lasts for the session only; it never reaches the file.
const collapsedHunks = new Set();
const collapseKey = (meta) => meta.hunk ?? `${meta.path}:${meta.lines ?? ""}`;
export const isHunkCollapsed = (meta) => collapsedHunks.has(collapseKey(meta));
export function setHunkCollapsed(meta, collapsed) {
  if (collapsed) collapsedHunks.add(collapseKey(meta));
  else collapsedHunks.delete(collapseKey(meta));
}

function linesLabel(lines) {
  if (!lines) return "";
  return lines.startsWith("old:") ? `deleted, old lines ${lines.slice(4)}` : `lines ${lines}`;
}

function button(document, className, label) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  return element;
}

function setReviewedState(root, reviewed) {
  root.classList.toggle("diff-hunk-is-reviewed", reviewed);
  const toggle = root.querySelector(".diff-hunk-reviewed");
  toggle.setAttribute("aria-pressed", String(reviewed));
  toggle.textContent = reviewed ? "✓ Reviewed" : "Mark reviewed";
}

// Collapsing from the floating header of a hunk scrolled far into would leave
// the collapsed hunk high above the view; bring its header back to the top.
function keepHeaderInView(root) {
  let scroller = root.parentElement;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
  if (!scroller) return;
  const above = scroller.getBoundingClientRect().top - root.getBoundingClientRect().top;
  if (above > 0) scroller.scrollTop -= above;
}

function setCollapsedState(root, collapsed) {
  root.classList.toggle("diff-hunk-is-collapsed", collapsed);
  const toggle = root.querySelector(".diff-hunk-collapse");
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.textContent = collapsed ? "▸" : "▾";
  toggle.title = collapsed ? "Show hunk" : "Hide hunk";
}

/**
 * The hunk widget's DOM. `onLineComment(index)` gets the row's index in the
 * fence body; without it, line numbers are plain text. With `codeComments`
 * (see enableCodeSelection), code is selected inside the widget and offered
 * for a comment.
 */
export function buildHunkElement(document, {
  meta,
  body,
  hljs = null,
  onToggleReviewed = null,
  onLineComment = null,
  onToggleCollapsed = null,
  codeComments = null
}) {
  const root = document.createElement("div");
  root.className = "diff-hunk";
  if (meta.hunk) root.setAttribute("data-hunk", meta.hunk);
  root.setAttribute("data-path", meta.path);
  if (meta.lines) root.setAttribute("data-lines", meta.lines);
  root.setAttribute("data-source", body);

  const header = document.createElement("div");
  header.className = "diff-hunk-header";
  const collapse = button(document, "diff-hunk-collapse", "▾");
  const path = document.createElement("span");
  path.className = "diff-hunk-path";
  path.textContent = meta.path;
  path.title = meta.path;
  const lines = document.createElement("span");
  lines.className = "diff-hunk-lines";
  lines.textContent = linesLabel(meta.lines);
  const reviewed = button(document, "diff-hunk-reviewed", "");
  header.append(collapse, path, lines, reviewed);

  const rows = parseHunkBody(body);
  const html = highlightRows(rows, meta.path, hljs);
  const table = document.createElement("table");
  table.className = "diff-hunk-body";
  const tbody = document.createElement("tbody");
  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.className = `diff-row diff-row-${row.kind}`;
    tr.dataset.index = String(index);
    if (row.kind === "header" || row.kind === "note") {
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "diff-meta";
      cell.textContent = row.text;
      tr.append(cell);
    } else {
      for (const [side, number] of [["old", row.old], ["new", row.new]]) {
        const cell = document.createElement("td");
        cell.className = `diff-ln diff-ln-${side}`;
        if (number !== null) {
          if (onLineComment) {
            const comment = button(document, "diff-ln-button", String(number));
            comment.title = "Comment on this line";
            comment.setAttribute("aria-label", `Comment on line ${number}`);
            comment.addEventListener("click", event => {
              event.preventDefault();
              event.stopPropagation();
              onLineComment(index);
            });
            cell.append(comment);
          } else {
            cell.textContent = String(number);
          }
        }
        tr.append(cell);
      }
      const marker = document.createElement("td");
      marker.className = "diff-marker";
      marker.textContent = row.kind === "ctx" ? "" : row.marker;
      const code = document.createElement("td");
      code.className = "diff-code";
      code.innerHTML = html[index] || "​";
      tr.append(marker, code);
    }
    tbody.append(tr);
  });
  table.append(tbody);
  root.append(header, table);
  if (meta.elided) {
    const note = document.createElement("div");
    note.className = "diff-hunk-elided";
    note.textContent = "Lines elided: this hunk is too large to show. Read it in the file itself.";
    root.append(note);
  }

  setReviewedState(root, meta.reviewed);
  setCollapsedState(root, isHunkCollapsed(meta));
  collapse.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    const next = !root.classList.contains("diff-hunk-is-collapsed");
    setHunkCollapsed(meta, next);
    setCollapsedState(root, next);
    if (next) keepHeaderInView(root);
    onToggleCollapsed?.(next);
  });
  if (onToggleReviewed) {
    reviewed.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const next = !root.classList.contains("diff-hunk-is-reviewed");
      setReviewedState(root, next);
      onToggleReviewed(next);
    });
  } else {
    reviewed.disabled = true;
  }
  if (codeComments) {
    root.classList.add("diff-hunk-commentable");
    enableCodeSelection(root, codeComments);
  }
  return root;
}

/**
 * Reading mode: swaps every rendered review hunk for its widget. The toggle
 * gets the hunk's id and its position among review hunks, so a hunk without
 * a valid id can still be found in the source.
 */
export function renderHunkWidgets(container, { hljs = null, onToggleReviewed = null } = {}) {
  const codes = [...container.querySelectorAll("pre > code.language-diff[data-path]")];
  codes.forEach((code, index) => {
    const pre = code.parentElement;
    const meta = {
      path: code.getAttribute("data-path"),
      hunk: code.getAttribute("data-hunk"),
      lines: code.getAttribute("data-lines"),
      reviewed: code.hasAttribute("data-reviewed"),
      elided: code.hasAttribute("data-elided")
    };
    const widget = buildHunkElement(container.ownerDocument, {
      meta,
      body: code.textContent ?? "",
      hljs,
      onToggleReviewed: onToggleReviewed ? reviewed => onToggleReviewed({ hunk: meta.hunk, index }, reviewed) : null
    });
    pre.replaceWith(widget);
  });
  return codes.length;
}

/**
 * Copy-as-HTML and export: each hunk becomes a plain highlighted diff block
 * captioned with its path, whether it is still a code block or a widget.
 * Mutates `root`; pass a copy of anything on screen.
 */
export function exportHunks(root, hljs = null) {
  const document = root.ownerDocument;
  const sources = [
    ...[...root.querySelectorAll(".diff-hunk[data-path]")].map(widget => ({
      element: widget,
      path: widget.getAttribute("data-path"),
      lines: widget.getAttribute("data-lines"),
      body: widget.getAttribute("data-source") ?? ""
    })),
    ...[...root.querySelectorAll("pre > code.language-diff[data-path]")].map(code => ({
      element: code.parentElement,
      path: code.getAttribute("data-path"),
      lines: code.getAttribute("data-lines"),
      body: code.textContent ?? ""
    }))
  ];
  for (const { element, path, lines, body } of sources) {
    const figure = document.createElement("figure");
    figure.className = "diff-hunk-export";
    const caption = document.createElement("figcaption");
    const name = document.createElement("code");
    name.textContent = path;
    caption.append(name);
    if (lines) caption.append(` (${linesLabel(lines)})`);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-diff";
    const text = body.replace(/\n$/, "");
    let highlighted = null;
    try {
      highlighted = hljs?.getLanguage?.("diff") ? hljs.highlight(text, { language: "diff", ignoreIllegals: true }).value : null;
    } catch {
      highlighted = null;
    }
    if (highlighted !== null) {
      code.innerHTML = highlighted;
      code.classList.add("hljs");
    } else {
      code.textContent = text;
    }
    pre.append(code);
    figure.append(caption, pre);
    element.replaceWith(figure);
  }
  return sources.length;
}
