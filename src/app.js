// SPDX-License-Identifier: GPL-3.0-or-later

// The main window: the start page, the Sodilaud menu and the file editor. Notes
// live in the Quick Notes panel (notes.html), which owns their storage.

import { formatAccelerator } from "./clipboard-settings.js";

export const WELCOME_NOTE_LINK_TITLE = "Welcome to Quick Notes";

const invoke = (command, args) => {
  const bridge = window.__TAURI__?.core?.invoke;
  if (typeof bridge !== "function") return Promise.reject(new Error("Not running in Sodilaud"));
  return bridge(command, args);
};

const $ = (id) => document.getElementById(id);

let quickNotesConfig = { hotkey: "", hotkeyError: null };

function renderQuickNotesHotkey() {
  const label = quickNotesConfig.hotkey ? formatAccelerator(quickNotesConfig.hotkey) : "no hotkey";
  document.querySelectorAll(".quicknotes-hotkey-text").forEach((element) => {
    element.textContent = label;
  });
}

async function loadQuickNotesConfig() {
  try {
    const config = await invoke("qn_get_config");
    if (config && typeof config === "object") quickNotesConfig = config;
  } catch (error) {
    console.error("Could not read the Quick Notes settings", error);
  }
  renderQuickNotesHotkey();
}

function showQuickNotes(focusNoteTitle = null) {
  return invoke("qn_show", { focusNoteTitle }).catch((error) => {
    console.error("Could not open Quick Notes", error);
  });
}

function attachStartPageListeners() {
  $("open-quicknotes-btn").addEventListener("click", () => showQuickNotes());
  $("open-welcome-note-link").addEventListener("click", () => showQuickNotes(WELCOME_NOTE_LINK_TITLE));
}

// Rust waits for this window's answer before quitting. Nothing here is unsaved
// yet; file buffers are flushed here once the main window edits files.
async function registerQuitHandler() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    await listen("sodilaud-quit-requested", () => {
      invoke("quit_window_done", { ok: true }).catch((error) => {
        console.error("Failed to quit Sodilaud", error);
      });
    });
    await invoke("quit_handler_ready");
  } catch (error) {
    console.error("Failed to register the quit handler", error);
  }
}

async function startApp() {
  document.documentElement.classList.add("theme-dark");
  attachStartPageListeners();
  await registerQuitHandler();
  await loadQuickNotesConfig();
}

startApp();
