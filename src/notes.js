// SPDX-License-Identifier: GPL-3.0-or-later

import {
  LOCAL_FOLDERS_KEY,
  LOCAL_NOTES_BACKUP_KEY,
  LOCAL_NOTES_KEY,
  readStoredFolders,
  readStoredNotes
} from "./storage.js";
import { LOCAL_TRASH_KEY, readTrash } from "./trash.js";
import { createTrashUi } from "./trash-ui.js";
import { applyUpdatesToText, createNoteSync } from "./note-sync.js";
import { renderMarkdown, resolveLinkAction, sanitizeMarkdownHtml } from "./markdown.js";
import { scrollToReadingAnchor } from "./anchors.js";
import { getNotePreview } from "./note-preview.js";
import { createThemes } from "./themes.js";
import { createAppearance } from "./appearance.js";
import { broadcastPreference, onPreferenceChange } from "./preferences.js";
import { createAgentAccess } from "./agent-access.js";
import { applyPlatformShortcutLabels, isMacLikePlatform } from "./platform-labels.js";
import { compareNoteText, emptyNoteComparison } from "./note-compare.js";
import { findTextMatches } from "./find.js";
import { createMarkdownEditor } from "./editor-view.js";
import { commentsExtension, startComment } from "./editor-comments.js";
import { createComments } from "./comments-panel.js";
import { markdownEditingCommands, runFormatAction } from "./editor-commands.js";
import { createFormatToolbar } from "./format-toolbar.js";
import { livePreview } from "./editor-live-preview.js";
import { getMarkdownTemplateEdit } from "./markdown-insert.js";
import { escapeHTML, highlightPreviewCode } from "./syntax-highlighting.js";
import { exportHunks, renderHunkWidgets } from "./diff-hunk.js";
import { setHunkReviewed } from "./editor-hunks.js";
import { WELCOME_NOTE_CONTENT, WELCOME_NOTE_TITLE } from "./welcome-note.js";
import {
  canMoveNote,
  getNoteMoveTargetIndex,
  insertNoteBelowPinned,
  isNotePinned,
  moveNoteInGroup,
  normalizePinnedNoteOrder,
  setNotePinned
} from "./note-order.js";
import { autoTitle, UNTITLED_TITLE } from "./note-title.js";
import {
  UNFILED_SECTION_ID,
  isFolderNameAvailable,
  isReservedFolderName,
  moveFolder,
  normalizeFolderName,
  normalizeFolders,
  normalizeNoteFolderAssignments,
  noteSectionId,
  removeFolder,
  validFolderId
} from "./folders.js";
import { normalizeLayoutMode } from "./view-preferences.js";
import { createMermaidRenderer, themeVariablesFrom } from "./mermaid.js";

// ----------------------------------------------------
// Sodilaud - Core Application Logic
// Handles state, events, markdown compiling, and theme
// ----------------------------------------------------

const { invoke } = window.__TAURI__ ? window.__TAURI__.core : { invoke: () => Promise.resolve() };

// Select DOM elements
const appContainer = document.getElementById("app");
const sidebar = document.getElementById("sidebar");
const toggleSidebarBtn = document.getElementById("toggle-sidebar");
const newNoteBtn = document.getElementById("new-note-btn");
const newFolderBtn = document.getElementById("new-folder-btn");
const searchInput = document.getElementById("search-input");
const noteListContainer = document.getElementById("note-list-container");
const noteList = document.getElementById("note-list");
const noteTitleInput = document.getElementById("note-title");
const editorHost = document.getElementById("editor-host");
const markdownPreview = document.getElementById("markdown-preview");
const wordCharCount = document.getElementById("word-char-count");
const cursorPosition = document.getElementById("cursor-position");
const selectionCount = document.getElementById("selection-count");
const saveStatus = document.getElementById("save-status");
const focusBtn = document.getElementById("focus-btn");
const splitNoteBtn = document.getElementById("split-note-btn");
const compareNotesBtn = document.getElementById("compare-notes-btn");
const compareNotesCount = document.getElementById("compare-notes-count");
const topbarLeft = document.getElementById("topbar-left");

const layoutModeButtons = {
  live: document.getElementById("mode-live"),
  source: document.getElementById("mode-source"),
  reading: document.getElementById("mode-reading")
};

const actionsBtn = document.getElementById("actions-btn");
const actionsDropdown = document.getElementById("actions-dropdown-content");
const copyMarkdownBtn = document.getElementById("copy-markdown");
const copyHtmlBtn = document.getElementById("copy-html");
const importBtn = document.getElementById("import-btn");
const exportBtn = document.getElementById("export-btn");
const dbConnectBtn = document.getElementById("db-connect-btn");
const dbDisconnectBtn = document.getElementById("db-disconnect-btn");
const workspaceMenuValue = document.getElementById("workspace-menu-value");

const panesContainer = document.getElementById("panes-container");
const primaryPaneWrapper = document.getElementById("primary-pane-wrapper");
const primaryPaneHeader = document.getElementById("primary-pane-header");
const secondaryPaneWrapper = document.getElementById("secondary-pane-wrapper");
const secondaryNoteSelect = document.getElementById("secondary-note-select");
const secondaryNoteTitle = document.getElementById("secondary-note-title");
const closeSecondaryBtn = document.getElementById("close-secondary-btn");
const secondaryEditorHost = document.getElementById("secondary-editor-host");
const secondaryMarkdownPreview = document.getElementById("secondary-markdown-preview");

const findBar = document.getElementById("find-bar");
const findInput = document.getElementById("find-input");
const findCount = document.getElementById("find-count");
const findPrevBtn = document.getElementById("find-prev");
const findNextBtn = document.getElementById("find-next");
const findCloseBtn = document.getElementById("find-close");
const findToggleReplaceBtn = document.getElementById("find-toggle-replace");
const findCaseToggleBtn = document.getElementById("find-case-toggle");
const findExactToggleBtn = document.getElementById("find-exact-toggle");
const findRegexToggleBtn = document.getElementById("find-regex-toggle");
const findResultsToggleBtn = document.getElementById("find-results-toggle");
const findResultsPane = document.getElementById("find-results-pane");
const findResultsCloseBtn = document.getElementById("find-results-close");
const findAllNotesToggleBtn = document.getElementById("find-all-notes-toggle");
const findResultsSummary = document.getElementById("find-results-summary");
const findResultsList = document.getElementById("find-results-list");
const replaceRow = document.getElementById("replace-row");
const replaceInput = document.getElementById("replace-input");
const replaceOneBtn = document.getElementById("replace-one-btn");
const replaceAllBtn = document.getElementById("replace-all-btn");

const customContextMenu = document.getElementById("custom-context-menu");
const ctxCutBtn = document.getElementById("ctx-cut");
const ctxCopyBtn = document.getElementById("ctx-copy");
const ctxPasteBtn = document.getElementById("ctx-paste");
const ctxInsertDivider = document.getElementById("ctx-insert-divider");
const ctxInsertGroup = document.getElementById("ctx-insert-group");
const ctxInsertBtn = document.getElementById("ctx-insert");
const ctxInsertMenu = document.getElementById("ctx-insert-menu");
const ctxSelectAllBtn = document.getElementById("ctx-select-all");
const ctxFindBtn = document.getElementById("ctx-find");
const ctxCommentBtn = document.getElementById("ctx-comment");
const ctxOpenSideBtn = document.getElementById("ctx-open-side");
const ctxSidebarDivider = document.getElementById("ctx-sidebar-divider");
const ctxPinBtn = document.getElementById("ctx-pin-note");
const ctxMoveUpBtn = document.getElementById("ctx-move-up");
const ctxMoveDownBtn = document.getElementById("ctx-move-down");
const ctxMoveFolderGroup = document.getElementById("ctx-move-folder-group");
const ctxMoveFolderBtn = document.getElementById("ctx-move-folder");
const ctxMoveFolderMenu = document.getElementById("ctx-move-folder-menu");
const ctxDeleteNoteBtn = document.getElementById("ctx-delete-note");
const ctxDeleteNoteDivider = document.getElementById("ctx-delete-note-divider");
const ctxFolderNewNoteBtn = document.getElementById("ctx-folder-new-note");
const ctxFolderRenameBtn = document.getElementById("ctx-folder-rename");
const ctxFolderMoveUpBtn = document.getElementById("ctx-folder-move-up");
const ctxFolderMoveDownBtn = document.getElementById("ctx-folder-move-down");
const ctxFolderDeleteBtn = document.getElementById("ctx-folder-delete");
const ctxFolderDivider = document.getElementById("ctx-folder-divider");

const helpBtn = document.getElementById("help-btn");
const settingsMenuBtn = document.getElementById("settings-menu-btn");
const quickNotesCloseBtn = document.getElementById("quicknotes-close-btn");
const quickNotesDragRegion = document.getElementById("quicknotes-header");
const splitDropOverlay = document.getElementById("split-drop-overlay");

const ACTIVE_NOTE_KEY = "sodilaud_quicknotes_active_note";
const COLLAPSED_FOLDERS_KEY = "sodilaud_collapsed_folders";

// State
let notes = [];
let folders = [];
let trash = [];
let activeNoteId = null;
let secondaryNoteId = null;
let activePane = "primary"; // "primary" or "secondary"
let isSplitNoteMode = false;
let isCompareMode = false;
let noteComparison = emptyNoteComparison();
let noteComparisonSource = null;
let noteComparisonRefreshTimer = null;
let isNoteComparisonPending = false;
// The collection Rust has open. Notes, folders and trash mirror its last event.
let collectionId = null;
let workspaceInfo = { name: "Local notes", path: "", isDefault: true };
let currentLayoutMode = "live";
let primaryEditor = null;
let secondaryEditor = null;
let isFocusMode = false;
let findMatches = [];
let activeMatchIndex = -1;
let isFindBarOpen = false;
let isFindResultsOpen = false;
let isFindAllNotesMode = false;
let hasInvalidFindPattern = false;
let contextMenuTarget = null;
let contextMenuEditor = null;
let contextMenuNoteId = null;
let contextMenuFolderId = null;
let editingFolderId = null;
let isCreatingFolder = false;
const collapsedFolderIds = new Set();
let isMatchCaseMode = false;
let isExactMatchMode = false;
let isRegexMode = false;
let isReplaceOpen = false;
let previewDebounceTimer = null;
let noteListRenderTimer = null;
let titleSyncTimer = null;
let notificationSequence = 0;
let activeNotification = null;
let previewHighlightsRendered = false;
let isWorkspaceSwitching = false;

const shareAppearance = (key) => broadcastPreference(window, key);
const appearance = createAppearance({
  document,
  storage: localStorage,
  broadcast: shareAppearance,
  onPreviewLines: () => renderNoteList(searchInput.value),
  onLineNumbers: (enabled) => {
    primaryEditor.setLineNumbers(enabled);
    secondaryEditor.setLineNumbers(enabled);
  },
  onSyntaxHighlighting: (enabled) => {
    primaryEditor.setSyntaxHighlighting(enabled);
    secondaryEditor.setSyntaxHighlighting(enabled);
    updateMarkdownPreview();
    updateSecondaryMarkdownPreview();
  }
});
const mermaid = createMermaidRenderer({ document });
mermaid.onChange(() => {
  updateMarkdownPreview();
  updateSecondaryMarkdownPreview();
});
// The theme is chosen in the main window; this page only follows it.
const themes = createThemes({
  document,
  storage: localStorage,
  invoke,
  onApplied: () => mermaid.setTheme(themeVariablesFrom(document))
});

// ----------------------------------------------------
// Rust-owned collection
// ----------------------------------------------------
// Rust owns the notes. This page renders its events and sends two kinds of
// writes: text changes, through a collab client per editor (note-sync.js), and
// the sidebar structure, as the order and metadata the page arranged.

// What Rust holds once the writes already sent are applied, so each write
// carries only what the page changed since.
const knownNotes = new Map();
const knownFolders = new Map();
let structureQueue = Promise.resolve(true);
let structureWritesInFlight = 0;
let deferredWorkspaceState = null;
let lastWorkspaceSeq = 0;
let structureFailed = false;
let textSyncFailed = false;

const noteSync = createNoteSync({
  invoke,
  collectionId: () => collectionId,
  ready: () => structureQueue,
  label: "quicknotes",
  onRemote: remote => comments.remote(remote),
  onStatus: ({ failed }) => {
    textSyncFailed = failed;
    refreshSaveStatus();
  },
  onReload: (noteId, text, version) => {
    const note = notes.find(candidate => candidate.id === noteId);
    if (!note) return;
    note.content = text;
    note.syncedContent = text;
    note.version = version;
    forgetPaneStates(noteId);
    if (activeNoteId === noteId) loadActiveNote();
    if (isSplitNoteMode && secondaryNoteId === noteId) loadSecondaryNote();
  }
});

// The save label for the current state. A notification that is showing gets it
// as the label to restore when it goes away.
function refreshSaveStatus() {
  const apply = structureFailed || textSyncFailed ? setSaveFailedState
    : noteSync.pending() || structureWritesInFlight > 0 ? triggerSavingState
      : setSavedState;
  if (!activeNotification) {
    apply();
    return;
  }
  const shown = { textContent: saveStatus.textContent, className: saveStatus.className, title: saveStatus.title };
  apply();
  activeNotification.restoreState = { textContent: saveStatus.textContent, className: saveStatus.className, title: saveStatus.title };
  Object.assign(saveStatus, { textContent: shown.textContent, className: shown.className, title: shown.title });
}

const noteMeta = note => ({
  title: note.title,
  isTitleLocked: Boolean(note.isTitleLocked),
  isPinned: Boolean(note.isPinned),
  folderId: note.folderId ?? null
});

// The sidebar as this page arranged it, with each note's and folder's changes
// relative to what Rust last reported. An unlocked title is Rust's to derive.
function structurePayload() {
  const payload = {
    collectionId,
    notes: notes.map(note => {
      const known = knownNotes.get(note.id);
      const meta = noteMeta(note);
      if (!known) return { id: note.id, ...meta, content: note.syncedContent ?? "" };
      const patch = { id: note.id };
      if (meta.isTitleLocked !== known.isTitleLocked) patch.isTitleLocked = meta.isTitleLocked;
      if (meta.isTitleLocked && meta.title !== known.title) patch.title = meta.title;
      if (meta.isPinned !== known.isPinned) patch.isPinned = meta.isPinned;
      if (meta.folderId !== known.folderId) patch.folderId = meta.folderId;
      return patch;
    }),
    folders: folders.map(folder => (
      knownFolders.get(folder.id) === folder.name ? { id: folder.id } : { id: folder.id, name: folder.name }
    )),
    deletedFolderIds: [...knownFolders.keys()].filter(id => !folders.some(folder => folder.id === id))
  };
  // Rust applies writes in order, so the next payload is relative to this one.
  // The next Rust state that is applied resets both maps.
  knownNotes.clear();
  notes.forEach(note => knownNotes.set(note.id, noteMeta(note)));
  knownFolders.clear();
  folders.forEach(folder => knownFolders.set(folder.id, folder.name));
  return payload;
}

