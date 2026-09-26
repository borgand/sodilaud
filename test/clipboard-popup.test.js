// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createPopup, formatRemaining, slotKey } from "../src/clipboard.js";

const LISTING = {
  ttlMinutes: 10,
  items: [
    { id: 7, text: "sodilaud-infra", masked: false, secondsLeft: 540, extraLines: 0 },
    { id: 9, text: "ghp_••••Q7r8 (40)", masked: true, secondsLeft: 45, extraLines: 0 },
    { id: 11, text: "first line", masked: false, secondsLeft: 120, extraLines: 3 }
  ]
};

async function setup(listing = LISTING) {
  const html = await readFile("src/clipboard.html", "utf8");
  const dom = new JSDOM(html);
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "clip_list") return structuredClone(listing);
    if (command === "clip_reveal") return "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    return true;
  };
  const popup = createPopup({ document: dom.window.document, invoke });
  await popup.refresh();
  const key = (k) => popup.onKey(new dom.window.KeyboardEvent("keydown", { key: k }));
  return { dom, doc: dom.window.document, calls, popup, key };
}

test("the footer hint mentions j/k and h alongside the arrow keys and Space", async () => {
  const html = await readFile("src/clipboard.html", "utf8");
  const footer = html.slice(html.indexOf('class="clip-footer"'), html.indexOf("</footer>"));
  assert.match(footer, /jk/);
  assert.match(footer, /Space\/h/);
});

test("formats time left and slot keys", () => {
  assert.equal(formatRemaining(540), "9m");
  assert.equal(formatRemaining(59), "59s");
  assert.deepEqual([0, 8, 9, 10].map(slotKey), ["1", "9", "0", ""]);
});

test("renders rows with slot numbers, masks, and time left", async () => {
  const { doc } = await setup();
  const rows = [...doc.querySelectorAll(".clip-row")];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector(".clip-slot").textContent, "1");
  assert.equal(rows[1].querySelector(".clip-text").textContent, "ghp_••••Q7r8 (40)");
  assert.ok(rows[1].querySelector(".clip-reveal"));
  assert.equal(rows[0].querySelector(".clip-reveal"), null);
  assert.ok(rows[1].classList.contains("clip-expiring"));
  assert.match(rows[2].textContent, /\+3/);
  assert.equal(doc.getElementById("clip-ttl").textContent, "10 min TTL");
});

test("reveal and delete icons are outline SVGs, not emoji glyphs", async () => {
  const { doc } = await setup();
  const rows = [...doc.querySelectorAll(".clip-row")];
  const eye = rows[1].querySelector(".clip-reveal");
  const trash = rows[0].querySelector(".clip-trash");
  assert.equal(eye.getAttribute("aria-label"), "Reveal");
  assert.equal(eye.textContent, "", "the button must hold an svg icon, not emoji text");
  const eyeSvg = eye.querySelector("svg");
  assert.ok(eyeSvg, "reveal button must contain an svg icon");
  assert.equal(eyeSvg.getAttribute("fill"), "none");
  assert.equal(eyeSvg.getAttribute("stroke"), "currentColor");
  assert.equal(trash.getAttribute("aria-label"), "Delete");
  const trashSvg = trash.querySelector("svg");
  assert.ok(trashSvg, "delete button must contain an svg icon");
  assert.equal(trashSvg.getAttribute("fill"), "none");
  assert.equal(trashSvg.getAttribute("stroke"), "currentColor");
});

test("revealing swaps the eye icon and aria-label to Hide, and back on hide", async () => {
  const { doc, key } = await setup();
  await key("ArrowDown");
  await key(" ");
  const revealedButton = doc.querySelectorAll(".clip-row")[1].querySelector(".clip-reveal");
  assert.equal(revealedButton.getAttribute("aria-label"), "Hide");
  assert.ok(revealedButton.querySelector("svg"));
  await key(" ");
  const hiddenButton = doc.querySelectorAll(".clip-row")[1].querySelector(".clip-reveal");
  assert.equal(hiddenButton.getAttribute("aria-label"), "Reveal");
});

