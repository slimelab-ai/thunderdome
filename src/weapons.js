import * as THREE from 'three';
import { versioned } from './asset-version.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bindAuthoredMaterials } from './materials.js';

// dmg = per bullet torso damage. spread in degrees (hipfire base).
//
// `reloadEmpty` and `draw` are the handling model ported from DogEater, whose rule
// is that every action costs time and the *state you were in* decides how much.
//
// **A round in the chamber.** Reload with rounds left and the one already chambered
// stays there: you finish with `mag + 1` and you only swap the magazine, which is
// `reload`. Run the gun dry and there is nothing to chamber — you get `mag`, and you
// pay `reloadEmpty` because the bolt has to be sent home as well. Reloading early is
// therefore both faster and worth an extra round, which is the whole point: it gives
// a reason to top up behind cover instead of always firing to slide-lock.
//
// **`raise`** is how long the weapon takes to come back up out of a sprint. Sprinting
// carries it down where it cannot be fired, so closing ground fast costs a moment of
// helplessness at the end of it rather than being strictly free.
//
// **`draw`** is how long the weapon takes to come up after a swap. Nothing fires,
// reloads or aims until it has. Swapping used to be instantaneous, so the pistol was
// a free extra magazine you could reach in zero time.
//
// `suppression` is how hard a round from this weapon pins the people it is fired at,
// relative to the rifle. Not a damage number — a *threat* number, which is why the
// DMR outscores the SMG it loses a straight shootout to: a lane covered by something
// that kills in one is a lane nobody crosses, while a sidearm cracking off across the
// pit is a nuisance. Without this a player with the starting pistol could hold five
// men behind a crate as effectively as an AK, which is not what a sidearm is.
//
// `recoilPattern` is the shape of the climb, one entry per shot, `x` right and `y` up,
// in roughly unit terms — `recoilVelocity` sets how hard it is in degrees per second.
// `recoilImpulse` advances a few milliseconds of that kick on the firing frame, so
// low-rate guns punch immediately instead of beginning a slow camera drift.
// The list is walked in order and repeated if the magazine outlasts it, and the index
// resets after `recoilCooldown` without firing, so every burst opens the same way.
//
// The point of a pattern rather than a random kick is that it can be *learned*: a
// player who knows the gun can pull against it and hold a group. Sprays therefore
// climb hard for the first handful of rounds and then break sideways, which is where
// the skill is. `recoilRandom` adds a little scatter so it is not a machine.
// See src/recoil.js.

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 SIDEARM', price: 0, tier: 0,
    dmg: 34, rpm: 280, auto: false, mag: 12, reload: 1.25, reloadEmpty: 1.70, draw: 0.35, raise: 0.16,
    spread: 1.3, adsSpread: 0.22, recoil: 1.3, pellets: 1,
    aiRange: 15, adsFov: 60, sound: 'pistol',
    // When the slide is worked during the reload, as a fraction of the reload's
    // duration. Matches the frames in `anim_reload_pistol` where the support hand is
    // over the top of the weapon — without this the hand mimes a rack the slide never
    // performs, which is what made the reload read as a rifle's.
    slideRack: [0.66, 0.82],
    // Semi-auto, so the pattern is short and the cooldown rarely lets it run: a
    // sidearm's recoil is a flick you ride out between shots, not a climb.
    recoilPattern: [[0, 1], [0.14, 0.98], [-0.16, 0.96]],
    recoilVelocity: 9.0, recoilRandom: 1.4, recoilCooldown: 0.45,
    recoilImpulse: 0.055, viewKick: 0.72,
    // Just above what the decay eats at a fast trigger finger, so sustained
    // deliberate fire does pin somebody after a few seconds and a couple of
    // opportunist shots do nothing. Below about 0.5 a sidearm can never pin anyone
    // at all, which is as wrong in the other direction.
    suppression: 0.55,
    desc: 'Every contestant starts with one. 3 to the chest or 1 to the skull.',
  },
  smg: {
    id: 'smg', name: 'SKORPION K', price: 650, tier: 1,
    dmg: 15, rpm: 850, auto: true, mag: 32, reload: 1.6, reloadEmpty: 2.15, draw: 0.45, raise: 0.2,
    spread: 3.1, adsSpread: 1.3, recoil: 0.65, pellets: 1, falloff: 14,
    aiRange: 13, adsFov: 62, sound: 'smg',
    // Fast and light: little per shot, but 850 rpm stacks it quickly, and it wanders
    // rather than climbing straight — this is a weapon you walk onto a target.
    recoilPattern: [
      [0, 1], [0.05, 1], [0.12, 0.95], [0.2, 0.85], [0.28, 0.7], [0.3, 0.55],
      [0.22, 0.45], [0.05, 0.4], [-0.18, 0.4], [-0.35, 0.35], [-0.45, 0.3],
      [-0.4, 0.25], [-0.2, 0.25], [0.08, 0.25], [0.3, 0.2], [0.42, 0.2],
      [0.38, 0.15], [0.2, 0.15], [-0.05, 0.15], [-0.28, 0.15],
    ],
    recoilVelocity: 5.29, recoilRandom: 1.8, recoilCooldown: 0.5,
    recoilImpulse: 0.010, viewKick: 0.50,
    suppression: 0.75,
    desc: 'A hose of cheap brass. Wild past 12 meters, filthy up close.',
  },
  shotgun: {
    id: 'shotgun', name: 'PIT BOSS 12G', price: 950, tier: 2,
    dmg: 17, rpm: 82, auto: false, mag: 6, reload: 2.4, reloadEmpty: 2.4, draw: 0.60, raise: 0.26,
    spread: 4.6, adsSpread: 3.0, recoil: 3.2, pellets: 9, falloff: 24,
    aiRange: 8, adsFov: 64, sound: 'shotgun',
    // Pump action, loaded shell by shell. `pump` is the stroke that has to complete
    // between shots; `shellReload` is the time to feed one round, repeated until the
    // tube is full — a shotgun does not swap a magazine.
    pump: 0.42, shellReload: 0.44,
    // One heavy shove. There is no pattern to learn on a pump gun — you are back on
    // target by the time the next shell is chambered.
    recoilPattern: [[0, 1], [0.12, 1], [-0.12, 1]],
    recoilVelocity: 18.5, recoilRandom: 2.2, recoilCooldown: 0.6,
    recoilImpulse: 0.065, viewKick: 1.0,
    suppression: 0.6,
    desc: '9 pellets of crowd-pleasing violence. Deletes torsos inside 10m.',
  },
  rifle: {
    id: 'rifle', name: 'AK VULTURE', price: 1500, tier: 3,
    dmg: 43, rpm: 600, auto: true, mag: 30, reload: 1.9, reloadEmpty: 2.55, draw: 0.55, raise: 0.24,
    spread: 1.7, adsSpread: 0.4, recoil: 1.5, pellets: 1,
    aiRange: 20, adsFov: 55, sound: 'rifle',
    // The one worth learning. Six rounds nearly straight up, then a hard break right
    // and a slower drift back across — hold the trigger and you spell out the shape.
    recoilPattern: [
      [0, 1], [0.02, 1], [0.06, 0.98], [0.1, 0.92], [0.16, 0.84], [0.22, 0.72],
      [0.32, 0.56], [0.42, 0.44], [0.48, 0.34], [0.46, 0.28], [0.34, 0.24],
      [0.12, 0.22], [-0.14, 0.22], [-0.38, 0.2], [-0.52, 0.18], [-0.56, 0.16],
      [-0.48, 0.14], [-0.3, 0.14], [-0.05, 0.14], [0.22, 0.12], [0.44, 0.12],
      [0.54, 0.1], [0.5, 0.1], [0.34, 0.08], [0.1, 0.08], [-0.16, 0.08],
      [-0.36, 0.08], [-0.46, 0.06], [-0.4, 0.06], [-0.22, 0.06],
    ],
    recoilVelocity: 7.13, recoilRandom: 1.1, recoilCooldown: 0.55,
    recoilImpulse: 0.012, viewKick: 0.58,
    suppression: 1,
    desc: 'The workhorse of every syndicate in the league. 2–3 rounds does it.',
  },
  dmr: {
    id: 'dmr', name: 'LONGPIG DMR', price: 2500, tier: 4,
    dmg: 82, rpm: 145, auto: false, mag: 10, reload: 2.1, reloadEmpty: 2.80, draw: 0.70, raise: 0.3,
    spread: 0.9, adsSpread: 0.06, recoil: 2.5, pellets: 1,
    aiRange: 28, adsFov: 34, sound: 'dmr',
    // A single hard punch straight up. You lose the sight picture and get it back.
    recoilPattern: [[0, 1], [0.08, 1], [-0.09, 1]],
    recoilVelocity: 19.55, recoilRandom: 1.0, recoilCooldown: 0.8,
    recoilImpulse: 0.048, viewKick: 0.86,
    suppression: 1.15,
    desc: 'One shot, one funeral. Scoped. Slow. Surgical.',
  },
};