// The payload is taken now, so a Rust event that arrives before it is sent
// cannot erase what the user just did.
function syncStructure() {
  if (!collectionId) return Promise.resolve(false);
  const payload = structurePayload();
  structureWritesInFlight += 1;
  triggerSavingState();
  const result = structureQueue.then(async () => {
    try {
      deferWorkspaceState(await invoke("notes_sync_structure", { structure: payload }));
      structureFailed = false;
      return true;
    } catch (error) {
      console.error("Could not save the note list", error);
      structureFailed = true;
      // Rust may lack this write, so the next one sends every note in full.
      knownNotes.clear();
      showNotification(`Could not save the note list: ${error.message || error}`);
      return false;
    } finally {
      structureWritesInFlight -= 1;
      if (structureWritesInFlight === 0 && deferredWorkspaceState) {
        const state = deferredWorkspaceState;
        deferredWorkspaceState = null;
        applyWorkspaceState(state);
      }
      refreshSaveStatus();
    }
  });
  structureQueue = result;
  return result;
}

function scheduleTitleSync() {
  clearTimeout(titleSyncTimer);
  titleSyncTimer = setTimeout(() => {
    titleSyncTimer = null;
    syncStructure();
  }, 400);
}

function flushTitleSync() {
  if (titleSyncTimer === null) return;
  clearTimeout(titleSyncTimer);
  titleSyncTimer = null;
  syncStructure();
}

function scheduleNoteListRender() {
  clearTimeout(noteListRenderTimer);
  noteListRenderTimer = setTimeout(() => {
    noteListRenderTimer = null;
    if (!isCreatingFolder && editingFolderId === null) renderNoteList(searchInput.value);
  }, 400);
}

// Each pane keeps the editor state of every note it showed, so switching back
// resumes the same collab client, with its unsent changes and undo history.
// A new editor starts from the text Rust confirmed, never from unsent typing.
const paneStates = { primary: new Map(), secondary: new Map() };
const paneNoteIds = { primary: null, secondary: null };

// Forgets what the panes hold for one note, or for every note, so the next
// load starts again from Rust's text.
function forgetPaneStates(noteId = null) {
  for (const pane of Object.keys(paneStates)) {
    if (noteId === null) {
      paneStates[pane].clear();
      paneNoteIds[pane] = null;
    } else {
      paneStates[pane].delete(noteId);
      if (paneNoteIds[pane] === noteId) paneNoteIds[pane] = null;
    }
  }
}

function showNoteInPane(pane, editor, note) {
  const previous = paneNoteIds[pane];
  if (previous === note.id) return;
  if (previous !== null && notes.some(candidate => candidate.id === previous)) {
    paneStates[pane].set(previous, editor.getState());
  }
  paneNoteIds[pane] = note.id;
  const cached = paneStates[pane].get(note.id);
  paneStates[pane].delete(note.id);
  if (cached) editor.restoreState(cached);
  else editor.loadText(note.syncedContent ?? note.content, { extensions: noteSync.extension(note.id, note.version ?? 0) });
  comments.shown();
}

const openNoteText = noteId => {
  if (activeNoteId === noteId) return primaryEditor.getText();
  if (isSplitNoteMode && secondaryNoteId === noteId) return secondaryEditor.getText();
  return null;
};

function deferWorkspaceState(state) {
  if (state && (!deferredWorkspaceState || state.seq > deferredWorkspaceState.seq)) deferredWorkspaceState = state;
}

// Replaces the page's collection with Rust's. Open editors keep their own text:
// they are collab clients and catch up through doc updates. While this page's
// own structure writes are on their way, the newest state waits for them, so
// the sidebar never jumps back to an arrangement the user already changed.
function applyWorkspaceState(state, { initial = false } = {}) {
  if (!state || !Array.isArray(state.notes)) return;
  if (!initial && state.seq <= lastWorkspaceSeq) return;
  if (!initial && structureWritesInFlight > 0 && state.collectionId === collectionId) {
    deferWorkspaceState(state);
    return;
  }
  lastWorkspaceSeq = state.seq;
  const switched = state.collectionId !== collectionId;
  collectionId = state.collectionId;
  workspaceInfo = { name: state.name, path: state.path, isDefault: state.isDefault };
  if (switched) forgetPaneStates();
  const present = new Set(state.notes.map(note => note.id));
  for (const pane of Object.keys(paneStates)) {
    for (const noteId of paneStates[pane].keys()) if (!present.has(noteId)) paneStates[pane].delete(noteId);
  }
  notes = state.notes.map(note => ({
    ...note,
    syncedContent: note.content,
    content: switched ? note.content : (openNoteText(note.id) ?? note.content)
  }));
  folders = state.folders.map(folder => ({ id: folder.id, name: folder.name }));
  trash = Array.isArray(state.trash) ? state.trash : [];
  knownNotes.clear();
  notes.forEach(note => knownNotes.set(note.id, noteMeta(note)));
  knownFolders.clear();
  folders.forEach(folder => knownFolders.set(folder.id, folder.name));
  updateDbUiState();
  refreshTrashUi();
  if (initial) return;

  if (switched || !notes.some(note => note.id === activeNoteId)) {
    activeNoteId = notes[0]?.id ?? null;
    loadActiveNote();
  } else {
    const active = notes.find(note => note.id === activeNoteId);
    if (active && document.activeElement !== noteTitleInput) noteTitleInput.value = active.title;
  }
  if (switched) syncSecondaryNoteUi(true);
  else syncSecondaryNoteUi(isSplitNoteMode && !notes.some(note => note.id === secondaryNoteId));
  if (!isCreatingFolder && editingFolderId === null) renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  if (isFindResultsOpen && isFindAllNotesMode) renderFindResults();
  if (pendingFocusNoteId !== null) focusPendingNote();
}

// Text another client changed: this page's editors, another pane, or an agent.
async function applyDocUpdates(event) {
  if (!event || event.collectionId !== collectionId) return;
  noteSync.receive(event);
  const note = notes.find(candidate => candidate.id === event.noteId);
  if (!note) return;
  note.title = event.title;
  note.updatedAt = event.updatedAt;
  if (note.version === event.from) {
    note.syncedContent = applyUpdatesToText(note.syncedContent, event.updates);
    note.version = event.version;
  } else if ((note.version ?? 0) < event.version) {
    await catchUpNote(note);
  }
  note.content = openNoteText(note.id) ?? note.syncedContent;
  if (!note.isTitleLocked) knownNotes.set(note.id, noteMeta(note));
  refreshOpenNoteViews(note.id);
}

async function catchUpNote(note) {
  try {
    const since = note.version ?? 0;
    const result = await invoke("doc_pull", { collectionId, noteId: note.id, since });
    if (result?.reload) {
      note.syncedContent = result.reload.text;
      note.version = result.reload.version;
    } else if (Array.isArray(result?.updates) && note.version === since) {
      note.syncedContent = applyUpdatesToText(note.syncedContent, result.updates);
      note.version = since + result.updates.length;
    }
  } catch (error) {
    console.error("Could not catch up a note", error);
  }
}

function refreshOpenNoteViews(noteId) {
  try {
    const note = notes.find(candidate => candidate.id === noteId);
    if (activeNoteId === noteId) {
      if (note && document.activeElement !== noteTitleInput) noteTitleInput.value = note.title;
      updateMarkdownPreview();
      updateWordCharCountForText(primaryEditor);
    }
    if (isSplitNoteMode && secondaryNoteId === noteId) {
      if (note && document.activeElement !== secondaryNoteTitle) secondaryNoteTitle.value = note.title;
      updateSecondaryMarkdownPreview();
    }
    // A pending refresh reads the editors when it fires, and the echo of this
    // page's own push leaves the texts as last compared: neither needs a new one.
    if (
      isCompareMode &&
      (activeNoteId === noteId || secondaryNoteId === noteId) &&
      !isNoteComparisonPending &&
      !noteComparisonMatches(primaryEditor.getText(), secondaryEditor.getText())
    ) {
      scheduleNoteComparisonRefresh();
    }
    if (isFindResultsOpen && isFindAllNotesMode) renderFindResults();
    if (isFindBarOpen && activeNoteId === noteId) runFind({ preserveActive: true, selectActive: false });
    populateSecondaryNoteSelect();
    scheduleNoteListRender();
  } catch (error) {
    console.error("Could not render a note change", error);
  }
}

async function registerWorkspaceListeners() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  await listen("notes-workspace-changed", ({ payload }) => {
    if (collectionId !== null) applyWorkspaceState(payload);
  });
  await listen("notes-doc-updates", ({ payload }) => {
    applyDocUpdates(payload).catch(error => console.error("Could not apply a note change", error));
  });
  await listen("comments-changed", ({ payload }) => comments.receive(payload));
  await listen("coedit-state", ({ payload }) => comments.setState(payload));
}

const trashUi = createTrashUi({
  state: () => ({ entries: trash, collectionId, error: null }),
  restore: async (id, expectedCollection) => {
    await invoke("notes_restore", { collectionId: expectedCollection, trashId: id });
  },
  empty: async (ids, expectedCollection) => {
    await invoke("notes_empty_trash", { collectionId: expectedCollection, ids });
  }
});

function refreshTrashUi() { trashUi.refresh(); }

const agentAccess = createAgentAccess({
  document,
  invoke,
  notify: showNotification,
  menuSection: document.getElementById("agent-access-menu-section"),
  statusAnchor: document.getElementById("comments-count-btn"),
  closeMenu: () => {
    toggleActionsDropdown(false);
    actionsBtn.focus({ preventScroll: true });
  },
  // Agents read what Rust holds, so send what is still unsent first.
  beforeEnable: flushPendingSaves
});

// Comments on the notes the panes show. The drawer follows the active pane.
const paneDocs = () => {
  const shown = [];
  if (primaryEditor && activeNoteId) shown.push({ view: primaryEditor.view, doc: { collectionId, noteId: activeNoteId }, pane: "primary" });
  if (secondaryEditor && isSplitNoteMode && secondaryNoteId) {
    shown.push({ view: secondaryEditor.view, doc: { collectionId, noteId: secondaryNoteId }, pane: "secondary" });
  }
  return shown;
};
const comments = createComments({
  document,
  invoke,
  root: document.getElementById("comments-panel"),
  countButton: document.getElementById("comments-count-btn"),
  editors: paneDocs,
  active: () => {
    if (currentLayoutMode === "reading" || !collectionId) return null;
    const pane = isSplitNoteMode ? activePane : "primary";
    return paneDocs().find(shown => shown.pane === pane) ?? null;
  },
  flush: () => noteSync.flush(),
  notify: message => showNotification(message)
});

const WORD_COUNT_DEBOUNCE_MS = 150;
let wordCountTimer = null;

// Counting words walks the whole document, so it trails typing; the cursor
// position stays immediate.
function scheduleWordCharCount(pane, editor) {
  clearTimeout(wordCountTimer);
  wordCountTimer = setTimeout(() => {
    wordCountTimer = null;
    if (activePane === pane) updateWordCharCountForText(editor);
  }, WORD_COUNT_DEBOUNCE_MS);
}

const editorModeFor = mode => mode === "source" ? "source" : "live";

function createAppEditor(host, { ariaLabel, pane }) {
  const editor = createMarkdownEditor({
    parent: host,
    ariaLabel,
    placeholder: "Type something here... Supports Markdown formatting.",
    mode: editorModeFor(currentLayoutMode),
    syntaxHighlighting: appearance.syntaxHighlighting,
    lineNumbers: appearance.lineNumbers,
    extensions: [
      markdownEditingCommands(),
      livePreview({ onOpenLink: openExternalHref, mermaid }),
      commentsExtension({
        onSubmit: (view, comment) => comments.submit(view, comment),
        onSelect: id => {
          setActivePane(view === secondaryEditor?.view ? "secondary" : "primary");
          comments.select(id);
        }
      })
    ],
    onChange: pane === "primary" ? handleEditorInput : handleSecondaryEditorInput,
    onSelectionChange: () => {
      if (activePane !== pane) return;
      updateCursorPositionForText(editor);
      scheduleWordCharCount(pane, editor);
    },
    onFocus: () => setActivePane(pane)
  });
  return editor;
}

// Copies the collection earlier versions kept in local storage, for the one-time
// import into the default workspace. Local storage itself is left untouched,
// so going back to an older release still finds every note.
function readLocalCollection() {
  let localNotes = [];
  try {
    localNotes = readStoredNotes(localStorage.getItem(LOCAL_NOTES_KEY)) ?? [];
  } catch (error) {
    console.error("Failed to read local notes", error);
  }
  // Notes set aside by an early build, when local storage was shared between
  // the local-only collection and the active workspace.
  try {
    const stashed = readStoredNotes(localStorage.getItem(LOCAL_NOTES_BACKUP_KEY));
    if (stashed) {
      const byId = new Map(stashed.map(note => [note.id, note]));
      localNotes.forEach(note => {
        const held = byId.get(note.id);
        if (!held || (note.updatedAt || 0) >= (held.updatedAt || 0)) byId.set(note.id, note);
      });
      localNotes = [...byId.values()];
    }
  } catch (error) {
    console.error("Failed to read previously set-aside notes", error);
  }
  const localFolders = normalizeFolders(readStoredFolders(localStorage.getItem(LOCAL_FOLDERS_KEY)));
  let localTrash = [];
  try {
    localTrash = readTrash(localStorage.getItem(LOCAL_TRASH_KEY));
  } catch (error) {
    console.error("Local trash could not be read; it stays in local storage", error);
  }
  const validNotes = localNotes.filter(note => note && typeof note.id === "string" && note.id
    && typeof note.content === "string" && typeof note.title === "string");
  return {
    notes: normalizePinnedNoteOrder(normalizeNoteFolderAssignments(validNotes, localFolders)).map(note => ({
      id: note.id,
      title: note.title,
      content: note.content,
      updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : Date.now(),
      isTitleLocked: Boolean(note.isTitleLocked),
      isPinned: Boolean(note.isPinned),
      folderId: note.folderId ?? null
    })),
    folders: localFolders,
    trash: localTrash
  };
}

// Initialize app
async function init() {
  // 1. Localize shortcut labels and attach event listeners immediately.
  applyPlatformShortcutLabels(document, navigator);
  primaryEditor = createAppEditor(editorHost, { ariaLabel: "Sodilaud content", pane: "primary" });
  secondaryEditor = createAppEditor(secondaryEditorHost, {
    ariaLabel: "Secondary scratchpad content",
    pane: "secondary"
  });
  attachEventListeners();
  await registerQuitHandler();
  await registerQuickNotesHandlers();
  await registerWorkspaceListeners();
  await onPreferenceChange(window, followPreferenceChange);

  // 2. Load the saved theme (Default Dark on first launch) and layout mode
  themes.load();
  appearance.load();
  const savedLayoutMode = localStorage.getItem("sodilaud_layout_mode");
  setLayoutMode(normalizeLayoutMode(savedLayoutMode), { persist: savedLayoutMode !== null });
  loadCollapsedFolders();

  // 3. Rust opened the remembered workspace, or the default one, at launch. A
  // workspace path kept in local storage by an old build is handed over once.
  const boot = await invoke("notes_boot", { legacyPath: localStorage.getItem("sodilaud_active_db") });
  if (!boot?.state) throw new Error("Sodilaud returned no notes collection");
  localStorage.removeItem("sodilaud_active_db");
  let state = boot.state;
  if (boot.needsLocalImport) {
    state = await invoke("notes_import_local", { local: readLocalCollection() });
  }
  applyWorkspaceState(state, { initial: true });
  if (boot.fallback) showNotification(boot.fallback);

  // 4. Create default note if none exist
  if (notes.length === 0) {
    createNote(WELCOME_NOTE_TITLE, WELCOME_NOTE_CONTENT);
  } else {
    // Reopen the note that was open last, or the first one.
    const remembered = localStorage.getItem(ACTIVE_NOTE_KEY);
    activeNoteId = notes.some(note => note.id === remembered) ? remembered : notes[0].id;
  }

  // 5. Render UI
  renderNoteList();
  loadActiveNote();
  await agentAccess.load();
  try {
    comments.setState(await invoke("coedit_get_state"));
  } catch (error) {
    console.error("Could not read the comment mode", error);
  }
}

