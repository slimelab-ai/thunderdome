/**
 * Third-person locomotion test bed.
 *
 *   node tools/fightercheck.mjs            # every gait, every direction
 *   node tools/fightercheck.mjs --verbose  # per-case detail
 *
 * The first-person bench (`animcheck.mjs`) drives the viewmodel. This one drives a
 * bare `FighterRig` with no AI, no world and no camera, and measures the things that
 * make third-person locomotion read as real:
 *
 *   stride    the ground distance one authored cycle actually covers, measured from
 *             the feet. This is not a number you can guess — it falls out of the leg
 *             swing angles — and getting it wrong is *the* cause of foot sliding,
 *             because the runtime advances the blendspace by distance travelled.
 *   slide     how fast the planted foot drifts across the floor. A planted foot that
 *             moves is a foot on a conveyor belt, which is what the walk looked like.
 *   jump      largest single-frame move of a foot in rig space. Catches blends that
 *             pop, which is what happens when two cycles play at different phases.
 *   ground    no foot below the floor, and never both feet airborne in a walk.
 *   locked    feet must not move at all when only the aim offset or lean changes.
 *             This is the check that would have caught the old lean, which rolled the
 *             whole fighter about his feet and lifted a boot into the air.
 *
 * The rig is stepped by hand, so every measurement is of the *final* world transform
 * after the mixer, the blendspace weights and the additive layer have all composed —
 * which is the only place any of these faults are visible.
 */
import { dirname } from 'node:path';
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
const verbose = process.argv.includes('--verbose');
const url = arg('url', 'http://localhost:5173');

