// SPDX-License-Identifier: GPL-3.0-or-later

import { createCssColorResolver } from "./css-color.js";
import { mix, toHex } from "./theme-colors.js";

const CACHE_LIMIT = 100;

const loadVendoredMermaid = () => import("./vendor/mermaid/mermaid.esm.min.mjs");

function errorMessage(error) {
  const message = typeof error === "string" ? error : error?.message;
  return String(message || "Unknown error").trim();
}

// The ELK chunk is not vendored (see the design doc), so a diagram that asks for
// that layout fails on a missing module rather than on its syntax.
function explainError(source, error) {
  const message = errorMessage(error);
  if (/\belk\b/i.test(source) && /module|import|fetch/i.test(message)) {
    return "The ELK layout is not included in Sodilaud. Remove `layout: elk` to use the default layout.";
  }
  return message;
}

/**
 * Renders Mermaid source to SVG, loading Mermaid on first use. One per window.
 *
 * @param {object} options
 * @param {Document} options.document
 * @param {() => Promise<object>} [options.load] resolves to the Mermaid module
 */
export function createMermaidRenderer({ document, load = loadVendoredMermaid }) {
  let modulePromise = null;
  let variables = {};
  let variablesKey = "{}";
  let generation = 0;
  let queue = Promise.resolve();
  let counter = 0;
  const cache = new Map();
  const pending = new Map();
  const listeners = new Set();

  const config = () => ({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // Mermaid 12 defaults to ELK, which is not vendored; dagre is the Mermaid 11 default.
    layout: "dagre",
    state: { layout: "dagre" },
    theme: "base",
    themeVariables: variables,
    ...(variables.fontFamily ? { fontFamily: variables.fontFamily } : {})
  });

  function mermaidApi() {
    if (!modulePromise) {
      modulePromise = load().then(module => {
        const api = module.default ?? module;
        api.initialize(config());
        return api;
      });
      modulePromise.catch(() => { modulePromise = null; });
    }
    return modulePromise;
  }

  async function renderNow(source) {
    let api;
    try {
      api = await mermaidApi();
    } catch (error) {
      return { error: `Could not load Mermaid: ${errorMessage(error)}` };
    }
    const id = `sodilaud-mermaid-${++counter}`;
    try {
      const { svg } = await api.render(id, source);
      return { svg };
    } catch (error) {
      return { error: explainError(source, error) };
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }

  function cached(source) {
    const result = cache.get(source);
    if (result === undefined) return undefined;
    cache.delete(source);
    cache.set(source, result);
    return result;
  }

  function render(source) {
    const hit = cached(source);
    if (hit) return Promise.resolve(hit);
    const inFlight = pending.get(source);
    if (inFlight) return inFlight;

    const startedIn = generation;
    // Mermaid measures text in one shared hidden element, so renders run one at a time.
    const job = queue.then(() => renderNow(source));
    queue = job;
    pending.set(source, job);
    job.then(result => {
      if (pending.get(source) === job) pending.delete(source);
      if (startedIn !== generation) return;
      cache.set(source, result);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    });
    return job;
  }

  function setTheme(next) {
    const key = JSON.stringify(next ?? {});
    if (key === variablesKey) return false;
    variables = next ?? {};
    variablesKey = key;
    generation += 1;
    cache.clear();
    pending.clear();
    modulePromise?.then(api => api.initialize(config()), () => {});
    listeners.forEach(listener => listener());
    return true;
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function fill(element, result) {
    element.replaceChildren();
    element.classList.toggle("mermaid-error", Boolean(result.error));
    if (result.error) {
      const title = document.createElement("strong");
      title.textContent = "Mermaid diagram error";
      const message = document.createElement("pre");
      message.textContent = result.error;
      element.append(title, message);
    } else {
      // securityLevel "strict" runs Mermaid's output through its bundled DOMPurify.
      element.innerHTML = result.svg;
    }
  }

  async function renderBlocks(container) {
    const blocks = [...container.querySelectorAll("pre > code.language-mermaid")];
    await Promise.all(blocks.map(async code => {
      const pre = code.parentElement;
      const result = await render(code.textContent ?? "");
      if (!pre.parentNode) return;
      const diagram = document.createElement("div");
      diagram.className = "mermaid-diagram";
      fill(diagram, result);
      pre.replaceWith(diagram);
    }));
    return blocks.length;
  }

  return {
    render,
    cached,
    renderBlocks,
    fill,
    setTheme,
    onChange,
    get generation() { return generation; }
  };
}

function readColor(style, name, resolve) {
  const resolved = resolve(style.getPropertyValue(name));
  return resolved && resolved.alpha === 1 ? resolved.rgb : null;
}

/**
 * Maps the active theme's preview colors onto Mermaid's "base" theme variables.
 * Colors the engine cannot resolve to opaque sRGB are left to Mermaid's defaults.
 */
export function themeVariablesFrom(document) {
  const view = document.defaultView;
  const root = document.documentElement;
  const style = view.getComputedStyle(root);
  const resolve = createCssColorResolver(document);
  const background = readColor(style, "--preview-bg", resolve);
  const text = readColor(style, "--preview-text", resolve);
  const accent = readColor(style, "--accent-color", resolve);
  const border = readColor(style, "--border-color", resolve);
  const fontFamily = view.getComputedStyle(document.body ?? root).fontFamily;

  const variables = { darkMode: root.classList.contains("theme-dark") };
  if (fontFamily) variables.fontFamily = fontFamily;
  if (!background || !text) return variables;

  const accentOr = accent ?? text;
  const nodeFill = toHex(mix(background, accentOr, 0.16));
  const lineColor = toHex(mix(text, background, 0.3));
  // Mindmap, timeline and journey sections take their fills from the cScale series.
  const sections = {};
  for (let index = 0; index < 12; index += 1) {
    sections[`cScale${index}`] = toHex(mix(background, accentOr, 0.12 + (index % 4) * 0.08));
    sections[`cScaleLabel${index}`] = toHex(text);
  }
  return {
    ...variables,
    ...sections,
    background: toHex(background),
    textColor: toHex(text),
    primaryColor: nodeFill,
    primaryTextColor: toHex(text),
    primaryBorderColor: toHex(accentOr),
    secondaryColor: toHex(mix(background, text, 0.08)),
    tertiaryColor: toHex(mix(background, text, 0.04)),
    lineColor,
    clusterBkg: toHex(mix(background, text, 0.04)),
    clusterBorder: toHex(border ?? mix(background, text, 0.2)),
    edgeLabelBackground: toHex(background),
    noteBkgColor: toHex(mix(background, accentOr, 0.08)),
    noteTextColor: toHex(text),
    noteBorderColor: toHex(border ?? mix(background, text, 0.2)),
    actorBkg: nodeFill,
    actorBorder: toHex(accentOr),
    actorTextColor: toHex(text),
    signalColor: lineColor,
    signalTextColor: toHex(text)
  };
}
