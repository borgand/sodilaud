// SPDX-License-Identifier: GPL-3.0-or-later

import {
  LOCAL_FOLDERS_KEY,
  LOCAL_NOTES_BACKUP_KEY,
  LOCAL_NOTES_KEY,
  persistFoldersLocally,
  persistNotesLocally,
  readStoredFolders,
  readStoredNotes
} from "./storage.js";
import { LOCAL_TRASH_KEY, readTrash, trashSummary, restoredNote, persistNotesAndTrashLocally, emptyTrashLocally } from "./trash.js";
import { createTrashUi } from "./trash-ui.js";
import { createMcpWriter, createNoteRevisionTracker, createFolderRevisionTracker } from "./mcp-writes.js";
import { renderMarkdown, resolveLinkAction, sanitizeMarkdownHtml } from "./markdown.js";
import { getNotePreview } from "./note-preview.js";
import { createThemes } from "./themes.js";
import { createAppearance } from "./appearance.js";
import { broadcastPreference, onPreferenceChange } from "./preferences.js";
import { trapModalFocus } from "./modal-focus.js";
import { applyPlatformShortcutLabels, isMacLikePlatform } from "./platform-labels.js";
import { compareNoteText, emptyNoteComparison } from "./note-compare.js";
import { findTextMatches } from "./find.js";
import { createMarkdownEditor } from "./editor-view.js";
import { markdownEditingCommands, runFormatAction } from "./editor-commands.js";
import { getVisibleItemCount } from "./format-toolbar-fit.js";
import { livePreview } from "./editor-live-preview.js";
import { getMarkdownTemplateEdit } from "./markdown-insert.js";
import { escapeHTML, highlightPreviewCode } from "./syntax-highlighting.js";
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
const mcpStatus = document.getElementById("mcp-status");
const focusBtn = document.getElementById("focus-btn");
const splitNoteBtn = document.getElementById("split-note-btn");
const compareNotesBtn = document.getElementById("compare-notes-btn");
const compareNotesCount = document.getElementById("compare-notes-count");
const topbarLeft = document.getElementById("topbar-left");
const formatControls = document.getElementById("format-controls");
const formatHeadingBtn = document.getElementById("format-heading-btn");
const formatHeadingMenu = document.getElementById("format-heading-menu");
const formatMoreBtn = document.getElementById("format-more-btn");
const formatMoreMenu = document.getElementById("format-more-menu");
const formatMenus = [
  { trigger: formatHeadingBtn, menu: formatHeadingMenu },
  { trigger: formatMoreBtn, menu: formatMoreMenu, build: buildFormatMoreMenu }
];

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
const mcpPermissionsSummary = document.getElementById("mcp-permissions-summary");
const agentAccessToggleBtn = document.getElementById("agent-access-toggle-btn");
const mcpPermissionInputs = [...document.querySelectorAll("[data-mcp-tool]")];
const mcpSelectAllInputs = [...document.querySelectorAll("[data-mcp-select-all]")];
const mcpPermissionStatus = document.getElementById("mcp-permission-status");
const agentAccessConfigBtn = document.getElementById("agent-access-config-btn");

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

const mcpConfigModalBackdrop = document.getElementById("mcp-config-modal-backdrop");
const mcpConfigModal = document.getElementById("mcp-config-modal");
const closeMcpConfigBtn = document.getElementById("close-mcp-config-btn");
const mcpConfigCommand = document.getElementById("mcp-config-command");
const mcpConfigArgs = document.getElementById("mcp-config-args");
const copyMcpCommandBtn = document.getElementById("copy-mcp-command-btn");
const copyMcpArgsBtn = document.getElementById("copy-mcp-args-btn");
const copyMcpExampleBtn = document.getElementById("copy-mcp-example-btn");
const mcpConfigExampleCode = document.getElementById("mcp-config-example-code");

const ACTIVE_NOTE_KEY = "sodilaud_quicknotes_active_note";
const COLLAPSED_FOLDERS_KEY = "sodilaud_collapsed_folders";

// State
let notes = [];
let folders = [];
let trash = [];
let trashLoadError = null;
let trashNeedsSave = false;
let activeNoteId = null;
let secondaryNoteId = null;
let activePane = "primary"; // "primary" or "secondary"
let isSplitNoteMode = false;
let isCompareMode = false;
let noteComparison = emptyNoteComparison();
let noteComparisonSource = null;
let noteComparisonRefreshTimer = null;
let isNoteComparisonPending = false;
let activeDbPath = null;
let currentLayoutMode = "live";
let primaryEditor = null;
let secondaryEditor = null;
let isFocusMode = false;
let isMcpConfigModalOpen = false;
let mcpConfigModalPreviousFocus = null;
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
const noteSaveDebounceTimers = new Map();
let previewDebounceTimer = null;
let dbSaveQueue = Promise.resolve();
let localMirrorFailureNotified = false;
let notificationSequence = 0;
let activeNotification = null;
let previewHighlightsRendered = false;
let isMcpEnabled = false;
const MCP_READ_TOOLS = ["list_folders", "list_notes", "search_notes", "get_note", "list_trash"];
const MCP_WRITE_TOOLS = ["create_note", "create_folder", "append_to_note", "rename_note", "move_note", "rename_folder", "delete_note", "delete_folder"];
const defaultMcpPermissions = () => Object.fromEntries([...MCP_READ_TOOLS.map(tool => [tool, true]), ...MCP_WRITE_TOOLS.map(tool => [tool, false])]);
let mcpPermissions = defaultMcpPermissions();
let isMcpPermissionSaving = false;
const noteRevision = createNoteRevisionTracker(() => window.crypto.randomUUID());
const currentNoteRevision = note => noteRevision(note, mcpCollectionId);
const folderRevision = createFolderRevisionTracker(() => window.crypto.randomUUID());
const currentFolderRevision = folder => folderRevision(folder, mcpCollectionId);
let mcpWriteListener = null;
let mcpCollectionId = window.crypto.randomUUID();
let isWorkspaceSwitching = false;
let isClosePending = false;

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
// The theme is chosen in the main window; this page only follows it.
const themes = createThemes({ document, storage: localStorage, invoke });

function enqueueWorkspaceOperation(operation) {
  const result = dbSaveQueue.then(operation);
  dbSaveQueue = result.catch(() => undefined);
  return result;
}