// A foot at a brisk 2 m/s covers 0.033 m per frame at 60 fps.
const LIMITS = {
  slide: 0.07,     // m the planted foot may wander across the floor in one stance
  jump: 6.0,       // biggest single-frame foot move, as a multiple of the typical one
  sink: 0.035,     // m a foot may pass below the floor
  locked: 0.012,   // m a foot may move when only the upper body is asked to change
  grip: 0.070,     // m the support fist may sit from the weapon it is holding
  recoil: 2.0,     // deg the muzzle must swing under sustained automatic fire
  headStep: 0.045, // m the head may move in one frame, through any state change
  churn: 0.60,     // how much blendspace weight may move in one frame
  bob: 0.085,      // m the head may rise and fall over one locomotion cycle
  covered: 0.90,   // fraction of the visible fighter the hitboxes must cover
  overhang: 0.30,  // fraction of hitbox coverage allowed to stick out past the mesh;
                   // a box around a cylinder is ~27% over by geometry alone
  headParted: 0.85,// fraction of skull hits that must come back as head hits
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
// Deliberately *not* `await window.__game.assetsReady` here.
//
// Combat assets now sit behind a gate that only opens when a match is actually
// started (`beginCombatAssetLoading`, wired into `buildArena` as `loadGate`), so
// `arena.propsReady` — and therefore `assetsReady` — stays pending forever on the
// menu. Every bench used to wait on it before starting anything, and after that
// change they all hung until puppeteer's protocol timeout killed them with a stack
// trace that said nothing about loading. Start the match, then wait for the phase.

const report = await page.evaluate(async () => {
  const g = window.__game;
  const T = g.THREE;
  const DT = 1 / 60;

  // The fighter model, and only that. `assetsReady` also waits on the arena props,
  // which sit behind the combat asset gate and never resolve outside a match — this
  // bench drives a rig by hand and needs neither.
  await g.loadCombatAssets();

  const rig = new g.FighterRig({ scale: 1 });
  rig.group.position.set(0, 0, 0);
  g.scene.add(rig.group);

  // Prove the rig is actually being driven before measuring it.
  //
  // This bench drives the rig by hand rather than through the match, so it does not
  // depend on `phase` the way the others do — but the others learned that the hard
  // way, twice, and a bench that silently measures a static scene reports a perfect
  // score or a catalogue of nonsense with equal confidence. Three lines to make that
  // impossible is a good trade.
  {
    const probe = rig.bones.get('foot_l');
    const before = probe.quaternion.clone();
    for (let i = 0; i < 20; i++) { rig.setStance(3, false, 0, 1); rig.update(DT); }
    if (before.angleTo(probe.quaternion) < 1e-4) {
      throw new Error('the fighter rig is not animating — the harness is measuring nothing');
    }
    rig.setStance(0, false, 0, 1);
    for (let i = 0; i < 30; i++) rig.update(DT);
  }

  const feet = ['foot_l', 'foot_r'].map((n) => rig.bones.get(n));
  const world = new T.Vector3();
  const local = new T.Vector3();

  /** World and rig-space position of both feet, right now. */
  function sampleFeet() {
    rig.group.updateMatrixWorld(true);
    return feet.map((b) => {
      world.setFromMatrixPosition(b.matrixWorld);
      local.copy(world);
      rig.group.worldToLocal(local);
      return { wx: world.x, wy: world.y, wz: world.z, lx: local.x, ly: local.y, lz: local.z };
    });
  }

  /**
   * Walk the rig in a straight line and record the feet every frame.
   *
   * The rig has no root motion, so the harness supplies it: the group is translated
   * at `speed` while `setStance` is told the same speed. That is exactly what the
   * game does, so any disagreement between the two shows up here as slide.
   *
   * Local +Z is forward and local +X is his *left*, so a rightward `moveX` sends the
   * body along world −X when yaw is zero.
   */
  function run({ speed, crouching, moveX, moveZ, frames = 260, aim = null, lean = 0 }) {
    const len = Math.hypot(moveX, moveZ) || 1;
    const nx = moveX / len, nz = moveZ / len;
    rig.group.position.set(0, 0, 0);
    rig.phase = 0;
    rig._crouchK = crouching ? 1 : 0;   // start settled; the ease is tested separately
    const trace = [];
    for (let i = 0; i < frames; i++) {
      const t = i * DT;
      rig.group.position.x += -nx * speed * DT;
      rig.group.position.z += nz * speed * DT;
      rig.setStance(speed, crouching, moveX, moveZ);
      if (aim) rig.setAim(aim.pitch(t), aim.yaw(t));
      rig.setLean(typeof lean === 'function' ? lean(t) : lean);
      rig.update(DT);
      trace.push({ t, phase: rig.phase, feet: sampleFeet() });
    }
    return { trace, nx, nz };
  }

  /**
   * Turn a trace into the numbers that matter. Only the back half is measured: the
   * first second is the blend easing in from idle, which is meant to move.
   */
  function measure({ trace, nx, nz }, speed, usedStride) {
    const half = trace.slice(Math.floor(trace.length / 2));
    const out = { stride: 0, want: 0, slide: 0, jump: 0, jumpRatio: 0, sink: 0, airborne: 0 };

    // Travel direction in rig space, to project the foot swing onto.
    const dirLX = -nx, dirLZ = nz;

    let wantSum = 0, wantN = 0;
    for (let f = 0; f < 2; f++) {
      const proj = half.map((s) => s.feet[f].lx * dirLX + s.feet[f].lz * dirLZ);
      const excursion = Math.max(...proj) - Math.min(...proj);
      out.stride = Math.max(out.stride, excursion);

      // Stance is found from *motion*, not from height.
      //
      // Height thresholds do not survive a blend: two clips whose planted foot sits at
      // exactly the same level produce a blended foot that wobbles a few millimetres,
      // so a tight window rejects the real stance and a loose one accepts the start of
      // the swing. Either way the number comes out confidently wrong, and both did.
      // The foot is planted exactly when it is travelling backwards, which is a
      // property of the pose and survives any blend.
      let backFrames = 0;
      for (let i = 1; i < proj.length; i++) if (proj[i] < proj[i - 1]) backFrames++;
      const beta = backFrames / (proj.length - 1);

      // Over the phase fraction `beta` the foot gives back `excursion` of ground, so
      // the stride that makes it stationary is excursion / beta. No height, no
      // threshold, no tuning.
      if (beta > 0.05) { wantSum += excursion / beta; wantN++; }

      const mid = (xs) => {
        if (!xs.length) return 0;
        const t = [...xs].sort((p, q) => p - q);
        return t[t.length >> 1];
      };

      // How far the planted foot wanders across the floor, in metres, over one stance.
      //
      // Measured as a *displacement from where it landed*, not as a per-frame speed.
      // A per-frame speed cannot tell drift from ripple, and at a run there is plenty
      // of ripple: the clip plays 2.8x faster than it was authored, so consecutive
      // render frames cross a varying number of keys and the instantaneous velocity
      // alternates around the correct mean. That is invisible. A foot that creeps
      // across the floor is not, and only this measures it.
      const slips = [];
      let anchor = null, worst = 0;
      for (let i = 1; i < half.length; i++) {
        const b = half[i].feet[f];
        if (proj[i] < proj[i - 1]) {
          if (!anchor) { anchor = b; worst = 0; }
          worst = Math.max(worst, Math.hypot(b.wx - anchor.wx, b.wz - anchor.wz));
        } else if (anchor) {
          slips.push(worst);
          anchor = null;
        }
        out.sink = Math.max(out.sink, -Math.min(b.ly, 0));
      }
      out.slide = Math.max(out.slide, mid(slips));

      // Pops are measured against the clip's own tempo, not an absolute distance: a
      // run legitimately throws a foot four times faster than a walk does, so a fixed
      // threshold either misses pops in a run or fails every clean one.
      const steps = [];
      for (let i = 1; i < half.length; i++) {
        const a = half[i - 1].feet[f], b = half[i].feet[f];
        steps.push(Math.hypot(b.lx - a.lx, b.ly - a.ly, b.lz - a.lz));
      }
      out.jumpRatio = Math.max(out.jumpRatio, Math.max(...steps) / (mid(steps) || 1e-6));
    }
    if (wantN) out.want = wantSum / wantN;

    // Airborne fraction: how much of the cycle has neither foot down. A run is meant
    // to have one; a walk, by definition, is not.
    const fl = Math.min(...half.map((q) => q.feet[0].ly));
    const fr = Math.min(...half.map((q) => q.feet[1].ly));
    let up = 0;
    for (const s of half) {
      if (s.feet[0].ly - fl > 0.05 && s.feet[1].ly - fr > 0.05) up++;
    }
    out.airborne = up / half.length;
    return out;
  }

  /**
   * The stride the runtime is currently configured to use for one direction. Mirrors
   * `_updateLocomotion` exactly, vector sum included — a bench that models the runtime
   * differently from the runtime is measuring something nobody ships.
   */
  function configuredStride(gait, mx, mz) {
    const len = Math.hypot(mx, mz) || 1;
    const st = rig._loco.find((e) => e.gait === gait).strides;
    let a = Math.atan2(mx, mz) / (Math.PI / 4);
    if (a < 0) a += 8;
    const lo = Math.floor(a) % 8, frac = a - Math.floor(a);
    let sx = 0, sz = 0;
    for (const [i, w] of [[lo, 1 - frac], [(lo + 1) % 8, frac]]) {
      const ang = i * Math.PI / 4;
      sx += w * st[i] * Math.sin(ang);
      sz += w * st[i] * Math.cos(ang);
    }
    return Math.abs(sx * mx / len + sz * mz / len);
  }

  const cases = [];
  // Every pole, plus the midpoint between each adjacent pair — the midpoints are
  // where a blendspace is at its worst and a pole-only sweep would never look.
  const NAMES = ['f', 'f+', 'fr', 'fr+', 'r', 'r+', 'br', 'br+',
                 'b', 'b+', 'bl', 'bl+', 'l', 'l+', 'fl', 'fl+'];
  const DIRS = {};
  NAMES.forEach((n, i) => { const a = i * Math.PI / 8; DIRS[n] = [Math.sin(a), Math.cos(a)]; });
  const GAITS = [
    ['walk', 1.6, false], ['run', 4.0, false], ['crouch', 1.2, true],
  ];
  for (const [gait, speed, crouching] of GAITS) {
    for (const [dir, [mx, mz]] of Object.entries(DIRS)) {
      const used = configuredStride(gait, mx, mz);
      const r = run({ speed, crouching, moveX: mx, moveZ: mz });
      cases.push({ name: `${gait}_${dir}`, gait, dir, speed, used, ...measure(r, speed, used) });
    }
  }

  // Direction sweep: rotate the travel direction a full turn while walking, and watch
  // for a pop. Blending four poles should be continuous everywhere; it is not if two
  // of them disagree about phase.
  {
    rig.group.position.set(0, 0, 0);
    rig.phase = 0;
    const speed = 1.6;
    let maxJump = 0;
    let prev = null;
    for (let i = 0; i < 480; i++) {
      const a = (i / 480) * Math.PI * 2;
      const mx = Math.sin(a), mz = Math.cos(a);
      rig.group.position.x += -mx * speed * DT;
      rig.group.position.z += mz * speed * DT;
      rig.setStance(speed, false, mx, mz);
      rig.update(DT);
      const s = sampleFeet();
      if (prev && i > 60) {
        for (let f = 0; f < 2; f++) {
          maxJump = Math.max(maxJump, Math.hypot(
            s[f].lx - prev[f].lx, s[f].ly - prev[f].ly, s[f].lz - prev[f].lz));
        }
      }
      prev = s;
    }
    cases.push({ name: 'sweep_360', speed, stride: null, slide: null, sweepJump: maxJump, sink: 0, airborne: 0 });
  }

  // Upper body in isolation. Standing still, sweep aim and lean through their full
  // range: the feet must not move a millimetre. Anything that shows up here is the
  // upper body leaking into the legs.
  const locked = {};
  for (const [name, drive] of [
    ['aim_pitch', { aim: { pitch: (t) => Math.sin(t * 1.5) * 0.7, yaw: () => 0 }, lean: 0 }],
    ['aim_yaw', { aim: { pitch: () => 0, yaw: (t) => Math.sin(t * 1.5) * 0.8 }, lean: 0 }],
    ['lean', { aim: null, lean: (t) => Math.sin(t * 1.5) }],
  ]) {
    rig.group.position.set(0, 0, 0);
    rig.setStance(0, false, 0, 1);
    for (let i = 0; i < 60; i++) rig.update(DT);   // settle
    const base = sampleFeet();
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      const t = i * DT;
      rig.setStance(0, false, 0, 1);
      if (drive.aim) rig.setAim(drive.aim.pitch(t), drive.aim.yaw(t));
      rig.setLean(typeof drive.lean === 'function' ? drive.lean(t) : drive.lean);
      rig.update(DT);
      const s = sampleFeet();
      for (let f = 0; f < 2; f++) {
        worst = Math.max(worst, Math.hypot(
          s[f].wx - base[f].wx, s[f].wy - base[f].wy, s[f].wz - base[f].wz));
      }
    }
    locked[name] = worst;
    rig.setAim(0, 0); rig.setLean(0);
    for (let i = 0; i < 60; i++) rig.update(DT);
  }

  // Does the aim offset actually turn the head, and the right way?
  //
  // Measured as a *direction*, not a position. A spine twist rotates the head almost
  // in place, so a position probe reads nothing and reports a working aim offset as
  // broken — which is exactly what the first version of this check did.
  const aimRange = {};
  {
    const head = rig.bones.get('head');
    const read = () => {
      rig.group.updateMatrixWorld(true);
      const m = new T.Matrix4().copy(rig.group.matrixWorld).invert().multiply(head.matrixWorld);
      const q = new T.Quaternion().setFromRotationMatrix(m);
      // The head bone points up its own +Y, so its facing is local +Z... in rig space
      // after the bind rotation, what matters is only that this vector swings
      // consistently, so take the full basis and read the two axes we care about.
      return {
        fwd: new T.Vector3(0, 0, 1).applyQuaternion(q),
        up: new T.Vector3(0, 1, 0).applyQuaternion(q),
      };
    };
    const hold = (pitch, yaw) => {
      rig.setAim(pitch, yaw);
      for (let i = 0; i < 90; i++) { rig.setStance(0, false, 0, 1); rig.update(DT); }
      return read();
    };
    const rest = hold(0, 0);
    const up = hold(0.7, 0), down = hold(-0.7, 0);
    const left = hold(0, 0.8), right = hold(0, -0.8);
    // Total angle swept between the two poles, and its sign about the expected axis.
    const ang = (a, b) => a.angleTo(b);
    aimRange.pitchSweep = ang(up.fwd, down.fwd);
    aimRange.yawSweep = ang(left.fwd, right.fwd);
    // Sign: looking up must raise the head's facing relative to looking down.
    aimRange.pitchSign = Math.sign(up.fwd.y - down.fwd.y);
    // Positive yaw is to his left, and local +X is his left.
    aimRange.yawSign = Math.sign(left.fwd.x - right.fwd.x);
    aimRange.restSanity = ang(rest.fwd, rest.up);
    hold(0, 0);

    // Which way a lean actually leans.
    //
    // Worth measuring rather than deriving: the sign depends on a bone roll, a Blender
    // axis convention and a glTF axis flip, and getting any one of the three backwards
    // gives a fighter who peeks out of the opposite side of cover from the one combat
    // thinks he is exposing. Rig-space local +X is his left.
    const headPos = () => {
      rig.group.updateMatrixWorld(true);
      return rig.group.worldToLocal(
        new T.Vector3().setFromMatrixPosition(rig.bones.get('head').matrixWorld));
    };
    const settle = (k) => {
      rig.setLean(k);
      for (let i = 0; i < 90; i++) { rig.setStance(0, false, 0, 1); rig.update(DT); }
      return headPos();
    };
    // How far leaning actually carries the *muzzle* sideways. Combat sizes its corner
    // peek off this: a peek offset larger than the body can reach is a shot from an
    // angle that does not exist at the other end.
    const gun = g.buildHeldGun('rifle');
    rig.weaponSocket.add(gun);
    rig.setWeapon('rifle', gun);
    const muzzleAt = (k) => {
      rig.setLean(k);
      rig.setAimWeight(1);
      for (let i = 0; i < 90; i++) { rig.setStance(0, false, 0, 1); rig.update(DT); }
      rig.group.updateMatrixWorld(true);
      return rig.group.worldToLocal(
        new T.Vector3().setFromMatrixPosition(gun.userData.muzzle.matrixWorld));
    };
    const mR = muzzleAt(1), mL = muzzleAt(-1);
    aimRange.peekReach = Math.abs(mL.x - mR.x) / 2;
    // Bore height against the sight line.
    //
    // Combat fires from the real muzzle, so where the barrel sits decides what the
    // fighter can shoot over. A weapon carried at the chest cannot clear cover its
    // owner can see over, and the fights slowed by half when that was true. A
    // shouldered weapon's bore belongs just under the eye.
    aimRange.boreHeight = muzzleAt(0).y;
    aimRange.eyeHeight = 1.55;   // Combatant.eyePos
    rig.setAimWeight(0);
    rig.weaponSocket.remove(gun);
    rig.setWeapon(null, null);

    const outR = settle(1), outL = settle(-1);
    aimRange.leanSpread = Math.abs(outL.x - outR.x);
    // setLean(+1) means lean right, and his right is -X.
    aimRange.leanSign = Math.sign(outL.x - outR.x);
    settle(0);
  }

  // ---- transitions ----
  //
  // Gameplay state is not continuous. A fighter who reaches his goal drops from
  // 4.6 m/s to zero in one frame, and one frame of a fighter shoved by collision
  // resolution points anywhere at all. Both used to reach the blendspace raw:
  // stopping cut a deep leaning run pose straight to idle and threw the head 20 cm in
  // a single frame, and the heading swinging past 60 degrees between frames made
  // fighters snap between leaning left and leaning right twice every five seconds.
  //
  // Neither is visible in a steady walk, which is all every case above tests.
  const headOf = () => {
    rig.group.updateMatrixWorld(true);
    return rig.group.worldToLocal(
      new T.Vector3().setFromMatrixPosition(rig.bones.get('head').matrixWorld));
  };
  const transitions = [];
  for (const [name, script] of [
    ['stop', (i) => (i < 130 ? [4.4, 0, 1] : [0, 0, 1])],
    ['start', (i) => (i < 60 ? [0, 0, 1] : [4.4, 0, 1])],
    ['reverse', (i) => (i < 130 ? [3.2, 0, 1] : [3.2, 0, -1])],
    // The pathological case: heading noise of the kind collision resolution produces.
    ['jitter', (i) => [3.0, i % 2 ? 0.9 : -0.9, 0.4]],
  ]) {
    rig.group.position.set(0, 0, 0);
    rig.phase = 0;
    let head = null, worstHead = 0, worstChurn = 0, prevW = null;
    for (let i = 0; i < 260; i++) {
      const [sp, mx, mz] = script(i);
      const len = Math.hypot(mx, mz) || 1;
      rig.group.position.x += -(mx / len) * sp * DT;
      rig.group.position.z += (mz / len) * sp * DT;
      rig.setStance(sp, false, mx, mz);
      rig.update(DT);
      const h = headOf();
      if (head && i > 20) worstHead = Math.max(worstHead, h.distanceTo(head));
      head = h;
      const w = Array.from(rig._dirW);
      if (prevW && i > 20) {
        let churn = 0;
        for (let k = 0; k < 8; k++) churn += Math.abs(w[k] - prevW[k]);
        worstChurn = Math.max(worstChurn, churn);
      }
      prevW = w;
    }
    transitions.push({ name, head: worstHead, churn: worstChurn });
  }

  // Steady-state head travel: how far the head rides up and down over a cycle with
  // nothing else changing. This is the "heads bob a lot" number.
  const bob = [];
  for (const [name, sp, crouched] of [['walk', 1.6, false], ['run', 4.0, false], ['crouch', 1.4, true]]) {
    rig.group.position.set(0, 0, 0);
    rig._crouchK = crouched ? 1 : 0;
    for (let i = 0; i < 200; i++) { rig.setStance(sp, crouched, 0, 1); rig.update(DT); }
    const ys = [], xs = [];
    for (let i = 0; i < 200; i++) {
      rig.group.position.z += sp * DT;
      rig.setStance(sp, crouched, 0, 1);
      rig.update(DT);
      const h = headOf();
      ys.push(h.y); xs.push(h.x);
    }
    bob.push({ name, rise: Math.max(...ys) - Math.min(...ys), sway: Math.max(...xs) - Math.min(...xs) });
  }
  rig._crouchK = 0;

  // ---- hitbox coverage ----
  //
  // Do the bone hitboxes actually cover the fighter you can see?
  //
  // Nothing else checks this. The boxes are invisible, so a gap is a place where
  // rounds pass through a visible body and nobody can tell why, and an overhang is a
  // place where they connect with thin air. A grid of rays is cast at the fighter, and
  // what the skinned mesh intercepts is compared against what the boxes intercept.
  const coverage = [];
  {
    const ray = new T.Raycaster();
    ray.firstHitOnly = false;
    const dir = new T.Vector3();
    const from = new T.Vector3();
    for (const [name, drive] of [
      ['aimed', () => { rig.setStance(0, false, 0, 1); rig.setAimWeight(1); }],
      ['running', () => { rig.setStance(4.0, false, 0.3, 0.95); rig.setAimWeight(1); }],
      ['crouched', () => { rig.setStance(1.4, true, 0, 1); rig.setAimWeight(1); }],
    ]) {
      rig.group.position.set(0, 0, 0);
      for (let i = 0; i < 150; i++) { drive(); rig.setAim(0.05, 0.1); rig.update(DT); }
      rig.group.updateMatrixWorld(true);

      // Everything above the neck joint is head. Using a radius around the head *bone*
      // instead is wrong twice over: the bone sits at the base of the skull, not its
      // centre, so the sample lands on the jaw and throat.
      const neckY = new T.Vector3()
        .setFromMatrixPosition(rig.bones.get('head').matrixWorld).y + 0.03;
      let mesh = 0, box = 0, both = 0, headRays = 0, headBoxed = 0;
      // Cast from several angles: a fighter is shot at from the front, the side and
      // behind, and a box that lines up from one of those can miss from another.
      for (const yaw of [0, Math.PI / 2, Math.PI]) {
        const cx = Math.sin(yaw) * 4, cz = Math.cos(yaw) * 4;
        for (let gx = -22; gx <= 22; gx++) {
          for (let gy = 0; gy <= 46; gy++) {
            const off = gx * 0.022;
            from.set(cx + Math.cos(yaw) * off, gy * 0.04, cz - Math.sin(yaw) * off);
            dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
            ray.set(from, dir);
            const hitMesh = ray.intersectObjects(rig.skinned, false);
            const hitBox = ray.intersectObjects(rig.hitboxes, false);
            if (hitMesh.length) mesh++;
            if (hitBox.length) box++;
            if (hitMesh.length && hitBox.length) both++;
            // Rays that pass through the skull should come back as head hits.
            if (hitMesh.length && hitMesh[0].point.y > neckY) {
              headRays++;
              if (hitBox.length && hitBox[0].object.userData.part === 'head') headBoxed++;
            }
          }
        }
      }
      coverage.push({
        name,
        covered: mesh ? both / mesh : 0,
        overhang: box ? (box - both) / box : 0,
        headParted: headRays ? headBoxed / headRays : 1,
      });
    }
    rig.setAimWeight(0);
    rig._crouchK = 0;
  }

  // ---- support hand ----
  //
  // Does the left hand actually hold the weapon?
  //
  // This is the check that was missing while every fighter in the game ran around
  // one-handing a rifle with his support hand out in front of him gripping air. The
  // stance pose reached for a rifle-length handguard and nothing verified it arrived —
  // and it never did, on any weapon, in any pose.
  const grip = [];
  for (const id of ['rifle', 'smg', 'shotgun', 'dmr', 'pistol']) {
    const gun = g.buildHeldGun(id);
    rig.weaponSocket.add(gun);
    rig.setWeapon(id, gun);
    const point = new T.Vector3(...g.SUPPORT_GRIP[id]);
    const fist = new T.Vector3();
    const measure = () => {
      rig.group.updateMatrixWorld(true);
      const want = point.clone();
      gun.localToWorld(want);
      // The fist, not the wrist: the hand bone sits a hand's length short of what it
      // is supposed to be holding, and measuring the wrist hides a 10 cm miss.
      fist.set(0, 0.11, 0);
      rig.bones.get('hand_l').localToWorld(fist);
      return fist.distanceTo(want);
    };
    // Three states that matter: standing aimed, walking aimed, and firing.
    const cases2 = {};
    for (const [name, drive] of [
      ['aimed', () => { rig.setStance(0, false, 0, 1); rig.setAimWeight(1); }],
      ['walking', () => { rig.setStance(3.0, false, 0.4, 0.9); rig.setAimWeight(1); }],
      ['crouched', () => { rig.setStance(1.4, true, 0, 1); rig.setAimWeight(1); }],
    ]) {
      for (let i = 0; i < 120; i++) { drive(); rig.setAim(0.1, 0.2); rig.update(DT); }
      let worst = 0;
      for (let i = 0; i < 90; i++) { drive(); rig.setAim(0.1, 0.2); rig.update(DT); worst = Math.max(worst, measure()); }
      cases2[name] = worst;
    }
    // Under sustained automatic fire, retriggered every 5 frames the way a 700 rpm
    // weapon does.
    for (let i = 0; i < 60; i++) { rig.setStance(0, false, 0, 1); rig.setAimWeight(1); rig.update(DT); }
    let firing = 0;
    const socket = rig.weaponSocket;
    const dir = new T.Vector3();
    let minY = 1e9, maxY = -1e9;
    for (let i = 0; i < 180; i++) {
      if (i % 5 === 0) rig.trigger('fire');
      rig.setStance(0, false, 0, 1);
      rig.setAimWeight(1);
      rig.update(DT);
      firing = Math.max(firing, measure());
      rig.group.updateMatrixWorld(true);
      // Where the barrel points. The socket's -Z runs down the bore.
      dir.set(0, 0, -1).applyQuaternion(socket.getWorldQuaternion(new T.Quaternion()));
      minY = Math.min(minY, dir.y); maxY = Math.max(maxY, dir.y);
    }
    cases2.firing = firing;
    // How much the muzzle actually moves under sustained fire, in degrees. An additive
    // impulse that is reset faster than it plays contributes nothing at all, and the
    // pose looks identical to not firing.
    cases2.recoilDeg = Math.asin(Math.min(1, maxY - minY)) * 57.3;
    grip.push({ id, ...cases2 });
    rig.weaponSocket.remove(gun);
  }
  rig.setWeapon(null, null);

  g.scene.remove(rig.group);
  return { cases, locked, aimRange, grip, transitions, bob, coverage };
});

