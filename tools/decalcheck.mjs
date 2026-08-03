/**
 * Decal placement check. Drives the real game in headless Chrome, fires oblique
 * rays at arena geometry through the actual `wallHit` path, stamps hole decals,
 * and verifies each quad lies flat on the surface it hit — the quad's +Z axis
 * parallel to the reported face normal, the reported normal facing the shooter,
 * and (the regression that motivated this tool) not every hole silently facing
 * straight up because a facade dropped the `outNormal` argument.
 *
 *   node tools/decalcheck.mjs
 *   node tools/decalcheck.mjs --url http://localhost:5173 --shot decals.png
 *
 * Exits non-zero on any failure. `--shot` also writes a screenshot of a wall
 * peppered at 45° so a human can eyeball the result.
 */
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = arg('url', 'http://localhost:5173');
const shotPath = arg('shot', null);

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
    '--window-size=1280,720',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.waitForFunction(() => window.__game, { timeout: 30_000 });

const report = await page.evaluate(async () => {
  await window.__game.assetsReady;          // props landed → triangle collider live
  const game = window.__game;
  const THREE = game.THREE;
  const world = game.world;
  const fx = world.fx;
  const { wallHit } = await import('/src/combat.js');

  const failures = [];
  const results = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // Oblique shots at known arena surfaces: the boundary walls (x ≈ ±22, z ≈ ±16),
  // the floor, and whatever prop a diagonal across the pit happens to find. Every
  // direction here is deliberately NOT parallel to the normal it should report.
  const shots = [
    { name: 'east wall, 45° yaw', o: V(10, 1.5, -6), d: V(1, 0, 1) },
    { name: 'east wall, shallow', o: V(14, 1.4, 4), d: V(1, 0, 0.35) },
    { name: 'north wall, 45° yaw', o: V(-4, 1.6, -8), d: V(0.9, 0, -1) },
    { name: 'west wall, downward slant', o: V(-12, 2.2, 3), d: V(-1, -0.12, 0.5) },
    { name: 'floor, steep slant', o: V(3, 1.7, 2), d: V(0.7, -1, 0.4) },
    { name: 'across the pit, diagonal', o: V(-16, 1.2, -11), d: V(1, -0.03, 0.75) },
  ];

  for (const s of shots) {
    s.d.normalize();
    const res = wallHit(world, s.o, s.d, 200);
    if (res.dist >= 199) { failures.push(`${s.name}: ray hit nothing`); continue; }
    if (!res.normal) { failures.push(`${s.name}: no surface normal reported`); continue; }
    const n = res.normal.clone();
    if (n.lengthSq() < 0.9) { failures.push(`${s.name}: degenerate normal ${n.toArray()}`); continue; }
    if (n.dot(s.d) >= 0) failures.push(`${s.name}: normal faces away from the shooter`);

    // Stamp the hole exactly as the game does, then read the quad back out of the
    // instanced batch and check it lies in the surface plane.
    fx.sparks(res.point.clone(), s.d.clone(), res.normal);
    const cursor = fx.decalCursor.hole;
    const m = new THREE.Matrix4();
    fx.decalMeshes.hole.getMatrixAt(cursor, m);
    const quadZ = V(0, 0, 1).applyMatrix4(
      new THREE.Matrix4().extractRotation(m)).normalize();
    const align = Math.abs(quadZ.dot(n));
    if (align < 0.999) failures.push(`${s.name}: quad tilted off the surface, |z·n| = ${align.toFixed(4)}`);
    const pos = V(0, 0, 0).setFromMatrixPosition(m);
    if (pos.distanceTo(res.point) > 0.05) failures.push(`${s.name}: quad ${pos.distanceTo(res.point).toFixed(3)} m from the impact`);
    results.push({ name: s.name, normal: n.toArray().map((v) => +v.toFixed(3)), align: +align.toFixed(4) });
  }

  // The facade regression looked exactly like this: every quad facing +y. Distinct
  // wall shots above make that impossible unless something is broken again.
  const ups = results.filter((r) => Math.abs(r.normal[1]) > 0.9).length;
  if (results.length >= 4 && ups > 2) failures.push(`${ups}/${results.length} normals point up — outNormal is being dropped again`);

  return { failures, results };
});

for (const r of report.results) console.log(`  ok  ${r.name}  n=(${r.normal.join(', ')})  align=${r.align}`);
for (const f of report.failures) console.error(`  FAIL  ${f}`);

if (shotPath && !report.failures.length) {
  // Pepper the east wall at 45° and park the camera on it for human eyes.
  await page.evaluate(async () => {
    document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });
    const game = window.__game;
    const THREE = game.THREE;
    const { wallHit } = await import('/src/combat.js');
    const fx = game.world.fx;
    // A 45° spray at one wall, then park the camera on the impact centroid so the
    // holes are actually in frame.
    const hits = [];
    let normal = null;
    for (let i = 0; i < 10; i++) {
      const o = new THREE.Vector3(14, 1.1 + (i % 5) * 0.22, -0.6 + (i % 3) * 0.4);
      const d = new THREE.Vector3(1, 0.03 * ((i % 3) - 1), 1).normalize();
      const res = wallHit(game.world, o, d, 200);
      if (res.dist < 199) {
        fx.sparks(res.point.clone(), d, res.normal);
        hits.push(res.point.clone());
        if (res.normal) normal = res.normal.clone();
      }
    }
    if (hits.length) {
      const c = hits.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(hits.length);
      const back = (normal || new THREE.Vector3(-1, 0, -1).normalize()).clone();
      const eye = c.clone().addScaledVector(back, 1.4);
      eye.y = Math.max(1.2, c.y + 0.3);
      game.freeCam([eye.x, eye.y, eye.z], [c.x, c.y, c.z]);
    }
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: resolve(shotPath) });
  console.log(`  shot  ${resolve(shotPath)}`);
}

await browser.close();
if (report.failures.length) {
  console.error(`decalcheck: ${report.failures.length} failure(s)`);
  process.exit(1);
}
console.log(`decalcheck: ${report.results.length} placements verified`);
