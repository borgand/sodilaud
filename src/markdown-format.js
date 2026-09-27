// SPDX-License-Identifier: GPL-3.0-or-later

import {
  getBlockquotePrefix,
  getFenceStateBeforeLine,
  getIndentColumns,
  getLineEnd,
  getLineStart,
  isInsideFencedCode,
  parseListLine
} from "./editor-context.js";
import { getMarkdownTemplateEdit } from "./markdown-insert.js";

export const FORMAT_ACTIONS = Object.freeze([
  "bold", "italic", "strikethrough", "code", "link",
  "heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6", "paragraph",
  "bullet-list", "numbered-list", "task-list", "quote",
  "code-block", "table", "horizontal-rule"
]);

const INLINE_MARKERS = {
  bold: "**",
  italic: "*",
  strikethrough: "~~",
  code: "`"
};

const LIST_ACTIONS = new Set(["bullet-list", "numbered-list", "task-list"]);
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const HEADING_PREFIX = /^(#{1,6})(?:[ \t]+|$)/;
const LINK = /\[([^\]\n]*)\]\(([^()\n]*)\)/g;
const FENCE_OPEN = /^[ ]{0,3}(`{3,}|~{3,})[^`\n]*$/;
const FENCE_CLOSE = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/;

function clampPosition(value, position) {
  const numeric = Number(position);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(value.length, numeric));
}

function edit(value, selectionStart, selectionEnd = selectionStart) {
  return { value, selectionStart, selectionEnd };
}

function countRun(value, position, step, character) {
  let count = 0;
  for (let index = step < 0 ? position - 1 : position; value[index] === character; index += step) {
    count += 1;
  }
  return count;
}

// "*" runs of 2 belong to bold, so italic only counts odd runs (1, or 3 for bold italic).
function isWrappedBy(before, after, marker) {
  if (marker === "*") return before % 2 === 1 && after % 2 === 1;
  return before >= marker.length && after >= marker.length;
}

function getInlineRangeEdit(value, start, end, marker) {
  const character = marker[0];
  const length = marker.length;

  if (isWrappedBy(countRun(value, start, -1, character), countRun(value, end, 1, character), marker)) {
    return edit(
      value.slice(0, start - length) + value.slice(start, end) + value.slice(end + length),
      start - length,
      end - length
    );
  }

  const selected = value.slice(start, end);
  const leading = countRun(selected, 0, 1, character);
  const trailing = countRun(selected, selected.length, -1, character);
  if (leading + trailing <= selected.length && isWrappedBy(leading, trailing, marker)) {
    return edit(
      value.slice(0, start) + selected.slice(length, selected.length - length) + value.slice(end),
      start,
      end - 2 * length
    );
  }

  return edit(
    value.slice(0, start) + marker + selected + marker + value.slice(end),
    start + length,
    end + length
  );
}

// Whitespace at the selection edges (a triple-clicked line ends with its line
// break) stays outside the marks. A whitespace-only selection acts like a caret.
function trimSelection(value, start, end) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(value[from])) from += 1;
  while (to > from && /\s/.test(value[to - 1])) to -= 1;
  return from === to ? [start, start] : [from, to];
}

function getInlineEdit(value, selectionStart, selectionEnd, marker) {
  const [start, end] = trimSelection(value, selectionStart, selectionEnd);
  if (start !== end) return getInlineRangeEdit(value, start, end, marker);

  const isWord = index => WORD_CHARACTER.test(value[index] ?? "");
  if (!isWord(start - 1) && !isWord(start)) {
    return getInlineRangeEdit(value, start, start, marker);
  }

  let wordStart = start;
  let wordEnd = start;
  while (isWord(wordStart - 1)) wordStart -= 1;
  while (isWord(wordEnd)) wordEnd += 1;
  const result = getInlineRangeEdit(value, wordStart, wordEnd, marker);
  const caret = start + (result.selectionStart - wordStart);
  return edit(result.value, caret);
}

function findLinkAround(value, start, end) {
  const lineStart = getLineStart(value, start);
  const line = value.slice(lineStart, getLineEnd(value, start));
  for (const match of line.matchAll(LINK)) {
    const from = lineStart + match.index;
    const to = from + match[0].length;
    if (value[from - 1] === "!") continue;
    const inside = start === end ? from < start && start < to : from <= start && end <= to;
    if (inside) return { from, url: from + match[1].length + 3, to };
  }
  return null;
}

