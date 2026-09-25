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
  let closed = 0;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "clip_list") return structuredClone(listing);
    if (command === "clip_reveal") return "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    return true;
  };
  const popup = createPopup({ document: dom.window.document, invoke, close: () => { closed += 1; } });
  await popup.refresh();
  const key = (k) => popup.onKey(new dom.window.KeyboardEvent("keydown", { key: k }));
  return { dom, doc: dom.window.document, calls, popup, key, closed: () => closed };
}

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

test("Escape closes", async () => {
  const { key, closed } = await setup();
  await key("Escape");
  assert.equal(closed(), 1);
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
