import * as THREE from 'three';
import { buildArena, updateArenaAmbience, ARENA } from './arena.js';
import { FX } from './fx.js';
import { Player } from './player.js';
import { Combatant } from './combatant.js';
import { Announcer } from './announcer.js';
import { UI, nextCrewName } from './ui.js';
import { WEAPONS } from './weapons.js';
import { audio } from './audio.js';
import { NavMesh } from './nav.js';
import {
  ITEM_TYPES, AMMO_TYPES, makeItem, autoPlace, removeFromGrid, canPlace,
  makeCharacter, characterWeight, weightSpeedMult, armorMits, countInPack, useFromPack,
  ammoInPack, consumeAmmo, bestUsableGun, buildAmmoPools, STASH_COLS,
} from './items.js';
import { createMarket } from './market.js';
import { InputHub, STICK, TOUCH, AIM_ASSIST } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { MenuNavigator } from './ui-nav.js';
import { ControllerSettingsPanel } from './controller-settings.js';
import { analytics } from './analytics.js';
import {
  newLiquidationState, fundDraftRound, runLiquidationAI, enemyRoster,
  liquidationOdds, liquidationBetOptions, resupplyLiquidation, draftCanCoverDebt, allocateRivalSupply,
  recordMarketRound, recordMarketTrade, commitPlayerDraftTurn,
} from './liquidation.js';
import {
  PLAYER_TYPE, HIRE_TYPES, createProgression, normalizeProgression, buyTraining,
  combatProfile, emptyXpStats, calculateXp, grantXp,
} from './progression.js';
import {
  CREW_CONTRACT_CAP, DEPLOYED_CREW_CAP, deployedCrewCount,
  normalizeCrewDeployment, shouldBenchNewHire,
} from './roster.js';

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
const menuNavigator = new MenuNavigator();
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
  onDamage: (shooter, victim, amount) => handleXpDamage(shooter, victim, amount),
  onSupport: (supporter, amount) => handleXpSupport(supporter, amount),
  onHitmarker: (kill, headshot) => ui.hitmarker(kill, headshot),
};

world.nav = new NavMesh(arena.colliders);

const player = new Player(camera, world);

// controller + touch input (mouse/keyboard bypass this and get no aim assist)
const touchMode = isTouchDevice();
if (touchMode) document.body.classList.add('touch-mode');
const onCycleSpectator = (dir) => { if (phase === 'match' && match?.spectating) cycleSpectator(dir); };
const touch = touchMode ? new TouchControls(player, { onPause: () => pauseMatch(), onCycleSpectator }) : null;
const input = new InputHub(player, world, camera, {
  touch,
  onPause: () => pauseMatch(),
  onResume: () => resumeFromPause(),
  onCycleSpectator,
  onMenuInput: (action) => menuNavigator.handle(action),
  onControllerActive: () => menuNavigator.activate(),
});
const controllerSettingsPanel = new ControllerSettingsPanel(input);

// ============================================================ career / save
// v2: unified grid inventory — old v1 saves are a different economy entirely, no migration
const SAVE_KEY = 'thunderdome-save-v2';
let career;
let market;

