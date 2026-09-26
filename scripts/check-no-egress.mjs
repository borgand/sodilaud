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

// Exact-string identifiers that look like URLs (matching the "remote url" rule) but are
// XML/XHTML namespace identifiers, never fetched or dereferenced over the network. Justified
// in docs/security/2026-09-26-egress-allowances.md. This is scoped to the exact string only:
// stripNonNetworkIdentifiers removes an occurrence only when it is not immediately followed by
// another URI character, so a longer or different URL on the same text is untouched and still
// trips the "remote url" rule.
const NON_NETWORK_IDENTIFIERS = ["http://www.w3.org/2000/svg"];

// Characters that can continue a URI after an identifier's exact text. If one of these follows
// a matched identifier, the match is part of a longer, unrecognised URL and must not be stripped.
const URI_CONTINUATION = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

export function stripNonNetworkIdentifiers(line) {
  let result = line;
  for (const identifier of NON_NETWORK_IDENTIFIERS) {
    let index = result.indexOf(identifier);
    while (index !== -1) {
      const after = result[index + identifier.length];
      if (after === undefined || !URI_CONTINUATION.test(after)) {
        result = result.slice(0, index) + result.slice(index + identifier.length);
        index = result.indexOf(identifier, index);
      } else {
        index = result.indexOf(identifier, index + identifier.length);
      }
    }
  }
  return result;
}

function lineMatches(label, pattern, line) {
  const subject = label === "remote url" ? stripNonNetworkIdentifiers(line) : line;
  return pattern.test(subject);
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SCAN_EXTS.has(extname(entry.name))) {
      yield join(dir, entry.name);
    }
  }
}

async function collectFindings() {
  const findings = [];

  for (const dir of SCAN_DIRS) {
    for await (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (rel === SELF) continue;
      const allowed = ALLOWED.get(rel) ?? [];
      let lines = (await readFile(file, "utf8")).split("\n");
      // Rust unit tests never ship, and they hold URL fixtures by design.
      if (rel.endsWith(".rs")) {
        const testModule = lines.findIndex((line) => line.trim() === "#[cfg(test)]");
        if (testModule !== -1) lines = lines.slice(0, testModule);
      }
      for (const [label, pattern] of RULES) {
        if (allowed.includes(label)) continue;
        lines.forEach((line, index) => {
          if (lineMatches(label, pattern, line)) findings.push(`${rel}:${index + 1}: ${label}: ${line.trim().slice(0, 100)}`);
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

  return findings;
}

async function main() {
  const findings = await collectFindings();
  if (findings.length) {
    process.stderr.write(`Egress gate failed. Remove the finding or justify it in docs/security/ and ALLOWED.\n\n${findings.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write("Egress gate passed: no network capability in shipped source.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
