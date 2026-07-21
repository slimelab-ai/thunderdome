import * as THREE from 'three';
import { buildArena, updateArenaAmbience, ARENA } from './arena.js';
import { FX } from './fx.js';
import { Player } from './player.js';
import { Combatant } from './combatant.js';
import { Announcer } from './announcer.js';
import { UI, ARMOR_SLOTS, CONSUMABLES, CREW_TIERS, TRAINING, nextCrewName } from './ui.js';
import { WEAPONS } from './weapons.js';
import { audio } from './audio.js';
import { NavMesh } from './nav.js';

// ============================================================ setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050507);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
scene.add(camera);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const arena = buildArena(scene);
const fx = new FX(scene);
const ui = new UI();
const announcer = new Announcer();

// ============================================================ world
const world = {
  scene,
  colliders: arena.colliders,
  combatants: [],
  hitMeshes: [],
  zones: [],
  fx,
  cameraPos: camera.position,
  enemyDmgScale: 0.85,
  playerProxy: { isPlayer: true, team: 'player', alive: true, pos: new THREE.Vector3(), heightScale: 1, name: 'YOU' },
  playerAim: new THREE.Vector3(0, 0, -1),
  playerShooter: { isPlayer: true, team: 'player', name: 'YOU' },
  onPlayerDamaged: (dmg, part, fromPos) => handlePlayerDamaged(dmg, part, fromPos),
  onKill: (killer, victim, part) => handleKill(killer, victim, part),
  onHitmarker: (kill, headshot) => ui.hitmarker(kill, headshot),
};

world.nav = new NavMesh(arena.colliders);

const player = new Player(camera, world);

// ============================================================ career / save
const SAVE_KEY = 'thunderdome-save-v1';
let career;

