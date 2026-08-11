/**
 * Runs every Blender authoring script headlessly, in dependency order.
 *
 *   node tools/blender/build.mjs                 # all
 *   node tools/blender/build.mjs fighter         # one script by name
 *
 * Set BLENDER_PATH to override discovery.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function findBlender() {
  if (process.env.BLENDER_PATH) return process.env.BLENDER_PATH;
  const installed = [];
  for (const base of ['C:/Program Files/Blender Foundation', 'C:/Program Files (x86)/Blender Foundation']) {
    if (!existsSync(base)) continue;
    for (const dir of readdirSync(base)) {
      const exe = `${base}/${dir}/blender.exe`;
      if (existsSync(exe)) installed.push(exe);
    }
  }
  installed.sort().reverse();                 // newest version directory first
  const fallbacks = ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender']
    .filter((p) => existsSync(p));
  // A bare `blender` only works if it is on PATH, so it is the last resort.
  return [...installed, ...fallbacks, 'blender'][0];
}

const BLENDER = findBlender();
const scripts = readdirSync(HERE)
  .filter((f) => f.endsWith('.py'))
  .sort();
const filter = process.argv.slice(2);
const wanted = filter.length
  ? scripts.filter((s) => filter.some((f) => s.includes(f)))
  : scripts;

if (!wanted.length) {
  console.error(`no authoring scripts matched ${filter.join(', ')} (have: ${scripts.join(', ')})`);
  process.exit(1);
}

console.log(`blender: ${BLENDER}`);
for (const script of wanted) {
  const t0 = Date.now();
  const res = spawnSync(BLENDER, ['--background', '--factory-startup', '--python', resolve(HERE, script)], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.error) {
    console.error(`could not launch Blender: ${res.error.message}`);
    process.exit(1);
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  // Blender is extremely chatty on success; only the export lines and any
  // traceback are worth surfacing.
  const useful = out.split(/\r?\n/).filter((l) => (
    /Exported|Error|Traceback|^\s{2}File "|Exception|error:/i.test(l)
    // Authoring scripts report their own measurements (weight bakes, floor planting,
    // clip lists) through td_lib's log(); those lines are the whole point of the build.
    || /^ {2}(planted|baked|\d+ clips)/.test(l)
  ));
  console.log(`${basename(script)}  (${Date.now() - t0}ms)`);
  for (const l of useful) console.log(`  ${l}`);
  if (res.status !== 0) {
    console.error(out.slice(-4000));
    process.exit(res.status || 1);
  }
}