await browser.close();

// ---- report ----
let failures = 0;
const bad = (cond, msg) => { if (cond) { failures++; return ` FAIL(${msg})`; } return ''; };

console.log('\nlocomotion blendspace');
console.log('  case           speed    used    want   swing    slip     pop    sink   air');
for (const c of report.cases) {
  const n = (v, d = 3) => (v == null ? '   -  ' : v.toFixed(d).padStart(6));
  let flags = '';
  if (c.slide != null) flags += bad(c.slide > LIMITS.slide, `slip ${(c.slide * 100).toFixed(1)} cm`);
  if (c.jumpRatio != null) flags += bad(c.jumpRatio > LIMITS.jump, `pop ${c.jumpRatio.toFixed(1)}x typical`);
  flags += bad(c.sink > LIMITS.sink, `sink ${c.sink.toFixed(3)} m`);
  // A run is *supposed* to have a flight phase. A walk keeps a foot down.
  const airLimit = c.gait === 'run' ? 0.42 : 0.12;
  if (c.airborne != null && c.gait) flags += bad(c.airborne > airLimit, `airborne ${(c.airborne * 100) | 0}%`);
  console.log(`  ${c.name.padEnd(13)} ${c.speed.toFixed(1).padStart(5)}  ${n(c.used)}  ${n(c.want)}  ${n(c.stride)}  ${n(c.slide)}  ${n(c.jumpRatio, 2)}  ${n(c.sink)}  ${(c.airborne * 100).toFixed(0).padStart(3)}%${flags}`);
}
const sweep = report.cases.find((c) => c.name === 'sweep_360');
console.log(`  turning full circle at a walk, worst single-frame foot move ${sweep.sweepJump.toFixed(3)} m`
  + bad(sweep.sweepJump > 0.06, `sweep pop ${sweep.sweepJump.toFixed(3)} m`));
