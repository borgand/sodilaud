// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { attach, createPopup, formatRemaining, slotKey } from "../src/clipboard.js";

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

// Splits a grid-template-columns value into its tracks, respecting spaces inside
// function-like tracks such as minmax(0, 1fr) so it is not mistaken for two tracks.
function splitTracks(value) {
  const guarded = value.replace(/\(([^)]*)\)/g, (_, inner) => `(${inner.replace(/\s+/g, "\u0000")})`);
  return guarded.trim().split(/\s+/).map((t) => t.replace(/\u0000/g, " "));
}

test("clip-row is a CSS grid with 5 fixed column tracks so icons line up across independently-sized rows", async () => {
  const css = await readFile("src/clipboard.css", "utf8");
  const base = cssRule(css, ".clip-row");
  assert.match(base, /display:\s*grid/, "clip-row must be a grid, not a flex row");
  const match = base.match(/grid-template-columns:\s*([^;]+);/);
  assert.ok(match, "clip-row must declare grid-template-columns");
  assert.equal(splitTracks(match[1]).length, 5, `expected 5 column tracks, got: ${match[1]}`);
});

test("an unmasked row still reserves the eye column, and revealing a masked row keeps the same cell order and count", async () => {
  const { doc, key } = await setup();
  const rows = [...doc.querySelectorAll(".clip-row")];
  assert.equal(rows[0].children.length, 5, "every row has 5 top-level cells, masked or not");
  assert.ok(rows[0].querySelector(".clip-eye-slot"), "an unmasked row still renders an eye placeholder cell");
  const beforeTags = [...rows[1].children].map((c) => c.className.split(" ")[0]);
  await key("ArrowDown");
  await key(" ");
  const revealedRow = doc.querySelectorAll(".clip-row")[1];
  const afterTags = [...revealedRow.children].map((c) => c.className.split(" ")[0]);
  assert.equal(afterTags.length, beforeTags.length, "revealing must not change the cell count");
  assert.deepEqual(afterTags, beforeTags, "revealing must not reorder or add/remove cells");
});

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

function fakeTimers() {
  const live = new Map();
  let next = 1;
  return {
    live,
    setInterval(fn, ms) { const id = next++; live.set(id, { fn, ms }); return id; },
    clearInterval(id) { live.delete(id); }
  };
}

