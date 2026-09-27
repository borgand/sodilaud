// SPDX-License-Identifier: GPL-3.0-or-later

const TEMPLATES = {
  table: {
    block: true,
    text: "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |",
    placeholder: "Column 1"
  },
  "task-list": {
    block: true,
    text: "- [ ] Task",
    placeholder: "Task"
  },
  "code-block": {
    block: true,
    text: "```language\ncode\n```",
    placeholder: "language"
  },
  link: {
    block: false,
    text: "[link text](https://example.com)",
    placeholder: "link text"
  },
  "horizontal-rule": {
    block: true,
    paragraph: true,
    text: "---\n"
  },
  "reference-link": {
    block: true,
    text: "[link text][reference]\n\n[reference]: https://example.com",
    placeholder: "link text"
  }
};

function clampPosition(value, position) {
  const numericPosition = Number(position);
  if (!Number.isFinite(numericPosition)) return 0;
  return Math.max(0, Math.min(value.length, numericPosition));
}

// A paragraph template needs a blank line above it: "---" right under text is a setext heading.
function getLeadingBreak(before, template) {
  if (!template.block || before === "") return "";
  if (!template.paragraph) return before.endsWith("\n") ? "" : "\n";
  if (before.endsWith("\n\n")) return "";
  return before.endsWith("\n") ? "\n" : "\n\n";
}

export function getMarkdownTemplateEdit(value, selectionStart, selectionEnd, templateName) {
  const source = String(value ?? "");
  const template = TEMPLATES[templateName];
  if (!template) return null;

  const start = clampPosition(source, selectionStart);
  const end = Math.max(start, clampPosition(source, selectionEnd));
  const leadingBreak = getLeadingBreak(source.slice(0, start), template);
  const trailingBreak = template.block && end < source.length && source[end] !== "\n" ? "\n" : "";
  const replacement = `${leadingBreak}${template.text}${trailingBreak}`;
  const placeholder = template.placeholder ?? "";
  const placeholderIndex = template.placeholder === undefined
    ? template.text.length
    : template.text.indexOf(placeholder);
  const placeholderStart = start + leadingBreak.length + placeholderIndex;
  const placeholderEnd = placeholderStart + placeholder.length;

  return {
    value: source.slice(0, start) + replacement + source.slice(end),
    selectionStart: placeholderStart,
    selectionEnd: placeholderEnd
  };
}
