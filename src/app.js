// SPDX-License-Identifier: GPL-3.0-or-later

// The main window: the start page, the Sodilaud menu and the file editor. Notes
// live in the Quick Notes panel (notes.html), which owns their storage.

import { acceleratorFromKeyEvent, formatAccelerator, isMacPlatform } from "./clipboard-settings.js";
import { setupClipboardHistory, syncClipboardPopupTheme } from "./clipboard-settings-ui.js";
import { createThemes } from "./themes.js";
import { createAppearance } from "./appearance.js";
import { broadcastPreference, onPreferenceChange } from "./preferences.js";
import { trapModalFocus } from "./modal-focus.js";
import { applyPlatformShortcutLabels } from "./platform-labels.js";
import { resolveLinkAction } from "./markdown.js";
import { WELCOME_NOTE_TITLE } from "./welcome-note.js";
import { createFileEditor } from "./file-editor.js";
import { isMacLikePlatform } from "./platform-labels.js";

const HOTKEY_MESSAGES = {
  HotkeyInvalid: "That shortcut is not supported. The previous hotkey is still active.",
  HotkeyUnavailable: "That shortcut is already in use. The previous hotkey is still active."
};
const NO_HOTKEY_MESSAGE = "That shortcut could not be registered. No hotkey is active; choose another.";
const DEFAULT_QUICK_NOTES_HOTKEY_MAC = "super+shift+KeyN";
const DEFAULT_QUICK_NOTES_HOTKEY_OTHER = "ctrl+shift+KeyN";

const invoke = (command, args) => {
  const bridge = window.__TAURI__?.core?.invoke;
  if (typeof bridge !== "function") return Promise.reject(new Error("Not running in Sodilaud"));
  return bridge(command, args);
};

const $ = (id) => document.getElementById(id);

const actionsBtn = $("actions-btn");
const actionsDropdown = $("actions-dropdown-content");
const helpBtn = $("help-btn");
const helpModalBackdrop = $("help-modal-backdrop");
const aboutModalBackdrop = $("about-modal-backdrop");
const aboutModal = $("about-modal");
const hotkeyBtn = $("quicknotes-hotkey-btn");
const hotkeyStatus = $("quicknotes-hotkey-status");

const isMac = isMacPlatform(navigator);
let quickNotesConfig = { hotkey: "", requested: "", hotkeyError: null, upgradeIntro: false };
let capturingHotkey = false;
let isHelpModalOpen = false;
let helpModalPreviousFocus = null;
let isAboutModalOpen = false;
let aboutModalPreviousFocus = null;
let notificationTimer = null;

const appearance = createAppearance({
  document,
  storage: localStorage,
  broadcast: (key) => broadcastPreference(window, key),
  onLineNumbers: (enabled) => fileEditor?.setLineNumbers(enabled),
  onSyntaxHighlighting: (enabled) => fileEditor?.setSyntaxHighlighting(enabled)
});
const themes = createThemes({
  document,
  storage: localStorage,
  invoke,
  onApplied: () => syncClipboardPopupTheme({ document, invoke, isMac: isMac && Boolean(window.__TAURI__) }),
  onChanged: () => broadcastPreference(window, "sodilaud_active_theme")
});

// Rendered and live-preview links: Rust shows the real destination before the
// browser opens it.
function openExternalHref(href) {
  const action = resolveLinkAction(href);
  if (action.kind !== "external") return;
  if (!window.__TAURI__) {
    window.open(action.url, "_blank", "noopener,noreferrer");
    return;
  }
  invoke("confirm_and_open_url", { url: action.url }).catch((error) => {
    console.error("Failed to open a link in the browser", error);
    showNotification("Could not open that link");
  });
}

const fileEditor = createFileEditor({
  document,
  invoke,
  storage: localStorage,
  appearance,
  broadcast: (key) => broadcastPreference(window, key),
  notify: showNotification,
  closeMenus: () => toggleActionsDropdown(false),
  openExternal: openExternalHref
});

