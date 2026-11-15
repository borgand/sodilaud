// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

test("the main window restores both sidebar widths and gives each a resize handle", async () => {
  const app = await bootMainWindow({
    platform: "MacIntel",
    storage: { sodilaud_files_sidebar_width: "320", sodilaud_comments_panel_width: "380" },
    handlers: {
      qn_get_config: () => ({ hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false }),
      file_lists: () => ({ open: [], recent: [] })
    }
  });
  const document = app.dom.window.document;
  const files = document.getElementById("files-sidebar");
  const comments = document.getElementById("comments-panel");
  assert.equal(files.style.getPropertyValue("--sidebar-width"), "320px");
  assert.equal(comments.style.getPropertyValue("--sidebar-width"), "380px");

  const filesHandle = files.nextElementSibling;
  const commentsHandle = comments.previousElementSibling;
  assert.equal(filesHandle.getAttribute("role"), "separator");
  assert.equal(filesHandle.getAttribute("aria-label"), "Resize the sidebar");
  assert.equal(commentsHandle.getAttribute("aria-label"), "Resize the comments panel");
  assert.equal(filesHandle.hidden, files.hidden);
  assert.equal(commentsHandle.hidden, true);
});
