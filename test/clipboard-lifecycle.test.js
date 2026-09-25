// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("closing hides the window when Rust keeps the app in the menu bar", async () => {
  let closeHandler;
  let destroyed = false;
  const app = await bootApp({
    handlers: { hide_main_window: () => true },
    windowApi: { getCurrentWindow: () => ({
      onCloseRequested: async handler => { closeHandler = handler; },
      destroy: async () => { destroyed = true; }
    }) }
  });
  await closeHandler({ preventDefault() {} });
  assert.equal(destroyed, false);
  assert.ok(app.invocations.some(i => i.command === "hide_main_window"));
  await closeHandler({ preventDefault() {} });
  assert.equal(app.invocations.filter(i => i.command === "hide_main_window").length, 2);
});

test("quit request flushes, then asks Rust to quit", async () => {
  const app = await bootApp({ instance: 2 });
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.ok(app.invocations.some(i => i.command === "quit_app"));
});
