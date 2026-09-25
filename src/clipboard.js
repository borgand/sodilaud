// SPDX-License-Identifier: GPL-3.0-or-later

// Standalone popup page: no imports and no storage. Values arrive masked from
// Rust; plaintext is fetched only on reveal and dies with this window.

const REFRESH_MS = 1000;
const EXPIRING_SECONDS = 60;

export function formatRemaining(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
}

export function slotKey(index) {
  if (index < 9) return String(index + 1);
  return index === 9 ? "0" : "";
}

export function createPopup({ document, invoke, close }) {
  const list = document.getElementById("clip-list");
  const empty = document.getElementById("clip-empty");
  const ttl = document.getElementById("clip-ttl");
  let items = [];
  let focused = 0;
  let focusedId;
  const revealed = new Map();

  function focus(index) {
    focused = index;
    focusedId = items[index]?.id;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    const rows = items.map((item, index) => {
      const row = element("li", "clip-row");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === focused));
      if (index === focused) row.classList.add("clip-focused");
      if (item.secondsLeft < EXPIRING_SECONDS) row.classList.add("clip-expiring");
      const plain = revealed.get(item.id);
      if (plain !== undefined) row.classList.add("clip-revealed");
      row.append(element("span", "clip-slot", slotKey(index)));
      row.append(element("span", "clip-text", plain ?? item.text));
      if (item.extraLines > 0 && plain === undefined) row.append(element("span", "clip-extra", `+${item.extraLines}`));
      if (item.masked) {
        const eye = element("button", "clip-icon clip-reveal", plain === undefined ? "👁" : "◡");
        eye.type = "button";
        eye.setAttribute("aria-label", plain === undefined ? "Reveal" : "Hide");
        eye.addEventListener("click", (event) => { event.stopPropagation(); focus(index); toggleReveal(index); });
        row.append(eye);
      }
      row.append(element("span", "clip-time", formatRemaining(item.secondsLeft)));
      const trash = element("button", "clip-icon clip-trash", "🗑");
      trash.type = "button";
      trash.setAttribute("aria-label", "Delete");
      trash.addEventListener("click", (event) => { event.stopPropagation(); remove(index); });
      row.append(trash);
      row.addEventListener("click", () => pick(index));
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = items.length > 0;
    rows[focused]?.scrollIntoView?.({ block: "nearest" });
  }

  async function refresh() {
    try {
      const listing = await invoke("clip_list");
      items = listing.items;
      ttl.textContent = `${listing.ttlMinutes} min TTL`;
      empty.textContent = `Nothing copied yet. Entries expire after ${listing.ttlMinutes} min.`;
    } catch {
      items = [];
    }
    for (const id of [...revealed.keys()]) {
      if (!items.some((item) => item.id === id)) revealed.delete(id);
    }
    const kept = items.findIndex((item) => item.id === focusedId);
    focus(kept >= 0 ? kept : Math.min(focused, Math.max(items.length - 1, 0)));
    render();
  }

  async function pick(index) {
    const item = items[index];
    if (item) await invoke("clip_select", { id: item.id }).catch(() => refresh());
  }

  async function toggleReveal(index) {
    const item = items[index];
    if (!item?.masked) return;
    if (revealed.has(item.id)) {
      revealed.delete(item.id);
    } else {
      try {
        revealed.set(item.id, await invoke("clip_reveal", { id: item.id }));
      } catch {
        await refresh();
        return;
      }
    }
    render();
  }

  async function remove(index) {
    const item = items[index];
    if (!item) return;
    revealed.delete(item.id);
    await invoke("clip_delete", { id: item.id }).catch(() => {});
    await refresh();
  }

  async function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const slot = event.key === "0" ? 9 : Number.parseInt(event.key, 10) - 1;
    if (/^[0-9]$/.test(event.key)) return pick(slot);
    switch (event.key) {
      case "ArrowDown": focus(Math.min(focused + 1, Math.max(items.length - 1, 0))); render(); break;
      case "ArrowUp": focus(Math.max(focused - 1, 0)); render(); break;
      case "Enter": return pick(focused);
      case " ": event.preventDefault?.(); return toggleReveal(focused);
      case "Backspace": case "Delete": return remove(focused);
      case "Escape": return close();
      default: break;
    }
  }

  document.addEventListener("keydown", onKey);
  document.getElementById("clip-close")?.addEventListener("click", () => close());
  return { refresh, onKey, state: () => ({ items, focused, revealed }) };
}

if (globalThis.window?.__TAURI__) {
  const tauri = window.__TAURI__;
  const popup = createPopup({
    document,
    invoke: tauri.core.invoke,
    close: () => tauri.window.getCurrentWindow().destroy()
  });
  popup.refresh();
  setInterval(popup.refresh, REFRESH_MS);
}
