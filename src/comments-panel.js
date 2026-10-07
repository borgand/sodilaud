// SPDX-License-Identifier: GPL-3.0-or-later

import { getSyncedVersion } from "./vendor/codemirror.js";
import { isMacLikePlatform } from "./platform-labels.js";
import { flashChanges, fromConfirmed, setActiveComment, setComments, shownComments, startComment, toConfirmed } from "./editor-comments.js";

// The comments of the document an editor shows: the status-bar count, the
// drawer listing them, and keeping each editor's ranges in step with Rust.
// Rust sends a document's comments at a version; an editor that is at that
// version (plus its own unsent typing) shows them, one that is behind waits
// for the updates, and one that is ahead asks again.

export const AGENT_CLIENT = "agent";
const SNIPPET_CHARS = 140;

export const docKey = doc => doc?.noteId ? `note:${doc.collectionId}:${doc.noteId}` : doc?.path ? `file:${doc.path}:${doc.docId}` : null;

export function eventDoc(event) {
  if (event?.noteId) return { collectionId: event.collectionId, noteId: event.noteId };
  if (event?.path) return { path: event.path, docId: event.docId };
  return null;
}

const SHOWN_STATE = { held: "Held for review", queued: "Waiting for an agent", sent: "Sent to an agent", open: "Open", resolved: "Resolved", orphaned: "Text gone" };

export function shownState(comment) {
  if (comment.state === "resolved") return "resolved";
  return comment.orphaned ? "orphaned" : comment.state;
}

/** Each thread's root with its replies, oldest first. A reply whose root is gone stands alone. */
export function threads(all) {
  const ids = new Set(all.map(comment => comment.id));
  const rootId = comment => comment.replyTo && ids.has(comment.replyTo) ? comment.replyTo : comment.id;
  const found = new Map();
  for (const comment of all) {
    if (rootId(comment) === comment.id) found.set(comment.id, { root: comment, replies: [] });
  }
  for (const comment of all) {
    const thread = found.get(rootId(comment));
    if (thread.root !== comment) thread.replies.push(comment);
  }
  for (const thread of found.values()) thread.replies.sort((a, b) => a.createdAt - b.createdAt);
  return [...found.values()];
}

export function countLabel(all) {
  const open = threads(all).filter(thread => thread.root.state !== "resolved");
  const fresh = open.filter(thread => [thread.root, ...thread.replies].some(comment => comment.unread)).length;
  const count = open.length === 1 ? "1 comment" : open.length ? `${open.length} comments` : "No comments";
  return fresh ? `${count}, ${fresh} new` : count;
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(command: string, args?: object) => Promise<any>} options.invoke
 * @param {HTMLElement} options.root the drawer
 * @param {HTMLButtonElement} options.countButton the status-bar count that toggles the drawer
 * @param {() => {view: object, doc: object}[]} options.editors every editor and the document it shows
 * @param {() => {view: object, doc: object} | null} options.active the editor the drawer follows
 * @param {() => Promise<unknown>} options.flush sends unsent typing
 * @param {(message: string) => void} [options.notify]
 */
