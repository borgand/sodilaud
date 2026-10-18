// SPDX-License-Identifier: GPL-3.0-or-later

// Every main window registers the same listeners. A plain listen also hears
// events Rust sends to another window, so each window listens only for its own.

export function ownLabel(window) {
  try {
    return window.__TAURI__?.window?.getCurrentWindow?.()?.label ?? null;
  } catch {
    return null;
  }
}

export async function listenHere(window, name, handler) {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return undefined;
  return listen(name, handler, { target: { kind: "WebviewWindow", label: ownLabel(window) } });
}
