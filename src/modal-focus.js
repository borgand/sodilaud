// SPDX-License-Identifier: GPL-3.0-or-later

// Keeps Tab and Shift+Tab inside an open modal.
export function trapModalFocus(event, modal) {
  const document = modal.ownerDocument;
  const focusable = [...modal.querySelectorAll(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"
  )].filter((element) => !element.closest("[hidden]") &&
    (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if ((event.shiftKey && document.activeElement === first) ||
      (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
