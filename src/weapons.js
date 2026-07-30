import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bindAuthoredMaterials } from './materials.js';

// dmg = per bullet torso damage. spread in degrees (hipfire base).
export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 SIDEARM', price: 0, tier: 0,
    dmg: 34, rpm: 280, auto: false, mag: 12, reload: 1.25,
    spread: 1.3, adsSpread: 0.22, recoil: 1.3, pellets: 1,
    aiRange: 15, adsFov: 60, sound: 'pistol',
    // When the slide is worked during the reload, as a fraction of the reload's
    // duration. Matches the frames in `anim_reload_pistol` where the support hand is
    // over the top of the weapon — without this the hand mimes a rack the slide never
    // performs, which is what made the reload read as a rifle's.
    slideRack: [0.66, 0.82],
    desc: 'Every contestant starts with one. 3 to the chest or 1 to the skull.',
  },
  smg: {
    id: 'smg', name: 'SKORPION K', price: 650, tier: 1,
    dmg: 15, rpm: 850, auto: true, mag: 32, reload: 1.6,
    spread: 3.1, adsSpread: 1.3, recoil: 0.65, pellets: 1, falloff: 14,
    aiRange: 13, adsFov: 62, sound: 'smg',
    desc: 'A hose of cheap brass. Wild past 12 meters, filthy up close.',
  },
  shotgun: {
    id: 'shotgun', name: 'PIT BOSS 12G', price: 950, tier: 2,
    dmg: 17, rpm: 82, auto: false, mag: 6, reload: 2.4,
    spread: 4.6, adsSpread: 3.0, recoil: 3.2, pellets: 9, falloff: 24,
    aiRange: 8, adsFov: 64, sound: 'shotgun',
    // Pump action, loaded shell by shell. `pump` is the stroke that has to complete
    // between shots; `shellReload` is the time to feed one round, repeated until the
    // tube is full — a shotgun does not swap a magazine.
    pump: 0.42, shellReload: 0.44,
    desc: '9 pellets of crowd-pleasing violence. Deletes torsos inside 10m.',
  },
  rifle: {
    id: 'rifle', name: 'AK VULTURE', price: 1500, tier: 3,
    dmg: 43, rpm: 600, auto: true, mag: 30, reload: 1.9,
    spread: 1.7, adsSpread: 0.4, recoil: 1.5, pellets: 1,
    aiRange: 20, adsFov: 55, sound: 'rifle',
    desc: 'The workhorse of every syndicate in the league. 2–3 rounds does it.',
  },
  dmr: {
    id: 'dmr', name: 'LONGPIG DMR', price: 2500, tier: 4,
    dmg: 82, rpm: 145, auto: false, mag: 10, reload: 2.1,
    spread: 0.9, adsSpread: 0.06, recoil: 2.5, pellets: 1,
    aiRange: 28, adsFov: 34, sound: 'dmr',
    desc: 'One shot, one funeral. Scoped. Slow. Surgical.',
  },
};

// the knife is innate — every fighter carries one, nobody sells it
WEAPONS.knife = {
  id: 'knife', name: 'PIT SHANK', price: 0, tier: -1,
  dmg: 55, rpm: 95, auto: false, mag: 0, reload: 0,
  spread: 0, adsSpread: 0, recoil: 0.6, pellets: 1,
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
      .loadAsync(`/assets/models/${id}.glb`)
      .then((gltf) => {
        bindAuthoredMaterials(gltf.scene);
        weaponAssets.set(id, gltf.scene);
      })
      .catch((err) => console.error(`[weapons] could not load ${id}`, err))));
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
    });
    group.add(model);
  };

  const asset = weaponAssets.get(id);
  if (asset) install(asset);
  else preloadWeapons().then(() => { const a = weaponAssets.get(id); if (a) install(a); });

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
