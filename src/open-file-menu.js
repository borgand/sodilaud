// SPDX-License-Identifier: GPL-3.0-or-later

// The context menu of a file, or of the selected files, in the open files
// list: move them to a new or to another main window, or close them. One file
// can also copy its name or path; a file in the folder tree has only those.

const MARGIN = 8;

export function createOpenFileMenu({ document, root, invoke, onMove, onClose, onCopy, relativePath }) {
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

  function submenu(ids, windows, text) {
    const group = document.createElement("div");
    group.className = "context-menu-submenu";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "context-menu-item";
    trigger.setAttribute("role", "menuitem");
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = text;
    const caret = document.createElement("span");
    caret.className = "context-menu-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "›";
    trigger.append(label, caret);
    const content = document.createElement("div");
    content.className = "context-menu-submenu-content";
    content.setAttribute("role", "menu");
    content.setAttribute("aria-label", text);
    content.append(...windows.map((entry) => item(`Window ${entry.number} - ${entry.title}`, () => onMove(ids, entry.label))));
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

  function divider() {
    const element = document.createElement("div");
    element.className = "context-menu-divider";
    return element;
  }

  // `path` is null for a file that was never saved.
  function copyItems(name, path) {
    const items = [item("Copy File Name", () => onCopy(name, "File name"))];
    const unsaved = { disabled: true, title: "Save the file first" };
    items.push(item("Copy Full Path", () => onCopy(path, "Path"), path === null ? unsaved : {}));
    const relative = path === null ? null : relativePath(path);
    if (relative !== null) items.push(item("Copy Relative Path", () => onCopy(relative, "Relative path")));
    return items;
  }

  function show(items, label, at, from) {
    anchor = from ?? null;
    root.replaceChildren(...items);
    root.setAttribute("aria-label", label);
    root.hidden = false;
    place(at);
    enabledIn(root)[0]?.focus();
  }

  // `buffers` is one file, or the selection the menu acts on.
  async function open(buffers, at, from) {
    const ticket = (opening += 1);
    let windows = [];
    try {
      const listed = await invoke("main_window_list");
      if (Array.isArray(listed)) windows = listed;
    } catch (error) {
      console.error("Could not list the other windows", error);
    }
    if (ticket !== opening) return;
    const ids = buffers.map((buffer) => buffer.id);
    const many = buffers.length > 1;
    const files = many ? ` ${buffers.length} Files` : "";
    const saved = buffers.every((buffer) => buffer.path !== null);
    const disabled = { disabled: !saved, title: saved ? "" : many ? "Save the files first" : "Save the file first" };
    const items = [item(`Move${files} to New Window`, () => onMove(ids, null), disabled)];
    if (windows.length && saved) items.push(submenu(ids, windows, `Move${files} to Window`));
    if (!many) items.push(divider(), ...copyItems(buffers[0].name, buffers[0].path));
    items.push(divider(), item(many ? `Close${files}` : "Close", () => onClose(ids)));
    show(items, many ? `${buffers.length} files actions` : `${buffers[0].name} actions`, at, from);
  }

  // A file in the folder tree: `file` is { name, path }.
  function openPath(file, at, from) {
    opening += 1;
    show(copyItems(file.name, file.path), `${file.name} actions`, at, from);
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

  return { open, openPath, close, isOpen };
}
