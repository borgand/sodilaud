// SPDX-License-Identifier: GPL-3.0-or-later

// The main window's sidebar tabs: Files (open files and folders) and Outline.
// Each tab is `sidebar-tab-<name>` and controls `sidebar-panel-<name>`. Rust
// keeps the chosen tab per window; `onChange` is told when the user picks one,
// `onShow` whenever a tab is shown.

export const SIDEBAR_TABS = ["files", "outline"];
const DEFAULT_TAB = "files";

const sidebarTabName = (value) => (SIDEBAR_TABS.includes(value) ? value : DEFAULT_TAB);

export function createSidebarTabs({ document, onChange = () => {}, onShow = () => {} }) {
  const tabs = SIDEBAR_TABS.map((name) => document.getElementById(`sidebar-tab-${name}`));
  const panels = SIDEBAR_TABS.map((name) => document.getElementById(`sidebar-panel-${name}`));
  let current = null;

  function show(value, { focus = false, user = false } = {}) {
    const name = sidebarTabName(value);
    tabs.forEach((tab, index) => {
      const selected = SIDEBAR_TABS[index] === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[index].hidden = !selected;
    });
    if (focus) tabs[SIDEBAR_TABS.indexOf(name)].focus();
    onShow(name);
    const changed = name !== current;
    current = name;
    if (changed && user) onChange(name);
  }

  function onKeydown(event) {
    const index = tabs.indexOf(event.currentTarget);
    const last = tabs.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(SIDEBAR_TABS[next], { focus: true, user: true });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => show(SIDEBAR_TABS[index], { user: true }));
    tab.addEventListener("keydown", onKeydown);
  });
  show(DEFAULT_TAB);

  return {
    /** Shows a tab without reporting it, as when the window's saved tab is restored. */
    restore: (name) => show(name),
    /** Shows a tab and reports the choice. */
    select: (name) => show(name, { user: true })
  };
}
