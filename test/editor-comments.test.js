// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

async function setup(extra = []) {
  const env = installEditorDom();
  const { Compartment, EditorState, EditorView } = await import("../src/vendor/codemirror.js");
  const comments = await import("../src/editor-comments.js");
  const compartment = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc: "line one\nline two\n",
      extensions: [comments.commentsExtension({ onSubmit: async () => {} }), compartment.of(extra(comments))]
    }),
    parent: env.document.getElementById("host")
  });
  return { env, view, comments, compartment, done() { view.destroy(); env.cleanup(); } };
}

test("a composerHost predicate that claims the composer keeps it from being drawn", async () => {
  const t = await setup(({ composerHost }) => composerHost.of(() => true));
  try {
    assert.equal(t.comments.startCommentAt(t.view, 0, 4), true);
    assert.equal(t.view.dom.querySelector(".cm-comment-composer"), null);
    assert.equal(t.comments.composerHosted(t.view.state), true);
  } finally {
    t.done();
  }
});

test("without a claiming predicate the composer is drawn", async () => {
  const t = await setup(() => []);
  try {
    t.comments.startCommentAt(t.view, 0, 4);
    assert.ok(t.view.dom.querySelector(".cm-comment-composer"));
    assert.equal(t.comments.composerHosted(t.view.state), false);
  } finally {
    t.done();
  }
});

test("composerHosted is false with no composer open", async () => {
  const t = await setup(({ composerHost }) => composerHost.of(() => true));
  try {
    assert.equal(t.comments.composerHosted(t.view.state), false);
  } finally {
    t.done();
  }
});

test("the predicate is evaluated again when the configuration changes", async () => {
  const t = await setup(({ composerHost }) => composerHost.of(() => true));
  try {
    t.comments.startCommentAt(t.view, 0, 4);
    assert.equal(t.view.dom.querySelector(".cm-comment-composer"), null);
    t.view.dispatch({ effects: t.compartment.reconfigure([]) });
    assert.ok(t.view.dom.querySelector(".cm-comment-composer"));
  } finally {
    t.done();
  }
});

test("refocus false closes the composer without moving focus to the editor", async () => {
  const t = await setup(() => []);
  try {
    t.comments.startCommentAt(t.view, 0, 4);
    const box = t.comments.createComposerElement(t.view, t.comments.commentComposer(t.view.state).key, { refocus: false });
    let focused = 0;
    t.view.focus = () => { focused += 1; };
    box.querySelector(".cm-comment-cancel").click();
    assert.equal(focused, 0);
    assert.equal(t.comments.commentComposer(t.view.state), null);
  } finally {
    t.done();
  }
});