function newCareer() {
  return {
    money: 0, rank: 10,
    weapons: ['pistol'],
    armor: { head: 0, body: 0, limbs: 0 },
    stash: { head: [], body: [], limbs: [] },   // hand-me-down armor pieces
    consumables: { medkit: 1, splint: 1, grenade: 2 },
    skills: { aim: 0, cardio: 0, tough: 0 },
    crew: [],
    totals: { kills: 0, headshots: 0, deaths: 0, earned: 0, crewLost: 0 },
  };
}
function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(career)); } catch { /* private mode */ } }
function load() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    if (s) {
      const c = JSON.parse(s);
      if (c && c.rank >= 1) {
        // migrate older saves
        if (c.armor === undefined) c.armor = { head: 0, body: c.armorTier || 0, limbs: 0 };
        if (c.consumables === undefined) c.consumables = { medkit: 1, splint: 1, grenade: 2 };
        if (c.stash === undefined) c.stash = { head: [], body: [], limbs: [] };
        for (const m of c.crew || []) if (!m.gear) m.gear = { head: 0, body: 0, limbs: 0, medkit: 0, grenade: 0 };
        return c;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ============================================================ squads
const NAMES = ['Vik', 'Sasha', 'Grim', 'Pyotr', 'Knuckles', 'Ratface', 'Chains', 'Weasel', 'Hex', 'Bruno', 'Tusk', 'Cobra', 'Sable', 'Juba', 'Ferret', 'Mongoose', 'Tiny', 'Blade', 'Smiler', 'Curtains', 'Ivan', 'Patch', 'Gravel', 'Two-Step'];
function squadNames(n) {
  const pool = [...NAMES].sort(() => Math.random() - 0.5);
  return pool.slice(0, n);
}

const SQUADS = {
  10: { name: 'THE GUTTER RATS', shirt: 0x5a4632, blurb: 'Sewer scavengers with stolen pistols. Your warm-up act. Try not to embarrass the house.', roster: [{ w: 'pistol', hp: 75, sp: 2.9, re: 1.15 }, { w: 'pistol', hp: 75, sp: 2.9, re: 1.15 }] },
  9: { name: 'THE RUST DOGS', shirt: 0x6e3b28, blurb: 'Junkyard enforcers. Three of them, all mean, none smart.', roster: [{ w: 'pistol', hp: 82, sp: 2.5, re: 1.0 }, { w: 'pistol', hp: 82, sp: 2.5, re: 1.0 }, { w: 'pistol', hp: 82, sp: 2.5, re: 1.0 }] },
  8: { name: 'THE JACKALS', shirt: 0x7a6a2a, blurb: 'Street crew that graduated to automatic weapons last month. The SMG is new. The malice is not.', roster: [{ w: 'smg', hp: 88, sp: 1.9, re: 0.8 }, { w: 'pistol', hp: 88, sp: 1.9, re: 0.8 }, { w: 'pistol', hp: 88, sp: 1.9, re: 0.8 }] },
  7: { name: 'BLACKLINE PMC', shirt: 0x22262e, blurb: 'Washed-out private military contractors. Disciplined bursts, matching uniforms, dead eyes.', roster: [{ w: 'smg', hp: 95, sp: 1.65, re: 0.7 }, { w: 'smg', hp: 95, sp: 1.65, re: 0.7 }, { w: 'smg', hp: 95, sp: 1.65, re: 0.7 }] },
  6: { name: 'THE VIPER BOYS', shirt: 0x1e4d2b, blurb: 'Four brothers, one shotgun, zero impulse control. They will rush you.', roster: [{ w: 'shotgun', hp: 105, sp: 1.6, re: 0.65 }, { w: 'smg', hp: 100, sp: 1.6, re: 0.65 }, { w: 'smg', hp: 100, sp: 1.6, re: 0.65 }, { w: 'pistol', hp: 100, sp: 1.6, re: 0.65 }] },
  5: { name: 'IRON PACK', shirt: 0x3a3f4a, blurb: 'Ex-dockworkers turned killers. First crew on the ladder with body armor. Aim for the legs and laugh.', roster: [{ w: 'rifle', hp: 110, sp: 1.4, re: 0.6, ar: 0.25 }, { w: 'shotgun', hp: 110, sp: 1.4, re: 0.6, ar: 0.25 }, { w: 'smg', hp: 105, sp: 1.5, re: 0.6 }, { w: 'smg', hp: 105, sp: 1.5, re: 0.6 }] },
  4: { name: 'THE HOUNDS OF VRY', shirt: 0x4a1f24, blurb: 'A cult that worships violence. Rifles, armor, and unsettling chanting.', roster: [{ w: 'rifle', hp: 120, sp: 1.2, re: 0.55, ar: 0.25 }, { w: 'rifle', hp: 120, sp: 1.2, re: 0.55, ar: 0.25 }, { w: 'smg', hp: 115, sp: 1.3, re: 0.55 }, { w: 'shotgun', hp: 115, sp: 1.3, re: 0.55, ar: 0.25 }] },
  3: { name: 'CARTEL SICARIOS', shirt: 0x1a1a1a, blurb: 'Professional hitmen moonlighting for sport. Five guns, no wasted movement.', roster: [{ w: 'rifle', hp: 125, sp: 1.05, re: 0.5, ar: 0.3 }, { w: 'rifle', hp: 125, sp: 1.05, re: 0.5, ar: 0.3 }, { w: 'smg', hp: 120, sp: 1.1, re: 0.5 }, { w: 'smg', hp: 120, sp: 1.1, re: 0.5 }, { w: 'shotgun', hp: 120, sp: 1.1, re: 0.5, ar: 0.3 }] },
  2: { name: 'GHOST SECTION', shirt: 0x2a2f3a, blurb: 'Former special forces. The bookies stopped taking bets against them two seasons ago.', roster: [{ w: 'rifle', hp: 135, sp: 0.95, re: 0.42, ar: 0.4 }, { w: 'rifle', hp: 135, sp: 0.95, re: 0.42, ar: 0.4 }, { w: 'dmr', hp: 130, sp: 0.9, re: 0.42, ar: 0.4 }, { w: 'smg', hp: 130, sp: 1.0, re: 0.42, ar: 0.4 }, { w: 'rifle', hp: 135, sp: 0.95, re: 0.42, ar: 0.4 }] },
  1: { name: "DEATH'S HEAD SYNDICATE", shirt: 0x111114, blurb: 'The champion GOLIATH and his honor guard. Thirty-one bouts. Thirty-one closed caskets. Yours is pre-ordered.', roster: [{ w: 'rifle', hp: 650, sp: 0.85, re: 0.4, ar: 0.5, boss: true, name: 'GOLIATH', scale: 1.32 }, { w: 'rifle', hp: 140, sp: 0.9, re: 0.4, ar: 0.4 }, { w: 'dmr', hp: 135, sp: 0.85, re: 0.4, ar: 0.4 }, { w: 'shotgun', hp: 140, sp: 0.9, re: 0.4, ar: 0.4 }] },
};

const DEATH_LINES = [
  'The crowd files out. The mop comes in.',
  'Your odds tomorrow just got a lot worse.',
  'Somewhere, a bookie just bought a boat with your blood money.',
  'The tournament master sends his condolences. He does not mean them.',
];

// ============================================================ match state
let phase = 'menu'; // menu | intro | match | shop | dead | champion
let locked = false;
let match = null;

function makeMatch() {
  return {
    crew: [], enemies: [],
    frenzy: false, frenzyT: 0,
    firstBlood: false, ended: false, endTimer: 0, won: false,
    kills: 0, headshots: 0, killMoney: 0, hsMoney: 0, frenzyMoney: 0,
    eventTimer: 12 + Math.random() * 10, eventsFired: 0,
    lightsOut: 0, airdrop: null,
    enemiesAlive: 0,
    time: 0,
    campAnchor: { x: 0, z: 0 }, campT: 0, campWarned: false,
  };
}

function clearCombatants() {
  for (const c of [...world.combatants]) c.removeFrom(world);
  world.combatants.length = 0;
  world.hitMeshes.length = 0;
  for (const z of world.zones) removeZoneVisual(z);
  world.zones.length = 0;
  if (match?.airdrop?.mesh) scene.remove(match.airdrop.mesh);
  if (world.grenades) {
    for (const g of world.grenades) scene.remove(g.mesh);
    world.grenades.length = 0;
  }
}

function startMatch() {
  clearCombatants();
  match = makeMatch();
  const squad = SQUADS[career.rank];

  // spawn crew
  const aliveCrew = career.crew.filter(c => c.alive);
  aliveCrew.forEach((cm, i) => {
    const t = CREW_TIERS[cm.tier];
    if (!cm.gear) cm.gear = { head: 0, body: 0, limbs: 0, medkit: 0, grenade: 0 };
    const c = new Combatant({
      name: cm.name, team: 'player', weaponId: t.weapon,
      skill: { spreadMult: t.spreadMult, reaction: t.reaction, speedMult: t.speedMult },
      hp: t.hp, shirt: 0x2e5d33,
      armorParts: {
        head: ARMOR_SLOTS.head.tiers[cm.gear.head].mit,
        body: ARMOR_SLOTS.body.tiers[cm.gear.body].mit,
        limbs: ARMOR_SLOTS.limbs.tiers[cm.gear.limbs].mit,
      },
    });
    c.careerRef = cm;
    c.healKits = (cm.tier === 'elite' ? 2 : 1) + cm.gear.medkit;
    c.nades = (cm.tier === 'rookie' ? 0 : 1) + cm.gear.grenade;
    c.baseKits = cm.tier === 'elite' ? 2 : 1;
    c.baseNades = cm.tier === 'rookie' ? 0 : 1;
    c.addTo(world, arena.spawns.playerCrew[i % arena.spawns.playerCrew.length]);
    match.crew.push(c);
  });

  // spawn enemies
  const names = squadNames(squad.roster.length);
  squad.roster.forEach((r, i) => {
    const c = new Combatant({
      name: r.name || names[i], team: 'enemy', weaponId: r.w,
      skill: { spreadMult: r.sp, reaction: r.re, speedMult: 1 + (10 - career.rank) * 0.012 },
      hp: r.hp, shirt: squad.shirt, armor: r.ar || 0, boss: r.boss, scale: r.scale,
    });
    // higher-league fighters carry supplies
    c.nades = career.rank <= 3 ? 2 : career.rank <= 7 ? 1 : 0;
    c.healKits = career.rank <= 6 ? 1 : 0;
    if (r.boss) { c.nades = 2; c.healKits = 2; }
    c.addTo(world, arena.spawns.enemy[i % arena.spawns.enemy.length]);
    match.enemies.push(c);
  });
  match.enemiesAlive = match.enemies.length;

  // reset player
  player.slots = [...career.weapons];
  if (player.slotIdx >= player.slots.length) player.slotIdx = player.slots.length - 1;
  player._mountViewmodel();
  player.skills = career.skills;
  player.armor = {
    head: ARMOR_SLOTS.head.tiers[career.armor.head].mit,
    body: ARMOR_SLOTS.body.tiers[career.armor.body].mit,
    limbs: ARMOR_SLOTS.limbs.tiers[career.armor.limbs].mit,
    limbAccum: ARMOR_SLOTS.limbs.tiers[career.armor.limbs].accum || 0,
  };
  player.consumables = career.consumables;
  player.resetForMatch(arena.spawns.player);

  match.campAnchor.x = player.pos.x;
  match.campAnchor.z = player.pos.z;

  announcer.clear();
  announcer.say('matchStart', {}, { force: true });
  if (career.rank === 1) setTimeout(() => announcer.say('bossIntro', {}, { force: true }), 3000);
  audio.setCrowdLevel(0.055 + (10 - career.rank) * 0.004);
  audio.klaxon();

  phase = 'match';
  ui.showHUDOnly();
  enterCombatMode();
}

// ============================================================ kills / damage
function payout(base) {
  const mult = match.frenzy ? 2 : 1;
  const amt = base * mult;
  if (match.frenzy) match.frenzyMoney += base;
  career.money += amt;
  career.totals.earned += amt;
  return amt;
}

function handleKill(killer, victim, part) {
  const headshot = part === 'head';
  const killerName = killer.isPlayer ? 'YOU' : killer.name;
  ui.killfeed(killerName, victim.name, headshot, killer.team === 'player');
  audio.crowdRoar(headshot ? 1 : 0.6);

  if (!match.firstBlood) {
    match.firstBlood = true;
    announcer.say('firstBlood', {}, { force: true });
  }

  if (victim.team === 'enemy') {
    match.enemiesAlive--;
    match.kills++;
    if (headshot) match.headshots++;

    const base = 150 + (10 - career.rank) * 25;
    if (killer.isPlayer) {
      player.stats.matchKills++;
      career.totals.kills++;
      if (headshot) { player.stats.matchHeadshots++; career.totals.headshots++; }
      const amt = payout(base + (headshot ? 100 : 0));
      match.killMoney += base;
      if (headshot) match.hsMoney += 100;
      ui.moneyPop(amt);
      audio.cashRegister();
      player.hp = Math.min(player.maxHp, player.hp + 12); // adrenaline
      if (headshot) announcer.say('playerHeadshot', { victim: victim.name });
      else announcer.say('playerKill', { victim: victim.name });
    } else {
      const amt = payout(Math.round(base * 0.5));
      match.killMoney += Math.round(base * 0.5);
      ui.moneyPop(amt);
      if (killer.careerRef) killer.careerRef.kills = (killer.careerRef.kills || 0) + 1;
      announcer.say('allyKill', { killer: killer.name, victim: victim.name });
    }

    if (match.enemiesAlive === 1) announcer.say('lastEnemy', {}, { minGap: 30 });
    if (match.enemiesAlive <= 0 && !match.ended) {
      match.ended = true; match.won = true; match.endTimer = 2.0;
      announcer.say(victim.boss ? 'champWin' : 'win', {}, { force: true });
      audio.crowdRoar(1); audio.crowdRoar(1);
    }
  } else {
    // crew member died — scavenge their gear back
    if (victim.careerRef) {
      victim.careerRef.alive = false;
      career.totals.crewLost++;
      const gear = victim.careerRef.gear;
      if (gear) {
        for (const slot of ['head', 'body', 'limbs']) {
          if (gear[slot] > 0) { career.stash[slot].push(gear[slot]); gear[slot] = 0; }
        }
        // unused given supplies come back — they burn their OWN stock first, so
        // whatever remains counts as yours up to what you handed over
        career.consumables.medkit += Math.max(0, Math.min(gear.medkit, victim.healKits));
        career.consumables.grenade += Math.max(0, Math.min(gear.grenade, victim.nades));
        gear.medkit = 0; gear.grenade = 0;
      }
    }
    announcer.say('enemyKillsAlly', { killer: killerName, victim: victim.name });
  }
}

function handlePlayerDamaged(dmg, part, fromPos) {
  if (!player.alive) return;
  player.takeDamage(dmg, part, fromPos);
  ui.damageFlash();
  fx.blood(new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z));
  audio.crowdRoar(0.25);

  if (player.alive) {
    if (part === 'armL' || part === 'armR') announcer.say('playerArmHit', {}, { minGap: 8 });
    else if (part === 'legL' || part === 'legR') announcer.say('playerLegHit', {}, { minGap: 8 });
    else if (player.hp < 30) announcer.say('playerLow', {}, { minGap: 10 });
    else announcer.say('playerHurt', {}, { minGap: 9 });
  } else if (!match.ended) {
    match.ended = true; match.won = false; match.endTimer = 2.2;
    announcer.say('lose', {}, { force: true });
    career.totals.deaths++;
    audio.crowdRoar(1);
  }
}

// ============================================================ grenades
import { hasLoS } from './combat.js';

const NADE_GEO = new THREE.SphereGeometry(0.09, 8, 6);
const NADE_MAT = new THREE.MeshLambertMaterial({ color: 0x2c3a2c });

world.grenades = [];
world.throwGrenade = (origin, vel, thrower) => {
  const mesh = new THREE.Mesh(NADE_GEO, NADE_MAT);
  mesh.position.copy(origin);
  scene.add(mesh);
  world.grenades.push({ pos: origin.clone(), vel: vel.clone(), fuse: 2.8, mesh, thrower });
  audio.reload(0);
  announcer.say('nade', {}, { minGap: 14 });
};

function explode(pos, thrower) {
  const R = 7, MAX = 165, MIN = 25;
  audio.explosion(1.2 / (1 + pos.distanceTo(camera.position) * 0.05));
  fx.explosion(pos);
  audio.crowdRoar(0.8);

  const blast = new THREE.Vector3(pos.x, pos.y + 0.3, pos.z);
  // full cover means full cover — no shrapnel through solid walls
  const dmgAt = (d, occluded) => occluded ? 0 : Math.max(0, MAX - (MAX - MIN) * (d / R));

  // player
  if (player.alive) {
    const chest = new THREE.Vector3(player.pos.x, player.pos.y + 1.1, player.pos.z);
    const d = chest.distanceTo(blast);
    if (d < R) {
      const occ = !hasLoS(world.colliders, blast, chest);
      const pdmg = dmgAt(d, occ);
      if (pdmg > 0) handlePlayerDamaged(pdmg / 0.8, 'torso', pos); // undo grit for env-scale
      // shrapnel chews limbs
      if (!occ && d < R * 0.6) {
        player.armDmg = Math.min(1, player.armDmg + 0.3 * (1 - player.armor.limbAccum));
        player.legDmg = Math.min(1, player.legDmg + 0.3 * (1 - player.armor.limbAccum));
      }
      player.shakeT = 0.5;
    } else if (d < R * 2.2) {
      player.shakeT = 0.3;
    }
  }
  // combatants
  for (const c of [...world.combatants]) {
    if (!c.alive) continue;
    const chest = c.aimPoint();
    const d = chest.distanceTo(blast);
    if (d < R) {
      const occ = !hasLoS(world.colliders, blast, chest);
      const dmg = dmgAt(d, occ);
      if (dmg > 1) {
        if (!occ && d < R * 0.6) { c.armDmg = Math.min(1, c.armDmg + 0.35); c.legDmg = Math.min(1, c.legDmg + 0.35); }
        c.applyDamage(world, 'torso', dmg, thrower, chest);
      }
    }
  }
}

function updateGrenades(dt) {
  for (let i = world.grenades.length - 1; i >= 0; i--) {
    const g = world.grenades[i];
    g.fuse -= dt;
    g.vel.y -= 13 * dt;
    const prevX = g.pos.x, prevZ = g.pos.z;
    g.pos.addScaledVector(g.vel, dt);

    // floor + box-top bounces
    let floorY = 0;
    for (const box of world.colliders) {
      if (box.max.y <= 3 && box.containsXZ(g.pos.x, g.pos.z, 0.09) && g.pos.y > box.max.y - 0.2) {
        floorY = Math.max(floorY, box.max.y);
      }
    }
    if (g.pos.y < floorY + 0.09 && g.vel.y < 0) {
      g.pos.y = floorY + 0.09;
      g.vel.y *= -0.36;
      g.vel.x *= 0.72; g.vel.z *= 0.72;
      if (Math.abs(g.vel.y) < 0.6) g.vel.y = 0;
      audio.ricochet();
    }
    // wall bounces: entered a box side → back out and reflect horizontally
    for (const box of world.colliders) {
      if (g.pos.y > box.max.y || g.pos.y < box.min.y) continue;
      if (box.containsXZ(g.pos.x, g.pos.z, 0.09) && !box.containsXZ(prevX, prevZ, 0.09)) {
        const p = { x: g.pos.x, z: g.pos.z };
        box.pushCircleXZ(p, 0.12);
        const nx = p.x - g.pos.x, nz = p.z - g.pos.z;
        const nl = Math.hypot(nx, nz) || 1;
        const dot = (g.vel.x * nx + g.vel.z * nz) / nl;
        g.vel.x -= 2 * dot * (nx / nl); g.vel.z -= 2 * dot * (nz / nl);
        g.vel.x *= 0.5; g.vel.z *= 0.5;
        g.pos.x = p.x; g.pos.z = p.z;
        audio.ricochet();
        break;
      }
    }

    g.mesh.position.copy(g.pos);
    if (g.fuse <= 0) {
      scene.remove(g.mesh);
      world.grenades.splice(i, 1);
      explode(g.pos, g.thrower);
    }
  }
}

// ============================================================ events (tournament master)
function removeZoneVisual(z) {
  if (z.mesh) scene.remove(z.mesh);
  if (z.light) scene.remove(z.light);
}

function spawnZone(type, x, z, r, ttl, dps) {
  const isGas = type === 'gas';
  const color = isGas ? 0x39b32a : 0xff6a1a;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, isGas ? 2.6 : 0.5, 20, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
  );
  mesh.position.set(x, isGas ? 1.3 : 0.25, z);
  const light = new THREE.PointLight(color, isGas ? 25 : 40, r * 3.5, 1.6);
  light.position.set(x, 1.2, z);
  scene.add(mesh, light);
  world.zones.push({ type, x, z, r, ttl, dps, mesh, light });
}