function getLinkEdit(value, selectionStart, selectionEnd) {
  const [start, end] = trimSelection(value, selectionStart, selectionEnd);
  const link = findLinkAround(value, start, end);
  if (link) return edit(value, link.url, link.to - 1);

  if (start === end) return getMarkdownTemplateEdit(value, start, end, "link");

  const selected = value.slice(start, end);
  const urlStart = start + selected.length + 3;
  return edit(`${value.slice(0, start)}[${selected}](url)${value.slice(end)}`, urlStart, urlStart + 3);
}

function getSelectedLines(value, start, end) {
  const from = getLineStart(value, start);
  const lastPosition = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const to = getLineEnd(value, lastPosition);
  let lineStart = from;
  const lines = value.slice(from, to).split("\n").map(text => {
    const line = { text, start: lineStart };
    lineStart += text.length + 1;
    return line;
  });
  const skipBlank = lines.length > 1;
  for (const line of lines) line.blank = skipBlank && line.text.trim() === "";
  return { from, to, lines };
}

// A position inside a replaced prefix lands after the new prefix, except the
// start of a selection, which stays at the line start so the line stays selected.
function mapLineOffset(offset, change, keepAtChange) {
  if (offset < change.at) return offset;
  if (offset === change.at && keepAtChange) return offset;
  if (offset < change.at + change.remove || (offset === change.at && change.remove === 0)) {
    return change.at + change.insert.length;
  }
  return offset - change.remove + change.insert.length;
}

function applyLineChanges(value, start, end, { from, to, lines }, changes) {
  if (changes.every(change => !change)) return null;

  const texts = [];
  let delta = 0;
  let selectionStart = start;
  let selectionEnd = end;
  lines.forEach((line, index) => {
    const change = changes[index];
    const text = change
      ? line.text.slice(0, change.at) + change.insert + line.text.slice(change.at + change.remove)
      : line.text;
    const map = (position, keepAtChange) => line.start + delta +
      (change ? mapLineOffset(position - line.start, change, keepAtChange) : position - line.start);
    if (index === 0) selectionStart = map(start, start !== end);
    if (index === lines.length - 1 && end <= line.start + line.text.length) selectionEnd = map(end, false);
    delta += text.length - line.text.length;
    texts.push(text);
  });
  if (end > to) selectionEnd = end + delta;
  if (start === end) selectionEnd = selectionStart;

  return edit(value.slice(0, from) + texts.join("\n") + value.slice(to), selectionStart, selectionEnd);
}

// On a list line the heading goes after the list marker: "- ## item".
function parseHeading(text) {
  const list = parseListLine(text);
  const container = list ? text.slice(0, list.contentStart) : getBlockquotePrefix(text);
  const rest = text.slice(container.length);
  const lead = list ? "" : rest.match(/^ {0,3}/)[0];
  const match = rest.slice(lead.length).match(HEADING_PREFIX);
  return {
    at: container.length + lead.length,
    level: match ? match[1].length : 0,
    prefix: match ? match[0] : ""
  };
}

function getHeadingEdit(value, start, end, level) {
  const selection = getSelectedLines(value, start, end);
  const headings = selection.lines.map(line => line.blank ? null : parseHeading(line.text));
  const candidates = headings.filter(Boolean);
  const remove = level === 0 || candidates.every(heading => heading.level === level);
  const insert = remove ? "" : `${"#".repeat(level)} `;

  const changes = headings.map(heading => {
    if (!heading || heading.prefix === insert) return null;
    return { at: heading.at, remove: heading.prefix.length, insert };
  });
  return applyLineChanges(value, start, end, selection, changes);
}

function getListKind(parsed) {
  if (!parsed) return null;
  if (parsed.task) return "task-list";
  return parsed.number === null ? "bullet-list" : "numbered-list";
}

function getListEdit(value, start, end, kind) {
  const selection = getSelectedLines(value, start, end);
  const parsedLines = selection.lines.map(line => line.blank ? null : { line, parsed: parseListLine(line.text) });
  const candidates = parsedLines.filter(Boolean);

  if (candidates.every(({ parsed }) => getListKind(parsed) === kind)) {
    const changes = parsedLines.map(entry => entry && {
      at: entry.parsed.markerStart,
      remove: entry.parsed.contentStart - entry.parsed.markerStart,
      insert: ""
    });
    return applyLineChanges(value, start, end, selection, changes);
  }

  const counters = new Map();
  const changes = parsedLines.map(entry => {
    if (!entry) return null;
    const { line, parsed } = entry;
    let at;
    let columns;
    if (parsed) {
      at = parsed.markerStart;
      columns = parsed.indentColumns;
    } else {
      const container = getBlockquotePrefix(line.text);
      const indentation = line.text.slice(container.length).match(/^[ \t]*/)[0];
      at = container.length + indentation.length;
      columns = getIndentColumns(indentation);
    }
    const remove = parsed ? parsed.contentStart - parsed.markerStart : 0;

    let insert;
    if (kind === "numbered-list") {
      for (const depth of counters.keys()) if (depth > columns) counters.delete(depth);
      const number = (counters.get(columns) ?? 0) + 1;
      counters.set(columns, number);
      insert = `${number}${parsed?.delimiter ?? "."} `;
    } else {
      const bullet = parsed && parsed.number === null ? parsed.marker : "-";
      insert = kind === "task-list" ? `${bullet} [ ] ` : `${bullet} `;
    }

    if (line.text.slice(at, at + remove) === insert) return null;
    return { at, remove, insert };
  });
  return applyLineChanges(value, start, end, selection, changes);
}

