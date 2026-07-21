import * as THREE from 'three';

// dmg = per bullet torso damage. spread in degrees (hipfire base).
export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 SIDEARM', price: 0, tier: 0,
    dmg: 34, rpm: 280, auto: false, mag: 12, reload: 1.25,
    spread: 1.3, adsSpread: 0.22, recoil: 1.3, pellets: 1,
    aiRange: 15, adsFov: 60, sound: 'pistol',
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

export const WEAPON_ORDER = ['pistol', 'smg', 'shotgun', 'rifle', 'dmr'];

const BASE_MATS = {
  metal: new THREE.MeshLambertMaterial({ color: 0x53535e }),
  metalDark: new THREE.MeshLambertMaterial({ color: 0x35353d }),
  wood: new THREE.MeshLambertMaterial({ color: 0x6b4a32 }),
  grip: new THREE.MeshLambertMaterial({ color: 0x3d3d46 }),
  accent: new THREE.MeshLambertMaterial({ color: 0x5a616c }),
};

// Every gun gets its own material instances. Corpse fade-out mutates material opacity,
// so sharing materials between guns would fade every gun in the arena (including the
// player's viewmodel) each time someone died.
function freshMats() {
  const out = {};
  for (const [k, v] of Object.entries(BASE_MATS)) out[k] = v.clone();
  return out;
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(r, len, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

// Viewmodels: gun pointing down -Z, origin roughly at grip. Returns {group, muzzle}.
export function buildViewmodel(id) {
  const M = freshMats();
  const g = new THREE.Group();
  const muzzle = new THREE.Object3D();

  if (id === 'pistol') {
    g.add(box(0.045, 0.07, 0.24, M.metal, 0, 0.035, -0.06));       // slide
    g.add(box(0.04, 0.055, 0.2, M.metalDark, 0, -0.01, -0.04));    // frame
    g.add(box(0.042, 0.11, 0.055, M.grip, 0, -0.075, 0.045));      // grip
    g.add(cyl(0.011, 0.05, M.metalDark, 0, 0.04, -0.2));           // barrel tip
    muzzle.position.set(0, 0.04, -0.23);
  } else if (id === 'smg') {
    g.add(box(0.05, 0.08, 0.34, M.metal, 0, 0.03, -0.1));
    g.add(box(0.045, 0.16, 0.05, M.metalDark, 0, -0.08, -0.12));   // mag
    g.add(box(0.042, 0.1, 0.055, M.grip, 0, -0.07, 0.05));
    g.add(cyl(0.013, 0.12, M.metalDark, 0, 0.045, -0.32));
    g.add(box(0.03, 0.04, 0.16, M.accent, 0, 0.0, 0.16));          // folded stock
    muzzle.position.set(0, 0.045, -0.39);
  } else if (id === 'shotgun') {
    g.add(cyl(0.02, 0.5, M.metal, 0, 0.05, -0.2));                 // barrel
    g.add(cyl(0.018, 0.34, M.metalDark, 0, 0.005, -0.24));         // tube
    g.add(box(0.05, 0.05, 0.14, M.wood, 0, 0.005, -0.28));         // pump
    g.add(box(0.05, 0.08, 0.16, M.metal, 0, 0.03, 0.03));          // receiver
    g.add(box(0.05, 0.09, 0.2, M.wood, 0, -0.02, 0.16));           // stock
    muzzle.position.set(0, 0.05, -0.46);
  } else if (id === 'rifle') {
    g.add(box(0.05, 0.075, 0.32, M.metal, 0, 0.03, -0.02));        // receiver
    g.add(cyl(0.013, 0.3, M.metalDark, 0, 0.045, -0.32));          // barrel
    g.add(box(0.045, 0.06, 0.16, M.wood, 0, 0.008, -0.24));        // handguard
    const mag = box(0.045, 0.15, 0.06, M.metalDark, 0, -0.075, -0.06); // curved mag (approx)
    mag.rotation.x = 0.25;
    g.add(mag);
    g.add(box(0.042, 0.1, 0.055, M.grip, 0, -0.065, 0.08));
    g.add(box(0.045, 0.08, 0.22, M.wood, 0, 0.0, 0.24));           // stock
    muzzle.position.set(0, 0.045, -0.48);
  } else if (id === 'dmr') {
    g.add(box(0.05, 0.08, 0.4, M.metal, 0, 0.03, -0.06));
    g.add(cyl(0.012, 0.4, M.metalDark, 0, 0.05, -0.45));
    g.add(cyl(0.028, 0.14, M.metalDark, 0, 0.1, 0.0));             // scope
    g.add(box(0.045, 0.12, 0.05, M.metalDark, 0, -0.06, -0.1));    // mag
    g.add(box(0.042, 0.1, 0.055, M.grip, 0, -0.065, 0.08));
    g.add(box(0.05, 0.09, 0.26, M.grip, 0, -0.005, 0.26));         // stock
    muzzle.position.set(0, 0.05, -0.66);
  }

  g.add(muzzle);
  return { group: g, muzzle };
}

// Small held-gun models for AI combatants (simpler, held in right hand area)
export function buildHeldGun(id) {
  const M = freshMats();
  const g = new THREE.Group();
  const len = { pistol: 0.22, smg: 0.35, shotgun: 0.6, rifle: 0.6, dmr: 0.75 }[id] || 0.3;
  g.add(box(0.05, 0.09, len, M.metalDark, 0, 0, -len * 0.3));
  if (id !== 'pistol') g.add(box(0.04, 0.12, 0.05, M.metal, 0, -0.08, -len * 0.15));
  return g;
}
