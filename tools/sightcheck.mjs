/**
 * Ironsight alignment test bed.
 *
 *   npm run sightcheck
 *   node tools/sightcheck.mjs --weapon rifle
 *
 * Aims each weapon and measures where its sights actually land **on screen**, in
 * pixels from the crosshair. That is the only definition of aligned that matters: a
 * player looks at the middle of the screen, and the sights either frame it or they do
 * not.
 *
 * Measuring the screen and not the transform is the point. The alignment is produced
 * by a solve that composes with the arms' animation, the viewmodel root's scale, the
 * camera's field of view and the ADS blend, and a bug in any of those is invisible in
 * the solve's own output. Before this existed, aiming was one hardcoded offset shared
 * by every weapon — correct for whichever gun it had been eyeballed against, silently
 * wrong for the rest, and nothing in the project could say by how much.
 *
 * Checks, per weapon:
 *   rear/front   pixels from screen centre with the weapon fully aimed
 *   spread       how far apart the two sights are on screen — they should be nearly
 *                on top of each other, which is what looking *down* a sight line means
 *   swing        worst frame-to-frame *growth* in offset while coming up, so the
 *                weapon travels to the middle instead of swinging wide on the way
 *   firing       worst offset mid-burst — informational, since recoil is meant to
 *                move the picture; the limit only catches something diverging
 *   recover      where the sights sit once the trigger is released, which is the real
 *                invariant: recoil moves the picture and the picture comes back
 *   blocked      how far in front of the rear sight the aim line first meets the
 *                player's own hands — sights on the axis with a fist parked on them
 *                are perfectly aligned and no use at all
 *   upright      the weapon is not rolled: its up still points up on screen
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const only = arg('weapon', null);
const url = arg('url', 'http://localhost:5173');

// A 1080p screen is ~1900 px wide. Ten pixels is about a third of the width of the
// front post — visibly off-centre if you are looking for it, invisible if not.
const LIMITS = {
  aimed: 6,      // px from the crosshair, fully aimed and still
  spread: 9,     // px between the two sights, fully aimed
  settle: 8,     // px the offset may *grow* between frames while coming up
  firing: 70,    // px the picture may wander mid-burst — generous, because this is
                 // recoil doing its job; it only has to catch something diverging
  recover: 6,    // px it must come back to once the trigger is released
  blocked: 0.02, // m of viewmodel geometry allowed in front of the rear sight, on the
                 // aim line itself — a hand there is aligned and useless
  nearest: 0.10, // m the weapon may come to the player's face
  roll: 3.0,     // degrees of roll on screen
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 600000,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
    '--mute-audio', '--no-first-run', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('!!window.__game', { timeout: 30000 });
await page.evaluate('window.__game.assetsReady');

const report = await page.evaluate(async (opts) => {
  const g = window.__game;
  const T = g.THREE;
  const p = g.player;
  const out = [];

  // Boot into the sandbox first.
  //
  // `__game.step` is a no-op unless `phase === 'match'`, so a harness that arms the
  // player and starts stepping without starting a match runs nothing at all — and
  // then reports the viewmodel's constructor position as a 300 px alignment error,
  // with total confidence. The sandbox is the right arena for this: empty, and
  // nothing shoots back while the weapon is being measured.
  g.sandbox(['pistol', 'smg', 'shotgun', 'rifle', 'dmr']);
  g.step(1 / 60, 30);

  const revive = () => {
    p.alive = true; p.hp = p.maxHp; p.deathT = 0; p.healing = null;
    g.world.playerProxy.alive = true;
    g.setLocked(true);
  };
  revive();
  if (!p.update.__wrapped) {
    // Fail loudly rather than silently measuring a static scene.
    let ran = 0;
    const orig = Object.getPrototypeOf(p).update.bind(p);
    p.update = (...a2) => { ran++; return orig(...a2); };
    p.update.__wrapped = true;
    g.step(1 / 60, 5);
    if (!ran) throw new Error('player.update is not running — the harness is measuring nothing');
    delete p.update;
  }

  const W = 1280, H = 720;
  const v = new T.Vector3();
  /**
   * A point's position on screen, in pixels from the centre.
   *
   * The camera's world matrix has to be current: `step` advances the match but does
   * not render, so nothing else updates it, and reading a stale one gives confident
   * numbers about where the sights were last frame.
   */
  const toScreen = (obj) => {
    g.camera.updateMatrixWorld(true);
    g.camera.updateProjectionMatrix();
    obj.getWorldPosition(v);
    v.project(g.camera);
    return { x: v.x * W / 2, y: -v.y * H / 2, behind: v.z > 1 };
  };
  const dist = (s) => Math.hypot(s.x, s.y);

  const AMMO = { pistol: 'ammo_9mm', smg: 'ammo_9mm', shotgun: 'ammo_buck', rifle: 'ammo_762', dmr: 'ammo_308' };
  const weapons = opts.only ? [opts.only] : ['pistol', 'smg', 'shotgun', 'rifle', 'dmr'];

  for (const id of weapons) {
    revive();
    p.triggerHeld = false; p.triggerQueued = false; p.adsHeld = false; p.ads = 0;
    p.slots = [id]; p.slotIdx = 0; p.knifeOut = false;
    p._mountViewmodel();
    p.mag = p.weapon.mag;
    for (let i = 0; i < 4; i++) g.items.autoPlace(p.character.pack, g.items.makeItem(AMMO[id]));
    g.step(1 / 60, 160);                       // let the draw settle

    const held = p.currentVM.group;
    const rear = held.userData.sightRear;
    const front = held.userData.sightFront;
    if (!rear || !front) { out.push({ id, missing: true }); continue; }

    // Raise the weapon, watching the whole way up.
    //
    // The offset during a raise is *supposed* to be large: the weapon starts at the
    // hip, 270 px off, and travels to the middle. What must not happen is it swinging
    // wide on the way, so the measurement is how much the offset ever *grows* between
    // frames, not how big it gets. A limit on the raw offset would just be a limit on
    // where the hip pose is.
    p.adsHeld = true;
    let settle = 0;
    let prev = null;
    for (let i = 0; i < 90; i++) {
      g.step(1 / 60, 1);
      const d = Math.max(dist(toScreen(rear)), dist(toScreen(front)));
      if (prev !== null && p.ads > 0.02) settle = Math.max(settle, d - prev);
      prev = d;
    }
    const sRear = toScreen(rear);
    const sFront = toScreen(front);

    // Is the sight picture actually clear?
    //
    // The sights being on the axis is necessary and not sufficient — a hand parked on
    // the sight line is perfectly aligned and completely useless. Fire a ray straight
    // down the middle and see what it meets first: anything nearer than the rear
    // sight is between the player and his own sights.
    g.camera.updateMatrixWorld(true);
    const camPos = new T.Vector3();
    const camDir = new T.Vector3();
    g.camera.getWorldPosition(camPos);
    g.camera.getWorldDirection(camDir);
    const meshes = [];
    p.vmRoot.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) meshes.push(o); });
    const rc = new T.Raycaster(camPos, camDir, 0.01, 3);
    const hits = rc.intersectObjects(meshes, false);
    const rearDist = camPos.distanceTo(rear.getWorldPosition(new T.Vector3()));
    // And how close the weapon gets to the player's face at all — the stock is below
    // the aim line, so nothing above notices it sitting on the end of his nose.
    let nearest = Infinity;
    p.vmRoot.updateMatrixWorld(true);
    for (const m of meshes) {
      const b = new T.Box3().setFromObject(m);
      nearest = Math.min(nearest, b.distanceToPoint(camPos));
    }
    let blocked = 0;
    for (const h of hits) {
      if (h.object === rear || h.object === front) continue;
      if (h.distance < rearDist - 0.005) blocked = Math.max(blocked, rearDist - h.distance);
    }

    // Roll: the weapon's own up, projected. A rolled gun still has its sights on the
    // crosshair, so nothing above would catch it.
    const upWorld = new T.Vector3();
    held.matrixWorld.extractBasis(new T.Vector3(), upWorld, new T.Vector3());
    const camQ = new T.Quaternion();
    g.camera.getWorldQuaternion(camQ);
    upWorld.applyQuaternion(camQ.invert()).normalize();
    const roll = Math.atan2(upWorld.x, upWorld.y) * 57.3;

    // Now fire, with the weapon still up.
    let firing = 0;
    p.fireCooldown = 0;
    p.triggerHeld = true; p.triggerQueued = true;
    for (let i = 0; i < 120; i++) {
      p.mag = Math.max(1, p.mag);
      g.step(1 / 60, 1);
      firing = Math.max(firing, dist(toScreen(rear)), dist(toScreen(front)));
    }
    p.triggerHeld = false; p.triggerQueued = false;
    // And back. Recoil is allowed to move the sight picture — that is what recoil is
    // for, and how much is the recoil system's business, not alignment's. What
    // alignment has to guarantee is that it *returns*: a weapon that creeps a little
    // further off with every shot is broken in a way no single frame reveals.
    for (let i = 0; i < 45; i++) g.step(1 / 60, 1);
    const recover = Math.max(dist(toScreen(rear)), dist(toScreen(front)));

    out.push({
      id,
      rear: dist(sRear), front: dist(sFront),
      spread: Math.hypot(sRear.x - sFront.x, sRear.y - sFront.y),
      settle, firing, recover, roll, blocked, nearest,
      behind: sRear.behind || sFront.behind,
    });
  }
  return out;
}, { only });

