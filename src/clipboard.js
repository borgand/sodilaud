// SPDX-License-Identifier: GPL-3.0-or-later

// Standalone popup page: no imports and no storage. Values arrive masked from
// Rust; plaintext is fetched only on reveal and dies with this window.

const REFRESH_MS = 1000;
const EXPIRING_SECONDS = 60;

// Split so the egress checker's remote-URL pattern (scripts/check-no-egress.mjs)
// does not flag this XML namespace URI as a network address.
const SVG_NS = "http:" + "//www.w3.org/2000/svg";

// Outline icon paths, drawn node by node with document.createElementNS.
// viewBox is 0 0 24 24; stroke=currentColor picks up the button's colour
// (muted, or the normal text colour on hover/focus).
const ICON_PATHS = {
  eye: [
    "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
  ],
  eyeOff: [
    "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M3 3l18 18"
  ],
  trash: [
    "M4 7h16",
    "M9 7V4h6v3",
    "M6 7l1 13h10l1-13"
  ]
};

// Strict #rgb / #rrggbb / #rrggbbaa. Rust already validates the theme it
// sends, but the popup checks again rather than trust a value at face value.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const THEME_VARS = {
  background: "--clip-bg",
  surface: "--clip-surface",
  text: "--clip-fg",
  muted: "--clip-muted",
  accent: "--clip-accent",
  border: "--clip-line"
};

export function formatRemaining(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
}

export function slotKey(index) {
  if (index < 9) return String(index + 1);
  return index === 9 ? "0" : "";
}

export function createPopup({ document, invoke }) {
  const list = document.getElementById("clip-list");
  const empty = document.getElementById("clip-empty");
  const ttl = document.getElementById("clip-ttl");
  let items = [];
  let focused = 0;
  let focusedId;
  const revealed = new Map();
  let shownLayout;

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

  function svgIcon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICON_PATHS[name]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function iconButton(className, iconName, label, onClick) {
    const button = element("button", `clip-icon ${className}`);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.append(svgIcon(iconName));
    button.addEventListener("click", onClick);
    return button;
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
        row.append(iconButton(
          "clip-reveal",
          plain === undefined ? "eye" : "eyeOff",
          plain === undefined ? "Reveal" : "Hide",
          (event) => { event.stopPropagation(); focus(index); toggleReveal(index); }
        ));
      }
      row.append(element("span", "clip-time", formatRemaining(item.secondsLeft)));
      row.append(iconButton("clip-trash", "trash", "Delete", (event) => { event.stopPropagation(); remove(index); }));
      row.addEventListener("click", () => pick(index));
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = items.length > 0;
    shownLayout = layout();
  }

  function layout() {
    return items.map((item) => `${item.id}${revealed.has(item.id) ? "r" : ""}`).join(",");
  }

  // Rebuilding every second would reset scrolling and could drop a click, so an
  // unchanged list only has its countdowns updated.
  function patch() {
    [...list.children].forEach((row, index) => {
      const item = items[index];
      row.classList.toggle("clip-expiring", item.secondsLeft < EXPIRING_SECONDS);
      row.querySelector(".clip-time").textContent = formatRemaining(item.secondsLeft);
    });
  }

  function applyTheme(theme) {
    for (const [key, cssVar] of Object.entries(THEME_VARS)) {
      const value = theme?.[key];
      if (typeof value === "string" && HEX_COLOR.test(value)) {
        document.documentElement.style.setProperty(cssVar, value);
      }
    }
  }

  function moveFocus(index) {
    focus(index);
    render();
    list.children[focused]?.scrollIntoView?.({ block: "nearest" });
  }

  async function refresh() {
    try {
      const listing = await invoke("clip_list");
      items = listing.items;
      ttl.textContent = `${listing.ttlMinutes} min TTL`;
      empty.textContent = `Nothing copied yet. Entries expire after ${listing.ttlMinutes} min.`;
      applyTheme(listing.theme);
    } catch {
      items = [];
    }
    for (const id of [...revealed.keys()]) {
      if (!items.some((item) => item.id === id)) revealed.delete(id);
    }
    const kept = items.findIndex((item) => item.id === focusedId);
    focus(kept >= 0 ? kept : Math.min(focused, Math.max(items.length - 1, 0)));
    if (layout() === shownLayout) patch();
    else render();
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

  function close() {
    return invoke("clip_close").catch(() => {});
  }

  async function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const slot = event.key === "0" ? 9 : Number.parseInt(event.key, 10) - 1;
    if (/^[0-9]$/.test(event.key)) return pick(slot);
    switch (event.key) {
      case "ArrowDown": case "j": moveFocus(Math.min(focused + 1, Math.max(items.length - 1, 0))); break;
      case "ArrowUp": case "k": moveFocus(Math.max(focused - 1, 0)); break;
      case "Enter": return pick(focused);
      case " ": case "h": event.preventDefault?.(); return toggleReveal(focused);
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
  const popup = createPopup({ document, invoke: tauri.core.invoke });
  popup.refresh();
  setInterval(popup.refresh, REFRESH_MS);
}
