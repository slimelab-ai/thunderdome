#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const valueAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
};
const matchCount = Number.parseInt(valueAfter('--matches') || '10', 10);
const baseSeed = Number.parseInt(valueAfter('--seed') || '2026073000', 10);
if (!Number.isInteger(matchCount) || matchCount <= 0 || matchCount % 2 !== 0) {
  throw new Error('--matches must be a positive even number so every seed has a side-swapped pair');
}
if (!Number.isInteger(baseSeed) || baseSeed < 0) throw new Error('--seed must be a non-negative integer');

const batchId = `headless-${new Date().toISOString().replaceAll(':', '-')}`;
const dataDir = resolve('data/headless-liquidation', batchId);
const availablePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});
const collectorPort = await availablePort();
const vitePort = await availablePort();
// Where `@puppeteer/browsers install chrome-headless-shell` leaves the binary. All
// three of the directory, the archive name and the suffix differ per platform.
const CHROME_BUILD = '151.0.7922.71';
const [chromeDir, chromeArchive, chromeSuffix] = {
  win32: ['win64', 'win64', '.exe'],
  darwin: process.arch === 'arm64' ? ['mac_arm', 'mac-arm64', ''] : ['mac', 'mac-x64', ''],
}[process.platform] || ['linux', 'linux64', ''];
const bundledChrome = resolve(
  '.cache/puppeteer/chrome-headless-shell',
  `${chromeDir}-${CHROME_BUILD}`,
  `chrome-headless-shell-${chromeArchive}`,
  `chrome-headless-shell${chromeSuffix}`,
);
const playwrightChrome = resolve(homedir(), '.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell');
const chrome = process.env.CHROME_PATH ||
  (existsSync(bundledChrome) ? bundledChrome : playwrightChrome);
await mkdir(dataDir, { recursive: true });

const children = [];
const start = (command, args, env = {}) => {
  const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
};
// Vite colours its ready banner, and picocolors treats win32 as colour-capable even
// when stdout is a pipe — so the marker arrives as `Local\x1b[22m:` and a plain
// substring test never matches. Strip the escapes, and keep a short tail so a marker
// split across two reads is still found.
const ANSI = /\x1B\[[0-9;]*m/g;
const waitFor = (child, text) => new Promise((resolveReady, reject) => {
  child.once('exit', code => reject(new Error(`${text} process exited ${code}`)));
  let seen = '';
  child.stdout.on('data', chunk => {
    const output = String(chunk);
    process.stdout.write(output);
    seen = (seen + output.replace(ANSI, '')).slice(-4096);
    if (seen.includes(text)) resolveReady();
  });
});

let browser;
try {
  const collector = start(process.execPath, ['server/analytics-server.mjs'], {
    PORT: String(collectorPort), ANALYTICS_DATA_DIR: dataDir,
  });
  await waitFor(collector, 'analytics collector listening');
  // Vite's own entry point rather than the `.bin` shim: the shim is an extensionless
  // shell script that Windows cannot spawn, and reaching for the .cmd beside it would
  // need a shell, whose SIGTERM would not carry through to vite itself.
  const vite = start(process.execPath, [
    resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort),
  ], { ANALYTICS_URL: `http://127.0.0.1:${collectorPort}` });
  await waitFor(vite, 'Local:');
  browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage();
  page.on('pageerror', error => process.stderr.write(`[pageerror] ${error.stack}\n`));
  await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__game', { timeout: 30000 });
  await page.evaluate('window.__game.assetsReady');
  const results = [];
  for (let index = 0; index < matchCount; index++) {
    const seed = baseSeed + Math.floor(index / 2);
    const sideSwap = index % 2 === 1;
    const result = await page.evaluate(async ({ batchId, seed, sideSwap, index }) => {
      let state = seed >>> 0;
      Math.random = () => {
        state += 0x6d2b79f5;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
      window.__game.startHeadlessBotMatch({
        batchId, seed, pairId: `pair-${Math.floor(index / 2) + 1}`, sideSwap,
      });
      const outcome = window.__game.stepHeadlessBotMatch(1 / 60, 18000);
      for (let attempt = 0; attempt < 200 && window.__game.analyticsPending > 0; attempt++) {
        await window.__game.flushAnalytics();
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (window.__game.analyticsPending > 0) {
        throw new Error(`analytics outbox did not drain: ${window.__game.analyticsPending}`);
      }
      return outcome;
    }, { batchId, seed, sideSwap, index });
    results.push(result);
    process.stdout.write(`real match ${index + 1}/${matchCount}: ${JSON.stringify(result.result)}\n`);
  }
  const eventPath = resolve(dataDir, `events-${new Date().toISOString().slice(0, 10)}.ndjson`);
  const events = (await readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const simulated = events.filter(event => event.simulation === true && event.simulation_batch_id === batchId);
  const terminals = simulated.filter(event => event.event_type === 'match_terminal');
  if (terminals.length !== matchCount) {
    throw new Error(`collector contains ${terminals.length}/${matchCount} tagged terminals`);
  }
  process.stdout.write(`verified ${simulated.length} tagged events and ${terminals.length} terminals in ${eventPath}\n`);
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
}
