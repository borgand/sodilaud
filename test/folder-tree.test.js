// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { createFolderTree } from "../src/folder-tree.js";

const folder = (path, name) => ({ name, path: `${path}/${name}`, kind: "folder" });
const file = (path, name) => ({ name, path: `${path}/${name}`, kind: "file" });
const listing = (path, entries, truncated = false) => ({ path, entries, truncated });
const shape = (tree) => tree.rows().map(row => `${row.level}:${row.kind}:${row.name}`);

// /r: a/ (b/ (deep.md), x.md), c.md; /s: empty
function sample() {
  const tree = createFolderTree();
  tree.setRoots([{ path: "/r", name: "r" }, { path: "/s", name: "s" }]);
  tree.expand("/r");
  tree.setListing(listing("/r", [folder("/r", "a"), file("/r", "c.md")]));
  tree.expand("/r/a");
  tree.setListing(listing("/r/a", [folder("/r/a", "b"), file("/r/a", "x.md")]));
  tree.setListing(listing("/r/a/b", [file("/r/a/b", "deep.md")]));
  return tree;
}

test("rows list roots, then the children of expanded folders depth first", () => {
  const tree = sample();
  assert.deepEqual(shape(tree), [
    "1:root:r", "2:folder:a", "3:folder:b", "3:file:x.md", "2:file:c.md", "1:root:s"
  ]);
  tree.expand("/r/a/b");
  assert.deepEqual(shape(tree), [
    "1:root:r", "2:folder:a", "3:folder:b", "4:file:deep.md", "3:file:x.md", "2:file:c.md", "1:root:s"
  ]);
  assert.deepEqual(tree.rows()[1], {
    path: "/r/a", name: "a", kind: "folder", level: 2, expanded: true, missing: false, truncatedNote: false
  });
  assert.deepEqual(tree.rows()[6], {
    path: "/s", name: "s", kind: "root", level: 1, expanded: false, missing: false, truncatedNote: false
  });
});

test("a collapsed folder hides its children but keeps its cache", () => {
  const tree = sample();
  tree.collapse("/r/a");
  assert.deepEqual(shape(tree), ["1:root:r", "2:folder:a", "2:file:c.md", "1:root:s"]);
  tree.expand("/r/a");
  assert.deepEqual(tree.needsListing(), []);
  assert.deepEqual(shape(tree), [
    "1:root:r", "2:folder:a", "3:folder:b", "3:file:x.md", "2:file:c.md", "1:root:s"
  ]);
});

test("collapse also collapses below", () => {
  const tree = sample();
  tree.expand("/r/a/b");
  tree.collapse("/r/a");
  assert.equal(tree.isExpanded("/r/a/b"), false);
  assert.equal(tree.isExpanded("/r"), true);
});

test("needsListing names visible expanded folders without children", () => {
  const tree = createFolderTree();
  tree.setRoots([{ path: "/r", name: "r" }]);
  assert.deepEqual(tree.needsListing(), []);
  tree.expand("/r");
  assert.deepEqual(tree.needsListing(), ["/r"]);
  tree.setListing(listing("/r", [folder("/r", "a"), folder("/r", "b")]));
  assert.deepEqual(tree.needsListing(), []);
  tree.expand("/r/a");
  assert.deepEqual(tree.needsListing(), ["/r/a"]);
  tree.setListing(listing("/r/a", [folder("/r/a", "inner")]));
  tree.expand("/r/a/inner");
  tree.collapse("/r");
  tree.expand("/r");
  assert.deepEqual(tree.needsListing(), [], "collapsing /r collapsed /r/a/inner too");
  tree.expand("/r/b");
  tree.expand("/r/a/inner");
  assert.deepEqual(tree.needsListing(), ["/r/b"], "not for one under a collapsed parent");
});

test("a missing folder shows as missing and is not listed again until forgotten", () => {
  const tree = createFolderTree();
  tree.setRoots([{ path: "/r", name: "r" }]);
  tree.expand("/r");
  tree.setMissing("/r");
  assert.deepEqual(tree.needsListing(), []);
  assert.equal(tree.rows()[0].missing, true);
  tree.forget("/r");
  assert.deepEqual(tree.needsListing(), ["/r"]);
  tree.setListing(listing("/r", [file("/r", "a.md")]));
  assert.equal(tree.rows()[0].missing, false);
  assert.deepEqual(shape(tree), ["1:root:r", "2:file:a.md"]);
});

test("forget drops the cached children of a folder and below", () => {
  const tree = sample();
  tree.expand("/r/a/b");
  tree.forget("/r/a");
  assert.deepEqual(shape(tree), ["1:root:r", "2:folder:a", "2:file:c.md", "1:root:s"]);
  assert.deepEqual(tree.needsListing(), ["/r/a"]);
  tree.setListing(listing("/r/a", [folder("/r/a", "b")]));
  assert.deepEqual(tree.needsListing(), ["/r/a/b"]);
});

test("a truncated listing ends with a note row", () => {
  const tree = createFolderTree();
  tree.setRoots([{ path: "/r", name: "r" }]);
  tree.expand("/r");
  tree.setListing(listing("/r", [file("/r", "a.md"), file("/r", "b.md")], true));
  assert.deepEqual(shape(tree), ["1:root:r", "2:file:a.md", "2:file:b.md", "2:note:Some items are not shown."]);
  assert.deepEqual(tree.rows()[3], {
    path: "/r#more", kind: "note", level: 2, name: "Some items are not shown.", truncatedNote: true
  });
});

