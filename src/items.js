import { WEAPONS } from './weapons.js';

// ============================================================================
// Unified inventory: everything is an item tile. The stash is a bottomless grid,
// each character carries a limited backpack grid plus worn/held gear slots.
// Item instance: { uid, type, rounds? } — ammo boxes track remaining rounds.
// ============================================================================

export const AMMO_TYPES = {
  '9mm': { name: '9MM', box: 90, price: 55, weight: 0.6, icon: 14 },
  buck: { name: 'BUCK', box: 24, price: 65, weight: 0.9, icon: 15 },
  '762': { name: '7.62', box: 60, price: 95, weight: 1.1, icon: 16 },
  '308': { name: '.308', box: 20, price: 90, weight: 0.8, icon: 17 },
};

// icon = cell index in /assets/icons/items_sheet.png (6 cols × 4 rows)
export const ITEM_TYPES = {
  // guns — stats live in WEAPONS; the pistol feeds on house rounds (infinite ammo)
  pistol: { kind: 'gun', gun: 'pistol', name: 'P9 SIDEARM', w: 1, h: 1, weight: 1.0, price: 60, icon: 0, ammo: null },
  smg: { kind: 'gun', gun: 'smg', name: 'SKORPION K', w: 2, h: 1, weight: 2.2, price: WEAPONS.smg.price, icon: 1, ammo: '9mm' },
  shotgun: { kind: 'gun', gun: 'shotgun', name: 'PIT BOSS 12G', w: 3, h: 1, weight: 3.4, price: WEAPONS.shotgun.price, icon: 2, ammo: 'buck' },
  rifle: { kind: 'gun', gun: 'rifle', name: 'AK VULTURE', w: 3, h: 1, weight: 3.8, price: WEAPONS.rifle.price, icon: 3, ammo: '762' },
  dmr: { kind: 'gun', gun: 'dmr', name: 'LONGPIG DMR', w: 3, h: 1, weight: 4.4, price: WEAPONS.dmr.price, icon: 4, ammo: '308' },

  // armor — slot + mitigation
  helm1: { kind: 'armor', slot: 'head', tier: 1, name: 'STEEL POT', w: 1, h: 1, weight: 1.6, price: 450, icon: 5, mit: 0.35 },
  helm2: { kind: 'armor', slot: 'head', tier: 2, name: 'OPS-CORE RIG', w: 1, h: 1, weight: 1.9, price: 1200, icon: 6, mit: 0.55 },
  vest1: { kind: 'armor', slot: 'body', tier: 1, name: 'STAB VEST', w: 2, h: 2, weight: 3.5, price: 500, icon: 7, mit: 0.3 },
  vest2: { kind: 'armor', slot: 'body', tier: 2, name: 'CERAMIC PLATES', w: 2, h: 2, weight: 7.5, price: 1300, icon: 8, mit: 0.55 },
  pads1: { kind: 'armor', slot: 'limbs', tier: 1, name: 'COMBAT PADS', w: 2, h: 1, weight: 1.8, price: 400, icon: 9, mit: 0.25, accum: 0.45 },
  pads2: { kind: 'armor', slot: 'limbs', tier: 2, name: 'EXO BRACING', w: 2, h: 1, weight: 3.2, price: 950, icon: 10, mit: 0.4, accum: 0.65 },

  // consumables
  medkit: { kind: 'consumable', name: 'MEDKIT', w: 1, h: 1, weight: 0.8, price: 160, icon: 11 },
  splint: { kind: 'consumable', name: 'SPLINT KIT', w: 1, h: 1, weight: 0.4, price: 110, icon: 12 },
  grenade: { kind: 'consumable', name: 'FRAG', w: 1, h: 1, weight: 0.6, price: 90, icon: 13 },

  // ammo boxes
  ammo_9mm: { kind: 'ammo', ammoType: '9mm', name: '9MM ×90', w: 1, h: 1, weight: 0.6, price: 55, icon: 14 },
  ammo_buck: { kind: 'ammo', ammoType: 'buck', name: 'BUCK ×24', w: 1, h: 1, weight: 0.9, price: 65, icon: 15 },
  ammo_762: { kind: 'ammo', ammoType: '762', name: '7.62 ×60', w: 1, h: 1, weight: 1.1, price: 95, icon: 16 },
  ammo_308: { kind: 'ammo', ammoType: '308', name: '.308 ×20', w: 1, h: 1, weight: 0.8, price: 90, icon: 17 },
};

let _uid = 1;
export function makeItem(type) {
  const def = ITEM_TYPES[type];
  const it = { uid: 'i' + (_uid++) + '_' + ((Math.random() * 1e6) | 0), type };
  if (def.kind === 'ammo') it.rounds = AMMO_TYPES[def.ammoType].box;
  return it;
}

export function sellValue(it) {
  const def = ITEM_TYPES[it.type];
  let v = def.price * 0.55;
  if (def.kind === 'ammo') v *= it.rounds / AMMO_TYPES[def.ammoType].box;
  return Math.max(1, Math.round(v));
}

