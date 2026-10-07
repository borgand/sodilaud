// SPDX-License-Identifier: GPL-3.0-or-later

// Live and Source mode anchors, found in the Lezer tree with the same slugs
// Reading mode gives its rendered headings.

import { EditorView, ensureSyntaxTree, syntaxTree } from "./vendor/codemirror.js";
import { HUNK_ID, createSlugger, hunkIdFromInfo } from "./anchors.js";

const HEADING = /^(ATXHeading[1-6]|SetextHeading[12])$/;
// Markup that the rendered heading does not show as text.
const HIDDEN = new Set([
  "HeaderMark", "EmphasisMark", "CodeMark", "LinkMark", "URL", "LinkTitle",
  "LinkLabel", "Image", "StrikethroughMark", "HTMLTag", "Comment"
]);
// Headings and fences only occur at the top level or inside these blocks.
const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);
const PARSE_TIMEOUT_MS = 200;

function fullTree(state) {
  return ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS) ?? syntaxTree(state);
}

function headingText(state, node) {
  let text = "";
  let at = node.from;
  const cursor = node.cursor();
  const skip = (from, to, keep = "") => {
    text += state.doc.sliceString(at, from) + keep;
    at = to;
  };
  if (cursor.firstChild()) {
    do {
      if (HIDDEN.has(cursor.name)) skip(cursor.from, cursor.to);
      else if (cursor.name === "Escape") skip(cursor.from, cursor.to, state.doc.sliceString(cursor.from + 1, cursor.to));
      else if (cursor.name === "Link" || cursor.name === "Emphasis" || cursor.name === "StrongEmphasis" ||
        cursor.name === "InlineCode" || cursor.name === "Strikethrough") {
        // Descend: only their marks are hidden.
        const inner = headingText(state, cursor.node);
        skip(cursor.from, cursor.to, inner);
      }
    } while (cursor.nextSibling());
  }
  text += state.doc.sliceString(at, node.to);
  return text.replace(/\s+/g, " ");
}

/**
 * Every anchor in document order: headings with their slug, and diff fences
 * whose info string names a hunk id. `full: false` reads only what is parsed
 * so far, which is cheap enough to run on every change.
 * @returns {{ kind: "heading" | "hunk", id: string, from: number, to: number, level?: number, text?: string }[]}
 */
export function documentAnchors(state, { full = true } = {}) {
  const slug = createSlugger();
  const anchors = [];
  (full ? fullTree(state) : syntaxTree(state)).iterate({
    enter: ref => {
      if (HEADING.test(ref.name)) {
        const level = Number(ref.name.slice(-1));
        const text = headingText(state, ref.node);
        anchors.push({ kind: "heading", id: slug(text), from: ref.from, to: ref.to, level, text: text.trim() });
        return false;
      }
      if (ref.name === "FencedCode") {
        const info = ref.node.getChild("CodeInfo");
        const hunk = info ? hunkIdFromInfo(state.doc.sliceString(info.from, info.to)) : null;
        if (hunk) anchors.push({ kind: "hunk", id: hunk, from: ref.from, to: ref.to });
        return false;
      }
      return CONTAINERS.has(ref.name) ? undefined : false;
    }
  });
  return anchors;
}

export function findAnchor(state, fragment) {
  if (!fragment) return null;
  const anchors = documentAnchors(state);
  const preferHunk = HUNK_ID.test(fragment);
  return (preferHunk && anchors.find(anchor => anchor.kind === "hunk" && anchor.id === fragment)) ||
    anchors.find(anchor => anchor.kind === "heading" && anchor.id === fragment) ||
    null;
}

// Scrolls without moving the cursor, so the target is not revealed as raw markup.
export function scrollToAnchor(view, fragment) {
  const anchor = findAnchor(view.state, fragment);
  if (!anchor) return false;
  view.dispatch({ effects: EditorView.scrollIntoView(anchor.from, { y: "start" }) });
  return true;
}
