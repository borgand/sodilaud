// SPDX-License-Identifier: GPL-3.0-or-later

// Standalone popup page: no imports and no storage. Values arrive masked from
// Rust; plaintext is fetched only on reveal. The window is reused: Rust calls
// hide() on every close, which forgets everything the page was shown.

const REFRESH_MS = 1000;
const EXPIRING_SECONDS = 60;

// Icon markup lives in <template> elements in clipboard.html, drawn once by the
// HTML parser (which puts <svg> in the SVG namespace on its own) and cloned here.
const ICON_TEMPLATES = { eye: "icon-eye", eyeOff: "icon-eye-slash", trash: "icon-trash" };

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

// Resolves once the current DOM has been painted: the second frame callback runs
// after the frame that drew it. No timeout: Rust never shows unpainted content and
// has its own fallbacks.
function afterNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

export function createPopup({ document, invoke, timers = globalThis, afterPaint = afterNextPaint }) {
  const list = document.getElementById("clip-list");
  const empty = document.getElementById("clip-empty");
  const ttl = document.getElementById("clip-ttl");
  let items = [];
  let focused = 0;
  let focusedId;
  const revealed = new Map();
  let shownLayout;
  // Bumped by every show and hide, so an answer that arrives afterwards is dropped.
  let session = 0;
  let hidden = false;
  let timer;

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
    return document.getElementById(ICON_TEMPLATES[name]).content.firstElementChild.cloneNode(true);
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
      // Fixed cell order (slot, text, eye, time, trash) on every row, masked or
      // not, so the columns line up: an unmasked row gets an empty eye-slot
      // placeholder instead of skipping that cell.
      const main = element("span", "clip-main");
      main.append(element("span", "clip-text", plain ?? item.text));
      if (item.extraLines > 0 && plain === undefined) main.append(element("span", "clip-extra", `+${item.extraLines}`));
      row.append(element("span", "clip-slot", slotKey(index)));
      row.append(main);
      row.append(item.masked
        ? iconButton(
            "clip-reveal",
            plain === undefined ? "eye" : "eyeOff",
            plain === undefined ? "Reveal" : "Hide",
            (event) => { event.stopPropagation(); focus(index); toggleReveal(index); }
          )
        : element("span", "clip-eye-slot"));
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
    if (hidden) return;
    const asked = session;
    const listing = await invoke("clip_list").catch(() => undefined);
    if (asked !== session) return;
    if (listing) {
      items = listing.items;
      ttl.textContent = `${listing.ttlMinutes} min TTL`;
      empty.textContent = `Nothing copied yet. Entries expire after ${listing.ttlMinutes} min.`;
      applyTheme(listing.theme);
    } else {
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

  async function pick(index, paste = false) {
    const item = items[index];
    if (item) await invoke("clip_select", { id: item.id, paste }).catch(() => refresh());
  }

  async function toggleReveal(index) {
    const item = items[index];
    if (!item?.masked) return;
    if (revealed.has(item.id)) {
      revealed.delete(item.id);
    } else {
      const asked = session;
      try {
        const plain = await invoke("clip_reveal", { id: item.id });
        if (asked !== session) return;
        revealed.set(item.id, plain);
      } catch {
        if (asked === session) await refresh();
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

  function clear() {
    session += 1;
    hidden = true;
    if (timer !== undefined) timers.clearInterval(timer);
    timer = undefined;
    revealed.clear();
    items = [];
    focus(0);
    list.replaceChildren();
    empty.hidden = true;
    shownLayout = undefined;
  }

  // Rust orders the panel out only after this reports the emptied page painted.
  async function hide(token) {
    clear();
    const hid = session;
    await afterPaint();
    if (hid !== session) return;
    await invoke("clip_hidden", { token }).catch(() => {});
  }

  // Rust makes the panel visible only after this reports the list painted.
  async function show(token) {
    clear();
    hidden = false;
    const shown = session;
    await refresh();
    if (shown !== session) return;
    timer = timers.setInterval(refresh, REFRESH_MS);
    await afterPaint();
    if (shown !== session) return;
    await invoke("clip_shown", { token }).catch(() => {});
  }

  function startDrag(event) {
    if (event.button !== 0 || event.target.closest?.("#clip-close")) return;
    invoke("clip_start_drag").catch(() => {});
  }

  async function onKey(event) {
    if (event.metaKey && event.key === "Enter" && !event.ctrlKey && !event.altKey) return pick(focused, true);
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
  document.querySelector(".clip-header")?.addEventListener("mousedown", startDrag);
  return { refresh, onKey, show, hide, state: () => ({ items, focused, revealed }) };
}

// Rust drives the page through these hooks (see show_script and hide_script in
// src-tauri/src/clipboard/popup_state.rs). A show that arrived before this module
// ran left its token behind instead.
export function attach(win, popup) {
  win.__sodilaudClip = { show: popup.show, hide: popup.hide };
  const token = win.__sodilaudClipPending;
  if (token) {
    win.__sodilaudClipPending = false;
    popup.show(token);
  }
}

if (globalThis.window?.__TAURI__) {
  attach(window, createPopup({ document, invoke: window.__TAURI__.core.invoke }));
}