function randomFloorSpot(margin = 5) {
  return {
    x: (Math.random() - 0.5) * (ARENA.W - margin * 2),
    z: (Math.random() - 0.5) * (ARENA.D - margin * 2),
  };
}

const EVENTS = ['lightsout', 'gas', 'frenzy', 'airdrop', 'molotov'];
function fireEvent() {
  const ev = EVENTS[(Math.random() * EVENTS.length) | 0];
  audio.klaxon();
  if (ev === 'lightsout') {
    match.lightsOut = 11;
    ui.eventBanner('LIGHTS OUT', 'Someone cut the power. How unfortunate.');
    announcer.say('event_lightsout', {}, { force: true });
  } else if (ev === 'gas') {
    const s = randomFloorSpot(8);
    spawnZone('gas', s.x, s.z, 5.5, 18, 8);
    ui.eventBanner('GAS LEAK', 'Stay out of the green cloud', '#86ff3c');
    announcer.say('event_gas', {}, { force: true });
  } else if (ev === 'frenzy') {
    match.frenzy = true; match.frenzyT = 20;
    ui.eventBanner('CROWD FRENZY', 'Double payout on all kills', 'var(--gold)');
    announcer.say('event_frenzy', {}, { force: true });
    audio.crowdRoar(1);
  } else if (ev === 'airdrop') {
    const s = randomFloorSpot(9);
    const mesh = new THREE.Group();
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x8a6d2f }));
    crate.position.y = 0.5;
    const beacon = new THREE.PointLight(0xffb92e, 50, 14, 1.4);
    beacon.position.y = 1.6;
    mesh.add(crate, beacon);
    mesh.position.set(s.x, 14, s.z);
    scene.add(mesh);
    match.airdrop = { mesh, beacon, x: s.x, z: s.z, landed: false, ttl: 30 };
    ui.eventBanner('CARE PACKAGE', 'Full patch-up + cash for whoever grabs it', 'var(--gold)');
    announcer.say('event_airdrop', {}, { force: true });
  } else if (ev === 'molotov') {
    for (let i = 0; i < 3; i++) {
      const s = randomFloorSpot(6);
      spawnZone('fire', s.x, s.z, 2.6, 13, 16);
    }
    ui.eventBanner('MOLOTOV RAIN', 'The cheap seats are feeling generous');
    announcer.say('event_molotov', {}, { force: true });
  }
}

