#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hunk catalogue, manifest writer and coverage checker for a review book.
// Zero dependencies; needs Node 18 or later and git.
//
//   node check-book.mjs hunks    --base <ref> [--head <ref>] [--repo <dir>] [--json]
//   node check-book.mjs manifest <book-dir> [--base <ref>] [--head <ref>] [--repo <dir>]
//   node check-book.mjs check    <book-dir> [--repo <dir>]
//   node check-book.mjs status   <book-dir>
//   node check-book.mjs signoff  <book-dir> [--repo <dir>]
//
// Without --head the book covers base to the working tree, untracked files
// included. With --head it covers base to that commit; the manifest keeps the
// commit as "ref" so check, manifest and signoff compare against it later.
//
// Hunk id: "h" plus the first five hex characters of
// sha256(path + "\n" + body), where path is the new-side path (old-side for a
// deleted file) and body is every line of the hunk after its "@@" header, each
// ending in "\n", exactly as `git diff -U3` prints them (including any
// "\ No newline at end of file" line). The header is left out so a hunk that
// only moved, because an earlier hunk in the file grew or shrank, keeps its
// id and its reviewed mark. When two hunks get the same id, the later one in
// diff order is hashed again with "#2", "#3", ... appended to the input.
//
// A block with the bare `elided` token holds only its "@@" header line. It
// still owns its hunk and still goes stale when the hunk changes, since the
// id is checked against the diff; only the body is not shown.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SIBLING_EXTENSIONS = /\.(md|markdown|txt)$/i;
const HUNK_ID = /^h[0-9a-f]{5}$/;
const LINES = /^(old:)?\d+-\d+$/;

function git(repo, args, { allowExit1 = false, env } = {}) {
  try {
    return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowExit1 && error.status === 1) return error.stdout;
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr || error.message}`);
  }
}

export function hunkId(path, body, salt = "") {
  const hash = createHash("sha256").update(`${path}\n${body}${salt}`).digest("hex");
  return `h${hash.slice(0, 5)}`;
}

export function lineRange(header) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) throw new Error(`Not a hunk header: ${header}`);
  const [oldStart, oldCount, newStart, newCount] = [match[1], match[2] ?? "1", match[3], match[4] ?? "1"].map(Number);
  if (newCount > 0) return `${newStart}-${newStart + newCount - 1}`;
  return `old:${oldStart}-${oldStart + Math.max(oldCount, 1) - 1}`;
}

function unquote(path) {
  if (!path.startsWith('"')) return path;
  return JSON.parse(path.replace(/\\([0-7]{3})/g, (_, octal) => `\\u00${parseInt(octal, 8).toString(16).padStart(2, "0")}`));
}

function stripPrefix(path) {
  if (path === "/dev/null") return null;
  const plain = unquote(path.replace(/\t.*$/, ""));
  return plain.replace(/^[ab]\//, "");
}

// Parses unified diff text into files, each with its hunks.
export function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hunk = null;
      const rest = line.slice("diff --git ".length);
      let guess = null;
      if (!rest.startsWith('"') && (rest.length - 5) % 2 === 0) {
        const half = (rest.length - 5) / 2;
        if (rest.slice(2, 2 + half) === rest.slice(5 + half)) guess = rest.slice(2, 2 + half);
      }
      file = { oldPath: guess, newPath: guess, status: "modified", binary: false, hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (hunk && !line.startsWith("@@ ")) {
      hunk.body.push(line);
      continue;
    }
    if (line.startsWith("@@ ")) {
      hunk = { header: line, body: [] };
      file.hunks.push(hunk);
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) file.newPath = unquote(line.slice("rename to ".length));
    else if (line.startsWith("--- ")) file.oldPath = stripPrefix(line.slice(4));
    else if (line.startsWith("+++ ")) file.newPath = stripPrefix(line.slice(4));
    else if (line.startsWith("Binary files ")) file.binary = true;
  }
  for (const entry of files) {
    if (entry.status === "added") entry.oldPath = null;
    if (entry.status === "deleted") entry.newPath = null;
    entry.path = entry.newPath ?? entry.oldPath;
  }
  return files;
}

// Gives every hunk its id, line range and block text.
export function catalogue(files) {
  const seen = new Set();
  const hunks = [];
  for (const file of files) {
    for (const raw of file.hunks) {
      const body = raw.body.map((line) => `${line}\n`).join("");
      let id = hunkId(file.path, body);
      for (let n = 2; seen.has(id); n += 1) id = hunkId(file.path, body, `#${n}`);
      seen.add(id);
      hunks.push({ id, path: file.path, header: raw.header, body, lines: lineRange(raw.header), text: `${raw.header}\n${body}` });
    }
  }
  return hunks;
}

