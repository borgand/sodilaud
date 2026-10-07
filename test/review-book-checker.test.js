import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  catalogue,
  checkBook,
  hunkId,
  lineRange,
  parseDiff,
  renderBlock,
  repoDiff,
  reviewStatus,
  slugify,
  writeManifest,
} from "../src-tauri/resources/claude/review-book/check-book.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}

const lines = (count, label) => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "review-book-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.js"), lines(20, "line"));
  writeFileSync(join(repo, "gone.txt"), "old\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();
  const changed = lines(20, "line").replace("line 2\n", "line two\n").replace("line 18\n", "line eighteen\n");
  writeFileSync(join(repo, "a.js"), changed);
  writeFileSync(join(repo, "b.md"), "# New\n");
  rmSync(join(repo, "gone.txt"));
  const book = join(root, "book");
  mkdirSync(book);
  const hunks = catalogue(repoDiff(repo, base));
  const [first, second, added, deleted] = ["a.js", "a.js", "b.md", "gone.txt"].map((path, i) =>
    hunks.filter((h) => h.path === path)[path === "a.js" ? i : 0]);
  const write = (name, text) => writeFileSync(join(book, name), text);
  write("00-overview.md", `Adds names.\n\n## Reading order\n\n1. [Names](01-names.md)\n2. [First change](01-names.md#${first.id})\n`);
  write("01-names.md", `# Names\n\nSee [the second](#${second.id}) and [the order](00-overview.md#reading-order).\n\n${renderBlock(first)}\n${renderBlock(second)}`);
  write("99-everything-else.md", `# Everything else\n\n${renderBlock(added)}\n${renderBlock(deleted)}`);
  writeManifest(book, repo, base);
  return { repo, book, base, hunks: { first, second, added, deleted }, write, read: (name) => readFileSync(join(book, name), "utf8") };
}

test("hunk ids hash the path and the body after the header", () => {
  const files = parseDiff([
    "diff --git a/x.js b/x.js",
    "index 1..2 100644",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,2 +1,2 @@ function x()",
    "-a",
    "+b",
    " c",
    "\\ No newline at end of file",
    "",
  ].join("\n"));
  const [hunk] = catalogue(files);
  assert.equal(hunk.id, hunkId("x.js", "-a\n+b\n c\n\\ No newline at end of file\n"));
  assert.match(hunk.id, /^h[0-9a-f]{5}$/);
  assert.equal(hunk.lines, "1-2");
  assert.equal(lineRange("@@ -4,3 +3,0 @@"), "old:4-6");
  assert.equal(lineRange("@@ -1 +1 @@"), "1-1");
});

test("identical hunks in one file get distinct ids", () => {
  const block = ["@@ -1,1 +1,1 @@", "-a", "+b"];
  const files = parseDiff(["diff --git a/x b/x", "--- a/x", "+++ b/x", ...block, ...block.map((l) => l.replace("-1,1 +1,1", "-9,1 +9,1")), ""].join("\n"));
  const [one, two] = catalogue(files);
  assert.notEqual(one.id, two.id);
});

test("slugs follow GitHub rules", () => {
  assert.equal(slugify("The merge `engine`: why?"), "the-merge-engine-why");
  assert.equal(slugify("Use [links](x.md) & snake_case"), "use-links--snake_case");
});

test("a complete book passes, deletions and untracked files included", (t) => {
  const { repo, book, hunks } = fixture(t);
  assert.deepEqual(checkBook(book, repo), []);
  assert.equal(hunks.deleted.lines, "old:1-1");
  const manifest = JSON.parse(readFileSync(join(book, "manifest.json"), "utf8"));
  assert.equal(manifest.hunks.length, 4);
  assert.deepEqual(manifest.hunks.find((h) => h.id === hunks.first.id).refs, ["00-overview.md"]);
  assert.equal(manifest.signedOff, null);
});

test("a hunk without an owner fails", (t) => {
  const { repo, book, hunks, write, read } = fixture(t);
  write("99-everything-else.md", read("99-everything-else.md").replace(renderBlock(hunks.added), ""));
  assert.ok(checkBook(book, repo).some((p) => p.includes(`hunk ${hunks.added.id} (b.md 1-1) has no owner`)));
});

test("a hunk owned twice fails", (t) => {
  const { repo, book, hunks, write, read } = fixture(t);
  write("01-names.md", `${read("01-names.md")}\n${renderBlock(hunks.added)}`);
  assert.ok(checkBook(book, repo).some((p) => p.includes(`hunk ${hunks.added.id} (b.md 1-1) is owned 2 times`)));
});