function newCareer(mode = 'circuits') {
  const playerCh = makeCharacter();
  autoPlace(playerCh.pack, makeItem('ammo_9mm'));
  autoPlace(playerCh.pack, makeItem('medkit'));
  autoPlace(playerCh.pack, makeItem('grenade'));
  autoPlace(playerCh.pack, makeItem('grenade'));
  return {
    analyticsId: crypto.randomUUID(),
    mode,
    money: 0, rank: 15, circuit: 1, mutators: [],
    playerCh,
    playerHp: null,                    // null = full; persists between matches
    playerLimbs: { arm: 0, leg: 0 },
    playerProgress: createProgression(),
    crew: [],                          // {name, type, progress, kills, hp, limbs, ch}
    stash: { cols: STASH_COLS, rows: 0, items: [] },
    bet: 0,
    totals: { kills: 0, headshots: 0, deaths: 0, earned: 0, crewLost: 0, circuitsCleared: 0 },
    liquidation: mode === 'liquidation' ? newLiquidationState() : null,
  };
}
function save() {
  if (career?.mode === 'liquidation' && market) career.liquidation.market = market.snapshot();
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(career)); } catch { /* private mode */ }
}
function load() {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    if (s) {
      const c = JSON.parse(s);
      if (c && c.rank >= 1 && c.playerCh && c.stash?.items) {
        // Preserve in-progress wars saved before the mode was renamed.
        if (c.attrition && !c.liquidation) c.liquidation = c.attrition;
        if (c.mode === 'attrition') c.mode = 'liquidation';
        delete c.attrition;
        if (c.liquidation) {
          c.liquidation.marketLog ||= [{ kind: 'round', round: c.liquidation.round || 1 }];
          delete c.liquidation.enemy?.log;
        }
        if ((c.mode === 'liquidation' || c.liquidation) && c.liquidation?.complete) {
          localStorage.removeItem(SAVE_KEY);
          return null;
        }
        c.playerProgress = normalizeProgression(c.playerProgress, c.skills);
        delete c.skills;
        for (const m of c.crew || []) {
          if (m.benched === undefined) m.benched = false;
          if (!m.type) {
            const legacyXp = m.tier === 'elite' ? 900 : m.tier === 'veteran' ? 350 : 0;
            m.type = 'enforcer';
            m.progress = normalizeProgression(m.progress || createProgression({}, legacyXp, legacyXp));
          } else {
            m.progress = normalizeProgression(m.progress);
          }
          delete m.tier;
        }
        normalizeCrewDeployment(c.crew);
        c.mode ||= c.liquidation ? 'liquidation' : 'circuits'; c.liquidation ||= null;
        c.analyticsId ||= crypto.randomUUID();
        if (c.liquidation) {
          c.liquidation.enemy ||= { strategy: 'balanced', inventory: {} };
          if (!Array.isArray(c.liquidation.enemy.recruits) || !c.liquidation.enemy.recruits.length) {
            c.liquidation.enemy.recruits = ['enforcer'];
          }
        }
        if (c.liquidation?.draft && c.liquidation.draft.version !== 3) {
          const old = c.liquidation.draft;
          if (old.version === 2) {
            c.liquidation.draft = {
              ...old, version: 3,
              playerFirst: !!old.pendingEnemyShop,
              playerTurnEnded: false,
            };
          } else {
            c.liquidation.draft = {
              version: 3,
              fundedRounds: old.complete ? 10 : Math.min(10, Math.floor((old.turn || 0) / 2)),
              starter: old.starter || 'player', complete: !!old.complete,
              pendingEnemyShop: false, playerFirst: false, playerTurnEnded: false, lastEnvelope: 0,
            };
          }
        }
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
  15: { name: 'THE GUTTER RATS', shirt: 0x5a4632, blurb: 'Sewer scavengers with stolen pistols. Your warm-up act. Try not to embarrass the house.', roster: [{ w: 'pistol', hp: 75, sp: 2.9, re: 1.15 }, { w: 'pistol', hp: 75, sp: 2.9, re: 1.15 }] },
  14: { name: 'THE RUST DOGS', shirt: 0x6e3b28, blurb: 'Junkyard enforcers. Three of them, all mean, none smart.', roster: [{ w: 'pistol', hp: 82, sp: 2.5, re: 1.0 }, { w: 'pistol', hp: 82, sp: 2.5, re: 1.0 }, { w: 'pistol', hp: 82, sp: 2.5, re: 1.0 }] },
  13: { name: 'THE JACKALS', shirt: 0x7a6a2a, blurb: 'Street crew that graduated to automatic weapons last month. The SMG is new. The malice is not.', roster: [{ w: 'smg', hp: 88, sp: 1.95, re: 0.85 }, { w: 'pistol', hp: 88, sp: 1.95, re: 0.85 }, { w: 'pistol', hp: 88, sp: 1.95, re: 0.85 }] },
  12: { name: 'BLACKLINE PMC', shirt: 0x22262e, blurb: 'Washed-out private military contractors. Disciplined bursts, matching uniforms, dead eyes.', roster: [{ w: 'smg', hp: 95, sp: 1.7, re: 0.72 }, { w: 'smg', hp: 95, sp: 1.7, re: 0.72 }, { w: 'smg', hp: 95, sp: 1.7, re: 0.72 }] },
  11: { name: 'THE VIPER BOYS', shirt: 0x1e4d2b, blurb: 'Four brothers, one shotgun, zero impulse control. They will rush you.', roster: [{ w: 'shotgun', hp: 105, sp: 1.65, re: 0.68 }, { w: 'smg', hp: 100, sp: 1.65, re: 0.68 }, { w: 'smg', hp: 100, sp: 1.65, re: 0.68 }, { w: 'pistol', hp: 100, sp: 1.65, re: 0.68 }] },
  10: { name: 'IRON PACK', shirt: 0x3a3f4a, blurb: 'Ex-dockworkers turned killers. First crew on the ladder with body armor. Aim for the legs and laugh.', roster: [{ w: 'rifle', hp: 108, sp: 1.5, re: 0.62, ar: 0.25 }, { w: 'shotgun', hp: 108, sp: 1.5, re: 0.62, ar: 0.25 }, { w: 'smg', hp: 104, sp: 1.55, re: 0.62 }, { w: 'smg', hp: 104, sp: 1.55, re: 0.62 }] },
  9: { name: 'THE SAWBONES', shirt: 0x3d5a52, blurb: 'A fighting clinic. Their medic drags men back from the dead mid-bout — shoot the one with the white cross FIRST.', roster: [{ w: 'rifle', hp: 112, sp: 1.4, re: 0.6, ar: 0.25 }, { w: 'smg', hp: 108, sp: 1.45, re: 0.6 }, { w: 'shotgun', hp: 112, sp: 1.4, re: 0.6 }, { w: 'smg', hp: 100, sp: 1.5, re: 0.6, arch: 'medic' }] },
  8: { name: 'THE STAMPEDE', shirt: 0x6b3a1e, blurb: 'They do one thing: RUN AT YOU. The two in front do not stop for grenades, caution, or common sense.', roster: [{ w: 'shotgun', hp: 150, sp: 1.5, re: 0.55, arch: 'rusher' }, { w: 'shotgun', hp: 150, sp: 1.5, re: 0.55, arch: 'rusher' }, { w: 'smg', hp: 110, sp: 1.4, re: 0.58 }, { w: 'rifle', hp: 112, sp: 1.35, re: 0.58, ar: 0.25 }] },
  7: { name: 'SHIELDWALL', shirt: 0x2f3a4a, blurb: 'Riot shields and patience. Shooting the wall from the front is donating ammo — get an angle.', roster: [{ w: 'pistol', hp: 130, sp: 1.35, re: 0.55, ar: 0.25, arch: 'shield' }, { w: 'pistol', hp: 130, sp: 1.35, re: 0.55, ar: 0.25, arch: 'shield' }, { w: 'rifle', hp: 115, sp: 1.3, re: 0.55, ar: 0.25 }, { w: 'smg', hp: 105, sp: 1.4, re: 0.55, arch: 'medic' }] },
  6: { name: 'GLASSEYE CARTEL', shirt: 0x403050, blurb: 'Their marksman paints you with a laser before the round arrives. When you see red, MOVE.', roster: [{ w: 'dmr', hp: 110, sp: 1.0, re: 0.5, ar: 0.25, arch: 'marksman' }, { w: 'rifle', hp: 118, sp: 1.25, re: 0.52, ar: 0.25 }, { w: 'rifle', hp: 118, sp: 1.25, re: 0.52, ar: 0.25 }, { w: 'smg', hp: 110, sp: 1.3, re: 0.52 }] },
  5: { name: 'THE HOUNDS OF VRY', shirt: 0x4a1f24, blurb: 'A cult that worships violence, now with a shield deacon and a battlefield surgeon. The chanting is worse in person.', roster: [{ w: 'rifle', hp: 122, sp: 1.15, re: 0.5, ar: 0.3 }, { w: 'rifle', hp: 122, sp: 1.15, re: 0.5, ar: 0.3 }, { w: 'pistol', hp: 135, sp: 1.25, re: 0.5, ar: 0.3, arch: 'shield' }, { w: 'shotgun', hp: 155, sp: 1.35, re: 0.5, arch: 'rusher' }, { w: 'smg', hp: 110, sp: 1.3, re: 0.5, arch: 'medic' }] },
  4: { name: 'CARTEL SICARIOS', shirt: 0x1a1a1a, blurb: 'Professional hitmen moonlighting for sport. Five guns, no wasted movement, one laser you will learn to hate.', roster: [{ w: 'rifle', hp: 126, sp: 1.05, re: 0.48, ar: 0.3 }, { w: 'rifle', hp: 126, sp: 1.05, re: 0.48, ar: 0.3 }, { w: 'dmr', hp: 115, sp: 0.9, re: 0.45, ar: 0.3, arch: 'marksman' }, { w: 'smg', hp: 120, sp: 1.1, re: 0.48 }, { w: 'shotgun', hp: 120, sp: 1.1, re: 0.48, ar: 0.3 }] },
  3: { name: 'GHOST SECTION', shirt: 0x2a2f3a, blurb: 'Former special forces with a combat medic. The bookies stopped taking bets against them two seasons ago.', roster: [{ w: 'rifle', hp: 135, sp: 0.95, re: 0.42, ar: 0.4 }, { w: 'rifle', hp: 135, sp: 0.95, re: 0.42, ar: 0.4 }, { w: 'dmr', hp: 128, sp: 0.85, re: 0.42, ar: 0.4, arch: 'marksman' }, { w: 'smg', hp: 128, sp: 1.0, re: 0.42, ar: 0.4, arch: 'medic' }, { w: 'rifle', hp: 135, sp: 0.95, re: 0.42, ar: 0.4 }] },
  2: { name: 'THE CULL', shirt: 0x101418, blurb: 'The league\'s cleanup crew: a shield, a stampede, a surgeon and a laser, moving as one organism.', roster: [{ w: 'pistol', hp: 150, sp: 1.05, re: 0.42, ar: 0.4, arch: 'shield' }, { w: 'shotgun', hp: 170, sp: 1.15, re: 0.42, arch: 'rusher' }, { w: 'smg', hp: 130, sp: 1.05, re: 0.42, ar: 0.4, arch: 'medic' }, { w: 'dmr', hp: 130, sp: 0.8, re: 0.4, ar: 0.4, arch: 'marksman' }, { w: 'rifle', hp: 140, sp: 0.9, re: 0.4, ar: 0.4 }] },
  1: { name: "DEATH'S HEAD SYNDICATE", shirt: 0x111114, blurb: 'The champion GOLIATH and his honor guard. Thirty-one bouts. Thirty-one closed caskets. Yours is pre-ordered.', roster: [{ w: 'rifle', hp: 650, sp: 0.85, re: 0.4, ar: 0.5, boss: true, name: 'GOLIATH', scale: 1.32 }, { w: 'pistol', hp: 150, sp: 1.0, re: 0.42, ar: 0.4, arch: 'shield' }, { w: 'dmr', hp: 132, sp: 0.8, re: 0.4, ar: 0.4, arch: 'marksman' }, { w: 'smg', hp: 132, sp: 1.0, re: 0.42, ar: 0.4, arch: 'medic' }, { w: 'shotgun', hp: 168, sp: 1.1, re: 0.42, arch: 'rusher' }] },
};

// ---- circuits: this IS the game. Each lap is harder and richer; the run ends
// when the house collects you. Score = circuits + lifetime blood money.
const MUTATORS = {
  blood_money: { name: 'RICH CROWD', desc: '+25% payouts' },
  dim: { name: 'BROWNOUT', desc: 'House keeps the lights low' },
  pricey_docs: { name: 'MEDICAL RACKET', desc: 'Doctors charge +50%' },
  hair_trigger: { name: 'HAIR TRIGGERS', desc: 'Enemies react faster' },
  hard_rounds: { name: 'HOT LOADS', desc: 'Enemy rounds hit +15% harder' },
  swarm: { name: 'FULL CARD', desc: 'Every squad fields an extra body' },
};
function rollMutators(circuit) {
  if (circuit <= 1) return [];
  const pool = Object.keys(MUTATORS);
  const picks = [];
  while (picks.length < Math.min(2 + ((circuit / 3) | 0), 4)) {
    const m = pool[(Math.random() * pool.length) | 0];
    if (!picks.includes(m)) picks.push(m);
  }
  return picks;
}
const hasMut = (id) => career.mutators.includes(id);
const circuitN = () => career.circuit - 1;
const payMult = () => (1 + circuitN() * 0.35) * (hasMut('blood_money') ? 1.25 : 1);
const priceMult = () => 1 + circuitN() * 0.22;
const medMult = () => priceMult() * (hasMut('pricey_docs') ? 1.5 : 1);

const DEATH_LINES = [
  'The crowd files out. The mop comes in.',
  'Your odds tomorrow just got a lot worse.',
  'Somewhere, a bookie just bought a boat with your blood money.',
  'The tournament master sends his condolences. He does not mean them.',
];

// ============================================================ match state
let phase = 'menu'; // menu | settings | intro | match | shop | dead | champion
let settingsReturnPhase = 'menu';
let locked = false;
let match = null;

function itemSnapshot(it) {
  return it ? { type: it.type, ...(it.rounds == null ? {} : { rounds: it.rounds }) } : null;
}

function characterSnapshot(ch) {
  if (!ch) return null;
  return {
    gear: Object.fromEntries(Object.entries(ch.gear).map(([slot, it]) => [slot, itemSnapshot(it)])),
    pack: ch.pack.items.map(entry => itemSnapshot(entry.it)),
  };
}

function progressionSnapshot(progress) {
  return progress ? {
    level: progress.level,
    xp: progress.xp,
    skills: { ...progress.skills },
  } : null;
}

function careerSnapshot() {
  const liquidation = career.liquidation;
  return {
    mode: career.mode,
    money: career.money,
    rank: career.rank,
    circuit: career.circuit,
    bet: career.bet,
    player: {
      hp: career.playerHp,
      limbs: { ...career.playerLimbs },
      progression: progressionSnapshot(career.playerProgress),
      inventory: characterSnapshot(career.playerCh),
    },
    crew: career.crew.map(member => ({
      name: member.name,
      type: member.type,
      hp: member.hp,
      limbs: { ...member.limbs },
      benched: member.benched,
      progression: progressionSnapshot(member.progress),
      inventory: characterSnapshot(member.ch),
    })),
    stash: career.stash.items.map(entry => itemSnapshot(entry.it)),
    liquidation: liquidation ? {
      round: liquidation.round,
      bankroll: liquidation.bankroll,
      playerWins: liquidation.playerWins,
      enemyWins: liquidation.enemyWins,
      enemyMoney: liquidation.enemyMoney,
      draft: { ...liquidation.draft },
      enemy: structuredClone(liquidation.enemy),
      market: market?.snapshot() ? structuredClone(market.snapshot()) : null,
    } : null,
  };
}

function fighterSnapshot(fighter) {
  if (fighter?.isPlayer && fighter !== player) return fighterSnapshot(player);
  const pos = fighter?.pos || { x: 0, y: 0, z: 0 };
  const armDmg = Number(fighter?.armDmg || 0);
  const legDmg = Number(fighter?.legDmg || 0);
  return {
    name: fighter?.isPlayer ? 'YOU' : fighter?.name || 'UNKNOWN',
    team: fighter?.team || null,
    alive: fighter?.alive ?? null,
    hp: Number.isFinite(fighter?.hp) ? Math.round(fighter.hp) : null,
    maxHp: Number.isFinite(fighter?.maxHp) ? Math.round(fighter.maxHp) : null,
    limbs: { arm: +armDmg.toFixed(2), leg: +legDmg.toFixed(2) },
    position: {
      x: +(Number(pos.x) || 0).toFixed(2),
      y: +(Number(pos.y) || 0).toFixed(2),
      z: +(Number(pos.z) || 0).toFixed(2),
    },
    weapon: fighter?.weapon?.id || fighter?.weaponId || null,
    role: fighter?.role || null,
    ammo: fighter?.ammoPools ? { ...fighter.ammoPools } : null,
    supplies: {
      medkit: fighter?.healKits || 0,
      splint: fighter?.splints || 0,
      grenade: fighter?.nades || 0,
    },
    inventory: characterSnapshot(fighter?.character),
  };
}

function matchSnapshot() {
  return {
    time: +match.time.toFixed(3),
    player: fighterSnapshot(player),
    crew: match.crew.map(fighterSnapshot),
    enemies: match.enemies.map(fighterSnapshot),
  };
}

function emitCareerEvent(type, payload = {}) {
  try {
    analytics.setContext({
      career_id: career.analyticsId,
      war_id: career.mode === 'liquidation' ? career.analyticsId : null,
      mode: career.mode,
      round: career.liquidation?.round || null,
      match_id: match?.analyticsId || null,
    });
    analytics.emit(type, payload);
  } catch (error) {
    console.warn('analytics event dropped', type, error);
  }
}

function runTrackedLiquidationAI(reason) {
  const before = careerSnapshot();
  const signals = { hoarded9mm: market.info('ammo_9mm').pressure > 1.4 };
  const result = runLiquidationAI(career.liquidation, market, signals);
  emitCareerEvent('liquidation_ai_decision', {
    reason,
    signals,
    result,
    before,
    after: careerSnapshot(),
  });
  return result;
}

function makeMatch() {
  return {
    analyticsId: crypto.randomUUID(),
    mode: career.mode,
    crew: [], enemies: [],
    frenzy: false, frenzyT: 0,
    firstBlood: false, ended: false, endTimer: 0, won: false,
    kills: 0, headshots: 0, killMoney: 0, hsMoney: 0, frenzyMoney: 0,
    eventTimer: 12 + Math.random() * 10, eventsFired: 0,
    lightsOut: 0, airdrop: null,
    enemiesAlive: 0,
    playerXp: emptyXpStats(),
    spectating: false, spectatorTarget: null,
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
  if (career.mode === 'liquidation' && career.liquidation.draft.pendingEnemyShop) {
    openShop();
    return;
  }
  clearCombatants();
  match = makeMatch();
  const liquidation = career.mode === 'liquidation';
  const squad = liquidation
    ? { name: 'THE RIVAL SYNDICATE', shirt: 0x5b2434, roster: enemyRoster(career.liquidation) }
    : SQUADS[career.rank];

  // spawn crew — deployed, breathing, and carrying exactly what you stocked them with
  career.crew.filter(cm => !cm.benched && (cm.hp == null || cm.hp > 0)).slice(0, DEPLOYED_CREW_CAP).forEach((cm, i) => {
    const stats = combatProfile(cm.type, cm.progress);
    const mits = armorMits(cm.ch);
    const c = new Combatant({
      name: cm.name, team: 'player', weaponId: bestUsableGun(cm.ch),
      skill: {
        spreadMult: stats.spreadMult, reaction: stats.reaction,
        speedMult: stats.speedMult * weightSpeedMult(cm.ch),
      },
      hp: stats.maxHp, shirt: 0x2e5d33,
      armorParts: mits,
      archetype: stats.archetype,
      damageMult: stats.damageMult,
      damageTakenMult: stats.damageTakenMult,
      healingMult: stats.healingMult,
      medicCooldownMult: stats.medicCooldownMult,
    });
    c.careerRef = cm;
    c.matchXp = emptyXpStats();
    c.character = cm.ch;
    c.healKits = countInPack(cm.ch, 'medkit');
    c.splints = countInPack(cm.ch, 'splint');
    c.nades = countInPack(cm.ch, 'grenade');
    c.shotsFired = 0;
    c.gunOptions = ['gun1', 'gun2'].map(s => cm.ch.gear[s]).filter(Boolean).map(g => ITEM_TYPES[g.type].gun);
    c.ammoPools = buildAmmoPools(cm.ch);
    c._initialPools = { ...c.ammoPools };
    // wounds carry over — patch them in the black market or they fight hurt
    if (cm.hp != null) c.hp = Math.min(c.maxHp, cm.hp);
    if (cm.limbs) { c.armDmg = cm.limbs.arm || 0; c.legDmg = cm.limbs.leg || 0; }
    c.addTo(world, arena.spawns.playerCrew[i % arena.spawns.playerCrew.length]);
    match.crew.push(c);
  });

  // spawn enemies (circuit scaling + mutators applied here)
  const cn = liquidation ? 0 : circuitN();
  const roster = [...squad.roster];
  if (!liquidation && hasMut('swarm') && roster.length <= 4) roster.push({ ...roster[roster.length - 1] });
  const names = squadNames(roster.length);
  roster.forEach((r, i) => {
    const c = new Combatant({
      name: r.name || names[i], team: 'enemy', weaponId: r.w,
      skill: {
        spreadMult: r.sp * Math.max(0.55, 1 - cn * 0.1),
        reaction: r.re * Math.max(0.45, 1 - cn * 0.08) * (!liquidation && hasMut('hair_trigger') ? 0.8 : 1),
        speedMult: 1 + (15 - career.rank) * 0.008 + cn * 0.03,
      },
      hp: Math.round(r.hp * (1 + cn * 0.4) * (r.boss ? 1 + cn * 0.15 : 1)),
      shirt: squad.shirt, armor: r.ar || 0, boss: r.boss, scale: r.scale,
      archetype: r.arch,
    });
    // higher-league fighters carry supplies
    c.nades = liquidation
      ? allocateRivalSupply(career.liquidation.enemy.inventory, 'grenade', i, roster.length)
      : career.rank <= 5 ? 2 : career.rank <= 10 ? 1 : 0;
    c.healKits = liquidation
      ? allocateRivalSupply(career.liquidation.enemy.inventory, 'medkit', i, roster.length)
      : career.rank <= 9 ? 1 : 0;
    c.splints = liquidation
      ? allocateRivalSupply(career.liquidation.enemy.inventory, 'splint', i, roster.length)
      : 0;
    // Circuit personalities get house-issued supplies; Liquidation archetypes
    // must use only the persistent stock their team actually purchased.
    if (!liquidation && r.arch === 'medic') c.healKits = 3;
    if (!liquidation && r.arch === 'rusher') { c.nades = 0; c.healKits = 0; c.splints = 0; }
    if (!liquidation && r.boss) { c.nades = 2; c.healKits = 2; }
    // Circuit fighters get five magazines from the house. Liquidation divides
    // the rival's persistent ammo inventory across its paid roster.
    const et = ITEM_TYPES[r.w]?.ammo;
    if (et) c.ammoPools[et] = liquidation ? (r.ammo || 0) : WEAPONS[r.w].mag * 5;
    c._initialPools = { ...c.ammoPools }; // for honest end-of-match settlement
    c._initialSupplies = { grenade: c.nades, medkit: c.healKits, splint: c.splints };
    c.addTo(world, arena.spawns.enemy[i % arena.spawns.enemy.length]);
    match.enemies.push(c);
  });
  match.enemiesAlive = match.enemies.length;
  world.enemyDmgScale = 0.85 * (!liquidation && hasMut('hard_rounds') ? 1.15 : 1);

  // reset player — loadout straight off the paper doll; the knife lives on [3]
  const pch = career.playerCh;
  const guns = ['gun1', 'gun2'].map(s => pch.gear[s]).filter(Boolean).map(g => ITEM_TYPES[g.type].gun);
  player.slots = guns;
  player.slotIdx = 0;
  const playerStats = combatProfile(PLAYER_TYPE, career.playerProgress, true);
  player.skills = career.playerProgress.skills;
  player.progressStats = playerStats;
  player.damageTakenMult = playerStats.damageTakenMult;
  player.armor = armorMits(pch);
  player.character = pch;
  player.weightMult = weightSpeedMult(pch);
  // Start angled toward the right-hand gap in the protective gate screen
  // instead of staring squarely into it from three metres away.
  player.resetForMatch(arena.spawns.player, -0.72);
  player.vmRoot.visible = true;
  player._mountViewmodel();
  player.loadMagsFromPack();
  // player wounds carry over too
  if (career.playerHp != null) player.hp = Math.min(player.maxHp, career.playerHp);
  player.armDmg = career.playerLimbs.arm || 0;
  player.legDmg = career.playerLimbs.leg || 0;

  assignRoles();
  assignOpeningPlays();
  emitCareerEvent('match_enter', {
    game_mode: career.mode,
    opening_plays: {
      player: match.crew.map(c => ({ name: c.name, role: c.role, goal: c.openingGoal?.toArray() })),
      enemy: match.enemies.map(c => ({ name: c.name, role: c.role, goal: c.openingGoal?.toArray() })),
    },
    career: careerSnapshot(),
    squads: matchSnapshot(),
  });

  match.campAnchor.x = player.pos.x;
  match.campAnchor.z = player.pos.z;
  world.globalDmgMult = 1;

  // escrow the bet
  if (liquidation) {
    career.bet = Math.max(250, career.bet || 0);
    match.betOdds = liquidationOdds(career.liquidation, career.money);
    match.enemyBet = career.bet;
    career.money -= career.bet;
    career.liquidation.enemyMoney -= match.enemyBet;
  } else if (career.bet > 0) career.money -= career.bet;

  announcer.clear();
  announcer.say('matchStart', {}, { force: true });
  if (career.rank === 1) setTimeout(() => announcer.say('bossIntro', {}, { force: true }), 3000);
  audio.setCrowdLevel(0.055 + (10 - career.rank) * 0.004);
  audio.klaxon();

  phase = 'match';
  ui.hideSpectator();
  ui.showHUDOnly();
  enterCombatMode();
}

// ============================================================ kills / damage
function betOdds() {
  return 1 + (16 - career.rank) * 0.12 + circuitN() * 0.15;
}

function payout(base) {
  if (match?.mode === 'liquidation') return 0;
  const mult = (match.frenzy ? 2 : 1) * payMult();
  const amt = Math.round(base * mult);
  if (match.frenzy) match.frenzyMoney += base;
  career.money += amt;
  career.totals.earned += amt;
  return amt;
}

function handleXpDamage(shooter, victim, amount) {
  if (!match || victim.team !== 'enemy' || shooter?.team !== 'player' || amount <= 0) return;
  const stats = shooter.isPlayer ? match.playerXp : shooter.matchXp;
  if (stats) stats.damage += amount;
}

function handleXpSupport(supporter, amount) {
  if (!match || supporter?.team !== 'player' || amount <= 0) return;
  if (supporter.matchXp) supporter.matchXp.support += amount;
}

function livingCrew() {
  return match?.crew.filter(c => c.alive) || [];
}

function endPlayerTeamLoss() {
  if (match.ended) return;
  match.ended = true;
  match.won = false;
  match.endTimer = 2.2;
  announcer.say('lose', {}, { force: true });
  audio.crowdRoar(1);
}

function cycleSpectator(direction = 1) {
  const alive = livingCrew();
  if (!alive.length) {
    match.spectatorTarget = null;
    ui.hideSpectator();
    endPlayerTeamLoss();
    return;
  }
  const current = alive.indexOf(match.spectatorTarget);
  const next = current < 0 ? 0 : (current + direction + alive.length) % alive.length;
  match.spectatorTarget = alive[next];
  ui.showSpectator(match.spectatorTarget.name, next, alive.length);
}

function handlePlayerDeath() {
  if (match.playerDeathHandled) return;
  match.playerDeathHandled = true;
  career.totals.deaths++;
  player.clearInput();
  player.vmRoot.visible = false;
  if (livingCrew().length) {
    match.spectating = true;
    cycleSpectator(1);
    ui.eventBanner('YOU ARE DOWN', 'Your squad is still fighting', 'var(--gold)');
  } else {
    endPlayerTeamLoss();
  }
}

function handleKill(killer, victim, part) {
  const headshot = part === 'head';
  const killerName = killer.isPlayer ? 'YOU' : killer.name;
  ui.killfeed(killerName, victim.name, headshot, killer.team === 'player');
  audio.crowdRoar(headshot ? 1 : 0.6);
  emitCareerEvent('combat_kill', {
    time: +match.time.toFixed(3),
    part,
    headshot,
    killer: fighterSnapshot(killer),
    victim: fighterSnapshot(victim),
  });

  if (!match.firstBlood) {
    match.firstBlood = true;
    announcer.say('firstBlood', {}, { force: true });
  }

  if (victim.team === 'enemy') {
    match.enemiesAlive--;
    match.kills++;
    if (headshot) match.headshots++;
    const xpStats = killer.isPlayer ? match.playerXp : killer.matchXp;
    if (killer.team === 'player' && xpStats) {
      xpStats.kills++;
      if (headshot) xpStats.headshots++;
    }

    let base = 140 + (15 - career.rank) * 20;
    if (victim.bountyT > 0) {
      base *= 3;
      ui.eventBanner('BOUNTY COLLECTED', `${victim.name} was worth triple`, 'var(--gold)');
    }
    if (killer.isPlayer) {
      player.stats.matchKills++;
      career.totals.kills++;
      if (headshot) { player.stats.matchHeadshots++; career.totals.headshots++; }
      const amt = payout(base + (headshot ? 100 : 0));
      match.killMoney += base;
      if (headshot) match.hsMoney += 100;
      if (amt > 0) { ui.moneyPop(amt); audio.cashRegister(); } // liquidation kills pay in position, not cash
      player.hp = Math.min(player.maxHp, player.hp + (player.progressStats.killHeal || 8)); // adrenaline
      if (headshot) announcer.say('playerHeadshot', { victim: victim.name });
      else announcer.say('playerKill', { victim: victim.name });
    } else {
      const amt = payout(Math.round(base * 0.5));
      match.killMoney += Math.round(base * 0.5);
      if (amt > 0) ui.moneyPop(amt);
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
    // crew member went down — they're bruised, not buried; gear stays theirs
    if (victim.careerRef) career.totals.crewLost++;
    if (killer && killer.isPlayer) announcer.say('teamkill', { victim: victim.name }, { force: true });
    else announcer.say('enemyKillsAlly', { killer: killerName, victim: victim.name });
    if (!player.alive) cycleSpectator(1);
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
  } else handlePlayerDeath();
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

const EVENTS = ['lightsout', 'gas', 'frenzy', 'airdrop', 'molotov', 'bounty', 'bloodrules'];
// liquidation has no kill payouts, so the money-themed spectacles would announce cash that never arrives
const LIQUIDATION_EVENTS = ['lightsout', 'gas', 'airdrop', 'molotov', 'bloodrules'];
function fireEvent() {
  const pool = match.mode === 'liquidation' ? LIQUIDATION_EVENTS : EVENTS;
  let ev = pool[(Math.random() * pool.length) | 0];
  if (ev === 'bounty' && !match.enemies.some(c => c.alive && !c.boss)) ev = 'frenzy';
  audio.klaxon();
  if (ev === 'bounty') {
    const marks = match.enemies.filter(c => c.alive && !c.boss);
    const mark = marks[(Math.random() * marks.length) | 0];
    mark.bountyT = 22;
    mark.bountyLight = new THREE.PointLight(0xffb92e, 30, 7, 1.5);
    mark.bountyLight.position.y = 2.3;
    mark.group.add(mark.bountyLight);
    ui.eventBanner('BOUNTY POSTED', `${mark.name} is worth TRIPLE for 20 seconds`, 'var(--gold)');
    announcer.say('bounty', { victim: mark.name }, { force: true });
    return;
  }
  if (ev === 'bloodrules') {
    match.bloodT = 15;
    world.globalDmgMult = 1.5;
    ui.eventBanner('BLOOD RULES', 'Everyone takes +50% damage. Everyone.', 'var(--blood)');
    announcer.say('bloodrules', {}, { force: true });
    return;
  }
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

  // bounty ticks + blood rules
  for (const c of match.enemies) {
    if (c.bountyT > 0) {
      c.bountyT -= dt;
      if (c.bountyLight) c.bountyLight.intensity = 22 + Math.sin(match.time * 8) * 14;
      if ((c.bountyT <= 0 || !c.alive) && c.bountyLight) {
        c.group.remove(c.bountyLight);
        c.bountyLight = null;
      }
    }
  }
  if (match.bloodT > 0) {
    match.bloodT -= dt;
    if (match.bloodT <= 0) world.globalDmgMult = 1;
  }

  // lights out (BROWNOUT circuits never run the house at full wattage)
  const targetFactor = match.lightsOut > 0 ? 0.05 : (hasMut('dim') ? 0.6 : 1);
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
        handlePlayerDeath();
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
        if (amt > 0) { ui.moneyPop(amt); audio.cashRegister(); }
        ui.eventBanner('PACKAGE CLAIMED', 'Full patch-up. Back to work.', '#86ff3c');
        scene.remove(ad.mesh);
        match.airdrop = null;
      }
    }
    if (match.airdrop && ad.ttl <= 0) { scene.remove(ad.mesh); match.airdrop = null; }
  }
}

// ============================================================ match end
function awardMatchExperience() {
  const awards = [];
  const award = (name, progress, stats, survived) => {
    const result = calculateXp(stats, { won: match.won, survived });
    const xp = grantXp(progress, result.total);
    awards.push({ name, xp, ...result });
  };
  award('YOU', career.playerProgress, match.playerXp, player.alive);
  for (const c of match.crew) {
    if (!c.careerRef || !c.matchXp) continue;
    award(c.name, c.careerRef.progress, c.matchXp, c.alive);
  }
  match.xpAwards = awards;
  return awards;
}

function finishMatch() {
  document.exitPointerLock();
  ui.hideSpectator();
  const xpAwards = awardMatchExperience();
  // crew burn real supplies: rounds actually fired (per pool), kits and frags used
  for (const c of match.crew) {
    const ch = c.character;
    if (ch) {
      for (const [type, initial] of Object.entries(c._initialPools || {})) {
        const used = initial - (c.ammoPools[type] || 0);
        if (used > 0) consumeAmmo(ch, type, used);
      }
      while (countInPack(ch, 'medkit') > c.healKits) useFromPack(ch, 'medkit');
      while (countInPack(ch, 'splint') > c.splints) useFromPack(ch, 'splint');
      while (countInPack(ch, 'grenade') > c.nades) useFromPack(ch, 'grenade');
    }
    // health persists; the downed stay at zero until someone pays the doctor
    if (c.careerRef) {
      c.careerRef.hp = c.alive ? Math.round(c.hp) : 0;
      c.careerRef.limbs = { arm: +c.armDmg.toFixed(2), leg: +c.legDmg.toFixed(2) };
    }
  }
  // settle the bet
  if (career.bet > 0) {
    if (match.mode === 'liquidation') {
      const winnings = Math.round(career.bet * match.betOdds);
      if (match.won) {
        career.money += winnings;
        career.totals.earned += winnings;
        career.liquidation.playerWins++;
      } else {
        career.liquidation.enemyMoney += career.bet + match.enemyBet;
        career.liquidation.enemyWins++;
      }
      match.betWinnings = match.won ? winnings : 0;
    } else if (match.won) {
      const winnings = Math.round(career.bet * betOdds());
      career.money += winnings;
      career.totals.earned += winnings;
      match.betWinnings = winnings;
    }
    career.bet = 0;
  }
  // player: keep your wounds, or — if dead — get auto-charged for the minimum
  // stabilization to 1hp NOW, before the money can be spent on anything else.
  if (player.alive) {
    career.playerHp = Math.round(player.hp);
  } else {
    career.playerHp = 1;
    career.money -= 25; // the house medic's "you live" fee, non-negotiable
  }
  career.playerLimbs = { arm: +player.armDmg.toFixed(2), leg: +player.legDmg.toFixed(2) };
  emitCareerEvent('match_exit', {
    won: match.won,
    duration: +match.time.toFixed(3),
    kills: match.kills,
    headshots: match.headshots,
    squads: matchSnapshot(),
    career_before_settlement: careerSnapshot(),
  });
  clearCombatants();

  if (match.mode === 'liquidation') {
    const a = career.liquidation;
    a.round++;
    recordMarketRound(a);
    resupplyLiquidation(a, market);
    // The rival burns stock too; combat is the principal resource sink.
    // Settle by rounds ACTUALLY fired per ammo type, not by whatever strategy
    // the shopkeeper AI happens to hold now.
    const usedByType = {};
    const usedSupplies = { grenade: 0, medkit: 0, splint: 0 };
    for (const c of match.enemies) {
      for (const [t, initial] of Object.entries(c._initialPools || {})) {
        usedByType[t] = (usedByType[t] || 0) + Math.max(0, initial - (c.ammoPools[t] || 0));
      }
      for (const [type, initial] of Object.entries(c._initialSupplies || {})) {
        const remaining = type === 'grenade' ? c.nades : type === 'medkit' ? c.healKits : c.splints;
        usedSupplies[type] += Math.max(0, initial - remaining);
      }
    }
    for (const [t, used] of Object.entries(usedByType)) {
      if (used <= 0) continue;
      const itemType = `ammo_${t}`;
      a.enemy.inventory[itemType] = Math.max(0, (a.enemy.inventory[itemType] || 0) - Math.ceil(used / AMMO_TYPES[t].box));
    }
    for (const [type, used] of Object.entries(usedSupplies)) {
      a.enemy.inventory[type] = Math.max(0, (a.enemy.inventory[type] || 0) - used);
    }
    for (let i = 0; i < 3; i++) runTrackedLiquidationAI('post_match');
    const playerBroke = career.money < 0 && !draftCanCoverDebt(a, career.money);
    const enemyBroke = a.enemyMoney < 0 && !draftCanCoverDebt(a, a.enemyMoney);
    if (playerBroke || enemyBroke) {
      a.complete = true;
      save();
      phase = playerBroke ? 'executed' : 'champion';
      const result = `Liquidation ended after <b>${a.round - 1} rounds</b> · you ${a.playerWins}–${a.enemyWins} rival.<br>` +
        `Final bankrolls: <b style="color:var(--gold)">$${career.money}</b> vs <b>$${a.enemyMoney}</b>.`;
      if (playerBroke) { ui.renderExecuted(result, true); ui.showScreen('executed'); }
      else { ui.renderChampion(result, true); ui.showScreen('champion'); }
      return;
    }
    save();
    openShop({ kills: match.kills, headshots: match.headshots, killMoney: 0, hsMoney: 0,
      frenzyMoney: 0, winBonus: 0, betWinnings: match.betWinnings || 0,
      xpAwards,
      total: match.won ? match.betWinnings || 0 : 0 });
    return;
  }

  if (match.won) {
    const winBonus = Math.round((350 + (15 - career.rank) * 90) * payMult());
    career.money += winBonus;
    career.totals.earned += winBonus;
    const earnings = {
      kills: match.kills, headshots: match.headshots,
      killMoney: match.killMoney, hsMoney: match.hsMoney,
      frenzyMoney: match.frenzyMoney, winBonus,
      betWinnings: match.betWinnings || 0,
      xpAwards,
      total: match.killMoney + match.hsMoney + match.frenzyMoney + winBonus + (match.betWinnings || 0),
    };
    audio.cashRegister();

    if (career.rank === 1) {
      // circuit cleared — the ladder resets harder and richer. This IS the game.
      career.totals.circuitsCleared++;
      career.circuit++;
      career.rank = 15;
      career.mutators = rollMutators(career.circuit);
      save();
      phase = 'champion';
      ui.renderChampion(
        `<b style="color:var(--gold)">CIRCUIT ${career.circuit - 1} CLEARED</b> — the league reseeds, the odds get worse, the money gets better.<br><br>` +
        `Career kills: <b>${career.totals.kills}</b> (${career.totals.headshots} headshots)<br>` +
        `Total blood money: <b style="color:var(--gold)">$${career.totals.earned.toLocaleString()}</b><br>` +
        `Circuit ${career.circuit} conditions: <b>${career.mutators.map(m => MUTATORS[m].name).join(' · ') || 'standard card'}</b>`
      );
      ui.showScreen('champion');
      return;
    }

    career.rank--;
    save();
    openShop(earnings);
  } else {
    // death: the house takes its cut whether you can afford it or not
    const cut = Math.max(120, Math.round(career.money * 0.15));
    career.money -= cut;
    if (career.money < 0) {
      // in debt to the house — there's only one collections department
      phase = 'executed';
      ui.renderExecuted(
        `You owed the house <b style="color:var(--blood)">$${Math.abs(career.money)}</b> it was never getting back.<br>` +
        `Career: rank ${career.rank} · ${career.totals.kills} kills · ${career.totals.deaths + 1} deaths · ` +
        `$${career.totals.earned.toLocaleString()} earned and spent.`
      );
      ui.showScreen('executed');
      audio.shot('dmr', 1); // one round, behind the bleachers
      localStorage.removeItem(SAVE_KEY);
      return;
    }
    save();
    phase = 'dead';
    ui.renderDeath(
      DEATH_LINES[(Math.random() * DEATH_LINES.length) | 0],
      `The house took its cut: <b style="color:var(--blood)">−$${cut}</b><br>` +
      `Bankroll: $${career.money} — go into debt and the house collects YOU.<br>` +
      `Kills this bout: ${match.kills} · Career deaths: ${career.totals.deaths}<br>` +
      `Experience: ${xpAwards.map(a => `${a.name} +${a.xp} XP`).join(' · ')}`
    );
    ui.showScreen('death');
  }
}

// medical pricing: this is the drain that makes dying expensive (circuits inflate it)
function playerPatchCost() {
  const max = combatProfile(PLAYER_TYPE, career.playerProgress, true).maxHp;
  const missing = career.playerHp == null ? 0 : Math.max(0, max - career.playerHp);
  const limbs = (career.playerLimbs.arm > 0.05 || career.playerLimbs.leg > 0.05) ? 80 : 0;
  return Math.round((missing * 2.2 + limbs) * medMult());
}
function crewPatchCost(m) {
  if (!m) return 0;
  const max = combatProfile(m.type, m.progress).maxHp;
  const missing = m.hp == null ? 0 : Math.max(0, max - m.hp);
  const limbs = (m.limbs && (m.limbs.arm > 0.05 || m.limbs.leg > 0.05)) ? 60 : 0;
  return Math.round((missing * 1.6 + limbs) * medMult());
}

// ---- inventory plumbing for the shop UI ----
const getChar = (who) => who === 'player' ? career.playerCh : career.crew[who]?.ch;

function findItem(uid) {
  const s = career.stash.items.find(e => e.it.uid === uid);
  if (s) return { it: s.it, loc: { kind: 'stash' } };
  const chars = [['player', career.playerCh], ...career.crew.map((m, i) => [i, m.ch])];
  for (const [who, ch] of chars) {
    for (const slot of ['head', 'body', 'limbs', 'gun1', 'gun2']) {
      if (ch.gear[slot]?.uid === uid) return { it: ch.gear[slot], loc: { kind: 'slot', who, slot } };
    }
    const p = ch.pack.items.find(e => e.it.uid === uid);
    if (p) return { it: p.it, loc: { kind: 'pack', who } };
  }
  return null;
}

function detachItem(found) {
  const { it, loc } = found;
  if (loc.kind === 'stash') removeFromGrid(career.stash, it.uid);
  else if (loc.kind === 'pack') removeFromGrid(getChar(loc.who).pack, it.uid);
  else getChar(loc.who).gear[loc.slot] = null;
}

function slotAccepts(slot, it) {
  const def = ITEM_TYPES[it.type];
  if (slot === 'gun1' || slot === 'gun2') return def.kind === 'gun';
  return def.kind === 'armor' && def.slot === slot;
}

// move an item to {kind:'stash'|'pack'|'slot'|'sell', who?, slot?, x?, y?}; returns true on success
function moveItem(uid, to) {
  const found = findItem(uid);
  if (!found) return false;
  const { it } = found;
  const def = ITEM_TYPES[it.type];

  if (to.kind === 'sell') {
    detachItem(found);
    const value = career.mode === 'liquidation' ? market.sell(it) : market.quoteSell(it, priceMult());
    career.money += value;
    if (career.mode === 'liquidation') recordPlayerMarket('sell', it.type, value);
    audio.cashRegister();
    return true;
  }
  if (to.kind === 'stash') {
    detachItem(found);
    if (to.x != null && canPlace(career.stash, it, to.x, to.y)) career.stash.items.push({ it, x: to.x, y: to.y });
    else autoPlace(career.stash, it);
    return true;
  }
  if (to.kind === 'pack') {
    if (def.kind !== 'consumable' && def.kind !== 'ammo') return false; // packs carry supplies, not hardware
    const ch = getChar(to.who);
    if (!ch) return false;
    const src = { ...found };
    detachItem(found);
    if (to.x != null && canPlace(ch.pack, it, to.x, to.y)) { ch.pack.items.push({ it, x: to.x, y: to.y }); return true; }
    if (autoPlace(ch.pack, it)) return true;
    // pack full — bounce back to stash
    if (src.loc.kind === 'stash') autoPlace(career.stash, it);
    else autoPlace(career.stash, it);
    return false;
  }
  if (to.kind === 'slot') {
    const ch = getChar(to.who);
    if (!ch || !slotAccepts(to.slot, it)) return false;
    const old = ch.gear[to.slot];
    // slot→slot with a compatible occupant: swap in place, nothing goes home
    if (found.loc.kind === 'slot' && old && slotAccepts(found.loc.slot, old)) {
      const srcCh = getChar(found.loc.who);
      srcCh.gear[found.loc.slot] = old;
      ch.gear[to.slot] = it;
      return true;
    }
    detachItem(found);
    ch.gear[to.slot] = it;
    if (old) autoPlace(career.stash, old); // displaced piece goes home
    return true;
  }
  return false;
}

// combat roles: rolled per match so squads spread instead of blob-rushing together.
// Crew always includes a shadow (your bodyguard) and support (overwatch); the rest
// split pointman/flanker. Enemy archetypes imply their roles.
function assignRoles() {
  const shuffle = (a) => a.sort(() => Math.random() - 0.5);
  const crewRoles = shuffle(['shadow', 'support', 'flanker', 'pointman', 'flanker']);
  match.crew.forEach((c, i) => { c.role = crewRoles[i % crewRoles.length]; });
  const enemyRoles = shuffle(['pointman', 'flanker', 'support', 'flanker', 'pointman']);
  match.enemies.forEach((c, i) => {
    if (c.archetype === 'rusher' || c.archetype === 'shield') c.role = 'pointman';
    else if (c.archetype === 'marksman') c.role = 'support';
    else if (c.archetype === 'medic') c.role = 'support';
    else c.role = enemyRoles[i % enemyRoles.length];
  });
}

// opening plays: a pre-match nudge so squads don't pour down the same lane every bout
function assignOpeningPlays() {
  const PLAYS = ['left', 'right', 'split', 'center', 'gantry'];
  const anchors = (side) => ({
    // side: -1 = squad spawning north (moving +z), +1 = squad spawning south (moving -z)
    left: [new THREE.Vector3(-17, 0, 3 * side), new THREE.Vector3(-12, 0, 5 * side)],
    right: [new THREE.Vector3(17, 0, 3 * side), new THREE.Vector3(12, 0, 5 * side)],
    center: [new THREE.Vector3(-3, 0, 2 * side), new THREE.Vector3(3, 0, 2 * side)],
    gantryW: new THREE.Vector3(-16.5, 2.25, 0),
    gantryE: new THREE.Vector3(16.5, 2.25, 0),
  });
  const applyPlay = (squad, side) => {
    if (!squad.length) return;
    const play = PLAYS[(Math.random() * PLAYS.length) | 0];
    const a = anchors(side);
    squad.forEach((c, i) => {
      let goal;
      if (play === 'left') goal = a.left[i % 2];
      else if (play === 'right') goal = a.right[i % 2];
      else if (play === 'center') goal = a.center[i % 2];
      else if (play === 'split') goal = (i % 2 === 0 ? a.left : a.right)[(i >> 1) % 2];
      else goal = i === 0 ? (Math.random() < 0.5 ? a.gantryW : a.gantryE) : (i % 2 === 0 ? a.left : a.right)[0];
      c.openingGoal = goal.clone();
      c.openingGoal.x += (Math.random() - 0.5) * 2;
      c.openingGoal.z += (Math.random() - 0.5) * 2;
      c.openingT = 6.5 + Math.random() * 3;
    });
  };
  applyPlay(match.enemies, -1);
  applyPlay(match.crew, 1);
}

function openShop(earnings = null) {
  if (career.mode === 'liquidation') ensureLiquidationRoundFunding();
  phase = 'shop';
  ui.showScreen('shop');
  renderShop(earnings);
}

function ensureLiquidationRoundFunding() {
  const a = career.liquidation;
  if (!a || a.complete || a.draft.fundedRounds >= Math.min(a.round, 10)) return;
  career.money = fundDraftRound(a, career.money, () => {
    for (let i = 0; i < 8; i++) runTrackedLiquidationAI('enemy_first_draft');
  });
  emitCareerEvent('liquidation_draft_funding', { state: careerSnapshot() });
  save();
}

function draftShopState() {
  if (career.mode !== 'liquidation' || career.liquidation.round > 10) {
    return { mustEndTurn: false, locked: false };
  }
  const draft = career.liquidation.draft;
  return {
    mustEndTurn: !!draft.playerFirst && !draft.playerTurnEnded,
    locked: !!draft.playerFirst && !!draft.playerTurnEnded,
  };
}

function runRivalDraftShop() {
  for (let i = 0; i < 8; i++) runTrackedLiquidationAI('player_draft_commit');
}

function recordPlayerMarket(action, type, amount, label = null) {
  recordMarketTrade(career.liquidation, 'player', action, type, amount, label);
  emitCareerEvent('liquidation_market_action', {
    side: 'player',
    action,
    type,
    amount,
    label,
    state: careerSnapshot(),
  });
}

function renderShop(earnings) {
  ui.renderShop(career, player, career.mode === 'liquidation' ? { name: 'THE RIVAL SYNDICATE', blurb: '', roster: [] } : SQUADS[career.rank], earnings, {
    playerPatchCost,
    crewPatchCost,
    priceMult,
    priceOf: (type) => market.quoteBuy(type, 1, priceMult()),
    marketInfo: (type) => market.info(type),
    recruitPrice: (type) => market.quoteRecruit(type),
    recruitMarketInfo: (type) => market.recruitInfo(type),
    releaseValue: (type) => market.quoteReleaseRecruit(type),
    draftShopState,
    endDraftTurn: () => {
      if (commitPlayerDraftTurn(career.liquidation, runRivalDraftShop)) {
        audio.klaxon();
        save();
        renderShop(earnings);
      }
    },
    buyItem: (type) => {
      if (draftShopState().locked) return;
      const def = ITEM_TYPES[type];
      const cost = market.quoteBuy(type, 1, priceMult());
      if (def && career.money >= cost) {
        market.buy(type);
        career.money -= cost;
        if (career.mode === 'liquidation') recordPlayerMarket('buy', type, cost);
        autoPlace(career.stash, makeItem(type));
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
    moveItem: (uid, to) => {
      if (draftShopState().locked) return;
      if (moveItem(uid, to)) { audio.uiClick(); save(); }
      renderShop(earnings);
    },
    patchPlayer: () => {
      if (draftShopState().locked) return;
      const cost = playerPatchCost();
      const pay = Math.min(cost, career.money);
      if (cost <= 0 || pay <= 0) return;
      career.money -= pay;
      const f = pay / cost;
      if (f >= 0.999) {
        career.playerHp = null;
        career.playerLimbs = { arm: 0, leg: 0 };
      } else {
        // broke? the doc does what the money covers
        const max = combatProfile(PLAYER_TYPE, career.playerProgress, true).maxHp;
        const cur = career.playerHp == null ? max : career.playerHp;
        career.playerHp = Math.min(max, Math.round(cur + (max - cur) * f));
        career.playerLimbs.arm = +(career.playerLimbs.arm * (1 - f)).toFixed(2);
        career.playerLimbs.leg = +(career.playerLimbs.leg * (1 - f)).toFixed(2);
      }
      if (career.mode === 'liquidation') emitCareerEvent('liquidation_patch', {
        target: 'player', cost: pay, state: careerSnapshot(),
      });
      audio.cashRegister(); save(); renderShop(earnings);
    },
    patchCrew: (idx) => {
      if (draftShopState().locked) return;
      const m = career.crew[idx];
      const cost = crewPatchCost(m);
      const pay = Math.min(cost, career.money);
      if (!m || cost <= 0 || pay <= 0) return;
      career.money -= pay;
      const f = pay / cost;
      if (f >= 0.999) {
        m.hp = null;
        m.limbs = { arm: 0, leg: 0 };
      } else {
        const max = combatProfile(m.type, m.progress).maxHp;
        const cur = m.hp == null ? max : m.hp;
        m.hp = Math.min(max, Math.round(cur + (max - cur) * f));
        m.limbs.arm = +((m.limbs.arm || 0) * (1 - f)).toFixed(2);
        m.limbs.leg = +((m.limbs.leg || 0) * (1 - f)).toFixed(2);
      }
      if (career.mode === 'liquidation') emitCareerEvent('liquidation_patch', {
        target: m.name, cost: pay, state: careerSnapshot(),
      });
      audio.cashRegister(); save(); renderShop(earnings);
    },
    sellCrew: (idx) => {
      if (draftShopState().locked) return;
      const m = career.crew[idx];
      if (!m) return;
      // Everything they carry goes back to the stash. In Liquidation their
      // contract returns to that archetype's public AMM pool.
      for (const slot of ['head', 'body', 'limbs', 'gun1', 'gun2']) {
        const it = m.ch.gear[slot];
        if (it && !(it.type === 'pistol' && slot === 'gun1')) autoPlace(career.stash, it);
      }
      for (const e of [...m.ch.pack.items]) autoPlace(career.stash, e.it);
      const refund = market.releaseRecruit(m.type);
      career.money += refund;
      if (career.mode === 'liquidation') {
        recordPlayerMarket('release', null, refund, `${HIRE_TYPES[m.type].name} CONTRACT`);
      }
      career.crew.splice(idx, 1);
      audio.cashRegister(); save(); renderShop(earnings);
    },
    hire: (typeId) => {
      if (draftShopState().locked) return;
      const t = HIRE_TYPES[typeId];
      const quoted = market.quoteRecruit(typeId);
      if (t && Number.isFinite(quoted) && career.money >= quoted && career.crew.length < CREW_CONTRACT_CAP) {
        const cost = market.buyRecruit(typeId);
        career.money -= cost;
        const ch = makeCharacter();
        autoPlace(ch.pack, makeItem('ammo_9mm')); // signs on stocked, like you did
        autoPlace(ch.pack, makeItem('medkit'));
        const name = nextCrewName();
        career.crew.push({
          name, type: typeId, progress: createProgression(), kills: 0,
          hp: null, limbs: { arm: 0, leg: 0 },
          benched: shouldBenchNewHire(career.crew),
          ch,
        });
        if (career.mode === 'liquidation') {
          recordPlayerMarket('hire', null, cost, `${t.name} · ${name}`);
        }
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
    toggleBench: (idx) => {
      if (draftShopState().locked) return;
      const m = career.crew[idx];
      if (!m) return;
      // deploy cap: 5 in the pit at once
      const deployed = deployedCrewCount(career.crew);
      if (m.benched && deployed >= DEPLOYED_CREW_CAP) return;
      m.benched = !m.benched;
      audio.uiClick(); save(); renderShop(earnings);
    },
    buyItemTo: (type, who) => {
      if (draftShopState().locked) return;
      const def = ITEM_TYPES[type];
      const cost = market.quoteBuy(type, 1, priceMult());
      if (!def || career.money < cost) return;
      const ch = getChar(who);
      if (!ch) return;
      career.money -= cost;
      market.buy(type);
      if (career.mode === 'liquidation') recordPlayerMarket('buy', type, cost);
      const it = makeItem(type);
      if (def.kind === 'gun') {
        if (!ch.gear.gun1) ch.gear.gun1 = it;
        else if (!ch.gear.gun2) ch.gear.gun2 = it;
        else autoPlace(career.stash, it);
      } else if (def.kind === 'armor') {
        if (!ch.gear[def.slot]) ch.gear[def.slot] = it;
        else autoPlace(career.stash, it);
      } else {
        if (!autoPlace(ch.pack, it)) autoPlace(career.stash, it); // pack full → stash
      }
      audio.cashRegister(); save(); renderShop(earnings);
    },
    train: (who, skillId) => {
      if (draftShopState().locked) return;
      const isPlayer = who === 'player';
      const member = isPlayer ? null : career.crew[Number(who)];
      const progress = isPlayer ? career.playerProgress : member?.progress;
      const type = isPlayer ? PLAYER_TYPE : member?.type;
      if (progress && buyTraining(progress, type, skillId)) {
        if (career.mode === 'liquidation') emitCareerEvent('liquidation_training', {
          target: isPlayer ? 'YOU' : member.name,
          skill_id: skillId,
          state: careerSnapshot(),
        });
        audio.cashRegister(); save(); renderShop(earnings);
      }
    },
  });
}

function showIntro() {
  if (career.mode === 'liquidation' && career.liquidation.draft.pendingEnemyShop) {
    openShop();
    return;
  }
  phase = 'intro';
  const liquidation = career.mode === 'liquidation';
  const liquidationBets = liquidation ? liquidationBetOptions(career.liquidation, career.money) : [];
  career.bet = liquidation ? (liquidationBets[1] || liquidationBets[0] || 0) : 0;
  const squad = career.mode === 'liquidation'
    ? { name: 'THE RIVAL SYNDICATE', blurb: `Round ${career.liquidation.round}. Choose your stake; a poorer squad receives longer comeback odds.` }
    : SQUADS[career.rank];
  const rerender = () => ui.renderIntro(career, squad, liquidation ? liquidationOdds(career.liquidation, career.money) : betOdds(), (amt) => {
    if (amt <= career.money) {
      career.bet = amt;
      audio.uiClick();
      rerender();
    }
  }, liquidationBets);
  rerender();
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
    if (match?.spectating && !e.repeat && (e.code === 'KeyA' || e.code === 'KeyD')) {
      cycleSpectator(e.code === 'KeyD' ? 1 : -1);
      return;
    }
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
  if (touchMode) return; // no pointer to lock; the touch layer drives input
  try {
    if (navigator.keyboard?.lock) await navigator.keyboard.lock([...GAME_KEYS]);
  } catch { /* unsupported — fine */ }
  // may reject without user activation (gamepad Start resume) — pad play doesn't need the lock
  try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch { /* fine */ }
}
document.addEventListener('wheel', (e) => { if (locked && phase === 'match') player.onWheel(e.deltaY); });

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  player.clearInput();
  if (!locked && phase === 'match' && (player.alive || match.spectating) && !match.ended) {
    // pointer-lock loss only pauses mouse players; a controller plays unlocked
    if (input.gamepadActive) return;
    ui.showScreen('pause');
    phase = 'paused';
  }
});

// pause/resume paths that don't depend on pointer lock (gamepad Start, touch button)
function pauseMatch() {
  if (phase !== 'match' || match?.ended || (!player.alive && !match?.spectating)) return;
  if (document.pointerLockElement) document.exitPointerLock();
  player.clearInput();
  ui.showScreen('pause');
  phase = 'paused';
}
function resumeFromPause() {
  if (phase !== 'paused') return;
  phase = 'match';
  ui.showHUDOnly();
  enterCombatMode();
}
function openSettings() {
  if (phase !== 'menu' && phase !== 'paused') return;
  settingsReturnPhase = phase;
  phase = 'settings';
  document.getElementById('settings-overlay').classList.remove('hidden');
}
function closeSettings() {
  if (phase !== 'settings') return;
  document.getElementById('settings-overlay').classList.add('hidden');
  phase = settingsReturnPhase;
  document.dispatchEvent(new CustomEvent('screenchange', { detail: phase }));
}

// ============================================================ buttons
const on = (id, fn) => document.getElementById(id).addEventListener('click', () => { audio.init(); audio.resume(); audio.uiClick(); fn(); });

on('btn-new', () => { career = newCareer('circuits'); market = createMarket('circuits'); save(); showIntro(); });
on('btn-new-liquidation', () => { career = newCareer('liquidation'); market = createMarket('liquidation'); save(); openShop(); });
on('btn-continue', () => { showIntro(); });
on('btn-menu-settings', () => openSettings());
on('btn-fight', () => startMatch());
on('btn-next-fight', () => {
  if (!draftShopState().mustEndTurn) showIntro();
});
on('btn-retry', () => openShop());
on('btn-intro-back', () => { career.bet = 0; openShop(); });
function returnToMainMenu() {
  localStorage.removeItem(SAVE_KEY);
  career = newCareer('circuits');
  market = createMarket('circuits');
  document.getElementById('btn-continue').classList.add('hidden');
  document.getElementById('btn-new').textContent = 'NEW CIRCUITS CAREER';
  ui.showScreen('menu');
  phase = 'menu';
}
on('btn-newgame', () => {
  if (career.mode === 'liquidation' && career.liquidation?.complete) returnToMainMenu();
  else openShop(); // circuits: next lap is already armed
});
on('btn-executed-new', () => {
  if (career.mode === 'liquidation' && career.liquidation?.complete) returnToMainMenu();
  else { career = newCareer(); save(); showIntro(); }
});
on('btn-resume', () => resumeFromPause());
on('btn-pause-settings', () => openSettings());
on('btn-settings-close', () => closeSettings());
document.getElementById('settings-overlay').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeSettings();
});
on('btn-abandon', () => {
  if (career.bet > 0) {
    career.money += career.bet;
    if (career.mode === 'liquidation') career.liquidation.enemyMoney += career.bet;
    career.bet = 0;
  } // no contest, stake returned
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
market = createMarket(career.mode, career.liquidation?.market);
ui.showScreen('menu');

// idle backdrop camera for menu
camera.position.set(0, 8, 20);
camera.lookAt(0, 1, 0);

// ============================================================ loop
const clock = new THREE.Clock();

const _aimTmp = new THREE.Vector3();
const _spectatorPos = new THREE.Vector3();
const _spectatorLook = new THREE.Vector3();

function updateSpectatorCamera(dt) {
  if (!match.spectatorTarget?.alive) cycleSpectator(1);
  const target = match.spectatorTarget;
  if (!target) return;
  const forwardX = Math.sin(target.yaw);
  const forwardZ = Math.cos(target.yaw);
  _spectatorPos.set(
    target.pos.x - forwardX * 3.8,
    target.pos.y + 2.5,
    target.pos.z - forwardZ * 3.8,
  );
  camera.position.lerp(_spectatorPos, 1 - Math.exp(-dt * 7));
  _spectatorLook.set(target.pos.x + forwardX * 2, target.pos.y + 1.25, target.pos.z + forwardZ * 2);
  camera.lookAt(_spectatorLook);
  const alive = livingCrew();
  ui.showSpectator(target.name, Math.max(0, alive.indexOf(target)), alive.length);
}

function stepMatch(dt) {
  match.time += dt;
  player.update(dt, locked || touchMode || input.gamepadActive);

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
  if (match.spectating) updateSpectatorCamera(dt);
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
  get input() { return input; },
  get controllerSettings() { return input.controllerSettings; },
  tuning: { STICK, TOUCH, AIM_ASSIST },
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
  input.update(dt, phase); // gamepad + touch → player (runs in pause too, for Start-resume)
  if (touch) {
    touch.setVisible(phase === 'match');
    touch.setSpectating(phase === 'match' && !!match?.spectating);
  }

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
