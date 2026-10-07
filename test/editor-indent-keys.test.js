// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { installEditorDom } from "./helpers/cm-dom.js";

// CodeMirror reads the platform once, when its module first loads, so this
// file runs as macOS (Mod = Cmd).
async function setup() {
  const env = installEditorDom();
  Object.defineProperty(env.window.navigator, "platform", { value: "MacIntel", configurable: true });
  const { createMarkdownEditor } = await import("../src/editor-view.js");
  const editor = createMarkdownEditor({ parent: env.document.getElementById("host"), ariaLabel: "t" });
  editor.setText("line");
  return { env, editor, done() { editor.destroy(); env.cleanup(); } };
}

function press(t, init) {
  const event = new t.env.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "keyCode", { value: init.keyCode });
  let seenByDocument = false;
  const onDocumentKeydown = () => { seenByDocument = true; };
  t.env.document.addEventListener("keydown", onDocumentKeydown);
  try {
    t.editor.view.contentDOM.dispatchEvent(event);
  } finally {
    t.env.document.removeEventListener("keydown", onDocumentKeydown);
  }
  return { prevented: event.defaultPrevented, seenByDocument };
}

// Option+] and Option+[ type quotes on a US layout; CodeMirror falls back to the key code.
test("Cmd+Alt+] and Cmd+Alt+[ indent and outdent the line", async () => {
  const t = await setup();
  try {
    assert.equal(press(t, { key: "‘", keyCode: 221, metaKey: true, altKey: true }).prevented, true);
    assert.match(t.editor.getText(), /^\s+line$/);
    press(t, { key: "“", keyCode: 219, metaKey: true, altKey: true });
    assert.equal(t.editor.getText(), "line");
  } finally {
    t.done();
  }
});

test("Cmd+[ and Cmd+] leave the text alone and reach the app as Back and Forward", async () => {
  const t = await setup();
  try {
    for (const init of [{ key: "]", keyCode: 221, metaKey: true }, { key: "[", keyCode: 219, metaKey: true }]) {
      const { prevented, seenByDocument } = press(t, init);
      assert.equal(prevented, false);
      assert.equal(seenByDocument, true);
      assert.equal(t.editor.getText(), "line");
    }
  } finally {
    t.done();
  }
});