export function createComments({ document, invoke, root, countButton, editors, active, flush, notify = () => {} }) {
  const latest = new Map();
  const asking = new Set();
  let coedit = { holdForReview: false, listening: false };
  let open = false;
  let editing = null;

  const error = failure => notify(failure?.message ?? String(failure));

  function place(view, event) {
    let synced;
    try {
      synced = getSyncedVersion(view.state);
    } catch {
      return;
    }
    if (synced === event.version) {
      const comments = fromConfirmed(view.state, threads(event.comments).map(({ root: c }) => ({
        id: c.id, from: c.from, to: c.to, author: c.author, state: c.state, orphaned: Boolean(c.orphaned)
      })));
      view.dispatch({ effects: setComments.of(comments) });
    } else if (synced > event.version) {
      refresh(eventDoc(event));
    }
  }

  function placeAll() {
    for (const { view, doc } of editors()) {
      const event = latest.get(docKey(doc));
      if (event) place(view, event);
      else if (doc) refresh(doc);
    }
  }

  function receive(event) {
    const key = docKey(eventDoc(event));
    if (!key || !Array.isArray(event?.comments)) return;
    const known = latest.get(key);
    if (known && known.version > event.version) return;
    latest.set(key, event);
    for (const { view, doc } of editors()) {
      if (docKey(doc) === key) place(view, event);
    }
    if (docKey(active()?.doc) === key) render();
  }

  async function refresh(doc) {
    const key = docKey(doc);
    if (!key || asking.has(key)) return;
    asking.add(key);
    try {
      receive(await invoke("comments_get", { doc }));
    } catch (failure) {
      // A note the page just created reaches Rust a moment later; the next
      // update asks again.
      if (!/No note exists|not open|Collection changed/.test(String(failure?.message ?? failure))) {
        console.error("Could not load comments", failure);
      }
    } finally {
      asking.delete(key);
    }
  }

  // An editor showed another document, or an editor state was put back.
  function shown() {
    placeAll();
    render();
  }

  // Remote updates reached an editor: an agent's are highlighted, and
  // comments that waited for these updates can be placed.
  function remote({ view, transaction, clientID }) {
    if (clientID === AGENT_CLIENT) flashChanges(view, transaction);
    queueMicrotask(placeAll);
  }

  async function act(command, args) {
    const doc = active()?.doc;
    if (!doc) return null;
    try {
      const result = await invoke(command, { doc, ...args });
      await refresh(doc);
      return result;
    } catch (failure) {
      error(failure);
      return null;
    }
  }

  async function submit(view, { from, to, body }) {
    const target = editors().find(editor => editor.view === view)?.doc;
    if (!target) throw new Error("This document cannot take comments");
    await flush();
    const range = toConfirmed(view.state, from, to);
    if (range.to <= range.from) throw new Error("The selected text changed; select it again");
    await invoke("comment_add", { doc: target, comment: { version: range.version, from: range.from, to: range.to, body } });
    await refresh(target);
    if (!open) toggle(true);
  }

  function select(id) {
    const editor = active();
    if (!editor) return;
    const all = latest.get(docKey(editor.doc))?.comments ?? [];
    const thread = threads(all).find(({ root, replies }) => root.id === id || replies.some(reply => reply.id === id));
    if (thread) id = thread.root.id;
    if (thread && [thread.root, ...thread.replies].some(comment => comment.unread)) act("comment_mark_read", { id });
    const comment = shownComments(editor.view.state).find(c => c.id === id);
    editor.view.dispatch({
      effects: setActiveComment.of(id),
      ...(comment && comment.to > comment.from
        ? { selection: { anchor: comment.from, head: comment.to }, scrollIntoView: true }
        : {})
    });
    if (!open) toggle(true);
    else render();
    [...root.querySelectorAll("[data-comment-id]")].find(element => element.dataset.commentId === id)?.scrollIntoView?.({ block: "nearest" });
  }

  function toggle(force = !open) {
    open = Boolean(force);
    render();
  }

  function setState(state) {
    if (!state) return;
    coedit = { holdForReview: Boolean(state.holdForReview), listening: Boolean(state.listening) };
    render();
  }

  async function setHold(hold) {
    try {
      setState(await invoke("coedit_set_hold", { hold }));
    } catch (failure) {
      error(failure);
    }
  }

  function button(label, className, onClick) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.addEventListener("click", event => {
      event.stopPropagation();
      onClick();
    });
    return element;
  }

  function inlineEditor(initial, label, onSave) {
    const box = document.createElement("div");
    box.className = "comment-inline-editor";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.value = initial;
    input.setAttribute("aria-label", label);
    const save = () => {
      const body = input.value.trim();
      if (body) onSave(body);
    };
    const cancel = () => {
      editing = null;
      render();
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener("click", event => event.stopPropagation());
    box.append(input, button("Save", "comment-action comment-save", save), button("Cancel", "comment-action", cancel));
    setTimeout(() => input.focus(), 0);
    return box;
  }

  // One comment of a thread: who wrote it, its state, its text and what the
  // owner can still do with it alone.
  function entry(comment, element) {
    const state = shownState(comment);
    element.classList.add("comment-item", `comment-${comment.author}`, `comment-${state}`);
    element.classList.toggle("comment-unread", Boolean(comment.unread));
    element.dataset.commentId = comment.id;
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    const author = document.createElement("span");
    author.className = "comment-author";
    author.textContent = comment.author === "agent" ? "Agent" : "You";
    if (comment.unread) {
      const fresh = document.createElement("span");
      fresh.className = "comment-new";
      fresh.textContent = "New";
      author.append(" ", fresh);
    }
    const badge = document.createElement("span");
    badge.className = "comment-state";
    badge.textContent = SHOWN_STATE[state] ?? state;
    meta.append(author, badge);
    element.append(meta);
    if (!comment.replyTo) {
      const snippet = document.createElement("blockquote");
      snippet.className = "comment-snippet";
      snippet.textContent = comment.anchoredText.length > SNIPPET_CHARS ? `${comment.anchoredText.slice(0, SNIPPET_CHARS)}…` : comment.anchoredText;
      element.append(snippet);
    }
    const body = document.createElement("p");
    body.className = "comment-body";
    body.textContent = comment.body;
    element.append(body);
    if (comment.note) {
      const note = document.createElement("p");
      note.className = "comment-note";
      note.textContent = comment.note;
      element.append(note);
    }
    const id = comment.id;
    if (editing?.id === id && editing.kind === "edit") {
      element.append(inlineEditor(comment.body, "Edit comment", text => {
        editing = null;
        act("comment_edit", { id, body: text });
      }));
    }
    const actions = document.createElement("div");
    actions.className = "comment-actions";
    if (comment.author === "owner" && (state === "held" || state === "queued")) {
      actions.append(button("Edit", "comment-action comment-edit", () => { editing = { id, kind: "edit" }; render(); }));
      actions.append(button("Delete", "comment-action comment-delete", () => act("comment_delete", { id })));
    } else if (comment.author === "owner" && state === "sent") {
      actions.append(button("Resend", "comment-action comment-resend", () => act("comment_resend", { id })));
    } else if (state === "orphaned" && !comment.replyTo) {
      actions.append(button("Delete", "comment-action comment-delete", () => act("comment_delete", { id })));
    }
    return actions;
  }

  // A thread: its root, the replies indented under it, then a reply box and
  // Resolve while it is unresolved.
  function threadItem({ root, replies }) {
    const element = document.createElement("li");
    const actions = entry(root, element);
    element.classList.toggle("comment-thread-unread", [root, ...replies].some(comment => comment.unread));
    if (replies.length) {
      const list = document.createElement("ol");
      list.className = "comment-replies";
      for (const reply of replies) {
        const item = document.createElement("li");
        const own = entry(reply, item);
        if (own.childElementCount) item.append(own);
        item.addEventListener("click", event => {
          event.stopPropagation();
          select(reply.id);
        });
        list.append(item);
      }
      element.append(list);
    }
    const id = root.id;
    const pending = root.author === "owner" && (root.state === "held" || root.state === "queued") && replies.length === 0;
    if (root.state !== "resolved" && !pending) {
      if (editing?.id === id && editing.kind === "reply") {
        element.append(inlineEditor("", "Reply", text => {
          editing = null;
          act("comment_add", { comment: { body: text, replyTo: id } });
        }));
      } else {
        actions.append(button("Reply", "comment-action comment-reply", () => { editing = { id, kind: "reply" }; select(id); }));
      }
      actions.append(button("Resolve", "comment-action comment-resolve", () => act("comment_resolve", { id })));
    }
    if (actions.childElementCount) element.append(actions);
    element.addEventListener("click", () => select(id));
    return element;
  }

  function render() {
    const editor = active();
    const event = editor ? latest.get(docKey(editor.doc)) : null;
    const all = event?.comments ?? [];
    countButton.hidden = !editor;
    countButton.textContent = countLabel(all);
    countButton.classList.toggle("listening", coedit.listening);
    countButton.title = coedit.listening ? "Comments. An agent is listening for them." : "Comments";
    countButton.setAttribute("aria-expanded", String(open && Boolean(editor)));
    root.hidden = !open || !editor;
    if (root.hidden) return;

    const header = document.createElement("div");
    header.className = "comments-header";
    const title = document.createElement("h2");
    title.textContent = "Comments";
    const listening = document.createElement("span");
    listening.className = "comments-listening";
    listening.hidden = !coedit.listening;
    listening.title = "An agent is listening for comments";
    listening.textContent = "Agent listening";
    header.append(title, listening, button("×", "comments-close", () => toggle(false)));
    header.lastChild.setAttribute("aria-label", "Close comments");

    const mode = document.createElement("div");
    mode.className = "comments-mode";
    mode.setAttribute("role", "group");
    mode.setAttribute("aria-label", "When comments go to agents");
    for (const [label, hold] of [["Send as I go", false], ["Hold for review", true]]) {
      const choice = button(label, "comments-mode-option", () => setHold(hold));
      choice.setAttribute("aria-pressed", String(coedit.holdForReview === hold));
      mode.append(choice);
    }

    const tools = document.createElement("div");
    tools.className = "comments-tools";
    const held = all.filter(comment => comment.state === "held").length;
    if (held) tools.append(button(`Send review (${held})`, "comments-send-review", () => act("comments_send_review")));
    if (all.some(comment => comment.state === "resolved")) tools.append(button("Clear resolved", "comments-clear-resolved", () => act("comments_clear_resolved")));

    const list = document.createElement("ol");
    list.className = "comments-list";
    const order = threads(all).sort(({ root: a }, { root: b }) => (shownState(a) === "resolved") - (shownState(b) === "resolved") || Boolean(a.orphaned) - Boolean(b.orphaned) || a.from - b.from);
    list.append(...order.map(threadItem));
    if (all.length === 0) {
      const empty = document.createElement("p");
      empty.className = "comments-empty";
      empty.textContent = `Select text and press ${isMacLikePlatform() ? "⌘⌥M" : "Ctrl+Alt+M"} to comment.`;
      list.append(empty);
    }
    root.replaceChildren(header, mode, tools, list);
  }

  return {
    receive,
    refresh,
    shown,
    remote,
    submit,
    select,
    toggle,
    setState,
    render,
    start: () => {
      const editor = active();
      if (!editor || !startComment(editor.view)) {
        notify("Select the text to comment on first");
        return false;
      }
      return true;
    },
    isOpen: () => open
  };
}
