// SPDX-License-Identifier: GPL-3.0-or-later

export const UNTITLED_TITLE = "Untitled Scratchpad";
const TITLE_UNITS = 30;

// The title a note shows until the user names it: the first line without
// heading marks, at most 30 UTF-16 units. Rust derives the same title
// (`auto_title` in docs/registry.rs), so the page can show it before the
// change round-trips.
export function autoTitle(content) {
  const first = String(content ?? "").trim().split("\n")[0].replace(/^#+\s+/, "").trim();
  let title = "";
  for (const character of first) {
    if (title.length + character.length > TITLE_UNITS) break;
    title += character;
  }
  return title || UNTITLED_TITLE;
}