function showNotification(message) {
  const toast = $("app-notification");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

function toggleActionsDropdown(show) {
  const open = show === undefined ? !actionsDropdown.classList.contains("show") : show;
  actionsDropdown.classList.toggle("show", open);
  actionsBtn.setAttribute("aria-expanded", String(open));
}

function closeMenuThen(action) {
  return () => {
    toggleActionsDropdown(false);
    actionsBtn.focus({ preventScroll: true });
    action();
  };
}

// ----------------------------------------------------
// Quick Notes
// ----------------------------------------------------
function hotkeyMessage(status) {
  if (!status?.hotkeyError) return "";
  if (!status.hotkey) return NO_HOTKEY_MESSAGE;
  return HOTKEY_MESSAGES[status.hotkeyError] ?? HOTKEY_MESSAGES.HotkeyInvalid;
}

function renderQuickNotes() {
  const label = quickNotesConfig.hotkey ? formatAccelerator(quickNotesConfig.hotkey) : "no hotkey";
  document.querySelectorAll(".quicknotes-hotkey-text").forEach((element) => {
    element.textContent = label;
  });
  hotkeyBtn.textContent = capturingHotkey ? "Press keys…" : label;
  hotkeyBtn.setAttribute("aria-pressed", String(capturingHotkey));
  hotkeyStatus.textContent = hotkeyMessage(quickNotesConfig);
  $("upgrade-banner").hidden = !quickNotesConfig.upgradeIntro;
}

function acceptQuickNotesStatus(status) {
  if (status && typeof status === "object") quickNotesConfig = { ...quickNotesConfig, ...status };
  renderQuickNotes();
}

async function loadQuickNotesConfig() {
  try {
    acceptQuickNotesStatus(await invoke("qn_get_config"));
  } catch (error) {
    console.error("Could not read the Quick Notes settings", error);
    renderQuickNotes();
  }
}

async function setQuickNotesHotkey(hotkey) {
  try {
    acceptQuickNotesStatus(await invoke("qn_set_hotkey", { hotkey }));
  } catch (error) {
    console.error("Could not change the Quick Notes hotkey", error);
    hotkeyStatus.textContent = "Could not change the hotkey.";
  }
}

function showQuickNotes(focusNoteTitle = null) {
  return invoke("qn_show", { focusNoteTitle }).catch((error) => {
    console.error("Could not open Quick Notes", error);
  });
}

function dismissUpgradeIntro() {
  if (!quickNotesConfig.upgradeIntro) return;
  quickNotesConfig = { ...quickNotesConfig, upgradeIntro: false };
  renderQuickNotes();
  invoke("qn_dismiss_intro").catch((error) => console.error("Could not dismiss the Quick Notes intro", error));
}

// Capture phase, so a chord being recorded never reaches another shortcut.
function handleHotkeyCapture(event) {
  if (!capturingHotkey) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "Escape") {
    capturingHotkey = false;
    renderQuickNotes();
    return true;
  }
  const accelerator = acceleratorFromKeyEvent(event);
  if (!accelerator) return true;
  capturingHotkey = false;
  renderQuickNotes();
  setQuickNotesHotkey(accelerator);
  return true;
}

// ----------------------------------------------------
// Help and About
// ----------------------------------------------------
function switchHelpTab(tabName, focusTab = false) {
  const topics = ["shortcuts", "markdown", "mcp"];
  const active = topics.includes(tabName) ? tabName : "shortcuts";
  for (const topic of topics) {
    const button = $(`tab-${topic}-btn`);
    const pane = $(`pane-${topic}`);
    const isActive = topic === active;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    pane.classList.toggle("active", isActive);
    pane.setAttribute("aria-hidden", String(!isActive));
  }
  if (focusTab) $(`tab-${active}-btn`).focus({ preventScroll: true });
}

function cycleHelpTab(backwards = false) {
  const tabs = ["shortcuts", "markdown", "mcp"];
  const current = tabs.find((tab) => $(`tab-${tab}-btn`).classList.contains("active")) || "shortcuts";
  const next = (tabs.indexOf(current) + (backwards ? -1 : 1) + tabs.length) % tabs.length;
  switchHelpTab(tabs[next], true);
}

function openHelpModal(defaultTab = "shortcuts") {
  helpModalPreviousFocus = document.activeElement;
  isHelpModalOpen = true;
  helpModalBackdrop.style.display = "flex";
  helpModalBackdrop.setAttribute("aria-hidden", "false");
  helpBtn.setAttribute("aria-expanded", "true");
  switchHelpTab(defaultTab, true);
}

function closeHelpModal() {
  isHelpModalOpen = false;
  helpModalBackdrop.style.display = "none";
  helpModalBackdrop.setAttribute("aria-hidden", "true");
  helpBtn.setAttribute("aria-expanded", "false");
  if (helpModalPreviousFocus?.isConnected) helpModalPreviousFocus.focus({ preventScroll: true });
  helpModalPreviousFocus = null;
}

function toggleHelpModal() {
  if (isHelpModalOpen) closeHelpModal();
  else openHelpModal();
}

