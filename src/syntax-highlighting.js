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
