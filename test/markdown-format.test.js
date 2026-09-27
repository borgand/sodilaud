// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { FORMAT_ACTIONS, getFormatEdit } from "../src/markdown-format.js";
import { getMarkdownTemplateEdit } from "../src/markdown-insert.js";

// "«" and "»" mark a selection, "‸" marks a caret.
function parse(marked) {
  const caret = marked.indexOf("‸");
  if (caret !== -1) return { value: marked.replace("‸", ""), start: caret, end: caret };
  const start = marked.indexOf("«");
  const end = marked.indexOf("»") - 1;
  return { value: marked.replace("«", "").replace("»", ""), start, end };
}

function render(edit) {
  if (!edit) return null;
  const { value, selectionStart: start, selectionEnd: end } = edit;
  if (start === end) return value.slice(0, start) + "‸" + value.slice(start);
  return value.slice(0, start) + "«" + value.slice(start, end) + "»" + value.slice(end);
}

function format(marked, actionId) {
  const { value, start, end } = parse(marked);
  return render(getFormatEdit(value, start, end, actionId));
}

function textOf(marked) {
  return parse(marked).value;
}

test("FORMAT_ACTIONS lists every formatting action id", () => {
  assert.deepEqual([...FORMAT_ACTIONS], [
    "bold", "italic", "strikethrough", "code", "link",
    "heading-1", "heading-2", "heading-3", "heading-4", "heading-5", "heading-6", "paragraph",
    "bullet-list", "numbered-list", "task-list", "quote",
    "code-block", "table", "horizontal-rule"
  ]);
  assert.equal(getFormatEdit("x", 0, 1, "unknown"), null);
});

const inlineMarks = [
  ["bold", "**"],
  ["italic", "*"],
  ["strikethrough", "~~"],
  ["code", "`"]
];

for (const [id, marker] of inlineMarks) {
  test(`${id} wraps a selection and unwraps it from inside or outside`, () => {
    assert.equal(format("a «word» b", id), `a ${marker}«word»${marker} b`);
    assert.equal(format(`a ${marker}«word»${marker} b`, id), "a «word» b");
    assert.equal(format(`a «${marker}word${marker}» b`, id), "a «word» b");
  });

  test(`${id} acts on the word at the caret`, () => {
    assert.equal(format("say hel‸lo now", id), `say ${marker}hel‸lo${marker} now`);
    assert.equal(format(`say ${marker}hel‸lo${marker} now`, id), "say hel‸lo now");
  });

  test(`${id} inserts an empty marker pair outside a word and removes it again`, () => {
    assert.equal(format("a ‸", id), `a ${marker}‸${marker}`);
    assert.equal(format("a ‸ b", id), `a ${marker}‸${marker} b`);
    assert.equal(format(`a ${marker}‸${marker}`, id), "a ‸");
  });

  test(`${id} acts on the word when the caret sits at its edge`, () => {
    assert.equal(format("hello‸ world", id), `${marker}hello‸${marker} world`);
    assert.equal(format("say ‸hello", id), `say ${marker}‸hello${marker}`);
    assert.equal(format(`${marker}‸bold${marker} x`, id), "‸bold x");
    assert.equal(format(`x ${marker}bold‸${marker}`, id), "x bold‸");
  });

  test(`${id} keeps whitespace and line breaks at the selection edges outside the marks`, () => {
    assert.equal(format("«line one\n»next", id), `${marker}«line one»${marker}\nnext`);
    assert.equal(format("a «word »b", id), `a ${marker}«word»${marker} b`);
    assert.equal(format("a« word» b", id), `a ${marker}«word»${marker} b`);
    assert.equal(format(`«${marker}line${marker}\n»next`, id), "«line»\nnext");
    assert.equal(format("«\n»next", id), `${marker}‸${marker}\nnext`);
    assert.equal(format("a « » b", id), `a ${marker}‸${marker}  b`);
  });
}

test("italic and bold tell single and double asterisks apart", () => {
  assert.equal(format("**«x»**", "italic"), "***«x»***");
  assert.equal(format("***«x»***", "italic"), "**«x»**");
  assert.equal(format("*«x»*", "bold"), "***«x»***");
  assert.equal(format("***«x»***", "bold"), "*«x»*");
});

test("link wraps a selection and selects the url", () => {
  assert.equal(format("see «docs» now", "link"), "see [docs](«url») now");
});