function openAboutModal() {
  if (isAboutModalOpen) return;
  aboutModalPreviousFocus = document.activeElement;
  isAboutModalOpen = true;
  aboutModalBackdrop.style.display = "flex";
  aboutModalBackdrop.setAttribute("aria-hidden", "false");
  $("close-about-btn").focus({ preventScroll: true });
}

function closeAboutModal() {
  isAboutModalOpen = false;
  aboutModalBackdrop.style.display = "none";
  aboutModalBackdrop.setAttribute("aria-hidden", "true");
  if (aboutModalPreviousFocus?.isConnected) aboutModalPreviousFocus.focus({ preventScroll: true });
  aboutModalPreviousFocus = null;
}

// Rendered links carry target="_blank", which the desktop webview ignores; Rust
// shows the real destination before the browser opens it.
function handleLinkClick(event) {
  const link = event.target.closest("a[href]");
  if (!link) return;
  event.preventDefault();
  openExternalHref(link.getAttribute("href"));
}

// ----------------------------------------------------
// Events
// ----------------------------------------------------
function followPreferenceChange(key) {
  if (appearance.reload(key)) return;
  if (key === "sodilaud_layout_mode") {
    fileEditor.setLayoutMode(localStorage.getItem(key), { persist: false });
    return;
  }
  if (key === "sodilaud_active_theme" || key === "sodilaud_custom_themes" || key === "color-scheme") {
    themes.load();
  }
}

function openSection(section) {
  if (section === "help") {
    if (!isHelpModalOpen) openHelpModal();
  } else if (section === "settings") {
    toggleActionsDropdown(true);
  }
}

function attachListeners() {
  actionsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    fileEditor.closeFormatMenus();
    toggleActionsDropdown();
  });
  document.addEventListener("click", () => {
    toggleActionsDropdown(false);
    fileEditor.closeFormatMenus();
  });
  fileEditor.attach();
  actionsDropdown.addEventListener("click", (event) => {
    if (event.target.closest(".view-setting-row, .dropdown-note")) event.stopPropagation();
  });

  themes.attach();
  $("theme-picker-btn").addEventListener("click", () => {
    toggleActionsDropdown(false);
    themes.openModal();
  });
  appearance.attachControls();

  hotkeyBtn.addEventListener("click", () => {
    capturingHotkey = true;
    renderQuickNotes();
  });
  hotkeyBtn.addEventListener("blur", () => {
    if (!capturingHotkey) return;
    capturingHotkey = false;
    renderQuickNotes();
  });
  $("quicknotes-hotkey-reset-btn").addEventListener("click", () => {
    setQuickNotesHotkey(isMac ? DEFAULT_QUICK_NOTES_HOTKEY_MAC : DEFAULT_QUICK_NOTES_HOTKEY_OTHER);
  });
  $("open-quicknotes-menu-btn").addEventListener("click", closeMenuThen(() => showQuickNotes()));
  $("agent-access-menu-btn").addEventListener("click", closeMenuThen(async () => {
    await showQuickNotes();
    window.__TAURI__?.event?.emitTo?.("quicknotes", "quicknotes-open-menu")
      ?.catch?.((error) => console.error("Could not open the Quick Notes menu", error));
  }));

  $("open-quicknotes-btn").addEventListener("click", () => {
    dismissUpgradeIntro();
    showQuickNotes();
  });
  $("open-welcome-note-link").addEventListener("click", () => {
    dismissUpgradeIntro();
    showQuickNotes(WELCOME_NOTE_TITLE);
  });
  $("upgrade-banner-open-btn").addEventListener("click", () => {
    dismissUpgradeIntro();
    showQuickNotes();
  });
  $("upgrade-banner-dismiss-btn").addEventListener("click", dismissUpgradeIntro);

  helpBtn.addEventListener("click", () => openHelpModal());
  $("help-menu-btn").addEventListener("click", closeMenuThen(() => openHelpModal()));
  $("close-help-btn").addEventListener("click", closeHelpModal);
  helpModalBackdrop.addEventListener("click", (event) => {
    if (event.target === helpModalBackdrop) closeHelpModal();
  });
  for (const topic of ["shortcuts", "markdown", "mcp"]) {
    $(`tab-${topic}-btn`).addEventListener("click", () => switchHelpTab(topic));
  }

  $("about-menu-btn").addEventListener("click", closeMenuThen(openAboutModal));
  $("close-about-btn").addEventListener("click", closeAboutModal);
  aboutModalBackdrop.addEventListener("click", (event) => {
    if (event.target === aboutModalBackdrop) closeAboutModal();
  });
  aboutModal.addEventListener("click", handleLinkClick);

  document.addEventListener("keydown", (event) => {
    if (handleHotkeyCapture(event)) return;
  }, true);
  document.addEventListener("keydown", handleKeydown);
}

