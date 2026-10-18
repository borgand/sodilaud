// SPDX-License-Identifier: GPL-3.0-or-later

// The Folders section as data: the roots in sidebar order, which folders are
// expanded, and the cached one-level listings from Rust. rows() is what the
// sidebar draws; move() is the tree keyboard pattern over those rows.
const TRUNCATED_NOTE = "Some items are not shown.";
const endsWithSeparator = (path) => /[\\/]$/.test(path);

function isUnder(path, base) {
  if (path === base) return true;
  if (!path.startsWith(base)) return false;
  return endsWithSeparator(base) || path[base.length] === "/" || path[base.length] === "\\";
}

export function createFolderTree() {
  let rootList = [];
  const expandedSet = new Set();
  const listings = new Map();
  // A folder expanded through a symbolic link is listed as its real folder:
  // the link's path -> the real path its listing is cached under.
  const aliases = new Map();
  const missing = new Set();

  const inRoots = (path) => rootList.some(root => isUnder(path, root.path));

  function prune() {
    for (const path of expandedSet) if (!inRoots(path)) expandedSet.delete(path);
    for (const path of missing) if (!inRoots(path)) missing.delete(path);
    for (const path of listings.keys()) if (!inRoots(path)) listings.delete(path);
    for (const [path, real] of aliases) if (!inRoots(path) || !inRoots(real)) aliases.delete(path);
  }

  // Children of a shown folder, with paths under the folder's own path even
  // when it is a link to another folder.
  function children(path) {
    const real = aliases.get(path) ?? path;
    const listing = listings.get(real);
    if (!listing) return null;
    const entries = listing.entries.map(entry => {
      if (real === path || !entry.path.startsWith(real)) return entry;
      const rest = entry.path.slice(real.length);
      return { ...entry, path: endsWithSeparator(real) ? path + real.at(-1) + rest : path + rest };
    });
    return { entries, truncated: listing.truncated };
  }

  // Visible rows, each with the path of its parent row (null for roots).
  function walk() {
    const out = [];
    const descend = (path, level) => {
      const listed = children(path);
      if (!listed) return;
      for (const entry of listed.entries) {
        const open = entry.kind === "folder" && expandedSet.has(entry.path);
        out.push({
          row: {
            path: entry.path, name: entry.name, kind: entry.kind, level,
            expanded: open, missing: missing.has(entry.path), truncatedNote: false
          },
          parent: path
        });
        // A child path is always longer than its parent's, which keeps a link loop finite.
        if (open && !missing.has(entry.path) && entry.path.length > path.length) descend(entry.path, level + 1);
      }
      if (listed.truncated) {
        out.push({
          row: { path: `${path}#more`, kind: "note", level, name: TRUNCATED_NOTE, truncatedNote: true },
          parent: path
        });
      }
    };
    for (const root of rootList) {
      const open = expandedSet.has(root.path);
      out.push({
        row: {
          path: root.path, name: root.name, kind: "root", level: 1,
          expanded: open, missing: missing.has(root.path), truncatedNote: false
        },
        parent: null
      });
      if (open && !missing.has(root.path)) descend(root.path, 2);
    }
    return out;
  }

  const expandable = (row) => row.kind === "root" || row.kind === "folder";

  return {
    setRoots(roots) {
      rootList = roots.map(({ path, name }) => ({ path, name }));
      prune();
    },
    roots: () => rootList.map(root => ({ ...root })),
    addRoot(root) {
      if (!rootList.some(existing => existing.path === root.path)) {
        rootList.push({ path: root.path, name: root.name });
      }
      expandedSet.add(root.path);
    },
    removeRoot(path) {
      rootList = rootList.filter(root => root.path !== path);
      prune();
    },
    // `requested` is the path the listing was asked for, when Rust resolved it
    // to another folder (listing.path).
    setListing(listing, requested = listing.path) {
      if (!inRoots(listing.path) || !inRoots(requested)) return;
      listings.set(listing.path, { entries: listing.entries, truncated: Boolean(listing.truncated) });
      missing.delete(listing.path);
      missing.delete(requested);
      if (requested === listing.path) aliases.delete(requested);
      else aliases.set(requested, listing.path);
    },
    setMissing(path) {
      listings.delete(path);
      aliases.delete(path);
      missing.add(path);
    },
    forget(path) {
      for (const key of listings.keys()) if (isUnder(key, path)) listings.delete(key);
      for (const key of aliases.keys()) if (isUnder(key, path)) aliases.delete(key);
      for (const key of missing) if (isUnder(key, path)) missing.delete(key);
    },
    isExpanded: (path) => expandedSet.has(path),
    expand(path) {
      expandedSet.add(path);
    },
    collapse(path) {
      for (const key of expandedSet) if (isUnder(key, path)) expandedSet.delete(key);
    },
    expanded() {
      const ordered = rootList.map(root => root.path).filter(path => expandedSet.has(path));
      for (const { row } of walk()) {
        if (row.kind === "folder" && row.expanded && !ordered.includes(row.path)) ordered.push(row.path);
      }
      for (const path of expandedSet) if (!ordered.includes(path)) ordered.push(path);
      return ordered;
    },
    needsListing() {
      return walk()
        .map(({ row }) => row)
        .filter(row => expandable(row) && row.expanded && !row.missing && !children(row.path))
        .map(row => row.path);
    },
    rows: () => walk().map(({ row }) => row),
    move(path, key) {
      const items = walk().filter(({ row }) => row.kind !== "note");
      if (!items.length) return { focus: path };
      const index = items.findIndex(({ row }) => row.path === path);
      if (index < 0) return { focus: items[0].row.path };
      const { row, parent } = items[index];
      switch (key) {
        case "ArrowDown": return { focus: items[Math.min(index + 1, items.length - 1)].row.path };
        case "ArrowUp": return { focus: items[Math.max(index - 1, 0)].row.path };
        case "Home": return { focus: items[0].row.path };
        case "End": return { focus: items.at(-1).row.path };
        case "ArrowRight": {
          if (!expandable(row)) return { focus: path };
          if (!row.expanded) return { expand: path };
          const next = items[index + 1];
          return { focus: next && next.parent === path ? next.row.path : path };
        }
        case "ArrowLeft":
          if (expandable(row) && row.expanded) return { collapse: path };
          return { focus: parent ?? path };
        default: return { focus: path };
      }
    }
  };
}
