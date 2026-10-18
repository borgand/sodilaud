// SPDX-License-Identifier: GPL-3.0-or-later

// Preferences both windows share. localStorage is the source of truth; the event
// only tells the other window which key to re-read.

import { ownLabel } from "./window-events.js";

export const PREFERENCES_CHANGED_EVENT = "prefs-changed";

export function broadcastPreference(window, key) {
  const emit = window.__TAURI__?.event?.emit;
  if (typeof emit !== "function") return;
  Promise.resolve()
    .then(() => emit(PREFERENCES_CHANGED_EVENT, { key, source: ownLabel(window) }))
    .catch((error) => console.error("Could not share a preference change", error));
}

// Calls `handler(key)` for changes made in another window.
export async function onPreferenceChange(window, handler) {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  const own = ownLabel(window);
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
