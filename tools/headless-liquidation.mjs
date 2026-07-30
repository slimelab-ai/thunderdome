#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

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
const chrome = process.env.CHROME_PATH || resolve('.cache/puppeteer/chrome-headless-shell/linux-151.0.7922.71/chrome-headless-shell-linux64/chrome-headless-shell');
await mkdir(dataDir, { recursive: true });

const children = [];
const start = (command, args, env = {}) => {
  const child = spawn(command, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
};
const waitFor = (child, text) => new Promise((resolveReady, reject) => {
  child.once('exit', code => reject(new Error(`${text} process exited ${code}`)));
  child.stdout.on('data', chunk => {
    const output = String(chunk);
    process.stdout.write(output);
    if (output.includes(text)) resolveReady();
  });
});

let browser;
try {
  const collector = start(process.execPath, ['server/analytics-server.mjs'], {
    PORT: String(collectorPort), ANALYTICS_DATA_DIR: dataDir,
  });
  await waitFor(collector, 'analytics collector listening');
  const vite = start(resolve('node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(vitePort)], {
    ANALYTICS_URL: `http://127.0.0.1:${collectorPort}`,
  });
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
  for (let index = 0; index < 10; index++) {
    const seed = 2026073000 + Math.floor(index / 2);
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
    process.stdout.write(`real match ${index + 1}/10: ${JSON.stringify(result.result)}\n`);
  }
  const eventPath = resolve(dataDir, `events-${new Date().toISOString().slice(0, 10)}.ndjson`);
  const events = (await readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const simulated = events.filter(event => event.simulation === true && event.simulation_batch_id === batchId);
  const terminals = simulated.filter(event => event.event_type === 'match_terminal');
  if (terminals.length !== 10) throw new Error(`collector contains ${terminals.length}/10 tagged terminals`);
  process.stdout.write(`verified ${simulated.length} tagged events and ${terminals.length} terminals in ${eventPath}\n`);
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
}