console.log('  (`used` is what the runtime is configured with; `want` is what the feet ask for)');

// The stride table the runtime should be carrying, straight out of the measurement.
const solved = {};
for (const c of report.cases) {
  if (!c.gait || c.dir.endsWith('+')) continue;
  (solved[c.gait] ||= {})[c.dir] = c.want;
}
console.log('\nsolved stride table');
for (const [gait, dirs] of Object.entries(solved)) {
  const parts = ['f', 'fr', 'r', 'br', 'b', 'bl', 'l', 'fl'].map((d) => `${d}: ${dirs[d].toFixed(2)}`).join(', ');
  console.log(`  ${gait.padEnd(7)} { ${parts} }`);
}

console.log('\nupper body must not move the feet');
for (const [k, v] of Object.entries(report.locked)) {
  console.log(`  ${k.padEnd(12)} ${v.toFixed(4)} m${bad(v > LIMITS.locked, `${v.toFixed(4)} m`)}`);
}

console.log('\naim offset reach');
const a = report.aimRange;
console.log(`  pitch sweep  ${(a.pitchSweep * 57.3).toFixed(1).padStart(6)} deg  sign ${a.pitchSign > 0 ? 'up' : 'DOWN'}${bad(a.pitchSweep < 0.35, `pitch sweep only ${(a.pitchSweep * 57.3).toFixed(1)} deg`)}${bad(a.pitchSign <= 0, 'aim pitch is inverted')}`);
console.log(`  lean spread  ${(a.leanSpread * 100).toFixed(1).padStart(6)} cm   sign ${a.leanSign > 0 ? 'right' : 'LEFT'}${bad(a.leanSpread < 0.10, `lean spread only ${(a.leanSpread * 100).toFixed(1)} cm`)}${bad(a.leanSign <= 0, 'setLean(+1) leans him left, not right')}`);
console.log(`  bore height  ${(a.boreHeight * 100).toFixed(1).padStart(6)} cm   vs a ${(a.eyeHeight * 100).toFixed(0)} cm sight line`
  + bad(a.eyeHeight - a.boreHeight > 0.12, `bore sits ${((a.eyeHeight - a.boreHeight) * 100).toFixed(0)} cm below the eye`));
