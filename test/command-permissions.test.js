// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const POPUP_COMMANDS = [
  "clip_list", "clip_reveal", "clip_select", "clip_delete", "clip_close", "clip_shown", "clip_hidden", "clip_start_drag"
];

async function capabilities() {
  const files = await readdir("src-tauri/capabilities");
  return Promise.all(files.filter(f => f.endsWith(".json")).map(async f =>
    JSON.parse(await readFile(`src-tauri/capabilities/${f}`, "utf8"))));
}

test("every registered command is declared and permissioned", async () => {
  const [lib, build, caps] = await Promise.all([
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src-tauri/build.rs", "utf8"),
    capabilities()
  ]);
  const handlerList = lib.match(/generate_handler!\[([^\]]*)\]/)?.[1] ?? "";
  const registered = handlerList
    .split(",")
    .map((entry) => entry.trim().split("::").pop())
    .filter(Boolean);
  assert.ok(registered.length >= 20, `expected the handler list to parse, got ${registered.length}`);

  const granted = new Set(caps.flatMap(cap => cap.permissions));
  for (const command of registered) {
    assert.ok(build.includes(`"${command}"`), `build.rs must declare ${command}`);
    assert.ok(granted.has(`allow-${command.replaceAll("_", "-")}`), `some capability must grant ${command}`);
  }
});

test("popup commands are granted only to the clipboard window", async () => {
  const caps = await capabilities();
  const main = caps.find(cap => cap.identifier === "default");
  const popup = caps.find(cap => cap.identifier === "clipboard");
  assert.deepEqual(main.windows, ["main"]);
  assert.deepEqual(popup.windows, ["clipboard"]);
  for (const command of POPUP_COMMANDS) {
    assert.ok(!main.permissions.includes(`allow-${command.replaceAll("_", "-")}`), `main must not grant ${command}`);
  }
  assert.deepEqual(
    [...popup.permissions].sort(),
    POPUP_COMMANDS.map((command) => `allow-${command.replaceAll("_", "-")}`).sort()
  );
  assert.ok(main.permissions.includes("allow-clip-set-config"));
  assert.ok(main.permissions.includes("allow-clip-set-theme"));
});
