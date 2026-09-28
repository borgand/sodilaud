// SPDX-License-Identifier: GPL-3.0-or-later

export function isMacLikePlatform(navigatorLike = globalThis.navigator) {
  const platform = navigatorLike?.userAgentData?.platform || navigatorLike?.platform || navigatorLike?.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

// Shortcut labels are written for macOS; elsewhere Cmd reads Ctrl, and Ctrl+Cmd
// chords use Ctrl+Alt.
export function applyPlatformShortcutLabels(document, navigatorLike = globalThis.navigator) {
  if (isMacLikePlatform(navigatorLike)) return;

  document.querySelectorAll("[title]").forEach((element) => {
    const title = element.getAttribute("title");
    if (title?.includes("Cmd")) {
      element.setAttribute("title", title.replaceAll("Ctrl+Cmd", "Ctrl+Alt").replaceAll("Cmd", "Ctrl"));
    }
  });

  document.querySelectorAll("kbd[data-shortcut-off-mac]").forEach((element) => {
    element.textContent = element.dataset.shortcutOffMac;
  });

  document.querySelectorAll("kbd, .shortcut-hint").forEach((element) => {
    if (element.textContent.includes("Cmd")) {
      element.textContent = element.textContent.replaceAll("Cmd", "Ctrl");
    }
  });
}
