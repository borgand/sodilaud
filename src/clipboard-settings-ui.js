// SPDX-License-Identifier: GPL-3.0-or-later

import {
  DEFAULT_CLIPBOARD_SETTINGS, acceleratorFromKeyEvent, formatAccelerator,
  loadClipboardSettings, normalizeClipboardSettings, saveClipboardSettings
} from "./clipboard-settings.js";
import { createCssColorResolver } from "./css-color.js";
import { toHex } from "./theme-colors.js";

const STOPPED_EVENT = "clipboard-history-stopped";
const HOTKEY_MESSAGES = {
  HotkeyInvalid: "That shortcut is not supported. The previous hotkey is still active.",
  HotkeyUnavailable: "That shortcut is already in use. The previous hotkey is still active."
};

const NO_HOTKEY_MESSAGE = "That shortcut could not be registered. No hotkey is active; choose another.";

function hotkeyMessage(status) {
  if (!status?.hotkeyError) return "";
  if (!status.hotkey) return NO_HOTKEY_MESSAGE;
  return HOTKEY_MESSAGES[status.hotkeyError] ?? HOTKEY_MESSAGES.HotkeyInvalid;
}

// The six main-window variables that best match what the popup needs (see
// src/styles.css :root and PopupTheme in src-tauri/src/clipboard/service.rs).
//
// `surface` reads --bg-note-hover rather than --bg-input: a custom theme
// (applyTheme in main.js) never sets --bg-input inline, only the built-in
// light/dark class rules define it, so the popup would always fall back to
// the generic default under a custom theme. --bg-note-hover is the surface
// tone the main window itself derives and sets inline for every measurable
// custom theme (deriveThemeSurfaceColors in theme-colors.js), and in the
// built-in themes it is the same tone as --bg-input, so this changes nothing
// about what the main window displays.
const POPUP_THEME_VARS = {
  background: "--bg-app",
  surface: "--bg-note-hover",
  text: "--text-primary",
  muted: "--text-muted",
  accent: "--accent-color",
  border: "--border-color"
};

function colorVarToHex(raw, resolveCssColor) {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const resolved = resolveCssColor(raw.trim());
  if (!resolved) return undefined;
  const hex = toHex(resolved.rgb);
  if (resolved.alpha >= 1) return hex;
  return hex + Math.round(resolved.alpha * 255).toString(16).padStart(2, "0");
}

function readPopupTheme(document) {
  const view = document?.defaultView;
  if (!view?.getComputedStyle) return {};
  const computed = view.getComputedStyle(document.documentElement);
  const resolveCssColor = createCssColorResolver(document);
  const theme = {};
  for (const [key, cssVar] of Object.entries(POPUP_THEME_VARS)) {
    const hex = colorVarToHex(computed.getPropertyValue(cssVar), resolveCssColor);
    if (hex) theme[key] = hex;
  }
  return theme;
}

// Called at clipboard setup and again whenever the main window's theme
// changes (see applyTheme in main.js). `isMac` is the same gate setup uses --
// on any other platform, or before setup ran, this is a silent no-op. Never
// throws: a failure here must not break theme switching.
export async function syncClipboardPopupTheme({ document, invoke, isMac } = {}) {
  if (!isMac || !document || typeof invoke !== "function") return;
  try {
    await invoke("clip_set_theme", { theme: readPopupTheme(document) });
  } catch {
    // Swallowed: the popup keeps its own default colours.
  }
}

