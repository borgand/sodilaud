// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootMainWindow } from "./helpers/app-harness.js";
import { listenHere, ownLabel } from "../src/window-events.js";

test("the main window hears only events sent to it", async () => {
  const app = await bootMainWindow({ label: "main-2", platform: "MacIntel" });
  for (const name of ["file-doc-updates", "file-doc-saved", "file-doc-external", "file-open-request",
    "comments-changed", "coedit-state", "sodilaud-quit-requested", "sodilaud-open-about", "sodilaud-open-section", "mcp-state-changed"]) {
    assert.deepEqual(app.listenOptions.get(name), { target: { kind: "WebviewWindow", label: "main-2" } }, name);
  }
  assert.equal(app.listenOptions.get("prefs-changed"), undefined);
});

test("without the bridge there is no label and nothing to listen to", async () => {
  assert.equal(ownLabel({}), null);
  assert.equal(ownLabel({ __TAURI__: { window: { getCurrentWindow: () => { throw new Error("gone"); } } } }), null);
  assert.equal(await listenHere({}, "file-open-request", () => {}), undefined);
});