// ----------------------------------------------------
// Note Management Logic
// ----------------------------------------------------
function createNoteRecord(title, content, folderId) {
  // Rust stores text with \n line breaks, as the editor does.
  const text = String(content ?? "").replace(/\r\n?/g, "\n");
  const isTitleLocked = title !== UNTITLED_TITLE && title !== WELCOME_NOTE_TITLE;
  return {
    id: `note_${window.crypto.randomUUID()}`,
    title: isTitleLocked ? title : (text ? autoTitle(text) : title),
    content: text,
    updatedAt: Date.now(),
    isTitleLocked,
    isPinned: false,
    folderId,
    syncedContent: text,
    version: 0
  };
}

function createNote(title = "Untitled Scratchpad", content = "", folderId = undefined) {
  const activeNote = notes.find((note) => note.id === activeNoteId);
  const destinationFolderId = folderId === undefined
    ? (isNotePinned(activeNote) ? null : validFolderId(activeNote?.folderId, folders))
    : validFolderId(folderId, folders);
  const newNote = createNoteRecord(title, content, destinationFolderId);
  
  notes = insertNoteBelowPinned(notes, newNote);
  activeNoteId = newNote.id;
  const destinationSectionId = destinationFolderId || UNFILED_SECTION_ID;
  if (collapsedFolderIds.delete(destinationSectionId)) persistCollapsedFolders();
  searchInput.value = "";
  
  syncStructure();
  renderNoteList();
  loadActiveNote();
  syncSecondaryNoteUi(true);
  
  const activeItem = noteList.querySelector(`[data-id="${newNote.id}"]`);
  if (typeof activeItem?.scrollIntoView === "function") {
    activeItem.scrollIntoView({ block: "nearest" });
  }

  // A blank scratchpad has nothing to render, and Reading hides the editor, so
  // it would open on an empty pane with nowhere to type. Only that mode strands
  // the user, and an import or the welcome note arrives with content worth
  // reading, so it is left as it is.
  if (!content && currentLayoutMode === "reading") setLayoutMode("live");
  primaryEditor.focus();
}

function deleteNote(id, event) {
  if (event) event.stopPropagation();
  const expectedCollection = collectionId;
  // Unsent typing goes into the trash with the note.
  return Promise.all([noteSync.flush(), structureQueue])
    .then(() => invoke("notes_trash", { collectionId: expectedCollection, noteId: id }))
    .catch(error => {
      setSaveFailedState();
      showNotification(`Could not delete the note: ${error.message || error}`);
    });
}

function loadActiveNote() {
  const activeNote = notes.find(n => n.id === activeNoteId);
  if (!activeNote) return;
  try {
    localStorage.setItem(ACTIVE_NOTE_KEY, activeNote.id);
  } catch {
    // Only the reopened note depends on it.
  }

  cancelScheduledNoteComparison();

  noteTitleInput.value = activeNote.title;
  showNoteInPane("primary", primaryEditor, activeNote);

  updateWordCharCountForText(primaryEditor);
  updateMarkdownPreview();
  markdownPreview.scrollTop = 0;
  applyComparisonDecorations();
  if (isFindBarOpen) {
    runFind({ selectActive: false });
  } else {
    updateFindHighlights();
  }
}

function createNoteListItem(note) {
    const item = document.createElement("li");
    item.className = `note-item ${note.id === activeNoteId ? "active" : ""} ${isNotePinned(note) ? "pinned" : ""}`;
    item.setAttribute("data-id", note.id);
    item.setAttribute("data-pinned", String(isNotePinned(note)));
    item.tabIndex = 0;
    item.setAttribute("aria-label", `Open ${isNotePinned(note) ? "pinned " : ""}${note.title}`);
    if (note.id === activeNoteId) item.setAttribute("aria-current", "true");
    
    const snippet = getNotePreview(note, appearance.previewLines);
    
    const formattedDate = new Date(note.updatedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    item.innerHTML = `
      <div class="note-item-header">
        <span class="note-item-title">${escapeHTML(note.title)}</span>
        <div class="note-item-actions">
          <button class="note-item-pin" title="${isNotePinned(note) ? "Unpin scratchpad" : "Pin scratchpad to top"}" aria-label="${isNotePinned(note) ? "Unpin" : "Pin"} ${escapeHTML(note.title)}" aria-pressed="${String(isNotePinned(note))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 17v5M5 17h14M15 3.5l5.5 5.5-3 1.5-4 4-1.5 3-5-5 3-1.5 4-4L15 3.5z" />
            </svg>
          </button>
          <button class="note-item-delete" title="Delete scratchpad" aria-label="Delete ${escapeHTML(note.title)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
      <div class="note-item-snippet">${escapeHTML(snippet)}</div>
      <div class="note-item-meta">
        <span>${formattedDate}</span>
      </div>
    `;
    
    let isItemDragged = false;

    // Switch to selected note on click
    item.addEventListener("click", (e) => {
      if (isItemDragged) {
        isItemDragged = false;
        return;
      }
      if (isSplitNoteMode && activePane === "secondary") {
        secondaryNoteId = note.id;
        populateSecondaryNoteSelect();
        loadSecondaryNote();
      } else {
        activeNoteId = note.id;
        renderNoteList(searchInput.value);
        loadActiveNote();
      }
    });

    item.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button")) {
        e.preventDefault();
        item.click();
      }
    });

    // Right click for context menu (Open to the side, move up/down)
    item.addEventListener("contextmenu", (e) => {
      e.stopPropagation();
      contextMenuNoteId = note.id;
      showContextMenu(e, note.id);
    });

    // Pointer-based drag and drop for rock-solid reordering in desktop webviews
    item.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      
      const pointerId = e.pointerId;
      try {
        item.setPointerCapture(pointerId);
      } catch (err) {}

      const startX = e.clientX;
      const startY = e.clientY;
      let hasDragged = false;
      let dragAvatar = null;
      let dropTarget = null;
      let dropPosition = "bottom";
      let isOverSplitDropZone = false;

      function onPointerMove(moveEvent) {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        // 4px threshold to distinguish normal click from dragging
        if (!hasDragged && Math.hypot(dx, dy) > 4) {
          hasDragged = true;
          isItemDragged = true;
          item.classList.add("dragging");

          dragAvatar = item.cloneNode(true);
          dragAvatar.className = "note-item drag-avatar";
          dragAvatar.style.width = `${item.offsetWidth}px`;
          dragAvatar.style.position = "fixed";
          dragAvatar.style.pointerEvents = "none";
          dragAvatar.style.zIndex = "9999";
          dragAvatar.style.opacity = "0.9";
          dragAvatar.style.left = `${moveEvent.clientX - 20}px`;
          dragAvatar.style.top = `${moveEvent.clientY - 20}px`;
          document.body.appendChild(dragAvatar);
        }

        if (hasDragged && dragAvatar) {
          dragAvatar.style.left = `${moveEvent.clientX - 20}px`;
          dragAvatar.style.top = `${moveEvent.clientY - 20}px`;

          const sidebarRect = sidebar.getBoundingClientRect();
          const isPastSidebar = moveEvent.clientX > (sidebarRect.right + 10);

          if (isPastSidebar) {
            // Dragging over the editor workspace!
            document.querySelectorAll(".note-item").forEach(el => {
              el.classList.remove("drag-over-top", "drag-over-bottom");
            });
            dropTarget = null;
            isOverSplitDropZone = true;
            splitDropOverlay.style.display = "flex";
          } else {
            // Inside the sidebar list: Reordering mode
            isOverSplitDropZone = false;
            splitDropOverlay.style.display = "none";

            // Hit test underneath the cursor
            dragAvatar.style.display = "none";
            const elemBelow = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
            dragAvatar.style.display = "flex";

            const targetItem = elemBelow ? elemBelow.closest(".note-item:not(.drag-avatar)") : null;
            const targetFolder = elemBelow ? elemBelow.closest(".note-folder-header[data-accept-notes='true']") : null;

            document.querySelectorAll(".note-item").forEach(el => {
              el.classList.remove("drag-over-top", "drag-over-bottom");
            });
            document.querySelectorAll(".note-folder-header").forEach(el => {
              el.classList.remove("drag-over-folder");
            });

            const targetNote = targetItem
              ? notes.find(candidate => candidate.id === targetItem.getAttribute("data-id"))
              : null;

            const isSameSection = targetNote && (
              noteSectionId(targetNote, folders) === noteSectionId(note, folders)
            );
            if (
              targetItem &&
              targetItem !== item &&
              (isSameSection || !isNotePinned(targetNote))
            ) {
              dropTarget = targetItem;
              const rect = targetItem.getBoundingClientRect();
              const isTop = (moveEvent.clientY - rect.top) < (rect.height / 2);
              dropPosition = isTop ? "top" : "bottom";
              targetItem.classList.toggle("drag-over-top", isTop);
              targetItem.classList.toggle("drag-over-bottom", !isTop);
            } else if (targetFolder) {
              dropTarget = targetFolder;
              dropPosition = "folder";
              targetFolder.classList.add("drag-over-folder");
            } else {
              dropTarget = null;
            }
          }
        }
      }

      function cleanupPointerDrag() {
        try {
          item.releasePointerCapture(pointerId);
        } catch (err) {}

        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);

        if (dragAvatar) {
          dragAvatar.remove();
          dragAvatar = null;
        }

        splitDropOverlay.style.display = "none";

        document.querySelectorAll(".note-item").forEach(el => {
          el.classList.remove("drag-over-top", "drag-over-bottom", "dragging");
        });
        document.querySelectorAll(".note-folder-header").forEach(el => {
          el.classList.remove("drag-over-folder");
        });
      }

      function onPointerCancel() {
        cleanupPointerDrag();
        isItemDragged = false;
      }

      function onPointerUp() {
        cleanupPointerDrag();

        if (hasDragged && isOverSplitDropZone) {
          openNoteInSecondaryPane(note.id);
          showNotification(`Opened "${note.title}" side-by-side`);
        } else if (hasDragged && dropTarget) {
          if (dropPosition === "folder") {
            const sectionId = dropTarget.dataset.sectionId;
            const folderId = sectionId === UNFILED_SECTION_ID ? null : sectionId;
            moveNoteToFolder(note.id, folderId);
          } else {
            const targetId = dropTarget.getAttribute("data-id");
            if (!targetId || targetId === note.id) return;
            const fromIndex = notes.findIndex(n => n.id === note.id);
            const toIndex = notes.findIndex(n => n.id === targetId);

            if (fromIndex !== -1 && toIndex !== -1) {
              const [draggedNote] = notes.splice(fromIndex, 1);
              const targetNote = notes.find(n => n.id === targetId);
              if (noteSectionId(draggedNote, folders) !== noteSectionId(targetNote, folders)) {
                draggedNote.folderId = validFolderId(targetNote?.folderId, folders);
                draggedNote.isPinned = false;
              }
              let targetIndex = notes.findIndex(n => n.id === targetId);
              if (dropPosition === "bottom") {
                targetIndex += 1;
              }
              notes.splice(targetIndex, 0, draggedNote);

              syncStructure();
              renderNoteList(searchInput.value);
              populateSecondaryNoteSelect();
              showNotification("Notes reordered");
            }
          }
        }
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    });
    
    item.querySelector(".note-item-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleNotePinned(note.id);
    });

    // Delete listener
    item.querySelector(".note-item-delete").addEventListener("click", (e) => {
      deleteNote(note.id, e);
    });

    return item;
}

function folderIconMarkup() {
  return `<svg class="note-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3 6.75A1.75 1.75 0 014.75 5h4l2 2h8.5A1.75 1.75 0 0121 8.75v8.5A1.75 1.75 0 0119.25 19H4.75A1.75 1.75 0 013 17.25V6.75z" />
  </svg>`;
}

function persistCollapsedFolders() {
  localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...collapsedFolderIds]));
}

function toggleFolderCollapsed(sectionId) {
  if (collapsedFolderIds.has(sectionId)) {
    collapsedFolderIds.delete(sectionId);
  } else {
    collapsedFolderIds.add(sectionId);
  }
  persistCollapsedFolders();
  renderNoteList(searchInput.value);
  const matchingHeader = [...noteList.querySelectorAll(".note-folder-header")]
    .find((header) => header.dataset.sectionId === sectionId);
  matchingHeader?.querySelector(".note-folder-toggle")?.focus({ preventScroll: true });
}

function renderFolderEditor(folder = null) {
  const section = document.createElement("li");
  section.className = "note-folder-section";
  const header = document.createElement("div");
  header.className = "note-folder-header";
  header.innerHTML = `${folderIconMarkup()}<input class="note-folder-input" aria-label="${folder ? "Rename folder" : "New folder name"}" maxlength="80" value="${escapeHTML(folder?.name || "")}" placeholder="Folder name">`;
  section.appendChild(header);
  noteList.appendChild(section);

  const input = header.querySelector("input");
  const finish = () => finishFolderEdit(input.value, folder?.id || null);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish();
    } else if (event.key === "Escape") {
      event.preventDefault();
      editingFolderId = null;
      isCreatingFolder = false;
      renderNoteList(searchInput.value);
    }
  });
  input.addEventListener("blur", finish);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
}

function finishFolderEdit(rawName, folderId) {
  if (!isCreatingFolder && editingFolderId === null) return;
  const name = normalizeFolderName(rawName);
  if (!name) {
    if (folderId) showNotification("Folder name cannot be empty");
    editingFolderId = null;
    isCreatingFolder = false;
    renderNoteList(searchInput.value);
    return;
  }
  if (!isFolderNameAvailable(folders, name, folderId)) {
    showNotification(isReservedFolderName(name)
      ? "That folder name is reserved by the sidebar"
      : "A folder with that name already exists");
    queueMicrotask(() => noteList.querySelector(".note-folder-input")?.focus());
    return;
  }

  if (folderId) {
    folders = folders.map((folder) => folder.id === folderId ? { ...folder, name } : folder);
    showNotification("Folder renamed");
  } else {
    folders = [...folders, {
      id: "folder_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
      name
    }];
    showNotification("Folder created");
  }
  editingFolderId = null;
  isCreatingFolder = false;
  syncStructure();
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
}

function startFolderCreation() {
  editingFolderId = null;
  isCreatingFolder = true;
  renderNoteList(searchInput.value);
}

function startFolderRename(folderId) {
  if (!folders.some((folder) => folder.id === folderId)) return;
  isCreatingFolder = false;
  editingFolderId = folderId;
  if (collapsedFolderIds.delete(folderId)) persistCollapsedFolders();
  renderNoteList(searchInput.value);
}

function deleteFolder(folderId) {
  const folder = folders.find((candidate) => candidate.id === folderId);
  if (!folder) return;
  const movedCount = notes.filter((note) => note.folderId === folderId).length;
  ({ folders, notes } = removeFolder(folders, notes, folderId));
  collapsedFolderIds.delete(folderId);
  persistCollapsedFolders();
  syncStructure();
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  showNotification(movedCount === 0
    ? `Deleted folder “${folder.name}”`
    : `Deleted folder “${folder.name}”; moved ${movedCount} note${movedCount === 1 ? "" : "s"} to the top level`);
}

