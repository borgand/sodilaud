// SPDX-License-Identifier: GPL-3.0-or-later

// Sections by heading: where each one ends, the outline with review progress,
// and folding in Reading mode. No CodeMirror here, so the outline and the
// Reading mode pass can be tested on their own.

import { ANCHOR_ATTRIBUTE } from "./anchors.js";

const HEADING_TAG = /^H([1-6])$/;

/**
 * Where each heading's section ends: at the next heading of the same or a
 * higher level, or at the end of the document.
 * @param {{ from: number, level: number }[]} headings in document order
 */
export function sectionEnds(headings, docLength) {
  const ends = new Array(headings.length).fill(docLength);
  const open = [];
  headings.forEach((heading, index) => {
    while (open.length && headings[open.at(-1)].level >= heading.level) ends[open.pop()] = heading.from;
    open.push(index);
  });
  return ends;
}

/**
 * The outline of a document: every heading, and for a heading whose section
 * holds review hunks, how many of them are marked reviewed.
 * @param {{ kind: string, id: string, from: number, to: number, level?: number, text?: string }[]} anchors
 * @param {{ from: number, meta: { reviewed: boolean } }[]} hunks
 */
export function outlineEntries(anchors, hunks, docLength) {
  const headings = anchors.filter(anchor => anchor.kind === "heading");
  const ends = sectionEnds(headings, docLength);
  return headings.map((heading, index) => {
    const inside = hunks.filter(hunk => hunk.from >= heading.to && hunk.from < ends[index]);
    return {
      id: heading.id,
      level: heading.level,
      text: heading.text ?? heading.id,
      from: heading.from,
      to: ends[index],
      reviewed: inside.filter(hunk => hunk.meta.reviewed).length,
      total: inside.length
    };
  });
}

export function reviewProgress(hunks) {
  return { reviewed: hunks.filter(hunk => hunk.meta.reviewed).length, total: hunks.length };
}

export const reviewProgressText = ({ reviewed, total }) => (total ? `${reviewed}/${total} reviewed` : "");

/** Fills the sidebar outline: one button per heading, indented by level. */
export function renderOutlineList(list, entries, onSelect) {
  const document = list.ownerDocument;
  const top = Math.min(...entries.map(entry => entry.level));
  list.replaceChildren(...entries.map(entry => {
    const item = document.createElement("li");
    item.className = "outline-item";
    item.style.setProperty("--outline-depth", String(entry.level - top));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "outline-link";
    link.textContent = entry.text;
    link.title = entry.text;
    link.addEventListener("click", () => onSelect(entry.id));
    item.append(link);
    if (entry.total) {
      const progress = document.createElement("span");
      progress.className = `outline-progress${entry.reviewed === entry.total ? " complete" : ""}`;
      progress.textContent = `${entry.reviewed}/${entry.total}`;
      progress.title = `${entry.reviewed} of ${entry.total} hunks reviewed`;
      item.append(progress);
    }
    return item;
  }));
}

// ----------------------------------------------------
// Reading mode
// ----------------------------------------------------
const headingLevel = element => Number(HEADING_TAG.exec(element.tagName)?.[1] ?? 0);

function foldButton(document, heading) {
  let button = heading.querySelector(":scope > .heading-fold");
  if (button) return button;
  button = document.createElement("button");
  button.type = "button";
  button.className = "heading-fold";
  heading.prepend(button);
  return button;
}

/**
 * Adds a fold chevron to every top-level heading of a rendered document and
 * hides the sections named in `folded`. Hidden content stays in the DOM, so
 * anchors inside it still resolve. Safe to run again after a toggle.
 * @param {Set<string>} folded heading slugs
 * @param {(id: string, folded: boolean) => void} onToggle
 */
export function applyReadingFolds(root, folded, onToggle) {
  const document = root.ownerDocument;
  let hidingAbove = 0;
  for (const element of root.children) {
    const level = headingLevel(element);
    if (level && hidingAbove && level <= hidingAbove) hidingAbove = 0;
    element.classList.toggle("section-fold-hidden", hidingAbove > 0);
    const id = level ? element.getAttribute(ANCHOR_ATTRIBUTE) : null;
    if (!id) continue;
    const isFolded = folded.has(id);
    element.classList.toggle("is-section-folded", isFolded);
    const button = foldButton(document, element);
    button.setAttribute("aria-expanded", String(!isFolded));
    button.setAttribute("aria-label", isFolded ? "Unfold section" : "Fold section");
    button.title = isFolded ? "Unfold section" : "Fold section";
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      onToggle(id, !isFolded);
    };
    if (isFolded && !hidingAbove) hidingAbove = level;
  }
}

/**
 * The folded sections that hide `element`, outermost last, so following a
 * link into one can unfold them first.
 */
export function readingFoldsHiding(root, element, folded) {
  let block = element;
  while (block && block.parentElement !== root) block = block.parentElement;
  if (!block || !folded.size) return [];
  let limit = headingLevel(block) || 7;
  const hiding = [];
  for (let previous = block.previousElementSibling; previous && limit > 1; previous = previous.previousElementSibling) {
    const level = headingLevel(previous);
    if (!level || level >= limit) continue;
    limit = level;
    const id = previous.getAttribute(ANCHOR_ATTRIBUTE);
    if (id && folded.has(id)) hiding.push(id);
  }
  return hiding;
}
