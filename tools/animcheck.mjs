/**
 * Animation test bed.
 *
 *   node tools/animcheck.mjs                 # every weapon, every action
 *   node tools/animcheck.mjs --weapon rifle  # one weapon
 *   node tools/animcheck.mjs --verbose       # per-frame traces for failures
 *
 * Plays each first-person action frame by frame and measures the *final* world
 * transform of the things a player actually looks at — the muzzle, both fists, the
 * weapon's moving parts — then reports on them.
 *
 * This exists because eyeballing a still frame cannot see the two faults that matter
 * most in an animation, and both shipped:
 *
 *   - **Snapping.** A pose can be correct at every keyframe and still teleport
 *     between them. Only the frame-to-frame delta shows it.
 *   - **Inverted axes.** A recoil that kicks the muzzle *down* looks fine in a
 *     screenshot and wrong in motion. Only the sign of the change over time shows it.
 *
 * Checks, per action:
 *   jump      largest single-frame movement of any tracked point (snap detection)
 *   reach     how far the support fist sits from the point it should be holding
 *   recoil    which way the muzzle pitches when the weapon fires
 *   finite    no NaN anywhere in the final transforms
 *
 * Exits non-zero if anything fails, so it can gate an asset change.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const only = arg('weapon', null);
const verbose = process.argv.includes('--verbose');
const url = arg('url', 'http://localhost:5173');

// Thresholds. A hand moving at a brisk 1 m/s covers 0.017 m per frame at 60 fps, so
// anything past 0.05 is not motion, it is a cut.
const LIMITS = {
  jump: 0.05,      // metres in one frame
  reach: 0.06,     // metres from the fist to what it should be holding
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle',
    '--mute-audio', '--no-first-run', '--window-size=800,600'],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });
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

  // An isolated bench, not a live match. A real bout shoots back, and a dead player's
  // update returns early — which silently froze every measurement after the first
  // weapon and reported the resulting stuck pose as a 30 cm targeting error.
  g.fight('circuits', 8);
  g.step(1 / 60, 20);
  for (const c of [...g.world.combatants]) c.removeFrom(g.world);
  g.world.zones.length = 0;
  p.pos.set(0, 0, 6);
  p.yaw = 0;
  p.pitch = 0;

  const reviveAndArm = () => {
    p.alive = true;
    p.hp = p.maxHp;
    p.deathT = 0;
    p.healing = null;
    g.world.playerProxy.alive = true;
    g.setLocked(true);
  };
  reviveAndArm();

  const AMMO = { pistol: 'ammo_9mm', smg: 'ammo_9mm', shotgun: 'ammo_buck', rifle: 'ammo_762', dmr: 'ammo_308' };
  const camInv = new T.Matrix4();
  const v = new T.Vector3();

  // Everything is measured in camera space, because that is the space the player
  // sees a viewmodel in; world space would fold in their own movement.
  const inCam = (obj, local) => {
    v.set(local ? local[0] : 0, local ? local[1] : 0, local ? local[2] : 0);
    obj.localToWorld(v);
    return v.clone().applyMatrix4(camInv);
  };

  const sample = () => {
    // Force the camera subtree to recompute.
    //
    // `step` runs the simulation but not a render, and `camera.matrixWorld` is only
    // refreshed at render time — so every viewmodel transform read here would
    // otherwise be a frame stale, and stale by a *different* amount than the bones,
    // which the IK updates explicitly. That mismatch is what made a perfectly placed
    // hand measure 30 cm off its target.
    g.camera.updateMatrixWorld(true);
    camInv.copy(g.camera.matrixWorld).invert();
    const vm = p.arms;
    const s = {
      muzzle: inCam(p.currentVM.muzzle),
      fistL: inCam(vm.bones.get('hand_l'), [0, 0.123, 0]),
      fistR: inCam(vm.bones.get('hand_r'), [0, 0.123, 0]),
    };
    // Recoil, two ways: where the barrel is actually pointing in the world (which
    // folds in both the camera kick and the viewmodel's own), and the camera pitch
    // the controller applied. Both must go *up* when the weapon fires.
    const tipW = new T.Vector3();
    p.currentVM.muzzle.getWorldPosition(tipW);
    const breechW = new T.Vector3();
    p.currentVM.group.getWorldPosition(breechW);
    s.barrelY = tipW.sub(breechW).normalize().y;
    s.camPitch = p.recoilPitch;
    const t = vm._supportTarget && vm._supportTarget();
    if (t) {
      // Measured in world space: a distance is invariant under the camera transform,
      // and going through camera space only adds a chance to compare two points
      // sampled at different times.
      const fistWorld = new T.Vector3(0, 0.123, 0);
      vm.bones.get('hand_l').localToWorld(fistWorld);
      s.reach = fistWorld.distanceTo(t);
    } else {
      s.reach = null;
    }
    for (const [name, part] of Object.entries(p.currentVM.parts || {})) {
      s[`part_${name}`] = part.position.z;
    }
    return s;
  };

  const run = (weapon, action, frames, setup) => {
    reviveAndArm();
    p.triggerHeld = false;
    p.triggerQueued = false;
    p.slots = [weapon];
    p.slotIdx = 0;
    p.knifeOut = false;
    p._mountViewmodel();
    p.mag = p.weapon.mag;
    for (let i = 0; i < 4; i++) g.items.autoPlace(p.character.pack, g.items.makeItem(AMMO[weapon]));
    g.step(1 / 60, 150);                    // let the draw settle

    const magBefore = p.mag;
    // Baseline first, *then* the trigger. Sampling only after setup meant frame 0
    // already contained the recoil at full deflection, so the series that followed was
    // the kick decaying — and every weapon read as recoiling downwards.
    const frameData = [sample()];
    if (setup) setup();
    for (let i = 0; i < frames; i++) {
      g.step(1 / 60, 1);
      frameData.push(sample());
    }

    // Largest single-frame movement of any tracked point.
    let jump = 0;
    let jumpAt = 0;
    let jumpWhat = '';
    for (let i = 1; i < frameData.length; i++) {
      for (const key of ['muzzle', 'fistL', 'fistR']) {
        const d = frameData[i][key].distanceTo(frameData[i - 1][key]);
        if (d > jump) { jump = d; jumpAt = i; jumpWhat = key; }
      }
    }
    const reaches = frameData.map((f) => f.reach).filter((r) => r !== null);
    reaches.sort((a, b) => a - b);
    const finite = frameData.every((f) => Number.isFinite(f.muzzle.x + f.fistL.x + f.fistR.x));

    return {
      weapon,
      action,
      jump: +jump.toFixed(4),
      jumpAt,
      jumpWhat,
      reachMedian: reaches.length ? +reaches[Math.floor(reaches.length / 2)].toFixed(4) : null,
      reachMax: reaches.length ? +reaches[reaches.length - 1].toFixed(4) : null,
      finite,
      fired: action === 'fire' ? p.mag < magBefore : null,
      frames: opts.verbose ? frameData.map((f) => ({
        m: [+f.muzzle.x.toFixed(3), +f.muzzle.y.toFixed(3), +f.muzzle.z.toFixed(3)],
        l: [+f.fistL.x.toFixed(3), +f.fistL.y.toFixed(3), +f.fistL.z.toFixed(3)],
      })) : undefined,
      barrelY: frameData.map((f) => +f.barrelY.toFixed(4)),
      camPitch: frameData.map((f) => +f.camPitch.toFixed(4)),
    };
  };

  const weapons = opts.only ? [opts.only] : ['pistol', 'smg', 'shotgun', 'rifle', 'dmr'];
  for (const weapon of weapons) {
    out.push(run(weapon, 'idle', 90));
    out.push(run(weapon, 'fire', 40, () => {
      p.fireCooldown = 0;
      // Automatic weapons read `triggerHeld`, semi-automatics read `triggerQueued`.
      // Setting only the latter meant the rifle and SMG were never tested at all.
      p.triggerQueued = true;
      p.triggerHeld = true;
      g.setLocked(true);
    }));
    out.push(run(weapon, 'reload', 170, () => { p.mag = 0; p.startReload(); }));
    if (g.THREE && p.weapon.pump) {
      out.push(run(weapon, 'pump', 45, () => {
        p.mag = 6; p.pumpT = 0; p.fireCooldown = 0;
        g.setLocked(true); p.triggerQueued = true;
      }));
    }
  }
  return out;
}, { only, verbose });

await browser.close();

// ---------------------------------------------------------------- reporting

let failed = 0;
const fail = (msg) => { failed++; console.log(`  FAIL  ${msg}`); };

console.log('weapon    action   jump     reach(med/max)  recoil');
console.log('-'.repeat(78));
for (const r of report) {
  // Recoil: on the fire action the barrel should pitch UP, so the muzzle rises
  // relative to the breech. A drop means the kick is inverted.
  let recoil = '-';
  if (r.action === 'fire') {
    const peakOf = (series) => {
      const start = series[0];
      const peak = series.reduce((a, b) => (Math.abs(b - start) > Math.abs(a - start) ? b : a), start);
      return peak - start;
    };
    const barrel = peakOf(r.barrelY);
    const cam = peakOf(r.camPitch);
    const dir = (d) => (d > 0.002 ? 'up' : d < -0.002 ? 'DOWN' : 'flat');
    recoil = `barrel ${dir(barrel)} ${barrel.toFixed(3)} / cam ${dir(cam)} ${cam.toFixed(3)}`;
    r._barrel = barrel;
    r._cam = cam;
  }
  const reach = r.reachMedian === null ? '        -     '
    : `${r.reachMedian.toFixed(3)}/${r.reachMax.toFixed(3)}`.padEnd(14);
  console.log(
    `${r.weapon.padEnd(9)} ${r.action.padEnd(8)} ${r.jump.toFixed(4).padEnd(8)} ${reach} ${recoil}`,
  );

  if (!r.finite) fail(`${r.weapon}/${r.action}: non-finite transform`);
  if (r.jump > LIMITS.jump) {
    fail(`${r.weapon}/${r.action}: ${r.jumpWhat} jumps ${r.jump.toFixed(3)} m in one frame (at frame ${r.jumpAt})`);
  }
  if (r.reachMedian !== null && r.reachMedian > LIMITS.reach) {
    fail(`${r.weapon}/${r.action}: support hand sits ${r.reachMedian.toFixed(3)} m off its target`);
  }
  if (r.action === 'fire' && r.fired === false) {
    fail(`${r.weapon}/fire: the weapon never discharged, so nothing below is meaningful`);
  }
  if (r.action === 'fire' && r.fired) {
    if (r._barrel < -0.002) fail(`${r.weapon}/fire: the barrel pitches DOWN under recoil`);
    else if (Math.abs(r._barrel) <= 0.002) fail(`${r.weapon}/fire: the barrel does not move under recoil`);
    if (r._cam < -0.002) fail(`${r.weapon}/fire: the camera kicks DOWN`);
    else if (Math.abs(r._cam) <= 0.002) fail(`${r.weapon}/fire: no camera kick`);
  }
}

for (const e of pageErrors) fail(`page error: ${e}`);
console.log('-'.repeat(78));
console.log(failed ? `${failed} problem(s)` : 'all clean');
process.exitCode = failed ? 1 : 0;