// the knife is innate — every fighter carries one, nobody sells it
WEAPONS.knife = {
  id: 'knife', name: 'PIT SHANK', price: 0, tier: -1,
  dmg: 55, rpm: 95, auto: false, mag: 0, reload: 0, reloadEmpty: 0, draw: 0.25,
  spread: 0, adsSpread: 0, recoil: 0.6, pellets: 1,
  recoilPattern: [], recoilVelocity: 0.0,
  aiRange: 2, adsFov: 70, sound: 'slash', melee: true, meleeRange: 2.4,
  desc: 'Always with you. Two good slashes end anyone.',
};

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun', 'rifle', 'dmr'];

// ---------------------------------------------------------------- models
//
// Weapons are authored assets (tools/blender/weapons.py), loaded once and cloned.
// Barrel along -Z, origin at the grip — the same convention as the fighter's hand
// socket, so a gun attaches identically in the world and in first person.

/**
 * Where each weapon's grip actually is, in model space.
 *
 * The weapons were authored with their *origin* at the grip in principle, but in
 * practice each one's grip geometry sits somewhere slightly different — a pistol's
 * grip is 5 cm behind and 2.5 cm below its origin, a rifle's is right on it. The
 * first-person viewmodel offsets each weapon by this so the firing hand closes on the
 * grip rather than somewhere along the frame.
 */