function getQuoteEdit(value, start, end) {
  const selection = getSelectedLines(value, start, end);
  const quoted = text => /^ {0,3}>/.test(text);
  const allQuoted = selection.lines.every(line => line.blank || quoted(line.text));

  const changes = selection.lines.map(line => {
    if (line.blank) return null;
    if (!allQuoted) return { at: 0, remove: 0, insert: "> " };
    const match = line.text.match(/^( {0,3})> ?/);
    return { at: match[1].length, remove: match[0].length - match[1].length, insert: "" };
  });
  return applyLineChanges(value, start, end, selection, changes);
}

function isClosingFence(line, opener) {
  const close = line.match(FENCE_CLOSE);
  return Boolean(close && close[1][0] === opener[1][0] && close[1].length >= opener[1].length);
}

function getCodeBlockEdit(value, start, end) {
  if (start === end) {
    if (isInsideFencedCode(value, start)) return null;
    return getMarkdownTemplateEdit(value, start, end, "code-block");
  }

  const { from, to, lines } = getSelectedLines(value, start, end);
  const first = lines[0].text;
  const last = lines[lines.length - 1].text;

  const ownOpener = lines.length > 1 && first.match(FENCE_OPEN);
  if (ownOpener && isClosingFence(last, ownOpener)) {
    const innerFrom = from + first.length + 1;
    const innerTo = to - last.length - 1;
    const inner = innerTo > innerFrom ? value.slice(innerFrom, innerTo) : "";
    return edit(value.slice(0, from) + inner + value.slice(to), from, from + inner.length);
  }

  const insideFence = from > 0 && getFenceStateBeforeLine(value, from);
  if (insideFence && to < value.length) {
    const openerStart = getLineStart(value, from - 1);
    const opener = value.slice(openerStart, from - 1).match(FENCE_OPEN);
    const closerEnd = getLineEnd(value, to + 1);
    if (opener && isClosingFence(value.slice(to + 1, closerEnd), opener)) {
      const shift = from - openerStart;
      return edit(
        value.slice(0, openerStart) + value.slice(from, to) + value.slice(closerEnd),
        start - shift,
        end - shift
      );
    }
  }

  if (insideFence) return null;

  const content = value.slice(from, to);
  const longestRun = Math.max(0, ...[...content.matchAll(/^ {0,3}(`{3,})/gm)].map(match => match[1].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const shift = fence.length + 1;
  return edit(
    `${value.slice(0, from)}${fence}\n${content}\n${fence}${value.slice(to)}`,
    start + shift,
    end + shift
  );
}

/**
 * Returns the Markdown edit for a formatting action, or null when there is nothing to do.
 *
 * @param {string} value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {string} actionId one of FORMAT_ACTIONS
 * @returns {{value: string, selectionStart: number, selectionEnd: number} | null}
 */
export function getFormatEdit(value, selectionStart, selectionEnd, actionId) {
  const source = String(value ?? "");
  const a = clampPosition(source, selectionStart);
  const b = clampPosition(source, selectionEnd);
  const start = Math.min(a, b);
  const end = Math.max(a, b);

  if (Object.hasOwn(INLINE_MARKERS, actionId)) return getInlineEdit(source, start, end, INLINE_MARKERS[actionId]);
  if (actionId === "link") return getLinkEdit(source, start, end);
  if (actionId === "paragraph") return getHeadingEdit(source, start, end, 0);
  const heading = /^heading-([1-6])$/.exec(actionId);
  if (heading) return getHeadingEdit(source, start, end, Number(heading[1]));
  if (LIST_ACTIONS.has(actionId)) return getListEdit(source, start, end, actionId);
  if (actionId === "quote") return getQuoteEdit(source, start, end);
  if (actionId === "code-block") return getCodeBlockEdit(source, start, end);
  if (actionId === "table" || actionId === "horizontal-rule") {
    const at = start === end ? start : getSelectedLines(source, start, end).to;
    return getMarkdownTemplateEdit(source, at, at, actionId);
  }
  return null;
}