function moveNoteToFolder(noteId, folderId) {
  const noteIndex = notes.findIndex((note) => note.id === noteId);
  if (noteIndex === -1) return;
  const destinationId = validFolderId(folderId, folders);
  const updatedNote = { ...notes[noteIndex], folderId: destinationId, isPinned: false };
  const remaining = notes.filter((_, index) => index !== noteIndex);
  const destinationNotes = remaining.filter((note) => (
    !isNotePinned(note) && validFolderId(note.folderId, folders) === destinationId
  ));
  const lastDestination = destinationNotes.at(-1);
  if (lastDestination) {
    const insertIndex = remaining.findIndex((note) => note.id === lastDestination.id) + 1;
    notes = [...remaining.slice(0, insertIndex), updatedNote, ...remaining.slice(insertIndex)];
  } else {
    notes = insertNoteBelowPinned(remaining, updatedNote);
  }
  if (collapsedFolderIds.delete(destinationId || UNFILED_SECTION_ID)) persistCollapsedFolders();
  syncStructure();
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  const folderName = folders.find((folder) => folder.id === destinationId)?.name || "the top level";
  showNotification(`Moved note to ${folderName}`);
}

function attachFolderDrag(header, folder) {
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("input")) return;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let hasDragged = false;
    let hasPointerCapture = false;
    let avatar = null;
    let targetHeader = null;

    function onPointerMove(moveEvent) {
      if (!hasDragged && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 4) {
        hasDragged = true;
        try {
          header.setPointerCapture(pointerId);
          hasPointerCapture = true;
        } catch (error) {}
        header.dataset.justDragged = "true";
        header.classList.add("dragging");
        avatar = header.cloneNode(true);
        avatar.className = "note-folder-header drag-avatar";
        avatar.style.width = `${header.offsetWidth}px`;
        document.body.appendChild(avatar);
      }
      if (!hasDragged || !avatar) return;
      avatar.style.left = `${moveEvent.clientX - 18}px`;
      avatar.style.top = `${moveEvent.clientY - 14}px`;
      avatar.style.display = "none";
      const below = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      avatar.style.display = "flex";
      const candidate = below?.closest(".note-folder-header[data-user-folder='true']");
      document.querySelectorAll(".note-folder-header").forEach((element) => element.classList.remove("drag-over-folder"));
      targetHeader = candidate && candidate !== header ? candidate : null;
      targetHeader?.classList.add("drag-over-folder");
    }

    function cleanupPointerDrag() {
      if (hasPointerCapture) {
        try { header.releasePointerCapture(pointerId); } catch (error) {}
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      avatar?.remove();
      avatar = null;
      header.classList.remove("dragging");
      setTimeout(() => delete header.dataset.justDragged, 0);
      document.querySelectorAll(".note-folder-header").forEach((element) => element.classList.remove("drag-over-folder"));
    }

    function onPointerCancel() {
      cleanupPointerDrag();
    }

    function onPointerUp() {
      cleanupPointerDrag();
      if (!hasDragged || !targetHeader) return;
      const fromIndex = folders.findIndex((candidate) => candidate.id === folder.id);
      const targetIndex = folders.findIndex((candidate) => candidate.id === targetHeader.dataset.sectionId);
      if (fromIndex === -1 || targetIndex === -1) return;
      const updated = [...folders];
      const [dragged] = updated.splice(fromIndex, 1);
      const adjustedTarget = updated.findIndex((candidate) => candidate.id === targetHeader.dataset.sectionId);
      updated.splice(adjustedTarget + (fromIndex < targetIndex ? 1 : 0), 0, dragged);
      folders = updated;
      syncStructure();
      renderNoteList(searchInput.value);
      populateSecondaryNoteSelect();
      showNotification("Folders reordered");
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  });
}

function renderNoteSection({ id, name, sectionNotes, folder = null, acceptNotes = false }, filterActive) {
  const collapsed = !filterActive && collapsedFolderIds.has(id);
  const section = document.createElement("li");
  section.className = `note-folder-section${collapsed ? " collapsed" : ""}`;
  section.dataset.sectionId = id;

  const header = document.createElement("div");
  header.className = "note-folder-header";
  header.dataset.sectionId = id;
  header.dataset.acceptNotes = String(acceptNotes);
  header.dataset.userFolder = String(Boolean(folder));
  header.innerHTML = `<button class="note-folder-toggle" type="button" aria-expanded="${String(!collapsed)}" aria-label="${collapsed ? "Expand" : "Collapse"} ${escapeHTML(name)}">
      <span class="note-folder-chevron" aria-hidden="true">▾</span>
      ${folderIconMarkup()}
      <span class="note-folder-name">${escapeHTML(name)}</span>
    </button>
    <span class="note-folder-count" aria-label="${sectionNotes.length} ${sectionNotes.length === 1 ? "note" : "notes"}">${sectionNotes.length}</span>`;
  header.querySelector("button").addEventListener("click", () => {
    if (header.dataset.justDragged === "true") {
      delete header.dataset.justDragged;
      return;
    }
    toggleFolderCollapsed(id);
  });
  if (folder) {
    header.addEventListener("contextmenu", (event) => {
      event.stopPropagation();
      showContextMenu(event, null, folder.id);
    });
    attachFolderDrag(header, folder);
  }
  section.appendChild(header);

  const sectionList = document.createElement("ul");
  sectionList.className = "note-folder-notes";
  sectionList.setAttribute("aria-label", `${name} notes`);
  sectionNotes.forEach((note) => sectionList.appendChild(createNoteListItem(note)));
  section.appendChild(sectionList);
  noteList.appendChild(section);
}

function renderNoteList(filter = "") {
  noteList.innerHTML = "";
  const query = filter.trim().toLocaleLowerCase();
  const filteredNotes = notes.filter((note) => (
    !query || note.title.toLocaleLowerCase().includes(query) || note.content.toLocaleLowerCase().includes(query)
  ));

  const pinnedNotes = filteredNotes.filter(isNotePinned);
  pinnedNotes.forEach((note) => noteList.appendChild(createNoteListItem(note)));
  if (pinnedNotes.length > 0) {
    const divider = document.createElement("li");
    divider.className = "pinned-notes-divider";
    divider.setAttribute("aria-hidden", "true");
    noteList.appendChild(divider);
  }

  if (isCreatingFolder) renderFolderEditor();

  let renderedFolderCount = 0;
  folders.forEach((folder) => {
    if (editingFolderId === folder.id) {
      renderFolderEditor(folder);
      renderedFolderCount += 1;
      return;
    }
    const sectionNotes = filteredNotes.filter((note) => (
      !isNotePinned(note) && validFolderId(note.folderId, folders) === folder.id
    ));
    if (query && sectionNotes.length === 0) return;
    renderNoteSection({ id: folder.id, name: folder.name, sectionNotes, folder, acceptNotes: true }, Boolean(query));
    renderedFolderCount += 1;
  });

  const topLevelNotes = filteredNotes.filter((note) => (
    !isNotePinned(note) && validFolderId(note.folderId, folders) === null
  ));
  if (renderedFolderCount > 0 && topLevelNotes.length > 0) {
    const divider = document.createElement("li");
    divider.className = "top-level-notes-divider";
    divider.setAttribute("aria-hidden", "true");
    noteList.appendChild(divider);
  }
  topLevelNotes.forEach((note) => noteList.appendChild(createNoteListItem(note)));
}

function setSaveFailedState() {
  saveStatus.textContent = "Save failed";
  saveStatus.title = "Sodilaud could not persist the latest changes";
  saveStatus.classList.add("unsaved");
}

// Sends every unsent change. Rust has already written everything it accepted.
async function flushPendingSaves() {
  flushTitleSync();
  const [text, structure] = await Promise.all([noteSync.flush(), structureQueue]);
  return text && structure !== false && !structureFailed;
}

// The panel is never closed, only hidden, so its page keeps running; a quit is
// the one time it must finish saving. Rust waits for every window's answer.
async function registerQuitHandler() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;

  let quitting = false;
  try {
    await listen("sodilaud-quit-requested", async () => {
      if (quitting) return;
      quitting = true;
      let saved = false;
      try {
        saved = await flushPendingSaves();
        if (!saved) {
          setSaveFailedState();
          showNotification("Could not save the latest changes; quit cancelled");
        }
      } catch (error) {
        console.error("Failed to save before quitting", error);
        showNotification("Could not save the latest changes; quit cancelled");
      } finally {
        quitting = false;
      }
      try {
        await invoke("quit_window_done", { ok: saved });
      } catch (error) {
        console.error("Failed to quit Sodilaud", error);
        showNotification("Could not quit Sodilaud");
      }
    });
    // Until this runs, Rust quits without asking this window to save first.
    await invoke("quit_handler_ready");
  } catch (error) {
    console.error("Failed to register the quit handler", error);
  }
}

// ----------------------------------------------------
// UI Logic: Word counts, auto-saves, live previews
// ----------------------------------------------------
function handleEditorInput(text) {
  const activeNote = notes.find(n => n.id === activeNoteId);
  if (!activeNote) return;

  activeNote.content = text;
  activeNote.updatedAt = Date.now();
  scheduleNoteComparisonRefresh();
  if (isFindBarOpen) {
    runFind({ preserveActive: true, selectActive: false });
  }

  // Rust derives the title too; showing it now keeps the header in step.
  if (!activeNote.isTitleLocked) {
    const newTitle = autoTitle(text);
    if (activeNote.title !== newTitle) {
      activeNote.title = newTitle;
      noteTitleInput.value = newTitle;
    }
  }

  // The collab client sends the change; this only shows it is on its way.
  triggerSavingState();
  scheduleNoteListRender();

  // Live markdown compilation
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updateMarkdownPreview();
  }, 150);
}

function handleTitleInput() {
  const activeNote = notes.find(n => n.id === activeNoteId);
  if (!activeNote) return;

  activeNote.title = noteTitleInput.value.trim() || UNTITLED_TITLE;
  activeNote.isTitleLocked = true; // User edited manually, lock auto-renaming
  activeNote.updatedAt = Date.now();

  if (isFindResultsOpen && isFindAllNotesMode) {
    renderFindResults();
  }

  triggerSavingState();
  scheduleNoteListRender();
  scheduleTitleSync();
}

function triggerSavingState() {
  saveStatus.textContent = "Saving...";
  saveStatus.title = "Sodilaud is saving the latest changes";
  saveStatus.classList.add("unsaved");
}

function setSavedState() {
  if (!workspaceInfo.isDefault) {
    saveStatus.textContent = `Saved (${workspaceInfo.name})`;
    saveStatus.title = `Workspace: ${workspaceInfo.path}`;
  } else {
    saveStatus.textContent = "Saved";
    saveStatus.title = "Saved to Sodilaud's own workspace";
  }
  saveStatus.classList.remove("unsaved");
}

function renderPreviewHunks(container, editor) {
  renderHunkWidgets(container, {
    hljs: appearance.syntaxHighlighting ? window.hljs : null,
    onToggleReviewed: (target, reviewed) => setHunkReviewed(editor.view, target, reviewed)
  });
}

function updateMarkdownPreview() {
  if (currentLayoutMode !== "reading" || isSplitNoteMode) return; // don't render if not visible or in dual-note split mode

  const rawText = primaryEditor.getText();
  
  if (window.marked) {
    try {
      let html = "";
      if (typeof window.marked.parse === "function") {
        html = renderMarkdown(rawText, "*Empty scratchpad*");
      } else if (typeof window.marked === "function") {
        html = sanitizeMarkdownHtml(window.marked(rawText || "*Empty scratchpad*"));
      } else {
        throw new Error("window.marked is neither a function nor contains a parse function");
      }
      markdownPreview.innerHTML = html;
      renderPreviewHunks(markdownPreview, primaryEditor);
      highlightPreviewCode(markdownPreview, window.hljs, appearance.syntaxHighlighting);
      mermaid.renderBlocks(markdownPreview);
    } catch (e) {
      console.error("Marked parser error:", e);
      markdownPreview.innerHTML = `<div style="color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem;">
        <strong>Markdown Parsing Error:</strong> ${escapeHTML(e.message)}
      </div>` + escapeHTML(rawText).replace(/\n/g, "<br>").replace(/ /g, "&nbsp;");
    }
  } else {
    // Fallback if marked is offline / missing - render as plaintext with line breaks preserved
    console.warn("window.marked is not defined! Rendering as plain text.");
    markdownPreview.innerHTML = `<div style="color: #eab308; border: 1px solid rgba(234, 179, 8, 0.2); background: rgba(234, 179, 8, 0.05); padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 0.9rem;">
      <strong>Notice:</strong> Markdown parser not loaded. Displaying as formatted text.
    </div>` + escapeHTML(rawText).replace(/\n/g, "<br>").replace(/  /g, "&nbsp;&nbsp;");
  }

  updatePreviewHighlights();
}

// ----------------------------------------------------
// UI Layout Modes (Live, Source, Reading, Focus)
// ----------------------------------------------------
function setLayoutMode(value, { persist = true } = {}) {
  const mode = normalizeLayoutMode(value);
  currentLayoutMode = mode;

  appContainer.classList.remove("mode-live", "mode-source", "mode-reading");
  appContainer.classList.add(`mode-${mode}`);
  for (const [buttonMode, button] of Object.entries(layoutModeButtons)) {
    button.classList.toggle("active", buttonMode === mode);
    button.setAttribute("aria-pressed", String(buttonMode === mode));
  }

  primaryEditor.setMode(editorModeFor(mode));
  secondaryEditor.setMode(editorModeFor(mode));
  setFormatControlsEnabled(mode !== "reading");
  document.getElementById("comment-btn").disabled = mode === "reading";
  comments.render();
  if (mode === "reading") updateMarkdownPreview();

  if (persist) localStorage.setItem("sodilaud_layout_mode", mode);
}

// ----------------------------------------------------
// Formatting toolbar
// ----------------------------------------------------
function applyToolbarFormat(actionId) {
  if (currentLayoutMode === "reading") return;
  const editor = isSplitNoteMode && activePane === "secondary" ? secondaryEditor : primaryEditor;
  runFormatAction(editor.view, actionId);
  editor.focus();
}

const formatToolbar = createFormatToolbar({
  document,
  applyFormat: applyToolbarFormat,
  onMenuOpen: () => toggleActionsDropdown(false),
  observe: [".topbar", ".topbar-right", ".layout-controls"]
});
const closeFormatMenus = (except) => formatToolbar.closeMenus(except);
const setFormatControlsEnabled = (enabled) => formatToolbar.setEnabled(enabled);

// Another window changed a shared preference: re-read and apply it here.
function followPreferenceChange(key) {
  if (appearance.reload(key)) return;
  if (key === "sodilaud_active_theme" || key === "sodilaud_custom_themes" || key === "color-scheme") {
    themes.load();
  } else if (key === "sodilaud_layout_mode") {
    setLayoutMode(normalizeLayoutMode(localStorage.getItem("sodilaud_layout_mode")), { persist: false });
  }
}

// Ctrl+Cmd+S on macOS; Ctrl+Alt+S elsewhere, since Ctrl is already Mod there.
// Off macOS only event.key is trusted: AltGr reports Ctrl+Alt, and AltGr+S types
// a character on some layouts.
function isSidebarShortcut(event) {
  if (!event.ctrlKey || event.shiftKey) return false;
  if (isMacLikePlatform(navigator)) {
    return event.metaKey && !event.altKey && (event.code === "KeyS" || event.key.toLowerCase() === "s");
  }
  return event.altKey && !event.metaKey && event.key.toLowerCase() === "s";
}

