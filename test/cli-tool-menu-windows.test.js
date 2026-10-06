// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import { bootMainWindow } from "./helpers/app-harness.js";

test("Windows has no command line tool to install", async () => {
  await bootMainWindow({ platform: "Win32" });
  assert.equal(document.getElementById("menu-cli-tool-btn").hidden, true);
});