export const GRIP_ANCHOR = {
  pistol: [0, -0.075, 0.025],
  smg: [0, -0.060, 0.030],
  shotgun: [0, -0.020, 0.090],
  rifle: [0, -0.055, 0.090],
  dmr: [0, -0.050, 0.100],
  knife: [0, 0.004, 0.055],
};

/**
 * Where the support hand belongs on each weapon, in model space.
 *
 * One table, read by both the first-person arms and the third-person fighter, because
 * both hold the *same authored weapon* — a handguard that moves has to move for both,
 * and a tuned constant kept in two places drifts.
 *
 * These are targets to solve an arm towards, not poses. Every support-hand position
 * that was posed by hand missed: the fighter's left hand ended up out in front of him
 * holding nothing while the rifle hung off his right hand alone.
 */
/**
 * Solve where the viewmodel has to sit for the player to be looking down the sights.
 *
 * Given the two sight positions and the weapon's up, both in the viewmodel root's own
 * space, this produces the root's position and orientation such that the line through
 * the sights lies exactly along the camera's axis, with the rear sight `relief` metres
 * in front of the eye. The sights then project to the centre of the screen, which is
 * where the crosshair is, which is where the round goes.
 *
 * It is a solve rather than a table because a table is wrong the moment anything moves.
 * The whole of aiming down sights used to be
 *
 *     const adsPos = new THREE.Vector3(0, -0.148, -0.3);
 *
 * — one offset, every weapon, evidently fitted against the rifle. Every other gun was
 * misaligned by however far its sights sat from the rifle's, and nothing could tell
 * you by how much.
 *
 * `scale` is the viewmodel root's own scale, which the sight positions are expressed
 * before and the camera-space result after.
 */