const mcpWriter = createMcpWriter({
  state: () => ({
    permissions: Object.fromEntries(Object.entries(mcpPermissions).map(([tool, allowed]) => [tool, isMcpEnabled && allowed])),
    switching: isWorkspaceSwitching || isClosePending,
    collectionId: mcpCollectionId, dbPath: activeDbPath, notes, folders, trash, editingFolderId
  }),
  uuid: () => window.crypto.randomUUID(),
  revision: currentNoteRevision,
  folderRevision: currentFolderRevision,
  applyNoteDeletion,
  applyFolderDeletion,
  deletionSaved: () => { if (noteSaveDebounceTimers.size === 0) setSavedState(); },
  applyNoteChange: (note, operation) => {
    notes = notes.map(existing => existing.id === note.id ? note : existing);
    triggerSavingState();
    scheduleMcpNoteUpdate(note.id);
    try {
      for (const [id, editor] of [[activeNoteId, primaryEditor], [secondaryNoteId, secondaryEditor]]) {
        if (id !== note.id || operation !== "append_to_note") continue;
        editor.setText(note.content);
      }
      if (activeNoteId === note.id) {
        if (operation === "rename_note") noteTitleInput.value = note.title;
        updateMarkdownPreview();
        updateWordCharCountForText(primaryEditor);
      }
      if (secondaryNoteId === note.id) updateSecondaryMarkdownPreview();
      if (isCompareMode && (activeNoteId === note.id || secondaryNoteId === note.id)) {
        applyComparisonDecorations();
      }
      populateSecondaryNoteSelect();
      if (isFindResultsOpen && isFindAllNotesMode) renderFindResults();
      if (isFindBarOpen) runFind({ preserveActive: true, selectActive: false });
      if (!isCreatingFolder && editingFolderId === null) renderNoteList(searchInput.value);
    } catch (error) {
      console.error("Could not render MCP note change", error);
    }
  },
  applyFolderChange: folder => {
    folders = folders.map(existing => existing.id === folder.id ? folder : existing);
    triggerSavingState();
    scheduleMcpSnapshotUpdate();
    try {
      if (!isCreatingFolder && editingFolderId === null) renderNoteList(searchInput.value);
      populateSecondaryNoteSelect();
    } catch (error) {
      console.error("Could not render MCP folder rename", error);
    }
  },
  mutationSaveFailed: setSaveFailedState,
  mutationSaved: (id, revision, operation) => {
    const changingFolder = operation === "rename_folder";
    const item = (changingFolder ? folders : notes).find(item => item.id === id);
    if (item && (changingFolder ? currentFolderRevision(item) : currentNoteRevision(item)) === revision
      && noteSaveDebounceTimers.size === 0) setSavedState();
  },
  enqueue: enqueueWorkspaceOperation,
  persist: async (candidate, operation) => {
    if (candidate.dbPath) {
      await persistWorkspace(candidate);
    } else {
      const result = ["create_folder", "rename_folder", "delete_folder"].includes(operation) && !trashNeedsSave
        ? persistFoldersLocally(localStorage, candidate.folders)
        : persistNotesAndTrashLocally(localStorage, candidate.notes, candidate.trash);
      if (!result.ok) throw new Error("Could not save MCP write to local storage");
      if (trashNeedsSave) {
        const folderResult = persistFoldersLocally(localStorage, candidate.folders);
        if (!folderResult.ok) throw new Error("Could not save folders to local storage");
      }
      trashNeedsSave = false;
    }
  },
  publish: ({ note, folder }) => {
    if (note) {
      // A user may remove its destination folder while persistence is in flight.
      note.folderId = validFolderId(note.folderId, folders);
      notes = insertNoteBelowPinned(notes, note);
    }
    if (folder) folders = [...folders, folder];
    try {
      // Let an in-progress sidebar rename/create finish without replacing its
      // input. That action's normal render will reveal the new items.
      if (!isCreatingFolder && editingFolderId === null) renderNoteList(searchInput.value);
      populateSecondaryNoteSelect();
    } catch (error) {
      // Persistence succeeded; a rendering failure must not make retries create
      // another item. Keep the saved result and live state authoritative.
      console.error("Could not render MCP creation", error);
    }
  },
  refresh: () => syncMcpSnapshot()
});
async function persistWorkspace(candidate) {
  await invoke("save_workspace_db", {
    dbPath: candidate.dbPath, notes: candidate.notes.map(note => ({ ...note })),
    folders: candidate.folders.map(folder => ({ ...folder })), trash: structuredClone(candidate.trash)
  });
  trashNeedsSave = false;
}

const trashUi = createTrashUi({
  state: () => ({ entries: trash, collectionId: mcpCollectionId, error: trashLoadError }),
  restore: (id, collectionId) => enqueueWorkspaceOperation(async () => {
    checkTrashCollection(collectionId);
    const entry = trash.find(entry => entry.id === id);
    if (!entry) throw new Error("This note is no longer in the trash");
    const note = restoredNote(entry, notes, folders);
    const nextTrash = trash.filter(entry => entry.id !== id);
    await persistTrashState(insertNoteBelowPinned(notes, note), nextTrash);
    // Preserve edits made to other notes while persistence was in flight.
    note.folderId = validFolderId(note.folderId, folders);
    notes = insertNoteBelowPinned(notes, note);
    trash = nextTrash;
    if (noteSaveDebounceTimers.size === 0) setSavedState();
    refreshTrashUi();
    renderNoteList(searchInput.value);
    populateSecondaryNoteSelect();
    scheduleMcpSnapshotUpdate();
  }),
  empty: (ids, collectionId) => enqueueWorkspaceOperation(async () => {
    checkTrashCollection(collectionId);
    const selected = new Set(ids);
    const nextTrash = trash.filter(entry => !selected.has(entry.id));
    if (activeDbPath) await persistTrashState(notes, nextTrash);
    else {
      const result = emptyTrashLocally(localStorage, notes, nextTrash);
      if (!result.ok) { setSaveFailedState(); throw result.error; }
      trashNeedsSave = false;
    }
    trash = nextTrash;
    if (noteSaveDebounceTimers.size === 0) setSavedState();
    refreshTrashUi();
    scheduleMcpSnapshotUpdate();
  })
});

function checkTrashCollection(collectionId) {
  if (trashLoadError) throw new Error(trashLoadError);
  if (collectionId !== mcpCollectionId || isWorkspaceSwitching || isClosePending) {
    throw new Error("Collection changed or is switching; reopen Trash before continuing");
  }
}

async function persistTrashState(nextNotes, nextTrash) {
  try {
    if (activeDbPath) await persistWorkspace({ dbPath: activeDbPath, notes: nextNotes, folders, trash: nextTrash });
    else {
      const result = persistNotesAndTrashLocally(localStorage, nextNotes, nextTrash);
      if (!result.ok) throw result.error;
    }
    trashNeedsSave = false;
  } catch (error) {
    setSaveFailedState();
    throw error;
  }
}

function refreshTrashUi() { trashUi.refresh(); }

function applyNoteDeletion(note) {
  if (trashLoadError) throw new Error(trashLoadError);
  const entry = { id: window.crypto.randomUUID(), note: structuredClone(note), deletedAt: Date.now(),
    folderName: folders.find(folder => folder.id === note.folderId)?.name ?? null };
  trash = [...trash, entry];
  trashNeedsSave = true;
  notes = notes.filter(existing => existing.id !== note.id);
  clearTimeout(noteSaveDebounceTimers.get(note.id));
  noteSaveDebounceTimers.delete(note.id);
  if (notes.length === 0) {
    notes = [{ id: `note_${window.crypto.randomUUID()}`, title: "Untitled Scratchpad", content: "",
      updatedAt: Date.now(), isTitleLocked: false, isPinned: false, folderId: null }];
  }
  if (activeNoteId === note.id) activeNoteId = notes[0].id;
  triggerSavingState();
  try {
    refreshTrashUi();
    renderNoteList(searchInput.value);
    loadActiveNote();
    syncSecondaryNoteUi(true);
  } catch (error) {
    console.error("Could not render note deletion", error);
  }
  scheduleMcpSnapshotUpdate();
  return trashSummary(entry);
}

function applyFolderDeletion(folder) {
  if (editingFolderId === folder.id) throw new Error("Folder is being edited; try again when the edit finishes");
  if (notes.some(note => note.folderId === folder.id)) throw new Error("Folder is not empty; move its notes before deleting it");
  folders = folders.filter(existing => existing.id !== folder.id);
  collapsedFolderIds.delete(folder.id);
  triggerSavingState();
  try {
    persistCollapsedFolders();
    renderNoteList(searchInput.value);
    populateSecondaryNoteSelect();
  } catch (error) {
    console.error("Could not render folder deletion", error);
  }
  scheduleMcpSnapshotUpdate();
}

