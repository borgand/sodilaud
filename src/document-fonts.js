// SPDX-License-Identifier: GPL-3.0-or-later

// Body, heading and code fonts of the document, shared by both windows. A font
// is a curated id or a system font name typed by the user; either way only a
// validated value ever reaches a CSS custom property.

const SANS_STACK = "'Inter', -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "'JetBrains Mono', \"Fira Code\", Menlo, Monaco, Consolas, \"Courier New\", monospace";

export const CURATED_FONTS = [
  { id: "inter", name: "Inter", kind: "sans", stack: SANS_STACK },
  { id: "ibm-plex-serif", name: "IBM Plex Serif", kind: "serif", stack: "'IBM Plex Serif', Georgia, \"Times New Roman\", serif" },
  { id: "jetbrains-mono", name: "JetBrains Mono", kind: "mono", stack: MONO_STACK },
  { id: "ibm-plex-mono", name: "IBM Plex Mono", kind: "mono", stack: "'IBM Plex Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace" }
];

export const FONT_KEYS = {
  body: "sodilaud_font_body",
  heading: "sodilaud_font_heading",
  code: "sodilaud_font_code"
};

const SLOTS = Object.keys(FONT_KEYS);
const SYSTEM_PREFIX = "system:";
const SYSTEM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,62}$/u;

const curated = (id) => CURATED_FONTS.find((font) => font.id === id);

export function normalizeFontValue(value, slot) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  const font = curated(text);
  if (font) return slot === "code" && font.kind !== "mono" ? "" : font.id;
  if (!text.startsWith(SYSTEM_PREFIX)) return "";
  const name = text.slice(SYSTEM_PREFIX.length).trim();
  return SYSTEM_NAME.test(name) ? `${SYSTEM_PREFIX}${name}` : "";
}

function fontStack(value, slot) {
  if (value.startsWith(SYSTEM_PREFIX)) {
    return `"${value.slice(SYSTEM_PREFIX.length)}", ${slot === "code" ? MONO_STACK : SANS_STACK}`;
  }
  return curated(value).stack;
}

function fontName(value) {
  return value.startsWith(SYSTEM_PREFIX) ? value.slice(SYSTEM_PREFIX.length) : curated(value).name;
}

const THEME_KEYS = { body: "fontBody", heading: "fontHeading", code: "fontCode" };
const DEFAULTS = { body: "inter", code: "jetbrains-mono" };

// The value each slot resolves to: the user's choice, else the theme's, else
// the default. An empty heading follows the body.
function resolveValues(user = {}, theme = {}) {
  const pick = (slot) =>
    normalizeFontValue(user[slot], slot) || normalizeFontValue(theme?.[THEME_KEYS[slot]], slot);
  const body = pick("body") || DEFAULTS.body;
  return { body, heading: pick("heading") || body, code: pick("code") || DEFAULTS.code };
}

export function resolveFonts(user, theme) {
  const values = resolveValues(user, theme);
  return Object.fromEntries(SLOTS.map((slot) => [slot, fontStack(values[slot], slot)]));
}

export function createDocumentFonts({ document, storage, broadcast = () => {}, themeFonts = () => undefined, onApplied = () => {} }) {
  const root = document.documentElement;
  const controls = Object.fromEntries(SLOTS.map((slot) => [slot, {
    select: document.getElementById(`font-${slot}-select`),
    field: document.getElementById(`font-${slot}-system`)
  }]));

  const stored = () => Object.fromEntries(SLOTS.map((slot) => [slot, normalizeFontValue(storage.getItem(FONT_KEYS[slot]) ?? "", slot)]));

  function buildOptions(slot) {
    const { select } = controls[slot];
    if (!select || select.options.length) return;
    const add = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    };
    add("", "");
    for (const font of CURATED_FONTS) {
      if (slot !== "code" || font.kind === "mono") add(font.id, font.name);
    }
    add("system", "System font…");
  }

  function defaultLabel(slot, user, theme) {
    const values = resolveValues({ ...user, [slot]: "" }, theme);
    if (slot === "heading" && !normalizeFontValue(theme?.fontHeading, "heading")) return "Theme default (same as body)";
    return `Theme default (${fontName(values[slot])})`;
  }

  function syncControls(user, theme) {
    for (const slot of SLOTS) {
      const { select, field } = controls[slot];
      if (!select) continue;
      buildOptions(slot);
      select.options[0].textContent = defaultLabel(slot, user, theme);
      const value = user[slot];
      const isSystem = value.startsWith(SYSTEM_PREFIX);
      select.value = isSystem ? "system" : value;
      if (field) {
        field.hidden = !isSystem;
        if (isSystem) field.value = value.slice(SYSTEM_PREFIX.length);
        field.removeAttribute("aria-invalid");
      }
    }
  }

  function apply() {
    const user = stored();
    const theme = themeFonts();
    const fonts = resolveFonts(user, theme);
    root.style.setProperty("--doc-font-body", fonts.body);
    root.style.setProperty("--doc-font-heading", fonts.heading);
    root.style.setProperty("--doc-font-code", fonts.code);
    syncControls(user, theme);
  }

  function choose(slot, value) {
    storage.setItem(FONT_KEYS[slot], value);
    broadcast(FONT_KEYS[slot]);
    apply();
    onApplied();
  }

  function commitSystemName(slot) {
    const { field } = controls[slot];
    const value = normalizeFontValue(`${SYSTEM_PREFIX}${field.value}`, slot);
    if (!value) {
      field.setAttribute("aria-invalid", "true");
      return;
    }
    choose(slot, value);
  }

  for (const slot of SLOTS) {
    const { select, field } = controls[slot];
    if (select) {
      buildOptions(slot);
      select.addEventListener("change", () => {
        if (select.value === "system") {
          if (field) {
            field.hidden = false;
            field.focus();
          }
          return;
        }
        choose(slot, select.value);
      });
    }
    if (field) {
      field.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commitSystemName(slot);
      });
      field.addEventListener("blur", () => {
        if (!field.hidden) commitSystemName(slot);
      });
    }
  }

  function reload(key) {
    if (!Object.values(FONT_KEYS).includes(key)) return false;
    apply();
    onApplied();
    return true;
  }

  return { load: apply, reload, apply };
}
