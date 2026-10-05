// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("access that Rust started at launch shows as on with the saved permissions", async () => {
  const app = await bootApp({ handlers: {
    get_mcp_state: () => ({ enabled: true, tools: ["list_notes", "create_note"], error: null }),
    get_mcp_connection_info: () => ({ command: "/sodilaud", args: ["--mcp-stdio"] })
  } });
  assert.equal(document.getElementById("mcp-status").hidden, false);
  assert.equal(document.getElementById("agent-access-toggle-btn").textContent, "On");
  app.click("agent-access-config-btn");
  await settle();
  const selected = [...document.querySelectorAll("[data-mcp-tool]:checked")].map(input => input.dataset.mcpTool);
  assert.deepEqual(selected, ["list_notes", "create_note"]);
  assert.equal(document.getElementById("mcp-permission-create_note").disabled, false);
});