function toggleSidebar() {
  sidebar.classList.toggle("collapsed");
  toggleSidebarBtn.setAttribute("aria-expanded", String(!sidebar.classList.contains("collapsed")));
}

function toggleFocusMode() {
  isFocusMode = !isFocusMode;
  focusBtn.setAttribute("aria-pressed", String(isFocusMode));
  if (isFocusMode) {
    appContainer.classList.add("focus-mode");
    sidebar.classList.add("collapsed");
    toggleSidebarBtn.setAttribute("aria-expanded", "false");
  } else {
    appContainer.classList.remove("focus-mode");
    sidebar.classList.remove("collapsed");
    toggleSidebarBtn.setAttribute("aria-expanded", "true");
  }
}

// ----------------------------------------------------
// Sodilaud menu actions
// ----------------------------------------------------
function toggleActionsDropdown(show) {
  if (show === undefined) {
    actionsDropdown.classList.toggle("show");
  } else if (show) {
    actionsDropdown.classList.add("show");
  } else {
    actionsDropdown.classList.remove("show");
  }
  actionsBtn.setAttribute("aria-expanded", String(actionsDropdown.classList.contains("show")));
}

function copyMarkdownToClipboard() {
  const text = primaryEditor.getText();
  navigator.clipboard.writeText(text).then(() => {
    showNotification("Markdown copied to clipboard!");
  }).catch(err => {
    console.error("Failed to copy", err);
  });
}

async function renderedHtmlForCopy() {
  if (currentLayoutMode === "reading") {
    await mermaid.renderBlocks(markdownPreview);
    const copy = markdownPreview.cloneNode(true);
    exportHunks(copy, window.hljs);
    return copy.innerHTML;
  }
  const container = document.createElement("div");
  container.innerHTML = renderMarkdown(primaryEditor.getText());
  await mermaid.renderBlocks(container);
  exportHunks(container, window.hljs);
  return container.innerHTML;
}

function copyHtmlToClipboard() {
  renderedHtmlForCopy().then(html => navigator.clipboard.writeText(html)).then(() => {
    showNotification("HTML preview copied to clipboard!");
  }).catch(err => {
    console.error("Failed to copy", err);
  });
}

function exportAsMarkdownFile() {
  const activeNote = notes.find(n => n.id === activeNoteId);
  if (!activeNote) return;

  const content = activeNote.content;
  const fileName = activeNote.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".md";
  
  if (window.__TAURI__) {
    // Show a saving state
    saveStatus.textContent = "Exporting...";
    invoke("save_file_native", { content: content, defaultName: fileName })
      .then((path) => {
        showNotification("Saved successfully");
      })
      .catch((err) => {
        if (err !== "Cancelled") {
          showNotification("Export failed: " + err);
        } else {
          setSavedState(); // Restore Saved indicator
        }
      });
  } else {
    // Safe web-based blob download fallback compatible across systems
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8;" });
    const link = document.createElement("a");
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", fileName);
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showNotification(`Exported as ${fileName}`);
    }
  }
}

function importFile() {
  if (window.__TAURI__) {
    invoke("import_file_native")
      .then((file) => {
        if (file) {
          createNote(file.title, file.content);
          showNotification("Imported: " + file.title);
        }
      })
      .catch((err) => {
        alert("Unsupported File Format: " + err);
        showNotification("Import failed");
      });
  } else {
    // Safe web-based file reader fallback compatible across browser environments
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      const reader = new FileReader();
      reader.onload = (evt) => {
        const lastDot = file.name.lastIndexOf('.');
        const title = (lastDot > 0) ? file.name.substring(0, lastDot) : file.name;
        createNote(title, evt.target.result);
        showNotification("Imported: " + title);
      };
      reader.onerror = () => {
        alert(`Unsupported File Format: The file "${file.name}" could not be read as text.`);
      };
      reader.readAsText(file);
    };
    input.click();
  }
}

function showNotification(msg) {
  const sequence = ++notificationSequence;
  const restoreState = activeNotification && saveStatus.textContent === activeNotification.message
    ? activeNotification.restoreState
    : {
        textContent: saveStatus.textContent,
        className: saveStatus.className,
        title: saveStatus.title
      };

  activeNotification = { sequence, message: msg, restoreState };
  
  saveStatus.textContent = msg;
  saveStatus.className = ""; // clear unsaved indicator during alert
  
  setTimeout(() => {
    dismissNotification(msg, sequence);
  }, 2000);
}

function dismissNotification(message, sequence = null) {
  if (!activeNotification || activeNotification.message !== message) return;
  if (sequence !== null && activeNotification.sequence !== sequence) return;

  const { restoreState } = activeNotification;
  activeNotification = null;
  notificationSequence += 1;

  if (saveStatus.textContent !== message) return;
  saveStatus.textContent = restoreState.textContent;
  saveStatus.className = restoreState.className;
  saveStatus.title = restoreState.title;
}

// ----------------------------------------------------
// Event Listeners
// ----------------------------------------------------
function attachEventListeners() {
  noteTitleInput.addEventListener("input", handleTitleInput);

  // Sidebar toggle
  toggleSidebarBtn.addEventListener("click", toggleSidebar);

  // New note button
  newNoteBtn.addEventListener("click", () => createNote());

  // Double-clicking the empty space below the list creates a scratchpad, the way
  // double-clicking empty tab-bar space does in the editors people arrive from.
  // Only the container and the list itself are empty space: every other element
  // under the pointer is a note, a folder header, or the folder-name input, and
  // those own their double-clicks (selecting a folder name to rename it, say).
  noteListContainer.addEventListener("dblclick", (event) => {
    if (event.target !== noteListContainer && event.target !== noteList) return;
    createNote();
  });
  newFolderBtn.addEventListener("click", startFolderCreation);

  // Search filter
  searchInput.addEventListener("input", (e) => {
    renderNoteList(e.target.value);
  });

  // Layout mode controls
  for (const [mode, button] of Object.entries(layoutModeButtons)) {
    button.addEventListener("click", () => {
      setLayoutMode(mode);
      broadcastPreference(window, "sodilaud_layout_mode");
    });
  }

  // Markdown preview links
  markdownPreview.addEventListener("click", handlePreviewLinkClick);
  secondaryMarkdownPreview.addEventListener("click", handlePreviewLinkClick);

  // Focus toggle
  focusBtn.addEventListener("click", toggleFocusMode);

  // Help and settings live in the main window.
  helpBtn.addEventListener("click", () => showMainWindow("help"));
  settingsMenuBtn.addEventListener("click", () => {
    toggleActionsDropdown(false);
    showMainWindow("settings");
  });
  quickNotesCloseBtn.addEventListener("click", hideQuickNotes);
  quickNotesDragRegion.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    invoke("qn_start_drag").catch(() => {});
  });

  // Split Note toggle
  splitNoteBtn.addEventListener("click", () => toggleSplitNoteMode());
  compareNotesBtn.addEventListener("click", () => setCompareMode());
  closeSecondaryBtn.addEventListener("click", () => toggleSplitNoteMode(false));
  secondaryNoteSelect.addEventListener("change", (e) => {
    secondaryNoteId = e.target.value;
    loadSecondaryNote();
  });
  secondaryNoteTitle.addEventListener("input", handleSecondaryTitleInput);

  // Actions menu
  actionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFormatMenus();
    toggleActionsDropdown();
  });

  document.addEventListener("click", () => {
    toggleActionsDropdown(false);
    closeFormatMenus();
  });

  formatToolbar.attach();

  appearance.attachControls();

    copyMarkdownBtn.addEventListener("click", copyMarkdownToClipboard);
  copyHtmlBtn.addEventListener("click", copyHtmlToClipboard);
  importBtn.addEventListener("click", importFile);
  exportBtn.addEventListener("click", exportAsMarkdownFile);
  dbConnectBtn.addEventListener("click", connectDatabase);
  dbDisconnectBtn.addEventListener("click", disconnectDatabase);
  agentAccess.attach();

  // Custom Context Menu Events
  document.addEventListener("contextmenu", showContextMenu);
  document.addEventListener("click", hideContextMenu);
  window.addEventListener("blur", hideContextMenu);

  ctxCutBtn.addEventListener("click", handleContextCut);
  ctxCopyBtn.addEventListener("click", handleContextCopy);
  ctxPasteBtn.addEventListener("click", handleContextPaste);
  ctxInsertBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = ctxInsertGroup.classList.toggle("open");
    ctxInsertBtn.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) ctxInsertMenu.querySelector("button")?.focus();
  });
  ctxInsertMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-markdown-template]");
    if (item) handleContextInsert(item.dataset.markdownTemplate);
  });
  ctxInsertMenu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    ctxInsertGroup.classList.remove("open");
    ctxInsertBtn.setAttribute("aria-expanded", "false");
    ctxInsertBtn.focus();
  });
  ctxSelectAllBtn.addEventListener("click", handleContextSelectAll);
  ctxFindBtn.addEventListener("click", handleContextFind);
  ctxCommentBtn.addEventListener("click", () => {
    const editor = contextMenuEditor;
    hideContextMenu();
    if (!editor) return;
    setActivePane(editor === secondaryEditor ? "secondary" : "primary");
    startComment(editor.view);
  });
  document.getElementById("comment-btn").addEventListener("click", () => comments.start());
  document.getElementById("comments-count-btn").addEventListener("click", () => comments.toggle());
  ctxOpenSideBtn.addEventListener("click", () => {
    hideContextMenu();
    if (contextMenuNoteId) {
      openNoteInSecondaryPane(contextMenuNoteId);
    }
  });
  ctxPinBtn.addEventListener("click", () => {
    hideContextMenu();
    if (contextMenuNoteId) {
      toggleNotePinned(contextMenuNoteId);
    }
  });
  ctxDeleteNoteBtn.addEventListener("click", () => {
    const noteId = contextMenuNoteId;
    hideContextMenu();
    if (noteId) deleteNote(noteId);
  });
  ctxMoveUpBtn.addEventListener("click", () => {
    hideContextMenu();
    if (contextMenuNoteId) {
      moveNoteUp(contextMenuNoteId);
    }
  });
  ctxMoveDownBtn.addEventListener("click", () => {
    hideContextMenu();
    if (contextMenuNoteId) {
      moveNoteDown(contextMenuNoteId);
    }
  });
  ctxMoveFolderBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = ctxMoveFolderGroup.classList.toggle("open");
    ctxMoveFolderBtn.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) ctxMoveFolderMenu.querySelector("button:not([disabled])")?.focus();
  });
  ctxMoveFolderMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-folder-id]");
    if (!item || item.disabled || !contextMenuNoteId) return;
    const folderId = item.dataset.folderId === UNFILED_SECTION_ID ? null : item.dataset.folderId;
    hideContextMenu();
    moveNoteToFolder(contextMenuNoteId, folderId);
  });
  ctxMoveFolderMenu.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    ctxMoveFolderGroup.classList.remove("open");
    ctxMoveFolderBtn.setAttribute("aria-expanded", "false");
    ctxMoveFolderBtn.focus();
  });
  ctxFolderNewNoteBtn.addEventListener("click", () => {
    const folderId = contextMenuFolderId;
    hideContextMenu();
    if (folderId) createNote("Untitled Scratchpad", "", folderId);
  });
  ctxFolderRenameBtn.addEventListener("click", () => {
    const folderId = contextMenuFolderId;
    hideContextMenu();
    if (folderId) startFolderRename(folderId);
  });
  ctxFolderMoveUpBtn.addEventListener("click", () => {
    const folderId = contextMenuFolderId;
    hideContextMenu();
    if (!folderId) return;
    folders = moveFolder(folders, folderId, -1);
    syncStructure();
    renderNoteList(searchInput.value);
    populateSecondaryNoteSelect();
    showNotification("Folder moved up");
  });
  ctxFolderMoveDownBtn.addEventListener("click", () => {
    const folderId = contextMenuFolderId;
    hideContextMenu();
    if (!folderId) return;
    folders = moveFolder(folders, folderId, 1);
    syncStructure();
    renderNoteList(searchInput.value);
    populateSecondaryNoteSelect();
    showNotification("Folder moved down");
  });
  ctxFolderDeleteBtn.addEventListener("click", () => {
    const folderId = contextMenuFolderId;
    hideContextMenu();
    if (folderId) deleteFolder(folderId);
  });

  // Find & Replace Widget events
  findInput.addEventListener("input", runFind);
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrev();
      } else {
        findNext();
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideFindBar();
    }
  });
  findPrevBtn.addEventListener("click", findPrev);
  findNextBtn.addEventListener("click", findNext);
  findCloseBtn.addEventListener("click", hideFindBar);
  findResultsToggleBtn.addEventListener("click", () => toggleFindResults());
  findResultsCloseBtn.addEventListener("click", () => {
    toggleFindResults(false);
    findInput.focus();
  });
  findAllNotesToggleBtn.addEventListener("click", toggleFindAllNotesMode);
  findResultsList.addEventListener("click", handleFindResultClick);
  findResultsList.addEventListener("keydown", handleFindResultKeydown);
  findToggleReplaceBtn.addEventListener("click", () => toggleReplace());
  findCaseToggleBtn.addEventListener("click", toggleMatchCaseMode);
  findExactToggleBtn.addEventListener("click", toggleExactMatchMode);
  findRegexToggleBtn.addEventListener("click", toggleRegexMode);
  
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceOne();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideFindBar();
    }
  });
  replaceOneBtn.addEventListener("click", replaceOne);
  replaceAllBtn.addEventListener("click", replaceAll);

  // Shortcuts
  document.addEventListener("keydown", (e) => {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (agentAccess.isModalOpen() && e.key === "Tab" && !isMeta && !e.altKey) {
      agentAccess.handleKeydown(e);
      return;
    }

    if (appearance.handleZoomShortcut(e)) return;

        // Disable browser inspect shortcuts and accidental page reloads (F12, Cmd+Opt+I, Ctrl+Shift+I, Cmd+R)
    if (
      e.key === "F12" ||
      (isMeta && e.altKey && e.key.toLowerCase() === "i") ||
      (isMeta && isShift && e.key.toLowerCase() === "i") ||
      (isMeta && e.key.toLowerCase() === "r")
    ) {
      e.preventDefault();
    }

    if (isSidebarShortcut(e)) {
      e.preventDefault();
      toggleSidebar();
    }
    if (isMeta && e.key === "n") {
      e.preventDefault();
      createNote();
    }
    if (isMeta && e.key === "f") {
      e.preventDefault();
      toggleFindBar();
    }
    if (isMeta && e.key === "h") {
      e.preventDefault();
      toggleFindBar(true);
    }
    if (e.altKey && !isMeta && e.key.toLowerCase() === "r" && isFindBarOpen) {
      e.preventDefault();
      toggleRegexMode();
    }
    if (e.altKey && !isMeta && e.key.toLowerCase() === "c" && isFindBarOpen) {
      e.preventDefault();
      toggleMatchCaseMode();
    }
    if (e.altKey && !isMeta && e.key.toLowerCase() === "w" && isFindBarOpen) {
      e.preventDefault();
      toggleExactMatchMode();
    }
    if (isMeta && (e.key === "\\" || e.key === "|")) {
      e.preventDefault();
      toggleSplitNoteMode();
    }
    if ((isMeta && (e.key === "/" || e.key === "?")) || e.key === "F1") {
      e.preventDefault();
      showMainWindow("help");
    }
    // Cmd+W hides the panel, like closing any window; the notes stay loaded.
    if (isMeta && !isShift && !e.altKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      hideQuickNotes();
    }
    if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      moveNoteUp();
    }
    if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      moveNoteDown();
    }
    if (isMeta && isShift && e.key.toLowerCase() === "f") {
      e.preventDefault();
      toggleFocusMode();
    }
    if (e.key === "Escape") {
      if (closeFormatMenus()) {
        e.preventDefault();
      } else if (agentAccess.handleKeydown(e)) {
        e.preventDefault();
      } else if (isFindBarOpen) {
        e.preventDefault();
        hideFindBar();
      } else if (isFocusMode) {
        toggleFocusMode();
      }
    }
  });
}