/**
 * How far the weapon reaches back past its own rear sight, in metres.
 *
 * A rifle is mostly behind its rear sight: the receiver, the grip, and a stock that
 * ends at a shoulder. In first person that shoulder is where the camera is, so aiming
 * to a fixed eye relief buries the butt in the player's face — the rifle's stock ends
 * 26 cm behind its rear sight, so at 30 cm of relief it sat 4 cm from the eye and
 * filled a third of the screen with wood.
 *
 * Measured off the model rather than declared, so it stays true when a weapon is
 * reshaped and a new weapon needs nothing said about it.
 */
function measureTail(group) {
  const rear = group.userData.sightRear;
  const front = group.userData.sightFront;
  if (!rear || !front) return;
  group.updateMatrixWorld(true);
  _f.copy(front.position).sub(rear.position);
  if (_f.lengthSq() < 1e-12) return;
  _f.normalize();
  const box = new THREE.Box3().setFromObject(group);
  let tail = 0;
  for (let i = 0; i < 8; i++) {
    _r.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    tail = Math.min(tail, _r.sub(rear.position).dot(_f));
  }
  group.userData.sightTail = -tail;
}

export function solveSightAlignment(rear, front, up, relief, scale, outPos, outQuat) {
  _f.copy(front).sub(rear);
  if (_f.lengthSq() < 1e-12) return false;
  _f.normalize();
  // An orthonormal frame on the sight line: the weapon's own up only has to be
  // roughly right, since it is squared against the line here. What it decides is the
  // *roll* — without it the minimal rotation onto the camera axis would leave the
  // weapon lying over at whatever angle happened to be shortest.
  _r.crossVectors(_f, up);
  if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0);
  _r.normalize();
  _u.crossVectors(_r, _f);
  // Columns: right, up, back. Maps the sight frame into viewmodel-root space, so its
  // inverse — its transpose, being orthonormal — takes the sight line onto -Z.
  _basis.set(
    _r.x, _u.x, -_f.x,
    _r.y, _u.y, -_f.y,
    _r.z, _u.z, -_f.z,
  );
  _basis.transpose();
  outQuat.setFromRotationMatrix(_m4.setFromMatrix3(_basis));
  // Put the rear sight on the axis at the eye relief.
  outPos.copy(rear).multiplyScalar(scale).applyQuaternion(outQuat).negate();
  outPos.z -= relief;
  return true;
}

/**
 * How far in front of the eye the rear sight sits when aiming, in metres.
 *
 * A look choice, not a correctness one — the solve puts the sights on the axis at
 * whatever distance this says. Bigger numbers hold the weapon further out; the scope
 * comes in close because a scope you cannot see through is not a scope.
 */
/**
 * How far in front of the eye the rear sight sits when aiming, in metres.
 *
 * Close, because close is what makes a sight usable: the notch and post want to be
 * big enough to place on a target. The weapon's tail is *allowed* to end up behind
 * the camera — the near plane is at 5 cm and anything past it is simply not drawn,
 * which is how a stock has always been kept out of a first-person view.
 *
 * Pushing the weapon out until the whole of it cleared the eye was the other way
 * round, and it made things worse: at 39 cm the rifle's stock sat 17 cm away and 22
 * degrees below the axis, which is inside the frame, so a third of the screen filled
 * with wood. `npm run sightcheck` measures how much of the aimed view each weapon
 * eats.
 */