// The diff from base to the working tree, untracked files included, or to
// the commit `head` when one is given.
export function repoDiff(repo, base, head) {
  const tracked = git(repo, [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "-M",
    "--src-prefix=a/", "--dst-prefix=b/", base, ...(head ? [head] : []), "--",
  ]);
  if (head) return parseDiff(tracked);
  const untracked = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  let text = tracked;
  for (const path of untracked) {
    text += git(repo, [
      "diff", "--no-index", "--no-color", "--no-ext-diff", "-U3",
      "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", path,
    ], { allowExit1: true });
  }
  return parseDiff(text);
}

// Tree hash of the working tree as `git add -A` would see it, without touching the real index.
export function worktreeHash(repo) {
  const folder = mkdtempSync(join(tmpdir(), "review-book-"));
  const env = { GIT_INDEX_FILE: join(folder, "index") };
  try {
    git(repo, ["read-tree", "HEAD"], { env });
    git(repo, ["add", "-A", "--", "."], { env });
    return git(repo, ["write-tree"], { env }).trim();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function slugify(text) {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function fenceInfo(info) {
  const attributes = {};
  const tokens = info.match(/[^\s"=]+="[^"]*"|\S+/g) ?? [];
  const language = tokens.shift() ?? "";
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq < 0) attributes[token] = true;
    else attributes[token.slice(0, eq)] = token.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { language, attributes };
}

// Splits a Markdown file into prose lines and fenced blocks.
export function parseMarkdown(text) {
  const lines = text.split("\n");
  const blocks = [];
  const prose = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) {
      prose.push({ line: i + 1, text: lines[i] });
      continue;
    }
    const fence = open[1];
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const content = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) content.push(lines[j++]);
    blocks.push({ line: i + 1, info: open[2].trim(), ...fenceInfo(open[2].trim()), text: content.map((l) => `${l}\n`).join("") });
    i = j;
  }
  return { prose, blocks };
}

export function headings(prose) {
  const slugs = [];
  const used = new Set();
  const counts = new Map();
  for (const { text } of prose) {
    const match = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (!match) continue;
    const base = slugify(match[1] ?? "");
    let slug = base;
    while (used.has(slug)) {
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      slug = `${base}-${count}`;
    }
    used.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

export function links(prose) {
  const found = [];
  for (const { line, text } of prose) {
    const plain = text.replace(/`+[^`]*`+/g, "");
    for (const match of plain.matchAll(/(!?)\[(?:[^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      if (match[1] === "!") continue;
      found.push({ line, target: match[2] });
    }
  }
  return found;
}

export function readBook(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  return files.map((name) => {
    const { prose, blocks } = parseMarkdown(readFileSync(join(dir, name), "utf8"));
    const hunks = blocks
      .filter((block) => block.language === "diff" && block.attributes.path !== undefined)
      .map((block) => ({
        file: name,
        line: block.line,
        id: block.attributes.hunk,
        path: block.attributes.path,
        lines: block.attributes.lines,
        reviewed: block.attributes.reviewed === true,
        elided: block.attributes.elided === true,
        text: block.text,
      }));
    return { name, prose, hunks, anchors: new Set([...headings(prose), ...hunks.map((h) => h.id)]), links: links(prose) };
  });
}

function checkLink(book, chapter, target) {
  const hash = target.indexOf("#");
  const path = decodeURI(hash < 0 ? target : target.slice(0, hash));
  const fragment = hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1));
  let destination = chapter;
  if (path) {
    if (path.startsWith("/") || path.split("/").includes("..") || !SIBLING_EXTENSIONS.test(path)) {
      return "Sodilaud only follows relative .md, .markdown or .txt links without '..'";
    }
    destination = book.find((entry) => entry.name === path.replace(/^\.\//, ""));
    if (!destination) return `${path} is not in the book`;
  }
  if (fragment && !destination.anchors.has(fragment)) return `no heading or hunk #${fragment} in ${destination.name}`;
  return null;
}

// Every problem with the book against the working tree, as readable lines.
export function checkBook(dir, repo) {
  const problems = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return [`${manifestPath} is missing; run the manifest command first`];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const files = repoDiff(repo, manifest.base, manifest.ref);
  const diff = catalogue(files);
  const byId = new Map(diff.map((hunk) => [hunk.id, hunk]));
  const changedPaths = new Set(files.map((file) => file.path));
  const book = readBook(dir);
  const blocks = book.flatMap((chapter) => chapter.hunks);
  const owners = new Map();
  for (const block of blocks) {
    const where = `${block.file}:${block.line}`;
    if (!HUNK_ID.test(block.id ?? "")) problems.push(`${where}: hunk=${block.id ?? ""} is not h plus five hex characters`);
    if (!LINES.test(block.lines ?? "")) problems.push(`${where}: lines=${block.lines ?? ""} is not N-M or old:N-M`);
    owners.set(block.id, [...(owners.get(block.id) ?? []), block]);
    const expected = byId.get(block.id);
    if (!expected) {
      problems.push(changedPaths.has(block.path)
        ? `${where}: stale hunk ${block.id} in ${block.path}; the file changed, regenerate the block`
        : `${where}: extra hunk ${block.id}; ${block.path} is not in the diff`);
      continue;
    }
    if (block.path !== expected.path) problems.push(`${where}: hunk ${block.id} has path=${block.path}, the diff says ${expected.path}`);
    const [header, ...rest] = block.text.split("\n");
    const body = rest.join("\n");
    if (block.elided ? body !== "" : body !== expected.body) {
      problems.push(`${where}: hunk ${block.id} no longer matches the working tree`);
    } else {
      if (header !== expected.header) problems.push(`${where}: hunk ${block.id} header is "${header}", the diff says "${expected.header}"`);
      if (block.lines !== expected.lines) problems.push(`${where}: hunk ${block.id} has lines=${block.lines}, the diff says lines=${expected.lines}`);
    }
  }
  for (const hunk of diff) {
    const found = owners.get(hunk.id) ?? [];
    if (found.length === 0) problems.push(`hunk ${hunk.id} (${hunk.path} ${hunk.lines}) has no owner chapter`);
    if (found.length > 1) problems.push(`hunk ${hunk.id} (${hunk.path} ${hunk.lines}) is owned ${found.length} times: ${found.map((b) => `${b.file}:${b.line}`).join(", ")}`);
  }
  const allText = book.map((chapter) => chapter.prose.map((p) => p.text).join("\n")).join("\n");
  for (const file of files) {
    if (file.hunks.length === 0 && !allText.includes(file.path)) {
      problems.push(`${file.path} (${file.binary ? "binary" : file.status}) changed without hunks and is not mentioned in the book`);
    }
  }
  for (const chapter of book) {
    for (const { line, target } of chapter.links) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const problem = checkLink(book, chapter, target);
      if (problem) problems.push(`${chapter.name}:${line}: dead link ${target}: ${problem}`);
    }
  }
  const listed = new Map((manifest.hunks ?? []).map((entry) => [entry.id, entry]));
  for (const hunk of diff) {
    const owner = owners.get(hunk.id)?.[0]?.file;
    const entry = listed.get(hunk.id);
    if (!entry) problems.push(`manifest.json lacks hunk ${hunk.id}; run the manifest command`);
    else if (owner && entry.owner !== owner) problems.push(`manifest.json says ${hunk.id} is owned by ${entry.owner}, the book says ${owner}; run the manifest command`);
  }
  for (const id of listed.keys()) {
    if (!byId.has(id)) problems.push(`manifest.json lists ${id}, which is not in the diff; run the manifest command`);
  }
  return problems;
}

function commit(repo, ref) {
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

function headHash(repo, ref) {
  return ref ? git(repo, ["rev-parse", `${ref}^{tree}`]).trim() : worktreeHash(repo);
}

export function writeManifest(dir, repo, base, headRef) {
  const path = join(dir, "manifest.json");
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const baseSha = commit(repo, base);
  const ref = headRef ? commit(repo, headRef) : undefined;
  const head = headHash(repo, ref);
  const diff = catalogue(repoDiff(repo, baseSha, ref));
  const book = readBook(dir);
  const owner = new Map();
  for (const chapter of book) for (const block of chapter.hunks) if (!owner.has(block.id)) owner.set(block.id, chapter.name);
  const refs = new Map();
  for (const chapter of book) {
    for (const { target } of chapter.links) {
      const match = /#(h[0-9a-f]{5})$/.exec(target);
      if (match && owner.get(match[1]) !== chapter.name) refs.set(match[1], new Set([...(refs.get(match[1]) ?? []), chapter.name]));
    }
  }
  const manifest = {
    base: baseSha,
    ...(ref ? { ref } : {}),
    head,
    hunks: diff.map((hunk) => ({
      id: hunk.id,
      path: hunk.path,
      lines: hunk.lines,
      owner: owner.get(hunk.id) ?? null,
      refs: [...(refs.get(hunk.id) ?? [])].sort(),
    })),
    signedOff: previous.signedOff && previous.head === head ? previous.signedOff : null,
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function reviewStatus(dir) {
  return readBook(dir)
    .filter((chapter) => chapter.hunks.length > 0)
    .map((chapter) => ({
      chapter: chapter.name,
      reviewed: chapter.hunks.filter((h) => h.reviewed).length,
      total: chapter.hunks.length,
      open: chapter.hunks.filter((h) => !h.reviewed).map((h) => h.id),
    }));
}

function fenceFor(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

// The hunks command prints hunks longer than this elided; the skill allows
// that only for generated, vendored and lockfile content.
export const ELIDE_OVER = 20000;

export function shouldElide(hunk) {
  return hunk.text.length > ELIDE_OVER;
}

export function renderBlock(hunk, { elided = false } = {}) {
  const text = elided ? `${hunk.header}\n` : hunk.text;
  const fence = fenceFor(text);
  return `${fence}diff path=${hunk.path} hunk=${hunk.id} lines=${hunk.lines}${elided ? " elided" : ""}\n${text}${fence}\n`;
}

function option(args, name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function main(argv) {
  const [command, ...args] = argv;
  const repo = resolve(option(args, "--repo") ?? ".");
  const dir = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : undefined;
  switch (command) {
    case "hunks": {
      const base = option(args, "--base");
      if (!base) throw new Error("hunks needs --base <ref>");
      const files = repoDiff(repo, base, option(args, "--head"));
      const hunks = catalogue(files);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ files: files.map(({ path, oldPath, status, binary, hunks: h }) => ({ path, oldPath, status, binary, hunks: h.length })), hunks }, null, 2)}\n`);
        return 0;
      }
      for (const file of files) {
        const moved = file.status === "renamed" ? ` from ${file.oldPath}` : "";
        process.stdout.write(`## ${file.path} (${file.binary ? "binary" : file.status}${moved}, ${file.hunks.length} hunks)\n\n`);
        for (const hunk of hunks.filter((h) => h.path === file.path)) {
          process.stdout.write(`${renderBlock(hunk, { elided: shouldElide(hunk) })}\n`);
        }
      }
      process.stdout.write(`${files.length} files, ${hunks.length} hunks\n`);
      return 0;
    }
    case "manifest": {
      if (!dir) throw new Error("manifest needs <book-dir>");
      const previous = existsSync(join(dir, "manifest.json")) ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) : {};
      const base = option(args, "--base") ?? previous.base;
      if (!base) throw new Error("manifest needs --base <ref> the first time");
      const manifest = writeManifest(dir, repo, base, option(args, "--head") ?? previous.ref);
      process.stdout.write(`manifest.json: ${manifest.hunks.length} hunks, head ${manifest.head}\n`);
      return 0;
    }
    case "check": {
      if (!dir) throw new Error("check needs <book-dir>");
      const problems = checkBook(dir, repo);
      if (problems.length === 0) {
        process.stdout.write("Book OK: every hunk has exactly one owner and every link resolves.\n");
        return 0;
      }
      process.stdout.write(`${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
      return 1;
    }
    case "status": {
      if (!dir) throw new Error("status needs <book-dir>");
      const rows = reviewStatus(dir);
      const reviewed = rows.reduce((sum, row) => sum + row.reviewed, 0);
      const total = rows.reduce((sum, row) => sum + row.total, 0);
      for (const row of rows) process.stdout.write(`${row.chapter}: ${row.reviewed}/${row.total}${row.open.length ? ` (open: ${row.open.join(", ")})` : ""}\n`);
      process.stdout.write(`${reviewed}/${total} reviewed\n`);
      return reviewed === total ? 0 : 1;
    }
    case "signoff": {
      if (!dir) throw new Error("signoff needs <book-dir>");
      const problems = checkBook(dir, repo);
      const open = reviewStatus(dir).flatMap((row) => row.open);
      if (problems.length || open.length) {
        if (problems.length) process.stdout.write(`Checker problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
        if (open.length) process.stdout.write(`Not reviewed: ${open.join(", ")}\n`);
        return 1;
      }
      const path = join(dir, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.head = headHash(repo, manifest.ref);
      manifest.signedOff = manifest.head;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(`Signed off at ${manifest.head}\n`);
      return 0;
    }
    default:
      process.stdout.write("Usage: check-book.mjs hunks|manifest|check|status|signoff (see the header of this file)\n");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
