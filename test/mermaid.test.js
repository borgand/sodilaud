// SPDX-License-Identifier: GPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMermaidRenderer, themeVariablesFrom } from "../src/mermaid.js";

function fakeMermaid({ fail = () => null } = {}) {
  const api = {
    renders: [],
    configs: [],
    initialize(config) { api.configs.push(config); },
    async render(id, source) {
      api.renders.push(source);
      const error = fail(source);
      if (error) throw new Error(error);
      return { svg: `<svg id="${id}"><text>${source.length}</text></svg>` };
    }
  };
  return api;
}

function setup(options) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const api = fakeMermaid(options);
  let loads = 0;
  const renderer = createMermaidRenderer({
    document: dom.window.document,
    load: async () => { loads += 1; return { default: api }; }
  });
  return { dom, document: dom.window.document, api, renderer, loads: () => loads };
}

test("Mermaid loads on the first render, in strict mode on the base theme", async () => {
  const t = setup();
  assert.equal(t.loads(), 0);
  const result = await t.renderer.render("graph TD; A-->B");
  assert.match(result.svg, /^<svg/);
  assert.equal(t.loads(), 1);
  assert.equal(t.api.configs[0].securityLevel, "strict");
  assert.equal(t.api.configs[0].theme, "base");
  assert.equal(t.api.configs[0].startOnLoad, false);
  assert.equal(t.api.configs[0].layout, "dagre");
  assert.equal(t.api.configs[0].state.layout, "dagre");
});

test("a rendered source is cached and available synchronously", async () => {
  const t = setup();
  assert.equal(t.renderer.cached("graph TD; A"), undefined);
  const [first, second] = await Promise.all([t.renderer.render("graph TD; A"), t.renderer.render("graph TD; A")]);
  assert.equal(first, second);
  await t.renderer.render("graph TD; A");
  assert.deepEqual(t.api.renders, ["graph TD; A"]);
  assert.equal(t.renderer.cached("graph TD; A"), first);
});

test("renders run one at a time", async () => {
  const t = setup();
  let active = 0;
  let peak = 0;
  const render = t.api.render;
  t.api.render = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
    return render(...args);
  };
  await Promise.all(["a", "b", "c"].map(source => t.renderer.render(source)));
  assert.equal(peak, 1);
});

test("a syntax error comes back as a message and is cached like a diagram", async () => {
  const t = setup({ fail: source => (source.includes("bad") ? "Parse error on line 1" : null) });
  assert.deepEqual(await t.renderer.render("bad"), { error: "Parse error on line 1" });
  assert.deepEqual(t.renderer.cached("bad"), { error: "Parse error on line 1" });
});

test("a missing ELK layout is explained instead of reported as a module error", async () => {
  const t = setup({ fail: () => "Importing a module script failed." });
  const { error } = await t.renderer.render("---\nconfig:\n  layout: elk\n---\ngraph TD; A-->B");
  assert.match(error, /ELK layout is not included/);
});

test("a load failure is reported and retried on the next render", async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  let attempts = 0;
  const renderer = createMermaidRenderer({
    document: dom.window.document,
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return { default: fakeMermaid() };
    }
  });
  assert.deepEqual(await renderer.render("x"), { error: "Could not load Mermaid: boom" });
  assert.match((await renderer.render("y")).svg, /^<svg/);
});

test("render leaves no temporary elements in the page", async () => {
  const t = setup();
  t.api.render = async id => {
    const leftover = t.document.createElement("div");
    leftover.id = `d${id}`;
    t.document.body.append(leftover);
    throw new Error("nope");
  };
  await t.renderer.render("x");
  assert.equal(t.document.body.children.length, 0);
});

test("a theme change re-initialises Mermaid, clears the cache and notifies", async () => {
  const t = setup();
  await t.renderer.render("graph");
  let notified = 0;
  t.renderer.onChange(() => { notified += 1; });
  const before = t.renderer.generation;
  assert.equal(t.renderer.setTheme({ darkMode: true, background: "#000000" }), true);
  await Promise.resolve();
  assert.equal(t.renderer.setTheme({ darkMode: true, background: "#000000" }), false);
  assert.equal(notified, 1);
  assert.equal(t.renderer.generation, before + 1);
  assert.equal(t.renderer.cached("graph"), undefined);
  assert.equal(t.api.configs.at(-1).themeVariables.background, "#000000");
  await t.renderer.render("graph");
  assert.equal(t.api.renders.length, 2);
});

test("renderBlocks replaces only mermaid code blocks and never loads Mermaid without one", async () => {
  const t = setup({ fail: source => (source.includes("bad") ? "Parse error" : null) });
  const container = t.document.createElement("div");
  container.innerHTML = '<pre><code class="language-js">x</code></pre>';
  assert.equal(await t.renderer.renderBlocks(container), 0);
  assert.equal(t.loads(), 0);

  container.innerHTML = '<p>a</p><pre><code class="language-mermaid">graph TD\n</code></pre>' +
    '<pre><code class="language-mermaid">bad</code></pre><pre><code class="language-js">y</code></pre>';
  assert.equal(await t.renderer.renderBlocks(container), 2);
  const diagrams = container.querySelectorAll(".mermaid-diagram");
  assert.equal(diagrams.length, 2);
  assert.ok(diagrams[0].querySelector("svg"));
  assert.ok(diagrams[1].classList.contains("mermaid-error"));
  assert.equal(diagrams[1].querySelector("pre").textContent, "Parse error");
  assert.ok(container.querySelector("code.language-js"));
});

test("renderBlocks leaves a preview alone once it has been re-rendered", async () => {
  const t = setup();
  const container = t.document.createElement("div");
  container.innerHTML = '<pre><code class="language-mermaid">graph</code></pre>';
  const pending = t.renderer.renderBlocks(container);
  container.innerHTML = "<p>new</p>";
  await pending;
  assert.equal(container.innerHTML, "<p>new</p>");
});

test("theme variables follow the preview colors and the dark flag", () => {
  const dom = new JSDOM("<!doctype html><html class=theme-dark><body></body></html>");
  const root = dom.window.document.documentElement;
  root.style.setProperty("--preview-bg", "#101010");
  root.style.setProperty("--preview-text", "rgb(240, 240, 240)");
  root.style.setProperty("--accent-color", "#3366ff");
  root.style.setProperty("--border-color", "rgba(128,128,128,0.2)");
  const variables = themeVariablesFrom(dom.window.document);
  assert.equal(variables.darkMode, true);
  assert.equal(variables.background, "#101010");
  assert.equal(variables.textColor, "#f0f0f0");
  assert.equal(variables.primaryBorderColor, "#3366ff");
  assert.match(variables.primaryColor, /^#[0-9a-f]{6}$/);
  assert.notEqual(variables.clusterBorder, undefined);
});

test("theme variables fall back to Mermaid's defaults when colors do not resolve", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const variables = themeVariablesFrom(dom.window.document);
  assert.equal(variables.darkMode, false);
  assert.equal(variables.background, undefined);
});
