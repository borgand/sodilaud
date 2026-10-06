// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("a remembered start that failed at launch leaves access off and explains why", async () => {
  const app = await bootApp({ handlers: {
    get_mcp_state: () => ({ enabled: false, tools: [], error: "Could not enable agent access on port 39393" }),
    get_mcp_connection_info: () => ({ command: "/sodilaud", args: ["--mcp-stdio"] })
  } });
  assert.equal(document.getElementById("mcp-status").hidden, true);
  assert.equal(document.getElementById("agent-access-toggle-btn").textContent, "Off");
  app.click("agent-access-config-btn");
  await settle();
  assert.match(document.getElementById("mcp-permission-status").textContent, /Could not enable agent access on port 39393/);
});
