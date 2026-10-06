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

const NOTE_COMMANDS = [
  "save_file_native", "select_db_file",
  "notes_boot", "notes_import_local", "notes_connect", "notes_disconnect", "notes_sync_structure",
  "notes_trash", "notes_restore", "notes_empty_trash", "notes_vacuum", "doc_push", "doc_pull",
  "get_mcp_connection_info", "get_mcp_state", "start_mcp_server", "set_mcp_permissions", "stop_mcp_server"
];
const grant = (command) => `allow-${command.replaceAll("_", "-")}`;

test("only the Quick Notes window can read, write or expose notes", async () => {
  const caps = await capabilities();
  const quicknotes = caps.find(cap => cap.identifier === "quicknotes");
  assert.deepEqual(quicknotes.windows, ["quicknotes"]);
  for (const command of NOTE_COMMANDS) {
    const holders = caps.filter(cap => cap.permissions.includes(grant(command))).map(cap => cap.identifier);
    assert.deepEqual(holders, ["quicknotes"], `${command} must be granted to the Quick Notes window only`);
  }
});

test("note contents are sent to the Quick Notes window only", async () => {
  const commands = await readFile("src-tauri/src/docs/commands.rs", "utf8");
  assert.doesNotMatch(commands, /\.emit\(/, "a broadcast would reach every webview");
  assert.match(commands, /emit_to\(\s*quicknotes::window::LABEL,\s*CHANGED_EVENT/);
  assert.match(commands, /emit_to\(\s*quicknotes::window::LABEL,\s*DOC_EVENT/);
});

test("settings commands belong to the main window and panel commands to the panel", async () => {
  const caps = await capabilities();
  const holders = (command) => caps.filter(cap => cap.permissions.includes(grant(command))).map(cap => cap.identifier).sort();
  for (const command of ["clip_set_config", "clip_set_theme", "qn_set_hotkey", "qn_dismiss_intro", "qn_show"]) {
    assert.deepEqual(holders(command), ["default"], command);
  }
  for (const command of ["qn_close", "qn_start_drag", "show_main_window"]) {
    assert.deepEqual(holders(command), ["quicknotes"], command);
  }
  for (const command of ["quit_handler_ready", "quit_window_done", "qn_get_config", "import_file_native"]) {
    assert.deepEqual(holders(command), ["default", "quicknotes"], command);
  }
});

test("only the main window can reach user files", async () => {
  const caps = await capabilities();
  const holders = (command) => caps.filter(cap => cap.permissions.includes(grant(command))).map(cap => cap.identifier);
  for (const command of [
    "file_open_dialog", "file_save_as_dialog", "file_lists",
    "file_set_open", "file_take_pending", "file_forget_recent", "file_confirm_discard",
    "file_doc_open", "file_doc_push", "file_doc_pull", "file_doc_close", "file_doc_save", "file_doc_resolve"
  ]) {
    assert.deepEqual(holders(command), ["default"], `${command} must be granted to the main window only`);
  }
});

test("file contents are sent to the main window only", async () => {
  const commands = await readFile("src-tauri/src/docs/commands.rs", "utf8");
  for (const event of ["FILE_DOC_EVENT", "FILE_SAVED_EVENT", "FILE_EXTERNAL_EVENT"]) {
    assert.match(commands, new RegExp(`emit_to\\(\\s*quicknotes::window::MAIN_LABEL,\\s*${event}`), event);
  }
});