export async function setupClipboardHistory({ document, invoke, listen, storage, notify, isMac }) {
  if (!isMac) return;
  const $ = (id) => document.getElementById(id);
  $("clipboard-history-menu-section").hidden = false;
  $("clipboard-history-menu-divider").hidden = false;

  const backdrop = $("clipboard-settings-modal-backdrop");
  const hotkeyBtn = $("clipboard-hotkey-btn");

  let settings = loadClipboardSettings(storage);
  let accessibilityTrusted = false;
  let capturing = false;
  let open = false;

  function setStatus(text) {
    $("clipboard-settings-status").textContent = text;
  }

  function render() {
    const toggle = $("clipboard-history-toggle-btn");
    toggle.textContent = settings.enabled ? "On" : "Off";
    toggle.setAttribute("aria-pressed", String(settings.enabled));
    $("clipboard-capacity-input").value = String(settings.capacity);
    $("clipboard-ttl-input").value = String(settings.ttlMinutes);
    hotkeyBtn.textContent = capturing ? "Press a shortcut…" : formatAccelerator(settings.hotkey);
    const autoPaste = $("clipboard-autopaste-toggle-btn");
    autoPaste.textContent = settings.autoPaste ? "On" : "Off";
    autoPaste.setAttribute("aria-pressed", String(settings.autoPaste));
    $("clipboard-accessibility-row").hidden = !(settings.autoPaste && !accessibilityTrusted);
  }

  function openModal() {
    open = true;
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    render();
    $("clipboard-capacity-input").focus({ preventScroll: true });
  }

  function closeModal() {
    open = false;
    capturing = false;
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
    render();
  }

  async function apply(next) {
    const requested = normalizeClipboardSettings(next);
    try {
      const status = await invoke("clip_set_config", { config: requested });
      accessibilityTrusted = status?.accessibilityTrusted === true;
      // An empty hotkey means none is registered: keep the request so it can be retried.
      settings = { ...requested, hotkey: status?.hotkey || requested.hotkey };
      setStatus(hotkeyMessage(status));
    } catch {
      settings = { ...requested, enabled: false };
      setStatus("Clipboard history could not be started.");
    }
    try {
      saveClipboardSettings(storage, settings);
    } catch {
      // Storage can be full; the settings still apply for this session.
    }
    render();
  }

  $("clipboard-history-toggle-btn").addEventListener("click", () => apply({ ...settings, enabled: !settings.enabled }));
  $("clipboard-settings-btn").addEventListener("click", openModal);
  $("close-clipboard-settings-btn").addEventListener("click", closeModal);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) closeModal(); });
  function applyNumber(key, input) {
    const value = input.value.trim() === "" ? NaN : Number(input.value);
    if (!Number.isFinite(value)) { render(); return; }
    apply({ ...settings, [key]: value });
  }

  $("clipboard-capacity-input").addEventListener("change", (e) => applyNumber("capacity", e.target));
  $("clipboard-ttl-input").addEventListener("change", (e) => applyNumber("ttlMinutes", e.target));
  hotkeyBtn.addEventListener("click", () => { capturing = true; render(); });
  hotkeyBtn.addEventListener("blur", () => { if (capturing) { capturing = false; render(); } });
  $("clipboard-hotkey-reset-btn").addEventListener("click", () => apply({ ...settings, hotkey: DEFAULT_CLIPBOARD_SETTINGS.hotkey }));
  $("clipboard-autopaste-toggle-btn").addEventListener("click", () => apply({ ...settings, autoPaste: !settings.autoPaste }));
  $("clipboard-accessibility-open-btn").addEventListener("click", () => invoke("open_accessibility_settings").catch(() => {}));

  // Capture phase, so this preempts main.js's bubble-phase global shortcut
  // handler on document while the modal is open. A capturing keydown is
  // handled here too, since stopping propagation this early would otherwise
  // keep it from ever reaching a listener on the hotkey button itself.
  document.addEventListener("keydown", (event) => {
    if (!open) return;
    event.stopImmediatePropagation();
    if (capturing) {
      if (event.key === "Escape") { event.preventDefault(); capturing = false; render(); return; }
      event.preventDefault();
      const accelerator = acceleratorFromKeyEvent(event);
      if (!accelerator) return;
      capturing = false;
      apply({ ...settings, hotkey: accelerator });
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); closeModal(); }
  }, true);

  if (typeof listen === "function") {
    await listen(STOPPED_EVENT, async () => {
      await apply({ ...settings, enabled: false });
      setStatus("Clipboard history stopped unexpectedly and was cleared.");
      notify?.("Clipboard history stopped unexpectedly");
    });
  }

  await apply(settings);
  await syncClipboardPopupTheme({ document, invoke, isMac });
}
