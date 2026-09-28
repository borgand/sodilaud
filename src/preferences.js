// SPDX-License-Identifier: GPL-3.0-or-later

// Preferences both windows share. localStorage is the source of truth; the event
// only tells the other window which key to re-read.

export const PREFERENCES_CHANGED_EVENT = "prefs-changed";

function currentLabel(window) {
  try {
    return window.__TAURI__?.window?.getCurrentWindow?.()?.label ?? null;
  } catch {
    return null;
  }
}

export function broadcastPreference(window, key) {
  const emit = window.__TAURI__?.event?.emit;
  if (typeof emit !== "function") return;
  Promise.resolve()
    .then(() => emit(PREFERENCES_CHANGED_EVENT, { key, source: currentLabel(window) }))
    .catch((error) => console.error("Could not share a preference change", error));
}

// Calls `handler(key)` for changes made in another window.
export async function onPreferenceChange(window, handler) {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  const own = currentLabel(window);
  try {
    await listen(PREFERENCES_CHANGED_EVENT, ({ payload }) => {
      if (!payload || typeof payload.key !== "string") return;
      if (own !== null && payload.source === own) return;
      handler(payload.key);
    });
  } catch (error) {
    console.error("Could not follow preference changes", error);
  }
}
