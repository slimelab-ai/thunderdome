/**
 * Bakes the PBR texture library into public/assets/textures/.
 *
 *   node tools/textures/generate.mjs            # every set
 *   node tools/textures/generate.mjs concrete_floor steel_plate
 *
 * The drawing code lives in bake.js and runs inside headless Chrome, which gives
 * it Canvas2D and a WebP encoder. Output is deterministic — reruns produce
 * identical bytes, so a texture change is a reviewable diff.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'public/assets/textures');
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const SIZES = {
  concrete_floor: 1024,
  concrete_wall: 1024,
  fighter_kit: 1024,
  // Low on purpose: the cage is always seen at distance, and a high-resolution weave
  // only gives the filter more sub-pixel detail to alias on.
  chainlink: 256,
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--disable-gpu-sandbox', '--no-first-run', '--mute-audio'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => { console.error('[bake]', e.message); process.exitCode = 1; });
await page.goto('about:blank');
await page.evaluate(await readFile(resolve(HERE, 'bake.js'), 'utf8'));

const all = await page.evaluate('window.__bake.list()');
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : all;
for (const name of wanted) {
  if (!all.includes(name)) throw new Error(`unknown texture set: ${name} (have ${all.join(', ')})`);
}

await mkdir(OUT, { recursive: true });
for (const name of wanted) {
  const t0 = Date.now();
  const channels = await page.evaluate(
    (n, s) => window.__bake.run(n, s),
    name, SIZES[name] || 512,
  );
  const written = [];
  for (const [channel, dataUrl] of Object.entries(channels)) {
    const b64 = dataUrl.split(',')[1];
    const suffix = { albedo: '', normal: '_n', orm: '_orm' }[channel];
    const file = `${name}${suffix}.webp`;
    const buf = Buffer.from(b64, 'base64');
    await writeFile(resolve(OUT, file), buf);
    written.push(`${file} ${(buf.length / 1024).toFixed(0)}kB`);
  }
  console.log(`${name}  (${Date.now() - t0}ms)  ${written.join('  ')}`);
}

await browser.close();
