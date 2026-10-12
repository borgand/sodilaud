// SPDX-License-Identifier: GPL-3.0-or-later

export function escapeHTML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function highlightPreviewCode(container, highlighter, enabled = true) {
  if (!enabled || !container || !highlighter) return 0;
  let highlightedCount = 0;

  for (const code of container.querySelectorAll("pre > code")) {
    const languageClass = [...code.classList].find((className) => className.startsWith("language-"));
    const language = languageClass?.slice("language-".length).trim();
    if (!language || !highlighter.getLanguage?.(language)) continue;

    try {
      const result = highlighter.highlight(code.textContent ?? "", {
        language,
        ignoreIllegals: true
      });
      code.innerHTML = result.value;
      code.classList.add("hljs");
      highlightedCount += 1;
    } catch (error) {
      console.warn(`Could not highlight ${language} code block`, error);
    }
  }

  return highlightedCount;
}

const HIGHLIGHT_TOKEN = /<span class="([^"]*)">|<\/span>|&(amp|lt|gt|quot|#x27|#39);|[^<&]+|[<&]/g;
const HIGHLIGHT_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#x27": "'", "#39": "'" };

/**
 * Where Highlight.js puts its token classes in `code`, as offsets into it, so
 * an editor can mark the text in place instead of replacing it with HTML.
 * Nested tokens give nested ranges. Empty when the language is unknown.
 * @returns {{ from: number, to: number, className: string }[]}
 */
export function highlightRanges(code, language, highlighter) {
  if (!code || !language || !highlighter?.getLanguage?.(language)) return [];
  let html;
  try {
    html = highlighter.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return [];
  }
  const ranges = [];
  const open = [];
  let pos = 0;
  for (const [token, className, entity] of html.matchAll(HIGHLIGHT_TOKEN)) {
    if (className !== undefined) {
      open.push({ from: pos, className });
    } else if (token === "</span>") {
      const span = open.pop();
      if (span && pos > span.from) ranges.push({ from: span.from, to: pos, className: span.className });
    } else {
      pos += entity ? 1 : token.length;
    }
  }
  // The output has to spell out the same text, or the offsets point elsewhere.
  return pos === code.length ? ranges.sort((a, b) => a.from - b.from || b.to - a.to) : [];
}