// ----------------------------------------------------
// Utilities
// ----------------------------------------------------
// Sanitized external links carry target="_blank", but the desktop webview has
// no default handling for it, so clicking one would otherwise do nothing. Send
// external links to the user's browser and scroll to in-note anchors. Notes
// have no folder, so links to sibling files stay put.
function handlePreviewLinkClick(event) {
  const link = event.target.closest("a[href]");
  if (!link) return;

  event.preventDefault();
  const action = resolveLinkAction(link.getAttribute("href"));
  if (action.kind === "anchor") scrollToReadingAnchor(event.currentTarget, action.fragment);
  else openExternalHref(link.getAttribute("href"));
}

// Live-preview links arrive unfiltered (autolinks carry raw text), so they take
// the same resolveLinkAction gate as sanitized preview links.
function openExternalHref(href) {
  const action = resolveLinkAction(href);
  if (action.kind !== "external") return;

  if (!window.__TAURI__) {
    window.open(action.url, "_blank", "noopener,noreferrer");
    return;
  }

  // Rust shows the real destination in a native dialog before the browser opens it.
  invoke("confirm_and_open_url", { url: action.url }).catch(error => {
    console.error("Failed to open a link in the browser", error);
    showNotification("Could not open that link");
  });
}


function loadCollapsedFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || "[]");
    if (Array.isArray(saved)) {
      saved.filter((id) => typeof id === "string").forEach((id) => collapsedFolderIds.add(id));
    }
  } catch (error) {
    console.error("Failed to load collapsed folders", error);
  }
}

function updateDbUiState() {
  const connected = !workspaceInfo.isDefault;
  dbConnectBtn.style.display = connected ? "none" : "block";
  dbDisconnectBtn.style.display = connected ? "block" : "none";
  workspaceMenuValue.textContent = connected ? workspaceInfo.name : "Local notes";
  workspaceMenuValue.title = connected ? workspaceInfo.path : "Notes kept in Sodilaud's own workspace";
  refreshSaveStatus();
}

// Compaction only scrubs free pages left from before secure_delete; the
// workspace stays usable without it, so a failure is logged, not surfaced.
async function reclaimWorkspaceSpace() {
  try {
    await invoke("notes_vacuum");
  } catch (err) {
    console.error("Failed to reclaim workspace space", err);
  }
}

async function switchWorkspace(operation) {
  if (isWorkspaceSwitching) return;
  isWorkspaceSwitching = true;
  trashUi.close();
  try {
    await operation();
  } finally {
    isWorkspaceSwitching = false;
  }
}

function connectDatabase() { return switchWorkspace(connectDatabaseImpl); }
function disconnectDatabase() { return switchWorkspace(disconnectDatabaseImpl); }

async function connectDatabaseImpl() {
  if (!window.__TAURI__) {
    showNotification("Workspaces are only available in the desktop app");
    return;
  }
  if (!await flushPendingSaves()) {
    showNotification("Could not save your notes; workspace not opened");
    return;
  }

  let path;
  try {
    path = await invoke("select_db_file");
  } catch (err) {
    showNotification("Database selection failed: " + err);
    return;
  }
  if (!path) return;

  // Rust copies the open collection into a new, empty workspace.
  try {
    applyWorkspaceState(await invoke("notes_connect", { dbPath: path }));
  } catch (err) {
    console.error("Failed to open workspace", err);
    showNotification("Could not open workspace; using your current notes");
    return;
  }
  await reclaimWorkspaceSpace();
  if (notes.length === 0) createNote();
  showNotification("Workspace connected!");
}

async function disconnectDatabaseImpl() {
  if (!await flushPendingSaves()) {
    showNotification("Could not save workspace; disconnect cancelled");
    return;
  }
  await reclaimWorkspaceSpace();
  try {
    applyWorkspaceState(await invoke("notes_disconnect"));
  } catch (err) {
    console.error("Failed to disconnect the workspace", err);
    showNotification("Could not switch back to local notes");
    return;
  }
  if (notes.length === 0) createNote();
  showNotification("Workspace disconnected; using local notes");
}

// Find & Replace Widget functions
function toggleFindBar(openReplace = false) {
  if (isFindBarOpen) {
    if (openReplace && !isReplaceOpen) {
      toggleReplace(true);
    } else if (!openReplace) {
      hideFindBar();
    }
  } else {
    isFindBarOpen = true;
    findBar.style.display = "flex";
    
    if (openReplace) {
      toggleReplace(true);
    }
    
    const { start, end } = primaryEditor.getSelection();
    const selection = primaryEditor.getText().slice(start, end);
    if (selection) {
      findInput.value = selection;
    }
    
    if (openReplace && isReplaceOpen) {
      replaceInput.focus();
      replaceInput.select();
    } else {
      findInput.focus();
      findInput.select();
    }
    runFind();
  }
}

function hideFindBar() {
  isFindBarOpen = false;
  toggleFindResults(false);
  findBar.style.display = "none";
  findMatches = [];
  activeMatchIndex = -1;
  hasInvalidFindPattern = false;
  findInput.value = "";
  replaceInput.value = "";
  toggleReplace(false);
  updateFindCount();
  updateFindHighlights();
  primaryEditor.focus();
}

function toggleReplace(forceState) {
  isReplaceOpen = typeof forceState === "boolean" ? forceState : !isReplaceOpen;
  replaceRow.style.display = isReplaceOpen ? "flex" : "none";
  findToggleReplaceBtn.classList.toggle("expanded", isReplaceOpen);
  findToggleReplaceBtn.setAttribute("aria-expanded", String(isReplaceOpen));
  if (isReplaceOpen) {
    replaceInput.focus();
  }
}

function toggleRegexMode() {
  isRegexMode = !isRegexMode;
  findRegexToggleBtn.classList.toggle("active", isRegexMode);
  findRegexToggleBtn.setAttribute("aria-pressed", String(isRegexMode));
  runFind();
}

function toggleMatchCaseMode() {
  isMatchCaseMode = !isMatchCaseMode;
  findCaseToggleBtn.classList.toggle("active", isMatchCaseMode);
  findCaseToggleBtn.setAttribute("aria-pressed", String(isMatchCaseMode));
  runFind();
}

function toggleExactMatchMode() {
  isExactMatchMode = !isExactMatchMode;
  findExactToggleBtn.classList.toggle("active", isExactMatchMode);
  findExactToggleBtn.setAttribute("aria-pressed", String(isExactMatchMode));
  runFind();
}

function getFindOptions() {
  return {
    useRegex: isRegexMode,
    matchCase: isMatchCaseMode,
    exactMatch: isExactMatchMode
  };
}

function runFind({ preserveActive = false, selectActive = true } = {}) {
  const query = findInput.value;
  const previousActiveIndex = activeMatchIndex;
  findInput.classList.remove("invalid-regex");

  const result = findTextMatches(primaryEditor.getText(), query, getFindOptions());
  findMatches = result.matches;
  hasInvalidFindPattern = result.invalidPattern;

  if (hasInvalidFindPattern) {
    activeMatchIndex = -1;
    findInput.classList.add("invalid-regex");
    updateFindCount("Invalid");
    updateFindResultsToggle();
    updateFindHighlights();
    renderFindResults();
    return;
  }

  if (findMatches.length > 0) {
    activeMatchIndex = preserveActive && previousActiveIndex >= 0
      ? Math.min(previousActiveIndex, findMatches.length - 1)
      : 0;

    if (selectActive) {
      selectMatch(activeMatchIndex, false); // Do not steal focus from search input
    } else {
      updateFindCount();
      updateFindHighlights();
      renderFindResults();
    }
  } else {
    activeMatchIndex = -1;
    updateFindCount();
    updateFindHighlights();
    renderFindResults();
  }

  updateFindResultsToggle();
}

function selectMatch(index, focusEditor = false) {
  if (index < 0 || index >= findMatches.length) return;
  activeMatchIndex = index;
  const match = findMatches[index];
  
  const editorIsVisible = currentLayoutMode !== "reading" || isSplitNoteMode;
  if (focusEditor && editorIsVisible) {
    primaryEditor.focus();
  }
  primaryEditor.setSelection(match.start, match.end, { scroll: false });
  updateCursorPositionForText(primaryEditor);

  updateFindCount();
  updateFindHighlights();
  scrollActiveMatchIntoView(match);
  renderFindResults();
}

function scrollActiveMatchIntoView(match) {
  primaryEditor.scrollToRange(match.start, match.end);

  if (currentLayoutMode === "reading" && !isSplitNoteMode) {
    const previewHighlight = markdownPreview.querySelector("mark.active-match");
    previewHighlight?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }
}

function findNext() {
  if (findMatches.length === 0) return;
  const nextIndex = (activeMatchIndex + 1) % findMatches.length;
  selectMatch(nextIndex);
}

function findPrev() {
  if (findMatches.length === 0) return;
  const prevIndex = (activeMatchIndex - 1 + findMatches.length) % findMatches.length;
  selectMatch(prevIndex);
}

function applyFindReplacement(edit) {
  primaryEditor.applyEdit(edit);
}

function replaceOne() {
  if (findMatches.length === 0 || activeMatchIndex < 0) return;
  const match = findMatches[activeMatchIndex];
  const replaceText = replaceInput.value;
  const text = primaryEditor.getText();
  
  let replacement = replaceText;
  if (isRegexMode) {
    try {
      const regex = new RegExp(findInput.value, isMatchCaseMode ? "" : "i");
      replacement = match.text.replace(regex, replaceText);
    } catch (e) {}
  }
  
  const newContent = text.substring(0, match.start) + replacement + text.substring(match.end);
  const targetIndex = activeMatchIndex;
  const selectionAfterReplacement = match.start + replacement.length;
  applyFindReplacement({
    value: newContent,
    selectionStart: selectionAfterReplacement,
    selectionEnd: selectionAfterReplacement
  });

  // The edit's input event refreshes findMatches through handleEditorInput.
  // Keep advancing from the match the user just replaced.
  if (findMatches.length > 0) {
    selectMatch(Math.min(targetIndex, findMatches.length - 1), false);
  }
}

function replaceAll() {
  if (findMatches.length === 0) return;
  const query = findInput.value;
  const replaceText = replaceInput.value;
  const text = primaryEditor.getText();
  const totalMatches = findMatches.length;
  
  let newContent = text;
  let replacementRegex = null;
  if (isRegexMode) {
    try {
      replacementRegex = new RegExp(query, isMatchCaseMode ? "" : "i");
    } catch (e) {
      return;
    }
  }

  for (let index = findMatches.length - 1; index >= 0; index -= 1) {
    const match = findMatches[index];
    const replacement = replacementRegex
      ? match.text.replace(replacementRegex, replaceText)
      : replaceText;
    newContent = newContent.substring(0, match.start) +
      replacement +
      newContent.substring(match.end);
  }

  applyFindReplacement({
    value: newContent,
    selectionStart: newContent.length,
    selectionEnd: newContent.length
  });

  showNotification(`Replaced ${totalMatches} occurrences`);
  if (findMatches.length > 0) {
    selectMatch(0, false);
  }
}

function updateFindCount(customText) {
  if (customText) {
    findCount.textContent = customText;
  } else if (findMatches.length === 0) {
    findCount.textContent = "0 of 0";
  } else {
    findCount.textContent = `${activeMatchIndex + 1} of ${findMatches.length}`;
  }
}

function updateFindResultsToggle() {
  findResultsToggleBtn.disabled = !findInput.value || hasInvalidFindPattern;
}

function toggleFindResults(forceState) {
  const shouldOpen = typeof forceState === "boolean" ? forceState : !isFindResultsOpen;
  if (shouldOpen && (!findInput.value || hasInvalidFindPattern)) return;

  if (shouldOpen && isSplitNoteMode) {
    const previousFocus = document.activeElement;
    toggleSplitNoteMode(false);
    previousFocus?.focus?.({ preventScroll: true });
  }

  isFindResultsOpen = shouldOpen;
  panesContainer.classList.toggle("find-results-mode", shouldOpen);
  findResultsPane.style.display = shouldOpen ? "flex" : "none";
  findResultsToggleBtn.classList.toggle("active", shouldOpen);
  findResultsToggleBtn.setAttribute("aria-expanded", String(shouldOpen));

  if (shouldOpen) {
    renderFindResults();
  } else {
    findResultsList.replaceChildren();
  }
}

function toggleFindAllNotesMode() {
  isFindAllNotesMode = !isFindAllNotesMode;
  findAllNotesToggleBtn.classList.toggle("active", isFindAllNotesMode);
  findAllNotesToggleBtn.setAttribute("aria-pressed", String(isFindAllNotesMode));
  renderFindResults();
}

function getFindResultEntries() {
  if (!isFindAllNotesMode) {
    const activeNote = notes.find((note) => note.id === activeNoteId);
    if (!activeNote) return [];
    return findMatches.map((match, matchIndex) => ({ activeNote, match, matchIndex }));
  }

  return notes.flatMap((note) => {
    const result = findTextMatches(note.content || "", findInput.value, getFindOptions());
    return result.matches.map((match, matchIndex) => ({
      activeNote: note,
      match,
      matchIndex
    }));
  });
}

function renderFindResults() {
  if (!isFindResultsOpen) return;

  const resultEntries = getFindResultEntries();
  const matchLabel = resultEntries.length === 1 ? "match" : "matches";
  if (isFindAllNotesMode && resultEntries.length > 0) {
    const noteCount = new Set(resultEntries.map(({ activeNote }) => activeNote.id)).size;
    const noteLabel = noteCount === 1 ? "note" : "notes";
    findResultsSummary.textContent = `${resultEntries.length} ${matchLabel} in ${noteCount} ${noteLabel}`;
  } else {
    findResultsSummary.textContent = `${resultEntries.length} ${matchLabel}`;
  }
  findResultsList.replaceChildren();

  let emptyMessage = "";
  if (!findInput.value) {
    emptyMessage = "Enter a search term to see every match.";
  } else if (hasInvalidFindPattern) {
    emptyMessage = "Fix the regular expression to show results.";
  } else if (resultEntries.length === 0) {
    emptyMessage = isFindAllNotesMode
      ? "No matches in any scratchpad."
      : "No matches in this scratchpad.";
  }

  if (emptyMessage) {
    const item = document.createElement("li");
    item.className = "find-results-empty";
    item.textContent = emptyMessage;
    findResultsList.appendChild(item);
    return;
  }

  const fragment = document.createDocumentFragment();
  const hasActiveEntry = resultEntries.some(({ activeNote, matchIndex }) =>
    activeNote.id === activeNoteId && matchIndex === activeMatchIndex
  );

  resultEntries.forEach(({ activeNote, match, matchIndex }, index) => {
    const item = document.createElement("li");
    item.className = "find-result-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "find-result-button";
    button.dataset.noteId = activeNote.id;
    button.dataset.matchIndex = String(matchIndex);
    button.dataset.matchStart = String(match.start);
    button.dataset.matchEnd = String(match.end);
    const isActive = activeNote.id === activeNoteId && matchIndex === activeMatchIndex;
    button.tabIndex = isActive || (!hasActiveEntry && index === 0) ? 0 : -1;
    const noteContext = isFindAllNotesMode ? `${activeNote.title}, ` : "";
    button.setAttribute(
      "aria-label",
      `Match ${index + 1} of ${resultEntries.length}, ${noteContext}line ${match.line}, column ${match.column}: ${match.snippet}`
    );

    if (isActive) {
      button.classList.add("active");
      button.setAttribute("aria-current", "true");
    }

    const location = document.createElement("span");
    location.className = "find-result-location";
    location.textContent = `Line ${match.line}`;
    location.title = `Line ${match.line}, column ${match.column}`;

    const snippet = document.createElement("span");
    snippet.className = "find-result-snippet";
    snippet.textContent = match.snippet;
    snippet.title = match.snippet;

    const content = document.createElement("span");
    content.className = "find-result-content";
    if (isFindAllNotesMode) {
      const noteTitle = document.createElement("span");
      noteTitle.className = "find-result-note";
      noteTitle.textContent = activeNote.title;
      noteTitle.title = activeNote.title;
      content.appendChild(noteTitle);
    }
    content.appendChild(snippet);

    button.append(location, content);
    item.appendChild(button);
    fragment.appendChild(item);
  });

  findResultsList.appendChild(fragment);
  const activeResult = findResultsList.querySelector("[aria-current='true']");
  activeResult?.scrollIntoView?.({ block: "nearest" });
}