test("an expanded link lists its real folder under the link's own path", () => {
  const tree = createFolderTree();
  tree.setRoots([{ path: "/r", name: "r" }]);
  tree.expand("/r");
  tree.setListing(listing("/r", [folder("/r", "loop"), file("/r", "a.md")]));
  tree.expand("/r/loop");
  assert.deepEqual(tree.needsListing(), ["/r/loop"]);
  tree.setListing(listing("/r", [folder("/r", "loop"), file("/r", "a.md")]), "/r/loop");
  assert.deepEqual(tree.needsListing(), []);
  assert.deepEqual(tree.rows().map(row => row.path), ["/r", "/r/loop", "/r/loop/loop", "/r/loop/a.md", "/r/a.md"]);
  tree.forget("/r");
  assert.deepEqual(tree.needsListing(), ["/r"]);
});

test("keyboard moves follow the tree pattern", () => {
  const tree = sample();
  tree.setListing(listing("/r/a", [folder("/r/a", "b"), file("/r/a", "x.md")], true));
  // rows: /r, /r/a, /r/a/b, /r/a/x.md, (note), /r/c.md, /s
  assert.deepEqual(tree.move("/r", "ArrowDown"), { focus: "/r/a" });
  assert.deepEqual(tree.move("/r/a", "ArrowUp"), { focus: "/r" });
  assert.deepEqual(tree.move("/r/a/x.md", "ArrowDown"), { focus: "/r/c.md" }, "notes are skipped");
  assert.deepEqual(tree.move("/r/c.md", "ArrowUp"), { focus: "/r/a/x.md" });
  assert.deepEqual(tree.move("/s", "ArrowDown"), { focus: "/s" });
  assert.deepEqual(tree.move("/r", "ArrowUp"), { focus: "/r" });

  assert.deepEqual(tree.move("/r/a/b", "ArrowRight"), { expand: "/r/a/b" });
  assert.deepEqual(tree.move("/s", "ArrowRight"), { expand: "/s" });
  assert.deepEqual(tree.move("/r/a", "ArrowRight"), { focus: "/r/a/b" });
  assert.deepEqual(tree.move("/r", "ArrowRight"), { focus: "/r/a" });
  assert.deepEqual(tree.move("/r/c.md", "ArrowRight"), { focus: "/r/c.md" }, "Right on a file does nothing");

  assert.deepEqual(tree.move("/r/a", "ArrowLeft"), { collapse: "/r/a" });
  assert.deepEqual(tree.move("/r", "ArrowLeft"), { collapse: "/r" });
  assert.deepEqual(tree.move("/r/a/x.md", "ArrowLeft"), { focus: "/r/a" });
  assert.deepEqual(tree.move("/r/a/b", "ArrowLeft"), { focus: "/r/a" });
  assert.deepEqual(tree.move("/r/c.md", "ArrowLeft"), { focus: "/r" });
  assert.deepEqual(tree.move("/s", "ArrowLeft"), { focus: "/s" }, "Left on a collapsed root does nothing");

  assert.deepEqual(tree.move("/r/a/x.md", "Home"), { focus: "/r" });
  assert.deepEqual(tree.move("/r", "End"), { focus: "/s" });
});

test("an expanded folder without children keeps focus on Right", () => {
  const tree = createFolderTree();
  tree.setRoots([{ path: "/r", name: "r" }]);
  tree.expand("/r");
  assert.deepEqual(tree.move("/r", "ArrowRight"), { focus: "/r" });
  tree.setListing(listing("/r", []));
  assert.deepEqual(tree.move("/r", "ArrowRight"), { focus: "/r" });
});

test("removing a root drops its rows and its expanded paths", () => {
  const tree = sample();
  tree.expand("/s");
  tree.removeRoot("/r");
  assert.deepEqual(tree.roots(), [{ path: "/s", name: "s" }]);
  assert.deepEqual(shape(tree), ["1:root:s"]);
  assert.deepEqual(tree.expanded(), ["/s"]);
  assert.equal(tree.isExpanded("/r/a"), false);
  tree.addRoot({ path: "/r", name: "r" });
  assert.deepEqual(tree.roots(), [{ path: "/s", name: "s" }, { path: "/r", name: "r" }]);
  assert.deepEqual(tree.needsListing(), ["/s", "/r"], "the cache went with the root");
});

test("addRoot appends unless present and expands it", () => {
  const tree = createFolderTree();
  tree.addRoot({ path: "/r", name: "r" });
  tree.addRoot({ path: "/s", name: "s" });
  tree.collapse("/r");
  tree.addRoot({ path: "/r", name: "r" });
  assert.deepEqual(tree.roots().map(root => root.path), ["/r", "/s"]);
  assert.equal(tree.isExpanded("/r"), true);
});

test("setRoots drops the cache and expansion outside them", () => {
  const tree = sample();
  tree.expand("/s");
  tree.setRoots([{ path: "/s", name: "s" }, { path: "/t", name: "t" }]);
  assert.deepEqual(tree.expanded(), ["/s"]);
  assert.deepEqual(shape(tree), ["1:root:s", "1:root:t"]);
  tree.setListing(listing("/r", [file("/r", "c.md")]));
  tree.setRoots([{ path: "/r", name: "r" }]);
  tree.expand("/r");
  assert.deepEqual(tree.needsListing(), ["/r"], "a listing outside every root is not kept");
});

test("expanded() is roots first, then visible order", () => {
  const tree = sample();
  tree.expand("/r/a/b");
  tree.expand("/s");
  tree.expand("/r/later");
  assert.deepEqual(tree.expanded(), ["/r", "/s", "/r/a", "/r/a/b", "/r/later"]);
});
