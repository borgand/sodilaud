// SPDX-License-Identifier: GPL-3.0-or-later

// Settings only. Clipboard values never pass through this module.

export const CLIPBOARD_SETTINGS_KEY = "clipboardHistory.settings";
export const DEFAULT_CLIPBOARD_SETTINGS = Object.freeze({
  enabled: false,
  capacity: 10,
  ttlMinutes: 10,
  hotkey: "super+shift+KeyV",
  autoPaste: false
});

const LIMITS = { capacity: [1, 50], ttlMinutes: [1, 120] };
const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Slash|Backslash)$/;
const MODIFIERS = ["super", "ctrl", "alt", "shift"];

function clampInteger(value, [min, max], fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isValidAccelerator(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("+");
  const code = parts.pop();
  return KEY_CODE.test(code ?? "")
    && parts.length > 0
    && parts.every(p => MODIFIERS.includes(p))
    && parts.some(p => p !== "shift");
}

export function normalizeClipboardSettings(value) {
  const input = value && typeof value === "object" ? value : {};
  const defaults = DEFAULT_CLIPBOARD_SETTINGS;
  return {
    enabled: input.enabled === true,
    capacity: clampInteger(input.capacity, LIMITS.capacity, defaults.capacity),
    ttlMinutes: clampInteger(input.ttlMinutes, LIMITS.ttlMinutes, defaults.ttlMinutes),
    hotkey: isValidAccelerator(input.hotkey) ? input.hotkey : defaults.hotkey,
    autoPaste: input.autoPaste === true
  };
}

export function loadClipboardSettings(storage) {
  try {
    return normalizeClipboardSettings(JSON.parse(storage.getItem(CLIPBOARD_SETTINGS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_CLIPBOARD_SETTINGS };
  }
}

export function saveClipboardSettings(storage, settings) {
  storage.setItem(CLIPBOARD_SETTINGS_KEY, JSON.stringify(normalizeClipboardSettings(settings)));
}

export function acceleratorFromKeyEvent(event) {
  if (!KEY_CODE.test(event.code ?? "")) return null;
  const parts = [];
  if (event.metaKey) parts.push("super");
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (!parts.some(p => p !== "shift")) return null;
  return [...parts, event.code].join("+");
}

const SYMBOLS = { super: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };

export function formatAccelerator(accelerator) {
  const parts = accelerator.split("+");
  const code = parts.pop() ?? "";
  const ordered = ["ctrl", "alt", "super", "shift"].filter(m => parts.includes(m)).map(m => SYMBOLS[m]);
  return ordered.join("") + code.replace(/^Key|^Digit/, "");
}

export function isMacPlatform(navigatorLike) {
  const platform = navigatorLike?.userAgentData?.platform || navigatorLike?.platform || navigatorLike?.userAgent || "";
  return /mac/i.test(platform);
}
