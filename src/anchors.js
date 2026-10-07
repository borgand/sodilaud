// SPDX-License-Identifier: GPL-3.0-or-later

// Anchors a link can point at: headings, by GitHub-style slug, and review-book
// diff hunks, by the id in their fence info string. Shared by Reading mode,
// Live mode and anything that lists headings, so all agree on every slug.

export const HUNK_ID = /^h[0-9a-f]{5}$/;
export const ANCHOR_ATTRIBUTE = "data-anchor";

// Same rules as check-book.mjs in the review-book skill, so the checker and the app agree.
export function slugify(text) {
  return String(text)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

// Repeated headings get -1, -2, ... in document order, as on GitHub.
export function createSlugger() {
  const used = new Set();
  const counts = new Map();
  return text => {
    const base = slugify(text);
    let slug = base;
    while (used.has(slug)) {
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      slug = `${base}-${count}`;
    }
    used.add(slug);
    return slug;
  };
}

// "diff path=a.rs hunk=h3f2a reviewed" -> { lang: "diff", attrs: { path, hunk, reviewed: "" } }
export function parseFenceInfo(info) {
  const [lang = "", ...rest] = String(info ?? "").match(/[^\s"=]+="[^"]*"|\S+/g) ?? [];
  const attrs = {};
  for (const token of rest) {
    const equals = token.indexOf("=");
    if (equals === -1) attrs[token] = "";
    else attrs[token.slice(0, equals)] = token.slice(equals + 1).replace(/^"(.*)"$/, "$1");
  }
  return { lang, attrs };
}

export function hunkIdFromInfo(info) {
  const hunk = parseFenceInfo(info).attrs.hunk;
  return hunk && HUNK_ID.test(hunk) ? hunk : null;
}

// Fragments arrive percent-encoded from link hrefs.
export function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// Post-sanitize pass for Reading mode. Anchors go in data-anchor rather than
// id: a heading named "Comments panel" must not shadow the app's own element.
export function addHeadingAnchors(root) {
  const slug = createSlugger();
  root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach(heading => {
    heading.setAttribute(ANCHOR_ATTRIBUTE, slug(heading.textContent));
  });
}

export function findReadingAnchor(root, fragment) {
  if (!fragment) return null;
  if (HUNK_ID.test(fragment)) {
    // A plain code block, or the hunk widget that replaced it.
    const hunk = root.querySelector(`[data-hunk="${fragment}"]`);
    if (hunk) return hunk.closest("pre") ?? hunk;
  }
  for (const element of root.querySelectorAll(`[${ANCHOR_ATTRIBUTE}]`)) {
    if (element.getAttribute(ANCHOR_ATTRIBUTE) === fragment) return element;
  }
  return null;
}

export function scrollToReadingAnchor(root, fragment) {
  const target = findReadingAnchor(root, fragment);
  if (!target) return false;
  target.scrollIntoView({ block: "start" });
  return true;
}
