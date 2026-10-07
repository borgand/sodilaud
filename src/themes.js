// SPDX-License-Identifier: GPL-3.0-or-later

// Built-in and imported color themes. Both windows apply the active theme; only
// a page with the picker markup (the main window) can change it. Every element
// is looked up by id and may be missing.

import { ACTIVE_TEXT_PROPERTIES, DERIVED_THEME_PROPERTIES, deriveThemeSurfaceColors, isValidColor } from "./theme-colors.js";
import { createCssColorResolver, createOpaqueColorParser, isColorDark } from "./css-color.js";
import { PRESET_THEMES } from "./preset-themes.js";
import { escapeHTML } from "./syntax-highlighting.js";

export const THEME_STORAGE_KEYS = ["sodilaud_active_theme", "sodilaud_custom_themes", "color-scheme"];

export const DEFAULT_THEME_ID = "executive";

const LEGACY_THEME_IDS = {
  "macintosh-system-7": "mac-os-9-platinum"
};

function setText(element, text) {
  if (element) element.textContent = text;
}

export function createThemes({ document, storage, invoke, onApplied = () => {}, onChanged = () => {} }) {
  const byId = (id) => document.getElementById(id);
  const themeToggleBtn = byId("theme-toggle");
  const themePickerBtn = byId("theme-picker-btn");
  const activeThemeMenuValue = byId("active-theme-menu-value");
  const themeModalBackdrop = byId("theme-modal-backdrop");
  const themeModal = byId("theme-modal");
  const closeThemeBtn = byId("close-theme-btn");
  const themeGrid = byId("theme-grid");
  const resolveCssColor = createCssColorResolver(document);
  const parseOpaqueThemeColor = createOpaqueColorParser(resolveCssColor);
  const window = document.defaultView;
  const Blob = window.Blob;
  const URL = window.URL;

  let customThemes = [];
  let activeThemeId = DEFAULT_THEME_ID;
  let isThemeModalOpen = false;
  let themeModalPreviousFocus = null;

  function setTheme(theme, pin = true) {
    const isDark = theme === "dark";

    if (isDark) {
      document.documentElement.classList.add("theme-dark");
      document.documentElement.classList.remove("theme-light");
      setText(themeToggleBtn?.querySelector(".btn-text"), "Theme: Default Dark");
      setText(activeThemeMenuValue, "Default Dark");
    } else {
      document.documentElement.classList.add("theme-light");
      document.documentElement.classList.remove("theme-dark");
      setText(themeToggleBtn?.querySelector(".btn-text"), "Theme: Default Light");
      setText(activeThemeMenuValue, "Default Light");
    }

    if (pin) {
      storage.setItem("color-scheme", theme);
    } else {
      storage.removeItem("color-scheme");
    }
  }

  function openThemeModal() {
    const menu = byId("actions-dropdown-content");
    themeModalPreviousFocus = menu?.contains(document.activeElement)
      ? byId("actions-btn")
      : document.activeElement;
    isThemeModalOpen = true;
    themeModalBackdrop.style.display = "flex";
    themeModalBackdrop.setAttribute("aria-hidden", "false");
    themeToggleBtn?.setAttribute("aria-expanded", "true");
    themePickerBtn?.setAttribute("aria-expanded", "true");
    renderThemeGrid();
    closeThemeBtn.focus({ preventScroll: true });
  }

  function closeThemeModal() {
    isThemeModalOpen = false;
    themeModalBackdrop.style.display = "none";
    themeModalBackdrop.setAttribute("aria-hidden", "true");
    themeToggleBtn?.setAttribute("aria-expanded", "false");
    themePickerBtn?.setAttribute("aria-expanded", "false");
    if (themeModalPreviousFocus && themeModalPreviousFocus.isConnected) {
      themeModalPreviousFocus.focus({ preventScroll: true });
    }
    themeModalPreviousFocus = null;
  }

  function loadSavedThemes() {
    try {
      const saved = storage.getItem("sodilaud_custom_themes");
      if (saved) {
        const parsedThemes = JSON.parse(saved);
        if (Array.isArray(parsedThemes)) {
          customThemes = parsedThemes
            .map((theme, index) => normalizeCustomTheme(theme, index))
            .filter(Boolean);
          storage.setItem("sodilaud_custom_themes", JSON.stringify(customThemes));
        }
      }
    } catch (e) {}

    const storedThemeId = storage.getItem("sodilaud_active_theme");
    const savedThemeId = LEGACY_THEME_IDS[storedThemeId] || storedThemeId;
    const themeExists = [...PRESET_THEMES, ...customThemes]
      .some((theme) => theme.id === savedThemeId);

    if (savedThemeId && themeExists) {
      if (savedThemeId !== storedThemeId) {
        storage.setItem("sodilaud_active_theme", savedThemeId);
      }
      applyTheme(savedThemeId);
    } else {
      applyTheme(DEFAULT_THEME_ID);
    }
  }

  function applyTheme(themeId) {
    activeThemeId = themeId;
    storage.setItem("sodilaud_active_theme", themeId);

    const root = document.documentElement;
    const themeBtnText = document.getElementById("theme-btn-text");

    if (themeId === "default-dark") {
      clearCustomThemeStyles();
      setTheme("dark");
      if (themeBtnText) themeBtnText.textContent = "Theme: Default Dark";
      renderThemeGrid();
      onApplied();
      return;
    }
    if (themeId === "default-light") {
      clearCustomThemeStyles();
      setTheme("light");
      if (themeBtnText) themeBtnText.textContent = "Theme: Default Light";
      renderThemeGrid();
      onApplied();
      return;
    }

    const allThemes = [...PRESET_THEMES, ...customThemes];
    const theme = allThemes.find(t => t.id === themeId);
    if (!theme) return;

    if (theme.uiStyle) {
      root.dataset.themeStyle = theme.uiStyle;
    } else {
      delete root.dataset.themeStyle;
    }

    // Drop anything derived for the previous theme first. A theme whose colours
    // can only be partly measured sets only part of the list, and a stale
    // --text-on-active from a dark theme is exactly how near-white text ends up
    // on a pale row.
    DERIVED_THEME_PROPERTIES.forEach(prop => root.style.removeProperty(prop));

    const isDark = isColorDark(theme.background, resolveCssColor);
    if (isDark) {
      document.documentElement.classList.add("theme-dark");
      document.documentElement.classList.remove("theme-light");
    } else {
      document.documentElement.classList.add("theme-light");
      document.documentElement.classList.remove("theme-dark");
    }

    root.style.setProperty("--bg-app", theme.background);
    root.style.setProperty("--editor-bg", theme.background);
    root.style.setProperty("--editor-text", theme.foreground);
    root.style.setProperty("--preview-bg", theme.background);
    root.style.setProperty("--preview-text", theme.foreground);
    root.style.setProperty("--bg-sidebar", theme.sidebar || theme.background);
    root.style.setProperty("--sidebar-bg", theme.sidebar || theme.background);
    root.style.setProperty("--statusbar-bg", theme.sidebar || theme.background);
    root.style.setProperty("--topbar-bg", theme.sidebar || theme.background);
    root.style.setProperty("--dropdown-bg", theme.sidebar || theme.background);
    root.style.setProperty("--border-color", theme.border || "rgba(128,128,128,0.2)");
    root.style.setProperty("--text-primary", theme.foreground);
    root.style.setProperty("--accent-color", theme.accent || "#3b82f6");
    root.style.setProperty("--accent-hover", theme.accent || "#3b82f6");
    root.style.setProperty("--bg-note-active", theme.selection || "rgba(59,130,246,0.15)");
    root.style.setProperty("--border-note-active", theme.accent || "#3b82f6");

    // Sidebar text tones are derived from the theme rather than inherited from
    // the built-in palette, so preview snippets stay readable on every theme.
    // This runs last so it can also refine --bg-note-active; themes whose colours
    // aren't parseable keep the plain values set above.
    const derived = deriveThemeSurfaceColors(theme, parseOpaqueThemeColor) || {};
    Object.entries(derived).forEach(([prop, value]) => root.style.setProperty(prop, value));

    // The active row rebinds its text to the on-active tones whether or not we
    // could measure them, so anything left underived is pinned to the theme's own
    // foreground. That keeps the row at the contrast its author chose instead of
    // resolving to a built-in palette picked by a light/dark guess that cannot
    // read this theme's colours either.
    ACTIVE_TEXT_PROPERTIES
      .filter(prop => !derived[prop])
      .forEach(prop => root.style.setProperty(prop, theme.foreground));

    if (themeBtnText) {
      themeBtnText.textContent = `Theme: ${theme.name}`;
    }
    setText(activeThemeMenuValue, theme.name);

    renderThemeGrid();
    onApplied();
  }

  function clearCustomThemeStyles() {
    const root = document.documentElement;
    const props = [
      "--bg-app", "--editor-bg", "--editor-text", "--preview-bg", "--preview-text",
      "--bg-sidebar", "--sidebar-bg", "--statusbar-bg", "--topbar-bg", "--dropdown-bg",
      "--border-color", "--text-primary", "--accent-color", "--accent-hover",
      "--border-note-active",
      ...DERIVED_THEME_PROPERTIES
    ];
    props.forEach(p => root.style.removeProperty(p));
    delete root.dataset.themeStyle;
  }

  function normalizeCustomTheme(theme, index = 0) {
    if (!theme || typeof theme !== "object") return null;
    if (!isValidColor(theme.background) || !isValidColor(theme.foreground)) return null;

    return {
      id: typeof theme.id === "string" && theme.id ? theme.id : `custom_saved_${index}`,
      name: typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : `Custom Theme ${index + 1}`,
      background: theme.background.trim(),
      foreground: theme.foreground.trim(),
      sidebar: isValidColor(theme.sidebar) ? theme.sidebar.trim() : theme.background.trim(),
      accent: isValidColor(theme.accent) ? theme.accent.trim() : "#3b82f6",
      border: isValidColor(theme.border) ? theme.border.trim() : "rgba(128,128,128,0.2)",
      selection: isValidColor(theme.selection) ? theme.selection.trim() : "rgba(59,130,246,0.2)",
      isCustom: true
    };
  }

  async function promptImportError(title, message) {
    if (window.__TAURI__) {
      try {
        await invoke("show_alert_dialog", { title, message });
        return;
      } catch (e) {}
    }
    alert(`${title}\n\n${message}`);
  }

  function renderThemeGrid() {
    if (!themeGrid) return;
    themeGrid.innerHTML = "";

    const allThemes = [...PRESET_THEMES, ...customThemes];

    allThemes.forEach(theme => {
      const card = document.createElement("div");
      card.className = `theme-card ${theme.id === activeThemeId ? "active" : ""}`;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Use ${theme.name} theme`);
      card.setAttribute("aria-pressed", String(theme.id === activeThemeId));

      card.innerHTML = `
        <div class="theme-card-header">
          <span class="theme-card-name">${escapeHTML(theme.name)}</span>
          ${theme.id === activeThemeId ? '<span class="theme-card-badge">Active</span>' : ''}
        </div>
        <div class="theme-card-preview" style="background-color: ${theme.background};">
          <div class="theme-preview-sidebar" style="background-color: ${theme.sidebar || theme.background}; border-right: 1px solid ${theme.border || 'rgba(128,128,128,0.2)'};">
            <div class="theme-preview-line" style="background-color: ${theme.accent}; width: 60%;"></div>
            <div class="theme-preview-line" style="background-color: ${theme.foreground}; opacity: 0.5;"></div>
            <div class="theme-preview-line" style="background-color: ${theme.foreground}; opacity: 0.3;"></div>
          </div>
          <div class="theme-preview-editor" style="background-color: ${theme.background};">
            <div class="theme-preview-accent" style="background-color: ${theme.accent};"></div>
            <div class="theme-preview-line" style="background-color: ${theme.foreground}; opacity: 0.8; width: 90%;"></div>
            <div class="theme-preview-line" style="background-color: ${theme.foreground}; opacity: 0.5; width: 70%;"></div>
          </div>
        </div>
        ${theme.isCustom ? `
          <button class="theme-card-delete" title="Delete custom theme" aria-label="Delete ${escapeHTML(theme.name)} theme">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        ` : ''}
      `;

      card.addEventListener("click", () => {
        chooseTheme(theme.id);
      });

      card.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && !event.target.closest(".theme-card-delete")) {
          event.preventDefault();
          chooseTheme(theme.id);
        }
      });

      if (theme.isCustom) {
        const delBtn = card.querySelector(".theme-card-delete");
        if (delBtn) {
          delBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteCustomTheme(theme.id);
          });
        }
      }

      themeGrid.appendChild(card);
    });
  }

  function deleteCustomTheme(themeId) {
    customThemes = customThemes.filter(t => t.id !== themeId);
    storage.setItem("sodilaud_custom_themes", JSON.stringify(customThemes));
    if (activeThemeId === themeId) {
      applyTheme(DEFAULT_THEME_ID);
    } else {
      renderThemeGrid();
    }
    onChanged();
  }

  async function importThemeFile() {
    try {
      let fileContent = "";
      let fileName = "";

      if (window.__TAURI__) {
        const selected = await invoke("import_file_native");
        if (!selected || !selected.content) return;
        fileContent = selected.content;
        fileName = selected.title || "imported_theme.json";
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,.toml,.yaml,.yml,.conf,.txt";
        input.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          fileName = file.name;
          fileContent = await file.text();
          await processImportedTheme(fileContent, fileName);
        };
        input.click();
        return;
      }

      await processImportedTheme(fileContent, fileName);
    } catch (err) {
      console.error("Theme import failed:", err);
      await promptImportError("Theme Import Error", `Failed to read theme file: ${err}`);
    }
  }

  async function processImportedTheme(content, fileName) {
    if (!content || !content.trim()) {
      await promptImportError(
        "Theme Import Error",
        `The file "${fileName}" is empty.`
      );
      return;
    }

    const result = parseThemeContent(content, fileName);
    if (!result.success) {
      await promptImportError(
        "Invalid Theme File",
        `Could not import "${fileName}".\n\nReason: ${result.error}\n\nPlease ensure your file is a valid JSON or TOML color scheme with valid HEX or RGB color codes for "background" and "foreground".`
      );
      return;
    }

    const theme = result.theme;
    const existingIdx = customThemes.findIndex(t => t.id === theme.id || t.name.toLowerCase() === theme.name.toLowerCase());
    if (existingIdx !== -1) {
      customThemes[existingIdx] = theme;
    } else {
      customThemes.push(theme);
    }

    storage.setItem("sodilaud_custom_themes", JSON.stringify(customThemes));
    chooseTheme(theme.id);
  }

  function parseThemeContent(content, fileName) {
    const cleanName = fileName.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");

    // 1. Try JSON
    try {
      const data = JSON.parse(content);
      if (typeof data !== "object" || data === null) {
        return { success: false, error: "Root JSON is not an object" };
      }

      const colors = data.colors || data;
      const bg = colors.background || colors["editor.background"] || colors.bg || colors.editor_bg;
      const fg = colors.foreground || colors["editor.foreground"] || colors.fg || colors.editor_text;

      if (!bg || !fg) {
        return { success: false, error: "Missing required 'background' or 'foreground' color properties" };
      }
      if (!isValidColor(bg)) {
        return { success: false, error: `Invalid background color value: "${bg}"` };
      }
      if (!isValidColor(fg)) {
        return { success: false, error: `Invalid foreground color value: "${fg}"` };
      }

      const sb = colors.sidebar || colors["sideBar.background"] || colors.sidebar_bg || colors["activityBar.background"] || bg;
      const accent = colors.accent || colors.cursor || colors["activityBar.foreground"] || colors["editorCursor.foreground"] || "#3b82f6";
      const border = colors.border || colors["panel.border"] || colors["sideBar.border"] || "rgba(128,128,128,0.2)";
      const sel = colors.selection || colors["editor.selectionBackground"] || colors["list.activeSelectionBackground"] || "rgba(59,130,246,0.2)";

      return {
        success: true,
        theme: {
          id: "custom_" + Date.now(),
          name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : cleanName,
          background: bg,
          foreground: fg,
          sidebar: isValidColor(sb) ? sb : bg,
          accent: isValidColor(accent) ? accent : "#3b82f6",
          border: isValidColor(border) ? border : "rgba(128,128,128,0.2)",
          selection: isValidColor(sel) ? sel : "rgba(59,130,246,0.2)",
          isCustom: true
        }
      };
    } catch (e) {
      // If not valid JSON, proceed to TOML / Key-Value check
    }

    // 2. Try TOML / Key-Value / Alacritty / Ghostty style
    const lines = content.split("\n");
    const kv = {};
    for (const line of lines) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const match = clean.match(/^([a-zA-Z0-9_.-]+)\s*[:=]\s*["']?([^"'\r\n#]+)["']?/);
      if (match) {
        kv[match[1].toLowerCase()] = match[2].trim();
      }
    }

    const bg = kv.background || kv.bg || kv.editor_bg;
    const fg = kv.foreground || kv.fg || kv.editor_text;

    if (bg && fg) {
      if (!isValidColor(bg)) {
        return { success: false, error: `Invalid background color value: "${bg}"` };
      }
      if (!isValidColor(fg)) {
        return { success: false, error: `Invalid foreground color value: "${fg}"` };
      }

      const sb = kv.sidebar || kv.sidebar_bg || bg;
      const accent = kv.accent || kv.cursor || "#3b82f6";
      const border = kv.border || "rgba(128,128,128,0.2)";
      const sel = kv.selection || "rgba(59,130,246,0.2)";

      return {
        success: true,
        theme: {
          id: "custom_" + Date.now(),
          name: typeof kv.name === "string" && kv.name.trim() ? kv.name.trim() : cleanName,
          background: bg,
          foreground: fg,
          sidebar: isValidColor(sb) ? sb : bg,
          accent: isValidColor(accent) ? accent : "#3b82f6",
          border: isValidColor(border) ? border : "rgba(128,128,128,0.2)",
          selection: isValidColor(sel) ? sel : "rgba(59,130,246,0.2)",
          isCustom: true
        }
      };
    }

    return { 
      success: false, 
      error: "File could not be parsed as valid JSON or TOML/Key-Value color scheme with valid 'background' and 'foreground' color codes" 
    };
  }

  function exportCurrentTheme() {
    const allThemes = [...PRESET_THEMES, ...customThemes];
    const active = allThemes.find(t => t.id === activeThemeId)
      || PRESET_THEMES.find(t => t.id === DEFAULT_THEME_ID);

    const exportData = {
      name: active.name,
      background: active.background,
      foreground: active.foreground,
      sidebar: active.sidebar,
      accent: active.accent,
      border: active.border,
      selection: active.selection
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-theme.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // The user picked a theme here; the other window re-reads it from storage.
  function chooseTheme(themeId) {
    applyTheme(themeId);
    onChanged();
  }

  function attach() {
    themeToggleBtn?.addEventListener("click", openThemeModal);
    closeThemeBtn?.addEventListener("click", closeThemeModal);
    themeModalBackdrop?.addEventListener("click", (event) => {
      if (event.target === themeModalBackdrop) closeThemeModal();
    });
    byId("theme-import-btn")?.addEventListener("click", importThemeFile);
    byId("theme-export-btn")?.addEventListener("click", exportCurrentTheme);
  }

  return {
    attach,
    load: loadSavedThemes,
    apply: chooseTheme,
    openModal: openThemeModal,
    closeModal: closeThemeModal,
    isModalOpen: () => isThemeModalOpen,
    modal: themeModal,
    activeThemeId: () => activeThemeId
  };
}