function handleFindResultClick(event) {
  const button = event.target.closest(".find-result-button");
  if (!button) return;
  activateFindResult(button, true);
}

function activateFindResult(button, focusEditor) {
  const noteId = button.dataset.noteId;
  const matchStart = Number(button.dataset.matchStart);
  const matchEnd = Number(button.dataset.matchEnd);

  if (noteId !== activeNoteId) {
    activeNoteId = noteId;
    renderNoteList(searchInput.value);
    loadActiveNote();
  }

  const matchIndex = findMatches.findIndex(
    (match) => match.start === matchStart && match.end === matchEnd
  );
  if (matchIndex >= 0) selectMatch(matchIndex, focusEditor);
}

function handleFindResultKeydown(event) {
  const button = event.target.closest(".find-result-button");
  const buttons = [...findResultsList.querySelectorAll(".find-result-button")];
  if (!button || buttons.length === 0) return;

  const currentIndex = buttons.indexOf(button);
  let targetIndex = currentIndex;

  if (event.key === "ArrowDown") {
    targetIndex = (currentIndex + 1) % buttons.length;
  } else if (event.key === "ArrowUp") {
    targetIndex = (currentIndex - 1 + buttons.length) % buttons.length;
  } else if (event.key === "Home") {
    targetIndex = 0;
  } else if (event.key === "End") {
    targetIndex = buttons.length - 1;
  } else {
    return;
  }

  event.preventDefault();
  const target = buttons[targetIndex];
  const noteId = target.dataset.noteId;
  const matchStart = target.dataset.matchStart;
  activateFindResult(target, false);
  [...findResultsList.querySelectorAll(".find-result-button")]
    .find((result) => result.dataset.noteId === noteId && result.dataset.matchStart === matchStart)
    ?.focus();
}

function clearPreviewHighlights() {
  if (!previewHighlightsRendered) return;

  markdownPreview.querySelectorAll("mark.find-preview-match").forEach((highlight) => {
    highlight.replaceWith(document.createTextNode(highlight.textContent));
  });
  markdownPreview.normalize();
  previewHighlightsRendered = false;
}

function updatePreviewHighlights() {
  clearPreviewHighlights();

  if (
    currentLayoutMode !== "reading" ||
    isSplitNoteMode ||
    !isFindBarOpen ||
    !findInput.value ||
    hasInvalidFindPattern ||
    findMatches.length === 0
  ) {
    return;
  }

  const textNodes = [];
  const walker = document.createTreeWalker(
    markdownPreview,
    window.NodeFilter.SHOW_TEXT
  );
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  let previewMatchIndex = 0;
  textNodes.forEach((textNode) => {
    const nodeMatches = findTextMatches(
      textNode.nodeValue,
      findInput.value,
      getFindOptions()
    ).matches
      .map((match) => ({ ...match, previewIndex: previewMatchIndex++ }));

    for (let index = nodeMatches.length - 1; index >= 0; index -= 1) {
      const match = nodeMatches[index];
      textNode.splitText(match.end);
      const matchedText = textNode.splitText(match.start);
      const highlight = document.createElement("mark");

      highlight.className = "find-preview-match";
      highlight.dataset.findIndex = String(match.previewIndex);
      highlight.textContent = matchedText.nodeValue;
      if (match.previewIndex === activeMatchIndex) {
        highlight.classList.add("active-match");
      }

      matchedText.replaceWith(highlight);
      previewHighlightsRendered = true;
    }
  });
}

function updateFindHighlights() {
  updatePreviewHighlights();
  primaryEditor.setFindMatches(isFindBarOpen && findInput.value ? findMatches : [], activeMatchIndex);
}

// ----------------------------------------------------
// Custom Context Menu Logic
// ----------------------------------------------------
function setFolderContextVisibility(visible) {
  const display = visible ? "flex" : "none";
  ctxFolderNewNoteBtn.style.display = display;
  ctxFolderRenameBtn.style.display = display;
  ctxFolderMoveUpBtn.style.display = display;
  ctxFolderMoveDownBtn.style.display = display;
  ctxFolderDeleteBtn.style.display = display;
  ctxFolderDivider.style.display = visible ? "block" : "none";
}

function populateMoveFolderMenu(note) {
  ctxMoveFolderMenu.innerHTML = "";
  const destinations = [
    { id: UNFILED_SECTION_ID, name: "Top Level" },
    ...folders
  ];
  destinations.forEach((folder) => {
    const destinationId = folder.id === UNFILED_SECTION_ID ? null : folder.id;
    const button = document.createElement("button");
    button.className = "context-menu-item";
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.folderId = folder.id;
    button.textContent = folder.name;
    button.disabled = !isNotePinned(note) && validFolderId(note.folderId, folders) === destinationId;
    ctxMoveFolderMenu.appendChild(button);
  });
}

function showContextMenu(e, noteId = null, folderId = null) {
  e.preventDefault();
  let hasInsertMenu = false;
  contextMenuEditor = null;
  contextMenuFolderId = folderId;
  setFolderContextVisibility(Boolean(folderId));
  ctxDeleteNoteBtn.style.display = noteId ? "flex" : "none";
  ctxDeleteNoteDivider.style.display = noteId ? "block" : "none";
  
  if (noteId) {
    contextMenuNoteId = noteId;
    ctxOpenSideBtn.style.display = "flex";
    ctxSidebarDivider.style.display = "block";
    ctxPinBtn.style.display = "flex";
    ctxMoveUpBtn.style.display = "flex";
    ctxMoveDownBtn.style.display = "flex";
    ctxMoveFolderGroup.style.display = folders.length > 0 ? "block" : "none";
    
    const noteIndex = notes.findIndex(n => n.id === noteId);
    const note = notes[noteIndex];
    ctxPinBtn.querySelector("span").textContent = isNotePinned(note) ? "Unpin from Top" : "Pin to Top";
    ctxMoveUpBtn.disabled = !canMoveNote(notes, noteIndex, -1);
    ctxMoveDownBtn.disabled = !canMoveNote(notes, noteIndex, 1);
    populateMoveFolderMenu(note);
    
    ctxCutBtn.style.display = "none";
    ctxCopyBtn.style.display = "none";
    ctxPasteBtn.style.display = "none";
    ctxSelectAllBtn.style.display = "none";
    ctxFindBtn.style.display = "none";
    ctxCommentBtn.style.display = "none";
    ctxInsertDivider.style.display = "none";
    ctxInsertGroup.style.display = "none";
  } else if (folderId) {
    contextMenuNoteId = null;
    const folderIndex = folders.findIndex((folder) => folder.id === folderId);
    ctxFolderMoveUpBtn.disabled = folderIndex <= 0;
    ctxFolderMoveDownBtn.disabled = folderIndex === -1 || folderIndex >= folders.length - 1;

    ctxOpenSideBtn.style.display = "none";
    ctxSidebarDivider.style.display = "none";
    ctxPinBtn.style.display = "none";
    ctxMoveUpBtn.style.display = "none";
    ctxMoveDownBtn.style.display = "none";
    ctxMoveFolderGroup.style.display = "none";
    ctxCutBtn.style.display = "none";
    ctxCopyBtn.style.display = "none";
    ctxPasteBtn.style.display = "none";
    ctxSelectAllBtn.style.display = "none";
    ctxFindBtn.style.display = "none";
    ctxCommentBtn.style.display = "none";
    ctxInsertDivider.style.display = "none";
    ctxInsertGroup.style.display = "none";
  } else {
    contextMenuNoteId = null;
    contextMenuFolderId = null;
    setFolderContextVisibility(false);
    ctxOpenSideBtn.style.display = "none";
    ctxSidebarDivider.style.display = "none";
    ctxPinBtn.style.display = "none";
    ctxMoveUpBtn.style.display = "none";
    ctxMoveDownBtn.style.display = "none";
    ctxMoveFolderGroup.style.display = "none";
    
    ctxCutBtn.style.display = "flex";
    ctxCopyBtn.style.display = "flex";
    ctxPasteBtn.style.display = "flex";
    ctxSelectAllBtn.style.display = "flex";
    ctxFindBtn.style.display = "flex";
    
    // Checked first: a live-preview table widget also carries .markdown-preview.
    const target = e.target.closest(".cm-editor") ??
      e.target.closest("textarea, input[type='text'], .markdown-preview");
    if (!target) {
      hideContextMenu();
      return;
    }
    
    contextMenuTarget = target;
    contextMenuEditor = [primaryEditor, secondaryEditor].find(editor => editor.view.dom === target) ?? null;
    hasInsertMenu = contextMenuEditor !== null;
    ctxInsertDivider.style.display = hasInsertMenu ? "block" : "none";
    ctxInsertGroup.style.display = hasInsertMenu ? "block" : "none";
    
    let hasSelection = false;
    if (contextMenuEditor) {
      const { start, end } = contextMenuEditor.getSelection();
      hasSelection = start !== end;
    } else if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
      hasSelection = target.selectionStart !== target.selectionEnd;
    } else {
      hasSelection = Boolean(window.getSelection().toString());
    }
    
    ctxCutBtn.disabled = !hasSelection;
    ctxCopyBtn.disabled = !hasSelection;
    ctxCommentBtn.style.display = contextMenuEditor && hasSelection && currentLayoutMode !== "reading" ? "flex" : "none";
  }
  
  const menuWidth = 180;
  const menuHeight = noteId ? (folders.length > 0 ? 260 : 220) : (folderId ? 210 : (hasInsertMenu ? 285 : 220));
  const submenuWidth = 175;
  let x = e.clientX;
  let y = e.clientY;
  
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 8;
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 8;
  }
  
  customContextMenu.style.left = `${Math.max(8, x)}px`;
  customContextMenu.style.top = `${Math.max(8, y)}px`;
  customContextMenu.classList.toggle(
    "submenu-opens-left",
    x + menuWidth + submenuWidth + 8 > window.innerWidth
  );
  customContextMenu.classList.toggle("submenu-opens-up", e.clientY > window.innerHeight / 2);
  customContextMenu.style.display = "flex";
}

function hideContextMenu() {
  customContextMenu.style.display = "none";
  ctxInsertGroup.classList.remove("open");
  ctxInsertBtn.setAttribute("aria-expanded", "false");
  ctxMoveFolderGroup.classList.remove("open");
  ctxMoveFolderBtn.setAttribute("aria-expanded", "false");
}

function handleContextInsert(templateName) {
  const editor = contextMenuEditor;
  if (!editor) return;

  const { start, end } = editor.getSelection();
  const edit = getMarkdownTemplateEdit(editor.getText(), start, end, templateName);
  if (!edit) return;

  hideContextMenu();
  editor.focus();
  editor.applyEdit(edit);
}

async function handleContextCut() {
  if (!contextMenuTarget) return;
  hideContextMenu();
  
  if (contextMenuEditor) {
    const editor = contextMenuEditor;
    const { start, end } = editor.getSelection();
    const text = editor.getText().slice(start, end);
    if (text) {
      await navigator.clipboard.writeText(text);
      editor.replaceRange(start, end, "");
    }
  } else if (contextMenuTarget.tagName === "TEXTAREA" || contextMenuTarget.tagName === "INPUT") {
    const start = contextMenuTarget.selectionStart;
    const end = contextMenuTarget.selectionEnd;
    const text = contextMenuTarget.value.substring(start, end);
    if (text) {
      await navigator.clipboard.writeText(text);
      contextMenuTarget.value = contextMenuTarget.value.substring(0, start) + contextMenuTarget.value.substring(end);
      contextMenuTarget.selectionStart = contextMenuTarget.selectionEnd = start;
      contextMenuTarget.dispatchEvent(new Event("input"));
    }
  }
}

async function handleContextCopy() {
  if (!contextMenuTarget) return;
  hideContextMenu();
  
  let text = "";
  if (contextMenuEditor) {
    const { start, end } = contextMenuEditor.getSelection();
    text = contextMenuEditor.getText().slice(start, end);
  } else if (contextMenuTarget.tagName === "TEXTAREA" || contextMenuTarget.tagName === "INPUT") {
    text = contextMenuTarget.value.substring(contextMenuTarget.selectionStart, contextMenuTarget.selectionEnd);
  } else {
    text = window.getSelection().toString();
  }
  
  if (text) {
    await navigator.clipboard.writeText(text);
  }
}

async function handleContextPaste() {
  if (!contextMenuTarget) return;
  hideContextMenu();
  
  try {
    const text = await navigator.clipboard.readText();
    if (text && contextMenuEditor) {
      const { start, end } = contextMenuEditor.getSelection();
      contextMenuEditor.replaceRange(start, end, text);
    } else if (text && (contextMenuTarget.tagName === "TEXTAREA" || contextMenuTarget.tagName === "INPUT")) {
      const start = contextMenuTarget.selectionStart;
      const end = contextMenuTarget.selectionEnd;
      contextMenuTarget.value = contextMenuTarget.value.substring(0, start) + text + contextMenuTarget.value.substring(end);
      contextMenuTarget.selectionStart = contextMenuTarget.selectionEnd = start + text.length;
      contextMenuTarget.dispatchEvent(new Event("input"));
    }
  } catch (err) {
    console.error("Paste failed", err);
  }
}

function handleContextSelectAll() {
  if (!contextMenuTarget) return;
  hideContextMenu();
  
  if (contextMenuEditor) {
    contextMenuEditor.focus();
    contextMenuEditor.setSelection(0, contextMenuEditor.getText().length, { scroll: false });
  } else if (contextMenuTarget.tagName === "TEXTAREA" || contextMenuTarget.tagName === "INPUT") {
    contextMenuTarget.select();
  }
}

function handleContextFind() {
  hideContextMenu();
  toggleFindBar();
}

// ----------------------------------------------------
// Dual-Note Split View Functions
// ----------------------------------------------------
function canCompareVisibleNotes() {
  return Boolean(
    isSplitNoteMode &&
    activeNoteId &&
    secondaryNoteId &&
    activeNoteId !== secondaryNoteId &&
    typeof window.Diff?.diffLines === "function" &&
    typeof window.Diff?.diffWordsWithSpace === "function"
  );
}

