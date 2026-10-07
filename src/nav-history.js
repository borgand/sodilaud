// SPDX-License-Identifier: GPL-3.0-or-later

// Back and forward over link jumps, as in a browser. An entry is a place,
// { path, top, anchor? }: the file, its scroll offset and the anchor a link
// jumped to. Leaving a place records where it was scrolled to, so going back
// lands where the reader left off.
const LIMIT = 100;

const samePlace = (a, b) => a.path === b.path && a.top === b.top && a.anchor === b.anchor;

export function createNavHistory() {
  let entries = [];
  let index = -1;

  return {
    // Before a jump: `from` is where the reader is now, `to` where they land.
    visit(from, to) {
      if (!from?.path || !to?.path) return;
      entries = entries.slice(0, index + 1);
      if (index >= 0 && entries[index].path === from.path) entries[index] = from;
      else entries.push(from);
      if (!samePlace(entries.at(-1), to)) entries.push(to);
      if (entries.length > LIMIT) entries = entries.slice(entries.length - LIMIT);
      index = entries.length - 1;
    },
    back(current) {
      if (index <= 0) return null;
      if (current?.path === entries[index].path) entries[index] = current;
      index -= 1;
      return entries[index];
    },
    forward(current) {
      if (index >= entries.length - 1) return null;
      if (current?.path === entries[index].path) entries[index] = current;
      index += 1;
      return entries[index];
    },
    canBack: () => index > 0,
    canForward: () => index >= 0 && index < entries.length - 1
  };
}
