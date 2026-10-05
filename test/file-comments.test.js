// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

const handlers = (open) => ({
  qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
  file_lists: () => ({ open, recent: [] }),
  file_set_open: () => null,
  file_take_pending: () => []
});

const PATH = "/docs/spec.md";
const TEXT = "# Spec\n\nThe intro is vague.\n\nNone yet.\n";

function helpers(app) {
  const doc = app.dom.window.document;
  const view = () => app.editor();
  return {
    doc,
    $: id => doc.getElementById(id),
    select: (needle) => {
      const from = view().state.doc.toString().indexOf(needle);
      view().dispatch({ selection: { anchor: from, head: from + needle.length } });
    },
    key: (target, init) => target.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })),
    composer: () => doc.querySelector(".cm-comment-composer textarea"),
    items: () => [...doc.querySelectorAll(".comment-item")],
    marks: () => [...doc.querySelectorAll(".cm-comment")].map(mark => mark.textContent)
  };
}

test("a comment on a file: composer, panel, review mode, replies and agent edits", async () => {
  const app = await bootMainWindow({ platform: "MacIntel", disk: { [PATH]: TEXT }, handlers: handlers([PATH]) });
  const { $, select, key, composer, items, marks } = helpers(app);
  await app.settle();
  assert.equal($("comments-count-btn").hidden, false);
  assert.equal($("comments-count-btn").textContent, "No comments");

  // ⌘⌥M opens the composer under the selection; typing elsewhere goes on.
  select("vague");
  key(app.editor().contentDOM, { key: "m", metaKey: true, altKey: true });
  await app.settle();
  assert.ok(composer(), "the composer opened");
  app.editor().dispatch({ changes: { from: 0, insert: "Draft: " }, userEvent: "input.type" });
  composer().value = "Name the failure modes";
  key(composer(), { key: "Enter", metaKey: true });
  await app.settle(300);
  assert.equal(composer(), null, "the composer closed");
  const [first] = app.fileDocs.comments(PATH);
  assert.equal(first.anchoredText, "vague", "the range was carried past the typing");
  assert.equal(first.state, "queued");
  assert.deepEqual(marks(), ["vague"]);
  assert.equal($("comments-panel").hidden, false, "the panel opens on the first comment");
  assert.equal($("comments-count-btn").textContent, "1 comment");

  // Hold for review keeps the next one back until Send review.
  [...$("comments-panel").querySelectorAll(".comments-mode-option")].find(b => b.textContent === "Hold for review").click();
  await app.settle();
  select("None yet.");
  $("comment-btn").click();
  await app.settle();
  composer().value = "List real risks";
  $("comments-panel").ownerDocument.querySelector(".cm-comment-add").click();
  await app.settle(300);
  assert.equal(app.fileDocs.comments(PATH)[1].state, "held");
  const send = $("comments-panel").querySelector(".comments-send-review");
  assert.equal(send.textContent, "Send review (1)");
  send.click();
  await app.settle();
  assert.equal(app.fileDocs.comments(PATH)[1].state, "queued");

  // An agent takes them; a sent comment can be sent again.
  app.fileDocs.take(PATH);
  await app.settle();
  assert.ok(items().every(item => item.querySelector(".comment-resend")));

  // The agent asks a question; the owner answers in place.
  app.fileDocs.agentComment(PATH, "# Spec", "Which audience?");
  await app.settle();
  const question = items().find(item => item.classList.contains("comment-agent"));
  question.querySelector(".comment-reply").click();
  await app.settle();
  const answer = question.parentElement.querySelector(".comment-inline-editor textarea") ?? $("comments-panel").querySelector(".comment-inline-editor textarea");
  answer.value = "Developers";
  $("comments-panel").querySelector(".comment-save").click();
  await app.settle(200);
  const reply = app.fileDocs.comments(PATH).at(-1);
  assert.equal(reply.body, "Developers");
  assert.equal(reply.replyTo, app.fileDocs.comments(PATH).find(c => c.author === "agent").id);

  // An agent's edit is highlighted for a moment; the owner's are not.
  app.fileDocs.agentEdit(PATH, [7, [0, "Agent line."], app.fileDocs.text(PATH).length - 7]);
  await app.settle();
  assert.equal([...app.dom.window.document.querySelectorAll(".cm-agent-edit")].map(m => m.textContent).join(""), "Agent line.");
  await app.settle(2100);
  assert.equal(app.dom.window.document.querySelectorAll(".cm-agent-edit").length, 0);

  // Resolving with a note shows the note; Clear resolved removes it.
  app.fileDocs.resolveAsAgent(PATH, first.id, "Listed three failure modes");
  await app.settle();
  assert.match($("comments-panel").textContent, /Listed three failure modes/);
  $("comments-panel").querySelector(".comments-clear-resolved").click();
  await app.settle();
  assert.ok(!app.fileDocs.comments(PATH).some(c => c.id === first.id));
});