function updateEvents(dt) {
  // scheduler
  if (!match.ended && match.eventsFired < 3) {
    match.eventTimer -= dt;
    if (match.eventTimer <= 0) {
      match.eventsFired++;
      match.eventTimer = 24 + Math.random() * 14;
      fireEvent();
    }
  }

  // lights out
  const targetFactor = match.lightsOut > 0 ? 0.05 : 1;
  world._lightFactor = world._lightFactor ?? 1;
  world._lightFactor += (targetFactor - world._lightFactor) * Math.min(1, dt * 3);
  for (const l of arena.lights) l.light.intensity = l.base * world._lightFactor;
  if (match.lightsOut > 0) {
    match.lightsOut -= dt;
    arena.strobe.intensity = (Math.sin(match.time * 9) > 0.4) ? 90 : 0;
    if (match.lightsOut <= 0) arena.strobe.intensity = 0;
  }

  // frenzy
  if (match.frenzy) {
    match.frenzyT -= dt;
    if (match.frenzyT <= 0) match.frenzy = false;
  }

  // zones: damage + particles + expiry
  for (let i = world.zones.length - 1; i >= 0; i--) {
    const z = world.zones[i];
    z.ttl -= dt;
    if (Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * z.r;
      const p = new THREE.Vector3(z.x + Math.cos(a) * rr, 0.3, z.z + Math.sin(a) * rr);
      if (z.type === 'gas') fx.gasPuff(p); else fx.fireEmber(p);
    }
    z.mesh.material.opacity = 0.1 + Math.sin(match.time * 3) * 0.04 + (z.ttl < 2 ? -(2 - z.ttl) * 0.05 : 0);

    // damage player (throttle the feedback, not the damage)
    const pdx = player.pos.x - z.x, pdz = player.pos.z - z.z;
    if (player.alive && pdx * pdx + pdz * pdz < z.r * z.r) {
      player.hp -= z.dps * dt;
      z._flash = (z._flash || 0) - dt;
      if (z._flash <= 0) { z._flash = 0.7; ui.damageFlash(); audio.hurt(); }
      if (player.hp <= 0) {
        player.hp = 0; player.alive = false; player.deathT = 0;
        if (!match.ended) {
          match.ended = true; match.won = false; match.endTimer = 2.2;
          announcer.say('lose', {}, { force: true });
          career.totals.deaths++;
        }
      }
    }
    // damage AI
    for (const c of world.combatants) {
      if (!c.alive) continue;
      const dx = c.pos.x - z.x, dz = c.pos.z - z.z;
      if (dx * dx + dz * dz < z.r * z.r) {
        c.hp -= z.dps * dt;
        if (c.hp <= 0) c.die(world, { isPlayer: false, team: 'none', name: z.type === 'gas' ? 'THE GAS' : 'THE FIRE' }, 'torso');
      }
    }
    if (z.ttl <= 0) { removeZoneVisual(z); world.zones.splice(i, 1); }
  }

  // airdrop
  const ad = match.airdrop;
  if (ad) {
    ad.ttl -= dt;
    if (!ad.landed) {
      ad.mesh.position.y -= dt * 5;
      if (ad.mesh.position.y <= 0) { ad.mesh.position.y = 0; ad.landed = true; audio.drop(); }
    } else {
      ad.mesh.rotation.y += dt * 1.2;
      ad.beacon.intensity = 35 + Math.sin(match.time * 6) * 20;
      const dx = player.pos.x - ad.x, dz = player.pos.z - ad.z;
      if (player.alive && dx * dx + dz * dz < 2.2 * 2.2) {
        // claim
        player.hp = player.maxHp;
        player.healLimbs();
        player.mag = player.weapon.mag;
        const amt = payout(250);
        ui.moneyPop(amt);
        audio.cashRegister();
        ui.eventBanner('PACKAGE CLAIMED', 'Full patch-up. Back to work.', '#86ff3c');
        scene.remove(ad.mesh);
        match.airdrop = null;
      }
    }
    if (match.airdrop && ad.ttl <= 0) { scene.remove(ad.mesh); match.airdrop = null; }
  }
}

