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
import { HUNK_ID, findReadingAnchor, scrollToReadingAnchor } from "./anchors.js";
import { documentAnchors, scrollToAnchor } from "./editor-anchors.js";
import { highlightPreviewCode } from "./syntax-highlighting.js";
import { renderHunkWidgets } from "./diff-hunk.js";
import { createNavHistory } from "./nav-history.js";
import { reviewHunkFences, setHunkReviewed } from "./editor-hunks.js";
import { foldedSections, revealAnchor, sectionFolding, setFoldedSections, setSectionFolded } from "./editor-folds.js";
import {
  applyReadingFolds,
  isScrolledToEnd,
  markCurrentOutline,
  nextUnreviewed,
  outlineEntries,
  outlineIdAt,
  readingHeadingAt,
  readingFoldsHiding,
  renderOutlineList,
  reviewProgress,
  reviewProgressText
} from "./outline.js";
import { normalizeLayoutMode } from "./view-preferences.js";
import { applyUpdatesToText, createDocSync } from "./doc-sync.js";
import { createFilesModel, isDirty, needsPrompt } from "./files.js";
import { commentsExtension, startComment } from "./editor-comments.js";
import { createComments } from "./comments-panel.js";
import { createOpenFileMenu } from "./open-file-menu.js";
import { createFolderSidebar } from "./folder-sidebar.js";
import { createFindBar } from "./find-bar.js";
import { createFileSplit } from "./file-split.js";
import { createPaneCompare } from "./pane-compare.js";
import { isMacLikePlatform } from "./platform-labels.js";
import { createReadingComments, dropStrayComposer } from "./reading-comments.js";
import { EditorState, EditorView, Transaction } from "./vendor/codemirror.js";

const LAYOUT_KEY = "sodilaud_layout_mode";
// The outline reparses the whole file, so it waits for typing to pause.
const OUTLINE_DELAY_MS = 150;
const SAVED_FADE_MS = 2000;

const editorModeFor = (mode) => (mode === "source" ? "source" : "live");