test("link inside an existing link selects its url", () => {
  assert.equal(format("see [docs](«url») now", "link"), "see [docs](«url») now");
  assert.equal(format("see «[docs](https://a.b)» now", "link"), "see [docs](«https://a.b») now");
  assert.equal(format("see [do‸cs](https://a.b) now", "link"), "see [docs](«https://a.b») now");
  assert.equal(format("see [docs](https://‸a.b) now", "link"), "see [docs](«https://a.b») now");
});

test("link keeps whitespace and line breaks at the selection edges outside the link", () => {
  assert.equal(format("«line one\n»next", "link"), "[line one](«url»)\nnext");
  assert.equal(format("a «word »b", "link"), "a [word](«url») b");
  assert.equal(format("«\n»next", "link"), render(getMarkdownTemplateEdit("\nnext", 0, 0, "link")));
});

test("link with an empty selection inserts the link template", () => {
  const expected = getMarkdownTemplateEdit("go ", 3, 3, "link");
  assert.equal(format("go ‸", "link"), render(expected));
});

test("link leaves images alone", () => {
  assert.equal(format("![al‸t](a.png)", "link"), render(getMarkdownTemplateEdit("![alt](a.png)", 4, 4, "link")));
});

test("heading sets, changes and removes the level", () => {
  assert.equal(format("‸title", "heading-2"), "## ‸title");
  assert.equal(format("## ‸title", "heading-2"), "‸title");
  assert.equal(format("# «title»", "heading-3"), "### «title»");
  assert.equal(format("x\n‸title", "heading-6"), "x\n###### ‸title");
  assert.equal(format("> ‸quoted", "heading-1"), "> # ‸quoted");
});

test("heading on a list line goes after the list marker", () => {
  assert.equal(format("- ‸item", "heading-2"), "- ## ‸item");
  assert.equal(format("- ## ‸item", "heading-2"), "- ‸item");
  assert.equal(format("- # ‸item", "heading-3"), "- ### ‸item");
  assert.equal(format("- ## ‸item", "paragraph"), "- ‸item");
  assert.equal(format("- [ ] ‸task", "heading-1"), "- [ ] # ‸task");
  assert.equal(format("1. ‸x", "heading-3"), "1. ### ‸x");
  assert.equal(format("> - ‸q", "heading-1"), "> - # ‸q");
});

test("heading applies per line across a selection and skips blank lines", () => {
  assert.equal(format("«one\n\ntwo»", "heading-1"), "«# one\n\n# two»");
  assert.equal(format("«# one\n\n# two»", "heading-1"), "«one\n\ntwo»");
  assert.equal(format("«# one\n## two»", "heading-2"), "«## one\n## two»");
  assert.equal(format("«## one\n## two»", "heading-2"), "«one\ntwo»");
});

test("heading ignores a line after a selection that ends at its start", () => {
  assert.equal(format("«one\n»two", "heading-1"), "«# one\n»two");
});

test("paragraph removes headings and does nothing on plain text", () => {
  assert.equal(format("### ‸x", "paragraph"), "‸x");
  assert.equal(format("«# a\nb»", "paragraph"), "«a\nb»");
  assert.equal(format("plain‸", "paragraph"), null);
});

test("lists toggle per line and skip blank lines", () => {
  assert.equal(format("«a\n\nb»", "bullet-list"), "«- a\n\n- b»");
  assert.equal(format("«- a\n\n- b»", "bullet-list"), "«a\n\nb»");
  assert.equal(format("‸a", "task-list"), "- [ ] ‸a");
  assert.equal(format("- [ ] ‸a", "task-list"), "‸a");
  assert.equal(format("«a\n\nb\nc»", "numbered-list"), "«1. a\n\n2. b\n3. c»");
  assert.equal(format("‸", "bullet-list"), "- ‸");
});

test("lists switch kind by replacing the prefix and renumber 1..n", () => {
  assert.equal(format("«- a\n- b»", "numbered-list"), "«1. a\n2. b»");
  assert.equal(format("«3. a\n7. b»", "bullet-list"), "«- a\n- b»");
  assert.equal(format("«- [x] a\n- [ ] b»", "numbered-list"), "«1. a\n2. b»");
  assert.equal(format("«1. a\nb»", "numbered-list"), "«1. a\n2. b»");
  assert.equal(format("«5. a\n9. b»", "task-list"), "«- [ ] a\n- [ ] b»");
});

