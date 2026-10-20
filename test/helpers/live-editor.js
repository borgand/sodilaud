// SPDX-License-Identifier: GPL-3.0-or-later

// Shared boot for Live-mode editor tests. Exports: setupLive(text, options) returns a
// harness `t` (view, editor, opened, caret(pos), mousedown/mouseup/mousemove(target, init),
// done()); settle() waits one macrotask.
import { marked } from "marked";
import { installEditorDom } from "./cm-dom.js";

export const settle = () => new Promise(resolve => setTimeout(resolve, 0));

export async function setupLive(text, { focused = true, mermaid, hljs, comments = false } = {}) {
  const env = installEditorDom();
  env.window.marked = marked;
  if (hljs) env.window.hljs = hljs;
  const { createMarkdownEditor } = await import("../../src/editor-view.js");
  const live = await import("../../src/editor-live-preview.js");
  const commentsApi = await import("../../src/editor-comments.js");
  const opened = [];
  const changes = [];
  const selected = [];
  const extensions = [live.livePreview({ onOpenLink: href => opened.push(href), mermaid: mermaid?.(env.document) })];
  if (comments) extensions.push(commentsApi.commentsExtension({ onSubmit: async () => {}, onSelect: id => selected.push(id) }));
  const editor = createMarkdownEditor({
    parent: env.document.getElementById("host"),
    ariaLabel: "t",
    onChange: value => changes.push(value),
    extensions
  });
  let hasFocus = focused;
  Object.defineProperty(editor.view, "hasFocus", { get: () => hasFocus, configurable: true });
  editor.loadText(text);
  const fire = (target, type, init) => {
    const event = new env.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const t = {
    env, editor, opened, changes, live, commentsApi, selected,
    view: editor.view,
    lines: () => [...editor.view.contentDOM.querySelectorAll(".cm-line")],
    lineTexts: () => t.lines().map(line => line.textContent),
    setFocus(value) { hasFocus = value; },
    async caret(pos) {
      editor.setSelection(pos, pos);
      await settle();
    },
    mousedown(target, init = {}) {
      return fire(target, "mousedown", init);
    },
    mouseup(target, init = {}) {
      return fire(target, "mouseup", init);
    },
    mousemove(target, init = {}) {
      return fire(target, "mousemove", init);
    },
    done() { editor.destroy(); env.cleanup(); }
  };
  return t;
  return t;
}