function handleKeydown(event) {
  const isMeta = event.metaKey || event.ctrlKey;
  const plainTab = event.key === "Tab" && !isMeta && !event.altKey;

  if (themes.isModalOpen() && plainTab) {
    trapModalFocus(event, themes.modal);
    return;
  }
  if (isHelpModalOpen && plainTab) {
    event.preventDefault();
    cycleHelpTab(event.shiftKey);
    return;
  }
  if (isAboutModalOpen && plainTab) {
    trapModalFocus(event, aboutModal);
    return;
  }
  if (appearance.handleZoomShortcut(event)) return;
  if (isSidebarShortcut(event)) {
    event.preventDefault();
    fileEditor.toggleSidebar();
    return;
  }
  if (fileEditor.handleShortcut(event)) return;

  // Disable browser inspect shortcuts and accidental page reloads.
  if (
    event.key === "F12" ||
    (isMeta && event.altKey && event.key.toLowerCase() === "i") ||
    (isMeta && event.shiftKey && event.key.toLowerCase() === "i") ||
    (isMeta && event.key.toLowerCase() === "r")
  ) {
    event.preventDefault();
  }
  if ((isMeta && (event.key === "/" || event.key === "?")) || event.key === "F1") {
    event.preventDefault();
    toggleHelpModal();
    return;
  }
  if (event.key === "Escape") {
    if (isAboutModalOpen) {
      event.preventDefault();
      closeAboutModal();
    } else if (themes.isModalOpen()) {
      event.preventDefault();
      themes.closeModal();
    } else if (isHelpModalOpen) {
      event.preventDefault();
      closeHelpModal();
    } else if (actionsDropdown.classList.contains("show")) {
      event.preventDefault();
      toggleActionsDropdown(false);
    }
  }
}

// Ctrl+Cmd+S on macOS; Ctrl+Alt+S elsewhere, as in Quick Notes.
function isSidebarShortcut(event) {
  if (!event.ctrlKey || event.shiftKey) return false;
  if (isMacLikePlatform(navigator)) {
    return event.metaKey && !event.altKey && (event.code === "KeyS" || event.key.toLowerCase() === "s");
  }
  return event.altKey && !event.metaKey && event.key.toLowerCase() === "s";
}

// Rust waits for this window's answer before quitting: every open file is
// saved first, and an unsaved new file is asked about.
async function registerQuitHandler(listen) {
  let quitting = false;
  await listen("sodilaud-quit-requested", async () => {
    if (quitting) return;
    quitting = true;
    let ok = false;
    try {
      ok = await fileEditor.flushForQuit();
    } catch (error) {
      console.error("Failed to save files before quitting", error);
    } finally {
      quitting = false;
    }
    invoke("quit_window_done", { ok }).catch((error) => {
      console.error("Failed to quit Sodilaud", error);
    });
  });
  await invoke("quit_handler_ready");
}

async function registerNativeHandlers() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    await registerQuitHandler(listen);
    await listen("sodilaud-open-about", openAboutModal);
    await listen("sodilaud-open-section", ({ payload }) => openSection(payload));
    await listen("file-doc-updates", ({ payload }) => fileEditor.receiveUpdates(payload));
    await listen("file-doc-saved", ({ payload }) => fileEditor.handleSaved(payload));
    await listen("file-doc-external", ({ payload }) => fileEditor.handleExternal(payload));
    await listen("file-open-request", () => fileEditor.takePending());
  } catch (error) {
    console.error("Failed to register the main window's native handlers", error);
  }
}

async function startApp() {
  applyPlatformShortcutLabels(document, navigator);
  attachListeners();
  themes.load();
  appearance.load();
  await registerNativeHandlers();
  await onPreferenceChange(window, followPreferenceChange);
  try {
    await setupClipboardHistory({
      document,
      invoke,
      listen: window.__TAURI__?.event?.listen,
      storage: localStorage,
      notify: showNotification,
      isMac: isMac && Boolean(window.__TAURI__)
    });
  } catch (error) {
    console.error("Failed to set up clipboard history", error);
  }
  await loadQuickNotesConfig();
  await fileEditor.restore();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", startApp, { once: true });
} else {
  startApp();
}