async function setupHidden(listing = LISTING, { manualPaint = false } = {}) {
  const html = await readFile("src/clipboard.html", "utf8");
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const calls = [];
  const pending = [];
  const timers = fakeTimers();
  const invoke = async (command, args) => {
    calls.push({ command, args, rows: doc.querySelectorAll(".clip-row").length });
    if (command === "clip_list") return structuredClone(listing);
    if (command === "clip_reveal") {
      if (pending.hold) return new Promise((resolve) => pending.push(resolve));
      return "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    }
    return true;
  };
  const paints = [];
  const afterPaint = () => (manualPaint ? new Promise((resolve) => paints.push(resolve)) : Promise.resolve());
  const popup = createPopup({ document: doc, invoke, timers, afterPaint });
  const key = (k) => popup.onKey(new dom.window.KeyboardEvent("keydown", { key: k }));
  const paint = async () => {
    paints.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { dom, doc, calls, pending, timers, popup, key, paint };
}

test("show fetches and renders the list, starts the refresh timer, then signals readiness", async () => {
  const { doc, calls, timers, popup } = await setupHidden();
  await popup.show(4);
  const shown = calls.find((c) => c.command === "clip_shown");
  assert.ok(shown, "show must invoke clip_shown");
  assert.deepEqual(shown.args, { token: 4 }, "readiness echoes the show's token");
  assert.equal(calls[0].command, "clip_list", "the list is fetched first");
  assert.equal(shown.rows, 3, "rows are rendered before readiness is signalled");
  assert.equal(doc.querySelectorAll(".clip-row").length, 3);
  assert.equal(timers.live.size, 1, "one refresh timer runs while shown");
  assert.equal([...timers.live.values()][0].ms, 1000);
});

test("hide forgets revealed values, items, and rows, and stops the refresh timer", async () => {
  const { doc, timers, popup, key } = await setupHidden();
  await popup.show();
  await key("ArrowDown");
  await key(" ");
  assert.equal(popup.state().revealed.size, 1);
  popup.hide();
  assert.equal(popup.state().revealed.size, 0);
  assert.deepEqual(popup.state().items, []);
  assert.equal(doc.getElementById("clip-list").children.length, 0);
  assert.equal(doc.body.textContent.includes("ghp_"), false, "no value text may remain in the page");
  assert.equal(timers.live.size, 0, "the refresh timer must stop");
});

test("a show again after hide starts exactly one timer and re-masks revealed rows", async () => {
  const { doc, timers, popup, key } = await setupHidden();
  await popup.show();
  await key("ArrowDown");
  await key(" ");
  popup.hide();
  await popup.show();
  assert.equal(timers.live.size, 1);
  assert.equal(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, "ghp_••••Q7r8 (40)");
});

test("a show cut short by hide neither renders nor signals readiness", async () => {
  const { doc, calls, timers, popup } = await setupHidden();
  const showing = popup.show();
  popup.hide();
  await showing;
  assert.equal(calls.some((c) => c.command === "clip_shown"), false);
  assert.equal(doc.querySelectorAll(".clip-row").length, 0);
  assert.equal(timers.live.size, 0);
});

test("a reveal that answers after hide is dropped", async () => {
  const { doc, pending, popup, key } = await setupHidden();
  await popup.show();
  pending.hold = true;
  await key("ArrowDown");
  const revealing = key(" ");
  popup.hide();
  pending.forEach((resolve) => resolve("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"));
  await revealing;
  assert.equal(popup.state().revealed.size, 0);
  assert.equal(doc.body.textContent.includes("ghp_A1b2"), false);
});

test("a refresh that answers after hide leaves the page empty", async () => {
  const { doc, popup } = await setupHidden();
  await popup.show();
  const refreshing = popup.refresh();
  popup.hide();
  await refreshing;
  assert.equal(doc.querySelectorAll(".clip-row").length, 0);
  assert.deepEqual(popup.state().items, []);
});

test("mousedown on the header starts a window drag, but not on the close button or with another button", async () => {
  const { dom, doc, calls } = await setupHidden();
  const header = doc.querySelector(".clip-header");
  const title = doc.getElementById("clip-title");
  const close = doc.getElementById("clip-close");
  const down = (target, button = 0) =>
    target.dispatchEvent(new dom.window.MouseEvent("mousedown", { button, bubbles: true }));
  down(title);
  assert.deepEqual(calls.map((c) => c.command), ["clip_start_drag"]);
  down(header);
  assert.equal(calls.length, 2);
  down(close);
  down(header, 2);
  assert.equal(calls.length, 2, "close button and non-primary buttons must not drag");
});

test("the header text cannot be selected", async () => {
  const css = await readFile("src/clipboard.css", "utf8");
  const header = cssRule(css, ".clip-header");
  assert.match(header, /-webkit-user-select:\s*none/);
  assert.match(header, /(?<!-)user-select:\s*none/);
});

test("attach exposes the show/hide hooks and honours a show requested before the page loaded", async () => {
  const shown = [];
  const popup = { show: (token) => shown.push(`show ${token}`), hide: () => shown.push("hide") };
  const win = { __sodilaudClipPending: 5 };
  attach(win, popup);
  assert.deepEqual(shown, ["show 5"]);
  assert.equal(win.__sodilaudClipPending, false);
  win.__sodilaudClip.hide();
  assert.deepEqual(shown, ["show 5", "hide"]);
  attach({ __sodilaudClipPending: false }, { show: () => shown.push("again") });
  assert.deepEqual(shown, ["show 5", "hide"], "no pending token, no show");
});

async function rustScript(name, token) {
  const source = await readFile("src-tauri/src/clipboard/popup_state.rs", "utf8");
  const match = source.match(new RegExp(`fn ${name}\\(token: u64\\) -> String \\{\\s*format!\\(\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  assert.ok(match, `${name} not found in popup_state.rs`);
  return match[1].replaceAll('\\"', '"').replaceAll("{token}", String(token));
}

test("the Rust eval scripts call the hooks with their token, or leave the token before the page has loaded", async () => {
  const show = new Function("window", await rustScript("show_script", 12));
  const hide = new Function("window", await rustScript("hide_script", 13));
  const early = {};
  show(early);
  assert.equal(early.__sodilaudClipPending, 12);
  hide(early);
  assert.equal(early.__sodilaudClipPending, false);
  const seen = [];
  const loaded = { __sodilaudClip: { show: (t) => seen.push(`show ${t}`), hide: (t) => seen.push(`hide ${t}`) } };
  show(loaded);
  hide(loaded);
  assert.deepEqual(seen, ["show 12", "hide 13"]);
});

test("hide reports the emptied page only after it painted, with the hide's token", async () => {
  const { calls, popup, paint } = await setupHidden(LISTING, { manualPaint: true });
  const showing = popup.show(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await paint();
  await showing;
  const hiding = popup.hide(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.some((c) => c.command === "clip_hidden"), false, "no ack before the paint");
  await paint();
  await hiding;
  const ack = calls.find((c) => c.command === "clip_hidden");
  assert.deepEqual(ack.args, { token: 2 });
  assert.equal(ack.rows, 0, "the page was empty when it reported");
});

test("a hide overtaken by a show never reports", async () => {
  const { calls, popup, paint } = await setupHidden(LISTING, { manualPaint: true });
  const hiding = popup.hide(3);
  const showing = popup.show(4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await paint();
  await Promise.all([hiding, showing]);
  assert.equal(calls.some((c) => c.command === "clip_hidden"), false);
  assert.deepEqual(calls.find((c) => c.command === "clip_shown").args, { token: 4 });
});

test("show never signals readiness without a paint", async () => {
  const { calls, popup } = await setupHidden(LISTING, { manualPaint: true });
  popup.show(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.some((c) => c.command === "clip_shown"), false);
});

test("a delete that answers after hide does not refill the page", async () => {
  const { doc, calls, popup, key } = await setupHidden();
  await popup.show();
  const deleting = key("Backspace");
  popup.hide();
  await deleting;
  assert.ok(calls.some((c) => c.command === "clip_delete"));
  assert.equal(doc.querySelectorAll(".clip-row").length, 0);
  assert.deepEqual(popup.state().items, []);
});
