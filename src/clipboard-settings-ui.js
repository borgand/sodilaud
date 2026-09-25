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

const NO_HOTKEY_MESSAGE = "That shortcut could not be registered. No hotkey is active; choose another.";

function hotkeyMessage(status) {
  if (!status?.hotkeyError) return "";
  if (!status.hotkey) return NO_HOTKEY_MESSAGE;
  return HOTKEY_MESSAGES[status.hotkeyError] ?? HOTKEY_MESSAGES.HotkeyInvalid;
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
    saveClipboardSettings(storage, settings);
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
}
