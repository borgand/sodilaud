// SPDX-License-Identifier: GPL-3.0-or-later

import {
  DEFAULT_CLIPBOARD_SETTINGS, acceleratorFromKeyEvent, formatAccelerator,
  loadClipboardSettings, normalizeClipboardSettings, saveClipboardSettings
} from "./clipboard-settings.js";

const STOPPED_EVENT = "clipboard-history-stopped";
const HOTKEY_MESSAGES = {
  HotkeyInvalid: "That shortcut is not supported. The previous hotkey is still active.",
  HotkeyUnavailable: "That shortcut is already in use. The previous hotkey is still active."
};

export async function setupClipboardHistory({ document, invoke, listen, storage, notify, isMac }) {
  if (!isMac) return;
  const $ = (id) => document.getElementById(id);
  $("clipboard-history-menu-section").hidden = false;
  $("clipboard-history-menu-divider").hidden = false;

  let settings = loadClipboardSettings(storage);
  let accessibilityTrusted = false;
  let capturing = false;

  function setStatus(text) {
    $("clipboard-settings-status").textContent = text;
  }

  function render() {
    const toggle = $("clipboard-history-toggle-btn");
    toggle.textContent = settings.enabled ? "On" : "Off";
    toggle.setAttribute("aria-pressed", String(settings.enabled));
    $("clipboard-capacity-input").value = String(settings.capacity);
    $("clipboard-ttl-input").value = String(settings.ttlMinutes);
    $("clipboard-hotkey-btn").textContent = capturing ? "Press a shortcut…" : formatAccelerator(settings.hotkey);
    const autoPaste = $("clipboard-autopaste-toggle-btn");
    autoPaste.textContent = settings.autoPaste ? "On" : "Off";
    autoPaste.setAttribute("aria-pressed", String(settings.autoPaste));
    $("clipboard-accessibility-row").hidden = !(settings.autoPaste && !accessibilityTrusted);
  }

  async function apply(next) {
    const requested = normalizeClipboardSettings(next);
    try {
      const status = await invoke("clip_set_config", { config: requested });
      accessibilityTrusted = status?.accessibilityTrusted === true;
      settings = { ...requested, hotkey: status?.hotkey ?? requested.hotkey };
      setStatus(status?.hotkeyError ? HOTKEY_MESSAGES[status.hotkeyError] ?? HOTKEY_MESSAGES.HotkeyInvalid : "");
    } catch {
      settings = { ...requested, enabled: false };
      setStatus("Clipboard history could not be started.");
    }
    saveClipboardSettings(storage, settings);
    render();
  }

  $("clipboard-history-toggle-btn").addEventListener("click", () => apply({ ...settings, enabled: !settings.enabled }));
  $("clipboard-settings-btn").addEventListener("click", () => {
    const backdrop = $("clipboard-settings-modal-backdrop");
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    render();
  });
  $("close-clipboard-settings-btn").addEventListener("click", () => {
    const backdrop = $("clipboard-settings-modal-backdrop");
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
    capturing = false;
  });
  $("clipboard-capacity-input").addEventListener("change", (e) => apply({ ...settings, capacity: Number(e.target.value) }));
  $("clipboard-ttl-input").addEventListener("change", (e) => apply({ ...settings, ttlMinutes: Number(e.target.value) }));
  $("clipboard-hotkey-btn").addEventListener("click", () => { capturing = true; render(); });
  $("clipboard-hotkey-btn").addEventListener("keydown", (event) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { capturing = false; render(); return; }
    const accelerator = acceleratorFromKeyEvent(event);
    if (!accelerator) return;
    capturing = false;
    apply({ ...settings, hotkey: accelerator });
  });
  $("clipboard-hotkey-reset-btn").addEventListener("click", () => apply({ ...settings, hotkey: DEFAULT_CLIPBOARD_SETTINGS.hotkey }));
  $("clipboard-autopaste-toggle-btn").addEventListener("click", () => apply({ ...settings, autoPaste: !settings.autoPaste }));
  $("clipboard-accessibility-open-btn").addEventListener("click", () => invoke("open_accessibility_settings").catch(() => {}));

  if (typeof listen === "function") {
    await listen(STOPPED_EVENT, async () => {
      await apply({ ...settings, enabled: false });
      setStatus("Clipboard history stopped unexpectedly and was cleared.");
      notify?.("Clipboard history stopped unexpectedly");
    });
  }

  await apply(settings);
}