console.log(`  peek reach   ${(a.peekReach * 100).toFixed(1).padStart(6)} cm   how far a lean carries the muzzle (PEEK_REACH in combatant.js)`);
console.log(`  yaw sweep    ${(a.yawSweep * 57.3).toFixed(1).padStart(6)} deg  sign ${a.yawSign > 0 ? 'left' : 'RIGHT'}${bad(a.yawSweep < 0.35, `yaw sweep only ${(a.yawSweep * 57.3).toFixed(1)} deg`)}${bad(a.yawSign <= 0, 'aim yaw is inverted')}`);

console.log('\ntransitions: gameplay state is not continuous, and the rig must not care');
console.log('  case        worst head step   pole churn/frame');
for (const t of report.transitions) {
  console.log(`  ${t.name.padEnd(10)} ${t.head.toFixed(3).padStart(11)} m ${t.churn.toFixed(2).padStart(14)}`
    + bad(t.head > LIMITS.headStep, `${t.name} moves the head ${(t.head * 100).toFixed(1)} cm in one frame`)
    + bad(t.churn > LIMITS.churn, `${t.name} churns the blendspace ${t.churn.toFixed(2)}/frame`));
}

console.log('\nhead travel over one cycle (the "heads bob" number)');
for (const b of report.bob) {
  console.log(`  ${b.name.padEnd(8)} rise ${(b.rise * 100).toFixed(1).padStart(5)} cm   sway ${(b.sway * 100).toFixed(1).padStart(5)} cm`
    + bad(b.rise > LIMITS.bob, `${b.name} head rises ${(b.rise * 100).toFixed(1)} cm`));
}

