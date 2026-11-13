// SPDX-License-Identifier: GPL-3.0-or-later

// The main window's title. On macOS the window has an overlay title bar, so
// the toolbar row is the top strip: it leaves room for the traffic lights,
// shows the file name and drags the window. Linux and Windows keep the native
// title bar. Everywhere the native title, which Mission Control and the Window
// menu show, is the file name.

export const TITLE_MIN_WIDTH = 120;

// Marks the root for the macOS layout and makes the toolbar row's empty space
// a drag region. Buttons stay clickable; open menus do not drag the window.
export function applyTitleBarLayout(document) {
  document.documentElement.classList.add("platform-mac");
  document.querySelector(".main-topbar")?.setAttribute("data-tauri-drag-region", "deep");
  document.querySelectorAll(".main-topbar .format-menu, .main-topbar .dropdown-content").forEach((menu) => {
    menu.setAttribute("data-tauri-drag-region", "false");
  });
}

export function nativeWindowTitle(fileName, windowName) {
  const base = fileName || "Sodilaud";
  return windowName ? `${base} - ${windowName}` : base;
}

// Keeps the window name in the toolbar row and the native title in step with
// the file shown and the window's name.
export function createWindowTitle({ document, setNativeTitle }) {
  const nameLabel = document.getElementById("main-window-name");
  let fileName = null;
  let windowName = null;
  let applied = null;

  function render() {
    nameLabel.textContent = windowName ?? "";
    nameLabel.hidden = !windowName;
    const text = nativeWindowTitle(fileName, windowName);
    if (text === applied) return;
    applied = text;
    Promise.resolve(setNativeTitle(text)).catch((error) => console.error("Could not set the window title", error));
  }

  return {
    setFile(name) {
      fileName = name || null;
      render();
    },
    setWindowName(name) {
      windowName = typeof name === "string" && name.trim() ? name : null;
      render();
    }
  };
}
