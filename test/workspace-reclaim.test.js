// SPDX-License-Identifier: GPL-3.0-or-later

// Free pages written before secure_delete was enabled may still hold old note
// bodies, so a workspace is compacted when it is connected and when it is left.

import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "./helpers/app-harness.js";

const WORKSPACE = "/tmp/scratchpad-reclaim-workspace.db";

const app = await bootApp({
  storage: {
    scratchpad_notes: [{ id: "local", title: "Local", content: "local", updatedAt: 1, isTitleLocked: true }]
  },
  handlers: {
    select_db_file: () => WORKSPACE,
    load_db_notes: () => [{ id: "ws", title: "Workspace", content: "ws", updatedAt: 2, isTitleLocked: true }],
    vacuum_workspace: () => {
      throw new Error("disk is read-only");
    }
  }
});

const vacuums = () => app.invocations.filter(({ command }) => command === "vacuum_workspace");

test("connecting a workspace reclaims its free pages without blocking the switch", async () => {
  app.click("db-connect-btn");
  await app.settle();

  assert.deepEqual(vacuums().map(({ args }) => args), [{ dbPath: WORKSPACE }]);
  assert.deepEqual(app.sidebarTitles(), ["Workspace"], "a failed compaction still connects");
});

test("disconnecting reclaims the workspace it leaves", async () => {
  app.click("db-disconnect-btn");
  await app.settle();

  assert.deepEqual(vacuums().map(({ args }) => args), [{ dbPath: WORKSPACE }, { dbPath: WORKSPACE }]);
  assert.deepEqual(app.sidebarTitles(), ["Local"]);
});
