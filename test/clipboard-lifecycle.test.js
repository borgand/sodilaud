// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

const done = (app) => app.invocations.filter(i => i.command === "quit_window_done").map(i => i.args.ok);

test("quit request flushes, then reports success to Rust", async () => {
  const app = await bootApp({ instance: 2 });
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.deepEqual(done(app), [true]);
});

test("the quit listener tells Rust it is ready once registered", async () => {
  const app = await bootApp({ instance: 3 });
  assert.ok(app.invocations.some(i => i.command === "quit_handler_ready"));
});

test("a failed flush reports failure, which cancels the quit", async () => {
  const app = await bootApp({ instance: 4 });
  app.dom.window.Storage.prototype.setItem = () => {
    throw new app.dom.window.DOMException("full", "QuotaExceededError");
  };
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.deepEqual(done(app), [false]);
  assert.match(app.dom.window.document.getElementById("save-status").textContent, /quit cancelled/);
});

test("a second quit request while one is in flight answers once", async () => {
  const pending = [];
  const app = await bootApp({
    instance: 5,
    handlers: { quit_window_done: () => new Promise(resolve => { pending.push(resolve); }) }
  });
  app.emit("sodilaud-quit-requested");
  app.emit("sodilaud-quit-requested");
  await settle();
  pending.forEach(resolve => resolve());
  assert.equal(done(app).length, 1);
});

test("an unexpected quit error is reported instead of swallowed", async () => {
  const app = await bootApp({
    instance: 6,
    handlers: { quit_window_done: () => { throw new Error("quit failed"); } }
  });
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.equal(app.dom.window.document.getElementById("save-status").textContent, "Could not quit Sodilaud");
});
