// SPDX-License-Identifier: GPL-3.0-or-later
// Export the brand SVGs to PNG with headless Chromium (Playwright).
//
//   NODE_PATH=$(npm root -g) node brand/scripts/export-png.mjs
//
// Honours PLAYWRIGHT_BROWSERS_PATH, or set CHROMIUM_PATH to an executable.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 32, 64, 128, 256, 512, 1024];

// Detail steps down with size: full (512+), mid (64-256), flat (16-32).
const macosSource = (size) =>
  size >= 512 ? "icon/icon-macos.svg" : size >= 64 ? "icon/variants/icon-macos-mid.svg" : "icon/variants/icon-macos-flat.svg";

const jobs = [
  ...SIZES.map((s) => ({ src: macosSource(s), out: `icon/png/macos/icon-macos-${s}.png`, w: s })),
  ...SIZES.map((s) => ({ src: "icon/icon-flat.svg", out: `icon/png/flat/icon-flat-${s}.png`, w: s })),
  { src: "icon/icon-master.svg", out: "icon/png/icon-master-1024.png", w: 1024 },
  ...[16, 18, 32, 36].map((s) => ({ src: `tray/tray-${s}.svg`, out: `tray/png/tray-${s}.png`, w: s })),
];
for (const color of ["ink", "amber"]) {
  jobs.push({ src: `wordmark/wordmark-${color}.svg`, out: `wordmark/png/wordmark-${color}.png`, w: 1200 });
  jobs.push({ src: `wordmark/lockup-horizontal-${color}.svg`, out: `wordmark/png/lockup-horizontal-${color}.png`, w: 1600 });
  jobs.push({ src: `wordmark/lockup-stacked-${color}.svg`, out: `wordmark/png/lockup-stacked-${color}.png`, w: 1000 });
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();

for (const job of jobs) {
  const text = readFileSync(join(root, job.src), "utf8");
  const [, vw, vh] = text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const h = Math.round((job.w * Number(vh)) / Number(vw));
  const sized = text.replace(/ width="[\d.]+" height="[\d.]+"/, ` width="${job.w}" height="${h}"`);
  await page.setViewportSize({ width: job.w, height: h });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${sized}</body>`);
  const out = join(root, job.out);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: job.w, height: h } });
  console.log("wrote", job.out, `${job.w}x${h}`);
}

// Side-by-side proof sheet: old icon vs new, light and dark Dock, 16/32/128/512.
const sheet = join(root, "previews/old-vs-new.html");
await page.setViewportSize({ width: 1700, height: 900 });
await page.goto(pathToFileURL(sheet).href);
await page.waitForLoadState("load");
const height = await page.evaluate(() => document.documentElement.scrollHeight);
await page.setViewportSize({ width: 1700, height });
await page.screenshot({ path: join(root, "previews/old-vs-new.png"), fullPage: true });
console.log("wrote previews/old-vs-new.png");

await browser.close();
