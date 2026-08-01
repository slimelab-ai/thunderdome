/**
 * Do the colliders match the things you can see?
 *
 *   npm run collisioncheck
 *
 * Two faults, opposite in sign, both of which ship silently because neither is
 * visible in a screenshot:
 *
 * - **phantom** — the collider stops a shot where there is nothing to see. The car
 *   carried the height of its cabin along its whole length, so two fifths of it was
 *   half a metre of invisible wall at standing eye height, and a round lined up
 *   across the bonnet died in clear air. 38% of shots taken past it.
 * - **leak** — a shot passes through something solid on screen. This is what you risk
 *   every time you shrink a collider to fix the first fault, which is why the two are
 *   measured together and reported together.
 *
 * Method: fire at every low prop from all around it, at the heights a player actually
 * shoots from, and compare where `wallHit` stops the round against where a raycast
 * into the visible meshes says the surface is. Grazing hits are excluded — a ray that
 * clips a collider's corner passes just outside the mesh too, so the surface it finds
 * is whatever stands metres behind, and a sub-centimetre miss reads as a huge gap.
 *
 * The leak budget is a baseline, not zero. Some arena dressing has no collider at all
 * by design (wall fittings, signage), and props with pilasters cannot be fitted by one
 * box — see `addArenaBlock` in src/arena.js. The number is here to catch a regression,
 * not to demand perfection.
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.GAME_URL || 'http://localhost:5173';

// A prop may not stop a shot more than this far short of its visible surface.
const PHANTOM_GAP = 0.25;      // metres along the ray
const PHANTOM_PCT = 3;         // percent of shots, per prop
// Props that leak at all. Zero, now that rays run against the real triangles rather
// than boxes drawn round them: there is no longer anything for a shot to pass through
// that you can see, in either direction. The headroom is one prop, not a class of them.
const LEAK_BUDGET = 1;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 900000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
    '--mute-audio', '--no-first-run'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('!!window.__game', { timeout: 30000 });
await page.evaluate('window.__game.assetsReady');

const result = await page.evaluate(async () => {
  const g = window.__game;
  const T = g.THREE || window.THREE;
  const combat = await import('/src/combat.js');
  await g.fight('circuits', 8);
  g.step(1 / 60, 60);
  // Fighters would block their own rays and wander between samples.
  for (const c of [...g.world.combatants]) c.removeFrom(g.world);

  const visible = [];
  g.scene.traverse((o) => {
    // The fx pools live on their own layer and are not surfaces.
    if (o.isMesh && o.visible && o.layers.mask === 1) visible.push(o);
  });
  const ray = new T.Raycaster();
  const origin = new T.Vector3(), dir = new T.Vector3(), tgt = new T.Vector3();
  const HEIGHTS = [0.5, 0.9, 1.25, 1.55];   // prone-ish, crouched, chest, standing eye

  const phantom = [];
  let leakProps = 0;
  let worstLeak = 0, worstLeakAt = null;

  for (const col of g.world.colliders) {
    if (col.max.y > 3.0) continue;          // walls and roof rig: not shootable cover
    const w = col.max.x - col.min.x, d = col.max.z - col.min.z;
    const R = Math.max(w, d) / 2 + 4;
    let bad = 0, total = 0, worstGap = 0, worstInfo = null, leaks = 0;

    for (const h of HEIGHTS) {
      if (h > col.max.y) continue;
      for (let a = 0; a < 36; a++) {
        const th = (a / 36) * Math.PI * 2;
        origin.set(col.cx + Math.cos(th) * R, h, col.cz + Math.sin(th) * R);
        // An origin inside another prop stops every ray at zero and says nothing.
        if (g.world.colliders.some((c) => c.containsXZ && c.containsXZ(origin.x, origin.z, 0)
          && h >= c.min.y && h <= c.max.y)) continue;
        tgt.set(col.cx, h, col.cz);
        dir.copy(tgt).sub(origin).normalize();

        const hit = combat.wallHit(g.world, origin, dir, R + 2);
        ray.set(origin, dir);
        ray.far = R + 2;
        const seen = ray.intersectObjects(visible, false).find((q) => q.point.y > 0.02);

        // ---- leak: the round travelled past a surface that is on screen ----
        if (seen && hit.dist - seen.distance > 0.2) {
          leaks++;
          if (hit.dist - seen.distance > worstLeak) {
            worstLeak = hit.dist - seen.distance;
            worstLeakAt = [+col.cx.toFixed(1), +col.cz.toFixed(1), h];
          }
        }

        // ---- phantom: the round stopped on *this* prop with nothing to see ----
        const hp = hit.point;
        const INSET = 0.25;
        if (Math.abs(hp.x - col.cx) > w / 2 - INSET && Math.abs(hp.z - col.cz) > d / 2 - INSET) continue;
        if (Math.abs(hp.x - col.cx) > w / 2 + 0.05 || Math.abs(hp.z - col.cz) > d / 2 + 0.05) continue;
        total++;
        // Nothing visible at all along the ray is the worst case, not an
        // undefined one — cap it so the number survives the page boundary.
        const gap = Math.min((seen ? seen.distance : R + 2) - hit.dist, 99);
        if (gap > 0.25) {
          bad++;
          if (gap > worstGap) { worstGap = gap; worstInfo = { h, stop: +hit.dist.toFixed(2) }; }
        }
      }
    }
    if (leaks) leakProps++;
    if (!total) continue;
    phantom.push({
      at: [+col.cx.toFixed(1), +col.cz.toFixed(1)],
      top: +col.max.y.toFixed(2),
      pct: Math.round(bad / total * 100),
      worstGap: +worstGap.toFixed(2),
      worstInfo,
    });
  }
  phantom.sort((a, z) => z.pct - a.pct || z.worstGap - a.worstGap);
  return { phantom, leakProps, worstLeak: +worstLeak.toFixed(2), worstLeakAt };
});

await browser.close();

let failed = 0;
const fail = (msg) => { failed++; console.log(`  FAIL  ${msg}`); };

console.log('\ncollider vs. what you can actually see\n');
console.log('  prop                 top    phantom%  worst gap');
console.log('  ' + '-'.repeat(52));
for (const r of result.phantom.slice(0, 8)) {
  console.log(`  (${String(r.at[0]).padStart(6)},${String(r.at[1]).padStart(6)})   `
    + `${r.top.toFixed(2).padStart(5)}   ${String(r.pct).padStart(6)}%   ${r.worstGap.toFixed(2).padStart(6)} m`);
}
console.log(`\n  leaking props ${result.leakProps} (budget ${LEAK_BUDGET}), `
  + `worst ${result.worstLeak} m${result.worstLeakAt ? ` at ${JSON.stringify(result.worstLeakAt)}` : ''}`);

for (const r of result.phantom) {
  if (r.pct > PHANTOM_PCT && r.worstGap > PHANTOM_GAP) {
    fail(`prop at (${r.at}) stops ${r.pct}% of shots with nothing to see, worst ${r.worstGap} m`
      + ` at ${r.worstInfo ? `${r.worstInfo.h} m` : '?'} — an invisible wall`);
  }
}
if (result.leakProps > LEAK_BUDGET) {
  fail(`${result.leakProps} props let shots through visible geometry, over the budget of ${LEAK_BUDGET}`
    + ' — a collider was shrunk too far');
}
for (const e of pageErrors) fail(`page error: ${e}`);

console.log('  ' + '-'.repeat(52));
console.log(failed ? `${failed} problem(s)` : 'all clean');
process.exitCode = failed ? 1 : 0;