console.log('\nhitbox coverage: do the boxes cover the fighter you can see?');
console.log('  pose       body covered   overhang   head boxes read head');
for (const c of report.coverage) {
  const pc = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);
  console.log(`  ${c.name.padEnd(10)} ${pc(c.covered)}      ${pc(c.overhang)}   ${pc(c.headParted)}`
    + bad(c.covered < LIMITS.covered, `${c.name} leaves ${((1 - c.covered) * 100).toFixed(1)}% of the body unhittable`)
    + bad(c.overhang > LIMITS.overhang, `${c.name} has ${(c.overhang * 100).toFixed(1)}% of its hitboxes off the body`)
    + bad(c.headParted < LIMITS.headParted, `${c.name} reads only ${(c.headParted * 100).toFixed(0)}% of skull hits as head`));
}

console.log('\nsupport hand: distance from the left fist to the weapon it should be holding');
console.log('  weapon     aimed  walking crouched  firing   recoil');
for (const w of report.grip) {
  const n = (v) => v.toFixed(3).padStart(6);
  let flags = '';
  for (const k of ['aimed', 'walking', 'crouched', 'firing']) {
    flags += bad(w[k] > LIMITS.grip, `${k} grip off by ${(w[k] * 100).toFixed(1)} cm`);
  }
  flags += bad(w.recoilDeg < LIMITS.recoil, `recoil only ${w.recoilDeg.toFixed(1)} deg under sustained fire`);
  console.log(`  ${w.id.padEnd(9)} ${n(w.aimed)}  ${n(w.walking)}  ${n(w.crouched)}  ${n(w.firing)}  ${w.recoilDeg.toFixed(1).padStart(5)}°${flags}`);
}

if (pageErrors.length) {
  failures += pageErrors.length;
  console.log('\npage errors');
  for (const e of pageErrors) console.log(`  ${e}`);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nall clean\n');
process.exit(failures ? 1 : 0);