// ============================================================ match end
function finishMatch() {
  document.exitPointerLock();
  // survivors' given supplies reflect what they actually used (own stock burns first)
  for (const c of match.crew) {
    if (c.alive && c.careerRef?.gear) {
      c.careerRef.gear.medkit = Math.max(0, Math.min(c.careerRef.gear.medkit, c.healKits));
      c.careerRef.gear.grenade = Math.max(0, Math.min(c.careerRef.gear.grenade, c.nades));
    }
  }
  clearCombatants();

  if (match.won) {
    const winBonus = 400 + (10 - career.rank) * 150;
    career.money += winBonus;
    career.totals.earned += winBonus;
    const earnings = {
      kills: match.kills, headshots: match.headshots,
      killMoney: match.killMoney, hsMoney: match.hsMoney,
      frenzyMoney: match.frenzyMoney, winBonus,
      total: match.killMoney + match.hsMoney + match.frenzyMoney + winBonus,
    };
    audio.cashRegister();

    if (career.rank === 1) {
      phase = 'champion';
      ui.renderChampion(
        `Career kills: <b>${career.totals.kills}</b> (${career.totals.headshots} headshots)<br>` +
        `Total blood money earned: <b style="color:var(--gold)">$${career.totals.earned.toLocaleString()}</b><br>` +
        `Times carried out on a stretcher: <b>${career.totals.deaths}</b><br>` +
        `Crew members buried: <b>${career.totals.crewLost}</b>`
      );
      ui.showScreen('champion');
      localStorage.removeItem(SAVE_KEY);
      return;
    }

    career.rank--;
    save();
    openShop(earnings);
  } else {
    // death: house takes a cut
    const cut = Math.min(career.money, Math.max(50, Math.round(career.money * 0.15)));
    career.money -= cut;
    save();
    phase = 'dead';
    ui.renderDeath(
      DEATH_LINES[(Math.random() * DEATH_LINES.length) | 0],
      `The house took its cut: <b style="color:var(--blood)">−$${cut}</b><br>` +
      `Kills this bout: ${match.kills} · Career deaths: ${career.totals.deaths}`
    );
    ui.showScreen('death');
  }
}

