// SPDX-License-Identifier: GPL-3.0-or-later

export const SOURCE_FROM = "data-src-from";
export const SOURCE_TO = "data-src-to";

const SKIPPED = "button, input, textarea, svg, .diff-hunk, .reading-composer, .reading-comment-button";
const ANNOTATED = `[${SOURCE_FROM}][${SOURCE_TO}]`;
const SHOW_TEXT = 4;

const isSpace = (ch) => /\s/.test(ch);

export function alignText(rendered, source) {
  const out = new Int32Array(rendered.length);
  let cursor = 0;
  for (let i = 0; i < rendered.length; i++) {
    const ch = rendered[i];
    const space = isSpace(ch);
    let found = -1;
    for (let j = cursor; j < source.length; j++) {
      if (source[j] === ch || (space && isSpace(source[j]))) {
        found = j;
        break;
      }
    }
    out[i] = found;
    if (found >= 0) cursor = found + 1;
  }
  return out;
}

function elementOf(node) {
  return node.nodeType === 1 ? node : node.parentElement;
}

// Text directly in these is the renderer's layout whitespace: it aligns with
// arbitrary source spaces, and a mark span cannot sit there.
const NO_TEXT = "table, thead, tbody, tfoot, tr, ul, ol";

function isSkipped(node) {
  const el = elementOf(node);
  if (!el) return true;
  if (node.nodeType === 3 && el.matches(NO_TEXT)) return true;
  return el.closest(SKIPPED) !== null;
}

function textNodesOf(el) {
  const walker = el.ownerDocument.createTreeWalker(el, SHOW_TEXT);
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!isSkipped(n)) out.push(n);
  }
  return out;
}

export function sourceBlockOf(root, node) {
  if (!node || !root.contains(node) || isSkipped(node)) return null;
  for (let el = elementOf(node); el; el = el.parentElement) {
    if (el.matches(ANNOTATED)) return el;
    if (el === root) break;
  }
  return null;
}

function blockRange(block) {
  const from = Number(block.getAttribute(SOURCE_FROM));
  const to = Number(block.getAttribute(SOURCE_TO));
  return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from ? { from, to } : null;
}

function describeBlock(block, source) {
  const range = blockRange(block);
  if (!range) return null;
  const texts = textNodesOf(block);
  const starts = [];
  let rendered = "";
  for (const t of texts) {
    starts.push(rendered.length);
    rendered += t.data;
  }
  return { range, texts, starts, aligned: alignText(rendered, source.slice(range.from, range.to)) };
}

function firstMatch(aligned, from, to) {
  for (let i = from; i < to; i++) if (aligned[i] >= 0) return i;
  return -1;
}

function lastMatch(aligned, from, to) {
  for (let i = to - 1; i >= from; i--) if (aligned[i] >= 0) return i;
  return -1;
}

function renderedIndex(block, info, node, offset) {
  const pointer = block.ownerDocument.createRange();
  pointer.setStart(node, offset);
  pointer.collapse(true);
  let index = 0;
  for (const t of info.texts) {
    if (pointer.comparePoint(t, t.data.length) > 0) break;
    index += t.data.length;
  }
  return index;
}

export function pointToSource(root, node, offset, edge, source) {
  const block = sourceBlockOf(root, node);
  if (!block) return null;
  const info = describeBlock(block, source);
  if (!info) return null;
  const { aligned, texts, starts, range } = info;
  const total = aligned.length;
  const map = (i) => range.from + aligned[i];
  const start = edge === "start";

  const at = node.nodeType === 3 ? texts.indexOf(node) : -1;
  const index = at >= 0 ? starts[at] + Math.min(offset, node.data.length) : renderedIndex(block, info, node, offset);
  if (start) {
    const hit = firstMatch(aligned, index, total);
    return hit >= 0 ? map(hit) : null;
  }
  const hit = lastMatch(aligned, 0, index);
  return hit >= 0 ? map(hit) + 1 : null;
}

export function rangeToSource(root, range, source) {
  const from = pointToSource(root, range.startContainer, range.startOffset, "start", source);
  const to = pointToSource(root, range.endContainer, range.endOffset, "end", source);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}

export function blockForSource(root, pos) {
  let best = null;
  const candidates = root.matches(ANNOTATED) ? [root] : [];
  candidates.push(...root.querySelectorAll(ANNOTATED));
  for (const el of candidates) {
    const range = blockRange(el);
    if (!range || pos < range.from || pos > range.to) continue;
    if (!best || best.contains(el)) best = el;
  }
  return best;
}

function unwrapMarks(root) {
  for (const span of Array.from(root.querySelectorAll("span.source-mark"))) {
    span.replaceWith(...span.childNodes);
  }
  root.normalize();
}

function paintOne(root, mark, source) {
  const doc = root.ownerDocument;
  const infos = new Map();
  const runs = [];
  for (const text of textNodesOf(root)) {
    const block = sourceBlockOf(root, text);
    if (!block) continue;
    if (!infos.has(block)) infos.set(block, describeBlock(block, source));
    const info = infos.get(block);
    if (!info) continue;
    const base = info.starts[info.texts.indexOf(text)];
    let runStart = -1;
    for (let i = 0; i <= text.data.length; i++) {
      const src = i < text.data.length ? info.aligned[base + i] : -1;
      const inside = src >= 0 && info.range.from + src >= mark.from && info.range.from + src < mark.to;
      if (inside && runStart < 0) runStart = i;
      if (!inside && runStart >= 0) {
        runs.push({ text, from: runStart, to: i });
        runStart = -1;
      }
    }
  }
  // Later runs first so earlier offsets in the same text node stay valid.
  for (const run of runs.reverse()) {
    const range = doc.createRange();
    range.setStart(run.text, run.from);
    range.setEnd(run.text, run.to);
    const span = doc.createElement("span");
    span.className = `source-mark ${mark.className}`;
    if (mark.id !== undefined) span.setAttribute("data-comment-id", mark.id);
    range.surroundContents(span);
  }
}

export function paintSourceMarks(root, marks, source) {
  unwrapMarks(root);
  for (const mark of marks) paintOne(root, mark, source);
}

export function stripSourceAnnotations(root) {
  for (const el of root.querySelectorAll(".reading-composer, .reading-comment-button")) el.remove();
  unwrapMarks(root);
  for (const el of [root, ...root.querySelectorAll(`[${SOURCE_FROM}], [${SOURCE_TO}]`)]) {
    el.removeAttribute(SOURCE_FROM);
    el.removeAttribute(SOURCE_TO);
  }
}