let mcpConnectionInfo = null;
let mcpSnapshotTimer = null;
const mcpNoteSnapshotTimers = new Map();

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
    extensions: [markdownEditingCommands(), livePreview({ onOpenLink: openExternalHref })],
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

// Reports the remembered workspace alongside whether it could be determined at
// all. "Read it, there is no workspace" and "could not read it" look identical
// from the path alone, and only the first is safe to act on: a preference that
// failed to read may still name a workspace that opens on a later launch.
async function loadRememberedWorkspacePath() {
  const legacyPath = localStorage.getItem("sodilaud_active_db");
  if (!window.__TAURI__) return { known: true, path: legacyPath };

  try {
    const savedPath = await invoke("load_workspace_preference", { legacyPath });
    localStorage.removeItem("sodilaud_active_db");
    return { known: true, path: savedPath };
  } catch (err) {
    console.error("Failed to load native workspace preference", err);
    // Unknown even when a legacy path survives: the native preference takes
    // precedence over it and may name a different workspace.
    return { known: false, path: legacyPath };
  }
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
  await onPreferenceChange(window, followPreferenceChange);

  // 2. Load the saved theme (Default Dark on first launch) and layout mode
  themes.load();
  appearance.load();
  const savedLayoutMode = localStorage.getItem("sodilaud_layout_mode");
  setLayoutMode(normalizeLayoutMode(savedLayoutMode), { persist: savedLayoutMode !== null });

  // 3. Always load the local-only collection first as guaranteed baseline
  loadNotesFromLocalStorage();
  loadFoldersFromLocalStorage();
  loadTrashFromLocalStorage();
  notes = normalizeNoteFolderAssignments(notes, folders);
  loadCollapsedFolders();
  adoptLegacyStashedNotes();

  // 4. Check if a native workspace preference is configured. Existing
  // localStorage preferences are migrated once for origin-independent startup.
  const rememberedWorkspace = await loadRememberedWorkspacePath();
  if (rememberedWorkspace.path && window.__TAURI__) {
    activeDbPath = rememberedWorkspace.path;
    try {
      // Load serially because both commands ensure/migrate the SQLite schema.
      // Two first-open migrations against the same older file must not race.
      const dbNotes = await invoke("load_db_notes", { dbPath: activeDbPath });
      if (!Array.isArray(dbNotes)) {
        throw new Error("Workspace returned an unexpected notes response");
      }
      const dbFoldersResult = await invoke("load_db_folders", { dbPath: activeDbPath });
      if (!Array.isArray(dbFoldersResult)) {
        throw new Error("Workspace returned an unexpected folders response");
      }
      const dbFolders = normalizeFolders(dbFoldersResult);
      const dbTrash = await loadWorkspaceTrash(activeDbPath);
      // Seeding deletes and rewrites the workspace's rows, so an unreadable
      // response must not be mistaken for an empty workspace.
      if (dbNotes.length > 0) {
        folders = dbFolders;
        notes = normalizePinnedNoteOrder(normalizeNoteFolderAssignments(dbNotes, folders));
      } else if (dbFolders.length > 0 || dbTrash.length > 0) {
        notes = [];
        folders = dbFolders;
      } else {
        // Seed a completely empty workspace with the active local collection.
        // Include the welcome note in the awaited transaction so a failed first
        // write falls back to local mode instead of exposing an unsaved workspace.
        const seedNotes = notes.length > 0
          ? notes
          : [createNoteRecord(WELCOME_NOTE_TITLE, WELCOME_NOTE_CONTENT, null)];
        await invoke("save_workspace_db", {
          dbPath: activeDbPath,
          notes: seedNotes,
          folders
        });
        notes = seedNotes;
      }
      trash = dbTrash;
      trashLoadError = null;
      trashNeedsSave = false;
      refreshTrashUi();
      updateDbUiState(true);
    } catch (err) {
      console.error("Failed to load workspace from SQLite DB on boot", err);
      activeDbPath = null;
      // `notes` still holds the local-only collection: it is only replaced once
      // the workspace has answered. Editing it here cannot be undone by the
      // workspace opening on a later launch.
      updateDbUiState(false);
      showNotification("Workspace unavailable; using local notes");
    }
  } else {
    updateDbUiState(false);
    if (!rememberedWorkspace.known) {
      showNotification("Workspace settings unreadable; using local notes");
    }
  }

  // 5. Create default note if none exist
  if (notes.length === 0) {
    createNote(WELCOME_NOTE_TITLE, WELCOME_NOTE_CONTENT);
  } else {
    // Reopen the note that was open last, or the first one.
    const remembered = localStorage.getItem(ACTIVE_NOTE_KEY);
    activeNoteId = notes.some(note => note.id === remembered) ? remembered : notes[0].id;
  }

  // 6. Render UI
  renderNoteList();
  loadActiveNote();
}

