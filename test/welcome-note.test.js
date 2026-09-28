// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootApp } from "./helpers/app-harness.js";
import { WELCOME_NOTE_CONTENT, WELCOME_NOTE_TITLE } from "../src/welcome-note.js";

test("a fresh install creates the current welcome guide", async () => {
  const app = await bootApp({ handlers: { load_workspace_preference: () => null } });
  const notes = app.read("sodilaud_notes");

  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, WELCOME_NOTE_TITLE);
  assert.equal(notes[0].content, WELCOME_NOTE_CONTENT);
  assert.match(notes[0].content, /^# Welcome to Quick Notes\n/);
  assert.match(notes[0].content, /Cmd\/Ctrl\+Shift\+N/);
  assert.match(notes[0].content, /Cmd\/Ctrl\+W/);
  assert.match(notes[0].content, /Clicking another app leaves it open/);
  assert.match(notes[0].content, /kept apart from the files/);
  assert.match(notes[0].content, /Sodilaud menu → Quick Notes/);
  assert.match(notes[0].content, /Markdown that helps as you type/);
  assert.match(notes[0].content, /choose \*\*Compare\*\*/);
  assert.match(notes[0].content, /removed text on the left and added text on the right/);
  assert.match(notes[0].content, /Right-click in the editor/);
  assert.match(notes[0].content, /Paste a URL over selected text/);
  assert.match(notes[0].content, /folder button/);
  assert.match(notes[0].content, /very top/);
  assert.match(notes[0].content, /Unpinning returns a scratchpad to its folder/);
  assert.match(notes[0].content, /syntax highlighting, and line numbers/);
  assert.match(notes[0].content, /\*\*Agent access\*\*/);
  assert.doesNotMatch(notes[0].content, /—/, "no em dashes");
});
