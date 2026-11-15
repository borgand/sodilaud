// SPDX-License-Identifier: GPL-3.0-or-later

// A draggable edge between a sidebar and the editor. The handle sits next to
// the panel, follows its visibility, and remembers the width in local storage.
// `side` is where the panel sits: a left panel grows when its edge moves right,
// a right panel when it moves left.

const KEY_STEP = 10;
const KEY_STEP_LARGE = 50;

export function sidebarWidthBounds(window, { min, maxFraction }) {
  return { min, max: Math.max(min, Math.round(window.innerWidth * maxFraction)) };
}

export function readStoredWidth(raw, min) {
  const width = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(width) && width >= min ? width : null;
}

export function createSidebarResizer({
  document,
  panel,
  side,
  storage,
  storageKey,
  defaultWidth,
  min = 180,
  maxFraction = 0.5,
  label
}) {
  const window = document.defaultView;
  const handle = document.createElement("div");
  handle.className = `sidebar-resizer sidebar-resizer-${side}`;
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", label);
  if (panel.id) handle.setAttribute("aria-controls", panel.id);
  handle.title = "Drag to resize, double-click to reset";
  panel.insertAdjacentElement(side === "left" ? "afterend" : "beforebegin", handle);

  let width = readStoredWidth(storage.getItem(storageKey), min);
  const grow = side === "left" ? 1 : -1;

  const bounds = () => sidebarWidthBounds(window, { min, maxFraction });
  const clamp = (value) => {
    const { min: low, max } = bounds();
    return Math.min(max, Math.max(low, Math.round(value)));
  };
  const shownWidth = () => panel.getBoundingClientRect().width || width || defaultWidth;

  function render() {
    if (width === null) panel.style.removeProperty("--sidebar-width");
    else panel.style.setProperty("--sidebar-width", `${width}px`);
    const { min: low, max } = bounds();
    handle.setAttribute("aria-valuemin", String(low));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(Math.min(max, width ?? defaultWidth)));
  }

  function save() {
    try {
      if (width === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, String(width));
    } catch (error) {
      console.warn("Could not remember the sidebar width", error);
    }
  }

  function setWidth(value, { persist = true } = {}) {
    width = clamp(value);
    render();
    if (persist) save();
  }

  function reset() {
    width = null;
    render();
    save();
  }

  function syncVisibility() {
    handle.hidden = panel.hidden;
  }

  let drag = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: shownWidth() };
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("dragging");
    document.documentElement.classList.add("sidebar-resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setWidth(drag.startWidth + grow * (event.clientX - drag.startX), { persist: false });
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    handle.releasePointerCapture?.(event.pointerId);
    handle.classList.remove("dragging");
    document.documentElement.classList.remove("sidebar-resizing");
    if (width !== null) save();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("dblclick", reset);
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const current = width ?? shownWidth();
    let next = null;
    if (event.key === "ArrowRight") next = current + grow * step;
    else if (event.key === "ArrowLeft") next = current - grow * step;
    else if (event.key === "Home") next = bounds().min;
    else if (event.key === "End") next = bounds().max;
    else if (event.key === "Enter") {
      event.preventDefault();
      reset();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setWidth(next);
  });

  new window.MutationObserver(syncVisibility).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("resize", render);
  syncVisibility();
  render();

  return { handle, width: () => width, setWidth, reset };
}
