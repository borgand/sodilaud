// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

test("the Sodilaud menu opens the command line tool dialog in Rust", async () => {
  const app = await bootMainWindow({ platform: "Linux x86_64" });
  const actionsButton = document.getElementById("actions-btn");
  const actionsDropdown = document.getElementById("actions-dropdown-content");
  const item = document.getElementById("menu-cli-tool-btn");

  assert.equal(item.hidden, false);
  assert.equal(item.closest(".dropdown-section").id, "file-menu-section");
  actionsButton.click();
  item.click();
  await app.settle();

  assert.equal(actionsDropdown.classList.contains("show"), false);
  assert.equal(document.activeElement, actionsButton);
  assert.equal(app.invocations.filter((call) => call.command === "cli_tool_offer").length, 1);
});