export const ADS_RELIEF = {
  pistol: 0.30,
  smg: 0.25,
  // Short, because the sight radius is enormous — rear notch to bead is two thirds
  // of a metre — and every centimetre of relief pushes that whole length further out
  // in front of the player.
  shotgun: 0.22,
  rifle: 0.24,
  dmr: 0.22,
};

export function adsRelief(id) {
  return ADS_RELIEF[id] ?? 0.26;
}

export const SUPPORT_GRIP = {
  pistol: [0.012, -0.050, 0.075],  // wrapped around the firing hand at the grip
  smg: [0, 0.028, -0.24],
  rifle: [0, 0.036, -0.20],        // near end of the handguard; the far end is out of reach
  dmr: [0, 0.038, -0.21],          // ditto, a DMR handguard is longer than an arm
  shotgun: [0, 0.012, -0.24],      // on the pump
};

const MUZZLE = {
  // Barrel tip per weapon, in model space. Tracers and muzzle flash spawn here, so
  // these have to match the authored geometry; they come straight off the barrel
  // lengths in weapons.py.
  pistol: [0, 0.035, -0.19],
  smg: [0, 0.032, -0.43],
  shotgun: [0, 0.045, -0.66],
  rifle: [0, 0.038, -0.58],
  dmr: [0, 0.040, -0.71],
  knife: [0, 0.010, -0.28],
};

// How far each moving part travels when the weapon is worked, in metres.
//
// Rearward is **+Z**. Barrels point down -Z (see MUZZLE above, all negative), so a
// slide, bolt or pump being worked travels the other way. This was inverted for the
// whole life of the mechanism — the comment here even claimed -Z was rearward — and
// every gun in the game pushed its action *forward* when it cycled.
const CYCLE_TRAVEL = { slide: 0.035, bolt: 0.045, pump: 0.075 };

const weaponAssets = new Map();
let weaponLoad = null;

export function preloadWeapons() {
  if (!weaponLoad) {
    const loader = new GLTFLoader();
    weaponLoad = Promise.all(Object.keys(MUZZLE).map((id) => loader
      .loadAsync(versioned(`/assets/models/${id}.glb`))
      .then((gltf) => {
        bindAuthoredMaterials(gltf.scene);
        weaponAssets.set(id, gltf.scene);
      })
      .catch((err) => {
        // Log *and rethrow*. Swallowing this resolved `assetsReady` with a weapon
        // that does not exist: `buildWeaponModel` returns an empty group when the
        // asset never landed, so a blocked GLB meant a fighter holding an invisible
        // gun and no error anywhere but a console line nobody was watching.
        // Verified by blocking dmr.glb — zero meshes, all benches green.
        console.error(`[weapons] could not load ${id}`, err);
        throw err;
      })));
  }
  return weaponLoad;
}

/**
 * Instance a weapon.
 *
 * Returns immediately with an empty group if the asset has not landed yet and fills
 * it in on arrival, so callers stay synchronous — a fighter can be constructed
 * before the weapon pack has finished streaming.
 */