test("digit keys pick by slot", async () => {
  const { calls, key } = await setup();
  await key("2");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 9 } });
});

test("arrows and Enter pick the focused row", async () => {
  const { calls, key } = await setup();
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Enter");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 11 } });
});

test("j and k move focus like ArrowDown and ArrowUp", async () => {
  const { calls, key } = await setup();
  await key("j");
  await key("j");
  await key("Enter");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 11 } });
  await key("k");
  await key("Enter");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 9 } });
});

test("h reveals and re-masks a masked row like Space", async () => {
  const { doc, key } = await setup();
  await key("ArrowDown");
  await key("h");
  assert.match(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, /^ghp_A1b2/);
  await key("h");
  assert.equal(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, "ghp_••••Q7r8 (40)");
});

test("l and uppercase J do nothing", async () => {
  const { dom, calls, popup } = await setup();
  const before = calls.length;
  const focusedBefore = popup.state().focused;
  await popup.onKey(new dom.window.KeyboardEvent("keydown", { key: "l" }));
  await popup.onKey(new dom.window.KeyboardEvent("keydown", { key: "J" }));
  await popup.onKey(new dom.window.KeyboardEvent("keydown", { key: "K" }));
  await popup.onKey(new dom.window.KeyboardEvent("keydown", { key: "H" }));
  assert.equal(calls.length, before);
  assert.equal(popup.state().focused, focusedBefore);
});

test("Space reveals and re-masks a masked row", async () => {
  const { doc, key } = await setup();
  await key("ArrowDown");
  await key(" ");
  assert.match(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, /^ghp_A1b2/);
  await key(" ");
  assert.equal(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, "ghp_••••Q7r8 (40)");
});

test("Backspace deletes the focused row", async () => {
  const { calls, key } = await setup();
  await key("Backspace");
  assert.ok(calls.some(c => c.command === "clip_delete" && c.args.id === 7));
});

test("Escape asks Rust to close the popup", async () => {
  const { calls, key } = await setup();
  await key("Escape");
  assert.deepEqual(calls.at(-1), { command: "clip_close", args: undefined });
});

test("the close button asks Rust to close the popup", async () => {
  const { doc, calls } = await setup();
  doc.getElementById("clip-close").click();
  assert.deepEqual(calls.at(-1), { command: "clip_close", args: undefined });
});

test("empty history shows the TTL hint", async () => {
  const { doc } = await setup({ ttlMinutes: 10, items: [] });
  const empty = doc.getElementById("clip-empty");
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "Nothing copied yet. Entries expire after 10 min.");
});

test("values render as text, never markup", async () => {
  const { doc } = await setup({ ttlMinutes: 10, items: [{ id: 1, text: "<img src=x onerror=alert(1)>", masked: false, secondsLeft: 60, extraLines: 0 }] });
  assert.equal(doc.querySelector("img"), null);
});

test("focus follows the entry across a refresh that inserts a new copy at the top", async () => {
  const listing = structuredClone(LISTING);
  const { calls, key, popup } = await setup(listing);
  await key("ArrowDown");
  listing.items.unshift({ id: 20, text: "new copy", masked: false, secondsLeft: 600, extraLines: 0 });
  await popup.refresh();
  await key("Enter");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 9 } });
});

test("keys with a modifier do nothing", async () => {
  const { dom, calls, popup } = await setup();
  const before = calls.length;
  for (const modifier of ["metaKey", "ctrlKey", "altKey"]) {
    await popup.onKey(new dom.window.KeyboardEvent("keydown", { key: "2", [modifier]: true }));
    await popup.onKey(new dom.window.KeyboardEvent("keydown", { key: "Backspace", [modifier]: true }));
  }
  assert.equal(calls.length, before);
});

