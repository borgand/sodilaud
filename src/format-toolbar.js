// SPDX-License-Identifier: GPL-3.0-or-later

// The formatting toolbar in both windows: buttons that fit, a More menu for the
// rest, and the heading menu. The page says how to apply an action.

import { getVisibleItemCount } from "./format-toolbar-fit.js";

export function createFormatToolbar({ document, applyFormat, onMenuOpen = () => {}, observe = [] }) {
  const window = document.defaultView;
  const byId = (id) => document.getElementById(id);
  const formatControls = byId("format-controls");
  const formatHeadingBtn = byId("format-heading-btn");
  const formatHeadingMenu = byId("format-heading-menu");
  const formatMoreBtn = byId("format-more-btn");
  const formatMoreMenu = byId("format-more-menu");
  const formatMenus = [
    { trigger: formatHeadingBtn, menu: formatHeadingMenu },
    { trigger: formatMoreBtn, menu: formatMoreMenu, build: buildFormatMoreMenu }
  ];

  function setFormatControlsEnabled(enabled) {
    formatControls.setAttribute("aria-disabled", String(!enabled));
    formatControls.querySelectorAll("button").forEach((button) => { button.disabled = !enabled; });
    formatHeadingMenu.querySelectorAll("button").forEach((button) => { button.disabled = !enabled; });
    if (!enabled) closeFormatMenus();
  }

  function setFormatMenuOpen(entry, open) {
    if (open) {
      closeFormatMenus(entry);
      onMenuOpen();
      entry.build?.();
      entry.menu.style.left = `${entry.trigger.offsetLeft}px`;
    }
    entry.menu.hidden = !open;
    entry.trigger.setAttribute("aria-expanded", String(open));
  }

  function closeFormatMenus(except) {
    let closed = false;
    for (const entry of formatMenus) {
      if (entry === except || entry.menu.hidden) continue;
      setFormatMenuOpen(entry, false);
      closed = true;
    }
    return closed;
  }

  function formatMenuItems(menu) {
    return [...menu.querySelectorAll("[role='menuitem']:not([disabled])")];
  }

  function focusFormatMenuItem(menu, index) {
    const items = formatMenuItems(menu);
    if (items.length === 0) return;
    items[(index + items.length) % items.length].focus();
  }

  function shortcutFromTitle(title) {
    const match = /\(([^()]*\+[^()]*)\)\s*$/.exec(title ?? "");
    return match ? match[1] : "";
  }

  function createFormatMenuItem(actionId, label, shortcut) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dropdown-item format-menu-item";
    item.id = `format-more-${actionId}`;
    item.dataset.format = actionId;
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    item.append(labelSpan);
    if (shortcut) {
      const shortcutSpan = document.createElement("span");
      shortcutSpan.className = "format-menu-shortcut";
      shortcutSpan.textContent = shortcut;
      item.append(" ", shortcutSpan);
    }
    return item;
  }

  function buildFormatMoreMenu() {
    const items = [];
    for (const { button } of formatToolbarUnits()) {
      if (!button.hidden) continue;
      if (button === formatHeadingBtn) {
        for (const heading of formatMenuItems(formatHeadingMenu)) {
          items.push(createFormatMenuItem(heading.dataset.format, heading.textContent.trim(), shortcutFromTitle(heading.title)));
        }
      } else {
        items.push(createFormatMenuItem(button.dataset.format, button.getAttribute("aria-label"), shortcutFromTitle(button.title)));
      }
    }
    formatMoreMenu.replaceChildren(...items);
  }

  // Each button paired with the separator in front of it, in priority order.
  function formatToolbarUnits() {
    const units = [];
    let separator = null;
    for (const element of formatControls.children) {
      if (element.classList.contains("format-separator")) {
        separator = element;
      } else if (element !== formatMoreBtn) {
        units.push({ button: element, separator });
        separator = null;
      }
    }
    return units;
  }

  function outerWidth(element) {
    const style = window.getComputedStyle(element);
    return element.offsetWidth + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
  }

  // Shows every button once to measure, then hides the ones that do not fit so
  // they leave the tab order and appear in the More formatting menu instead.
  function layoutFormatToolbar() {
    const units = formatToolbarUnits();
    const wasVisible = units.filter(unit => !unit.button.hidden).length;
    for (const unit of units) {
      unit.button.hidden = false;
      if (unit.separator) unit.separator.hidden = false;
    }
    formatMoreBtn.hidden = false;
    const style = window.getComputedStyle(formatControls);
    const gap = parseFloat(style.columnGap) || 0;
    const moreWidth = outerWidth(formatMoreBtn) + gap;
    formatMoreBtn.hidden = true;

    const available = formatControls.clientWidth -
      (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) + gap;
    const widths = units.map(unit => outerWidth(unit.button) + gap + (unit.separator ? outerWidth(unit.separator) + gap : 0));
    const visible = getVisibleItemCount(available, widths, moreWidth);

    units.forEach((unit, index) => {
      unit.button.hidden = index >= visible;
      if (unit.separator) unit.separator.hidden = index >= visible;
    });
    formatMoreBtn.hidden = visible === units.length;
    if (visible !== wasVisible) closeFormatMenus();
  }

  function handleFormatControlClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    event.stopPropagation();
    const entry = formatMenus.find(candidate => candidate.trigger === button);
    if (entry) {
      const open = entry.menu.hidden;
      setFormatMenuOpen(entry, open);
      if (open && event.detail === 0) focusFormatMenuItem(entry.menu, 0);
      return;
    }
    if (!button.dataset.format) return;
    closeFormatMenus();
    onMenuOpen();
    applyFormat(button.dataset.format);
  }

  function handleFormatMenuKeydown(entry, event) {
    const items = formatMenuItems(entry.menu);
    const index = items.indexOf(document.activeElement);
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      focusFormatMenuItem(entry.menu, moves[event.key]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setFormatMenuOpen(entry, false);
      entry.trigger.focus();
    } else if (event.key === "Tab") {
      // The menus sit after the toolbar in the DOM, so Tab continues from the trigger.
      setFormatMenuOpen(entry, false);
      entry.trigger.focus();
    }
  }

  function handleFormatTriggerKeydown(entry, event) {
    if (entry.trigger.disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setFormatMenuOpen(entry, true);
      focusFormatMenuItem(entry.menu, event.key === "ArrowDown" ? 0 : -1);
    } else if (event.key === "Escape" && !entry.menu.hidden) {
      event.stopPropagation();
      setFormatMenuOpen(entry, false);
    }
  }

  function attach() {
    // Keeping focus in the editor on mousedown keeps its selection for the click.
    for (const container of [formatControls, formatHeadingMenu, formatMoreMenu]) {
      container.addEventListener("mousedown", (event) => {
        if (event.target.closest("button")) event.preventDefault();
      });
      container.addEventListener("click", handleFormatControlClick);
    }
    for (const entry of formatMenus) {
      entry.menu.addEventListener("keydown", (event) => handleFormatMenuKeydown(entry, event));
      entry.trigger.addEventListener("keydown", (event) => handleFormatTriggerKeydown(entry, event));
    }
    window.addEventListener("resize", layoutFormatToolbar);
    if (typeof window.ResizeObserver === "function") {
      const observer = new window.ResizeObserver(() => layoutFormatToolbar());
      for (const selector of observe) {
        const element = document.querySelector(selector);
        if (element) observer.observe(element);
      }
    }
    document.fonts?.ready.then(layoutFormatToolbar);
    layoutFormatToolbar();
  }

  return {
    attach,
    layout: layoutFormatToolbar,
    setEnabled: setFormatControlsEnabled,
    closeMenus: closeFormatMenus
  };
}
