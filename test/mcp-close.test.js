// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("quitting drains an in-flight creation and rejects additional writes until cancelled", async () => {
  let release;
  let savedNotes = [];
  let hold = true;
  const app = await bootApp({
    handlers: {
      load_workspace_preference: () => "/tmp/close-mcp.db",
      load_db_notes: () => [{ id: "original", title: "Original", content: "", updatedAt: 1 }],
      start_mcp_server: () => ({ command: "/sodilaud", args: ["--mcp-stdio"] }),
      save_workspace_db: async ({ notes }) => {
        if (hold) await new Promise(resolve => { release = resolve; });
        savedNotes = structuredClone(notes);
      }
    }
  });
  app.click("agent-access-toggle-btn");
  await settle();
  app.click("mcp-permission-create_note");
  await settle();
  app.click("mcp-permission-create_folder");
  await settle();
  const collectionId = app.invocations.findLast(i => i.command === "update_mcp_snapshot").args.collectionId;
  const send = (ticket, title) => app.emit("mcp-write-request", {
    ticket, operation: "create_note", arguments: { collectionId, requestId: ticket, title }
  });
  const first = send("first", "Keep on close");
  await settle(20);
  assert.equal(typeof release, "function");
  const quitting = app.emit("sodilaud-quit-requested");
  await send("late", "Too late");
  const late = app.invocations.findLast(i => i.command === "complete_mcp_write" && i.args.ticket === "late");
  assert.equal(late.args.result.ok, false);
  assert.ok(!app.invocations.some(i => i.command === "quit_window_done"));
  hold = false;
  release();
  await Promise.all([first, quitting]);
  await settle();
  assert.deepEqual(app.invocations.filter(i => i.command === "quit_window_done").map(i => i.args.ok), [true]);
  assert.ok(savedNotes.some(n => n.title === "Keep on close"));
  assert.ok(!savedNotes.some(n => n.title === "Too late"));

  // Another window failed to save, so the app stays open and writes resume.
  await app.emit("sodilaud-quit-cancelled");
  await send("after", "After cancel");
  const after = app.invocations.findLast(i => i.command === "complete_mcp_write" && i.args.ticket === "after");
  assert.equal(after.args.result.ok, true);
});