export function buildWeaponModel(id) {
  const group = new THREE.Group();
  const muzzle = new THREE.Object3D();
  muzzle.position.fromArray(MUZZLE[id] || MUZZLE.pistol);
  group.add(muzzle);
  // Also hung off the group, so anything holding the weapon can find the barrel tip
  // without being handed it separately. Third-person fire used to be drawn from the
  // shooter's *eye* instead, which put tracers half a metre off the gun on average
  // and 1.65 m off at worst — visibly nonsense from the receiving end.
  group.userData.muzzle = muzzle;
  const parts = {};

  const install = (source) => {
    const model = source.clone(true);
    model.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = true;
      // Moving parts keep their authored names so the runtime can find them.
      if (CYCLE_TRAVEL[child.name] !== undefined || child.name === 'mag') {
        parts[child.name] = child;
        child.userData.restZ = child.position.z;
      }
      // So do the sights. Aiming is solved against where they actually are rather
      // than against a per-weapon offset somebody tuned by eye, so they have to
      // survive the export as findable objects. See tools/blender/weapons.py.
      if (child.name === 'lens_ocular' || child.name === 'lens_objective') {
        // Its own material instance, because opacity is animated per weapon and the
        // surface registry hands out one shared material per name.
        child.material = child.material.clone();
        child.material.transparent = true;
        child.material.depthWrite = false;
        (group.userData.lenses ||= []).push(child);
      }
      if (child.name === 'sight_rear' || child.name === 'sight_front') {
        // Reference points, not art: they mark the middle of the notch and the tip of
        // the post, which are places you look *through* and *at*. Never drawn.
        child.visible = false;
        group.userData[child.name === 'sight_rear' ? 'sightRear' : 'sightFront'] = child;
      }
    });
    group.add(model);
    measureTail(group);
  };

  const asset = weaponAssets.get(id);
  if (asset) install(asset);
  // Quiet on rejection: the loader logged it and `assetsReady` carries the failure.
  else preloadWeapons().then(() => { const a = weaponAssets.get(id); if (a) install(a); }, () => {});

  return { group, muzzle, parts };
}

/**
 * Drive a weapon's moving parts.
 *
 * `cycle` is 0..1: 0 is at rest, 1 is fully rearward. `magDrop` is 0..1 and pulls the
 * magazine out of the well for reloads.
 */
export function animateWeaponParts(model, cycle, magDrop = 0, pump = 0) {
  if (!model?.parts) return;
  for (const [name, travel] of Object.entries(CYCLE_TRAVEL)) {
    const part = model.parts[name];
    if (!part) continue;
    // The pump runs off its own stroke, not the recoil impulse: a pump action is a
    // deliberate back-and-forward between shots, not a flinch during one.
    const k = name === 'pump' ? pump : cycle;
    part.position.z = part.userData.restZ + travel * k;
  }
  const mag = model.parts.mag;
  if (mag) {
    mag.position.y = (mag.userData.restY ??= mag.position.y) - magDrop * 0.16;
    mag.visible = magDrop < 0.98;
  }
}

/**
 * First-person viewmodel. Same authored mesh as the world model — a rifle is a
 * rifle — with the muzzle socket the player's ballistics read for tracer origin.
 */
export function buildViewmodel(id) {
  return buildWeaponModel(id);
}

/** World model, held in a fighter's hand socket. */
export function buildHeldGun(id) {
  return buildWeaponModel(id).group;
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _basis = new THREE.Matrix3();
const _m4 = new THREE.Matrix4();

/**
 * What a reload gives you, and what it costs.
 *
 * Ported from DogEater, where the chambered round is the mechanic that makes reload
 * timing a decision rather than a reflex. Reload with rounds still in the magazine and
 * the chambered one stays put: you end at `mag + 1` and pay only the magazine swap.
 * Run dry and there is nothing chambered, so you get `mag` and pay the longer
 * `reloadEmpty` because the bolt has to be sent home too.
 *
 * Pure, because it is the sort of arithmetic that looks obviously right and is off by
 * one: `capacity` differs between the two paths, and the reserve has to be able to
 * short-change either of them.
 *
 * @param {object} w        weapon
 * @param {number} mag      rounds currently in the weapon
 * @param {number} reserve  rounds available in the pack
 * @param {number} mult     reload speed multiplier from progression (lower is faster)
 */
export function planReload(w, mag, reserve, mult = 1) {
  const chambered = mag > 0;
  const capacity = w.mag + (chambered ? 1 : 0);
  const want = Math.max(0, capacity - mag);
  const taken = Math.min(want, Math.max(0, reserve));
  return {
    chambered,
    capacity,
    taken,
    mag: mag + taken,
    duration: (chambered ? w.reload : (w.reloadEmpty ?? w.reload)) * mult,
  };
}