export function createFileEditor({
  document,
  invoke,
  storage,
  appearance,
  broadcast = () => {},
  notify = () => {},
  closeMenus = () => {},
  openExternal = () => {},
  mermaid = null
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
  const statusPath = $("file-status-path");
  const preview = $("markdown-preview");
  const outlineSection = $("outline-section");
  const outlineToggle = $("outline-toggle-btn");
  const outlineList = $("outline-list");
  const reviewStatus = $("review-progress");
  const reviewNext = $("review-next-btn");
  const backButton = $("nav-back-btn");
  const forwardButton = $("nav-forward-btn");
  const banner = $("file-banner");
  const bannerText = $("file-banner-text");
  const bannerPrimary = $("file-banner-primary-btn");
  const bannerSecondary = $("file-banner-secondary-btn");
  const draftBar = $("draft-bar");
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
  // The buffer being handed to another window or to Quick Notes, or saved
  // under a new name: typing into it now would go to a document about to close.
  let lockedId = null;
  let recent = [];
  let drafts = [];
  let outlineTimer = null;
  let outlineShown = [];
  let currentOutlineId = null;
  let statusKey = null;
  let fadeTimer = null;
  const navHistory = createNavHistory();

  const reading = createReadingComments({
    preview,
    view: () => editor.view,
    enabled: () => layoutMode === "reading" && Boolean(model.active()) && model.active().kind !== "plain",
    onShortcut: () => comments.start()
  });
  // Both panes edit with the same extensions; `pane` names the one they serve.
  const editorOptions = (pane) => ({
    placeholder: "Type something here... Supports Markdown formatting.",
    mode: editorModeFor(layoutMode),
    syntaxHighlighting: appearance.syntaxHighlighting,
    lineNumbers: appearance.lineNumbers,
    extensions: [
      markdownEditingCommands(),
      pane === "primary"
        ? livePreview({ onOpenLink: followLink, onFollowAnchor: jumpTo, mermaid })
        : livePreview({ onOpenLink: (href) => followLink(href, "secondary"), onFollowAnchor: scrollRightPane, mermaid }),
      sectionFolding(),
      EditorState.changeFilter.of((tr) =>
        lockedId === null || lockedId !== paneBufferId(pane) || tr.annotation(Transaction.userEvent) === undefined),
      commentsExtension({
        onSubmit: (view, comment) => comments.submit(view, comment),
        onSelect: id => comments.select(id)
      }),
      reading.extension,
      // The preview's source offsets go stale with any edit, the owner's or a remote one.
      EditorView.updateListener.of(update => {
        if (update.docChanged) renderPreview();
      })
    ]
  });

  const editor = createMarkdownEditor({
    ...editorOptions("primary"),
    parent: $("editor-host"),
    ariaLabel: "File content",
    onChange: handleEditorChange
  });
  mermaid?.onChange(renderPreview);

  const findBar = createFindBar({
    document,
    editor: () => activeEditor(),
    preview: () => preview,
    isReading: () => layoutMode === "reading",
    notify
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
      split.reload(buffer.id);
      render();
    },
    onRemote: remote => comments.remote(remote),
    label: "main"
  });

  const split = createFileSplit({
    document,
    createEditor: (host, { onChange }) => createMarkdownEditor({
      ...editorOptions("secondary"),
      parent: host,
      ariaLabel: "File content in the right pane",
      onChange
    }),
    sync,
    model,
    onFocusPane: paneFocused,
    onChange: rightPaneChanged
  });

  const activeEditor = () => (split.activePane() === "secondary" ? split.editor() : editor);

  const compareButton = $("compare-files-btn");
  const compareCount = $("compare-files-count");
  const diffApi = () => document.defaultView?.Diff;
  const fileCompare = createPaneCompare({
    left: () => editor,
    right: () => split.editor(),
    diffApi,
    onResult: renderCompare
  });
  // The two files compare showed last, so a render that changes neither pane
  // does not redraw the marks.
  let comparedPanes = null;

  // Comments need a file Rust holds: an untitled buffer has none yet.
  const docOf = (buffer) => (buffer?.path ? { path: buffer.path, docId: buffer.docId } : null);
  const shownDoc = () => docOf(showingStartPage ? null : model.get(shownId));
  const paneBufferId = (pane) => (pane === "primary" ? (showingStartPage ? null : shownId) : split.shownId());
  const paneDoc = (pane) => docOf(model.get(paneBufferId(pane)));
  // The file the focused pane shows: Save, Save As and Close act on it.
  const focusedId = () => paneBufferId(split.activePane()) ?? model.active()?.id;
  const comments = createComments({
    document,
    invoke,
    root: $("comments-panel"),
    countButton: $("comments-count-btn"),
    editors: () => [
      { view: editor.view, doc: shownDoc() },
      { view: split.editor().view, doc: paneDoc("secondary") }
    ].filter(({ doc }) => doc),
    active: () => {
      const doc = paneDoc(split.activePane());
      return doc ? { view: activeEditor().view, doc } : null;
    },
    flush: () => sync.flush(),
    notify,
    startComment: view => layoutMode === "reading" ? reading.start() : startComment(view)
  });

  const fileMenu = createOpenFileMenu({
    document,
    root: $("open-file-menu"),
    invoke,
    onMove: (id, to) => keepFocus(id, () => moveFile(id, to)),
    onClose: (id) => keepFocus(id, () => closeFile(id))
  });

  const folders = createFolderSidebar({ document, invoke, openPath, notify, onChange: renderSidebar });

  // The file's button disappears with the file, which would drop keyboard
  // focus onto the page; it goes to the neighbouring file or the start page.
  async function keepFocus(id, action) {
    const ids = model.list().map((buffer) => buffer.id);
    const at = ids.indexOf(id);
    const neighbours = [id, ...ids.slice(at + 1), ...ids.slice(0, at).reverse()];
    await action();
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const names = neighbours.map((fileId) => openList.querySelector(`[data-file-id="${fileId}"] .open-file-name`));
    const target = names.find(Boolean);
    if (target) {
      target.focus({ preventScroll: true });
    } else {
      startPage.tabIndex = -1;
      startPage.focus({ preventScroll: true });
    }
  }

  const unsent = (buffer) => buffer.path !== null && sync.pending((doc) => doc.docId === buffer.docId);
  const dirty = (buffer) => isDirty(buffer, unsent(buffer));
  const errorMessage = (error) => error?.message ?? String(error);

  function loadBuffer(buffer) {
    const extensions = buffer.path === null ? [] : sync.extension({ path: buffer.path, docId: buffer.docId }, buffer.version);
    editor.loadText(buffer.text, { extensions });
    applyKind(buffer);
    refreshFind();
    fileCompare.refresh();
  }

  // ----------------------------------------------------
  // Compare
  // ----------------------------------------------------
  const canCompare = () => {
    const left = paneBufferId("primary");
    const right = split.shownId();
    const api = diffApi();
    return Boolean(left && right && left !== right &&
      typeof api?.diffLines === "function" && typeof api?.diffWordsWithSpace === "function");
  };

  function renderCompare({ changedLineCount, pending }) {
    const on = fileCompare.isEnabled();
    editorSection.classList.toggle("compare-mode", on);
    compareButton.classList.toggle("active", on);
    compareButton.setAttribute("aria-pressed", String(on));
    compareCount.hidden = !on;
    let summary = "";
    if (on && pending) summary = "Updating comparison…";
    else if (on) summary = changedLineCount === 0 ? "No differences" : `${changedLineCount} changed line${changedLineCount === 1 ? "" : "s"}`;
    compareCount.textContent = summary;
    compareButton.title = on ? `Stop comparing the files (${summary.toLowerCase()})` : "Compare the two files";
  }

  // Compare is offered for two different files side by side. Showing the same
  // file on both sides turns it off; another file on either side compares again.
  function syncCompare() {
    const available = canCompare();
    compareButton.hidden = !available;
    if (!available && fileCompare.isEnabled()) fileCompare.setEnabled(false);
    const panes = `${paneBufferId("primary")}|${split.shownId()}`;
    if (panes === comparedPanes) return;
    comparedPanes = panes;
    // A file's editor state comes back with the marks it had: redraw them.
    fileCompare.refresh();
  }

  function toggleCompare() {
    if (canCompare()) fileCompare.setEnabled(!fileCompare.isEnabled());
  }

  // An edit in either pane, or one from outside reaching a shown file.
  function compareEdited(id) {
    if (!fileCompare.isEnabled()) return;
    if (id !== undefined && id !== paneBufferId("primary") && id !== split.shownId()) return;
    // A pending run reads both panes when it fires; an echo leaves the texts as compared.
    if (id !== undefined && (fileCompare.isPending() || fileCompare.isCurrent())) return;
    fileCompare.schedule();
  }

  // The editor's matches belong to the text it showed before.
  function refreshFind() {
    if (findBar.isOpen()) findBar.run({ preserveActive: true, selectActive: false });
    else findBar.refreshHighlights();
  }

  // Find, formatting and comments follow the pane focused last.
  function paneFocused(pane) {
    (pane === "primary" ? split.editor() : editor).setFindMatches([], -1);
    if (findBar.isOpen()) findBar.run({ selectActive: false });
    else findBar.refreshHighlights();
    syncFormatting();
    comments.render();
  }

  function rightPaneChanged(what) {
    if (what === "file") {
      comparedPanes = null;
      syncCompare();
      comments.shown();
      if (split.activePane() === "secondary") {
        refreshFind();
        syncFormatting();
      }
    } else {
      compareEdited();
      if (findBar.isOpen() && split.activePane() === "secondary") findBar.run({ preserveActive: true, selectActive: false });
    }
  }

  // An anchor link in the right pane scrolls that pane.
  function scrollRightPane(fragment) {
    const { view } = split.editor();
    revealAnchor(view, fragment);
    scrollToAnchor(view, fragment);
  }

  function applyKind(buffer) {
    editor.setPlainText(buffer.kind === "plain");
    syncFormatting();
  }

  const syncFormatting = () => formatToolbar.setEnabled(layoutMode !== "reading" && !activeEditor().isPlainText());

  const formatToolbar = createFormatToolbar({
    document,
    applyFormat: (actionId) => {
      if (layoutMode === "reading" || !model.active()) return;
      const target = activeEditor();
      runFormatAction(target.view, actionId);
      target.focus();
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
    const text = buffer ? statusText(buffer) : "";
    status.textContent = text;
    status.title = buffer?.path ?? "";
    statusPath.textContent = buffer?.path ?? "";
    const key = buffer ? `${buffer.id}:${text}` : null;
    if (key !== statusKey) {
      statusKey = key;
      clearTimeout(fadeTimer);
      status.classList.remove("settled");
      if (text === "Saved") fadeTimer = setTimeout(() => status.classList.add("settled"), SAVED_FADE_MS);
    }
  }

  function renderSidebar() {
    const buffers = model.list();
    const hasRoots = folders.hasRoots();
    const content = buffers.length > 0 || hasRoots;
    sidebar.hidden = !content || sidebarHidden;
    sidebarToggle.hidden = !content;
    sidebarToggle.setAttribute("aria-expanded", String(!sidebar.hidden));
    $("files-sidebar-title").hidden = buffers.length === 0 && hasRoots;
    $("folders-section").hidden = !hasRoots;
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
      let keyOpenedAt = 0;
      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        // The ContextMenu key opens the menu on keydown and then fires this event too.
        if (Date.now() - keyOpenedAt < 500 && fileMenu.isOpen()) return;
        fileMenu.open(buffer, { x: event.clientX, y: event.clientY }, open);
      });
      open.addEventListener("keydown", (event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        keyOpenedAt = Date.now();
        const rect = open.getBoundingClientRect();
        fileMenu.open(buffer, { x: rect.left, y: rect.bottom }, open);
      });
      item.append(open);
      if (buffer.draft) {
        const tag = document.createElement("span");
        tag.className = "open-file-tag";
        tag.textContent = "Draft";
        item.append(tag);
      }
      item.append(close);
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

  function renderDrafts() {
    $("drafts-section").hidden = drafts.length === 0;
    $("drafts-list").replaceChildren(...drafts.map((draft) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "start-link";
      button.textContent = draft.name;
      button.title = draft.path;
      button.addEventListener("click", () => openPath(draft.path));
      item.append(button);
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
    draftBar.hidden = buffer?.draft !== true;
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
    if (model.active().kind === "plain") {
      const pre = document.createElement("pre");
      pre.className = "plain-text-preview";
      pre.textContent = editor.getText();
      preview.replaceChildren(pre);
      findBar.refreshPreview();
      return;
    }
    reading.renderWith(() => {
      try {
        preview.innerHTML = renderMarkdown(editor.getText(), "*Empty file*", undefined, { positions: true });
        const hljs = document.defaultView.hljs;
        renderHunkWidgets(preview, {
          hljs: appearance.syntaxHighlighting ? hljs : null,
          onToggleReviewed: (target, reviewed) => setHunkReviewed(editor.view, target, reviewed),
          ...reading.hunkOptions()
        });
        highlightPreviewCode(preview, hljs, appearance.syntaxHighlighting);
        mermaid?.renderBlocks(preview);
        renderReadingFolds();
      } catch (error) {
        console.error("Could not render the file", error);
        preview.textContent = editor.getText();
      }
    });
    findBar.refreshPreview();
  }

  // Reading mode shows the folds Live mode keeps in the editor state.
  function renderReadingFolds() {
    applyReadingFolds(preview, foldedSections(editor.view.state), (id, folded) => {
      setSectionFolded(editor.view, id, folded);
      renderReadingFolds();
    });
  }

  // A heading or hunk this close below the top of the view counts as the one
  // being read, so one a jump just scrolled to is not skipped for the next.
  const TOP_SLACK_PX = 8;

  function updateCurrentOutline() {
    if (outlineSection.hidden) return;
    let id;
    if (layoutMode === "reading") {
      const box = preview.getBoundingClientRect();
      id = readingHeadingAt(preview, isScrolledToEnd(preview) ? box.bottom : box.top + TOP_SLACK_PX);
    } else {
      const { view } = editor;
      const box = view.scrollDOM.getBoundingClientRect();
      const edge = isScrolledToEnd(view.scrollDOM) ? box.bottom : box.top + TOP_SLACK_PX;
      id = outlineIdAt(outlineShown, view.lineBlockAtHeight(edge - view.documentTop).from);
    }
    if (id === currentOutlineId) return;
    currentOutlineId = id;
    markCurrentOutline(outlineList, id)?.scrollIntoView?.({ block: "nearest" });
  }

  function renderOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = null;
    const buffer = showingStartPage ? null : model.active();
    const { state } = editor.view;
    const markdown = Boolean(buffer) && buffer.kind !== "plain";
    const hunks = markdown ? reviewHunkFences(state) : [];
    const entries = markdown ? outlineEntries(documentAnchors(state), hunks, state.doc.length) : [];
    outlineShown = entries;
    outlineSection.hidden = entries.length === 0;
    if (entries.length) {
      renderOutlineList(outlineList, entries, jumpTo);
      markCurrentOutline(outlineList, currentOutlineId);
      updateCurrentOutline();
    } else currentOutlineId = null;
    const progress = reviewProgress(hunks);
    reviewStatus.hidden = progress.total === 0;
    reviewStatus.textContent = reviewProgressText(progress);
    reviewStatus.classList.toggle("complete", progress.total > 0 && progress.reviewed === progress.total);
    reviewNext.hidden = progress.reviewed === progress.total;
  }

  function nextUnreviewedHunk() {
    if (layoutMode === "reading") {
      const widgets = [...preview.querySelectorAll(".diff-hunk[data-hunk]")];
      const top = preview.getBoundingClientRect().top + TOP_SLACK_PX;
      let current = -1;
      widgets.forEach((widget, index) => {
        const rect = widget.getBoundingClientRect();
        if (rect.height > 0 && rect.top <= top) current = index;
      });
      const hunks = widgets.map((widget, index) => ({
        id: widget.dataset.hunk,
        reviewed: widget.classList.contains("diff-hunk-is-reviewed"),
        at: index
      }));
      return nextUnreviewed(hunks, current);
    }
    const { view } = editor;
    const top = view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop + TOP_SLACK_PX).from;
    const hunks = reviewHunkFences(view.state)
      .filter(fence => HUNK_ID.test(fence.meta.hunk ?? ""))
      .map(fence => ({ id: fence.meta.hunk, reviewed: fence.meta.reviewed, at: fence.from }));
    return nextUnreviewed(hunks, top);
  }

  function goToNextUnreviewed() {
    const id = nextUnreviewedHunk();
    if (id) jumpTo(id);
  }

  function scheduleOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(renderOutline, OUTLINE_DELAY_MS);
  }

  function toggleOutline() {
    const expanded = outlineToggle.getAttribute("aria-expanded") !== "true";
    outlineToggle.setAttribute("aria-expanded", String(expanded));
    outlineList.hidden = !expanded;
  }

  function renderMenu() {
    const buffer = showingStartPage ? null : model.active();
    $("menu-save-file-btn").disabled = !buffer;
    $("menu-save-as-btn").disabled = !buffer;
    $("menu-close-file-btn").disabled = !buffer;
    $("menu-browse-folder-btn").disabled = !browsable(buffer);
    $("menu-start-page-btn").disabled = showingStartPage;
  }

  function render() {
    const buffer = model.active();
    const showEditor = Boolean(buffer) && !showingStartPage;
    startPage.hidden = showEditor;
    editorSection.hidden = !showEditor;
    toolbar.hidden = !showEditor;
    if (showEditor && shownId !== buffer.id) {
      // The editor and the preview are shared by every file, so each file
      // keeps its own scroll position; one shown for the first time starts
      // at the top instead of where the last file was.
      const previous = model.get(shownId);
      if (previous) {
        previous.editorState = editor.getState();
        previous.scroll = editor.scrollPlace();
        previous.previewTop = preview.scrollTop;
      }
      if (buffer.editorState) {
        editor.restoreState(buffer.editorState);
        applyKind(buffer);
        refreshFind();
        dropStrayComposer(editor.view, layoutMode === "reading" ? "reading" : "editor");
      } else loadBuffer(buffer);
      shownId = buffer.id;
      currentOutlineId = null;
      renderPreview();
      editor.restoreScroll(buffer.scroll);
      preview.scrollTop = buffer.previewTop ?? 0;
    }
    if (showEditor) formatToolbar.layout();
    if (split.isOpen()) split.refreshChoices();
    syncCompare();
    folders.setActivePath(showEditor ? buffer.path : null);
    comments.shown();
    renderTitle();
    renderSidebar();
    renderOutline();
    renderNav();
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
    compareEdited();
    // Replace reads the new matches straight after its edit.
    if (findBar.isOpen()) findBar.run({ preserveActive: true, selectActive: false });
    renderTitle();
    renderSidebar();
    scheduleOutline();
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

  // The document's text in the registry, which has every pane's changes
  // even before their update events reach the other pane.
  async function registryText(buffer) {
    const { text, version } = buffer.confirmed;
    const result = await invoke("file_doc_pull", { path: buffer.path, docId: buffer.docId, since: version });
    if (result?.reload) return result.reload.text;
    return applyUpdatesToText(text, Array.isArray(result?.updates) ? result.updates : []);
  }

  async function saveAs(id = focusedId()) {
    const buffer = model.get(id);
    if (!buffer || lockedId !== null) return false;
    lockedId = id;
    try {
      return await saveAsLocked(buffer);
    } finally {
      lockedId = null;
    }
  }

  async function saveAsLocked(buffer) {
    const { id } = buffer;
    const shown = buffer.id === shownId;
    let text;
    try {
      // Rust drops the document if the new path is this file, so nothing may
      // still be on its way to it.
      if (buffer.path === null) text = shown ? editor.getText() : buffer.editorState?.doc.toString() ?? buffer.text;
      else if (await sync.flush((doc) => doc.docId === buffer.docId)) text = await registryText(buffer);
      else throw new Error("unsaved changes could not be sent");
    } catch (error) {
      notify(`Could not save ${buffer.name}: ${errorMessage(error)}`);
      return false;
    }
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
    if (existing && existing.id !== id) {
      model.close(existing.id, { force: true });
      split.bufferClosed(existing.id);
    }
    const previousPath = buffer.path;
    const wasDraft = buffer.draft;
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
    split.reload(id);
    if (wasDraft && previousPath !== saved.path) {
      await invoke("draft_discard", { path: previousPath, ask: false })
        .catch((error) => console.error("Could not discard the saved draft", error));
    }
    await syncOpenList();
    await refreshRecent();
    render();
    return true;
  }

  // Cmd+S: a new file or a draft asks where to go; a saved one is written at once.
  function save(id = focusedId()) {
    const buffer = model.get(id);
    if (!buffer) return Promise.resolve(false);
    return buffer.path === null || buffer.draft ? saveAs(id) : saveNow(id);
  }

  async function saveDraftToNotes(id = model.active()?.id) {
    const buffer = model.get(id);
    if (!buffer?.draft || lockedId !== null) return false;
    lockedId = buffer.id;
    try {
      if (!(await sync.flush((doc) => doc.docId === buffer.docId))) {
        notify(`Could not save ${buffer.name}: unsaved changes could not be sent.`);
        return false;
      }
      await invoke("draft_save_to_notes", { path: buffer.path });
    } catch (error) {
      notify(errorMessage(error));
      return false;
    } finally {
      lockedId = null;
    }
    // Rust discarded the draft's document, so there is nothing to close.
    await forget(id, { detach: true });
    return true;
  }

  async function discardDraft(id = model.active()?.id) {
    const buffer = model.get(id);
    if (!buffer?.draft || lockedId !== null) return false;
    try {
      if (!(await invoke("draft_discard", { path: buffer.path, ask: true }))) return false;
    } catch (error) {
      notify(errorMessage(error));
      return false;
    }
    await forget(id, { detach: true });
    return true;
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
      const active = (showingStartPage ? null : model.active()?.path) ?? null;
      await invoke("file_set_open", { paths: model.paths(), active });
    } catch (error) {
      console.error("Could not update the open files", error);
    }
  }

  function takeLists(lists) {
    recent = Array.isArray(lists?.recent) ? lists.recent : [];
    drafts = Array.isArray(lists?.drafts) ? lists.drafts : [];
    renderRecent();
    renderDrafts();
  }

  async function refreshRecent() {
    let lists = null;
    try {
      lists = await invoke("file_lists");
    } catch (error) {
      console.error("Could not read the recent files", error);
    }
    takeLists(lists);
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
      // Rust has already brought the owning window forward.
      if (error?.code === "OpenElsewhere") return null;
      notify(error?.message ?? "Could not open the file");
      return null;
    }
  }

  // A target inside a folded section unfolds it first.
  function scrollToFragment(fragment) {
    if (layoutMode !== "reading") {
      revealAnchor(editor.view, fragment);
      scrollToAnchor(editor.view, fragment);
      return;
    }
    const target = findReadingAnchor(preview, fragment);
    const hiding = target ? readingFoldsHiding(preview, target, foldedSections(editor.view.state)) : [];
    if (hiding.length) {
      for (const id of hiding) setSectionFolded(editor.view, id, false);
      renderReadingFolds();
    }
    scrollToReadingAnchor(preview, fragment);
  }

  // A link to `chapter.md#heading` opens a file next to the shown one; Rust
  // refuses anything outside its folder, and then the click does nothing.
  // A sibling link in the right pane opens on the left.
  async function followLink(href, pane = "primary") {
    const action = resolveLinkAction(href);
    if (action.kind === "external") {
      openExternal(href);
      return;
    }
    if (action.kind === "anchor") {
      if (pane === "secondary") scrollRightPane(action.fragment);
      else await jumpTo(action.fragment);
      return;
    }
    const fromPath = pane === "secondary" ? paneDoc("secondary")?.path : showingStartPage ? null : model.active()?.path;
    if (action.kind !== "sibling" || !fromPath) return;
    let target;
    try {
      target = await invoke("file_doc_open_sibling", { fromPath, relative: action.path });
    } catch (error) {
      console.warn(`Not opening ${action.path}`, error);
      return;
    }
    await jump(async () => {
      const buffer = await openPath(target.path);
      if (buffer && action.fragment) scrollToFragment(action.fragment);
    }, action.fragment);
  }

  // ----------------------------------------------------
  // Back and forward
  // ----------------------------------------------------
  const scroller = () => (layoutMode === "reading" ? preview : editor.view.scrollDOM);

  function currentPlace() {
    const path = showingStartPage ? null : model.active()?.path;
    return path ? { path, top: Math.round(scroller().scrollTop) } : null;
  }

  function jumpTo(fragment) {
    return jump(() => scrollToFragment(fragment), fragment);
  }

  // Records a link jump so Back returns to where it started.
  async function jump(go, anchor) {
    const from = currentPlace();
    await go();
    const to = currentPlace();
    navHistory.visit(from, to && anchor ? { ...to, anchor } : to);
    renderNav();
  }

  async function goTo(place) {
    renderNav();
    if (!place) return;
    if (showingStartPage || model.active()?.path !== place.path) {
      if (!(await openPath(place.path))) return;
    }
    const restore = () => { scroller().scrollTop = place.top; };
    restore();
    preview.ownerDocument.defaultView?.requestAnimationFrame?.(restore);
  }

  const goBack = () => goTo(navHistory.back(currentPlace()));
  const goForward = () => goTo(navHistory.forward(currentPlace()));

  function renderNav() {
    const hidden = model.list().length === 0;
    backButton.hidden = hidden;
    forwardButton.hidden = hidden;
    backButton.disabled = !navHistory.canBack();
    forwardButton.disabled = !navHistory.canForward();
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
      // Not save(), which asks where to save a draft: a closed draft stays in app data.
      if (buffer.path !== null && !(await saveNow(id))) return false;
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
    await forget(id);
    return true;
  }

  // Drops a buffer this window no longer edits. `detach` lets go of a
  // document that is gone or belongs to another window now.
  async function forget(id, { detach = false } = {}) {
    model.close(id, { force: true });
    split.bufferClosed(id);
    if (shownId === id) {
      shownId = null;
      if (detach) editor.loadText("");
    }
    if (!model.active()) showingStartPage = true;
    await syncOpenList();
    await refreshRecent();
    render();
  }

  // ----------------------------------------------------
  // Moving to another window
  // ----------------------------------------------------
  // Where the file is read from, carried to the window it moves to.
  function viewState(buffer) {
    if (buffer.id === shownId) {
      const { view } = editor;
      const { start, end } = editor.getSelection();
      const scrolled = !showingStartPage && layoutMode !== "reading";
      return {
        selection: { start, end },
        top: scrolled ? view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop).from : null,
        previewTop: showingStartPage ? buffer.previewTop ?? 0 : preview.scrollTop,
        folds: [...foldedSections(view.state)]
      };
    }
    const state = buffer.editorState;
    const main = state?.selection.main;
    return {
      selection: { start: main?.from ?? 0, end: main?.to ?? 0 },
      top: null,
      previewTop: buffer.previewTop ?? 0,
      folds: state ? [...foldedSections(state)] : []
    };
  }

  // Applies a viewState() from another window to the shown file.
  function applyViewState(state) {
    if (!state || typeof state !== "object") return;
    const { view } = editor;
    const length = view.state.doc.length;
    const at = (value) => Math.max(0, Math.min(Number.isFinite(value) ? value : 0, length));
    if (Array.isArray(state.folds)) setFoldedSections(view, state.folds.filter((id) => typeof id === "string"));
    if (state.selection) editor.setSelection(at(state.selection.start), at(state.selection.end), { scroll: false });
    if (Number.isFinite(state.top)) view.dispatch({ effects: EditorView.scrollIntoView(at(state.top), { y: "start" }) });
    preview.scrollTop = Number.isFinite(state.previewTop) ? state.previewTop : 0;
  }

  // The registry document stays open, so its text, save state and comments go
  // along; only this window lets go of it.
  async function moveFile(id, to = null) {
    const buffer = model.get(id);
    if (!buffer) return false;
    if (buffer.path === null) {
      notify(`Save ${buffer.name} first to move it.`);
      return false;
    }
    if (lockedId !== null) return false;
    lockedId = buffer.id;
    try {
      if (!(await sync.flush((doc) => doc.docId === buffer.docId))) {
        notify(`Could not move ${buffer.name}: unsaved changes could not be sent.`);
        return false;
      }
      await invoke("main_window_move_file", { path: buffer.path, to, view: viewState(buffer) });
    } catch (error) {
      notify(errorMessage(error));
      return false;
    } finally {
      lockedId = null;
    }
    await forget(id, { detach: true });
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
    if (buffer) compareEdited(buffer.id);
    const inActivePane = buffer && buffer.id === (split.activePane() === "secondary" ? split.shownId() : shownId);
    if (inActivePane && findBar.isOpen()) findBar.run({ preserveActive: true, selectActive: false });
    if (buffer && buffer.id === shownId) scheduleOutline();
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
    const next = normalizeLayoutMode(value);
    // A composer is drawn by the editor or by the preview, never carried over.
    if (next !== layoutMode) reading.close();
    layoutMode = next;
    editorSection.classList.remove("mode-live", "mode-source", "mode-reading");
    editorSection.classList.add(`mode-${layoutMode}`);
    for (const [mode, button] of Object.entries(layoutButtons)) {
      button.classList.toggle("active", mode === layoutMode);
      button.setAttribute("aria-pressed", String(mode === layoutMode));
    }
    editor.setMode(editorModeFor(layoutMode));
    split.editor().setMode(editorModeFor(layoutMode));
    if (layoutMode === "reading") split.close();
    renderSplitButton();
    syncFormatting();
    comments.render();
    renderPreview();
    updateCurrentOutline();
    // Leaving Reading mode keeps the old preview, highlights and all.
    findBar.refreshPreview();
    if (persist) {
      storage.setItem(LAYOUT_KEY, layoutMode);
      broadcast(LAYOUT_KEY);
    }
  }

  const splitAvailable = () => layoutMode !== "reading";

  function renderSplitButton() {
    const button = $("split-file-btn");
    button.disabled = !splitAvailable();
    button.title = splitAvailable() ? `Split View (${isMac() ? "Cmd" : "Ctrl"}+\\)` : "Split view works in Live and Source";
  }

  function toggleSplit() {
    if (splitAvailable()) split.toggle();
  }

  function toggleSidebar() {
    if (model.list().length === 0 && !folders.hasRoots()) return;
    sidebarHidden = !sidebarHidden;
    renderSidebar();
  }

  // ----------------------------------------------------
  // Quit and start-up
  // ----------------------------------------------------
  // Saves everything before a quit or a window close. Returns false to cancel it.
  async function flushAll(failureMessage) {
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
      notify(failureMessage);
    }
    return ok;
  }

  const flushForQuit = () => flushAll("Could not save every file; quit cancelled");
  const flushForClose = () => flushAll("Could not save every file; the window stays open.");

  async function takePending() {
    let entries = [];
    try {
      entries = await invoke("file_take_pending");
    } catch (error) {
      console.error("Could not read files opened from outside", error);
    }
    let last = null;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const buffer = await openPath(entry.path);
      if (!buffer) continue;
      applyViewState(entry.view);
      last = buffer;
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
    takeLists(lists);
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
    // Listing the folders is not waited for: the window is usable before it is done.
    folders.restore(lists).catch((error) => console.error("Could not restore the folders", error));
  }

  function attach() {
    formatToolbar.attach();
    findBar.attach();
    // The markup names the macOS chord, which is not Cmd+H turned into Ctrl+H.
    if (!isMac()) $("find-toggle-replace").title = "Toggle Replace (Ctrl+H)";
    for (const [mode, button] of Object.entries(layoutButtons)) {
      button.addEventListener("click", () => setLayoutMode(mode));
    }
    editor.view.scrollDOM.addEventListener("scroll", updateCurrentOutline, { passive: true });
    preview.addEventListener("scroll", updateCurrentOutline, { passive: true });
    sidebarToggle.addEventListener("click", toggleSidebar);
    outlineToggle.addEventListener("click", toggleOutline);
    reviewNext.addEventListener("click", goToNextUnreviewed);
    backButton.addEventListener("click", goBack);
    forwardButton.addEventListener("click", goForward);
    // The side buttons of a mouse, as in a browser.
    $("file-editor").addEventListener("mouseup", (event) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.button === 3) goBack();
      else goForward();
    });
    preview.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      event.preventDefault();
      followLink(link.getAttribute("href"));
    });
    $("start-new-file-btn").addEventListener("click", newFile);
    $("start-open-file-btn").addEventListener("click", openDialog);
    $("menu-new-file-btn").addEventListener("click", () => { closeMenus(); newFile(); });
    $("menu-open-file-btn").addEventListener("click", () => { closeMenus(); openDialog(); });
    $("menu-save-file-btn").addEventListener("click", () => { closeMenus(); save(); });
    $("menu-save-as-btn").addEventListener("click", () => { closeMenus(); saveAs(); });
    $("menu-close-file-btn").addEventListener("click", () => { closeMenus(); closeFile(focusedId()); });
    $("menu-start-page-btn").addEventListener("click", () => { closeMenus(); showStartPage(); });
    $("comment-btn").addEventListener("click", () => comments.start());
    $("comments-count-btn").addEventListener("click", () => comments.toggle());
    $("split-file-btn").addEventListener("click", toggleSplit);
    compareButton.addEventListener("click", toggleCompare);
    $("draft-save-as-btn").addEventListener("click", () => saveAs(model.active()?.id));
    for (const [button, action] of [["draft-save-notes-btn", saveDraftToNotes], ["draft-discard-btn", discardDraft]]) {
      $(button).addEventListener("click", () => {
        const id = model.active()?.id;
        if (id) keepFocus(id, () => action(id));
      });
    }
    $("start-actions").hidden = false;
    $("recent-files").hidden = false;
    setLayoutMode(layoutMode, { persist: false });
  }

  // A draft lives in app data, so its folder cannot be shown.
  const browsable = (buffer) => Boolean(buffer?.path) && buffer.draft !== true;

  const openFolderDialog = () => folders.openFolderDialog();

  function browseFolder() {
    const buffer = showingStartPage ? null : model.active();
    return browsable(buffer) ? folders.browseFolder(buffer.path) : Promise.resolve();
  }

  const isMac = () => isMacLikePlatform(document.defaultView?.navigator);

  // Cmd on macOS, Ctrl elsewhere.
  const isCommandChord = (event) => (isMac()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey);

  // Cmd+Alt+F on macOS, where Option+F is a dead key, so the physical key is
  // matched. Ctrl+H elsewhere, but not AltGr+H.
  const isReplaceShortcut = (event) => (isMac()
    ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyF"
    : event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
      event.key.toLowerCase() === "h" && !event.getModifierState?.("AltGraph"));

  function handleFindShortcut(event) {
    if (showingStartPage || !model.active()) return false;
    let replace;
    if (isCommandChord(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") replace = false;
    else if (isReplaceShortcut(event)) replace = true;
    else return findBar.handleKeydown(event);
    event.preventDefault();
    findBar.open({ replace });
    return true;
  }

  // Escape closes the find bar first. Returns whether it did.
  function closeFind() {
    if (showingStartPage || !findBar.isOpen()) return false;
    findBar.close();
    return true;
  }

  // File shortcuts. Returns whether the event was one.
  function handleShortcut(event) {
    if (handleFindShortcut(event)) return true;
    const isMeta = event.metaKey || event.ctrlKey;
    if (!isMeta || event.altKey) return false;
    const key = event.key.toLowerCase();
    let action = null;
    if (key === "n" && !event.shiftKey) action = newFile;
    else if (key === "o" && !event.shiftKey) action = openDialog;
    else if (key === "o" && event.shiftKey && isCommandChord(event)) action = openFolderDialog;
    else if (key === "s" && event.shiftKey && model.active()) action = () => saveAs();
    // Ctrl+Cmd+S toggles the sidebar on macOS.
    else if (key === "s" && !event.shiftKey && !(event.ctrlKey && event.metaKey) && model.active()) action = () => save();
    else if (key === "w" && !event.shiftKey && model.active() && !showingStartPage) action = () => closeFile(focusedId());
    // Cmd+[ and Cmd+] go Back and Forward, as in a browser.
    else if (event.key === "[" && !event.shiftKey && model.list().length) action = goBack;
    else if (event.key === "]" && !event.shiftKey && model.list().length) action = goForward;
    // Cmd+\ (Ctrl+\ off macOS); Shift turns the key into | on some layouts.
    else if ((event.key === "\\" || event.key === "|") && isCommandChord(event) && splitAvailable() && model.active() && !showingStartPage) action = toggleSplit;
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
    receiveComments: event => comments.receive(event),
    setCoeditState: state => comments.setState(state),
    handleShortcut,
    closeFind,
    toggleSidebar,
    setLayoutMode,
    flushForQuit,
    flushForClose,
    newFile,
    openDialog,
    openFolderDialog,
    browseFolder,
    folderChanged: (payload) => folders.folderChanged(payload),
    openPath,
    save,
    saveAs,
    closeFile,
    moveFile,
    saveDraftToNotes,
    discardDraft,
    showStartPage,
    closeFormatMenus: () => formatToolbar.closeMenus(),
    setLineNumbers: (enabled) => {
      editor.setLineNumbers(enabled);
      split.editor().setLineNumbers(enabled);
    },
    setSyntaxHighlighting: (enabled) => {
      editor.setSyntaxHighlighting(enabled);
      split.editor().setSyntaxHighlighting(enabled);
      renderPreview();
    },
    model,
    editor
  };
}
