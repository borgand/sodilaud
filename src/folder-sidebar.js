// SPDX-License-Identifier: GPL-3.0-or-later

// The Folders section of the main window sidebar: the folder tree model drawn
// as an ARIA tree, listed one level at a time through Rust. Every path here
// came from Rust; the tree can only open what Rust lists.

import { createFolderTree } from "./folder-tree.js";

const MISSING_TEXT = "Folder not found";
const MOVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
const expandable = (row) => row.kind === "root" || row.kind === "folder";

export function createFolderSidebar({ document, invoke, openPath, notify = () => {}, onChange = () => {} }) {
  const section = document.getElementById("folders-section");
  const treeElement = document.getElementById("folder-tree");
  const tree = createFolderTree();
  let activePath = null;
  // The row in the tab order, and the one keyboard focus returns to.
  let focusPath = null;

  const errorMessage = (error, fallback) => error?.message ?? fallback;

  function rowElement(row, tabbable) {
    const item = document.createElement("li");
    item.className = `folder-row folder-row-${row.kind}`;
    item.dataset.path = row.path;
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.level));
    item.style.setProperty("--level", String(row.level));
    if (row.kind === "note") {
      item.setAttribute("aria-disabled", "true");
      item.textContent = row.name;
      return item;
    }
    item.tabIndex = tabbable ? 0 : -1;
    if (expandable(row)) item.setAttribute("aria-expanded", String(row.expanded));
    if (row.kind === "file") {
      const active = row.path === activePath;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    }
    const name = document.createElement("button");
    name.type = "button";
    name.className = "folder-name";
    name.tabIndex = -1;
    name.textContent = row.name;
    name.title = row.path;
    name.addEventListener("click", () => {
      focusPath = row.path;
      activateRow(row);
    });
    item.append(name);
    if (row.missing) {
      const missing = document.createElement("span");
      missing.className = "folder-missing";
      missing.textContent = MISSING_TEXT;
      item.append(missing);
    }
    if (row.kind === "root") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "folder-remove";
      remove.setAttribute("aria-label", `Remove ${row.name} from the sidebar`);
      remove.title = "Remove from sidebar";
      remove.textContent = "×";
      remove.addEventListener("click", () => removeRoot(row.path));
      item.append(remove);
    }
    return item;
  }

  function render() {
    const rows = tree.rows();
    const focusable = rows.filter((row) => row.kind !== "note");
    if (!focusable.some((row) => row.path === focusPath)) focusPath = focusable[0]?.path ?? null;
    const hadFocus = treeElement.contains(document.activeElement);
    treeElement.replaceChildren(...rows.map((row) => rowElement(row, row.path === focusPath)));
    section.hidden = tree.roots().length === 0;
    if (hadFocus) focusRow(focusPath);
    onChange();
  }

  function focusRow(path) {
    const item = [...treeElement.children].find((element) => element.dataset.path === path);
    item?.focus();
  }

  const report = () => invoke("folder_set_expanded", { paths: tree.expanded() })
    .catch((error) => console.error("Could not save the expanded folders", error));

  async function list(path) {
    try {
      tree.setListing(await invoke("folder_list", { path }), path);
    } catch (error) {
      // Marked missing, so it is not listed again until it changes or is expanded again.
      if (!tree.rows().some((row) => row.path === path)) return;
      tree.setMissing(path);
      if (error?.code !== "NotFound" && error?.code !== "NotGranted") notify(errorMessage(error, "Could not list the folder"));
    }
  }

  // Lists every shown expanded folder that has no listing yet, top-down.
  async function fill() {
    const tried = new Set();
    for (;;) {
      const next = tree.needsListing().find((path) => !tried.has(path));
      if (!next) break;
      tried.add(next);
      await list(next);
      render();
    }
  }

  async function toggle(row) {
    if (row.expanded) {
      tree.collapse(row.path);
      // Rust stops watching a collapsed folder, so its listing would go stale.
      tree.forget(row.path);
      render();
    } else {
      if (row.missing) tree.forget(row.path);
      tree.expand(row.path);
      render();
      await fill();
    }
    await report();
  }

  async function openFile(path) {
    let granted;
    try {
      granted = await invoke("folder_open_file", { path });
    } catch (error) {
      notify(errorMessage(error, "Could not open the file"));
      return;
    }
    await openPath(granted.path);
  }

  function activateRow(row) {
    if (row.kind === "file") return openFile(row.path);
    if (expandable(row)) return toggle(row);
    return undefined;
  }

  async function removeRoot(path) {
    try {
      await invoke("folder_remove", { path });
    } catch (error) {
      notify(errorMessage(error, "Could not remove the folder"));
      return;
    }
    tree.removeRoot(path);
    render();
    await report();
  }

  async function addRoot(root) {
    if (!root) return;
    tree.addRoot(root);
    render();
    await fill();
    await report();
  }

  function handleKeydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const item = event.target.closest?.("li.folder-row");
    if (!item || event.target.closest(".folder-remove")) return;
    const row = tree.rows().find((candidate) => candidate.path === item.dataset.path);
    if (!row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      focusPath = row.path;
      activateRow(row);
      return;
    }
    if (!MOVE_KEYS.has(event.key)) return;
    event.preventDefault();
    const move = tree.move(row.path, event.key);
    if (move.expand || move.collapse) {
      focusPath = row.path;
      toggle(row);
      return;
    }
    focusPath = move.focus;
    render();
    focusRow(focusPath);
  }

  treeElement.addEventListener("keydown", handleKeydown);

  return {
    async restore(lists) {
      const roots = Array.isArray(lists?.folders) ? lists.folders : [];
      tree.setRoots(roots);
      for (const path of Array.isArray(lists?.expanded) ? lists.expanded : []) tree.expand(path);
      render();
      await fill();
    },
    async openFolderDialog() {
      try {
        await addRoot(await invoke("folder_open_dialog"));
      } catch (error) {
        notify(errorMessage(error, "Could not open the folder"));
      }
    },
    async browseFolder(path) {
      try {
        await addRoot(await invoke("folder_browse", { path }));
      } catch (error) {
        notify(errorMessage(error, "Could not show the folder"));
      }
    },
    async folderChanged(payload) {
      const path = payload?.path;
      if (typeof path !== "string") return;
      if (tree.rows().some((row) => row.path === path && expandable(row) && row.expanded)) {
        await list(path);
        render();
      } else {
        tree.forget(path);
      }
      await fill();
    },
    setActivePath(path) {
      activePath = path ?? null;
      for (const item of treeElement.querySelectorAll(".folder-row-file")) {
        const active = item.dataset.path === activePath;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", String(active));
      }
    },
    hasRoots: () => tree.roots().length > 0
  };
}