test("the focused row is scrolled into view", async () => {
  const { dom, key } = await setup();
  const scrolled = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ row: this, options }); };
  await key("ArrowDown");
  const last = scrolled.at(-1);
  assert.ok(last.row.classList.contains("clip-focused"));
  assert.equal(last.row.querySelector(".clip-slot").textContent, "2");
  assert.deepEqual(last.options, { block: "nearest" });
});

test("a refresh with the same entries patches rows in place", async () => {
  const listing = structuredClone(LISTING);
  const { doc, popup } = await setup(listing);
  const before = [...doc.querySelectorAll(".clip-row")];
  listing.items[0].secondsLeft = 30;
  listing.items[1].secondsLeft = 44;
  await popup.refresh();
  const after = [...doc.querySelectorAll(".clip-row")];
  assert.equal(after.length, before.length);
  after.forEach((row, index) => assert.equal(row, before[index], `row ${index} is the same node`));
  assert.equal(after[0].querySelector(".clip-time").textContent, "30s");
  assert.ok(after[0].classList.contains("clip-expiring"));
  assert.equal(after[1].querySelector(".clip-time").textContent, "44s");
});

test("a refresh with a new entry rebuilds the rows", async () => {
  const listing = structuredClone(LISTING);
  const { doc, popup } = await setup(listing);
  const before = doc.querySelector(".clip-row");
  listing.items.unshift({ id: 30, text: "fresh", masked: false, secondsLeft: 600, extraLines: 0 });
  await popup.refresh();
  const rows = [...doc.querySelectorAll(".clip-row")];
  assert.equal(rows.length, 4);
  assert.notEqual(rows[0], before);
  assert.equal(rows[0].querySelector(".clip-text").textContent, "fresh");
});

function cssRule(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `selector ${selector} not found`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("the focused row's accent border has a non-zero width and a solid style", async () => {
  const css = await readFile("src/clipboard.css", "utf8");
  const base = cssRule(css, ".clip-row");
  const focused = cssRule(css, ".clip-row.clip-focused");
  // The width/style live on the base rule (shared by every row) so the border
  // reserves its space whether or not a row is focused; only the colour flips.
  assert.match(base, /border-left:\s*[1-9]\d*px\s+solid\s+/, "the base row must reserve a non-zero, solid border-left");
  assert.match(focused, /border-left-color:\s*var\(--clip-accent\)/, "the focused row must recolour that border to the accent");
  assert.doesNotMatch(focused, /padding-left/, "the focused row must not shift its padding relative to other rows");
});

test("a listing with a theme sets the popup CSS variables and ignores a non-hex value", async () => {
  const listing = structuredClone(LISTING);
  listing.theme = {
    background: "#101010",
    surface: "#202020",
    text: "#e0e0e0",
    muted: "#808080",
    accent: "#3b82f6",
    border: "javascript:alert(1)"
  };
  const { doc } = await setup(listing);
  const root = doc.documentElement;
  assert.equal(root.style.getPropertyValue("--clip-bg"), "#101010");
  assert.equal(root.style.getPropertyValue("--clip-surface"), "#202020");
  assert.equal(root.style.getPropertyValue("--clip-fg"), "#e0e0e0");
  assert.equal(root.style.getPropertyValue("--clip-muted"), "#808080");
  assert.equal(root.style.getPropertyValue("--clip-accent"), "#3b82f6");
  assert.equal(root.style.getPropertyValue("--clip-line"), "", "a non-hex value must not be applied");
});

test("a listing without a theme leaves the popup's default CSS variables alone", async () => {
  const { doc } = await setup();
  assert.equal(doc.documentElement.style.getPropertyValue("--clip-bg"), "");
});

test("a refresh never scrolls", async () => {
  const listing = structuredClone(LISTING);
  const { dom, popup } = await setup(listing);
  const scrolled = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  await popup.refresh();
  listing.items.unshift({ id: 31, text: "fresh", masked: false, secondsLeft: 600, extraLines: 0 });
  await popup.refresh();
  assert.equal(scrolled.length, 0);
});
