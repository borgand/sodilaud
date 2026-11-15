// SPDX-License-Identifier: GPL-3.0-or-later

// The Name Window dialog. A named window shows its name in the title bar and in
// other windows' Move to Window menu, and agents open files in it by that name.

import { trapModalFocus } from "./modal-focus.js";

export function createWindowNameDialog({ document, invoke, onNamed = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const backdrop = $("window-name-modal-backdrop");
  const modal = $("window-name-modal");
  const form = $("window-name-form");
  const input = $("window-name-input");
  const error = $("window-name-error");
  let previousFocus = null;
  let saving = false;

  const isOpen = () => backdrop.style.display !== "none";

  async function open() {
    if (isOpen()) return;
    previousFocus = document.activeElement;
    let name = null;
    try {
      name = await invoke("main_window_name");
    } catch (failure) {
      console.error("Could not read the window name", failure);
    }
    input.value = typeof name === "string" ? name : "";
    error.textContent = "";
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    input.focus({ preventScroll: true });
    input.select();
  }

  function close() {
    if (!isOpen()) return;
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    try {
      onNamed(await invoke("main_window_set_name", { name: input.value }));
      close();
    } catch (failure) {
      error.textContent = failure?.message ?? String(failure);
      input.focus({ preventScroll: true });
    } finally {
      saving = false;
    }
  });
  $("window-name-cancel-btn").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      trapModalFocus(event, modal);
    }
  });

  return { open, close, isOpen };
}
