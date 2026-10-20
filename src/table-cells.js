import { isSeparatorRow } from "./editor-tables.js";

function splitLine(lineText, lineFrom) {
  const segments = [];
  let segStart = 0;
  let backslashes = 0;
  for (let i = 0; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === "|" && backslashes % 2 === 0) {
      segments.push([segStart, i]);
      segStart = i + 1;
    }
    backslashes = 0;
  }
  const piped = segments.length > 0;
  segments.push([segStart, lineText.length]);

  const blank = ([from, to]) => lineText.slice(from, to).trim() === "";
  if (segments.length > 1 && blank(segments[0])) segments.shift();
  if (segments.length > 1 && blank(segments[segments.length - 1])) segments.pop();

  const cells = segments.map(([segFrom, segTo]) => {
    let from = segFrom;
    let to = segTo;
    while (from < to && (lineText[from] === " " || lineText[from] === "\t")) from++;
    while (to > from && (lineText[to - 1] === " " || lineText[to - 1] === "\t")) to--;
    return {
      segFrom: lineFrom + segFrom,
      segTo: lineFrom + segTo,
      from: lineFrom + from,
      to: lineFrom + to,
      text: lineText.slice(from, to)
    };
  });
  return { cells, piped };
}

export function rowCells(lineText, lineFrom) {
  return splitLine(lineText, lineFrom).cells;
}

export function tableGrid(source, offset = 0) {
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const rows = [];
  let separator = { from: offset, to: offset };
  let lineFrom = offset;
  lines.forEach((text, index) => {
    const lineTo = lineFrom + text.length;
    if (index === 1) separator = { from: lineFrom, to: lineTo };
    else rows.push({ from: lineFrom, to: lineTo, cells: rowCells(text, lineFrom) });
    lineFrom = lineTo + 1;
  });
  return { rows, separator, columns: rows.length ? rows[0].cells.length : 0 };
}

function cellIndexAt(cells, pos) {
  return cells.findIndex((cell) => pos >= cell.segFrom && pos <= cell.segTo);
}

export function cellAt(grid, pos) {
  for (let row = 0; row < grid.rows.length; row++) {
    const { from, to, cells } = grid.rows[row];
    if (pos < from || pos > to) continue;
    const col = cellIndexAt(cells, pos);
    return col === -1 ? null : { row, col };
  }
  return null;
}

export function cellForColumn(row, column) {
  const pos = row.from + column;
  const { cells } = row;
  if (pos < cells[0].segFrom) return cells[0];
  const index = cellIndexAt(cells, pos);
  return index === -1 ? cells[cells.length - 1] : cells[index];
}

export function snapToCell(grid, pos) {
  const { rows, separator } = grid;
  if (pos >= separator.from && pos <= separator.to) {
    return cellForColumn(rows[0], pos - separator.from).to;
  }
  const row = rows.find((candidate) => pos >= candidate.from && pos <= candidate.to);
  if (!row) {
    return pos < rows[0].from ? rows[0].cells[0].from : rows[rows.length - 1].cells.at(-1).to;
  }
  const first = row.cells[0];
  const last = row.cells[row.cells.length - 1];
  if (pos < first.segFrom) return first.from;
  if (pos > last.segTo) return last.to;
  const cell = row.cells[cellIndexAt(row.cells, pos)];
  return Math.min(Math.max(pos, cell.from), cell.to);
}

export function rectCells(grid, a, b) {
  const rowMin = Math.min(a.row, b.row);
  const rowMax = Math.max(a.row, b.row);
  const colMin = Math.min(a.col, b.col);
  const colMax = Math.max(a.col, b.col);
  const result = [];
  for (let r = rowMin; r <= rowMax; r++) {
    const cells = grid.rows[r]?.cells ?? [];
    result.push(cells.slice(colMin, colMax + 1));
  }
  return result;
}

export function escapeCellText(text) {
  const flat = text.replace(/\r\n|\n|\r/g, " ");
  let out = "";
  let backslashes = 0;
  for (const ch of flat) {
    if (ch === "\\") {
      backslashes++;
      out += ch;
      continue;
    }
    out += ch === "|" && backslashes % 2 === 0 ? "\\|" : ch;
    backslashes = 0;
  }
  return out;
}

export function unescapeCellText(text) {
  return text.replace(/\\\|/g, "|");
}

export function newRowText(headerLineText, columns) {
  const indent = headerLineText.match(/^\s*/)[0];
  return `${indent}|${"  |".repeat(columns)}`;
}

function tableLine(line) {
  if (isSeparatorRow(line.text)) return null;
  const { cells, piped } = splitLine(line.text, line.from);
  return piped ? cells : null;
}

function rectWalk(doc, a, b) {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const start = doc.lineAt(from);
  const end = doc.lineAt(to);
  const fromCells = tableLine(start);
  const toCells = tableLine(end);
  if (!fromCells || !toCells) return [];
  const fromCol = cellIndexAt(fromCells, from);
  const toCol = cellIndexAt(toCells, to);
  if (fromCol === -1 || toCol === -1) return [];
  const colMin = Math.min(fromCol, toCol);
  const colMax = Math.max(fromCol, toCol);
  const rows = [];
  for (let n = start.number; n <= end.number; n++) {
    const cells = tableLine(doc.line(n));
    if (!cells) continue;
    const picked = cells.slice(colMin, colMax + 1);
    if (picked.length) rows.push(picked);
  }
  return rows;
}

export function rectRanges(doc, from, to) {
  return rectWalk(doc, from, to)
    .flat()
    .filter((cell) => cell.from < cell.to)
    .map(({ from: cellFrom, to: cellTo }) => ({ from: cellFrom, to: cellTo }));
}

export function cellQuote(doc, from, to) {
  return rectWalk(doc, from, to)
    .map((row) => row.map((cell) => unescapeCellText(cell.text)).join("\t"))
    .join("\n");
}
