// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("the Claude Code integration shows what changes before it installs, and can be removed", async () => {
  const notInstalled = { installed: false, present: false, changes: ["Create ~/.claude/commands/sodilaud.md (the /sodilaud command)", "Create ~/.claude/skills/sodilaud/SKILL.md (the sodilaud skill)", "Add a PreToolUse hook"] };
  let state = notInstalled;
  const app = await bootApp({ handlers: {
    coedit_integration_plan: () => state,
    coedit_integration_install: () => { state = { installed: true, present: true, changes: [] }; return state; },
    coedit_integration_remove: () => { state = notInstalled; return state; }
  } });
  const $ = id => document.getElementById(id);
  const commands = () => app.invocations.map(i => i.command).filter(c => c.startsWith("coedit_integration"));
  app.click("agent-access-config-btn");
  await settle();
  assert.equal($("coedit-integration-summary").textContent, "Not installed.");
  assert.equal($("coedit-integration-btn").hidden, false);
  assert.equal($("coedit-integration-remove-btn").hidden, true);

  app.click("coedit-integration-btn");
  await settle();
  assert.deepEqual([...$("coedit-integration-changes").children].map(item => item.textContent), notInstalled.changes);
  assert.equal($("coedit-integration-confirm-btn").hidden, false);
  assert.ok(!commands().includes("coedit_integration_install"), "nothing is written before confirming");

  app.click("coedit-integration-cancel-btn");
  await settle();
  assert.equal($("coedit-integration-changes").hidden, true);

  app.click("coedit-integration-btn");
  await settle();
  app.click("coedit-integration-confirm-btn");
  await settle();
  assert.equal($("coedit-integration-summary").textContent, "Installed.");
  assert.equal($("coedit-integration-remove-btn").hidden, false);
  assert.equal($("coedit-integration-btn").hidden, true);

  app.click("coedit-integration-remove-btn");
  await settle();
  assert.equal($("coedit-integration-summary").textContent, "Not installed.");
  assert.deepEqual(commands().slice(-2), ["coedit_integration_install", "coedit_integration_remove"]);
});

test("a refused install explains why", async () => {
  const app = await bootApp({ instance: 2, handlers: {
    coedit_integration_plan: () => ({ installed: false, present: false, changes: ["x"] }),
    coedit_integration_install: () => { throw new Error("settings.json is not a JSON object. Fix it first; nothing was changed."); }
  } });
  app.click("agent-access-config-btn");
  await settle();
  app.click("coedit-integration-btn");
  await settle();
  app.click("coedit-integration-confirm-btn");
  await settle();
  assert.match(document.getElementById("coedit-integration-summary").textContent, /nothing was changed/);
});