// ----------------------------------------------------
// Note Management Logic
// ----------------------------------------------------
function createNoteRecord(title, content, folderId) {
  return {
    id: "note_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
    title,
    content,
    updatedAt: Date.now(),
    isTitleLocked: title !== "Untitled Scratchpad" && title !== WELCOME_NOTE_TITLE,
    isPinned: false,
    folderId
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
  
  saveNotesToStorage({ syncWorkspace: true });
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
  const collectionId = mcpCollectionId;
  return enqueueWorkspaceOperation(async () => {
    checkTrashCollection(collectionId);
    const note = notes.find(note => note.id === id);
    if (!note) return;
    applyNoteDeletion(note);
    await persistTrashState(notes, trash);
    if (noteSaveDebounceTimers.size === 0) setSavedState();
  }).catch(error => {
    setSaveFailedState();
    showNotification(`Could not save deletion; your note remains recoverable: ${error.message || error}`);
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
  primaryEditor.loadText(activeNote.content);

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

              saveNotesToStorage({ syncWorkspace: true });
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
  if (!isFolderNameAvailable([...folders, ...mcpWriter.reservedFolders()], name, folderId)) {
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
  saveNotesToStorage({ syncWorkspace: true });
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
  saveNotesToStorage({ syncWorkspace: true });
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
  saveNotesToStorage({ syncWorkspace: true });
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
      saveNotesToStorage({ syncWorkspace: true });
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

// A workspace owns its own storage. Local storage holds the local-only
// collection and nothing else, so a workspace session never writes over notes
// it does not contain.
function saveNotesToStorage({ noteId = activeNoteId, syncWorkspace = false } = {}) {
  if (syncWorkspace) {
    scheduleMcpSnapshotUpdate();
  } else {
    scheduleMcpNoteUpdate(noteId);
  }

  if (activeDbPath) {
    const dbPath = activeDbPath;
    const workspaceSave = enqueueWorkspaceOperation(async () => {
      if (activeDbPath !== dbPath) return true;
      // Capture at execution time: a preceding MCP creation may have committed
      // since this save was queued. Stale full snapshots could erase it.
      if (syncWorkspace || trashNeedsSave) {
        await persistWorkspace({ dbPath, notes, folders, trash });
      } else {
        const sortOrder = notes.findIndex(note => note.id === noteId);
        if (sortOrder === -1) return true;
        await invoke("save_note_db", { dbPath, note: { ...notes[sortOrder] }, sortOrder });
      }
      return true;
    }).catch(err => {
      console.error("Failed to save workspace to SQLite DB", err);
      setSaveFailedState();
      return false;
    });

    return workspaceSave;
  }

  const noteResult = persistNotesAndTrashLocally(localStorage, notes, trash);
  const folderResult = persistFoldersLocally(localStorage, folders);
  const localResult = noteResult.ok ? folderResult : noteResult;

  if (localResult.ok) {
    trashNeedsSave = false;
    localMirrorFailureNotified = false;
  } else {
    console.error("Failed to save local workspace data", localResult.error);
    if (!localMirrorFailureNotified) {
      showNotification("Local save failed; free some disk space or connect a workspace");
      localMirrorFailureNotified = true;
    }
  }

  return Promise.resolve(localResult.ok);
}

function scheduleNoteSave(noteId, afterSave) {
  clearTimeout(noteSaveDebounceTimers.get(noteId));
  const timer = setTimeout(() => {
    noteSaveDebounceTimers.delete(noteId);
    const saveResult = saveNotesToStorage({ noteId });
    if (afterSave) afterSave();
    saveResult.then((saved) => {
      if (noteSaveDebounceTimers.size > 0) return;
      if (saved) {
        setSavedState();
      } else {
        setSaveFailedState();
      }
    });
  }, 400);
  noteSaveDebounceTimers.set(noteId, timer);
}

function setSaveFailedState() {
  saveStatus.textContent = "Save failed";
  saveStatus.title = "Sodilaud could not persist the latest changes";
  saveStatus.classList.add("unsaved");
}

function clearPendingSaveTimers() {
  noteSaveDebounceTimers.forEach(timer => clearTimeout(timer));
  noteSaveDebounceTimers.clear();
}

async function flushPendingSaves() {
  clearPendingSaveTimers();
  return saveNotesToStorage({ syncWorkspace: true });
}

function persistLocalMirrorBeforePageExit() {
  // A workspace session has nothing to flush here, and writing would replace
  // the local-only collection with the workspace's notes.
  if (activeDbPath) return;

  const result = persistNotesAndTrashLocally(localStorage, notes, trash);
  const folderResult = persistFoldersLocally(localStorage, folders);
  if (!result.ok || !folderResult.ok) {
    console.error("Failed to flush local workspace data during page exit", result.error || folderResult.error);
  }
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
      isClosePending = true;
      let saved = false;
      try {
        await dbSaveQueue;
        saved = await flushPendingSaves();
        if (!saved) {
          setSaveFailedState();
          showNotification("Could not save the latest changes; quit cancelled");
        }
      } catch (error) {
        console.error("Failed to save before quitting", error);
        showNotification("Could not save the latest changes; quit cancelled");
      } finally {
        if (!saved) isClosePending = false;
        quitting = false;
      }
      try {
        await invoke("quit_window_done", { ok: saved });
      } catch (error) {
        isClosePending = false;
        console.error("Failed to quit Sodilaud", error);
        showNotification("Could not quit Sodilaud");
      }
    });
    // Another window could not save, so the app keeps running: accept writes again.
    await listen("sodilaud-quit-cancelled", () => { isClosePending = false; });
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
  scheduleMcpNoteUpdate(activeNote.id);
  scheduleNoteComparisonRefresh();
  if (isFindBarOpen) {
    runFind({ preserveActive: true, selectActive: false });
  }

  // Auto-rename the title from the first line until the user edits it manually.
  if (!activeNote.isTitleLocked) {
    const lines = text.trim().split("\n");
    let firstLine = lines[0] || "";
    // Clean markdown headings out of title
    firstLine = firstLine.replace(/^#+\s+/, "").trim();
    
    const newTitle = firstLine ? firstLine.substring(0, 30) : "Untitled Scratchpad";
    if (activeNote.title !== newTitle) {
      activeNote.title = newTitle;
      noteTitleInput.value = newTitle;
    }
  }

  // Visual auto-save feedback
  triggerSavingState();

  // Save notes locally
  scheduleNoteSave(activeNote.id, () => {
    renderNoteList(searchInput.value);
  });

  // Live markdown compilation
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updateMarkdownPreview();
  }, 150);
}

function handleTitleInput() {
  const activeNote = notes.find(n => n.id === activeNoteId);
  if (!activeNote) return;

  activeNote.title = noteTitleInput.value.trim() || "Untitled Scratchpad";
  activeNote.isTitleLocked = true; // User edited manually, lock auto-renaming
  activeNote.updatedAt = Date.now();
  scheduleMcpNoteUpdate(activeNote.id);

  if (isFindResultsOpen && isFindAllNotesMode) {
    renderFindResults();
  }

  triggerSavingState();
  
  scheduleNoteSave(activeNote.id, () => {
    renderNoteList(searchInput.value);
  });
}

function triggerSavingState() {
  saveStatus.textContent = "Saving...";
  saveStatus.title = "Sodilaud is saving the latest changes";
  saveStatus.classList.add("unsaved");
}

function setSavedState() {
  if (activeDbPath) {
    const fileName = activeDbPath.split(/[/\\]/).pop();
    saveStatus.textContent = `Saved (${fileName})`;
    saveStatus.title = `Workspace: ${activeDbPath}`;
  } else {
    saveStatus.textContent = "Saved";
    saveStatus.title = "Saved to local webview storage";
  }
  saveStatus.classList.remove("unsaved");
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
      highlightPreviewCode(markdownPreview, window.hljs, appearance.syntaxHighlighting);
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
  if (mode === "reading") updateMarkdownPreview();

  if (persist) localStorage.setItem("sodilaud_layout_mode", mode);
}

// ----------------------------------------------------
// Formatting toolbar
// ----------------------------------------------------
function setFormatControlsEnabled(enabled) {
  formatControls.setAttribute("aria-disabled", String(!enabled));
  formatControls.querySelectorAll("button").forEach((button) => { button.disabled = !enabled; });
  formatHeadingMenu.querySelectorAll("button").forEach((button) => { button.disabled = !enabled; });
  if (!enabled) closeFormatMenus();
}

function setFormatMenuOpen(entry, open) {
  if (open) {
    closeFormatMenus(entry);
    toggleActionsDropdown(false);
    entry.build?.();
    entry.menu.style.left = `${entry.trigger.offsetLeft}px`;
  }
  entry.menu.hidden = !open;
  entry.trigger.setAttribute("aria-expanded", String(open));
}

function closeFormatMenus(except) {
  let closed = false;
  for (const entry of formatMenus) {
    if (entry === except || entry.menu.hidden) continue;
    setFormatMenuOpen(entry, false);
    closed = true;
  }
  return closed;
}

function formatMenuItems(menu) {
  return [...menu.querySelectorAll("[role='menuitem']:not([disabled])")];
}

function focusFormatMenuItem(menu, index) {
  const items = formatMenuItems(menu);
  if (items.length === 0) return;
  items[(index + items.length) % items.length].focus();
}

function shortcutFromTitle(title) {
  const match = /\(([^()]*\+[^()]*)\)\s*$/.exec(title ?? "");
  return match ? match[1] : "";
}

function createFormatMenuItem(actionId, label, shortcut) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "dropdown-item format-menu-item";
  item.id = `format-more-${actionId}`;
  item.dataset.format = actionId;
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  item.append(labelSpan);
  if (shortcut) {
    const shortcutSpan = document.createElement("span");
    shortcutSpan.className = "format-menu-shortcut";
    shortcutSpan.textContent = shortcut;
    item.append(" ", shortcutSpan);
  }
  return item;
}

function buildFormatMoreMenu() {
  const items = [];
  for (const { button } of formatToolbarUnits()) {
    if (!button.hidden) continue;
    if (button === formatHeadingBtn) {
      for (const heading of formatMenuItems(formatHeadingMenu)) {
        items.push(createFormatMenuItem(heading.dataset.format, heading.textContent.trim(), shortcutFromTitle(heading.title)));
      }
    } else {
      items.push(createFormatMenuItem(button.dataset.format, button.getAttribute("aria-label"), shortcutFromTitle(button.title)));
    }
  }
  formatMoreMenu.replaceChildren(...items);
}

// Each button paired with the separator in front of it, in priority order.
function formatToolbarUnits() {
  const units = [];
  let separator = null;
  for (const element of formatControls.children) {
    if (element.classList.contains("format-separator")) {
      separator = element;
    } else if (element !== formatMoreBtn) {
      units.push({ button: element, separator });
      separator = null;
    }
  }
  return units;
}

function outerWidth(element) {
  const style = getComputedStyle(element);
  return element.offsetWidth + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
}

// Shows every button once to measure, then hides the ones that do not fit so
// they leave the tab order and appear in the More formatting menu instead.
function layoutFormatToolbar() {
  const units = formatToolbarUnits();
  const wasVisible = units.filter(unit => !unit.button.hidden).length;
  for (const unit of units) {
    unit.button.hidden = false;
    if (unit.separator) unit.separator.hidden = false;
  }
  formatMoreBtn.hidden = false;
  const style = getComputedStyle(formatControls);
  const gap = parseFloat(style.columnGap) || 0;
  const moreWidth = outerWidth(formatMoreBtn) + gap;
  formatMoreBtn.hidden = true;

  const available = formatControls.clientWidth -
    (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) + gap;
  const widths = units.map(unit => outerWidth(unit.button) + gap + (unit.separator ? outerWidth(unit.separator) + gap : 0));
  const visible = getVisibleItemCount(available, widths, moreWidth);

  units.forEach((unit, index) => {
    unit.button.hidden = index >= visible;
    if (unit.separator) unit.separator.hidden = index >= visible;
  });
  formatMoreBtn.hidden = visible === units.length;
  if (visible !== wasVisible) closeFormatMenus();
}

function applyToolbarFormat(actionId) {
  if (currentLayoutMode === "reading") return;
  const editor = isSplitNoteMode && activePane === "secondary" ? secondaryEditor : primaryEditor;
  runFormatAction(editor.view, actionId);
  editor.focus();
}

function handleFormatControlClick(event) {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  event.stopPropagation();
  const entry = formatMenus.find(candidate => candidate.trigger === button);
  if (entry) {
    const open = entry.menu.hidden;
    setFormatMenuOpen(entry, open);
    if (open && event.detail === 0) focusFormatMenuItem(entry.menu, 0);
    return;
  }
  if (!button.dataset.format) return;
  closeFormatMenus();
  toggleActionsDropdown(false);
  applyToolbarFormat(button.dataset.format);
}

function handleFormatMenuKeydown(entry, event) {
  const items = formatMenuItems(entry.menu);
  const index = items.indexOf(document.activeElement);
  const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
  if (event.key in moves) {
    event.preventDefault();
    focusFormatMenuItem(entry.menu, moves[event.key]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setFormatMenuOpen(entry, false);
    entry.trigger.focus();
  } else if (event.key === "Tab") {
    // The menus sit after the toolbar in the DOM, so Tab continues from the trigger.
    setFormatMenuOpen(entry, false);
    entry.trigger.focus();
  }
}

function handleFormatTriggerKeydown(entry, event) {
  if (entry.trigger.disabled) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setFormatMenuOpen(entry, true);
    focusFormatMenuItem(entry.menu, event.key === "ArrowDown" ? 0 : -1);
  } else if (event.key === "Escape" && !entry.menu.hidden) {
    event.stopPropagation();
    setFormatMenuOpen(entry, false);
  }
}

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

function currentMcpCollectionName() {
  if (!activeDbPath) return "Local notes";
  return activeDbPath.split(/[/\\]/).pop() || "Sodilaud workspace";
}

function mcpSnapshotArguments() {
  return {
    collectionName: currentMcpCollectionName(),
    collectionId: mcpCollectionId,
    noteRevisions: Object.fromEntries(notes.map(note => [note.id, currentNoteRevision(note)])),
    folderRevisions: Object.fromEntries(folders.map(folder => [folder.id, currentFolderRevision(folder)])),
    trash: trash.map(trashSummary),
    notes: notes.map(note => ({ ...note })),
    folders: folders.map(folder => ({ ...folder }))
  };
}

async function syncMcpSnapshot() {
  if (!isMcpEnabled || !window.__TAURI__) return;
  await invoke("update_mcp_snapshot", mcpSnapshotArguments());
}

async function syncMcpNote(noteId) {
  if (!isMcpEnabled || !window.__TAURI__) return;
  const note = notes.find(candidate => candidate.id === noteId);
  if (!note) return;
  await invoke("update_mcp_note", { note: { ...note }, revision: currentNoteRevision(note), collectionId: mcpCollectionId });
}

function scheduleMcpSnapshotUpdate() {
  if (!isMcpEnabled || !window.__TAURI__) return;
  cancelScheduledMcpSnapshotUpdates();
  mcpSnapshotTimer = setTimeout(() => {
    mcpSnapshotTimer = null;
    syncMcpSnapshot().catch(error => {
      console.error("Failed to update the MCP note snapshot", error);
    });
  }, 50);
}

function scheduleMcpNoteUpdate(noteId) {
  if (!isMcpEnabled || !window.__TAURI__ || !noteId) return;
  clearTimeout(mcpNoteSnapshotTimers.get(noteId));
  const timer = setTimeout(() => {
    mcpNoteSnapshotTimers.delete(noteId);
    syncMcpNote(noteId).catch(error => {
      console.error("Failed to update a note in the MCP snapshot", error);
    });
  }, 50);
  mcpNoteSnapshotTimers.set(noteId, timer);
}

function cancelScheduledMcpSnapshotUpdates() {
  clearTimeout(mcpSnapshotTimer);
  mcpSnapshotTimer = null;
  mcpNoteSnapshotTimers.forEach(timer => clearTimeout(timer));
  mcpNoteSnapshotTimers.clear();
}

function updateMcpUiState() {
  mcpStatus.hidden = !isMcpEnabled;
  const readCount = MCP_READ_TOOLS.filter(tool => mcpPermissions[tool]).length;
  const writeCount = MCP_WRITE_TOOLS.filter(tool => mcpPermissions[tool]).length;
  mcpPermissionsSummary.textContent = isMcpEnabled ? `${readCount} read · ${writeCount} write functions enabled` : "Off";
  mcpStatus.title = `MCP listening: ${mcpPermissionsSummary.textContent.toLowerCase()}`;
  agentAccessToggleBtn.textContent = isMcpEnabled ? "On" : "Off";
  agentAccessToggleBtn.setAttribute("aria-pressed", String(isMcpEnabled));
  for (const input of mcpPermissionInputs) {
    input.checked = mcpPermissions[input.dataset.mcpTool];
    input.disabled = !isMcpEnabled || isMcpPermissionSaving;
  }
  for (const input of mcpSelectAllInputs) {
    const tools = input.dataset.mcpSelectAll === "read" ? MCP_READ_TOOLS : MCP_WRITE_TOOLS;
    const count = tools.filter(tool => mcpPermissions[tool]).length;
    input.checked = count === tools.length;
    input.indeterminate = count > 0 && count < tools.length;
    input.disabled = !isMcpEnabled || isMcpPermissionSaving;
  }
}

async function changeMcpPermissions(next) {
  if (!isMcpEnabled || isMcpPermissionSaving) { updateMcpUiState(); return; }
  const previous = mcpPermissions;
  isMcpPermissionSaving = true;
  agentAccessToggleBtn.disabled = true;
  // Revoke immediately so queued writes cannot begin during the native update.
  // New grants take effect only after the backend confirms them.
  mcpPermissions = Object.fromEntries(Object.keys(previous).map(tool => [tool, previous[tool] && next[tool]]));
  updateMcpUiState();
  mcpPermissionStatus.textContent = "Saving permissions…";
  try {
    if (MCP_WRITE_TOOLS.some(tool => next[tool])) await ensureMcpWriteListener();
    await invoke("set_mcp_permissions", { tools: Object.keys(next).filter(tool => next[tool]) });
    mcpPermissions = next;
    mcpPermissionStatus.textContent = "Permissions saved";
  } catch (error) {
    mcpPermissions = previous;
    mcpPermissionStatus.textContent = `Could not save permissions: ${error.message || error}`;
  } finally {
    isMcpPermissionSaving = false;
    agentAccessToggleBtn.disabled = false;
    updateMcpUiState();
  }
}

async function ensureMcpWriteListener() {
  if (mcpWriteListener) return;
  mcpWriteListener = await window.__TAURI__.event.listen("mcp-write-request", async ({ payload }) => {
    let result;
    try {
      result = await mcpWriter.request(payload.operation, payload.arguments);
    } catch (error) {
      result = { ok: false, error: String(error.message || error) };
    }
    try {
      await invoke("complete_mcp_write", { ticket: payload.ticket, result });
    } catch (error) {
      console.error("Could not deliver MCP write result; client can retry its requestId", error);
    }
  });
}

async function toggleMcpAccess() {
  if (!window.__TAURI__) {
    showNotification("Agent access is only available in the desktop app");
    return;
  }

  agentAccessToggleBtn.disabled = true;
  agentAccessConfigBtn.disabled = true;
  const previousPermissions = mcpPermissions;
  const disabling = isMcpEnabled;
  try {
    if (isMcpEnabled) {
      if (isMcpConfigModalOpen) closeMcpConfigModal();
      mcpPermissions = Object.fromEntries(Object.keys(mcpPermissions).map(tool => [tool, false]));
      await dbSaveQueue;
      await invoke("stop_mcp_server");
      cancelScheduledMcpSnapshotUpdates();
      isMcpEnabled = false;
      mcpConnectionInfo = null;
      updateMcpUiState();
      showNotification("Agent access disabled");
      return;
    }

    // Seed the native server before it begins accepting connections. The
    // editor remains the authority, so this includes changes not yet saved.
    await invoke("update_mcp_snapshot", mcpSnapshotArguments());
    const connection = await invoke("start_mcp_server");
    if (!connection?.command || !Array.isArray(connection?.args) || !connection.args.length) {
      throw new Error("Sodilaud returned incomplete MCP connection details");
    }
    mcpConnectionInfo = connection;
    mcpPermissions = defaultMcpPermissions();
    isMcpEnabled = true;
    try {
      await syncMcpSnapshot();
    } catch (error) {
      console.error("Failed to refresh the MCP note snapshot after startup", error);
    }
    updateMcpUiState();
    showNotification("Agent access enabled — reads only until you allow write functions in MCP Configuration");
  } catch (error) {
    if (disabling) mcpPermissions = previousPermissions;
    updateMcpUiState();
    console.error("Could not change MCP agent access", error);
    showNotification(disabling
      ? "Could not disable agent access"
      : `Could not enable agent access: ${error}`);
  } finally {
    agentAccessToggleBtn.disabled = false;
    agentAccessConfigBtn.disabled = false;
  }
}

async function openMcpConfigModal() {
  mcpPermissionStatus.textContent = isMcpEnabled ? "" : "Agent access is off. Enable it from the actions menu to change function permissions.";
  updateMcpUiState();
  mcpConfigModalPreviousFocus = actionsDropdown.contains(document.activeElement)
    ? actionsBtn
    : document.activeElement;
  isMcpConfigModalOpen = true;
  mcpConfigModalBackdrop.style.display = "flex";
  mcpConfigModalBackdrop.setAttribute("aria-hidden", "false");
  closeMcpConfigBtn.focus({ preventScroll: true });
  const copyButtons = [copyMcpCommandBtn, copyMcpArgsBtn, copyMcpExampleBtn];
  copyButtons.forEach(button => { button.disabled = true; });
  try {
    if (!mcpConnectionInfo) mcpConnectionInfo = await invoke("get_mcp_connection_info");
    if (!isMcpConfigModalOpen) return;
    if (!mcpConnectionInfo?.command || !Array.isArray(mcpConnectionInfo.args) || !mcpConnectionInfo.args.length) {
      throw new Error("Connection details are unavailable");
    }
    mcpConfigCommand.value = mcpConnectionInfo.command;
    mcpConfigArgs.value = mcpConnectionInfo.args.join(" ");
    mcpConfigExampleCode.textContent = JSON.stringify({
      mcpServers: { sodilaud: { command: mcpConnectionInfo.command, args: mcpConnectionInfo.args } }
    }, null, 2);
    copyButtons.forEach(button => { button.disabled = false; });
  } catch (error) {
    if (isMcpConfigModalOpen) mcpPermissionStatus.textContent = `Could not load MCP configuration: ${error.message || error}`;
  }
}

function closeMcpConfigModal() {
  isMcpConfigModalOpen = false;
  mcpConfigModalBackdrop.style.display = "none";
  mcpConfigModalBackdrop.setAttribute("aria-hidden", "true");
  mcpConfigCommand.value = "";
  mcpConfigArgs.value = "";
  mcpConfigExampleCode.textContent = "";
  if (mcpConfigModalPreviousFocus && mcpConfigModalPreviousFocus.isConnected) {
    mcpConfigModalPreviousFocus.focus({ preventScroll: true });
  }
  mcpConfigModalPreviousFocus = null;
}

function copyMcpConfigValue(value, label) {
  navigator.clipboard.writeText(value).then(() => {
    showNotification(`${label} copied`);
  }).catch(error => {
    console.error(`Failed to copy MCP ${label.toLowerCase()}`, error);
    showNotification(`Could not copy ${label.toLowerCase()}`);
  });
}

function copyMarkdownToClipboard() {
  const text = primaryEditor.getText();
  navigator.clipboard.writeText(text).then(() => {
    showNotification("Markdown copied to clipboard!");
  }).catch(err => {
    console.error("Failed to copy", err);
  });
}

function copyHtmlToClipboard() {
  const html = currentLayoutMode === "reading"
    ? markdownPreview.innerHTML
    : renderMarkdown(primaryEditor.getText());
  
  navigator.clipboard.writeText(html).then(() => {
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

    // MCP Configuration Modal
  for (const input of mcpPermissionInputs) {
    input.addEventListener("change", () => changeMcpPermissions({ ...mcpPermissions, [input.dataset.mcpTool]: input.checked }));
  }
  for (const input of mcpSelectAllInputs) {
    input.addEventListener("change", () => {
      const tools = input.dataset.mcpSelectAll === "read" ? MCP_READ_TOOLS : MCP_WRITE_TOOLS;
      changeMcpPermissions({ ...mcpPermissions, ...Object.fromEntries(tools.map(tool => [tool, input.checked])) });
    });
  }
  agentAccessConfigBtn.addEventListener("click", () => {
    toggleActionsDropdown(false);
    actionsBtn.focus({ preventScroll: true });
    openMcpConfigModal();
  });
  closeMcpConfigBtn.addEventListener("click", closeMcpConfigModal);
  mcpConfigModalBackdrop.addEventListener("click", (e) => {
    if (e.target === mcpConfigModalBackdrop) closeMcpConfigModal();
  });
  copyMcpCommandBtn.addEventListener("click", () => {
    copyMcpConfigValue(mcpConfigCommand.value, "MCP command");
  });
  copyMcpArgsBtn.addEventListener("click", () => {
    copyMcpConfigValue(mcpConfigArgs.value, "MCP argument");
  });
  copyMcpExampleBtn.addEventListener("click", () => {
    copyMcpConfigValue(mcpConfigExampleCode.textContent, "Configuration example");
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

  // Keeping focus in the editor on mousedown keeps its selection for the click.
  for (const container of [formatControls, formatHeadingMenu, formatMoreMenu]) {
    container.addEventListener("mousedown", (event) => {
      if (event.target.closest("button")) event.preventDefault();
    });
    container.addEventListener("click", handleFormatControlClick);
  }
  for (const entry of formatMenus) {
    entry.menu.addEventListener("keydown", (event) => handleFormatMenuKeydown(entry, event));
    entry.trigger.addEventListener("keydown", (event) => handleFormatTriggerKeydown(entry, event));
  }
  window.addEventListener("resize", layoutFormatToolbar);
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => layoutFormatToolbar());
    for (const selector of [".topbar", ".topbar-right", ".layout-controls"]) {
      observer.observe(document.querySelector(selector));
    }
  }
  document.fonts?.ready.then(layoutFormatToolbar);
  layoutFormatToolbar();

  appearance.attachControls();

    copyMarkdownBtn.addEventListener("click", copyMarkdownToClipboard);
  copyHtmlBtn.addEventListener("click", copyHtmlToClipboard);
  importBtn.addEventListener("click", importFile);
  exportBtn.addEventListener("click", exportAsMarkdownFile);
  dbConnectBtn.addEventListener("click", connectDatabase);
  dbDisconnectBtn.addEventListener("click", disconnectDatabase);
  agentAccessToggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMcpAccess();
  });

  // Custom Context Menu Events
  document.addEventListener("contextmenu", showContextMenu);
  document.addEventListener("click", hideContextMenu);
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("pagehide", persistLocalMirrorBeforePageExit);

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
    saveNotesToStorage({ syncWorkspace: true });
    renderNoteList(searchInput.value);
    populateSecondaryNoteSelect();
    showNotification("Folder moved up");
  });
  ctxFolderMoveDownBtn.addEventListener("click", () => {
    const folderId = contextMenuFolderId;
    hideContextMenu();
    if (!folderId) return;
    folders = moveFolder(folders, folderId, 1);
    saveNotesToStorage({ syncWorkspace: true });
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

    if (isMcpConfigModalOpen && e.key === "Tab" && !isMeta && !e.altKey) {
      trapModalFocus(e, mcpConfigModal);
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
      } else if (isMcpConfigModalOpen) {
        e.preventDefault();
        closeMcpConfigModal();
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
// Sanitized Markdown links carry target="_blank", but the desktop webview has
// no default handling for it, so clicking one would otherwise do nothing. Send
// external links to the user's browser; everything else stays put.
function handlePreviewLinkClick(event) {
  const link = event.target.closest("a[href]");
  if (!link) return;

  event.preventDefault();
  openExternalHref(link.getAttribute("href"));
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


// Database helpers
function loadNotesFromLocalStorage() {
  const savedNotes = localStorage.getItem(LOCAL_NOTES_KEY);
  if (savedNotes) {
    try {
      notes = normalizePinnedNoteOrder(JSON.parse(savedNotes));
    } catch (e) {
      console.error("Failed to parse saved notes, resetting", e);
      notes = [];
    }
  }
}

function loadFoldersFromLocalStorage() {
  folders = normalizeFolders(readStoredFolders(localStorage.getItem(LOCAL_FOLDERS_KEY)));
}

function loadTrashFromLocalStorage() {
  try {
    trash = readTrash(localStorage.getItem(LOCAL_TRASH_KEY));
    trashLoadError = null;
  } catch (error) {
    trash = [];
    trashLoadError = String(error.message || error);
    showNotification("Trash could not be read; recovery data has been preserved");
  }
  trashNeedsSave = false;
  refreshTrashUi();
}

async function loadWorkspaceTrash(dbPath) {
  const result = await invoke("load_db_trash", { dbPath });
  if (!Array.isArray(result)) throw new Error("Workspace returned an unexpected trash response");
  return readTrash(JSON.stringify(result));
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

// Notes set aside by an earlier build of this branch, when local storage was
// shared between the local-only collection and the active workspace. Folded
// back in once so nothing is stranded; can be dropped after a release carries
// the current storage layout.
function adoptLegacyStashedNotes() {
  let stashed = null;
  try {
    stashed = readStoredNotes(localStorage.getItem(LOCAL_NOTES_BACKUP_KEY));
  } catch (error) {
    console.error("Failed to read previously set-aside notes", error);
    return false;
  }
  if (!stashed) return false;

  const byId = new Map(stashed.map(note => [note.id, note]));
  notes.forEach(note => {
    const held = byId.get(note.id);
    if (!held || (note.updatedAt || 0) >= (held.updatedAt || 0)) byId.set(note.id, note);
  });
  notes = normalizePinnedNoteOrder([...byId.values()]);

  const merged = persistNotesLocally(localStorage, notes);
  if (!merged.ok) {
    console.error("Failed to fold previously set-aside notes back in", merged.error);
    return false;
  }

  try {
    localStorage.removeItem(LOCAL_NOTES_BACKUP_KEY);
  } catch (error) {
    console.error("Failed to clear previously set-aside notes", error);
  }
  return true;
}

function updateDbUiState(isConnected) {
  if (isConnected && activeDbPath) {
    dbConnectBtn.style.display = "none";
    dbDisconnectBtn.style.display = "block";
    
    const fileName = activeDbPath.split(/[/\\]/).pop();
    workspaceMenuValue.textContent = fileName;
    workspaceMenuValue.title = activeDbPath;
    saveStatus.textContent = `Saved (${fileName})`;
    saveStatus.title = `Workspace: ${activeDbPath}`;
  } else {
    dbConnectBtn.style.display = "block";
    dbDisconnectBtn.style.display = "none";
    workspaceMenuValue.textContent = "Local notes";
    workspaceMenuValue.title = "Notes stored in local webview storage";
    
    saveStatus.textContent = "Saved";
    saveStatus.title = "Saved to local webview storage";
  }
}

async function switchMcpCollection(operation) {
  if (isWorkspaceSwitching) return;
  isWorkspaceSwitching = true;
  trashUi.close();
  try {
    await dbSaveQueue;
    await operation();
  } finally {
    mcpCollectionId = window.crypto.randomUUID();
    cancelScheduledMcpSnapshotUpdates();
    try {
      await syncMcpSnapshot();
    } catch (error) {
      console.error("Failed to update the MCP note snapshot after switching collections", error);
    } finally {
      isWorkspaceSwitching = false;
    }
  }
}

// Compaction only scrubs free pages left from before secure_delete; the
// workspace stays usable without it, so a failure is logged, not surfaced.
async function reclaimWorkspaceSpace(dbPath) {
  try {
    await invoke("vacuum_workspace", { dbPath });
  } catch (err) {
    console.error("Failed to reclaim workspace space", err);
  }
}

function connectDatabase() { return switchMcpCollection(connectDatabaseImpl); }
function disconnectDatabase() { return switchMcpCollection(disconnectDatabaseImpl); }

async function connectDatabaseImpl() {
  if (!window.__TAURI__) {
    showNotification("Workspaces are only available in the desktop app");
    return;
  }

  const localSaved = await flushPendingSaves();
  if (!localSaved) {
    showNotification("Could not save local notes; workspace not opened");
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

  const localNotes = notes.length > 0 ? notes.map((note) => ({ ...note })) : null;
  const localFolders = folders.map((folder) => ({ ...folder }));

  // Load into a local until the switch is known to be safe, so a failure here
  // leaves the active collection untouched.
  let workspaceNotes;
  let workspaceFolders;
  let workspaceTrash;
  try {
    workspaceNotes = await invoke("load_db_notes", { dbPath: path });
    if (!Array.isArray(workspaceNotes)) {
      throw new Error("Workspace returned an unexpected notes response");
    }
    workspaceFolders = await invoke("load_db_folders", { dbPath: path });
    if (!Array.isArray(workspaceFolders)) {
      throw new Error("Workspace returned an unexpected folders response");
    }
    workspaceFolders = normalizeFolders(workspaceFolders);
    workspaceTrash = await loadWorkspaceTrash(path);
  } catch (err) {
    console.error("Failed to read SQLite database", err);
    showNotification("Could not open workspace; using local notes");
    return;
  }

  await reclaimWorkspaceSpace(path);

  // Seeding deletes and rewrites the workspace's rows, so an unreadable
  // response must not be mistaken for an empty workspace.
  activeDbPath = path;

  // The local-only collection stays where it is. Nothing needs setting aside,
  // because a workspace session no longer writes to local storage at all.
  if (workspaceNotes.length > 0) {
    folders = workspaceFolders;
    notes = normalizePinnedNoteOrder(normalizeNoteFolderAssignments(workspaceNotes, folders));
  } else if (workspaceFolders.length > 0 || workspaceTrash.length > 0) {
    notes = [];
    folders = workspaceFolders;
  } else if (localNotes) {
    // Seed an empty workspace with the notes already in the app.
    folders = localFolders;
    notes = normalizePinnedNoteOrder(normalizeNoteFolderAssignments(localNotes, folders));
    try {
      await invoke("save_workspace_db", { dbPath: path, notes, folders });
    } catch (err) {
      console.error("Failed to seed SQLite workspace", err);
      activeDbPath = null;
      showNotification("Could not initialize workspace; using local notes");
      return;
    }
  }

  trash = workspaceTrash;
  trashLoadError = null;
  trashNeedsSave = false;
  refreshTrashUi();

  let preferenceSaved = true;
  try {
    await invoke("set_last_workspace", { dbPath: path });
    localStorage.removeItem("sodilaud_active_db");
  } catch (err) {
    preferenceSaved = false;
    console.error("Failed to remember workspace", err);
  }

  updateDbUiState(true);
  if (notes.length === 0) {
    createNote();
  } else {
    activeNoteId = notes[0].id;
    renderNoteList();
    loadActiveNote();
  }
  syncSecondaryNoteUi(true);
  scheduleMcpSnapshotUpdate();

  showNotification(preferenceSaved
    ? "Workspace connected!"
    : "Workspace connected, but could not be remembered");
}

async function disconnectDatabaseImpl() {
  const workspaceSaved = await flushPendingSaves();
  if (!workspaceSaved) {
    showNotification("Could not save workspace; disconnect cancelled");
    return;
  }

  if (activeDbPath) await reclaimWorkspaceSpace(activeDbPath);
  activeDbPath = null;
  localStorage.removeItem("sodilaud_active_db");

  // The local-only collection was never written over while the workspace was
  // connected, so it is simply still there.
  loadNotesFromLocalStorage();
  loadFoldersFromLocalStorage();
  loadTrashFromLocalStorage();
  notes = normalizeNoteFolderAssignments(notes, folders);

  if (notes.length === 0) {
    createNote();
  } else {
    activeNoteId = notes[0].id;
    renderNoteList();
    loadActiveNote();
  }
  syncSecondaryNoteUi(true);
  scheduleMcpSnapshotUpdate();
  
  updateDbUiState(false);
  try {
    if (window.__TAURI__) {
      await invoke("set_last_workspace", { dbPath: null });
    }
    showNotification("Workspace disconnected; using local notes");
  } catch (err) {
    console.error("Failed to forget workspace", err);
    showNotification("Disconnected, but the workspace preference could not be cleared");
  }
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
  secondaryEditor.loadText(note.content);

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
  scheduleMcpNoteUpdate(note.id);
  scheduleNoteComparisonRefresh();

  // Auto-rename if not locked
  if (!note.isTitleLocked) {
    const firstLine = note.content.trim().split("\n")[0];
    if (firstLine && firstLine.length > 0) {
      const cleanTitle = firstLine.replace(/^#+\s*/, "").trim().substring(0, 40);
      if (cleanTitle) {
        note.title = cleanTitle;
        secondaryNoteTitle.value = cleanTitle;
        populateSecondaryNoteSelect();
      }
    }
  }

  triggerSavingState();

  scheduleNoteSave(note.id, () => {
    renderNoteList(searchInput.value);
  });

  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updateSecondaryMarkdownPreview();
  }, 150);
}

function handleSecondaryTitleInput() {
  const note = notes.find(n => n.id === secondaryNoteId);
  if (!note) return;

  note.title = secondaryNoteTitle.value.trim() || "Untitled Scratchpad";
  note.isTitleLocked = true;
  note.updatedAt = Date.now();
  scheduleMcpNoteUpdate(note.id);

  triggerSavingState();

  scheduleNoteSave(note.id, () => {
    renderNoteList(searchInput.value);
    populateSecondaryNoteSelect();
  });
}

function updateSecondaryMarkdownPreview() {
  if (currentLayoutMode !== "reading") return;
  if (window.marked) {
    secondaryMarkdownPreview.innerHTML = renderMarkdown(secondaryEditor.getText());
    highlightPreviewCode(secondaryMarkdownPreview, window.hljs, appearance.syntaxHighlighting);
  }
}

function setActivePane(pane) {
  activePane = pane;
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
  
  saveNotesToStorage({ syncWorkspace: true });
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  showNotification("Note moved up");
}

function moveNoteDown(noteId) {
  const targetId = noteId || activeNoteId;
  const index = notes.findIndex(n => n.id === targetId);
  if (getNoteMoveTargetIndex(notes, index, 1) === -1) return;
  notes = moveNoteInGroup(notes, targetId, 1);
  
  saveNotesToStorage({ syncWorkspace: true });
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

  saveNotesToStorage({ syncWorkspace: true });
  renderNoteList(searchInput.value);
  populateSecondaryNoteSelect();
  showNotification(willPin ? "Note pinned to top" : "Note unpinned");
}

// ----------------------------------------------------
// Quick Notes panel
// ----------------------------------------------------
// The main window asks for a note (its start page links the Welcome note) or
// for this window's menu (where agent access lives).
async function registerQuickNotesHandlers() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    await listen("quicknotes-focus-note", ({ payload }) => {
      const note = notes.find(candidate => candidate.title === payload?.title);
      if (!note) return;
      if (isFocusMode) toggleFocusMode();
      activeNoteId = note.id;
      renderNoteList(searchInput.value);
      loadActiveNote();
    });
    await listen("quicknotes-open-menu", () => {
      toggleActionsDropdown(true);
    });
  } catch (error) {
    console.error("Failed to register the Quick Notes handlers", error);
  }
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
