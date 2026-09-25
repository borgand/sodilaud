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

test("the quit listener tells Rust it is ready once registered", async () => {
  const app = await bootApp({ instance: 3 });
  assert.ok(app.invocations.some(i => i.command === "quit_handler_ready"));
});

test("a failed flush cancels the quit", async () => {
  const app = await bootApp({ instance: 4 });
  app.dom.window.Storage.prototype.setItem = () => {
    throw new app.dom.window.DOMException("full", "QuotaExceededError");
  };
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.ok(!app.invocations.some(i => i.command === "quit_app"));
  assert.match(app.dom.window.document.getElementById("save-status").textContent, /quit cancelled/);
});

test("a second quit request while one is in flight does not quit twice", async () => {
  const pending = [];
  const app = await bootApp({
    instance: 5,
    handlers: { quit_app: () => new Promise(resolve => { pending.push(resolve); }) }
  });
  app.emit("sodilaud-quit-requested");
  app.emit("sodilaud-quit-requested");
  await settle();
  pending.forEach(resolve => resolve());
  assert.equal(app.invocations.filter(i => i.command === "quit_app").length, 1);
});

test("an unexpected quit error is reported instead of swallowed", async () => {
  const app = await bootApp({
    instance: 6,
    handlers: { quit_app: () => { throw new Error("quit failed"); } }
  });
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.equal(app.dom.window.document.getElementById("save-status").textContent, "Could not quit Sodilaud");
});
