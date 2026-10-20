import test from "node:test";
import assert from "node:assert/strict";
import { tableCellRanges } from "../src/markdown.js";
import { Text } from "../src/vendor/codemirror.js";
import {
  cellAt,
  cellForColumn,
  cellQuote,
  escapeCellText,
  newRowText,
  rectCells,
  rectRanges,
  rowCells,
  snapToCell,
  tableGrid,
  unescapeCellText
} from "../src/table-cells.js";

const FIXTURES = [
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "a | b\n--|--\n1 | 2",
  "| x \\| y | z |\n|---|---|\n| `p|q` | r |",
  "|| b |\n|---|---|\n|   | 2 |",
  "| a | b | c |\n|---|---|---|\n| 1 |",
  "  | a |\n  |---|\n  | 1 |"
];

test("rowCells matches tableCellRanges on every fixture", () => {
  for (const fixture of FIXTURES) {
    const expected = tableCellRanges(fixture).filter((_, index) => index !== 1);
    const actual = tableGrid(fixture).rows.map((row) => row.cells.map(({ from, to }) => ({ from, to })));
    assert.deepEqual(actual, expected, fixture);
  }
});

test("segments exclude the pipes and keep padding", () => {
  assert.deepEqual(rowCells("| a  | b |", 10), [
    { segFrom: 11, segTo: 15, from: 12, to: 13, text: "a" },
    { segFrom: 16, segTo: 19, from: 17, to: 18, text: "b" }
  ]);
});

test("an escaped pipe stays in its cell; a pipe in inline code splits", () => {
  const grid = tableGrid(FIXTURES[2]);
  assert.equal(grid.rows[0].cells.length, 2);
  assert.equal(grid.rows[0].cells[0].text, "x \\| y");
  assert.deepEqual(grid.rows[1].cells.map((cell) => cell.text), ["`p", "q`", "r"]);
});

test("empty cells sit before their closing pipe", () => {
  const grid = tableGrid(FIXTURES[3]);
  assert.deepEqual(grid.rows[0].cells[0], { segFrom: 1, segTo: 1, from: 1, to: 1, text: "" });
  const blank = grid.rows[1].cells[0];
  assert.ok(blank.from === blank.segTo && blank.to === blank.segTo);
});

test("cellAt and snapToCell", () => {
  const grid = tableGrid(FIXTURES[0], 100);
  assert.deepEqual(cellAt(grid, 102), { row: 0, col: 0 });
  const next = grid.rows[0].cells[1].segFrom;
  assert.deepEqual(cellAt(grid, next), { row: 0, col: 1 });
  assert.equal(cellAt(grid, grid.separator.from + 2), null);
  assert.equal(snapToCell(grid, 100), grid.rows[0].cells[0].from);
  assert.equal(snapToCell(grid, grid.separator.from + 5), grid.rows[0].cells[1].to);
  assert.equal(snapToCell(grid, 101), grid.rows[0].cells[0].from);
  assert.equal(snapToCell(grid, grid.rows[0].to), grid.rows[0].cells[1].to);
});

test("cellForColumn picks the covering cell, else the last", () => {
  const row = tableGrid("| a | bb |\n|---|----|").rows[0];
  assert.equal(cellForColumn(row, 6).text, "bb");
  assert.equal(cellForColumn(row, 40).text, "bb");
  assert.equal(cellForColumn(row, 0).text, "a");
});

test("rectCells skips cells a short row lacks", () => {
  const grid = tableGrid(FIXTURES[4]);
  const rect = rectCells(grid, { row: 0, col: 1 }, { row: 1, col: 2 });
  assert.deepEqual(rect.map((row) => row.map((cell) => cell.text)), [["b", "c"], []]);
});

test("escape and unescape", () => {
  assert.equal(escapeCellText("a|b\\|c\nd"), "a\\|b\\|c d");
  assert.equal(escapeCellText("a\r\nb\rc"), "a b c");
  assert.equal(unescapeCellText("a\\|b"), "a|b");
});

test("newRowText keeps the indentation", () => {
  assert.equal(newRowText("  | a | b |", 2), "  |  |  |");
});

test("rectRanges and cellQuote follow the rectangle, not the source span", () => {
  const lines = ["x", "| a | b | c |", "|---|---|---|", "| d | e \\| f | g |", "| h | i | j |"];
  const doc = Text.of(lines);
  const source = lines.join("\n");
  const from = source.indexOf("b");
  const to = source.indexOf("j") + 1;
  const texts = rectRanges(doc, from, to).map((range) => source.slice(range.from, range.to));
  assert.deepEqual(texts, ["b", "c", "e \\| f", "g", "i", "j"]);
  assert.equal(cellQuote(doc, from, to), "b\tc\ne | f\tg\ni\tj");
  assert.deepEqual(rectRanges(doc, 0, to), []);
  assert.equal(cellQuote(doc, 0, to), "");

  assert.deepEqual(rectRanges(doc, to, from), rectRanges(doc, from, to));
  assert.equal(cellQuote(doc, to, from), cellQuote(doc, from, to));
});

// The same vectors as cell_text_skips_the_separator_of_any_table in
// src-tauri/src/docs/comments.rs.
test("cellQuote skips the second line of any table as its separator", () => {
  const vectors = [
    ["| a |\n|---|\n| b |", "b", "a\nb"],
    ["| a | x |\n|-|-|\n| b | y |", "y", "a\tx\nb\ty"],
    ["a | x\n--- | ---\nb | y", "y", "a\tx\nb\ty"],
    ["p\n\n| a |\n|:-:|\n| b |\n| c |", "c", "a\nb\nc"]
  ];
  for (const [source, last, quote] of vectors) {
    const doc = Text.of(source.split("\n"));
    const from = source.indexOf("a");
    const to = source.lastIndexOf(last) + 1;
    assert.equal(cellQuote(doc, from, to), quote, source);
  }
});