function openShop(earnings = null) {
  phase = 'shop';
  ui.showScreen('shop');
  renderShop(earnings);
}

function renderShop(earnings) {
  ui.renderShop(career, player, SQUADS[career.rank], earnings, {
    buyWeapon: (id) => {
      const w = WEAPONS[id];
      if (career.money >= w.price && !career.weapons.includes(id)) {
        career.money -= w.price;
        career.weapons.push(id);
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
    buyArmor: (slot, tier) => {
      const t = ARMOR_SLOTS[slot]?.tiers[tier];
      if (t && career.money >= t.price && career.armor[slot] === tier - 1) {
        career.money -= t.price;
        if (career.armor[slot] > 0) career.stash[slot].push(career.armor[slot]); // hand-me-down
        career.armor[slot] = tier;
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
    outfit: (idx) => {
      const m = career.crew[idx];
      if (!m || !m.alive) return;
      for (const slot of ['head', 'body', 'limbs']) {
        const best = Math.max(0, ...career.stash[slot]);
        if (best > m.gear[slot]) {
          career.stash[slot].splice(career.stash[slot].indexOf(best), 1);
          if (m.gear[slot] > 0) career.stash[slot].push(m.gear[slot]);
          m.gear[slot] = best;
        }
      }
      audio.uiClick(); save(); renderShop(earnings);
    },
    giveItem: (idx, kind) => {
      const m = career.crew[idx];
      if (!m || !m.alive) return;
      if ((career.consumables[kind] || 0) > 0 && (m.gear[kind] || 0) < 2) {
        career.consumables[kind]--;
        m.gear[kind] = (m.gear[kind] || 0) + 1;
        audio.uiClick(); save(); renderShop(earnings);
      }
    },
    buyConsumable: (id) => {
      const c = CONSUMABLES[id];
      if (c && career.money >= c.price && (career.consumables[id] || 0) < c.max) {
        career.money -= c.price;
        career.consumables[id] = (career.consumables[id] || 0) + 1;
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
    hire: (tierId) => {
      const t = CREW_TIERS[tierId];
      if (career.money >= t.price && career.crew.filter(c => c.alive).length < 5) {
        career.money -= t.price;
        career.crew.push({ name: nextCrewName(), tier: tierId, alive: true, kills: 0, gear: { head: 0, body: 0, limbs: 0, medkit: 0, grenade: 0 } });
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
    train: (skillId) => {
      const t = TRAINING[skillId];
      const lvl = career.skills[skillId];
      if (lvl < t.max && career.money >= t.prices[lvl]) {
        career.money -= t.prices[lvl];
        career.skills[skillId]++;
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
  });
}

function showIntro() {
  phase = 'intro';
  ui.renderIntro(career.rank, SQUADS[career.rank]);
  ui.showScreen('intro');
}

// ============================================================ input
document.addEventListener('mousemove', (e) => {
  if (locked && phase === 'match') player.onMouseMove(e.movementX, e.movementY);
});
document.addEventListener('mousedown', (e) => {
  if (locked && phase === 'match') player.onMouseDown(e.button);
});
document.addEventListener('mouseup', (e) => {
  if (locked && phase === 'match') player.onMouseUp(e.button);
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

// every key the game uses — swallow them so browser shortcuts (Ctrl+S, Ctrl+D, space-scroll…) never fire
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'KeyQ', 'KeyE', 'KeyH', 'KeyV', 'KeyG',
  'Space', 'ShiftLeft', 'ControlLeft', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']);

document.addEventListener('keydown', (e) => {
  if (phase === 'match') {
    if (GAME_KEYS.has(e.code) || e.ctrlKey) e.preventDefault();
    player.onKey(e.code, true);
  }
});
document.addEventListener('keyup', (e) => {
  if (phase === 'match') {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    player.onKey(e.code, false);
  }
});

// Firefox has no Keyboard Lock API, so Ctrl+W would instantly kill the tab mid-fight.
// Arm a leave-page confirmation while a bout is live so a stray browser shortcut isn't fatal.
window.addEventListener('beforeunload', (e) => {
  if (phase === 'match' || phase === 'paused') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// if focus ever leaves (browser dialog, alt-tab, lock loss), drop all held keys so we never get stuck walking
window.addEventListener('blur', () => player.clearInput());
document.addEventListener('visibilitychange', () => { if (document.hidden) player.clearInput(); });

// fullscreen + keyboard lock: inside fullscreen, Keyboard Lock captures even Ctrl+W / Esc-adjacent combos
async function enterCombatMode() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { /* user denied or unsupported — playable regardless */ }
  try {
    if (navigator.keyboard?.lock) await navigator.keyboard.lock([...GAME_KEYS]);
  } catch { /* unsupported — fine */ }
  renderer.domElement.requestPointerLock();
}
document.addEventListener('wheel', (e) => { if (locked && phase === 'match') player.onWheel(e.deltaY); });

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  player.clearInput();
  if (!locked && phase === 'match' && player.alive && !match.ended) {
    ui.showScreen('pause');
    phase = 'paused';
  }
});

// ============================================================ buttons
const on = (id, fn) => document.getElementById(id).addEventListener('click', () => { audio.init(); audio.resume(); audio.uiClick(); fn(); });

on('btn-new', () => { career = newCareer(); save(); showIntro(); });
on('btn-continue', () => { showIntro(); });
on('btn-fight', () => startMatch());
on('btn-next-fight', () => showIntro());
on('btn-retry', () => openShop());
on('btn-newgame', () => { career = newCareer(); save(); ui.showScreen('menu'); showIntro(); });
on('btn-resume', () => {
  phase = 'match';
  ui.showHUDOnly();
  enterCombatMode();
});
on('btn-abandon', () => {
  clearCombatants();
  phase = 'shop';
  openShop();
});

// ============================================================ boot
const saved = load();
if (saved) {
  career = saved;
  document.getElementById('btn-continue').classList.remove('hidden');
  document.getElementById('btn-new').textContent = 'NEW CAREER (WIPES SAVE)';
} else {
  career = newCareer();
}
ui.showScreen('menu');

// idle backdrop camera for menu
camera.position.set(0, 8, 20);
camera.lookAt(0, 1, 0);

// ============================================================ loop
const clock = new THREE.Clock();

const _aimTmp = new THREE.Vector3();

function stepMatch(dt) {
  match.time += dt;
  player.update(dt, locked);

  // crew reads this to stay out of the player's line of fire
  camera.getWorldDirection(_aimTmp);
  _aimTmp.y = 0;
  if (_aimTmp.lengthSq() > 1e-6) world.playerAim.copy(_aimTmp).normalize();

  // anti-camp: the crowd paid for movement. Root in one spot and VULTURE ships fire.
  if (player.alive && !match.ended) {
    const cdx = player.pos.x - match.campAnchor.x, cdz = player.pos.z - match.campAnchor.z;
    if (cdx * cdx + cdz * cdz > 5 * 5) {
      match.campAnchor.x = player.pos.x;
      match.campAnchor.z = player.pos.z;
      match.campT = 0;
      match.campWarned = false;
    } else {
      match.campT += dt;
      if (match.campT > 14 && !match.campWarned) {
        match.campWarned = true;
        ui.eventBanner('THE CROWD IS BORED', 'Move, or management sends motivation', 'var(--gold)');
        announcer.say('bored', {}, { force: true });
      }
      if (match.campT > 22) {
        match.campT = 12; // re-punish every ~10s while rooted
        spawnZone('fire', match.campAnchor.x, match.campAnchor.z, 3.2, 11, 15);
        audio.klaxon();
        ui.eventBanner('MOTIVATION DELIVERED', 'The management suggests footwork', '#ff6a1a');
        announcer.say('event_molotov', {}, { force: true });
      }
    }
  }
  for (const c of world.combatants) c.update(world, dt);
  updateEvents(dt);
  updateGrenades(dt);
  announcer.update(dt);
  ui.updateHUD(player, career, match);

  if (match.ended) {
    match.endTimer -= dt;
    if (match.endTimer <= 0) finishMatch();
  }
}

// debug handle (harmless in production)
window.__game = {
  get world() { return world; }, get match() { return match; }, get player() { return player; },
  get phase() { return phase; }, get career() { return career; },
  step(dt = 1 / 60, n = 1) { for (let i = 0; i < n && phase === 'match'; i++) stepMatch(dt); },
  setLocked(v) { locked = v; },
};

function tick() {
  requestAnimationFrame(tick);
  window.__frames = (window.__frames || 0) + 1;
  const dt = Math.min(0.05, clock.getDelta());
  const t = clock.elapsedTime;

  updateArenaAmbience(arena, t);
  fx.update(dt);
  audio.update(dt);

  if (phase === 'match') {
    stepMatch(dt);
  } else if (phase === 'menu' || phase === 'shop' || phase === 'intro' || phase === 'dead' || phase === 'champion') {
    // slow orbit backdrop
    const a = t * 0.08;
    camera.position.set(Math.sin(a) * 16, 7 + Math.sin(t * 0.3) * 1, Math.cos(a) * 16);
    camera.lookAt(0, 1.2, 0);
  }

  renderer.render(scene, camera);
}
tick();
