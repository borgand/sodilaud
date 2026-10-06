// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootMainWindow, settle } from "./helpers/app-harness.js";

const config = { hotkey: "super+shift+KeyN", requested: "super+shift+KeyN", hotkeyError: null, upgradeIntro: false };
const command = "/Applications/Sodilaud.app/Contents/MacOS/sodilaud";

test("the main window's menu has the Agent access section and its MCP Configuration", async () => {
  const app = await bootMainWindow({ handlers: {
    qn_get_config: () => config,
    get_mcp_connection_info: () => ({ command, args: ["--mcp-stdio"] }),
    start_mcp_server: () => ({ command, args: ["--mcp-stdio"], tools: ["list_notes"] }),
    coedit_integration_plan: () => ({ installed: false, present: false, changes: ["Add a hook"] })
  } });
  const { document } = app.dom.window;
  const $ = id => document.getElementById(id);
  const section = $("agent-access-menu-section");
  assert.equal(section.querySelector(".dropdown-section-title").textContent, "Agent access");
  assert.deepEqual([...section.querySelectorAll("button")].map(button => button.id), ["agent-access-toggle-btn", "agent-access-config-btn"]);
  assert.equal($("agent-access-menu-btn"), null, "the menu no longer jumps to Quick Notes");
  assert.doesNotMatch(section.textContent, /Quick Notes/);
  assert.equal($("mcp-status").closest("#file-status-bar"), $("file-status-bar"));
  assert.equal($("mcp-status").hidden, true);

  app.click("actions-btn");
  app.click("agent-access-toggle-btn");
  await settle();
  assert.ok(app.invocations.some(call => call.command === "start_mcp_server"));
  assert.equal($("agent-access-toggle-btn").textContent, "On");
  assert.equal($("actions-dropdown-content").classList.contains("show"), true, "the toggle keeps the menu open");
  assert.equal($("mcp-status").hidden, false);

  app.click("agent-access-config-btn");
  await settle();
  const modal = $("mcp-config-modal");
  assert.equal(modal.getAttribute("role"), "dialog");
  assert.equal(modal.getAttribute("aria-modal"), "true");
  assert.equal($("mcp-config-modal-backdrop").style.display, "flex");
  assert.equal($("actions-dropdown-content").classList.contains("show"), false);
  assert.equal($("mcp-config-command").value, command);
  assert.equal(document.querySelectorAll(".mcp-permission-group").length, 2);
  assert.equal($("mcp-permission-list_notes").checked, true);
  assert.equal($("mcp-permission-create_note").checked, false);
  assert.equal($("coedit-integration-summary").textContent, "Not installed.");
  assert.equal($("coedit-integration-btn").hidden, false);

  document.dispatchEvent(new app.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal($("mcp-config-modal-backdrop").style.display, "none");
});

test("an mcp-state-changed event updates the main window without reopening anything", async () => {
  const app = await bootMainWindow({ instance: 2, handlers: { qn_get_config: () => config } });
  const { document } = app.dom.window;
  const $ = id => document.getElementById(id);
  app.click("agent-access-config-btn");
  await settle();

  app.emit("mcp-state-changed", { enabled: true, tools: ["list_notes", "create_note"], error: null, integration: null });
  assert.equal($("agent-access-toggle-btn").textContent, "On");
  assert.equal($("agent-access-toggle-btn").getAttribute("aria-pressed"), "true");
  assert.equal($("mcp-status").hidden, false);
  assert.equal($("mcp-permissions-summary").textContent, "1 read · 1 write functions enabled");
  assert.deepEqual([...document.querySelectorAll("[data-mcp-tool]:checked")].map(input => input.dataset.mcpTool), ["list_notes", "create_note"]);
  assert.equal($("mcp-permission-create_note").disabled, false);
  assert.equal($("mcp-select-all-write").indeterminate, true);

  app.emit("mcp-state-changed", { enabled: true, tools: ["list_notes"], error: null, integration: { installed: true, present: true, changes: [] } });
  assert.equal($("coedit-integration-summary").textContent, "Installed.");
  assert.equal($("coedit-integration-remove-btn").hidden, false);
  assert.equal($("mcp-permission-create_note").checked, false);

  app.emit("mcp-state-changed", { enabled: false, tools: [], error: null, integration: null });
  assert.equal($("agent-access-toggle-btn").textContent, "Off");
  assert.equal($("mcp-status").hidden, true);
  assert.equal($("mcp-permissions-summary").textContent, "Off");
  assert.ok([...document.querySelectorAll("[data-mcp-tool]")].every(input => input.disabled));
  assert.match($("mcp-permission-status").textContent, /Agent access is off/);
  assert.equal($("coedit-integration-summary").textContent, "Installed.", "an event without integration news leaves it alone");
});