function comparisonSummary() {
  if (isNoteComparisonPending) return "Updating comparison…";
  if (noteComparison.changedLineCount === 0) return "No differences";
  return `${noteComparison.changedLineCount} changed line${noteComparison.changedLineCount === 1 ? "" : "s"}`;
}

function syncCompareControl() {
  const available = canCompareVisibleNotes();
  const compareWasActive = isCompareMode;

  if (!available && isCompareMode) {
    isCompareMode = false;
    resetNoteComparison();
  }

  appContainer.classList.toggle("compare-mode", isCompareMode);
  compareNotesBtn.classList.toggle("active", isCompareMode);
  compareNotesBtn.setAttribute("aria-pressed", String(isCompareMode));
  compareNotesBtn.disabled = !available;
  compareNotesCount.hidden = !isCompareMode;

  if (!available) {
    const sameNote = isSplitNoteMode && activeNoteId === secondaryNoteId;
    const reason = sameNote
      ? "Choose a different note to compare"
      : "Note comparison is unavailable";
    compareNotesBtn.title = reason;
    compareNotesBtn.setAttribute("aria-label", reason);
    return compareWasActive && !isCompareMode;
  }

  if (isCompareMode) {
    const summary = comparisonSummary();
    compareNotesCount.textContent = summary;
    compareNotesBtn.title = `Stop comparing notes (${summary.toLowerCase()})`;
    compareNotesBtn.setAttribute("aria-label", `Stop comparing notes, ${summary.toLowerCase()}`);
  } else {
    compareNotesCount.textContent = "";
    compareNotesBtn.title = "Compare note contents";
    compareNotesBtn.setAttribute("aria-label", "Compare note contents");
  }

  return compareWasActive && !isCompareMode;
}

const NOTE_COMPARISON_DEBOUNCE_MS = 150;

function visibleNoteComparison() {
  return isNoteComparisonPending ? emptyNoteComparison() : noteComparison;
}

function noteComparisonMatches(leftText, rightText) {
  return noteComparisonSource?.leftText === leftText &&
    noteComparisonSource?.rightText === rightText;
}

function cancelScheduledNoteComparison() {
  if (noteComparisonRefreshTimer !== null) {
    clearTimeout(noteComparisonRefreshTimer);
    noteComparisonRefreshTimer = null;
  }
  isNoteComparisonPending = false;
}

function resetNoteComparison() {
  cancelScheduledNoteComparison();
  noteComparison = emptyNoteComparison();
  noteComparisonSource = null;
}

function scheduleNoteComparisonRefresh() {
  if (!isCompareMode) return;

  const leftText = primaryEditor.getText();
  const rightText = secondaryEditor.getText();
  if (noteComparisonMatches(leftText, rightText)) {
    cancelScheduledNoteComparison();
    syncCompareControl();
    renderComparisonDecorations();
    return;
  }

  if (noteComparisonRefreshTimer !== null) {
    clearTimeout(noteComparisonRefreshTimer);
  }
  const wasPending = isNoteComparisonPending;
  isNoteComparisonPending = true;
  syncCompareControl();
  if (!wasPending) renderComparisonDecorations();
  noteComparisonRefreshTimer = setTimeout(() => {
    noteComparisonRefreshTimer = null;
    isNoteComparisonPending = false;
    if (isCompareMode) applyComparisonDecorations({ forceComparison: true });
  }, NOTE_COMPARISON_DEBOUNCE_MS);
}

function renderComparisonDecorations() {
  const comparison = visibleNoteComparison();
  primaryEditor.setDiff(isCompareMode
    ? { decorations: comparison.leftDecorations, changedLines: comparison.leftChangedLines }
    : null);
  secondaryEditor.setDiff(isCompareMode
    ? { decorations: comparison.rightDecorations, changedLines: comparison.rightChangedLines }
    : null);
}

function applyComparisonDecorations({ forceComparison = false } = {}) {
  syncCompareControl();
  if (isCompareMode) {
    const leftText = primaryEditor.getText();
    const rightText = secondaryEditor.getText();
    if (noteComparisonMatches(leftText, rightText)) {
      cancelScheduledNoteComparison();
    } else if (forceComparison || !isNoteComparisonPending) {
      cancelScheduledNoteComparison();
      noteComparison = compareNoteText(leftText, rightText, window.Diff);
      noteComparisonSource = { leftText, rightText };
    }
    syncCompareControl();
  }

  renderComparisonDecorations();
}

function setCompareMode(forceState, { render = true } = {}) {
  const shouldEnable = typeof forceState === "boolean" ? forceState : !isCompareMode;
  if (shouldEnable && !canCompareVisibleNotes()) {
    syncCompareControl();
    return;
  }

  isCompareMode = shouldEnable;
  if (!isCompareMode) resetNoteComparison();
  syncCompareControl();

  if (render) applyComparisonDecorations();
}

function setDualPaneHeaderLayout(enabled) {
  if (enabled) {
    primaryPaneHeader.appendChild(noteTitleInput);
    primaryPaneHeader.style.display = "flex";
    return;
  }

  topbarLeft.appendChild(noteTitleInput);
  primaryPaneHeader.style.display = "none";
}

function toggleSplitNoteMode(forceState) {
  const shouldOpen = typeof forceState === "boolean" ? forceState : !isSplitNoteMode;
  if (shouldOpen && isFindResultsOpen) {
    toggleFindResults(false);
  }

  isSplitNoteMode = shouldOpen;
  splitNoteBtn.setAttribute("aria-pressed", String(isSplitNoteMode));
  
  if (isSplitNoteMode) {
    setDualPaneHeaderLayout(true);
    appContainer.classList.add("dual-note-active");
    panesContainer.classList.add("dual-split-mode");
    secondaryPaneWrapper.style.display = "flex";
    splitNoteBtn.classList.add("active");
    compareNotesBtn.hidden = false;
    
    // Choose secondary note (different from activeNoteId if possible)
    if (!secondaryNoteId || secondaryNoteId === activeNoteId) {
      const otherNote = notes.find(n => n.id !== activeNoteId);
      secondaryNoteId = otherNote ? otherNote.id : activeNoteId;
    }
    
    populateSecondaryNoteSelect();
    loadSecondaryNote();
    showNotification("Dual-Note Split View enabled");
  } else {
    setCompareMode(false);
    setDualPaneHeaderLayout(false);
    dismissNotification("Dual-Note Split View enabled");
    appContainer.classList.remove("dual-note-active");
    panesContainer.classList.remove("dual-split-mode");
    secondaryPaneWrapper.style.display = "none";
    splitNoteBtn.classList.remove("active");
    compareNotesBtn.hidden = true;
    activePane = "primary";
    primaryEditor.focus();
  }
}

function openNoteInSecondaryPane(noteId) {
  if (!noteId) return;
  secondaryNoteId = noteId;
  if (!isSplitNoteMode) {
    toggleSplitNoteMode(true);
  } else {
    populateSecondaryNoteSelect();
    loadSecondaryNote();
  }
  activePane = "secondary";
  setActivePane("secondary");
  secondaryEditor.focus();
}

function populateSecondaryNoteSelect() {
  secondaryNoteSelect.innerHTML = "";
  const appendOption = (note, parent = secondaryNoteSelect) => {
    const opt = document.createElement("option");
    opt.value = note.id;
    opt.textContent = note.title || "Untitled Scratchpad";
    if (note.id === secondaryNoteId) {
      opt.selected = true;
    }
    parent.appendChild(opt);
  };

  if (folders.length === 0) {
    notes.forEach((note) => appendOption(note));
    return;
  }

  const appendGroup = (label, groupNotes) => {
    if (groupNotes.length === 0) return;
    const group = document.createElement("optgroup");
    group.label = label;
    groupNotes.forEach((note) => appendOption(note, group));
    secondaryNoteSelect.appendChild(group);
  };
  notes.filter(isNotePinned).forEach((note) => appendOption(note));
  folders.forEach((folder) => appendGroup(
    folder.name,
    notes.filter((note) => !isNotePinned(note) && validFolderId(note.folderId, folders) === folder.id)
  ));
  notes.filter((note) => (
    !isNotePinned(note) && validFolderId(note.folderId, folders) === null
  )).forEach((note) => appendOption(note));
}

function syncSecondaryNoteUi(reload = false) {
  if (!notes.some((note) => note.id === secondaryNoteId)) {
    const alternative = notes.find((note) => note.id !== activeNoteId) || notes[0];
    secondaryNoteId = alternative?.id || null;
  }
  populateSecondaryNoteSelect();
  if (reload && isSplitNoteMode && secondaryNoteId) loadSecondaryNote();
}

function loadSecondaryNote() {
  const note = notes.find(n => n.id === secondaryNoteId);
  if (!note) return;

  cancelScheduledNoteComparison();

  secondaryNoteTitle.value = note.title;
  showNoteInPane("secondary", secondaryEditor, note);

  applyComparisonDecorations();
  updateSecondaryMarkdownPreview();
  if (secondaryNoteSelect.value !== note.id) {
    secondaryNoteSelect.value = note.id;
  }
}

function handleSecondaryEditorInput(text) {
  const note = notes.find(n => n.id === secondaryNoteId);
  if (!note) return;

  note.content = text;
  note.updatedAt = Date.now();
  scheduleNoteComparisonRefresh();

  if (!note.isTitleLocked) {
    const title = autoTitle(text);
    if (note.title !== title) {
      note.title = title;
      secondaryNoteTitle.value = title;
      populateSecondaryNoteSelect();
    }
  }

  triggerSavingState();
  scheduleNoteListRender();

  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updateSecondaryMarkdownPreview();
  }, 150);
}

function handleSecondaryTitleInput() {
  const note = notes.find(n => n.id === secondaryNoteId);
  if (!note) return;

  note.title = secondaryNoteTitle.value.trim() || UNTITLED_TITLE;
  note.isTitleLocked = true;
  note.updatedAt = Date.now();

  triggerSavingState();
  scheduleNoteListRender();
  populateSecondaryNoteSelect();
  scheduleTitleSync();
}

function updateSecondaryMarkdownPreview() {
  if (currentLayoutMode !== "reading") return;
  if (window.marked) {
    secondaryMarkdownPreview.innerHTML = renderMarkdown(secondaryEditor.getText());
    renderPreviewHunks(secondaryMarkdownPreview, secondaryEditor);
    highlightPreviewCode(secondaryMarkdownPreview, window.hljs, appearance.syntaxHighlighting);
    mermaid.renderBlocks(secondaryMarkdownPreview);
  }
}

function setActivePane(pane) {
  const changed = activePane !== pane;
  activePane = pane;
  if (changed) comments.render();
  if (pane === "secondary") {
    primaryPaneWrapper.classList.remove("active-pane");
    secondaryPaneWrapper.classList.add("active-pane");
    updateWordCharCountForText(secondaryEditor);
  } else {
    primaryPaneWrapper.classList.add("active-pane");
    secondaryPaneWrapper.classList.remove("active-pane");
    updateWordCharCountForText(primaryEditor);
  }
}

function updateWordCharCountForText(editor) {
  clearTimeout(wordCountTimer);
  wordCountTimer = null;
  const text = editor.getText();
  const totalWords = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const totalChars = text.length;
  
  wordCharCount.textContent = `${totalWords} word${totalWords !== 1 ? 's' : ''} • ${totalChars} character${totalChars !== 1 ? 's' : ''}`;
  updateCursorPositionForText(editor);

  const { start, end } = editor.getSelection();
  
  if (start !== end) {
    const selectedText = text.substring(start, end);
    const selectedWords = selectedText.trim() ? selectedText.trim().split(/\s+/).filter(Boolean).length : 0;
    const selectedChars = selectedText.length;
    
    selectionCount.textContent = `${selectedWords} word${selectedWords !== 1 ? 's' : ''} • ${selectedChars} character${selectedChars !== 1 ? 's' : ''} selected`;
    selectionCount.style.display = "inline-block";
  } else {
    selectionCount.style.display = "none";
  }
}

function updateCursorPositionForText(editor) {
  const { state } = editor.view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const position = { line: line.number, column: head - line.from + 1 };

  cursorPosition.textContent = `Ln ${position.line}, Col ${position.column}`;
  cursorPosition.title = `Line ${position.line}, column ${position.column}`;
}

function moveNoteUp(noteId) {
  const targetId = noteId || activeNoteId;
  const index = notes.findIndex(n => n.id === targetId);
  if (getNoteMoveTargetIndex(notes, index, -1) === -1) return;
  notes = moveNoteInGroup(notes, targetId, -1);
  
  syncStructure();
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  showNotification("Note moved up");
}

function moveNoteDown(noteId) {
  const targetId = noteId || activeNoteId;
  const index = notes.findIndex(n => n.id === targetId);
  if (getNoteMoveTargetIndex(notes, index, 1) === -1) return;
  notes = moveNoteInGroup(notes, targetId, 1);
  
  syncStructure();
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  showNotification("Note moved down");
}

function toggleNotePinned(noteId) {
  const note = notes.find(candidate => candidate.id === noteId);
  if (!note) return;

  const willPin = !isNotePinned(note);
  notes = setNotePinned(notes, noteId, willPin);
  if (!willPin) {
    const destinationSectionId = validFolderId(note.folderId, folders) || UNFILED_SECTION_ID;
    if (collapsedFolderIds.delete(destinationSectionId)) persistCollapsedFolders();
  }

  syncStructure();
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  showNotification(willPin ? "Note pinned to top" : "Note unpinned");
}

// ----------------------------------------------------
// Quick Notes panel
// ----------------------------------------------------
// The main window asks for a note (its start page links the Welcome note), and
// Rust tells both windows when agent access changes.
async function registerQuickNotesHandlers() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    await listen("quicknotes-focus-note", ({ payload }) => {
      if (typeof payload?.id === "string") {
        pendingFocusNoteId = payload.id;
        focusPendingNote();
        return;
      }
      const note = notes.find(candidate => candidate.title === payload?.title);
      if (note) focusNote(note);
    });
    await agentAccess.listen(listen);
  } catch (error) {
    console.error("Failed to register the Quick Notes handlers", error);
  }
}

// An agent's push names its note by ID. The event can arrive before the state
// that contains the note, so the request waits for it.
let pendingFocusNoteId = null;

function focusPendingNote() {
  const note = notes.find(candidate => candidate.id === pendingFocusNoteId);
  if (!note) return;
  pendingFocusNoteId = null;
  focusNote(note);
}

function focusNote(note) {
  if (isFocusMode) toggleFocusMode();
  if (!isNotePinned(note) && collapsedFolderIds.delete(validFolderId(note.folderId, folders) || UNFILED_SECTION_ID)) {
    persistCollapsedFolders();
  }
  activeNoteId = note.id;
  renderNoteList(searchInput.value);
  loadActiveNote();
}

function hideQuickNotes() {
  invoke("qn_close").catch((error) => console.error("Could not hide Quick Notes", error));
}

function showMainWindow(section) {
  invoke("show_main_window", { section }).catch((error) => {
    console.error("Could not show the Sodilaud window", error);
  });
}

// Boot up!
function startApp() {
  init().catch((error) => {
    console.error("Sodilaud failed to initialize", error);
    if (saveStatus) {
      saveStatus.textContent = "Startup error";
      saveStatus.title = String(error);
    }
  });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", startApp, { once: true });
} else {
  startApp();
}
