// SPDX-License-Identifier: GPL-3.0-or-later

// The right pane of the file editor: a second editor showing any saved file
// open in this window, the one on the left included. It is another collab
// client of the file's registry document, so one file in both panes stays one
// document. Untitled files have no document yet and are not offered.

export function createFileSplit({ document, createEditor, sync, model, onFocusPane = () => {}, onChange = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const section = $("file-editor");
  const wrapper = $("secondary-editor-wrapper");
  const primaryWrapper = $("editor-wrapper");
  const select = $("secondary-file-select");
  const button = $("split-file-btn");

  // Each file keeps its editor state here while another one is on the right,
  // so its undo history and unsent changes come back with it.
  const states = new Map();
  let open = false;
  let shown = null;
  let active = "primary";

  const editor = createEditor($("secondary-editor-host"), { onChange: () => onChange("text") });

  const saved = () => model.list().filter((buffer) => buffer.path !== null);

  // Another file than the left one if there is one, else the left one.
  function pick() {
    const choices = saved();
    const left = model.active()?.id;
    return choices.find((buffer) => buffer.id !== left) ?? choices[0] ?? null;
  }

  function setActive(pane) {
    const next = open ? pane : "primary";
    primaryWrapper.classList.toggle("active-pane", open && next === "primary");
    wrapper.classList.toggle("active-pane", open && next === "secondary");
    if (next === active) return;
    active = next;
    onFocusPane(next);
  }

  function putAway() {
    if (shown !== null && model.get(shown)) states.set(shown, editor.getState());
  }

  function load(buffer) {
    const cached = states.get(buffer.id);
    states.delete(buffer.id);
    if (cached) {
      editor.restoreState(cached);
    } else {
      const { text, version } = buffer.confirmed;
      editor.loadText(text, { extensions: sync.extension({ path: buffer.path, docId: buffer.docId }, version) });
    }
    editor.setPlainText(buffer.kind === "plain");
  }

  function refreshChoices() {
    const current = model.get(shown)?.path ?? null;
    select.replaceChildren(...saved().map((buffer) => {
      const option = document.createElement("option");
      option.value = buffer.path;
      option.textContent = buffer.name;
      option.title = buffer.path;
      option.selected = buffer.path === current;
      return option;
    }));
  }

  function show(id) {
    const buffer = model.get(id);
    if (!open || !buffer?.path) return false;
    if (shown !== id) {
      putAway();
      shown = id;
      load(buffer);
    }
    refreshChoices();
    onChange("file");
    return true;
  }

  function setOpen(value) {
    open = value;
    wrapper.hidden = !value;
    section.classList.toggle("split-mode", value);
    button.setAttribute("aria-pressed", String(value));
  }

  function openSplit() {
    if (open) return true;
    const target = pick();
    if (!target) return false;
    setOpen(true);
    show(target.id);
    setActive(active);
    return true;
  }

  // The hidden editor lets go of the document instead of following it.
  function close() {
    if (!open) return;
    putAway();
    shown = null;
    editor.loadText("");
    setOpen(false);
    setActive("primary");
    onChange("file");
  }

  function bufferClosed(id) {
    states.delete(id);
    if (id !== shown) {
      if (open) refreshChoices();
      return;
    }
    shown = null;
    const next = pick();
    if (next) show(next.id);
    else close();
  }

  // The buffer's document was replaced (Save As, or the registry lost the
  // history this pane needed): start again from the registry's text.
  function reload(id) {
    states.delete(id);
    if (id !== shown) return;
    shown = null;
    show(id);
  }

  select.addEventListener("change", () => {
    const buffer = model.byPath(select.value);
    if (buffer) show(buffer.id);
  });
  $("close-secondary-btn").addEventListener("click", () => {
    close();
    primaryWrapper.querySelector(".cm-content")?.focus();
  });
  wrapper.addEventListener("focusin", () => setActive("secondary"));
  primaryWrapper.addEventListener("focusin", () => setActive("primary"));

  return {
    open: openSplit,
    close,
    toggle: () => (open ? close() : openSplit()),
    isOpen: () => open,
    show,
    shownId: () => (open ? shown : null),
    editor: () => editor,
    bufferClosed,
    reload,
    refreshChoices,
    activePane: () => (open ? active : "primary")
  };
}