export function itemWeight(it) {
  const def = ITEM_TYPES[it.type];
  if (def.kind === 'ammo') return def.weight * (it.rounds / AMMO_TYPES[def.ammoType].box);
  return def.weight;
}

// ---------------------------------------------------------------- grids
// grid = { cols, rows (0 = grow), items: [{ it, x, y }] }
export const STASH_COLS = 10;
export const PACK_COLS = 4, PACK_ROWS = 3;

export function gridRows(grid) {
  if (grid.rows > 0) return grid.rows;
  let maxY = 3;
  for (const e of grid.items) maxY = Math.max(maxY, e.y + ITEM_TYPES[e.it.type].h);
  return maxY + 2; // always some empty rows to drop into
}

export function canPlace(grid, it, x, y, ignoreEntry = null) {
  const def = ITEM_TYPES[it.type];
  const rows = grid.rows > 0 ? grid.rows : Infinity;
  if (x < 0 || y < 0 || x + def.w > grid.cols || y + def.h > rows) return false;
  for (const e of grid.items) {
    if (e === ignoreEntry || e.it.uid === it.uid) continue;
    const d = ITEM_TYPES[e.it.type];
    if (x < e.x + d.w && x + def.w > e.x && y < e.y + d.h && y + def.h > e.y) return false;
  }
  return true;
}

export function autoPlace(grid, it) {
  const def = ITEM_TYPES[it.type];
  const maxRows = grid.rows > 0 ? grid.rows : gridRows(grid) + def.h + 2;
  for (let y = 0; y < maxRows; y++) {
    for (let x = 0; x <= grid.cols - def.w; x++) {
      if (canPlace(grid, it, x, y)) {
        grid.items.push({ it, x, y });
        return true;
      }
    }
  }
  return false; // only possible for fixed-size grids (packs)
}

export function removeFromGrid(grid, uid) {
  const i = grid.items.findIndex(e => e.it.uid === uid);
  if (i >= 0) return grid.items.splice(i, 1)[0];
  return null;
}

// ---------------------------------------------------------------- characters
// character = { gear: {head, body, limbs, gun1, gun2}, pack: grid }
export function makeCharacter() {
  return {
    gear: { head: null, body: null, limbs: null, gun1: makeItem('pistol'), gun2: null },
    pack: { cols: PACK_COLS, rows: PACK_ROWS, items: [] },
  };
}

export function characterWeight(ch) {
  let w = 0;
  for (const slot of ['head', 'body', 'limbs', 'gun1', 'gun2']) {
    if (ch.gear[slot]) w += itemWeight(ch.gear[slot]);
  }
  for (const e of ch.pack.items) w += itemWeight(e.it);
  return w;
}

// carrying past 10kg starts costing speed, floor at −22%
export function weightSpeedMult(ch) {
  return 1 - Math.min(0.22, Math.max(0, (characterWeight(ch) - 10) * 0.014));
}

export function armorMits(ch) {
  const g = ch.gear;
  return {
    head: g.head ? ITEM_TYPES[g.head.type].mit : 0,
    body: g.body ? ITEM_TYPES[g.body.type].mit : 0,
    limbs: g.limbs ? ITEM_TYPES[g.limbs.type].mit : 0,
    limbAccum: g.limbs ? (ITEM_TYPES[g.limbs.type].accum || 0) : 0,
  };
}

export function countInPack(ch, type) {
  return ch.pack.items.filter(e => e.it.type === type).length;
}

export function useFromPack(ch, type) {
  const e = ch.pack.items.find(e => e.it.type === type);
  if (!e) return false;
  removeFromGrid(ch.pack, e.it.uid);
  return true;
}

export function ammoInPack(ch, ammoType) {
  let n = 0;
  for (const e of ch.pack.items) {
    const def = ITEM_TYPES[e.it.type];
    if (def.kind === 'ammo' && def.ammoType === ammoType) n += e.it.rounds;
  }
  return n;
}

export function consumeAmmo(ch, ammoType, n) {
  let left = n;
  for (const e of [...ch.pack.items]) {
    if (left <= 0) break;
    const def = ITEM_TYPES[e.it.type];
    if (def.kind !== 'ammo' || def.ammoType !== ammoType) continue;
    const take = Math.min(left, e.it.rounds);
    e.it.rounds -= take;
    left -= take;
    if (e.it.rounds <= 0) removeFromGrid(ch.pack, e.it.uid);
  }
  return n - left;
}

// what guns can this character actually feed?
export function bestUsableGun(ch) {
  const usable = [];
  for (const slot of ['gun1', 'gun2']) {
    const g = ch.gear[slot];
    if (!g) continue;
    const def = ITEM_TYPES[g.type];
    if (!def.ammo || ammoInPack(ch, def.ammo) > 0) usable.push(def.gun);
  }
  if (!usable.length) return 'pistol'; // house loaner — nobody enters the pit unarmed
  usable.sort((a, b) => WEAPONS[b].tier - WEAPONS[a].tier);
  return usable[0];
}