test("lists preserve indentation and number nested levels separately", () => {
  assert.equal(format("«a\n    b»", "bullet-list"), "«- a\n    - b»");
  assert.equal(format("«a\n    b\n    c\nd»", "numbered-list"), "«1. a\n    1. b\n    2. c\n2. d»");
  assert.equal(format("«  - a\n  - b»", "numbered-list"), "«  1. a\n  2. b»");
  assert.equal(format("> ‸a", "bullet-list"), "> - ‸a");
});

test("quote toggles per line and skips blank lines", () => {
  assert.equal(format("«a\n\nb»", "quote"), "«> a\n\n> b»");
  assert.equal(format("«> a\n\n> b»", "quote"), "«a\n\nb»");
  assert.equal(format("‸x", "quote"), "> ‸x");
  assert.equal(format("«  a\n> b»", "quote"), "«>   a\n> > b»");
});

test("code block with an empty selection inserts the template", () => {
  const expected = getMarkdownTemplateEdit("x\n", 2, 2, "code-block");
  assert.equal(format("x\n‸", "code-block"), render(expected));
});

test("code block wraps the selected lines in a fence and unwraps it", () => {
  assert.equal(format("x\n«a\nb»\ny", "code-block"), "x\n```\n«a\nb»\n```\ny");
  assert.equal(format("x\n```\n«a\nb»\n```\ny", "code-block"), "x\n«a\nb»\ny");
  assert.equal(format("x\nfo«o\nba»r", "code-block"), "x\n```\nfo«o\nba»r\n```");
  assert.equal(format("«```\na\n```»", "code-block"), "«a»");
  assert.equal(format("«a\n```js\nb\n```»", "code-block"), "````\n«a\n```js\nb\n```»\n````");
});

test("code block inside an existing fence does nothing", () => {
  assert.equal(format("x\n```\n«a»\nb\nc\n```\ny", "code-block"), null);
  assert.equal(format("```\na‸\nb\n```", "code-block"), null);
});

test("table inserts the table template", () => {
  const expected = getMarkdownTemplateEdit("x", 1, 1, "table");
  assert.equal(format("x‸", "table"), render(expected));
});

test("table and horizontal rule insert after the selected lines and keep the selection text", () => {
  const value = "a\nkeep this\nnext";
  assert.equal(format("a\n«keep» this\nnext", "table"), render(getMarkdownTemplateEdit(value, 11, 11, "table")));
  assert.equal(format("«keep» this", "horizontal-rule"), "keep this\n\n---\n‸");
  assert.equal(format("«a\nb»\nc", "horizontal-rule"), "a\nb\n\n---\n‸\nc");
});

test("horizontal rule sits on its own paragraph so it never makes a heading", () => {
  assert.equal(format("‸", "horizontal-rule"), "---\n‸");
  assert.equal(format("foo‸", "horizontal-rule"), "foo\n\n---\n‸");
  assert.equal(format("foo‸\nbar", "horizontal-rule"), "foo\n\n---\n‸\nbar");
  assert.equal(format("foo\n‸\nbar", "horizontal-rule"), "foo\n\n---\n‸\nbar");
  assert.equal(format("foo\n\n‸", "horizontal-rule"), "foo\n\n---\n‸");
});

const roundTrips = [
  ["bold", ["a «word» b", "say hel‸lo", "a ‸", "«**x**»", "«line one\n»next", "hello‸ world"]],
  ["italic", ["a «word» b", "say hel‸lo", "a ‸", "**«x»**"]],
  ["strikethrough", ["a «word» b", "say hel‸lo", "a ‸"]],
  ["code", ["a «word» b", "say hel‸lo", "a ‸"]],
  ...[1, 2, 3, 4, 5, 6].map(level => [`heading-${level}`, ["‸title", "«one\n\n  two»", "> ‸q", "- ‸item"]]),
  ["bullet-list", ["‸a", "«one\n\n  two\nthree»", "> ‸q"]],
  ["numbered-list", ["‸a", "«one\n\n  two\nthree»"]],
  ["task-list", ["‸a", "«one\n\n  two\nthree»"]],
  ["quote", ["‸a", "«one\n\n  two\n> three»"]],
  ["code-block", ["x\n«a\nb»\ny", "«a»"]]
];

for (const [id, samples] of roundTrips) {
  test(`${id} applied twice restores the original text`, () => {
    for (const sample of samples) {
      const once = format(sample, id);
      assert.notEqual(once, null, sample);
      assert.equal(textOf(format(once, id)), textOf(sample), sample);
    }
  });
}