await browser.close();

let failures = 0;
const bad = (cond, msg) => { if (cond) { failures++; return ` FAIL(${msg})`; } return ''; };

console.log('\nironsight alignment — pixels from the crosshair at 1280x720\n');
console.log('  weapon     rear   front  spread   swing  firing recover    roll blocked   near');
for (const w of report) {
  if (w.missing) {
    failures++;
    console.log(`  ${w.id.padEnd(9)}  no sights exported FAIL(${w.id} cannot be aimed)`);
    continue;
  }
  const n = (x) => x.toFixed(1).padStart(6);
  let flags = '';
  flags += bad(w.behind, `${w.id} sights are behind the camera`);
  flags += bad(w.rear > LIMITS.aimed, `${w.id} rear sight ${w.rear.toFixed(1)} px off`);
  flags += bad(w.front > LIMITS.aimed, `${w.id} front sight ${w.front.toFixed(1)} px off`);
  flags += bad(w.spread > LIMITS.spread, `${w.id} sights ${w.spread.toFixed(1)} px apart`);
  flags += bad(w.settle > LIMITS.settle, `${w.id} offset jumps ${w.settle.toFixed(1)} px in a frame coming up`);
  flags += bad(w.firing > LIMITS.firing, `${w.id} drifts ${w.firing.toFixed(0)} px under fire`);
  flags += bad(Math.abs(w.roll) > LIMITS.roll, `${w.id} rolled ${w.roll.toFixed(1)} deg`);
  flags += bad(w.recover > LIMITS.recover, `${w.id} sits ${w.recover.toFixed(1)} px off after firing`);
  flags += bad(w.blocked > LIMITS.blocked, `${w.id} has hands ${(w.blocked * 100).toFixed(0)} cm in front of its sights`);
  flags += bad(w.nearest < LIMITS.nearest, `${w.id} comes ${(w.nearest * 100).toFixed(0)} cm from the player's face`);
  console.log(`  ${w.id.padEnd(9)} ${n(w.rear)}  ${n(w.front)}  ${n(w.spread)}  ${n(w.settle)}  ${n(w.firing)} ${n(w.recover)}  ${n(w.roll)} ${n(w.blocked)} ${n(w.nearest)}${flags}`);
}

if (pageErrors.length) {
  failures += pageErrors.length;
  console.log('\npage errors');
  for (const e of pageErrors) console.log(`  ${e}`);
}
console.log(failures ? `\n${failures} failure(s)\n` : '\nall clean\n');
process.exit(failures ? 1 : 0);
