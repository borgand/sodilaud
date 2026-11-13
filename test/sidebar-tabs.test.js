// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { marked } from "marked";

import { bootMainWindow } from "./helpers/app-harness.js";

const BOOK = (reviewed = "") =>
  `# Book\n\nIntro\n\n## Engine\n\n\`\`\`diff path=src/a.rs hunk=h00001 lines=1-1${reviewed}\n@@ -1 +1 @@\n-a\n+b\n\`\`\`\n\n## Notes\n\nDeep\n`;

function boot({ instance, sidebarTab, text = BOOK(), extra = {} } = {}) {
  let open = ["/docs/book.md"];
  return bootMainWindow({
    instance,
    platform: "MacIntel",
    disk: { "/docs/book.md": text },
    beforeBoot: (dom) => {
      dom.window.marked = marked;
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open, recent: [], ...(sidebarTab === undefined ? {} : { sidebarTab }) }),
      file_set_open: ({ paths }) => { open = paths; },
      file_take_pending: () => [],
      ...extra
    }
  });
}

const doc = (app) => app.dom.window.document;
const tab = (app, name) => doc(app).getElementById(`sidebar-tab-${name}`);
const panel = (app, name) => doc(app).getElementById(`sidebar-panel-${name}`);
const tabCalls = (app) => app.invocations.filter((call) => call.command === "sidebar_set_tab").map((call) => call.args);
const press = (app, target, key) => {
  const event = new app.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const shown = (app) => (tab(app, "outline").getAttribute("aria-selected") === "true" ? "outline" : "files");

test("the sidebar is a tablist with Files and Outline, Files chosen by default", async () => {
  const app = await boot({ instance: 1 });
  const list = doc(app).querySelector("#files-sidebar [role=tablist]");
  assert.ok(list);
  assert.deepEqual([...list.querySelectorAll("[role=tab]")].map((item) => item.textContent.trim()), ["Files", "Outline"]);
  assert.equal(tab(app, "files").getAttribute("aria-selected"), "true");
  assert.equal(tab(app, "files").tabIndex, 0);
  assert.equal(tab(app, "outline").getAttribute("aria-selected"), "false");
  assert.equal(tab(app, "outline").tabIndex, -1);
  assert.equal(panel(app, "files").getAttribute("role"), "tabpanel");
  assert.equal(panel(app, "files").getAttribute("aria-labelledby"), "sidebar-tab-files");
  assert.equal(tab(app, "outline").getAttribute("aria-controls"), "sidebar-panel-outline");
  assert.equal(panel(app, "files").hidden, false);
  assert.equal(panel(app, "outline").hidden, true);
  assert.equal(doc(app).getElementById("outline-toggle-btn"), null, "the collapsible outline heading is gone");
  assert.deepEqual(tabCalls(app), [], "restoring does not write the tab back");
});

test("clicking Outline shows the outline panel and remembers the tab for the window", async () => {
  const app = await boot({ instance: 2 });
  tab(app, "outline").click();
  assert.equal(shown(app), "outline");
  assert.equal(panel(app, "outline").hidden, false);
  assert.equal(panel(app, "files").hidden, true);
  assert.deepEqual([...doc(app).querySelectorAll(".outline-item")].map((item) => item.dataset.outlineId), ["book", "engine", "notes"]);
  assert.deepEqual(tabCalls(app), [{ tab: "outline" }]);
  tab(app, "files").click();
  assert.equal(shown(app), "files");
  assert.deepEqual(tabCalls(app), [{ tab: "outline" }, { tab: "files" }]);
  tab(app, "files").click();
  assert.equal(tabCalls(app).length, 2, "choosing the shown tab again writes nothing");
});

test("arrow keys, Home and End move between the tabs and focus them", async () => {
  const app = await boot({ instance: 3 });
  const files = tab(app, "files");
  const outline = tab(app, "outline");
  files.focus();
  assert.equal(press(app, files, "ArrowRight").defaultPrevented, true);
  assert.equal(shown(app), "outline");
  assert.ok(doc(app).activeElement === outline);
  press(app, outline, "ArrowRight");
  assert.equal(shown(app), "files", "wraps round");
  assert.ok(doc(app).activeElement === files);
  press(app, files, "ArrowLeft");
  assert.equal(shown(app), "outline");
  press(app, outline, "Home");
  assert.equal(shown(app), "files");
  press(app, files, "End");
  assert.equal(shown(app), "outline");
  assert.equal(press(app, outline, "a").defaultPrevented, false);
});

test("the remembered tab comes back at launch; an unknown value falls back to Files", async () => {
  const outline = await boot({ instance: 4, sidebarTab: "outline" });
  assert.equal(shown(outline), "outline");
  assert.equal(panel(outline, "outline").hidden, false);
  assert.equal(panel(outline, "files").hidden, true);
  const odd = await boot({ instance: 5, sidebarTab: "bookmarks" });
  assert.equal(shown(odd), "files");
});

test("the outline panel says so when the file has no headings", async () => {
  const app = await boot({ instance: 6, sidebarTab: "outline", text: "just text\n" });
  assert.equal(doc(app).getElementById("outline-section").hidden, true);
  assert.equal(doc(app).getElementById("outline-empty").hidden, false);
});

test("the review count in the status bar switches to the Outline tab and shows a hidden sidebar", async () => {
  const app = await boot({ instance: 7 });
  const count = doc(app).getElementById("review-progress");
  assert.equal(count.tagName, "BUTTON");
  assert.equal(count.textContent, "0/1 reviewed");
  app.click("toggle-files-sidebar");
  assert.equal(doc(app).getElementById("files-sidebar").hidden, true);
  count.click();
  assert.equal(doc(app).getElementById("files-sidebar").hidden, false);
  assert.equal(shown(app), "outline");
  assert.deepEqual(tabCalls(app), [{ tab: "outline" }]);
});

test("adding a folder switches to the Files tab, where the folder shows", async () => {
  const app = await boot({
    instance: 8,
    sidebarTab: "outline",
    extra: {
      folder_open_dialog: () => ({ path: "/r", name: "r" }),
      folder_list: ({ path }) => ({ path, entries: [], truncated: false }),
      folder_set_expanded: () => null
    }
  });
  assert.equal(shown(app), "outline");
  app.click("menu-open-folder-btn");
  await app.settle();
  assert.equal(shown(app), "files");
  assert.equal(doc(app).getElementById("folders-section").hidden, false);
  assert.deepEqual(tabCalls(app), [{ tab: "files" }]);
});