test("a hunk that changed in the working tree is stale", (t) => {
  const { repo, book, hunks } = fixture(t);
  writeFileSync(join(repo, "a.js"), readFileSync(join(repo, "a.js"), "utf8").replace("line two", "line 2b"));
  const problems = checkBook(book, repo);
  assert.ok(problems.some((p) => p.includes(`stale hunk ${hunks.first.id} in a.js`)));
  assert.ok(problems.some((p) => p.includes("has no owner")));
});

test("an edited block body no longer matches", (t) => {
  const { repo, book, write, read, hunks } = fixture(t);
  write("01-names.md", read("01-names.md").replace("+line two", "+line 2"));
  assert.ok(checkBook(book, repo).some((p) => p.includes(`hunk ${hunks.first.id} no longer matches`)));
});

test("a hunk for a file outside the diff is extra", (t) => {
  const { repo, book, write, read } = fixture(t);
  write("01-names.md", `${read("01-names.md")}\n\`\`\`diff path=c.js hunk=habcde lines=1-1\n@@ -1 +1 @@\n-x\n+y\n\`\`\`\n`);
  assert.ok(checkBook(book, repo).some((p) => p.includes("extra hunk habcde; c.js is not in the diff")));
});

test("dead links fail", (t) => {
  const { repo, book, write, read } = fixture(t);
  write("00-overview.md", `${read("00-overview.md")}\n[a](02-missing.md) [b](#nowhere) [c](../x.md) [d](https://example.com) \`[e](#code)\`\n`);
  const problems = checkBook(book, repo).filter((p) => p.includes("dead link"));
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.ok(problems[0].includes("02-missing.md is not in the book"));
  assert.ok(problems[1].includes("no heading or hunk #nowhere"));
  assert.ok(problems[2].includes("without '..'"));
});

test("wrong lines or header fails", (t) => {
  const { repo, book, write, read, hunks } = fixture(t);
  write("01-names.md", read("01-names.md").replace(`lines=${hunks.second.lines}`, "lines=1-3"));
  assert.ok(checkBook(book, repo).some((p) => p.includes(`hunk ${hunks.second.id} has lines=1-3, the diff says lines=${hunks.second.lines}`)));
  write("01-names.md", read("01-names.md").replace("lines=1-3", `lines=${hunks.second.lines}`).replace(hunks.second.header, "@@ -1,7 +1,7 @@"));
  assert.ok(checkBook(book, repo).some((p) => p.includes(`hunk ${hunks.second.id} header is`)));
});

test("an elided block owns its hunk with the header alone", (t) => {
  const { repo, book, write, read, hunks } = fixture(t);
  write("99-everything-else.md", read("99-everything-else.md").replace(renderBlock(hunks.added), renderBlock(hunks.added, { elided: true })));
  assert.deepEqual(checkBook(book, repo), []);
  write("99-everything-else.md", read("99-everything-else.md").replace(" elided\n@@ -0,0 +1 @@\n", " elided\n@@ -0,0 +1 @@\n+extra\n"));
  assert.ok(checkBook(book, repo).some((p) => p.includes("no longer matches")));
});

test("a stale manifest fails and review status counts reviewed tokens", (t) => {
  const { repo, book, write, read, hunks } = fixture(t);
  write("manifest.json", read("manifest.json").replace(`"owner": "01-names.md"`, `"owner": "99-everything-else.md"`));
  assert.ok(checkBook(book, repo).some((p) => p.includes("run the manifest command")));
  write("01-names.md", read("01-names.md").replace(`hunk=${hunks.first.id} lines=${hunks.first.lines}`, `hunk=${hunks.first.id} lines=${hunks.first.lines} reviewed`));
  const status = reviewStatus(book);
  assert.deepEqual(status.find((row) => row.chapter === "01-names.md"), { chapter: "01-names.md", reviewed: 1, total: 2, open: [hunks.second.id] });
});

test("a committed range is checked against its head commit", (t) => {
  const { repo, base } = fixture(t);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  writeFileSync(join(repo, "a.js"), "unrelated working tree edit\n");
  const files = repoDiff(repo, base, "HEAD");
  assert.deepEqual(files.map((f) => f.path).sort(), ["a.js", "b.md", "gone.txt"]);
  assert.equal(catalogue(files).filter((h) => h.path === "a.js").length, 2);
});
