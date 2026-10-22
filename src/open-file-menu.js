// SPDX-License-Identifier: GPL-3.0-or-later

// The context menu of a file in the open files list: move it to a new or to
// another main window, or close it.

const MARGIN = 8;

export function createOpenFileMenu({ document, root, invoke, onMove, onClose }) {
  const view = document.defaultView;
  let anchor = null;
  // Each open() takes a number, so a slow window list cannot reopen a menu
  // that was closed or opened again meanwhile.
  let opening = 0;

  const isOpen = () => !root.hidden;
  const levelOf = (element) => element.closest(".context-menu-submenu-content") ?? root;
  const enabledIn = (level) => [...level.children]
    .map((child) => (child.classList.contains("context-menu-submenu") ? child.firstElementChild : child))
    .filter((item) => item?.classList.contains("context-menu-item") && !item.disabled);

  function item(text, action, { disabled = false, title = "" } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = text;
    button.disabled = disabled;
    if (title) button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      action();
    });
    return button;
  }

  function setSubmenuOpen(group, open) {
    group.classList.toggle("open", open);
    group.firstElementChild.setAttribute("aria-expanded", String(open));
  }

  function submenu(buffer, windows) {
    const group = document.createElement("div");
    group.className = "context-menu-submenu";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "context-menu-item";
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = "Move to Window";
    const caret = document.createElement("span");
    caret.className = "context-menu-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "›";
    trigger.append(label, caret);
    const content = document.createElement("div");
    content.className = "context-menu-submenu-content";
    content.setAttribute("role", "menu");
    content.setAttribute("aria-label", "Move to Window");
    content.append(...windows.map((entry) => item(`Window ${entry.number} - ${entry.title}`, () => onMove(buffer.id, entry.label))));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      setSubmenuOpen(group, true);
      enabledIn(content)[0]?.focus();
    });
    group.append(trigger, content);
    return group;
  }

  function place({ x, y }) {
    const rect = root.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(x, view.innerWidth - rect.width - MARGIN));
    const top = Math.max(MARGIN, Math.min(y, view.innerHeight - rect.height - MARGIN));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.classList.toggle("submenu-opens-left", left + rect.width * 2 > view.innerWidth);
  }

  async function open(buffer, at, from) {
    const ticket = (opening += 1);
    let windows = [];
    try {
      const listed = await invoke("main_window_list");
      if (Array.isArray(listed)) windows = listed;
    } catch (error) {
      console.error("Could not list the other windows", error);
    }
    if (ticket !== opening) return;
    anchor = from ?? null;
    const saved = buffer.path !== null;
    const disabled = { disabled: !saved, title: saved ? "" : "Save the file first" };
    const items = [item("Move to New Window", () => onMove(buffer.id, null), disabled)];
    if (windows.length && saved) items.push(submenu(buffer, windows));
    const divider = document.createElement("div");
    divider.className = "context-menu-divider";
    items.push(divider, item("Close", () => onClose(buffer.id)));
    root.replaceChildren(...items);
    root.setAttribute("aria-label", `${buffer.name} actions`);
    root.hidden = false;
    place(at);
    enabledIn(root)[0]?.focus();
  }

  function hide({ restoreFocus }) {
    opening += 1;
    if (!isOpen()) return;
    root.hidden = true;
    root.replaceChildren();
    const target = anchor;
    anchor = null;
    if (restoreFocus) target?.focus({ preventScroll: true });
  }

  const close = () => hide({ restoreFocus: true });

  function move(current, step) {
    const items = enabledIn(levelOf(current));
    if (!items.length) return;
    const index = items.indexOf(current);
    items[(index + step + items.length) % items.length].focus();
  }

  root.addEventListener("keydown", (event) => {
    const current = document.activeElement;
    const group = current?.parentElement?.classList.contains("context-menu-submenu") ? current.parentElement : null;
    const inSubmenu = levelOf(current) !== root;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      move(current, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "ArrowRight" && group) {
      current.click();
    } else if ((event.key === "ArrowLeft" || event.key === "Escape") && inSubmenu) {
      const parent = current.closest(".context-menu-submenu");
      setSubmenuOpen(parent, false);
      parent.firstElementChild.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      close();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  document.addEventListener("mousedown", (event) => {
    if (isOpen() && !root.contains(event.target)) hide({ restoreFocus: false });
  }, true);
  view.addEventListener("blur", () => hide({ restoreFocus: false }));

  return { open, close, isOpen };
}
