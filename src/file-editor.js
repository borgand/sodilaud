// SPDX-License-Identifier: GPL-3.0-or-later

// Editing Markdown and text files in the main window: one editor that shows the
// active file, the open files list, the start page's Recent list, and what to
// do when a file changes on disk. Rust owns the files: the editor is a collab
// client of each file's document, and Rust autosaves and merges outside edits.
// Every path here came from Rust.

import { createMarkdownEditor } from "./editor-view.js";
import { markdownEditingCommands, runFormatAction } from "./editor-commands.js";
import { livePreview } from "./editor-live-preview.js";
import { createFormatToolbar } from "./format-toolbar.js";
import { renderMarkdown, resolveLinkAction } from "./markdown.js";
import { highlightPreviewCode } from "./syntax-highlighting.js";
import { normalizeLayoutMode } from "./view-preferences.js";
import { createDocSync } from "./doc-sync.js";
import { createFilesModel, isDirty, needsPrompt } from "./files.js";

const LAYOUT_KEY = "sodilaud_layout_mode";

const editorModeFor = (mode) => (mode === "source" ? "source" : "live");

export function createFileEditor({
  document,
  invoke,
  storage,
  appearance,
  broadcast = () => {},
  notify = () => {},
  closeMenus = () => {},
  openExternal = () => {}
}) {
  const $ = (id) => document.getElementById(id);
  const startPage = $("start-page");
  const editorSection = $("file-editor");
  const toolbar = $("file-toolbar");
  const sidebar = $("files-sidebar");
  const sidebarToggle = $("toggle-files-sidebar");
  const openList = $("open-files-list");
  const title = $("main-title");
  const status = $("file-status");
  const preview = $("markdown-preview");
  const banner = $("file-banner");
  const bannerText = $("file-banner-text");
  const bannerPrimary = $("file-banner-primary-btn");
  const bannerSecondary = $("file-banner-secondary-btn");
  const layoutButtons = {
    live: $("mode-live"),
    source: $("mode-source"),
    reading: $("mode-reading")
  };

  const model = createFilesModel();
  let layoutMode = normalizeLayoutMode(storage.getItem(LAYOUT_KEY));
  let showingStartPage = true;
  let sidebarHidden = false;
  let shownId = null;
  let recent = [];

  const editor = createMarkdownEditor({
    parent: $("editor-host"),
    ariaLabel: "File content",
    placeholder: "Type something here... Supports Markdown formatting.",
    mode: editorModeFor(layoutMode),
    syntaxHighlighting: appearance.syntaxHighlighting,
    lineNumbers: appearance.lineNumbers,
    extensions: [markdownEditingCommands(), livePreview({ onOpenLink: openExternal })],
    onChange: handleEditorChange
  });

  const sync = createDocSync({
    push: ({ path, docId }, version, updates) => invoke("file_doc_push", { path, docId, version, updates }),
    pull: ({ path, docId }, since) => invoke("file_doc_pull", { path, docId, since }),
    same: (doc, event) => doc.path === event.path && doc.docId === event.docId,
    // The file was closed or reopened, or Save As replaced it: nothing is left to send to.
    isGone: (error) => error?.code === "NotOpen",
    onStatus: () => {
      renderTitle();
      renderSidebar();
    },
    onReload: ({ path, docId }, text, version) => {
      const buffer = model.byPath(path);
      if (!buffer || buffer.docId !== docId) return;
      model.reload(buffer.id, text, version);
      if (shownId === buffer.id) loadBuffer(buffer);
      render();
    },
    label: "main"
  });

  const unsent = (buffer) => buffer.path !== null && sync.pending((doc) => doc.docId === buffer.docId);
  const dirty = (buffer) => isDirty(buffer, unsent(buffer));
  const errorMessage = (error) => error?.message ?? String(error);

  function loadBuffer(buffer) {
    const extensions = buffer.path === null ? [] : sync.extension({ path: buffer.path, docId: buffer.docId }, buffer.version);
    editor.loadText(buffer.text, { extensions });
  }

  const formatToolbar = createFormatToolbar({
    document,
    applyFormat: (actionId) => {
      if (layoutMode === "reading" || !model.active()) return;
      runFormatAction(editor.view, actionId);
      editor.focus();
    },
    onMenuOpen: closeMenus,
    observe: [".main-topbar", ".layout-controls"]
  });

  // ----------------------------------------------------
  // Rendering
  // ----------------------------------------------------
  function statusText(buffer) {
    if (buffer.error) return "Not saved";
    if (buffer.path === null) return dirty(buffer) ? "Not saved yet" : "New file";
    if (!dirty(buffer)) return "Saved";
    return buffer.external === null ? "Saving…" : "Unsaved";
  }

  function renderTitle() {
    const buffer = showingStartPage ? null : model.active();
    title.textContent = buffer ? `${buffer.name}${dirty(buffer) ? " •" : ""}` : "Sodilaud";
    title.title = buffer?.path ?? "";
    document.title = buffer ? `${buffer.name} - Sodilaud` : "Sodilaud";
    status.textContent = buffer ? `${statusText(buffer)}${buffer.path ? ` · ${buffer.path}` : ""}` : "";
  }

  function renderSidebar() {
    const buffers = model.list();
    sidebar.hidden = buffers.length === 0 || sidebarHidden;
    sidebarToggle.hidden = buffers.length === 0;
    sidebarToggle.setAttribute("aria-expanded", String(!sidebar.hidden));
    const active = showingStartPage ? null : model.active();
    openList.replaceChildren(...buffers.map((buffer) => {
      const item = document.createElement("li");
      item.className = `open-file-item${buffer === active ? " active" : ""}`;
      item.dataset.fileId = buffer.id;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "open-file-name";
      open.textContent = `${buffer.name}${dirty(buffer) ? " •" : ""}`;
      open.title = buffer.path ?? "Not saved yet";
      open.setAttribute("aria-current", String(buffer === active));
      open.addEventListener("click", () => activate(buffer.id));
      const close = document.createElement("button");
      close.type = "button";
      close.className = "open-file-close";
      close.setAttribute("aria-label", `Close ${buffer.name}`);
      close.title = "Close";
      close.textContent = "×";
      close.addEventListener("click", () => closeFile(buffer.id));
      item.append(open, close);
      return item;
    }));
  }

  function renderRecent() {
    const list = $("recent-files-list");
    $("recent-files-empty").hidden = recent.length > 0;
    list.replaceChildren(...recent.map((file) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `start-link recent-file${file.exists ? "" : " missing"}`;
      button.textContent = file.name;
      button.title = file.exists ? file.path : `${file.path} (no longer on disk)`;
      button.addEventListener("click", () => openRecent(file));
      const where = document.createElement("span");
      where.className = "recent-file-path";
      where.textContent = file.path;
      item.append(button, where);
      return item;
    }));
  }

  function renderBanner() {
    const buffer = showingStartPage ? null : model.active();
    const error = buffer?.error;
    let content = null;
    if (buffer?.external === "conflict") {
      content = [`${buffer.name} changed on disk while you were editing it.`, "Reload", () => reloadFromDisk(buffer.id), "Keep mine", () => keepMine(buffer.id)];
    } else if (buffer?.external === "removed") {
      content = [`${buffer.name} is no longer on disk.`, "Save As…", () => saveAs(buffer.id), "Close", () => closeFile(buffer.id, { force: true })];
    } else if (error) {
      content = [`Could not save ${buffer.name}: ${error}`, "Try again", () => saveNow(buffer.id), "Save As…", () => saveAs(buffer.id)];
    }
    banner.hidden = content === null;
    if (!content) return;
    const [text, primary, onPrimary, secondary, onSecondary] = content;
    bannerText.textContent = text;
    bannerPrimary.textContent = primary;
    bannerPrimary.onclick = onPrimary;
    bannerSecondary.textContent = secondary;
    bannerSecondary.onclick = onSecondary;
  }

  function renderPreview() {
    if (layoutMode !== "reading" || !model.active()) return;
    try {
      preview.innerHTML = renderMarkdown(editor.getText(), "*Empty file*");
      highlightPreviewCode(preview, document.defaultView.hljs, appearance.syntaxHighlighting);
    } catch (error) {
      console.error("Could not render the file", error);
      preview.textContent = editor.getText();
    }
  }

  function renderMenu() {
    const buffer = showingStartPage ? null : model.active();
    $("menu-save-file-btn").disabled = !buffer;
    $("menu-save-as-btn").disabled = !buffer;
    $("menu-close-file-btn").disabled = !buffer;
    $("menu-start-page-btn").disabled = showingStartPage;
  }

  function render() {
    const buffer = model.active();
    const showEditor = Boolean(buffer) && !showingStartPage;
    startPage.hidden = showEditor;
    editorSection.hidden = !showEditor;
    toolbar.hidden = !showEditor;
    if (showEditor && shownId !== buffer.id) {
      const previous = model.get(shownId);
      if (previous) previous.editorState = editor.getState();
      if (buffer.editorState) editor.restoreState(buffer.editorState);
      else loadBuffer(buffer);
      shownId = buffer.id;
      renderPreview();
    }
    if (showEditor) formatToolbar.layout();
    renderTitle();
    renderSidebar();
    renderBanner();
    renderMenu();
  }

  // ----------------------------------------------------
  // Editing and saving
  // ----------------------------------------------------
  function handleEditorChange(text) {
    const buffer = model.get(shownId);
    if (!buffer) return;
    model.edit(buffer.id, text);
    renderTitle();
    renderSidebar();
  }

  // Sends everything typed, then has Rust write the file now. A file that
  // changed on disk or is gone waits for the owner's choice instead.
  async function saveNow(id) {
    const buffer = model.get(id);
    if (!buffer || buffer.path === null || buffer.external !== null) return true;
    const path = buffer.path;
    const sent = await sync.flush();
    let ok = sent;
    try {
      model.saved(await invoke("file_doc_save", { path }));
    } catch (error) {
      model.saved({ docId: buffer.docId, path, version: buffer.savedVersion, error: errorMessage(error) });
      ok = false;
    }
    render();
    return ok;
  }

  async function saveAs(id = model.active()?.id) {
    const buffer = model.get(id);
    if (!buffer) return false;
    // Rust drops the document if the new path is this file, so nothing may
    // still be on its way to it.
    if (buffer.path !== null) await sync.flush();
    const shown = buffer.id === shownId;
    const text = shown ? editor.getText() : buffer.editorState?.doc.toString() ?? buffer.text;
    let saved;
    try {
      saved = await invoke("file_save_as_dialog", {
        text,
        suggestedName: buffer.name,
        lineEnding: buffer.lineEnding,
        bom: buffer.bom
      });
    } catch (error) {
      buffer.error = errorMessage(error);
      render();
      return false;
    }
    if (!saved) return false;
    // Rust dropped any document open at the chosen path before writing it.
    const existing = model.byPath(saved.path);
    if (existing && existing.id !== id) model.close(existing.id, { force: true });
    const previousPath = buffer.path;
    if (previousPath !== null && previousPath !== saved.path) {
      await invoke("file_doc_close", { path: previousPath }).catch((error) => console.error("Could not close the old file", error));
    }
    let opened;
    try {
      opened = await invoke("file_doc_open", { path: saved.path });
    } catch (error) {
      buffer.error = errorMessage(error);
      render();
      return false;
    }
    model.adopt(id, opened);
    if (shown) {
      const selection = editor.getSelection();
      loadBuffer(buffer);
      editor.setSelection(selection.start, selection.end, { scroll: false });
    }
    await syncOpenList();
    await refreshRecent();
    render();
    return true;
  }

  // Cmd+S: a new file asks where to go; a saved one is written at once.
  function save(id = model.active()?.id) {
    const buffer = model.get(id);
    if (!buffer) return Promise.resolve(false);
    return buffer.path === null ? saveAs(id) : saveNow(id);
  }

  // ----------------------------------------------------
  // Opening and closing
  // ----------------------------------------------------
  function show(buffer) {
    showingStartPage = false;
    model.activate(buffer.id);
    render();
    editor.focus();
  }

  async function syncOpenList() {
    try {
      await invoke("file_set_open", { paths: model.paths() });
    } catch (error) {
      console.error("Could not update the open files", error);
    }
  }

  async function refreshRecent() {
    try {
      const lists = await invoke("file_lists");
      recent = Array.isArray(lists?.recent) ? lists.recent : [];
    } catch (error) {
      console.error("Could not read the recent files", error);
      recent = [];
    }
    renderRecent();
    return recent;
  }

  async function opened(file) {
    if (!file) return null;
    const buffer = model.openFile(file);
    show(buffer);
    await syncOpenList();
    await refreshRecent();
    return buffer;
  }

  async function openDialog() {
    try {
      const path = await invoke("file_open_dialog");
      return path ? await openPath(path) : null;
    } catch (error) {
      notify(error?.message ?? "Could not open the file");
      return null;
    }
  }

  async function openPath(path) {
    const existing = model.byPath(path);
    if (existing) {
      show(existing);
      return existing;
    }
    try {
      return await opened(await invoke("file_doc_open", { path }));
    } catch (error) {
      notify(error?.message ?? "Could not open the file");
      return null;
    }
  }

  async function openRecent(file) {
    if (!file.exists) {
      notify(`${file.name} is no longer on disk, so it was removed from Recent.`);
      await invoke("file_forget_recent", { path: file.path }).catch(() => {});
      await refreshRecent();
      return null;
    }
    return openPath(file.path);
  }

  function newFile() {
    const buffer = model.newUntitled();
    show(buffer);
    return buffer;
  }

  function activate(id) {
    const buffer = model.get(id);
    if (buffer) show(buffer);
  }

  // Asks about an untitled buffer with text. Returns whether to go on.
  async function resolveUnsavedNew(buffer) {
    if (!needsPrompt(buffer)) return true;
    let choice = "cancel";
    try {
      choice = await invoke("file_confirm_discard", { name: buffer.name });
    } catch (error) {
      console.error("Could not ask about the unsaved file", error);
    }
    if (choice === "save") return saveAs(buffer.id);
    return choice === "discard";
  }

  async function closeFile(id = model.active()?.id, { force = false } = {}) {
    const buffer = model.get(id);
    if (!buffer) return false;
    if (!force) {
      if (!(await resolveUnsavedNew(buffer))) return false;
      if (buffer.path !== null && !(await save(id))) return false;
    }
    if (buffer.path !== null) {
      try {
        await invoke("file_doc_close", { path: buffer.path });
      } catch (error) {
        if (!force) {
          buffer.error = errorMessage(error);
          render();
          return false;
        }
      }
    }
    model.close(id, { force: true });
    if (shownId === id) shownId = null;
    if (!model.active()) showingStartPage = true;
    await syncOpenList();
    await refreshRecent();
    render();
    return true;
  }

  function showStartPage() {
    showingStartPage = true;
    refreshRecent();
    render();
  }

  // ----------------------------------------------------
  // Changes on disk
  // ----------------------------------------------------
  // Reload sends what was typed first, so the file on disk replaces all of it.
  async function reloadFromDisk(id) {
    const buffer = model.get(id);
    if (!buffer?.path) return;
    await sync.flush();
    try {
      await invoke("file_doc_resolve", { path: buffer.path, keep: "disk" });
    } catch (error) {
      notify(error?.message ?? "Could not reload the file");
    }
    render();
  }

  async function keepMine(id) {
    const buffer = model.get(id);
    if (!buffer?.path) return;
    await sync.flush();
    try {
      await invoke("file_doc_resolve", { path: buffer.path, keep: "mine" });
    } catch (error) {
      buffer.error = errorMessage(error);
    }
    render();
  }

  // ----------------------------------------------------
  // Registry events
  // ----------------------------------------------------
  function receiveUpdates(event) {
    if (!event?.path) return;
    sync.receive(event);
    const buffer = model.docUpdated(event);
    if (buffer && buffer.id === shownId) renderPreview();
    renderTitle();
    renderSidebar();
  }

  function handleSaved(event) {
    if (!event?.path) return;
    model.saved(event);
    render();
  }

  function handleExternal(event) {
    if (!event?.path) return;
    model.external(event);
    render();
  }

  // ----------------------------------------------------
  // Mode, sidebar and settings
  // ----------------------------------------------------
  function setLayoutMode(value, { persist = true } = {}) {
    layoutMode = normalizeLayoutMode(value);
    editorSection.classList.remove("mode-live", "mode-source", "mode-reading");
    editorSection.classList.add(`mode-${layoutMode}`);
    for (const [mode, button] of Object.entries(layoutButtons)) {
      button.classList.toggle("active", mode === layoutMode);
      button.setAttribute("aria-pressed", String(mode === layoutMode));
    }
    editor.setMode(editorModeFor(layoutMode));
    formatToolbar.setEnabled(layoutMode !== "reading");
    renderPreview();
    if (persist) {
      storage.setItem(LAYOUT_KEY, layoutMode);
      broadcast(LAYOUT_KEY);
    }
  }

  function toggleSidebar() {
    if (model.list().length === 0) return;
    sidebarHidden = !sidebarHidden;
    renderSidebar();
  }

  // ----------------------------------------------------
  // Quit and start-up
  // ----------------------------------------------------
  // Saves everything before a quit. Returns false to cancel it.
  async function flushForQuit() {
    for (const buffer of model.list()) {
      if (!(await resolveUnsavedNew(buffer))) return false;
    }
    let ok = await sync.flush();
    for (const buffer of model.list()) {
      if (buffer.path !== null && buffer.external === null) ok = (await saveNow(buffer.id)) && ok;
    }
    if (!ok) {
      const failed = model.list().find((buffer) => buffer.error);
      if (failed) show(failed);
      notify("Could not save every file; quit cancelled");
    }
    return ok;
  }

  async function takePending() {
    let paths = [];
    try {
      paths = await invoke("file_take_pending");
    } catch (error) {
      console.error("Could not read files opened from outside", error);
    }
    let last = null;
    for (const path of Array.isArray(paths) ? paths : []) {
      last = (await openPath(path)) ?? last;
    }
    return last;
  }

  async function restore() {
    let lists = null;
    try {
      lists = await invoke("file_lists");
    } catch (error) {
      console.error("Could not read the file lists", error);
    }
    recent = Array.isArray(lists?.recent) ? lists.recent : [];
    renderRecent();
    for (const path of Array.isArray(lists?.open) ? lists.open : []) {
      try {
        model.openFile(await invoke("file_doc_open", { path }));
      } catch (error) {
        console.error(`Could not reopen ${path}`, error);
      }
    }
    await syncOpenList();
    // A file handed over at launch wins; otherwise the last file reopened shows.
    if (!(await takePending())) showingStartPage = model.list().length === 0;
    render();
  }

  function attach() {
    formatToolbar.attach();
    for (const [mode, button] of Object.entries(layoutButtons)) {
      button.addEventListener("click", () => setLayoutMode(mode));
    }
    sidebarToggle.addEventListener("click", toggleSidebar);
    preview.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      event.preventDefault();
      if (resolveLinkAction(link.getAttribute("href")).kind === "external") openExternal(link.getAttribute("href"));
    });
    $("start-new-file-btn").addEventListener("click", newFile);
    $("start-open-file-btn").addEventListener("click", openDialog);
    $("menu-new-file-btn").addEventListener("click", () => { closeMenus(); newFile(); });
    $("menu-open-file-btn").addEventListener("click", () => { closeMenus(); openDialog(); });
    $("menu-save-file-btn").addEventListener("click", () => { closeMenus(); save(); });
    $("menu-save-as-btn").addEventListener("click", () => { closeMenus(); saveAs(); });
    $("menu-close-file-btn").addEventListener("click", () => { closeMenus(); closeFile(); });
    $("menu-start-page-btn").addEventListener("click", () => { closeMenus(); showStartPage(); });
    $("start-actions").hidden = false;
    $("recent-files").hidden = false;
    setLayoutMode(layoutMode, { persist: false });
  }

  // File shortcuts. Returns whether the event was one.
  function handleShortcut(event) {
    const isMeta = event.metaKey || event.ctrlKey;
    if (!isMeta || event.altKey) return false;
    const key = event.key.toLowerCase();
    let action = null;
    if (key === "n" && !event.shiftKey) action = newFile;
    else if (key === "o" && !event.shiftKey) action = openDialog;
    else if (key === "s" && event.shiftKey && model.active()) action = () => saveAs();
    // Ctrl+Cmd+S toggles the sidebar on macOS.
    else if (key === "s" && !event.shiftKey && !(event.ctrlKey && event.metaKey) && model.active()) action = () => save();
    else if (key === "w" && !event.shiftKey && model.active() && !showingStartPage) action = () => closeFile();
    if (!action) return false;
    event.preventDefault();
    action();
    return true;
  }

  return {
    attach,
    restore,
    render,
    takePending,
    receiveUpdates,
    handleSaved,
    handleExternal,
    handleShortcut,
    toggleSidebar,
    setLayoutMode,
    flushForQuit,
    newFile,
    openDialog,
    openPath,
    save,
    saveAs,
    closeFile,
    showStartPage,
    closeFormatMenus: () => formatToolbar.closeMenus(),
    setLineNumbers: (enabled) => editor.setLineNumbers(enabled),
    setSyntaxHighlighting: (enabled) => {
      editor.setSyntaxHighlighting(enabled);
      renderPreview();
    },
    model,
    editor
  };
}
