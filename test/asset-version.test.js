// The asset cache-busting stamp has to match the assets it claims to stamp.
//
// Textures and models live in public/, which Vite copies verbatim — the URLs carry
// no content hash, so a browser that cached `/assets/textures/gunmetal_orm.webp`
// once will keep serving it forever. `tools/asset-version.mjs` hashes the tree into
// a constant that every asset URL appends.
//
// The failure mode this guards is regenerating assets and forgetting to re-run the
// stamper: everything works locally, where the dev server is fresh, and nobody with
// a warm cache ever sees the change. That already cost two rounds of re-diagnosing
// a bug that was fixed — the report came back identical because the fix never
// arrived. A missing stamp is invisible in exactly the situation you test in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_VERSION, versioned } from '../src/asset-version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(ROOT, 'public/assets');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('the stamp matches the assets on disk', async () => {
  const files = [];
  for await (const f of walk(ASSETS)) files.push(f);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(ASSETS, f).replace(/\\/g, '/'));
    h.update(await readFile(f));
  }
  assert.equal(h.digest('hex').slice(0, 12), ASSET_VERSION,
    'assets changed without re-running tools/asset-version.mjs — run `npm run assets`');
});

test('versioned() stamps a URL without mangling it', () => {
  assert.equal(versioned('/assets/textures/gunmetal_orm.webp'),
    `/assets/textures/gunmetal_orm.webp?v=${ASSET_VERSION}`);
});
