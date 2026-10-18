// SPDX-License-Identifier: GPL-3.0-or-later

// Page handlers for a main window with the folder commands faked.

const entry = (path, kind = path.endsWith(".md") ? "file" : "folder") => ({ name: path.split("/").at(-1), path, kind });

// `folders` is what each folder lists, by path; a folder not in it is NotFound.
export function folderHandlers({ folders = {}, roots = [], expanded = [], open = [], dialog = { path: "/r", name: "r" } } = {}) {
  return {
    qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
    file_lists: () => ({ open, recent: [], folders: roots, expanded }),
    file_set_open: ({ paths }) => { open = paths; },
    file_take_pending: () => [],
    folder_open_dialog: () => dialog,
    folder_browse: ({ path }) => {
      const parent = path.slice(0, path.lastIndexOf("/"));
      return { path: parent, name: parent.split("/").at(-1) };
    },
    folder_list: ({ path }) => {
      if (!(path in folders)) throw { code: "NotFound", message: `${path} is not on disk.` };
      return { path, entries: folders[path].map((child) => entry(child)), truncated: false };
    },
    folder_set_expanded: () => null,
    folder_remove: () => null,
    folder_open_file: ({ path }) => ({ path, name: path.split("/").at(-1), bytes: 1 })
  };
}
