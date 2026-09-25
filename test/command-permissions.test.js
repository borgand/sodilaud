// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("every registered command is declared and permissioned", async () => {
  const [lib, build, capability] = await Promise.all([
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src-tauri/build.rs", "utf8"),
    readFile("src-tauri/capabilities/default.json", "utf8")
  ]);
  const handlerList = lib.match(/generate_handler!\[([^\]]*)\]/)?.[1] ?? "";
  const registered = handlerList
    .split(",")
    .map((entry) => entry.trim().split("::").pop())
    .filter(Boolean);
  assert.ok(registered.length >= 20, `expected the handler list to parse, got ${registered.length}`);

  const permissions = JSON.parse(capability).permissions;
  for (const command of registered) {
    assert.ok(build.includes(`"${command}"`), `build.rs must declare ${command}`);
    assert.ok(
      permissions.includes(`allow-${command.replaceAll("_", "-")}`),
      `the default capability must grant ${command}`
    );
  }
});
