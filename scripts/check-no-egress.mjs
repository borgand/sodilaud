// SPDX-License-Identifier: GPL-3.0-or-later
// Fails the build when a network capability or a remote URL reappears in shipped source.

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIRS = ["src", "src-tauri/src", "scripts"];
const SCAN_EXTS = new Set([".js", ".mjs", ".rs", ".html", ".css", ".toml", ".json"]);
const SKIP_DIRS = new Set(["vendor", "node_modules", "target", "gen"]);
const SELF = "scripts/check-no-egress.mjs";

// Pattern label per file. Each entry is justified in docs/security/.
const ALLOWED = new Map([
  ["src/markdown.js", ["remote url"]],
  ["src/markdown-insert.js", ["remote url"]],
  ["src/index.html", ["remote url"]],
  ["src/welcome-note.js", ["remote url"]],
  ["scripts/generate-release-manifest.mjs", ["remote url"]]
]);
const RULES = [
  ["network api", /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(/],
  ["rust http client", /\b(?:reqwest|hyper|ureq|isahc|attohttpc|minreq)\b/],
  ["remote url", /https?:\/\/\S/]
];

const findings = [];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SCAN_EXTS.has(extname(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

for (const dir of SCAN_DIRS) {
  for await (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (rel === SELF) continue;
    const allowed = ALLOWED.get(rel) ?? [];
    const lines = (await readFile(file, "utf8")).split("\n");
    for (const [label, pattern] of RULES) {
      if (allowed.includes(label)) continue;
      lines.forEach((line, index) => {
        if (pattern.test(line)) findings.push(`${rel}:${index + 1}: ${label}: ${line.trim().slice(0, 100)}`);
      });
    }
  }
}

const cargo = await readFile(join(ROOT, "src-tauri/Cargo.toml"), "utf8");
for (const crate of ["reqwest", "hyper", "ureq", "isahc"]) {
  if (new RegExp(`^\\s*${crate}\\b`, "m").test(cargo)) findings.push(`src-tauri/Cargo.toml: declares ${crate}`);
}

const config = JSON.parse(await readFile(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const csp = config.app?.security?.csp ?? "";
const connectSrc =
  typeof csp === "string"
    ? (csp.split(";").map((directive) => directive.trim()).find((directive) => directive.startsWith("connect-src ")) ?? "")
    : (csp["connect-src"] ?? "");
if (!String(connectSrc).includes("ipc:") || /https?:\/\/(?!(ipc\.)localhost)/.test(String(connectSrc))) {
  findings.push(`src-tauri/tauri.conf.json: connect-src must stay ipc-only, found ${connectSrc}`);
}

if (findings.length) {
  process.stderr.write(`Egress gate failed. Remove the finding or justify it in docs/security/ and ALLOWED.\n\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Egress gate passed: no network capability in shipped source.\n");
