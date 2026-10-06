// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("Quick Notes builds the MCP Configuration and follows changes made in the main window", async () => {
  const app = await bootApp();
  const $ = id => document.getElementById(id);
  assert.equal($("mcp-config-modal").getAttribute("role"), "dialog");
  assert.equal($("mcp-status").closest(".statusbar-right"), document.querySelector(".statusbar-right"));
  assert.equal($("mcp-status").hidden, true);

  app.emit("mcp-state-changed", { enabled: true, tools: ["get_note", "apply_edit"], error: null, integration: null });
  assert.equal($("agent-access-toggle-btn").textContent, "On");
  assert.equal($("mcp-status").hidden, false);
  assert.equal($("mcp-status").title, "MCP listening: 1 read · 1 write functions enabled");

  app.click("agent-access-config-btn");
  await settle();
  assert.deepEqual([...document.querySelectorAll("[data-mcp-tool]:checked")].map(input => input.dataset.mcpTool), ["get_note", "apply_edit"]);

  app.emit("mcp-state-changed", { enabled: false, tools: [], error: null, integration: { installed: false, present: true, changes: [] } });
  assert.equal($("agent-access-toggle-btn").textContent, "Off");
  assert.equal($("mcp-status").hidden, true);
  assert.equal($("coedit-integration-summary").textContent, "Installed, but out of date.");
  assert.equal($("coedit-integration-btn").textContent, "Update Claude Code integration…");
});
