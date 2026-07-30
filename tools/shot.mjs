/**
 * Visual capture harness. Drives the running dev server in headless Chrome and
 * writes a PNG, so look-and-feel changes can be reviewed (and diffed) without a
 * human at a keyboard.
 *
 *   node tools/shot.mjs out.png
 *   node tools/shot.mjs out.png --pose arena
 *   node tools/shot.mjs out.png --pose match --wait 4000 --size 1600x900
 *
 * Poses live in tools/poses/*.js — each is a module-free snippet evaluated in the
 * page with `window.__game` available. `--pose none` captures the raw menu.
 */
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = resolve(process.argv[2] || 'shot.png');
const poseName = arg('pose', 'arena');
const url = arg('url', 'http://localhost:5173');
const waitMs = Number(arg('wait', 2500));
const [w, h] = arg('size', '1280x720').split('x').map(Number);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    `--window-size=${w},${h}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
// The analytics collector only exists in the Docker stack; its 404s are expected
// noise in a dev capture and would otherwise mask real asset failures.
const IGNORED = /\/api\/analytics/;
page.on('requestfailed', (r) => { if (!IGNORED.test(r.url())) logs.push(`[404] ${r.url()}`); });
page.on('response', (r) => {
  if (r.status() >= 400 && !IGNORED.test(r.url())) logs.push(`[${r.status()}] ${r.url()}`);
});

// `domcontentloaded`, not `networkidle2`: the analytics collector is absent in dev
// and its retrying POSTs mean the network never goes idle. Readiness is asserted
// below against the game's own asset promise instead.
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('!!window.__game', { timeout: 30000 }).catch(() => {});
// Poses that start a match need the fighter model in memory, or startMatch defers
// itself and the capture lands on an empty arena.
await page.evaluate('window.__game.assetsReady').catch(() => {});

const quality = arg('quality', null);
if (quality) await page.evaluate((q) => window.__game.setQuality(q), quality);

if (poseName !== 'none') {
  const pose = await readFile(resolve(HERE, 'poses', `${poseName}.js`), 'utf8');
  await page.evaluate(pose);
}

// Ad-hoc tweak, evaluated after the pose: for isolating one pass or uniform while
// hunting an artifact, without inventing a pose file per experiment.
// Wrapped in an IIFE: poses and --eval share one scope, so a bare `const g` in both
// is a redeclaration SyntaxError.
const evalJs = arg('eval', null);
if (evalJs) await page.evaluate(`(() => { ${evalJs} })()`);

// Let the render loop settle: streamed GLBs, lazily generated textures and the
// post stack all need a few real frames before a capture means anything.
await new Promise((r) => setTimeout(r, waitMs));

await mkdir(dirname(out), { recursive: true });
await page.screenshot({ path: out });

const frames = await page.evaluate('window.__frames || 0');
await browser.close();

for (const l of logs.filter((l) => l.includes('DIAG'))) console.log(l);
const errors = logs.filter((l) => /pageerror|\[4\d\d\]|\[5\d\d\]/.test(l)
  || (l.startsWith('[error]') && !/Failed to load resource/.test(l)));
console.log(`${out}  frames=${frames}`);
if (errors.length) {
  console.log('--- problems ---');
  for (const l of errors.slice(0, 25)) console.log(l);
  process.exitCode = 1;
}
