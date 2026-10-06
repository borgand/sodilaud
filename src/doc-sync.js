// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ChangeSet,
  Text,
  ViewPlugin,
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates
} from "./vendor/codemirror.js";

// Rust owns each document's text, a note's or a file's. Every editor showing
// one is a `@codemirror/collab` client: it sends its changes against the
// version it has seen, and the registry rejects them when another client (the
// other pane, an agent, the file on disk) got there first. The client then
// pulls, rebases and sends again.

export const PUSH_DELAY_MS = 150;
const RETRY_DELAY_MS = 2000;

/** Applies registry updates, as JSON, to plain text. */
export function applyUpdatesToText(text, updates) {
  let doc = Text.of(String(text ?? "").split("\n"));
  for (const update of updates) doc = ChangeSet.fromJSON(update.changes).apply(doc);
  return doc.toString();
}

const toWire = update => ({ clientID: update.clientID, changes: update.changes.toJSON() });
const fromWire = update => ({ clientID: update.clientID, changes: ChangeSet.fromJSON(update.changes) });

/**
 * `doc` is whatever names a document to the registry, such as `{ path }`.
 *
 * @param {object} options
 * @param {(doc: object, version: number, updates: object[]) => Promise<{accepted: boolean, version: number}>} options.push
 * @param {(doc: object, since: number) => Promise<{updates?: object[], reload?: {text: string, version: number}}>} options.pull
 * @param {(doc: object, event: object) => boolean} options.same whether an update event is for `doc`
 * @param {(error: unknown) => boolean} options.isGone the document no longer exists, so stop sending
 * @param {() => Promise<unknown>} [options.ready] resolves once writes that may create the document have been sent
 * @param {(status: {pending: boolean, failed: boolean}) => void} [options.onStatus]
 * @param {(doc: object, text: string, version: number) => void} [options.onReload] the registry no longer has
 *   the history this client needs; reload the document
 * @param {string} [options.label] names this page in client IDs
 */
export function createDocSync({ push: send, pull: fetchUpdates, same, isGone, ready = async () => {}, onStatus = () => {}, onReload = () => {}, label = "page", pushDelay = PUSH_DELAY_MS }) {
  const clients = new Set();
  let counter = 0;

  // A client outlives its editor state until everything it holds is confirmed:
  // switching notes right after typing must not drop the last keystrokes.
  const stateOf = client => client.attached ? client.view.state : client.state;
  const unsent = client => sendableUpdates(stateOf(client)).length > 0;
  const busy = client => client.inFlight || client.timer !== null || unsent(client);

  function report() {
    onStatus({ pending: [...clients].some(busy), failed: [...clients].some(client => client.failed) });
  }

  function retire(client) {
    if (!client.attached && !client.inFlight && !unsent(client)) {
      clearTimeout(client.timer);
      clients.delete(client);
    }
  }

  function schedule(client, delay = pushDelay) {
    clearTimeout(client.timer);
    client.timer = setTimeout(() => {
      client.timer = null;
      push(client);
    }, delay);
  }

  function dispatch(client, transaction) {
    if (client.attached) client.view.dispatch(transaction);
    else client.state = transaction.state;
  }

  function applyRemote(client, from, updates) {
    const synced = getSyncedVersion(stateOf(client));
    if (from > synced) {
      catchUp(client);
      return;
    }
    const fresh = updates.slice(synced - from);
    if (fresh.length) dispatch(client, receiveUpdates(stateOf(client), fresh.map(fromWire)));
  }

  function catchUp(client) {
    pull(client).catch(error => {
      if (isGone(error)) clients.delete(client);
      else console.error("Could not catch up a document", error);
    });
  }

  async function pull(client) {
    const since = getSyncedVersion(stateOf(client));
    const result = await fetchUpdates(client.doc, since);
    if (!clients.has(client)) return;
    if (result?.reload) {
      clients.delete(client);
      onReload(client.doc, result.reload.text, result.reload.version);
    } else if (Array.isArray(result?.updates)) {
      applyRemote(client, since, result.updates);
    }
  }

  async function push(client) {
    if (!clients.has(client)) return;
    if (client.inFlight) {
      client.again = true;
      return;
    }
    if (!unsent(client)) {
      retire(client);
      report();
      return;
    }
    client.inFlight = true;
    client.again = false;
    report();
    try {
      await ready();
      const updates = sendableUpdates(stateOf(client));
      if (updates.length === 0) return;
      const result = await send(client.doc, getSyncedVersion(stateOf(client)), updates.map(toWire));
      // Our own updates come back through the broadcast; pull if it has not
      // arrived yet, or if another client got in first.
      if (!result?.accepted || getSyncedVersion(stateOf(client)) < result.version) await pull(client);
      client.failed = false;
    } catch (error) {
      if (isGone(error)) {
        clients.delete(client);
        client.failed = false;
      } else {
        console.error("Could not send changes", error);
        client.failed = true;
      }
    } finally {
      client.inFlight = false;
      if (clients.has(client) && unsent(client)) {
        schedule(client, client.failed ? RETRY_DELAY_MS : client.again ? 0 : pushDelay);
      }
      retire(client);
      report();
    }
  }

  /** The collab client for one editor showing `doc` at `version`. */
  function extension(doc, version) {
    counter += 1;
    const clientID = `${label}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
    return [
      collab({ startVersion: version, clientID }),
      ViewPlugin.define(view => {
        const client = { view, state: view.state, attached: true, doc, timer: null, inFlight: false, again: false, failed: false };
        clients.add(client);
        // A restored state may have missed updates while it was put away.
        Promise.resolve(ready()).then(() => catchUp(client));
        return {
          update(update) {
            client.state = update.state;
            if (update.docChanged && sendableUpdates(update.state).length > 0) {
              schedule(client);
              report();
            }
          },
          destroy() {
            client.attached = false;
            if (unsent(client)) schedule(client, 0);
            else retire(client);
          }
        };
      })
    ];
  }

  /** Handles an update event from the registry. */
  function receive(event) {
    if (!event) return;
    for (const client of clients) {
      if (same(client.doc, event)) applyRemote(client, event.from, event.updates);
    }
  }

  /** Sends everything unsent now. Resolves false when a change could not be saved. */
  async function flush() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const waiting = [...clients].filter(client => client.inFlight || unsent(client));
      if (waiting.length === 0) return true;
      await Promise.all(waiting.map(async client => {
        clearTimeout(client.timer);
        client.timer = null;
        while (client.inFlight) await new Promise(resolve => setTimeout(resolve, 10));
        await push(client);
      }));
      if (waiting.some(client => client.failed)) return false;
    }
    return ![...clients].some(unsent);
  }

  /** Whether any client, or any of the documents `filter` picks, has changes not yet confirmed. */
  const pending = (filter = () => true) => [...clients].some(client => filter(client.doc) && busy(client));

  return { extension, receive, flush, pending };
}
