import * as THREE from 'three';
import { buildArena, updateArenaAmbience, ARENA } from './arena.js';
import { FX } from './fx.js';
import { Player } from './player.js';
import { Combatant } from './combatant.js';
import { Announcer, AnnouncerVoiceBank } from './announcer.js';
import { UI, nextCrewName } from './ui.js';
import { WEAPONS, WEAPON_ORDER, preloadWeapons, buildHeldGun, SUPPORT_GRIP } from './weapons.js';
import { audio } from './audio.js';
import { NavMesh } from './nav.js';
import { broadcastNoise, contactRadius } from './perception.js';
import { laneIsHot, shareHitGround } from './suppression.js';
import {
  LANE_TEST, laneTestColliders, buildLaneTestMeshes, buildLaneTestMarkers, spotAt,
} from './lane-test.js';
import { RenderPipeline, QUALITY_TIERS } from './render.js';
import { NO_OCCLUDE_LAYER } from './layers.js';
import { SpectatorCamera } from './spectator-camera.js';
import { preloadFighter, fighterReady, FighterRig } from './fighter-rig.js';
import { preloadViewmodel } from './viewmodel.js';
import {
  ITEM_TYPES, AMMO_TYPES, makeItem, autoPlace, removeFromGrid, canPlace,
  makeCharacter, characterWeight, weightSpeedMult, armorMits, countInPack, useFromPack,
  ammoInGrid, ammoInPack, addAmmoToPack, extractAmmoFromPack, takeAmmoFromGrid, consumeAmmo,
  bestUsableGun, buildAmmoPools, STASH_COLS,
} from './items.js';
import { createMarket } from './market.js';
import { InputHub, STICK, TOUCH, AIM_ASSIST } from './input.js';
import { TouchControls, isTouchDevice } from './touch.js';
import { TouchSettingsPanel } from './touch-settings.js';
import { MenuNavigator } from './ui-nav.js';
import { ControllerSettingsPanel } from './controller-settings.js';
import { analytics } from './analytics.js';
import { MatchLifecycle, markKnownOutcome } from './match-lifecycle.js';
import { isXboxBrowser, requestBrowserFullscreen } from './platform.js';
import { showGraphicsStartupFailure } from './graphics-startup.js';
import { createRuntimeDiagnostics, runtimeDiagnosticsEnabled } from './runtime-diagnostics.js';
import {
  newLiquidationState, fundDraftRound, runLiquidationAI, enemyRoster,
  liquidationOdds, liquidationBetOptions, canPlaceLiquidationBet, recordLiquidationOutcome,
  resupplyLiquidation, draftCanCoverDebt, allocateRivalSupply,
  recordMarketRound, recordMarketTrade, commitPlayerDraftTurn, liquidationRivalStake,
} from './liquidation.js';
import {
  PLAYER_TYPE, HIRE_TYPES, createProgression, normalizeProgression, buyTraining,
  combatProfile, emptyXpStats, calculateXp, grantXp,
} from './progression.js';
import {
  CREW_CONTRACT_CAP, DEPLOYED_CREW_CAP, deployedCrewCount,
  normalizeCrewDeployment, shouldBenchNewHire,
} from './roster.js';
import {
  AUTO_AMMO_STACKS, orderedSquad, planSquadAmmo, planSquadHealing, planSquadTraining,
} from './squad-auto.js';

// ============================================================ sandbox
/**
 * Debug bench: an empty arena with a chosen loadout.
 *
 *   ?sandbox                     every weapon, nothing shooting back
 *   ?sandbox=rifle,shotgun       just those, in slots 1 and 2
 *   ?sandbox=rifle&god=0         let the arena's own hazards hurt you
 *
 * Also callable live as `__game.sandbox('rifle')`.
 *
 * Animation and VFX work needs long uninterrupted looks at a weapon in the real
 * renderer, which a live bout does not allow — the fighters kill you, the match ends,
 * and the thing you were watching is gone. This spawns no opposition, keeps the match
 * from ending on an empty arena, and (by default) makes the player invulnerable.
 */
const sandbox = {
  active: false, god: true, publicRange: false, weapons: [],
  savedCareer: null, savedMarket: null, hits: 0, headshots: 0, damage: 0,
};

function updateRangePanel() {
  const panel = document.getElementById('range-panel');
  panel?.classList.toggle('hidden', !sandbox.active);
  const stats = document.getElementById('range-stats');
  if (stats) stats.textContent = `${sandbox.hits} HITS · ${sandbox.headshots} HEADSHOTS · ${Math.round(sandbox.damage)} DAMAGE`;
}

function spawnRangeTarget(pos, label) {
  const group = new THREE.Group();
  const plate = new THREE.MeshBasicMaterial({ color: 0xd8d3c3 });
  const bull = new THREE.MeshBasicMaterial({ color: 0xe3242b });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.10), plate);
  torso.position.y = 0.86;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 10), bull);
  head.position.y = 1.48;
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), new THREE.MeshBasicMaterial({ color: 0x4d4a45 }));
  post.position.y = 0.36;
  group.add(post, torso, head);
  group.position.copy(pos);

  const target = {
    name: label, team: 'enemy', alive: true, scale: 1, pos: pos.clone(), group,
    parts: [torso, head],
    aimPoint(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + 1.12, this.pos.z); },
    applyDamage(targetWorld, part, damage, shooter, point) {
      sandbox.hits++;
      sandbox.damage += damage;
      if (part === 'head') sandbox.headshots++;
      updateRangePanel();
      targetWorld.onHitmarker?.(false, part === 'head');
      targetWorld.fx.sparks(point, null, null, false);
      const material = part === 'head' ? bull : plate;
      const old = material.color.getHex();
      material.color.setHex(0xffb92e);
      setTimeout(() => material.color.setHex(old), 70);
    },
    update() {},
    removeFrom(targetWorld) {
      targetWorld.scene.remove(group);
      targetWorld.combatants = targetWorld.combatants.filter(c => c !== this);
      targetWorld.hitMeshes = targetWorld.hitMeshes.filter(mesh => mesh.userData.combatant !== this);
      torso.geometry.dispose(); head.geometry.dispose(); post.geometry.dispose();
      plate.dispose(); bull.dispose(); post.material.dispose();
    },
  };
  torso.userData = { combatant: target, part: 'torso' };
  head.userData = { combatant: target, part: 'head' };
  scene.add(group);
  world.combatants.push(target);
  world.hitMeshes.push(torso, head);
  group.updateMatrixWorld(true);
  return target;
}

function setupFiringRange() {
  // Start beyond the protective gate, looking straight down the target lane. A live
  // bout opens angled toward the gate's right-hand gap; that is useful under fire and
  // confusing in a range, where the first frame should already explain the mode.
  player.pos.set(0, 0, 8.5);
  player.vel.set(0, 0, 0);
  player.yaw = 0;
  player.pitch = 0;
  player.slots = [...sandbox.weapons];
  player.slotIdx = 0;
  player.knifeOut = false;
  player.infiniteAmmo = true;
  player.hideKnifeSlot = true;
  player.magBySlot = player.slots.map(id => WEAPONS[id].mag);
  player.mag = WEAPONS[player.slots[0]].mag;
  // A weapon handed over loaded has a round up as well as a full magazine. Setting the
  // magazine without the chamber leaves the gun unable to fire until it is racked.
  player.chamberBySlot = player.slots.map(() => true);
  player.chambered = true;
  player._mountViewmodel();
  sandbox.hits = 0; sandbox.headshots = 0; sandbox.damage = 0;
  [
    [-4.8, 0, 1.5, 'CLOSE PLATE'],
    [0, 0.45, 1.5, 'CENTER PLATE'],
    [4.8, 0, 1.5, 'RIGHT PLATE'],
  ].forEach(([x, y, z, label]) => spawnRangeTarget(new THREE.Vector3(x, y, z), label));
  updateRangePanel();
  ui.eventBanner('FIRING RANGE', 'Y / MOUSE WHEEL cycles every gun · ammunition is unlimited', 'var(--gold)');
}

function leaveFiringRange() {
  clearCombatants();
  player.infiniteAmmo = false;
  player.hideKnifeSlot = false;
  sandbox.active = false;
  updateRangePanel();
  career = sandbox.savedCareer || newCareer('circuits');
  market = sandbox.savedMarket || createMarket(career.mode, career.liquidation?.market);
  sandbox.savedCareer = null;
  sandbox.savedMarket = null;
  const hasSave = !!load();
  document.getElementById('btn-continue').classList.toggle('hidden', !hasSave);
  document.getElementById('btn-new').textContent = hasSave ? 'NEW CAREER (WIPES SAVE)' : 'NEW CIRCUITS CAREER';
  ui.showScreen('menu');
  phase = 'menu';
}

function enterSandbox(weapons = null, { god = true, publicRange = false } = {}) {
  const list = (Array.isArray(weapons) ? weapons : String(weapons || '').split(','))
    .map((w) => w.trim())
    .filter((w) => WEAPON_ORDER.includes(w));
  sandbox.active = true;
  sandbox.god = god;
  sandbox.publicRange = publicRange;
  sandbox.weapons = list.length ? list : [...WEAPON_ORDER];
  if (publicRange) {
    sandbox.savedCareer = career;
    sandbox.savedMarket = market;
  }

  career = newCareer('circuits');
  career.rank = 15;
  market = createMarket('circuits');

  // Stock the pack so every weapon has rounds, and put the requested guns in hand.
  const pack = career.playerCh.pack;
  for (const ammo of ['ammo_9mm', 'ammo_buck', 'ammo_762', 'ammo_308']) {
    for (let i = 0; i < 3; i++) autoPlace(pack, makeItem(ammo));
  }
  const chosen = sandbox.weapons;
  for (const id of chosen.slice(0, 2)) autoPlace(pack, makeItem(id));

  startMatch();
  return chosen;
}

// ============================================================ graphics quality
const QUALITY_KEY = 'thunderdome-quality';
const xboxBrowser = isXboxBrowser();
if (xboxBrowser) document.body.classList.add('xbox-browser');
const runtimeDiagnostics = createRuntimeDiagnostics({
  // Detailed timing is normal operational telemetry now, not a debug mode that a
  // player has to discover and activate. Keep one emergency URL opt-out.
  autoCreate: runtimeDiagnosticsEnabled(location.search),
});
runtimeDiagnostics?.ready.then(session => {
  if (!session?.label) return;
  const label = document.getElementById('diagnostic-session-label');
  label.textContent = `DIAG · ${session.label}`;
  label.classList.remove('hidden');
});

// Function declaration, not const: this runs during module setup, above its own
// definition in source order.
function loadGraphicsQuality() {
  const saved = localStorage.getItem(QUALITY_KEY);
  if (QUALITY_TIERS.includes(saved)) return saved;
  // First run: guess from the device rather than dropping a phone straight into the
  // full post stack. Touch-primary hardware and small logical viewports start low.
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 700;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarse && smallScreen) return 'low';
  if (cores <= 4) return 'medium';
  return 'high';
}

function saveGraphicsQuality(name) {
  localStorage.setItem(QUALITY_KEY, name);
}

// ============================================================ setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080b);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
scene.add(camera);

let pipeline;
try {
  pipeline = new RenderPipeline(scene, camera, {
    quality: loadGraphicsQuality(),
    container: document.getElementById('app'),
  });
} catch (error) {
  console.error('[graphics] WebGL startup failed', error);
  showGraphicsStartupFailure(error, { xbox: xboxBrowser });
  throw error;
}
const renderer = pipeline.renderer;

// Keep every menu completely free of GLTF parsing, GPU uploads, audio decoding and
// shader compilation. The NIMBLE-WOMBAT trace caught a 2.1 s shader-prep long task
// over the live PC menu; this gate now opens only after FIGHT or FIRING RANGE on
// every platform, behind an unmistakable loading screen.
let resolveCombatAssetGate;
let combatAssetLoadingStarted = false;
let voiceReady = Promise.resolve();
const combatAssetGate = new Promise(resolve => { resolveCombatAssetGate = resolve; });
function beginCombatAssetLoading() {
  if (combatAssetLoadingStarted) return;
  combatAssetLoadingStarted = true;
  showGraphicsPrep('LOADING ARENA', 'STREAMING FIGHTERS AND WEAPONS');
  prepareGrenadeMeshPool();
  // Xbox Edge has only reported 2 GB of browser memory. Eagerly decoding one clip
  // from all 26 categories added persistent PCM pressure immediately before the
  // trace's regular 100-165 ms pauses. Its reliable HTML media path stays lazy.
  voiceReady = xboxBrowser ? Promise.resolve() : announcer.prepare();
  resolveCombatAssetGate?.();
}

const arena = buildArena(scene, { loadGate: combatAssetGate });
pipeline.onShadowMapSize = (size) => arena.setShadowMapSize(size);
pipeline.onShadowMapSize(pipeline.tier.shadowMap);

// Combat assets start only from the explicit transition above. This keeps both
// mouse and controller menus responsive while the player is choosing what to do.
const assetsReady = combatAssetGate.then(() => Promise.all([
  arena.propsReady, preloadFighter(), preloadWeapons(), preloadViewmodel(),
]));
// A core asset failing to load used to be swallowed by the loaders, and the game
// carried on with invisible weapons or bare hands — the failure only surfaced as a
// gameplay bug report. The loaders now rethrow, and this is the one place the
// rejection is made impossible to miss. (Arena props are absent on purpose: they
// have designed primitive fallbacks and a match without a fancy crate is fine.)
assetsReady.catch((err) => {
  console.error('[assets] a core asset failed to load; the game cannot start a match', err);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;'
    + 'background:#7a1010;color:#fff;font:13px monospace;padding:10px 14px;';
  el.textContent = `ASSET LOAD FAILED: ${err?.message || err} — see the console.`;
  document.body.appendChild(el);
});
/**
 * Compile every program the first match will need, behind the menu.
 *
 * Nothing else ever calls renderer.compile(), so before this the first frame of the
 * first match compiled every fighter, gun and effect program at once — a stall of
 * hundreds of ms that also drove the adaptive scaler through a staircase of
 * resolution steps (each of which used to paint a black frame; see render.js).
 * Small representative groups are parked far below the pit one at a time —
 * compile() ignores the frustum and the menu camera never sees them — and compiled
 * in the driver's own threads where KHR_parallel_shader_compile allows.
 *
 * The muzzle-flash sprites are built invisible and compile() skips invisible
 * objects, so they are flipped visible for their own small compile job.
 *
 * Nothing staged here is disposed afterwards: disposing a material drops the
 * cached program's refcount and can delete the very program this exists to keep.
 * The stage is simply removed and the JS objects go to the collector, which leaves
 * the program cache alone.
 *
 * Out of reach: shadow-depth and GTAO-override variants only compile when their
 * pass first draws a fighter, so the first match frame still pays for two or three
 * skinned variants — small, and the deferred resize keeps it invisible — against
 * the dozens removed here.
 */
async function warmShaderCache({ between = async () => {} } = {}) {
  const eventProps = () => {
    const bounty = makeBountyMarker();
    bounty.visible = true;
    return [
      new THREE.Mesh(ZONE_GEO, ZONE_MATS.fire),
      new THREE.Mesh(ZONE_GEO, ZONE_MATS.gas),
      bounty,
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x8a6d2f, roughness: 0.8, metalness: 0.1 })),
      new THREE.Mesh(NADE_GEO, NADE_MAT),
    ];
  };
  const jobs = [
    { label: 'fighter', objects: () => [new FighterRig({ uniformColor: 0x3a4a5f }).group] },
    ...WEAPON_ORDER.map(id => ({ label: `weapon-${id}`, objects: () => [buildHeldGun(id)] })),
    { label: 'events', objects: eventProps },
    { label: 'effects', objects: () => [] },
  ];

  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    const stage = new THREE.Group();
    stage.position.set(0, -80, 0);
    stage.add(...job.objects());
    scene.add(stage);
    const restore = [];
    if (job.label === 'effects') {
      const show = (o) => { restore.push([o, o.visible]); o.visible = true; };
      for (const f of fx.flashes) show(f.sprite);
    }

    try {
      await renderer.compileAsync(scene, camera);
    } catch {
      try { renderer.compile(scene, camera); } catch { /* lazy compile remains the backstop */ }
    } finally {
      for (const [o, v] of restore) o.visible = v;
      scene.remove(stage);
    }
    await between(job.label, index + 1, jobs.length);
  }
}

// Preparation is armed at boot but blocked by combatAssetGate until the player
// explicitly starts a bout. It advertises real progress, yields between small jobs,
// and pauses during a bout.
let graphicsPrepScheduled = false;
let graphicsPrepStage = 'not-scheduled';
let lastControllerActivityAt = -Infinity;
const loadingTitleEl = document.getElementById('loading-title');
const loadingStageEl = document.getElementById('loading-stage');
const loadingDetailEl = document.getElementById('loading-detail');
const loadingMeterEl = document.getElementById('loading-meter-fill');
let resolveGraphicsReady;
const graphicsReady = new Promise(resolve => { resolveGraphicsReady = resolve; });
function showGraphicsPrep(stage, detail, progress = null) {
  if (loadingStageEl) loadingStageEl.textContent = stage;
  if (loadingDetailEl) loadingDetailEl.textContent = detail;
  if (loadingMeterEl && progress != null) loadingMeterEl.style.width = `${Math.round(progress * 100)}%`;
}
function finishGraphicsPrepStatus(detail = 'REFLECTIONS AND SHADERS READY') {
  showGraphicsPrep('ARENA READY', detail, 1);
}
function scheduleBackgroundGraphicsPrep() {
  if (graphicsPrepScheduled) return;
  graphicsPrepScheduled = true;
  graphicsPrepStage = 'waiting-for-assets';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const idle = () => new Promise(resolve => {
    if (window.requestIdleCallback) window.requestIdleCallback(resolve, { timeout: 800 });
    else setTimeout(resolve, 0);
  });
  const prepTurn = async (stage, detail) => {
    graphicsPrepStage = stage;
    const face = stage.match(/reflection-face-(\d)/)?.[1];
    const progress = face ? 0.68 + Number(face) * 0.04 : stage === 'environment' ? 0.68 : 0.94;
    showGraphicsPrep('PREPARING ARENA', detail, progress);
    while (phase === 'match' || phase === 'paused'
      || (xboxBrowser && performance.now() - lastControllerActivityAt < 1200)) {
      await delay(250);
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    await idle();
    if (phase === 'match' || phase === 'paused') return prepTurn(stage, detail);
  };
  assetsReady.then(async () => {
    await voiceReady;
    // Xbox Edge produced a white composer target after an explicit whole-scene
    // compile. Let the first reflection render compile the same arena programs via
    // the normal render path that is known to leave its WebGL state valid. Name the
    // work before it begins so the long driver pass is not mislabeled as face 0/6.
    await prepTurn('environment', xboxBrowser
      ? 'COMPILING ARENA MATERIALS · FIRST DRIVER PASS'
      : 'BAKING REFLECTIONS · 0/6');
    await pipeline.bakeEnvironment({
      size: xboxBrowser ? 64 : 128,
      // Six identical-quality faces, yielded between frames. Desktop used to bake
      // all six in one synchronous call; splitting the work changes scheduling,
      // not the resulting reflection map.
      incremental: true,
      shadows: !xboxBrowser,
      yieldTurn: async label => {
        const face = label.match(/reflection-face-(\d)/)?.[1];
        await prepTurn(label, face ? `BAKING REFLECTIONS · ${face}/6` : 'FILTERING REFLECTIONS');
      },
    });
    if (!xboxBrowser) {
      await prepTurn('shaders', 'COMPILING FIGHTERS AND EFFECTS');
      await warmShaderCache({
        between: async (label, done, total) => prepTurn(
          `shaders-${label}`,
          `COMPILING SHADERS · ${done}/${total}`,
        ),
      });
    }
    graphicsPrepStage = 'complete';
    finishGraphicsPrepStatus(xboxBrowser
      ? 'REFLECTIONS READY · SHADERS STREAM ON DEMAND'
      : 'REFLECTIONS AND SHADERS READY');
    resolveGraphicsReady?.();
  }).catch(() => { /* assetsReady already reported */ });
}

const fx = new FX(scene, camera);   // the camera keeps particle sizes in world units
const ui = new UI();
const menuNavigator = new MenuNavigator();
const announcer = new Announcer({
  voiceBank: new AnnouncerVoiceBank({ AudioContextCtor: xboxBrowser ? null : undefined }),
  onVoiceStart: details => runtimeDiagnostics?.emit('game_announcer_start', details),
});

// ============================================================ world
const world = {
  scene,
  // Two collision representations, on purpose. `colliders` are the simplified boxes
  // that movement, navigation and ground height run against — the right tool for
  // sweeping a capsule. `solids` is the arena's real triangles, which every *ray*
  // uses: shots, sightlines, grenade occlusion, and how far you can lean out past a
  // corner. See src/meshcollider.js.
  colliders: arena.colliders,
  solids: arena.solids,
  combatants: [],
  hitMeshes: [],
  zones: [],
  fx,
  // The clock the AI's perception runs on. Advanced once per simulated frame rather
  // than read from `performance.now`, so a headless batch and a live match age
  // contacts identically — the telemetry is only worth anything if they do.
  simTime: 0,
  cameraPos: camera.position,
  enemyDmgScale: 0.85,
  playerProxy: { isPlayer: true, team: 'player', alive: true, pos: new THREE.Vector3(), heightScale: 1, name: 'YOU' },
  playerAim: new THREE.Vector3(0, 0, -1),
  playerShooter: { isPlayer: true, team: 'player', name: 'YOU' },
  onPlayerDamaged: (dmg, part, fromPos, shooter, range) =>
    handlePlayerDamaged(dmg, part, fromPos, shooter, range),
  onKill: (killer, victim, part) => handleKill(killer, victim, part),
  onDamage: (shooter, victim, amount) => handleXpDamage(shooter, victim, amount),
  onSupport: (supporter, amount) => handleXpSupport(supporter, amount),
  onHitmarker: (kill, headshot) => ui.hitmarker(kill, headshot),
};

world.nav = new NavMesh(arena.colliders);

/**
 * Something made a noise, and the people who could hear it now know a little.
 *
 * The single entry point for every sound that carries information: gunshots,
 * sprinting boots, rounds landing, grenades. Bots turn it into an approximate
 * contact — never an exact one — and the player is the source of most of it, which
 * is what makes moving quietly a real decision rather than a cosmetic one.
 */
/**
 * (Re)install the world hooks that outlive any one match.
 *
 * `startMatch` already rebuilds the per-match callbacks; these two used to be
 * assigned once at module load and never again, which made them the only hooks a
 * test harness could stub *permanently*. An A/B that replaced `reportHit` for one
 * arm silently kept the replacement for every run afterwards, so the second arm
 * measured the first arm's behaviour and the comparison came out as noise dressed
 * up as a result. Anything installed here is restored at the start of every bout.
 */
function installWorldHooks() {
  world.emitNoise = (source, pos, kind, weight = 1, dir = null) => broadcastNoise(
    world,
    // The player fires as `playerShooter` but is *targeted* as `playerProxy`.
    // Contacts are keyed by entity, so they have to collapse to one identity here or
    // a bot ends up holding a belief about somebody who is never a candidate to
    // shoot at.
    source === world.playerShooter ? world.playerProxy : source,
    pos, kind, world.simTime, weight, dir,
  );

  // Somebody just got hit standing here, and said so. The squad's record of ground
  // that has actually drawn blood, as opposed to ground a gun is presumed to cover.
  world.reportHit = (victim, pos) => shareHitGround(world, victim, pos, world.simTime);

  /**
   * "Taking the left." Spread, without anybody reading anybody's mind.
   *
   * Lane assignment walked the live squad roster, which is a fighter knowing what
   * four other men intend without being told — and it still produced a mob, because
   * everyone then re-costed their way onto the same safe approach anyway. This is the
   * same coordination bought honestly: he says it, and the men near enough to hear
   * take it into account. Out of earshot is out of the loop.
   */
  world.callLane = (caller, lane, target) => {
    let told = 0;
    for (const mate of world.combatants) {
      if (!mate.alive || mate === caller || mate.team !== caller.team) continue;
      if (!mate.hearLaneCall) continue;
      if (Math.hypot(mate.pos.x - caller.pos.x, mate.pos.z - caller.pos.z) > LANE_CALL_RANGE) continue;
      mate.hearLaneCall(caller, lane, target, world.simTime);
      told++;
    }
    return told;
  };
}

/** How far "taking the left" carries. A shout, not a radio. */
const LANE_CALL_RANGE = 26;

installWorldHooks();

const player = new Player(camera, world);
// Combat telemetry treats the first-person player like every other shooter.
// Keep its position live so shot and damage events include the actual firing
// coordinate instead of a null placeholder.
world.playerShooter.pos = player.pos;
const spectatorCamera = new SpectatorCamera(camera, arena, {
  halfWidth: ARENA.W / 2 - 1,
  halfDepth: ARENA.D / 2 - 1,
});

// controller + touch input (mouse/keyboard bypass this and get no aim assist)
const touchMode = isTouchDevice({ excluded: xboxBrowser });
if (touchMode) document.body.classList.add('touch-mode');
const onCycleSpectator = (dir) => { if (phase === 'match' && match?.spectating) cycleSpectator(dir); };
const touch = touchMode ? new TouchControls(player, { onPause: () => pauseMatch(), onCycleSpectator }) : null;
const input = new InputHub(player, world, camera, {
  touch,
  onPause: () => pauseMatch(),
  onResume: () => resumeFromPause(),
  onCycleSpectator,
  onMenuInput: (action) => menuNavigator.handle(action),
  onControllerActive: () => {
    lastControllerActivityAt = performance.now();
    menuNavigator.activate();
  },
});
new TouchSettingsPanel(touch, input);
const controllerSettingsPanel = new ControllerSettingsPanel(input);
const matchLifecycle = new MatchLifecycle({ analytics });

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
          c.liquidation.playerLossStreak ||= 0;
          c.liquidation.enemyLossStreak ||= 0;
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
renderer.domElement.addEventListener('webglcontextlost', event => {
  runtimeDiagnostics?.emit('game_webgl_context_lost', {
    status_message: event.statusMessage || null,
    phase,
    graphics_prep: graphicsPrepStage,
  });
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  runtimeDiagnostics?.emit('game_webgl_context_restored', {
    phase,
    graphics_prep: graphicsPrepStage,
  });
});
scheduleBackgroundGraphicsPrep();
let settingsReturnPhase = 'menu';
let locked = false;
let match = null;

if (runtimeDiagnostics && globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
  let lastLongTaskReportAt = -Infinity;
  const longTaskObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.startTime - lastLongTaskReportAt < 1000) continue;
      lastLongTaskReportAt = entry.startTime;
      runtimeDiagnostics.emit('game_long_task', {
        duration_ms: +entry.duration.toFixed(2),
        start_ms: +entry.startTime.toFixed(2),
        phase,
        match_time: match ? +match.time.toFixed(3) : null,
      });
    }
  });
  longTaskObserver.observe({ entryTypes: ['longtask'] });
}

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
      playerLossStreak: liquidation.playerLossStreak || 0,
      enemyLossStreak: liquidation.enemyLossStreak || 0,
      enemyMoney: liquidation.enemyMoney,
      draft: { ...liquidation.draft },
      enemy: structuredClone(liquidation.enemy),
      market: market?.snapshot() ? structuredClone(market.snapshot()) : null,
    } : null,
  };
}

function fighterSnapshot(fighter) {
  if (fighter?.isPlayer && fighter !== player) return fighterSnapshot(player);
  const isPlayer = fighter === player || fighter?.isPlayer;
  const pos = fighter?.pos || { x: 0, y: 0, z: 0 };
  const armDmg = Number(fighter?.armDmg || 0);
  const legDmg = Number(fighter?.legDmg || 0);
  return {
    name: isPlayer ? 'YOU' : fighter?.name || 'UNKNOWN',
    team: isPlayer ? 'player' : fighter?.team || null,
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

function terminalSquadSnapshot() {
  const fighter = candidate => ({
    name: candidate?.isPlayer ? 'YOU' : candidate?.name || 'UNKNOWN',
    team: candidate?.isPlayer ? 'player' : candidate?.team || null,
    alive: candidate?.alive ?? null,
    hp: Number.isFinite(candidate?.hp) ? Math.round(candidate.hp) : null,
    maxHp: Number.isFinite(candidate?.maxHp) ? Math.round(candidate.maxHp) : null,
  });
  return {
    player: fighter(player),
    crew: (match?.crew || []).map(fighter),
    enemies: (match?.enemies || []).map(fighter),
  };
}

function preSettlementEconomySnapshot() {
  const liquidation = career?.liquidation;
  return {
    player_money: Number.isFinite(career?.money) ? career.money : null,
    stake: Number.isFinite(career?.bet) ? career.bet : null,
    rival_money: Number.isFinite(liquidation?.enemyMoney) ? liquidation.enemyMoney : null,
    player_wins: Number.isFinite(liquidation?.playerWins) ? liquidation.playerWins : null,
    rival_wins: Number.isFinite(liquidation?.enemyWins) ? liquidation.enemyWins : null,
    player_loss_streak: Number.isFinite(liquidation?.playerLossStreak) ? liquidation.playerLossStreak : null,
    rival_loss_streak: Number.isFinite(liquidation?.enemyLossStreak) ? liquidation.enemyLossStreak : null,
  };
}

function journalMatchEnter() {
  const metadata = {
    matchId: match.analyticsId,
    careerId: career.analyticsId,
    warId: career.mode === 'liquidation' ? career.analyticsId : null,
    mode: career.mode,
    round: career.liquidation?.round || null,
  };
  let payload = {};
  try {
    payload = {
      game_mode: career.mode,
      opening_plays: {
        player: match.crew.map(c => ({ name: c.name, role: c.role, goal: c.openingGoal?.toArray() })),
        enemy: match.enemies.map(c => ({ name: c.name, role: c.role, goal: c.openingGoal?.toArray() })),
      },
      career: careerSnapshot(),
      squads: matchSnapshot(),
    };
  } catch (error) {
    console.warn('analytics match_enter snapshot omitted', error);
  }
  try {
    matchLifecycle.begin(metadata, payload);
  } catch (error) {
    console.warn('analytics match_enter dropped', error);
  }
}

function journalTerminal(reason, winner = null) {
  try {
    const terminal = matchLifecycle.finalize(reason, () => ({
      winner,
      duration: Number.isFinite(match?.time) ? +match.time.toFixed(3) : null,
      kills: Number.isFinite(match?.kills) ? match.kills : 0,
      headshots: Number.isFinite(match?.headshots) ? match.headshots : 0,
      final_squad: terminalSquadSnapshot(),
      pre_settlement_economy: preSettlementEconomySnapshot(),
    }), { matchId: match?.analyticsId });
    if (match && terminal?.event_id) match.terminalEventId = terminal.event_id;
    return terminal;
  } catch (error) {
    console.warn('analytics terminal journal failed', error);
    return null;
  }
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

const READINESS_WEAPON_POWER = { knife: 0.55, pistol: 1, smg: 1.25, shotgun: 1.35, rifle: 1.6, dmr: 1.75 };

function characterReadinessPower(ch, hp, type, progress, isPlayer = false) {
  const profile = combatProfile(type, progress, isPlayer);
  const currentHp = hp == null ? profile.maxHp : Math.max(0, hp);
  const weapon = bestUsableGun(ch);
  const armor = armorMits(ch);
  const armorFactor = 1 + (armor.head + armor.body + armor.limbs) / 3;
  const supplies = countInPack(ch, 'medkit') + countInPack(ch, 'grenade') * 0.6 + countInPack(ch, 'splint') * 0.35;
  const skillFactor = profile.damageMult / Math.max(0.5, profile.damageTakenMult) *
    Math.max(0.75, profile.speedMult);
  return currentHp * (READINESS_WEAPON_POWER[weapon] || 1) * armorFactor * skillFactor * (1 + supplies * 0.04);
}

function playerSquadReadinessPower() {
  let power = characterReadinessPower(
    career.playerCh, career.playerHp, PLAYER_TYPE, career.playerProgress, true,
  );
  for (const member of career.crew
    .filter(candidate => !candidate.benched && (candidate.hp == null || candidate.hp > 0))
    .slice(0, DEPLOYED_CREW_CAP)) {
    power += characterReadinessPower(member.ch, member.hp, member.type, member.progress);
  }
  return Math.round(power);
}

function runTrackedLiquidationAI(reason) {
  const before = careerSnapshot();
  const signals = {
    hoarded9mm: market.info('ammo_9mm').pressure > 1.4,
    opponentPower: playerSquadReadinessPower(),
    opponentRoster: 1 + career.crew
      .filter(candidate => !candidate.benched && (candidate.hp == null || candidate.hp > 0))
      .slice(0, DEPLOYED_CREW_CAP).length,
    expectedStake: Math.max(250, Math.floor(Math.max(0, career.money) * 0.1 / 50) * 50),
  };
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
    terminalEventId: null,
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
  clearAirdrop();
  if (world.grenades) {
    for (const g of world.grenades) releaseGrenadeMesh(g.mesh);
    world.grenades.length = 0;
  }
}

function startMatch({ prepared = false } = {}) {
  if (career.mode === 'liquidation' && career.liquidation.draft.pendingEnemyShop) {
    openShop();
    return;
  }
  // Fighters are skinned GLB instances now, so a bout cannot begin until the model
  // is in memory. On Xbox, every part of that work happens on this dedicated screen.
  if (!prepared && (!fighterReady() || graphicsPrepStage !== 'complete')) {
    // This is intentionally called before the first await so a real FIGHT/START click
    // still owns browser activation and can enter fullscreen.
    enterCombatMode();
    phase = 'loading';
    ui.showScreen('loading');
    if (loadingTitleEl) loadingTitleEl.textContent = sandbox.active ? 'OPENING THE RANGE' : 'OPENING THE GATES';
    showGraphicsPrep('STREAMING COMBAT ASSETS', 'FIGHTERS · WEAPONS · ARENA PROPS', 0.08);
    // If the load failed, do not start a match with no fighters in it — the banner
    // from the `assetsReady` catch is already up and says why.
    beginCombatAssetLoading();
    if (!startMatch.assetWait) {
      startMatch.assetWait = true;
      // Give the loading screen two paints before any parser work can monopolize the
      // main thread. A static, explicit transition remains comprehensible even while
      // Edge is busy enough that its animation pauses.
      Promise.resolve()
        .then(() => new Promise(resolve => requestAnimationFrame(resolve)))
        .then(() => new Promise(resolve => requestAnimationFrame(resolve)))
        .then(() => assetsReady)
        .then(() => {
          showGraphicsPrep('FINALIZING THE ARENA', 'LIGHTING · REFLECTIONS · FIRST-FRAME SHADERS', 0.68);
          return graphicsReady;
        }).then(() => {
        startMatch.assetWait = false;
        startMatch({ prepared: true });
      }, () => { startMatch.assetWait = false; });
    }
    return;
  }
  // Request fullscreen while the trusted FIGHT click still owns browser activation;
  // the rest of match setup is intentionally substantial.
  enterCombatMode();
  clearCombatants();
  installWorldHooks();
  match = makeMatch();
  spectatorCamera.reset();
  const liquidation = career.mode === 'liquidation';
  world.onDamage = (shooter, victim, amount) => {
    handleXpDamage(shooter, victim, amount);
    emitCareerEvent('combat_damage', {
      time: +match.time.toFixed(3),
      shooter: shooter?.isPlayer ? 'YOU' : shooter?.name,
      shooter_team: shooter?.team,
      victim: victim?.name,
      victim_team: victim?.team,
      weapon: shooter?.weaponId || (shooter?.isPlayer ? player.weapon.id : null),
      amount: +amount.toFixed(2),
      range: shooter?.pos && victim?.pos ? +shooter.pos.distanceTo(victim.pos).toFixed(2) : null,
    });
  };
  world.onSupport = (supporter, amount) => {
    handleXpSupport(supporter, amount);
    emitCareerEvent('combat_support', {
      time: +match.time.toFixed(3),
      supporter: supporter?.name,
      supporter_team: supporter?.team,
      amount: +amount.toFixed(2),
    });
  };
  world.onCombatEvent = (type, fighter, detail) => emitCareerEvent(`combat_${type}`, {
    time: +match.time.toFixed(3),
    fighter: fighter?.isPlayer ? 'YOU' : fighter?.name,
    fighter_team: fighter?.team,
    position: fighter?.pos
      ? [fighter.pos.x, fighter.pos.y, fighter.pos.z].map(value => +value.toFixed(2))
      : null,
    ...detail,
  });
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
  (sandbox.active ? [] : roster).forEach((r, i) => {
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
  player.infiniteAmmo = false;
  player.hideKnifeSlot = false;
  if (sandbox.active) setupFiringRange();
  // player wounds carry over too
  if (career.playerHp != null) player.hp = Math.min(player.maxHp, career.playerHp);
  player.armDmg = career.playerLimbs.arm || 0;
  player.legDmg = career.playerLimbs.leg || 0;

  assignRoles();
  assignOpeningPlays();
  journalMatchEnter();

  match.campAnchor.x = player.pos.x;
  match.campAnchor.z = player.pos.z;
  world.globalDmgMult = 1;

  // escrow the bet
  if (liquidation) {
    career.bet = Math.max(250, career.bet || 0);
    match.betOdds = liquidationOdds(career.liquidation, career.money);
    match.enemyBetDecision = liquidationRivalStake(career.liquidation, {
      opponentPower: playerSquadReadinessPower(),
      expectedStake: 250,
    });
    match.enemyBet = match.enemyBetDecision.amount;
    match.enemyBetOdds = liquidationOdds({ enemyMoney: career.money }, career.liquidation.enemyMoney);
    career.money -= career.bet;
    career.liquidation.enemyMoney -= match.enemyBet;
  } else if (career.bet > 0) career.money -= career.bet;

  const revealMatch = () => {
    announcer.clear();
    if (!sandbox.active) announcer.say('matchStart', {}, { force: true });
    if (!sandbox.active && career.rank === 1) setTimeout(() => announcer.say('bossIntro', {}, { force: true }), 3000);
    audio.setCrowdLevel(0.055 + (10 - career.rank) * 0.004);
    audio.klaxon();
    phase = 'match';
    graphicsPrepStage = 'complete';
    ui.hideSpectator();
    ui.showHUDOnly();
  };

  // Desktop drivers tolerate an explicit assembled-bout compile and hidden composer
  // warmup. Xbox Edge does not: the August 8 trace reached this path and emerged
  // from loading with a permanently white camera target. On Xbox, reveal the match
  // and let its normal first render compile lazily, preserving valid WebGL state.
  if (!xboxBrowser && !startMatch.firstBoutWarmed) {
    startMatch.firstBoutWarmed = true;
    phase = 'loading';
    graphicsPrepStage = 'match-shaders';
    ui.showScreen('loading');
    showGraphicsPrep('FINALIZING COMBAT SCENE', 'COMPILING MATCH SHADERS · DRIVER PASS', 0.97);
    startMatch.warmPromise = Promise.resolve()
      .then(() => new Promise(resolve => requestAnimationFrame(resolve)))
      .then(async () => {
        try {
          await renderer.compileAsync(scene, camera);
        } catch {
          try { renderer.compile(scene, camera); } catch { /* the full pipeline pass below is the backstop */ }
        }
        showGraphicsPrep('FINALIZING COMBAT SCENE', 'WARMING POST EFFECTS · FINAL PASS', 0.99);
      })
      // Tick renders the complete composer between these two callbacks while the
      // simulation remains stopped in phase=loading.
      .then(() => new Promise(resolve => requestAnimationFrame(resolve)))
      .then(() => new Promise(resolve => requestAnimationFrame(resolve)))
      .then(revealMatch, revealMatch);
    return startMatch.warmPromise;
  }

  revealMatch();
  return Promise.resolve(match);
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
  if (!markKnownOutcome(match, { won: false, endDelay: 2.2 },
    () => journalTerminal('player_loss', 'rival'))) return;
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
  const crewContinues = livingCrew().length > 0;
  if (!crewContinues) endPlayerTeamLoss();
  player.clearInput();
  player.vmRoot.visible = false;
  if (crewContinues) {
    match.spectating = true;
    cycleSpectator(1);
    ui.eventBanner('YOU ARE DOWN', 'Your squad is still fighting', 'var(--gold)');
  }
}

function handleKill(killer, victim, part) {
  const headshot = part === 'head';
  const killerName = killer.isPlayer ? 'YOU' : killer.name;
  const enemyVictim = victim.team === 'enemy';
  let wonNow = false;

  // Commit gameplay accounting and any newly-known outcome before presentation,
  // payout, or non-terminal telemetry can fail.
  if (enemyVictim) {
    match.enemiesAlive--;
    match.kills++;
    if (headshot) match.headshots++;
    const xpStats = killer.isPlayer ? match.playerXp : killer.matchXp;
    if (killer.team === 'player' && xpStats) {
      xpStats.kills++;
      if (headshot) xpStats.headshots++;
    }
    if (killer.isPlayer) {
      player.stats.matchKills++;
      career.totals.kills++;
      if (headshot) {
        player.stats.matchHeadshots++;
        career.totals.headshots++;
      }
    } else if (killer.careerRef) {
      killer.careerRef.kills = (killer.careerRef.kills || 0) + 1;
    }
    wonNow = match.enemiesAlive <= 0 && !match.ended && !sandbox.active;
    if (wonNow) {
      markKnownOutcome(match, { won: true, endDelay: 2.0 },
        () => journalTerminal('player_win', 'player'));
    }
  } else if (victim.careerRef) {
    career.totals.crewLost++;
  }

  ui.killfeed(killerName, victim.name, headshot, killer.team === 'player');
  audio.crowdRoar(headshot ? 1 : 0.6);
  emitCareerEvent('combat_kill', {
    time: +match.time.toFixed(3),
    part,
    headshot,
    killer: fighterSnapshot(killer),
    victim: fighterSnapshot(victim),
  });
  runtimeDiagnostics?.emit('game_kill', {
    match_time: +match.time.toFixed(3),
    headshot,
    killer: killerName,
    killer_is_player: !!killer.isPlayer,
    victim: victim.name,
    weapon: killer.weaponId || null,
  });

  if (!match.firstBlood) {
    match.firstBlood = true;
    announcer.say('firstBlood', {}, { force: true });
  }

  if (enemyVictim) {
    let base = 140 + (15 - career.rank) * 20;
    if (victim.bountyT > 0) {
      base *= 3;
      ui.eventBanner('BOUNTY COLLECTED', `${victim.name} was worth triple`, 'var(--gold)');
    }
    if (killer.isPlayer) {
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
      announcer.say('allyKill', { killer: killer.name, victim: victim.name });
    }

    if (match.enemiesAlive === 1) announcer.say('lastEnemy', {}, { minGap: 30 });
    if (wonNow) {
      announcer.say(victim.boss ? 'champWin' : 'win', {}, { force: true });
      audio.crowdRoar(1); audio.crowdRoar(1);
    }
  } else {
    // crew member went down — they're bruised, not buried; gear stays theirs
    if (killer && killer.isPlayer) announcer.say('teamkill', { victim: victim.name }, { force: true });
    else announcer.say('enemyKillsAlly', { killer: killerName, victim: victim.name });
    if (!player.alive) cycleSpectator(1);
  }
}

function handlePlayerDamaged(dmg, part, fromPos, shooter = null, range = null) {
  if (sandbox.active && sandbox.god) return;   // the point of the bench is not dying
  if (!player.alive) return;
  const hpBefore = player.hp;
  player.takeDamage(dmg, part, fromPos);
  emitCareerEvent('combat_damage', {
    time: +match.time.toFixed(3),
    shooter: shooter?.name || null,
    shooter_team: shooter?.team || 'enemy',
    victim: 'YOU',
    victim_team: 'player',
    weapon: shooter?.weaponId || null,
    part,
    amount: +Math.min(hpBefore, Math.max(0, hpBefore - player.hp)).toFixed(2),
    range: Number.isFinite(range) ? +range.toFixed(2) : null,
  });
  ui.damageFlash();
  fx.blood(new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z));
  audio.crowdRoar(0.25);
  // The crew learn where the boss got hit the same way they learn it about each
  // other. Rate-limited to once a burst, matching the bots' own callout.
  if (match.time - (world._playerHitCall ?? -99) > 0.5) {
    world._playerHitCall = match.time;
    world.reportHit?.(world.playerProxy, player.pos);
  }

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
const NADE_MAT = new THREE.MeshStandardMaterial({ color: 0x2c3a2c, roughness: 0.55, metalness: 0.35 });
const GRENADE_POOL_SIZE = 16;
const grenadeMeshPool = [];
let grenadeMeshCursor = 0;
function prepareGrenadeMeshPool() {
  if (grenadeMeshPool.length) return;
  for (let i = 0; i < GRENADE_POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(NADE_GEO, NADE_MAT);
    mesh.visible = false;
    scene.add(mesh);
    grenadeMeshPool.push(mesh);
  }
}
function acquireGrenadeMesh() {
  prepareGrenadeMeshPool();
  for (let offset = 0; offset < GRENADE_POOL_SIZE; offset++) {
    const index = (grenadeMeshCursor + offset) % GRENADE_POOL_SIZE;
    if (grenadeMeshPool[index].visible) continue;
    grenadeMeshCursor = (index + 1) % GRENADE_POOL_SIZE;
    grenadeMeshPool[index].visible = true;
    return grenadeMeshPool[index];
  }
  // More than 16 simultaneous live grenades is outside any current roster, but
  // reusing the oldest pooled visual is still safer than allocating in combat.
  const mesh = grenadeMeshPool[grenadeMeshCursor];
  grenadeMeshCursor = (grenadeMeshCursor + 1) % GRENADE_POOL_SIZE;
  mesh.visible = true;
  return mesh;
}
function releaseGrenadeMesh(mesh) {
  if (mesh) mesh.visible = false;
}

world.grenades = [];
world.throwGrenade = (origin, vel, thrower) => {
  const mesh = acquireGrenadeMesh();
  mesh.position.copy(origin);
  world.grenades.push({ pos: origin.clone(), vel: vel.clone(), fuse: 2.8, mesh, thrower });
  // The spoon, the grunt, the arc: throwing gives away roughly where you threw from.
  if (thrower) world.emitNoise?.(thrower, origin, 'grenade');
  audio.reload(0);
  announcer.say('nade', {}, { minGap: 14 });
  runtimeDiagnostics?.emit('game_grenade_throw', {
    match_time: match ? +match.time.toFixed(3) : null,
    player: !!thrower?.isPlayer,
    origin: [origin.x, origin.y, origin.z].map(value => +value.toFixed(2)),
    velocity: [vel.x, vel.y, vel.z].map(value => +value.toFixed(2)),
  });
};

function explode(pos, thrower) {
  const explodeStarted = performance.now();
  const R = 7, MAX = 165, MIN = 25;
  let losChecks = 0;
  let affected = 0;
  // A blast tells you where a *grenade* went off, and nothing about who threw it —
  // so it lands as an unowned disturbance: somewhere to go and look when a fighter
  // has no live contact, not a fix on the thrower.
  world.emitNoise?.(null, pos, 'explosion');
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
      losChecks++;
      const occ = !hasLoS(world, blast, chest);
      const pdmg = dmgAt(d, occ);
      if (pdmg > 0) {
        affected++;
        handlePlayerDamaged(pdmg / 0.8, 'torso', pos); // undo grit for env-scale
      }
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
      losChecks++;
      const occ = !hasLoS(world, blast, chest);
      const dmg = dmgAt(d, occ);
      if (dmg > 1) {
        affected++;
        if (!occ && d < R * 0.6) { c.armDmg = Math.min(1, c.armDmg + 0.35); c.legDmg = Math.min(1, c.legDmg + 0.35); }
        c.applyDamage(world, 'torso', dmg, thrower, chest);
      }
    }
  }
  runtimeDiagnostics?.emit('game_grenade_explode', {
    match_time: match ? +match.time.toFixed(3) : null,
    player: !!thrower?.isPlayer,
    duration_ms: +(performance.now() - explodeStarted).toFixed(2),
    los_checks: losChecks,
    affected,
  });
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
      releaseGrenadeMesh(g.mesh);
      world.grenades.splice(i, 1);
      explode(g.pos, g.thrower);
    }
  }
}

// ============================================================ events (tournament master)
/**
 * Zone glows come out of a fixed pool.
 *
 * Adding a light to the scene changes its light count, which invalidates every cached
 * shader program — the next frame then recompiles all of them. A molotov spawns three
 * fire zones at once, and the first render after that measured at 7.5 seconds against
 * a 6 ms steady frame, recompiling ten programs. It is the same reason fx.js pools its
 * muzzle flashes rather than making a light per shot.
 *
 * Six covers the worst case that can actually arise. Random events land 24-38 s apart
 * and no zone outlives 18 s, so only one event's zones are ever alight at once — a
 * molotov's three — alongside at most two overlapping anti-camp fires.
 */
const MAX_ZONE_LIGHTS = 6;
const zoneLights = [];
for (let i = 0; i < MAX_ZONE_LIGHTS; i++) {
  // Parked at zero intensity, never hidden: three counts only *visible* lights, so
  // toggling `visible` would cause exactly the recompile this pool exists to avoid.
  const light = new THREE.PointLight(0xff6a1a, 0, 12, 1.6);
  scene.add(light);
  zoneLights.push({ light, zone: null });
}

// The care package's beacon, for the same reason and on the same terms. Only one drop
// is ever in play, so it gets one permanent light rather than a pool.
const airdropBeacon = new THREE.PointLight(0xffb92e, 0, 14, 1.4);
scene.add(airdropBeacon);

function clearAirdrop() {
  if (match?.airdrop?.mesh) scene.remove(match.airdrop.mesh);
  airdropBeacon.intensity = 0;
  if (match) match.airdrop = null;
}

function acquireZoneLight(zone, color, intensity) {
  let slot = zoneLights.find(candidate => !candidate.zone);
  if (!slot) {
    // Nothing free: take the glow off whichever zone is closest to burning out. It
    // keeps its haze and its damage, it just stops casting.
    slot = zoneLights.reduce((a, b) => (a.zone.ttl <= b.zone.ttl ? a : b));
    slot.zone.lightSlot = null;
  }
  slot.zone = zone;
  slot.light.color.setHex(color);
  slot.light.intensity = intensity;
  slot.light.distance = zone.r * 3.5;
  slot.light.position.set(zone.x, 1.2, zone.z);
  zone.lightSlot = slot;
}

// One unit cylinder for every zone haze, scaled per zone; the materials are cloned
// off these templates so each zone keeps its own opacity fade while every clone
// shares the template's compiled program. The templates also give the shader
// warm-up (see warmShaderCache) something to compile before the first event fires —
// this material combination appears nowhere else in the scene, so without it the
// first molotov of a session paid a mid-match compile.
const ZONE_GEO = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
const ZONE_MATS = {
  fire: new THREE.MeshBasicMaterial({ color: 0xff6a1a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  gas: new THREE.MeshBasicMaterial({ color: 0x39b32a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
};

function removeZoneVisual(z) {
  if (z.mesh) {
    scene.remove(z.mesh);
    // The geometry is shared and stays; the material is this zone's clone.
    z.mesh.material.dispose();
    z.mesh = null;
  }
  // The light goes back to the pool rather than out of the scene: removing it would
  // change the light count and recompile every shader, exactly as adding it does.
  if (z.lightSlot) {
    z.lightSlot.light.intensity = 0;
    z.lightSlot.zone = null;
    z.lightSlot = null;
  }
}

function spawnZone(type, x, z, r, ttl, dps) {
  const isGas = type === 'gas';
  const color = isGas ? 0x39b32a : 0xff6a1a;
  const mesh = new THREE.Mesh(ZONE_GEO, ZONE_MATS[isGas ? 'gas' : 'fire'].clone());
  mesh.scale.set(r, isGas ? 2.6 : 0.5, r);
  // A translucent haze has no business in GTAO's prepass: the override material
  // renders it as solid geometry and the cylinder occludes its own interior.
  mesh.layers.set(NO_OCCLUDE_LAYER);
  mesh.position.set(x, isGas ? 1.3 : 0.25, z);
  scene.add(mesh);
  const zone = { type, x, z, r, ttl, dps, mesh, lightSlot: null };
  acquireZoneLight(zone, color, isGas ? 25 : 40);
  world.zones.push(zone);
}

function randomFloorSpot(margin = 5) {
  return {
    x: (Math.random() - 0.5) * (ARENA.W - margin * 2),
    z: (Math.random() - 0.5) * (ARENA.D - margin * 2),
  };
}

function makeBountyMarker() {
  const marker = new THREE.Group();
  const gold = new THREE.MeshBasicMaterial({
    color: 0xffb92e,
    transparent: true,
    opacity: 0.85,
    depthTest: true,
    depthWrite: false,
  });
  const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.14, 0), gold);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.025, 6, 18), gold);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.24;
  marker.add(diamond, ring);
  marker.position.y = 2.25;
  marker.visible = false;
  return marker;
}

const EVENTS = ['lightsout', 'gas', 'frenzy', 'airdrop', 'molotov', 'bounty', 'bloodrules'];
// liquidation has no kill payouts, so the money-themed spectacles would announce cash that never arrives
const LIQUIDATION_EVENTS = ['lightsout', 'gas', 'airdrop', 'molotov', 'bloodrules'];
function fireEvent() {
  const pool = match.mode === 'liquidation' ? LIQUIDATION_EVENTS : EVENTS;
  let ev = pool[(Math.random() * pool.length) | 0];
  if (ev === 'bounty' && !match.enemies.some(c => c.alive && !c.boss)) ev = 'frenzy';
  runtimeDiagnostics?.emit('game_arena_event', {
    event: ev,
    match_time: +match.time.toFixed(3),
  });
  audio.klaxon();
  if (ev === 'bounty') {
    const marks = match.enemies.filter(c => c.alive && !c.boss);
    const mark = marks[(Math.random() * marks.length) | 0];
    mark.bountyT = 22;
    mark.bountyRevealed = mark.hadLoS || mark.sinceHit < 0.75 || mark.shotsFired > 0;
    mark.bountyMarker = makeBountyMarker();
    mark.bountyMarker.visible = mark.bountyRevealed;
    mark.group.add(mark.bountyMarker);
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
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8a6d2f, roughness: 0.8, metalness: 0.1 }));
    crate.position.y = 0.5;
    mesh.add(crate);
    mesh.position.set(s.x, 14, s.z);
    scene.add(mesh);
    // The beacon is not parented to the crate, so it is positioned to follow it.
    airdropBeacon.position.set(s.x, 14 + 1.6, s.z);
    airdropBeacon.intensity = 50;
    match.airdrop = { mesh, beacon: airdropBeacon, x: s.x, z: s.z, landed: false, ttl: 30 };
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
      if (c.bountyMarker) {
        if (c.hadLoS || c.sinceHit < 0.75 || c.shotsFired > 0) c.bountyRevealed = true;
        c.bountyMarker.visible = c.bountyRevealed;
        const pulse = 1 + Math.sin(match.time * 7) * 0.12;
        c.bountyMarker.scale.setScalar(pulse);
      }
      if ((c.bountyT <= 0 || !c.alive) && c.bountyMarker) {
        c.group.remove(c.bountyMarker);
        c.bountyMarker = null;
        c.bountyRevealed = false;
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
  arena.setLightFactor(world._lightFactor);
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
      airdropBeacon.position.y = ad.mesh.position.y + 1.6;
    } else {
      ad.mesh.rotation.y += dt * 1.2;
      ad.beacon.intensity = 35 + Math.sin(match.time * 6) * 20;
      const dx = player.pos.x - ad.x, dz = player.pos.z - ad.z;
      if (player.alive && dx * dx + dz * dz < 2.2 * 2.2) {
        // claim
        player.hp = player.maxHp;
        player.healLimbs();
        player.mag = player.weapon.mag;
        player.chambered = true;
        const amt = payout(250);
        if (amt > 0) { ui.moneyPop(amt); audio.cashRegister(); }
        ui.eventBanner('PACKAGE CLAIMED', 'Full patch-up. Back to work.', '#86ff3c');
        clearAirdrop();
      }
    }
    if (match.airdrop && ad.ttl <= 0) clearAirdrop();
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
      const enemyWinnings = Math.round(match.enemyBet * match.enemyBetOdds);
      const outcome = recordLiquidationOutcome(career.liquidation, match.won);
      if (match.won) {
        career.money += winnings;
        career.totals.earned += winnings;
        career.liquidation.playerWins++;
        career.liquidation.enemyMoney -= outcome.penalty;
      } else {
        career.liquidation.enemyMoney += enemyWinnings;
        career.liquidation.enemyWins++;
        career.money -= outcome.penalty;
      }
      match.liquidationOutcome = outcome;
      if (outcome.penalty > 0) {
        const side = outcome.loser === 'player' ? 'YOUR SQUAD' : 'THE RIVAL';
        ui.eventBanner('DEFEAT STREAK', `${side} margin-called $${outcome.penalty.toLocaleString()}`, 'var(--blood)');
      }
      emitCareerEvent('liquidation_match_settlement', {
        match_id: match.analyticsId,
        terminal_event_id: match.terminalEventId,
        lifecycle_sequence: 3,
        won: match.won,
        stake: career.bet,
        rival_stake: match.enemyBet,
        rival_stake_decision: match.enemyBetDecision,
        winnings: match.won ? winnings : 0,
        rival_winnings: match.won ? 0 : enemyWinnings,
        loser: outcome.loser,
        loss_streak: outcome.streak,
        streak_penalty: outcome.penalty,
        state: careerSnapshot(),
      });
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

function shopSquad() {
  return orderedSquad(career);
}

function autoQuote(type, quantity) {
  return market.quoteBuySeries(type, quantity, priceMult());
}

function autoShopPlans() {
  const fighters = shopSquad();
  return {
    heal: planSquadHealing(fighters.map(fighter => ({
      ...fighter,
      cost: fighter.who === 'player' ? playerPatchCost() : crewPatchCost(fighter.member),
    })), career.money),
    upgrade: planSquadTraining(fighters.map(fighter => ({
      ...fighter,
      type: fighter.who === 'player' ? PLAYER_TYPE : fighter.member.type,
      progress: fighter.who === 'player' ? career.playerProgress : fighter.member.progress,
    }))),
    ammo: planSquadAmmo(fighters, career.money, autoQuote, AUTO_AMMO_STACKS, career.stash),
  };
}

function applyPatchPayment(who, pay, cost) {
  if (pay <= 0 || cost <= 0) return false;
  const f = pay / cost;
  if (who === 'player') {
    if (f >= 0.999) {
      career.playerHp = null;
      career.playerLimbs = { arm: 0, leg: 0 };
    } else {
      const max = combatProfile(PLAYER_TYPE, career.playerProgress, true).maxHp;
      const cur = career.playerHp == null ? max : career.playerHp;
      career.playerHp = Math.min(max, Math.round(cur + (max - cur) * f));
      career.playerLimbs.arm = +(career.playerLimbs.arm * (1 - f)).toFixed(2);
      career.playerLimbs.leg = +(career.playerLimbs.leg * (1 - f)).toFixed(2);
    }
  } else {
    const member = career.crew[who];
    if (!member) return false;
    if (f >= 0.999) {
      member.hp = null;
      member.limbs = { arm: 0, leg: 0 };
    } else {
      const max = combatProfile(member.type, member.progress).maxHp;
      const cur = member.hp == null ? max : member.hp;
      member.hp = Math.min(max, Math.round(cur + (max - cur) * f));
      member.limbs.arm = +((member.limbs.arm || 0) * (1 - f)).toFixed(2);
      member.limbs.leg = +((member.limbs.leg || 0) * (1 - f)).toFixed(2);
    }
  }
  career.money -= pay;
  if (career.mode === 'liquidation') emitCareerEvent('liquidation_patch', {
    target: who === 'player' ? 'player' : career.crew[who]?.name,
    cost: pay,
    state: careerSnapshot(),
  });
  return true;
}

function executeAutoHeal(earnings) {
  if (draftShopState().locked) return;
  const plan = autoShopPlans().heal;
  let changed = false;
  for (const step of plan.steps) changed = applyPatchPayment(step.who, step.pay, step.cost) || changed;
  if (!changed) return;
  audio.cashRegister();
  save();
  renderShop(earnings);
}

function executeAutoTraining(earnings) {
  if (draftShopState().locked) return;
  const plan = autoShopPlans().upgrade;
  let changed = false;
  for (const upgrade of plan.upgrades) {
    const isPlayer = upgrade.who === 'player';
    const member = isPlayer ? null : career.crew[upgrade.who];
    const progress = isPlayer ? career.playerProgress : member?.progress;
    const type = isPlayer ? PLAYER_TYPE : member?.type;
    if (!progress || !buyTraining(progress, type, upgrade.skillId)) continue;
    if (career.mode === 'liquidation') emitCareerEvent('liquidation_training', {
      target: isPlayer ? 'YOU' : member.name,
      skill_id: upgrade.skillId,
      state: careerSnapshot(),
    });
    changed = true;
  }
  if (!changed) return;
  audio.cashRegister();
  save();
  renderShop(earnings);
}

function executeAutoAmmo(earnings) {
  if (draftShopState().locked) return;
  const plan = autoShopPlans().ammo;
  let changed = false;
  let spent = false;
  for (const step of plan.steps) {
    const fighter = shopSquad().find(entry => String(entry.who) === String(step.who));
    if (!fighter) continue;

    if (step.source === 'pack') {
      const returned = extractAmmoFromPack(fighter.ch, step.uid, step.rounds);
      if (!returned) continue;
      autoPlace(career.stash, returned);
      changed = true;
      continue;
    }

    const ammoType = ITEM_TYPES[step.type].ammoType;
    if (step.source === 'stash') {
      const available = ammoInGrid(career.stash, ammoType);
      const added = addAmmoToPack(fighter.ch, ammoType, Math.min(step.rounds, available));
      if (added <= 0) continue;
      takeAmmoFromGrid(career.stash, ammoType, added);
      changed = true;
      continue;
    }

    const cost = market.quoteBuy(step.type, 1, priceMult());
    if (!Number.isFinite(cost) || cost > career.money) break;
    const item = makeItem(step.type);
    const added = addAmmoToPack(fighter.ch, ammoType, Math.min(step.rounds, item.rounds));
    item.rounds -= added;
    if (item.rounds > 0) autoPlace(career.stash, item);
    market.buy(step.type);
    career.money -= cost;
    if (career.mode === 'liquidation') recordPlayerMarket('buy', step.type, cost);
    changed = true;
    spent = true;
  }
  if (!changed) return;
  if (spent) audio.cashRegister();
  save();
  renderShop(earnings);
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

function equipStashItem(uid, who) {
  const found = findItem(uid);
  if (!found || found.loc.kind !== 'stash') return false;
  const ch = getChar(who);
  const def = ITEM_TYPES[found.it.type];
  if (!ch || !def) return false;
  if (def.kind === 'gun') {
    const slot = !ch.gear.gun1 ? 'gun1' : !ch.gear.gun2 ? 'gun2' : 'gun2';
    return moveItem(uid, { kind: 'slot', who, slot });
  }
  if (def.kind === 'armor') return moveItem(uid, { kind: 'slot', who, slot: def.slot });
  if (def.kind === 'consumable' || def.kind === 'ammo') {
    return moveItem(uid, { kind: 'pack', who });
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
    autoPlans: autoShopPlans,
    autoHeal: () => executeAutoHeal(earnings),
    autoUpgrade: () => executeAutoTraining(earnings),
    autoAmmo: () => executeAutoAmmo(earnings),
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
    equipStashItem: (uid, who) => {
      if (draftShopState().locked) return;
      if (equipStashItem(uid, who)) { audio.uiClick(); save(); }
      renderShop(earnings);
    },
    patchPlayer: () => {
      if (draftShopState().locked) return;
      const cost = playerPatchCost();
      const pay = Math.min(cost, career.money);
      if (!applyPatchPayment('player', pay, cost)) return;
      audio.cashRegister(); save(); renderShop(earnings);
    },
    patchCrew: (idx) => {
      if (draftShopState().locked) return;
      const m = career.crew[idx];
      const cost = crewPatchCost(m);
      const pay = Math.min(cost, career.money);
      if (!m || !applyPatchPayment(idx, pay, cost)) return;
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
  career.bet = liquidation
    ? (liquidationBets.find(bet => bet > 250 && bet <= career.money) || liquidationBets[0] || 0)
    : 0;
  const squad = career.mode === 'liquidation'
    ? { name: 'THE RIVAL SYNDICATE', blurb: `Round ${career.liquidation.round}. Choose your stake; a poorer squad receives longer comeback odds.` }
    : SQUADS[career.rank];
  const rerender = () => ui.renderIntro(career, squad, liquidation ? liquidationOdds(career.liquidation, career.money) : betOdds(), (amt) => {
    if (!liquidation ? amt <= career.money : canPlaceLiquidationBet(career.liquidation, career.money, amt)) {
      career.bet = amt;
      audio.uiClick();
      rerender();
    }
  }, liquidationBets);
  rerender();
  ui.showScreen('intro');
}

// ============================================================ input
// One mousemove can arrive carrying a whole stall's worth of motion: when a frame
// hangs (a shader compile, speech synthesis blocking), the browser sums every
// pointer-lock delta it queued into a single event on resume. At base sensitivity
// ~750 px is a 90° snap and ~1500 px is 180° — the "view teleported" bug. No human
// flick delivers 200 px in one 8 ms event, so past that it is clipped, not believed.
const MAX_MOUSE_STEP = 200;
const clampMouseStep = (v) => Math.max(-MAX_MOUSE_STEP, Math.min(MAX_MOUSE_STEP, v || 0));
document.addEventListener('mousemove', (e) => {
  if (locked && phase === 'match') player.onMouseMove(clampMouseStep(e.movementX), clampMouseStep(e.movementY));
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
  } else if (phase === 'shop' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey &&
             (e.code === 'KeyA' || e.code === 'KeyD') &&
             !e.target?.matches?.('input, textarea, select')) {
    e.preventDefault();
    ui.cycleShopCharacter(e.code === 'KeyD' ? 1 : -1);
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
window.addEventListener('pagehide', () => {
  if (phase === 'match' || phase === 'paused') {
    journalTerminal('pagehide');
    analytics.flush(true);
  }
});

// if focus ever leaves (browser dialog, alt-tab, lock loss), drop all held keys so we never get stuck walking
window.addEventListener('blur', () => { player.clearInput(); input.resetGamepadState(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { player.clearInput(); input.resetGamepadState(); }
});

// fullscreen + keyboard lock: inside fullscreen, Keyboard Lock captures even Ctrl+W / Esc-adjacent combos
async function enterCombatMode() {
  // Fullscreen benefits every input mode. Controller players only skip the
  // keyboard and pointer capture calls that can reopen Edge's controller popup.
  const fullscreen = await requestBrowserFullscreen();
  runtimeDiagnostics?.emit('game_fullscreen_result', {
    entered: fullscreen,
    already_fullscreen: !!document.fullscreenElement,
    controller_connected: input.gamepadConnected,
  });
  if (touchMode || input.gamepadConnected) return;
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
    if (input.gamepadConnected) return;
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
const on = (id, fn) => document.getElementById(id).addEventListener('click', () => {
  audio.init();
  audio.resume();
  announcer.unlock();
  audio.uiClick();
  fn();
});

on('btn-new', () => { career = newCareer('circuits'); market = createMarket('circuits'); save(); showIntro(); });
on('btn-new-liquidation', () => { career = newCareer('liquidation'); market = createMarket('liquidation'); save(); openShop(); });
on('btn-firing-range', () => enterSandbox(WEAPON_ORDER, { god: true, publicRange: true }));
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
  if (sandbox.active) {
    leaveFiringRange();
    return;
  }
  journalTerminal('player_abandon');
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
matchLifecycle.recoverIncomplete();
ui.showScreen('menu');
runtimeDiagnostics?.emit('game_runtime_started', {
  build: import.meta.env?.VITE_BUILD_SHA || 'dev',
  installation_id: analytics.installationId,
  analytics_session_id: analytics.sessionId,
  xbox_browser: xboxBrowser,
  touch_mode: touchMode,
  user_agent: navigator.userAgent,
  platform: navigator.platform || '',
  hardware_concurrency: navigator.hardwareConcurrency || null,
  device_memory: navigator.deviceMemory || null,
  viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  quality: pipeline.quality,
});
if (runtimeDiagnostics) setInterval(() => runtimeDiagnostics.heartbeat(), 60_000);
window.addEventListener('pagehide', () => runtimeDiagnostics?.flush());

// idle backdrop camera for menu
camera.position.set(0, 8, 20);
camera.lookAt(0, 1, 0);

// ============================================================ loop
const clock = new THREE.Clock();

const _aimTmp = new THREE.Vector3();
let headlessSimulation = null;

function startHeadlessBotMatch(config = {}) {
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    throw new Error('headless simulation is local-only');
  }
  clearCombatants();
  match = makeMatch();
  // Grenades and medkits included, because career fighters carry them. The old
  // defaults carried neither, which quietly made every headless regression a
  // different game from the one on screen — grenade behaviour in particular was
  // untestable here while being very visible there, and conclusions drawn from
  // this harness silently excluded it.
  const defaults = [
    { w: 'rifle', hp: 100, sp: 1.2, re: 0.55, arch: 'marksman', ammo: 120, grenade: 2, medkit: 1 },
    { w: 'smg', hp: 100, sp: 1.35, re: 0.58, arch: 'rusher', ammo: 180, grenade: 1, medkit: 1 },
    { w: 'pistol', hp: 100, sp: 1.3, re: 0.6, arch: 'medic', ammo: 90, grenade: 1, medkit: 4 },
  ];
  const alpha = config.alpha || defaults;
  const bravo = config.bravo || defaults;
  const swapped = config.sideSwap === true;
  const north = swapped ? alpha : bravo;
  const south = swapped ? bravo : alpha;
  analytics.setSimulationContext({
    batchId: config.batchId,
    seed: config.seed,
    pairId: config.pairId,
    sideSwap: swapped,
    bots: ['alpha', 'bravo'],
  });
  const spawnSquad = (roster, team, bot, spawns) => roster.forEach((r, index) => {
    const fighter = new Combatant({
      name: `${bot.toUpperCase()} ${index + 1}`, team, weaponId: r.w,
      skill: { spreadMult: r.sp || 1.3, reaction: r.re || 0.58, speedMult: r.speed || 1 },
      hp: r.hp || 100, shirt: bot === 'alpha' ? 0x2e5d33 : 0x5b2434,
      armor: r.ar || 0, archetype: r.arch || null,
    });
    fighter.simulationBot = bot;
    fighter.ammoPools[ITEM_TYPES[r.w].ammo] = r.ammo || 120;
    fighter.healKits = r.medkit || 0;
    fighter.splints = r.splint || 0;
    fighter.nades = r.grenade || 0;
    fighter.addTo(world, spawns[index % spawns.length]);
    (team === 'player' ? match.crew : match.enemies).push(fighter);
  });
  spawnSquad(south, 'player', swapped ? 'bravo' : 'alpha', arena.spawns.playerCrew);
  spawnSquad(north, 'enemy', swapped ? 'alpha' : 'bravo', arena.spawns.enemy);
  match.enemiesAlive = match.enemies.length;
  player.alive = false;
  player.vmRoot.visible = false;
  world.playerProxy.alive = false;
  world.enemyDmgScale = 1;
  world.globalDmgMult = 1;
  assignRoles();
  assignOpeningPlays();
  const original = {
    onKill: world.onKill, onDamage: world.onDamage, onSupport: world.onSupport,
    onCombatEvent: world.onCombatEvent,
  };
  headlessSimulation = {
    config, original, elapsed: 0, nextFrame: 0, done: false, result: null,
    events: 0,
  };
  const emit = (type, payload) => {
    headlessSimulation.events++;
    analytics.emit(type, { simulation_match_id: match.analyticsId, time: +headlessSimulation.elapsed.toFixed(3), ...payload });
  };
  world.onDamage = (shooter, victim, amount) => emit('combat_damage', {
    shooter: shooter?.name, shooter_bot: shooter?.simulationBot,
    victim: victim?.name, victim_bot: victim?.simulationBot,
    amount: +amount.toFixed(2), weapon: shooter?.weaponId,
    range: shooter?.pos && victim?.pos ? +shooter.pos.distanceTo(victim.pos).toFixed(2) : null,
  });
  world.onSupport = (supporter, amount) => emit('combat_support', {
    supporter: supporter?.name, bot: supporter?.simulationBot, amount: +amount.toFixed(2),
  });
  world.onCombatEvent = (type, fighter, detail) => emit(`combat_${type}`, {
    fighter: fighter?.name, bot: fighter?.simulationBot,
    position: fighter?.pos ? [fighter.pos.x, fighter.pos.y, fighter.pos.z].map(value => +value.toFixed(2)) : null,
    ...detail,
  });
  world.onKill = (killer, victim, part) => {
    emit('combat_kill', {
      killer: killer?.name, killer_bot: killer?.simulationBot,
      victim: victim?.name, victim_bot: victim?.simulationBot,
      weapon: killer?.weaponId, part,
    });
    const living = world.combatants.filter(fighter => fighter.alive);
    const teams = new Set(living.map(fighter => fighter.simulationBot));
    if (teams.size <= 1) {
      headlessSimulation.done = true;
      headlessSimulation.result = {
        winner: living[0]?.simulationBot || null,
        duration: +headlessSimulation.elapsed.toFixed(3),
        survivors: living.length,
      };
    }
  };
  emit('match_enter', {
    game_mode: 'liquidation',
    opening_plays: world.combatants.map(fighter => ({
      fighter: fighter.name, bot: fighter.simulationBot, role: fighter.role,
      goal: fighter.openingGoal.toArray(), weapon: fighter.weaponId,
    })),
  });
  return { matchId: match.analyticsId };
}

function stepHeadlessBotMatch(dt = 1 / 60, maxSteps = 18000) {
  if (!headlessSimulation) throw new Error('no headless simulation match');
  const emitFrame = () => analytics.emit('combat_frame', {
    simulation_match_id: match.analyticsId,
    time: +headlessSimulation.elapsed.toFixed(3),
    fighters: world.combatants.map(fighter => ({
      name: fighter.name, bot: fighter.simulationBot, alive: fighter.alive,
      hp: +Math.max(0, fighter.hp).toFixed(2), weapon: fighter.weaponId,
      role: fighter.role, target: fighter.target?.name || null,
      position: [fighter.pos.x, fighter.pos.y, fighter.pos.z].map(value => +value.toFixed(2)),
      ammo: { ...fighter.ammoPools }, medkit: fighter.healKits, grenade: fighter.nades,
      pushing: fighter.pushT > 0, stalled_seconds: +fighter.stallT.toFixed(2),
      // Which ground he currently thinks is lethal, and whether he is standing on it.
      suppression: {
        pinned: !!fighter.pinnedBy,
        heat: fighter.pinnedBy ? +fighter.pinnedBy.heat.toFixed(2) : 0,
        holding: fighter.holdT > 0,
        hot_lanes: fighter.suppression.lanes.filter(l => laneIsHot(l, world.simTime)).length,
        // Ground he knows has drawn blood, whether or not he was the one bleeding.
        killing_ground: fighter.suppression.marks.filter(m => m.heat >= 3).length,
      },
      // What he thinks he knows, alongside where his target actually is. The pair is
      // the whole validation: after a sightline breaks, `believed` must stop moving
      // while `position` keeps going, and the route must converge on the former.
      contact: fighter.contact ? {
        kind: fighter.contact.kind,
        visible: !!fighter.contact.visible,
        believed: [fighter.contact.x, fighter.contact.y, fighter.contact.z].map(v => +v.toFixed(2)),
        error: +contactRadius(fighter.contact, world.simTime).toFixed(2),
        age: +(world.simTime - fighter.contact.t).toFixed(2),
        probes: fighter.contact.probes,
        // How far the belief actually is from the truth, in metres. Zero while seen.
        miss: fighter.contact.entity?.pos ? +Math.hypot(
          fighter.contact.x - fighter.contact.entity.pos.x,
          fighter.contact.z - fighter.contact.entity.pos.z,
        ).toFixed(2) : null,
      } : null,
    })),
  });
  for (let step = 0; step < maxSteps && !headlessSimulation.done; step++) {
    headlessSimulation.elapsed += dt;
    world.simTime += dt;
    for (const fighter of world.combatants) fighter.update(world, dt);
    updateGrenades(dt);
    if (headlessSimulation.elapsed >= headlessSimulation.nextFrame) {
      emitFrame();
      headlessSimulation.nextFrame += 0.5;
    }
    if (headlessSimulation.elapsed >= 180) {
      headlessSimulation.done = true;
      headlessSimulation.result = { winner: null, duration: 180, survivors: world.combatants.filter(f => f.alive).length };
    }
  }
  if (headlessSimulation.done && !headlessSimulation.terminalEmitted) {
    headlessSimulation.terminalEmitted = true;
    analytics.emit('match_terminal', {
      simulation_match_id: match.analyticsId,
      terminal_reason: headlessSimulation.result.winner ? 'team_elimination' : 'timeout',
      ...headlessSimulation.result,
    });
    Object.assign(world, headlessSimulation.original);
  }
  return { done: headlessSimulation.done, result: headlessSimulation.result, events: headlessSimulation.events };
}

// The held-corner trap that used to live here has been deleted, and the reason is
// worth keeping: it could not fail. It ran in the real arena, where a squad that
// avoids a lane and a squad that never had reason to approach it produce the same
// number — so it reported nought deaths in thirty and I reported that as a pass. The
// same question asked on a map built for it came back thirty for thirty. A test that
// cannot fail is worse than no test, because it is quoted. See the lane test below.
// ============================================================ the shield test
//
// Shieldwall against a competent squad, on the real map, from above.
//
// The lane test asks one narrow question about one corner. This asks the balance
// question: a team built around riot shields versus a team built around not being
// hit by them, on the arena everybody actually fights in, with nothing scripted on
// either side. Both squads are ordinary bots — no unkillable holder, no scenario
// driving anyone — so whatever happens is the AI's own opinion of the matchup.
//
// It reports the things the archetype is supposed to trade between: how much of the
// fight the shields spend actually presenting the plate, how much damage the plate
// ate, how much they landed while paying the accuracy tax for it, and whether the
// other squad went round them or stood in front donating ammunition.

const SHIELD_TEST = {
  // A shieldman with a two-handed weapon is a man carrying furniture, so the wall
  // runs pistols by construction. The counter-squad is deliberately well rounded
  // rather than hard-countered: no shotguns lined up to eat a wall, just a rifle, a
  // marksman who can punish an exposed head, a rusher to take the flank and a medic.
  // Every man on the wall carries a plate. Slipping a rifleman in among them made
  // the squad's damage impossible to attribute — most of what the "shieldwall" was
  // dealing came from the one man who was not holding a shield.
  wall: [
    { w: 'pistol', hp: 130, sp: 1.3, re: 0.55, ar: 0.25, arch: 'shield', ammo: 400, medkit: 1 },
    { w: 'pistol', hp: 130, sp: 1.3, re: 0.55, ar: 0.25, arch: 'shield', ammo: 400, medkit: 1 },
  ],
  balanced: [
    { w: 'rifle', hp: 115, sp: 1.25, re: 0.55, ar: 0.2, ammo: 400, medkit: 1, grenade: 1 },
    { w: 'rifle', hp: 115, sp: 1.3, re: 0.55, ar: 0.2, ammo: 400, medkit: 1 },
    { w: 'dmr', hp: 110, sp: 1.1, re: 0.52, ar: 0.2, arch: 'marksman', ammo: 400, medkit: 1 },
    { w: 'smg', hp: 120, sp: 1.35, re: 0.55, arch: 'rusher', ammo: 400, medkit: 1, grenade: 1 },
    { w: 'shotgun', hp: 130, sp: 1.4, re: 0.55, arch: 'rusher', ammo: 400, medkit: 1 },
    { w: 'smg', hp: 110, sp: 1.3, re: 0.55, arch: 'medic', ammo: 400, medkit: 4 },
  ],
  // How far off vertical the overhead view sits. Straight down is unreadable — every
  // fighter is a hat — so it leans back just enough to give them height.
  tilt: 7,
  seconds: 90,
};

/**
 * Take the roof off, so an overhead camera sees the fight instead of a slab.
 *
 * The lane test never hit this because it hides the whole arena and builds its own
 * box; this one is deliberately fought on the real map, which has a concrete ceiling
 * at 14 m, trusses at 13.5 and a lamp rig at 11.6. From above, all you see is the
 * underside of the building.
 *
 * Everything overhead is above 11.6 and everything that belongs to the fight is
 * below the 5 m wall tops, so a cut at seven metres separates them cleanly with no
 * list of names to maintain. Only the *meshes* go — the point lights hanging in the
 * rig stay exactly where they are, so the pit is still lit by the lamps you can no
 * longer see.
 */
function liftArenaRoof(minY = ARENA.WALL_H + 2) {
  const hidden = [];
  const box = new THREE.Box3();
  for (const child of scene.children) {
    if (!(child.isMesh || child.isInstancedMesh) || !child.visible) continue;
    box.setFromObject(child);
    // An empty box reports min +Infinity, which would otherwise read as "very high
    // up" and quietly hide anything without geometry.
    if (box.isEmpty() || box.min.y <= minY) continue;
    child.visible = false;
    hidden.push(child);
  }
  const fog = scene.fog;
  scene.fog = null;   // fifty metres of it between the camera and the floor
  return () => {
    for (const child of hidden) child.visible = true;
    scene.fog = fog;
  };
}

/**
 * How high the camera has to be for the whole pit to fit, given its actual lens.
 *
 * Computed rather than tuned, because a hard-coded height is only right for one
 * field of view and one window shape — the first version was set for a tall window
 * and cropped the ends of the arena off a wide one.
 */
function overheadHeight() {
  const half = Math.tan((camera.fov * Math.PI) / 180 / 2);
  const forDepth = (ARENA.D + 12) / (2 * half);
  const forWidth = (ARENA.W + 12) / (2 * half * camera.aspect);
  return Math.max(forDepth, forWidth);
}

function spawnShieldTestSquads(swap = false) {
  // A whole new match, the way the headless bot harness does it. Calling `fight()`
  // per seed worked until dev2 put a reflection bake behind the loading screen that
  // yields between painted frames — which a backgrounded or headless tab never
  // delivers, so `fight()` simply never resolves there and the scorer hangs. Nothing
  // about scoring two squads needs a loading screen.
  clearCombatants();
  match = makeMatch();
  const build = (roster, team, label, spawns) => roster.forEach((r, i) => {
    const fighter = new Combatant({
      name: `${label} ${i + 1}`, team, weaponId: r.w,
      skill: { spreadMult: r.sp || 1.3, reaction: r.re || 0.58, speedMult: r.speed || 1 },
      hp: r.hp || 100, shirt: team === 'player' ? 0x2e5d33 : 0x5b2434,
      armor: r.ar || 0, archetype: r.arch || null,
    });
    fighter.ammoPools[ITEM_TYPES[r.w].ammo] = r.ammo || 200;
    fighter.healKits = r.medkit || 0;
    fighter.nades = r.grenade || 0;
    fighter.openingT = 0;
    fighter.addTo(world, spawns[i % spawns.length]);
    (team === 'player' ? match.crew : match.enemies).push(fighter);
  });
  // Sides swap so the map's own asymmetry cannot be mistaken for the archetype's.
  build(swap ? SHIELD_TEST.balanced : SHIELD_TEST.wall, 'player', swap ? 'LINE' : 'WALL',
    arena.spawns.playerCrew);
  build(swap ? SHIELD_TEST.wall : SHIELD_TEST.balanced, 'enemy', swap ? 'WALL' : 'LINE',
    arena.spawns.enemy);
  match.enemiesAlive = match.enemies.length;
  player.alive = false;
  player.vmRoot.visible = false;
  world.playerProxy.alive = false;
  world.enemyDmgScale = 1;
  world.globalDmgMult = 1;
  assignRoles();
  return { wall: [...match.crew, ...match.enemies].filter(c => c.name.startsWith('WALL')),
    line: [...match.crew, ...match.enemies].filter(c => c.name.startsWith('LINE')) };
}

function makeShieldTest(squads, options = {}) {
  const cfg = { ...SHIELD_TEST, ...options };
  const test = {
    elapsed: 0, done: false, squads,
    stanceFrames: { carry: 0, aim: 0, turtle: 0, sprint: 0, stowed: 0 },
    frames: 0,
    plateAte: 0, wallDealt: 0, lineDealt: 0,
    lineFrontalFrames: 0, lineFlankFrames: 0, lineSeeingFrames: 0,
    baitFrames: 0,
    wallDeaths: 0, lineDeaths: 0,
    step(dt) {
      this.elapsed += dt;
      for (const c of squads.wall) {
        if (!c.alive || !c.shieldMesh) continue;
        this.frames++;
        if (this.stanceFrames[c.shieldStance] !== undefined) this.stanceFrames[c.shieldStance]++;
      }
      // Where the other squad is standing relative to the plates they can see: in
      // the arc (donating ammunition) or round the edge of it (the point).
      for (const c of squads.line) {
        if (!c.alive) continue;
        let sees = false, fronted = false;
        for (const sh of squads.wall) {
          if (!sh.alive || !sh.shieldPresenting) continue;
          if (c.pos.distanceTo(sh.pos) > 30) continue;
          sees = true;
          if (c._shieldFacingMe(sh)) fronted = true;
        }
        if (!sees) continue;
        this.lineSeeingFrames++;
        if (fronted) this.lineFrontalFrames++; else this.lineFlankFrames++;
        if (c.baiting) this.baitFrames++;
      }
      const wallAlive = squads.wall.filter(c => c.alive).length;
      const lineAlive = squads.line.filter(c => c.alive).length;
      if (!wallAlive || !lineAlive || this.elapsed > cfg.seconds) this.done = true;
    },
    report() {
      const f = Math.max(1, this.frames);
      const seen = Math.max(1, this.lineSeeingFrames);
      return {
        seconds: +this.elapsed.toFixed(1),
        wallAlive: this.squads.wall.filter(c => c.alive).length,
        lineAlive: this.squads.line.filter(c => c.alive).length,
        stance: Object.fromEntries(Object.entries(this.stanceFrames)
          .map(([k, v]) => [k, +(v / f).toFixed(2)])),
        plateAte: Math.round(this.plateAte),
        wallDealt: Math.round(this.wallDealt),
        lineDealt: Math.round(this.lineDealt),
        // The counterplay, in one number: of the time the other squad could see a
        // raised shield, how much of it did they spend somewhere it was not pointing?
        flankShare: +(this.lineFlankFrames / seen).toFixed(2),
        baitShare: +(this.baitFrames / seen).toFixed(2),
      };
    },
  };
  return test;
}

function instrumentShieldTest(test) {
  const original = { onKill: world.onKill, onDamage: world.onDamage };
  const isWall = (c) => !!c && test.squads.wall.includes(c);
  world.onDamage = (attacker, victim, amount) => {
    if (isWall(attacker)) test.wallDealt += amount;
    else if (attacker) test.lineDealt += amount;
    original.onDamage?.(attacker, victim, amount);
  };
  world.onKill = (killer, victim, part) => {
    if (isWall(victim)) test.wallDeaths++; else if (victim) test.lineDeaths++;
    original.onKill?.(killer, victim, part);
  };
  return () => { world.onKill = original.onKill; world.onDamage = original.onDamage; };
}

/**
 * Score the matchup across seeds, headless.
 *
 * Sides swap on alternate seeds, so a result that only appears from one spawn is
 * visible as one rather than averaged into a conclusion.
 */
async function runShieldTest({ seeds = [1, 2, 3, 4, 5, 6], rank = 5, ...options } = {}) {
  // The arena is built at boot behind the asset gate; open it and that is all the
  // world this needs. `spawnShieldTestSquads` starts a fresh match per seed, which
  // matters because a finished match stops thinking — reusing one showed up as a
  // ninety-second run with no contact in either direction, and I would otherwise
  // have read that as the wall being unapproachable.
  await window.__game.loadCombatAssets();
  const runs = [];
  for (const [i, seed] of seeds.entries()) {
    let sd = seed >>> 0;
    const realRandom = Math.random;
    Math.random = () => {
      sd += 0x6d2b79f5; let t = sd;
      t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const restore = () => { Math.random = realRandom; };
    const squads = spawnShieldTestSquads(i % 2 === 1);
    const test = makeShieldTest(squads, options);
    const uninstrument = instrumentShieldTest(test);
    // The plate's own accounting: applyDamage scales shield hits by 0.06, so what it
    // ate is what would have landed without it.
    const originalApply = Combatant.prototype.applyDamage;
    Combatant.prototype.applyDamage = function (w, part, dmg, shooter, point, dir) {
      if (part === 'shield' && squads.wall.includes(this)) test.plateAte += dmg;
      return originalApply.call(this, w, part, dmg, shooter, point, dir);
    };
    let guard = 0;
    while (!test.done && guard++ < 60 * (options.seconds ?? SHIELD_TEST.seconds) + 600) {
      stepMatch(1 / 60);
      test.step(1 / 60);
    }
    Combatant.prototype.applyDamage = originalApply;
    uninstrument();
    restore();
    runs.push({ seed, swapped: i % 2 === 1, ...test.report() });
  }
  const mean = (k) => +(runs.reduce((a, r) => a + (r[k] ?? 0), 0) / runs.length).toFixed(2);
  return {
    runs,
    wallSurvivors: `${runs.reduce((a, r) => a + r.wallAlive, 0)} / ${runs.length * SHIELD_TEST.wall.length}`,
    lineSurvivors: `${runs.reduce((a, r) => a + r.lineAlive, 0)} / ${runs.length * SHIELD_TEST.balanced.length}`,
    plateAte: mean('plateAte'), wallDealt: mean('wallDealt'), lineDealt: mean('lineDealt'),
    flankShare: mean('flankShare'), baitShare: mean('baitShare'),
    stance: Object.fromEntries(['carry', 'aim', 'turtle', 'sprint', 'stowed']
      .map(k => [k, +(runs.reduce((a, r) => a + r.stance[k], 0) / runs.length).toFixed(2)])),
  };
}

/** The same fight, rendered, straight down over the pit so the shapes are readable. */
async function watchShieldTest(options = {}) {
  await window.__game.fight('circuits', options.rank ?? 5);
  const squads = spawnShieldTestSquads(options.swap === true);
  const test = makeShieldTest(squads, options);
  const uninstrument = instrumentShieldTest(test);
  const restoreRoof = liftArenaRoof();
  const finish = () => {
    world.scenario = null;
    uninstrument();
    restoreRoof();
    player.vmRoot.visible = true;
  };
  world.scenario = (dt) => {
    test.step(dt);
    // Refitted every frame so resizing the window keeps the pit in shot. Set last,
    // after everything else has had its turn with the camera.
    camera.position.set(0, overheadHeight(), SHIELD_TEST.tilt);
    camera.lookAt(0, 0, 0);
    if (test.done) finish();
  };
  test.stop = finish;
  return test;
}

// ============================================================ the lane test
//
// The held-corner question asked on a map built for asking it. See src/lane-test.js
// for the geometry and why the real pit cannot answer it.
//
// The squad spawns behind a wall with one way out. The shooter holds the lane on the
// left. Left is short and lethal; right is long and safe. Passing looks like: nobody
// dies, nobody stands in the lane, and the squad spends its time on the safe side —
// or, if the shooter stops, comes down the short side hard while he is reloading.

function installLaneTestMap() {
  const realColliders = world.colliders;
  const realNav = world.nav;
  const hidden = [];
  for (const child of scene.children) {
    if ((child.isMesh || child.isInstancedMesh) && child.visible) {
      child.visible = false;
      hidden.push(child);
    }
  }
  const colliders = laneTestColliders();
  const disposeMeshes = buildLaneTestMeshes(scene);
  world.colliders = colliders;
  world.nav = new NavMesh(colliders);
  return () => {
    disposeMeshes();
    for (const child of hidden) child.visible = true;
    world.colliders = realColliders;
    world.nav = realNav;
  };
}

/**
 * The man holding the lane, as a fighter rather than as the human.
 *
 * He used to *be* the player, which made the test unwatchable: you were bolted to
 * the post looking down the sights of the thing under test. He is his own combatant
 * now — hostile to the squad, so they see him, target him and shoot back at him
 * exactly as they would anyone — with his AI removed, because the whole point is
 * that he holds one lane and never reacts to what walks into it. The human comes out
 * of play entirely and is left as a camera.
 */
function spawnLaneTestShooter(hp = 1e6) {
  const facing = Math.atan2(LANE_TEST.aim.x - LANE_TEST.post.x, LANE_TEST.aim.z - LANE_TEST.post.z);
  const shooter = new Combatant({
    name: 'HOLDER', team: 'player', weaponId: 'rifle',
    skill: { spreadMult: 1, reaction: 0.4, speedMult: 0 },
    // Effectively unkillable, and that is the point. He is not an opponent to be
    // beaten; he is the cheese itself, a fixture doing one thing forever. Making him
    // killable was a mistake — it ended runs early, flattered every number, and
    // quietly changed the question from "can the squad handle this" into "can the
    // squad out-damage it". Nobody should die to this however long he stands there.
    // Lower `holderHp` to watch a fight resolve; never to score one.
    hp, shirt: 0x2e5d33,
  });
  shooter.addTo(world, new THREE.Vector3(LANE_TEST.post.x, 0, LANE_TEST.post.z));
  shooter.yaw = facing;
  shooter.group.rotation.y = facing;
  shooter.laneFacing = facing;
  // Where he is trying to look. The scenario points this at the lane, or at whatever
  // he has broken off to punish, and he turns onto it at a human rate.
  shooter.aimDir = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));

  // No thinking, no moving, no target acquisition — he is a fixture with one job.
  // But he does *turn*: his yaw used to be pinned to the lane every frame while the
  // scenario fired at flankers off to one side, so he stood rigid, facing forward,
  // spraying tracers out of his shoulder. It reads exactly as a man trying to turn
  // and failing, because that is what it was.
  shooter.update = function (w, dt) {
    this.pos.set(LANE_TEST.post.x, 0, LANE_TEST.post.z);
    this.group.position.copy(this.pos);
    const want = Math.atan2(this.aimDir.x, this.aimDir.z);
    let dy = want - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * LANE_TEST.turnRate);
    this.group.rotation.y = this.yaw;
    this.rig.setStance(0, false, 0, 0);
    this.rig.setAimWeight(1);
    // The upper body leads the feet, as it does for everyone else.
    this.rig.setAim(0, dy * 0.6);
    this.rig.update(dt);
  };

  // The human is a spectator here, not a participant.
  player.alive = false;
  player.vmRoot.visible = false;
  world.playerProxy.alive = false;

  return shooter;
}

function makeLaneTest(shooter, options = {}) {
  const cfg = {
    ammo: 600, mag: 30, reload: 1.9, interval: 0.1, accuracy: 0.85,
    laneHalfWidth: 1.0, seconds: 75, holderHp: 1e6,
    /** A holder who also swings onto anything showing outside his lane. */
    // He breaks his hold to punish something showing, then goes back to the lane —
    // that is what holding an angle actually looks like, and it matters to the AI
    // rather than just to realism: a man who tracks flankers forever has no lane, and
    // the whole suppression model is built on there being one.
    //
    // 0.12 rather than the lane's 0.85 because he has to turn, reacquire a moving man
    // and lead him. At 0.35 he landed three and a half rounds a second across the
    // pit, which is not a player, it is an aimbot: every squad died wherever it stood
    // and the scenario could not tell good positioning from bad.
    // On by default. It was opt-in, which meant the obvious thing — calling
    // `laneTestWatch()` and watching — got you a holder who never turned, standing
    // there taking rounds from men in the open because nobody had passed a flag. The
    // realistic opponent is the default; `swing: false` is the special case, kept
    // because scoring the pure lane cheese needs a man who only ever holds the lane.
    swing: true, swingAccuracy: 0.12, swingRange: 30, swingHold: 1.2,
    /** How long he stays cross about being shot from somewhere. */
    swingGrudge: 2.5,
    /**
     * How long it takes him to *notice* something worth turning for, and how long
     * he must hold his lane again before he will break off a second time.
     *
     * Attention is the whole point. Without these he held the lane and picked men
     * off the far side in the same breath — one man, two jobs, no window ever. He
     * has to notice, commit, and re-settle now, which is what makes drawing him off
     * the lane a thing a squad can actually do rather than a thing that silently
     * costs the enemy nothing.
     */
    swingNotice: 0.45, swingSettle: 1.1,
    /**
     * How long he keeps hunting a man he has lost sight of, and the longest he will
     * stay off his lane however the engagement is going.
     */
    swingMaxEngage: 6,
    /** Seconds of fire, then seconds of silence, repeated. 0 = never stops. */
    ceaseFireAfter: 0, lullSeconds: 0,
    ...options,
  };
  const muzzle = new THREE.Vector3();
  const ray = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const end = new THREE.Vector3();
  const _trapDir = new THREE.Vector3();
  let reach = 0;

  const state = {
    cfg, shooter, mag: cfg.mag, ammo: cfg.ammo - cfg.mag, reload: 0, acc: 0,
    fired: 0, reloads: 0, deaths: 0, laneEntries: 0, elapsed: 0, done: false,
    trapFrames: 0, safeFrames: 0, botFrames: 0, laneFrames: 0,
    pushedInLull: 0, shooterHp: shooter.hp,
    track: [], sampleT: 0, holderDownAt: null, swingShots: 0,
    swingTarget: null, swingUntil: 0, engaging: null, hitChance: 0, aligned: true,
    lastAttacker: null, hurtAt: -99, swingKills: 0, swingEngagements: 0,
    noticing: null, noticedAt: 0, settleUntil: 0, laneOpenFor: 0, swingCap: 0,
    chaining: false, lastRoundAt: -99,
  };

  const firingNow = () => {
    if (!cfg.ceaseFireAfter) return true;
    const cycle = cfg.ceaseFireAfter + cfg.lullSeconds;
    return (state.elapsed % cycle) < cfg.ceaseFireAfter;
  };

  const aimLine = () => {
    muzzle.set(shooter.pos.x, 1.5, shooter.pos.z);
    ray.set(LANE_TEST.aim.x - shooter.pos.x, 1.15 - 1.5, LANE_TEST.aim.z - shooter.pos.z);
    reach = ray.length() + 6;
    ray.normalize();
  };

  state.standingInLane = (c) => {
    probe.set(c.pos.x, c.pos.y + 1.15, c.pos.z);
    rel.subVectors(probe, muzzle);
    const along = rel.dot(ray);
    if (along < 1 || along > reach) return false;
    const off = Math.hypot(rel.x - ray.x * along, rel.z - ray.z * along);
    return off < cfg.laneHalfWidth && hasLoS(world, muzzle, probe);
  };

  const inLane = new Map();

  state.step = (dt) => {
    if (state.done) return state;
    state.elapsed += dt;
    match.campT = 0;
    match.campWarned = false;
    aimLine();

    // Who he is on, decided once a frame rather than once a round.
    let engaging = world.combatants.find(c => c.alive && c.team === 'enemy' && state.standingInLane(c));
    let hitChance = cfg.accuracy;
    if (engaging) { state.swingTarget = null; state.swingUntil = 0; }
    else if (cfg.swing) {
      // He stays on a man while he can still see him.
      //
      // This was a countdown, and a countdown is not how anybody shoots. At the
      // accuracy of a man who has had to turn and reacquire, a fixed hold expires
      // long before a body drops — so he would put a burst into a flanker, lose
      // interest on a timer, and go back to his lane while the wounded man walked on.
      // He gives up when the target dies, when he loses sight of him for a moment,
      // or when he has been off his lane too long to justify it. Not before.
      if (state.swingTarget) {
        const t = state.swingTarget;
        let visible = t.alive;
        if (visible) {
          probe.set(t.pos.x, t.pos.y + 1.15, t.pos.z);
          visible = Math.hypot(t.pos.x - shooter.pos.x, t.pos.z - shooter.pos.z) <= cfg.swingRange
            && hasLoS(world, muzzle, probe);
        }
        if (visible) state.swingUntil = state.elapsed + cfg.swingHold;
        if (!t.alive || state.elapsed > state.swingUntil || state.elapsed > state.swingCap) {
          // Dropping a man is not a reason to stand down — it is a reason to look for
          // the next one. He used to settle back onto the lane the instant his target
          // died, which left him staring down an empty corridor while a shotgun
          // circled him, because the man who provoked him was no longer there to.
          // Standing down is for when there is nobody left in the open.
          state.chaining = !t.alive;
          state.swingTarget = null;
          if (!state.chaining) {
            state.settleUntil = state.elapsed + cfg.swingSettle;
            state.noticedAt = 0;
          }
        }
      }
      // He has to notice first, and having just come back to his lane he has to hold
      // it a moment before he will leave it again — unless he is already turned and
      // working, in which case he is alert and the next man costs him no delay.
      if (!state.swingTarget && (state.chaining || state.elapsed >= state.settleUntil)) {
        const canSee = (c) => {
          if (!c || !c.alive || c.team !== 'enemy') return false;
          if (Math.hypot(c.pos.x - shooter.pos.x, c.pos.z - shooter.pos.z) > cfg.swingRange) return false;
          probe.set(c.pos.x, c.pos.y + 1.15, c.pos.z);
          return hasLoS(world, muzzle, probe);
        };
        // Whoever is hitting him, first.
        //
        // Nearest-visible was the wrong rule and it showed: he fixated on whichever
        // man happened to be closest, engaged exactly one of them all run, and stood
        // there absorbing fire from the flank the entire time. Anybody would turn on
        // the person shooting them. The nearest man is only the answer when nobody is.
        let best = null;
        if (state.elapsed - state.hurtAt < cfg.swingGrudge && canSee(state.lastAttacker)) {
          best = state.lastAttacker;
        } else {
          let bestD = Infinity;
          for (const c of world.combatants) {
            if (!canSee(c)) continue;
            const d = Math.hypot(c.pos.x - shooter.pos.x, c.pos.z - shooter.pos.z);
            if (d < bestD) { bestD = d; best = c; }
          }
        }
        if (best) {
          if (state.noticing !== best) { state.noticing = best; state.noticedAt = state.elapsed; }
          if (state.chaining || state.elapsed - state.noticedAt >= cfg.swingNotice) {
            state.swingTarget = best;
            state.swingUntil = state.elapsed + cfg.swingHold;
            // However well it is going, the lane is still his job eventually.
            state.swingCap = state.elapsed + cfg.swingMaxEngage;
            state.swingEngagements++;
            state.noticing = null;
            state.chaining = false;
          }
        } else {
          // Nobody left showing: now he goes back to the lane.
          state.noticing = null;
          if (state.chaining) {
            state.chaining = false;
            state.settleUntil = state.elapsed + cfg.swingSettle;
          }
        }
      }
      if (state.swingTarget) { engaging = state.swingTarget; hitChance = cfg.swingAccuracy; }
    }
    state.engaging = engaging;
    state.hitChance = hitChance;

    // Where the rounds are going, and where he is pointing his body. Emitting the
    // lane's direction while shooting off to one side made the test unfair rather
    // than merely hard: the fighters being killed by the flank had no way to perceive
    // the angle killing them, because every round they heard claimed to be going
    // somewhere else. A gunshot has to report the truth about itself.
    if (engaging === state.swingTarget && state.swingTarget) {
      _trapDir.set(engaging.pos.x - muzzle.x, 0, engaging.pos.z - muzzle.z).normalize();
    } else {
      _trapDir.copy(ray);
      _trapDir.y = 0;
      if (_trapDir.lengthSq() > 1e-6) _trapDir.normalize();
    }
    shooter.aimDir.copy(_trapDir);
    state.aligned =
      Math.sin(shooter.yaw) * _trapDir.x + Math.cos(shooter.yaw) * _trapDir.z > Math.cos(LANE_TEST.aimTolerance);

    const shooting = firingNow();
    if (!shooting) state.acc = 0;
    else if (state.reload > 0) { state.reload -= dt; state.acc = 0; }
    else {
      state.acc += dt;
      while (state.acc >= cfg.interval) {
        state.acc -= cfg.interval;
        if (state.mag <= 0) {
          if (state.ammo <= 0) { state.done = true; break; }
          const take = Math.min(cfg.mag, state.ammo);
          state.mag = take; state.ammo -= take;
          state.reload = cfg.reload; state.reloads++;
          audio.reload(0);
          break;
        }
        // He is only ever pointing one way, so he only ever hits what he is pointing
        // at. The turn costs him time now instead of costing him accuracy, which is
        // both what it looks like and what it should be — the window a squad gets
        // when he breaks his hold is the swing itself, not a dice roll.
        if (!state.aligned) break;
        state.mag--; state.fired++;

        world.emitNoise?.(shooter, muzzle, 'gunshot', WEAPONS.rifle.suppression ?? 1, _trapDir);
        end.copy(muzzle).addScaledVector(_trapDir, reach);
        fx.tracer(muzzle, end);
        fx.muzzleFlash(muzzle, _trapDir);
        audio.shot(WEAPONS.rifle.sound, 1);

        state.lastRoundAt = state.elapsed;
        if (state.engaging === state.swingTarget && state.swingTarget) state.swingShots++;
        if (state.engaging && Math.random() < state.hitChance) {
          probe.set(state.engaging.pos.x, state.engaging.pos.y + 1.15, state.engaging.pos.z);
          // The round still has to get there. Retention deliberately keeps him on a
          // man who has just ducked behind something — the *hold* is right, and the
          // kill through the wall was not: acquisition checked line of sight but
          // firing never did, so a flanker who reached cover during the grace period
          // died through it. Walls stop bullets, including his.
          if (hasLoS(world, muzzle, probe)) {
            state.engaging.applyDamage(world, 'torso', WEAPONS.rifle.dmg, shooter, probe);
          }
        }
      }
    }

    // How much of the fight the lane was genuinely unattended: the window a squad
    // is meant to be fishing for, and the number that says whether it got one.
    if (state.swingTarget) state.laneOpenFor += dt;

    state.sampleT -= dt;
    const sampling = state.sampleT <= 0;
    if (sampling) state.sampleT = 0.25;

    for (const c of world.combatants) {
      if (!c.alive || c.team !== 'enemy') continue;
      state.botFrames++;
      const now = state.standingInLane(c);
      if (now) state.laneFrames++;
      if (now && !inLane.get(c)) state.laneEntries++;
      inLane.set(c, now);
      // Where everyone was and what they were doing, four times a second. The same
      // per-fighter picture  carries in a headless bout, recorded here
      // too — a scenario you cannot read back the movement from is a scenario you
      // have to guess about, and guessing is what these turns kept going wrong on.
      if (sampling) state.track.push({
        t: +state.elapsed.toFixed(2), who: c.name, arch: c.archetype || null,
        x: +c.pos.x.toFixed(2), z: +c.pos.z.toFixed(2),
        hp: Math.round(Math.max(0, c.hp)),
        range: +Math.hypot(c.pos.x - shooter.pos.x, c.pos.z - shooter.pos.z).toFixed(1),
        inLane: now, pinned: !!c.pinnedBy, sprint: !!c.sprintNow, peek: c.peekSide,
        sight: !!c.contact?.visible, hold: +c.holdT.toFixed(1), waiting: !!c.waitingForGap,
        lane: c.breachLane, staging: !!c.breachStaging,
        goal: [+c.breachGoal.x.toFixed(1), +c.breachGoal.z.toFixed(1)],
        firing: shooting,
        // Whether rounds were actually coming out, which is not the same as whether
        // he was nominally shooting: reloads and turns are gaps inside a burst
        // schedule that never stops. The first version of this recorded the schedule
        // and therefore reported that nobody ever crossed in a gap, which was a fact
        // about the metric rather than about the squad.
        quiet: +(state.elapsed - state.lastRoundAt).toFixed(2),
      });
      if (spotAt(c.pos, LANE_TEST.deathTraps)) {
        state.trapFrames++;
        if (!shooting) state.pushedInLull++;
      }
      if (spotAt(c.pos, LANE_TEST.safeGround)) state.safeFrames++;
    }
    state.shooterHp = shooter.hp;
    if (!shooter.alive && state.holderDownAt === null) {
      state.holderDownAt = +state.elapsed.toFixed(1);
      state.done = true;
    }
    if (state.elapsed > cfg.seconds) state.done = true;
    if (!world.combatants.some(c => c.alive && c.team === 'enemy')) state.done = true;
    return state;
  };

  return state;
}

function laneTestReport(state, squad, seed) {
  const share = (n) => +(n / Math.max(1, state.botFrames)).toFixed(3);
  return {
    seed, squad, deaths: state.deaths, survivors: squad - state.deaths,
    laneEntries: state.laneEntries,
    inLaneShare: share(state.laneFrames),
    atDeathTraps: share(state.trapFrames),
    atSafeGround: share(state.safeFrames),
    pushedTrapsDuringLull: state.pushedInLull,
    holderDownAt: state.holderDownAt,
    swingShots: state.swingShots,
    laneOpenSeconds: +state.laneOpenFor.toFixed(1),
    swingKills: state.swingKills, swingEngagements: state.swingEngagements,
    damageOnShooter: Math.round(state.cfg.holderHp - state.shooterHp),
    roundsFired: state.fired, reloads: state.reloads,
    seconds: +state.elapsed.toFixed(1),
  };
}

/** Put the squad in the spawn alcove with a full load, and clear the pit of extras. */
function placeLaneTestSquad() {
  const enemies = world.combatants.filter(c => c.team === 'enemy');
  for (const c of world.combatants.slice()) {
    if (c.team === 'player') c.removeFrom(world);
  }
  enemies.forEach((c, i) => {
    const spot = LANE_TEST.enemySpawn[i % LANE_TEST.enemySpawn.length];
    c.pos.set(spot.x, 0, spot.z);
    c.group.position.copy(c.pos);
    c.spawnPos = c.pos.clone();
    c.openingT = 0;
    for (const k of Object.keys(c.ammoPools)) c.ammoPools[k] = 400;
    // Everyone carries a medkit; the medic carries the bag. Supplies came from the
    // rank roll before, which meant most of the squad had nothing to use and the
    // medic nothing worth watching.
    c.healKits = c.archetype === 'medic' ? 6 : 1;
  });
  return enemies;
}

/**
 * Twelve seeds by default, not six.
 *
 * This map's numbers swing about twenty percent run to run on identical code — the
 * same baseline measured 88 degrees of spread and 2,075 damage one hour and 62 and
 * 2,414 the next. At three or six seeds that is wide enough to swallow any change
 * worth arguing about, and several calls made during this work were taken inside
 * that band. Twelve is slower and honest; pass fewer explicitly when iterating.
 */
async function runLaneTest({ seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], rank = 5, ...options } = {}) {
  const runs = [];
  for (const seed of seeds) {
    let s = seed >>> 0;
    const realRandom = Math.random;
    Math.random = () => {
      s += 0x6d2b79f5; let t = s;
      t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    let restore = null;
    try {
      await window.__game.fight('circuits', rank);
      restore = installLaneTestMap();
      const enemies = placeLaneTestSquad();
      const shooter = spawnLaneTestShooter(options.holderHp ?? 1e6);
      const test = makeLaneTest(shooter, options);
      const originalKill = world.onKill;
      const originalDamage = world.onDamage;
      world.onKill = (killer, victim, part) => {
        if (victim?.team === 'enemy') test.deaths++;
        if (victim === test.swingTarget) test.swingKills++;
        originalKill?.(killer, victim, part);
      };
      world.onDamage = (attacker, victim, amount) => {
        if (victim === shooter && attacker) { test.lastAttacker = attacker; test.hurtAt = test.elapsed; }
        originalDamage?.(attacker, victim, amount);
      };
      while (!test.done) { world.simTime += 1 / 60; stepMatch(1 / 60); test.step(1 / 60); }
      world.onKill = originalKill;
      world.onDamage = originalDamage;
      const report = laneTestReport(test, enemies.length, seed);
      report.track = test.track;
      runs.push(report);
    } finally {
      // Hand the world back exactly as it was found. Leaving the holder standing and
      // the player dead poisoned whatever ran next in the same session — headless
      // bouts afterwards took 31 to 180 simulated seconds against 13 to 24 on a fresh
      // page, which reads as an AI regression and is nothing of the kind. A harness
      // that dirties the thing it measures is worse than no harness.
      for (const c of world.combatants.slice()) if (c.team === 'player') c.removeFrom(world);
      player.alive = true;
      player.vmRoot.visible = true;
      world.playerProxy.alive = true;
      restore?.();
      Math.random = realRandom;
    }
  }
  const total = (k) => runs.reduce((sum, r) => sum + r[k], 0);
  const mean = (k) => +(runs.reduce((sum, r) => sum + r[k], 0) / runs.length).toFixed(3);
  return {
    runs,
    botLives: total('squad'),
    deaths: total('deaths'),
    deathRate: total('deaths') + ' / ' + total('squad'),
    laneEntries: total('laneEntries'),
    meanInLaneShare: mean('inLaneShare'),
    meanAtDeathTraps: mean('atDeathTraps'),
    meanAtSafeGround: mean('atSafeGround'),
    pushedTrapsDuringLull: total('pushedTrapsDuringLull'),
    holderKilled: runs.filter(r => r.holderDownAt !== null).length + ' / ' + runs.length,
    laneOpenSeconds: +runs.reduce((a, r) => a + r.laneOpenSeconds, 0).toFixed(1),
    swingKills: runs.reduce((a, r) => a + r.swingKills, 0),
    swingEngagements: runs.reduce((a, r) => a + r.swingEngagements, 0),
    damageOnShooter: total('damageOnShooter'),
  };
}

/**
 * The same thing on the real loop, seen from above.
 *
 * A top-down camera, because the question is entirely about *pathing*, and pathing is
 * the one thing you cannot see down a pair of iron sights. The scored ground is drawn
 * on the floor — red discs for the tempting cover inside the beaten zone, green for
 * the long way round, a red strip for the lane — so what the numbers count is on
 * screen while it happens.
 */
async function watchLaneTest(options = {}) {
  await window.__game.fight('circuits', options.rank ?? 5);
  const restoreMap = installLaneTestMap();
  const clearMarkers = buildLaneTestMarkers(scene);
  placeLaneTestSquad();
  const shooter = spawnLaneTestShooter(options.holderHp ?? 1e6);
  const test = makeLaneTest(shooter, options);
  const originalKill = world.onKill;
  const originalDamage = world.onDamage;
  world.onKill = (killer, victim, part) => {
    if (victim?.team === 'enemy') test.deaths++;
    originalKill?.(killer, victim, part);
  };
  world.onDamage = (attacker, victim, amount) => {
    if (victim === shooter && attacker) { test.lastAttacker = attacker; test.hurtAt = test.elapsed; }
    originalDamage?.(attacker, victim, amount);
  };
  const finish = () => {
    world.scenario = null;
    world.onKill = originalKill;
    world.onDamage = originalDamage;
    clearMarkers();
    restoreMap();
    player.vmRoot.visible = true;
  };
  world.scenario = (dt) => {
    test.step(dt);
    // Straight down over the pit, tilted a little so the fighters have some height to
    // read by. Set last, after everything else has had its turn with the camera.
    camera.position.set(LANE_TEST.camera.x, LANE_TEST.camera.height, LANE_TEST.camera.z);
    camera.lookAt(LANE_TEST.camera.x, 0, LANE_TEST.camera.lookZ);
    if (test.done) finish();
  };
  test.stop = finish;
  return test;
}

function updateSpectatorCamera(dt) {
  if (!match.spectatorTarget?.alive) cycleSpectator(1);
  const target = match.spectatorTarget;
  if (!target) return;
  spectatorCamera.follow(target, dt, world.combatants);
  const alive = livingCrew();
  ui.showSpectator(target.name, Math.max(0, alive.indexOf(target)), alive.length);
}

function stepMatch(dt) {
  match.time += dt;
  world.simTime += dt;
  player.update(dt, locked || touchMode || input.gamepadConnected, !!match.spectating);

  // crew reads this to stay out of the player's line of fire
  camera.getWorldDirection(_aimTmp);
  _aimTmp.y = 0;
  if (_aimTmp.lengthSq() > 1e-6) world.playerAim.copy(_aimTmp).normalize();

  // anti-camp: the crowd paid for movement. Root in one spot and VULTURE ships fire.
  if (!sandbox.active && player.alive && !match.ended) {
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
  // A scenario, if one is running. Only ever set by the debug harnesses.
  world.scenario?.(dt);
  if (match.spectating) updateSpectatorCamera(dt);
  if (!sandbox.active) updateEvents(dt);
  updateGrenades(dt);
  if (!sandbox.active) announcer.update(dt);
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
  get renderer() { return renderer; }, get camera() { return camera; },
  get scene() { return scene; }, get arena() { return arena; },
  get pipeline() { return pipeline; },
  THREE,                                  // capture/diagnostic poses need constructors
  FighterRig,                             // tools/fightercheck.mjs drives a rig alone
  /**
   * Open the combat asset gate and resolve once the streamed assets are in.
   *
   * `assetsReady` alone is a trap for tooling: it sits behind the gate, so awaiting it
   * before starting anything waits forever. A bench that measures a model rather than a
   * match has no reason to run a bout just to open the door, so here is the door.
   */
  loadCombatAssets() { beginCombatAssetLoading(); return assetsReady; },
  buildHeldGun, SUPPORT_GRIP,             // ...and puts a real weapon in its fist
  items: { makeItem, autoPlace },         // capture poses stock a pack to test reloads
  assetsReady,                            // tools/shot.mjs waits on this before posing
  setQuality(name) { pipeline.setQuality(name); saveGraphicsQuality(pipeline.quality); },
  sandbox(weapons, opts) { return enterSandbox(weapons, opts); },
  // Hazard zones are otherwise only reachable by camping for 22 s or waiting out the
  // event timer, which makes the cost of lighting them awkward to measure.
  spawnZone(type, x, z, r, ttl, dps) { return spawnZone(type, x, z, r, ttl, dps); },
  // The same teardown the expiry branch runs, so the light really goes back to the pool.
  expireZones() {
    for (const z of world.zones) removeZoneVisual(z);
    world.zones.length = 0;
  },
  get stats() { return pipeline.stats(); },
  tuning: { STICK, TOUCH, AIM_ASSIST },
  step(dt = 1 / 60, n = 1) { for (let i = 0; i < n && phase === 'match'; i++) stepMatch(dt); },
  startHeadlessBotMatch,
  stepHeadlessBotMatch,
  // The purpose-built version: one way out, a short lethal route and a long safe
  // one. `laneTest()` scores it; `laneTestWatch()` plays it in front of you.
  laneTest: (opts) => runLaneTest(opts),
  laneTestWatch: (opts) => watchLaneTest(opts),
  // Shieldwall against a competent squad on the real map. `shieldTest()` scores it
  // across seeds; `shieldTestWatch()` runs one from directly overhead.
  shieldTest: (opts) => runShieldTest(opts),
  shieldTestWatch: (opts) => watchShieldTest(opts),
  flushAnalytics() { return analytics.flush(); },
  get analyticsPending() { return analytics.queue.length; },
  setLocked(v) { locked = v; },
  // ---- capture harness (tools/shot.mjs) ----
  // freeCam parks the camera and stops the loop from driving it, so a captured
  // frame is reproducible instead of wherever the menu orbit happened to be.
  freeCam(pos, look) {
    this.frozenCam = true;
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(look[0], look[1], look[2]);
  },
  /**
   * Start a bout straight from the debug handle.
   *
   * Waits on `assetsReady` — which includes `arena.propsReady` — and returns a
   * promise, because the props carry colliders. Called without waiting, the first
   * bout after a page load runs in a pit whose crates have not arrived yet, so every
   * sightline in it differs from every later bout. That made run #1 of a measurement
   * session quietly incomparable with run #2, which is a fine way to read a result
   * off nothing at all.
   */
  fight(mode = 'circuits', rank = 15) {
    beginCombatAssetLoading();
    return Promise.all([assetsReady, graphicsReady]).then(() => {
      career = newCareer(mode);
      career.rank = rank;
      market = createMarket(mode);
      return startMatch({ prepared: true });
    }).then(() => {
      return match;
    });
  },
};

// URL entry into the debug bench, once the assets it needs have arrived.
{
  const params = new URLSearchParams(location.search);
  if (params.has('sandbox')) {
    beginCombatAssetLoading();
    assetsReady.then(() => enterSandbox(params.get('sandbox'), { god: params.get('god') !== '0' }));
  }
}

function tick() {
  requestAnimationFrame(tick);
  window.__frames = (window.__frames || 0) + 1;
  const rawDt = clock.getDelta();
  const dt = Math.min(0.05, rawDt);
  const t = clock.elapsedTime;

  if (rawDt >= 0.12 && t - (tick.lastHitchAt || -99) >= 1.5) {
    tick.lastHitchAt = t;
    const now = performance.now();
    runtimeDiagnostics?.emit('game_frame_hitch', {
      duration_ms: Math.round(rawDt * 1000),
      phase,
      match_time: match ? +match.time.toFixed(2) : null,
      controller_connected: input.gamepadConnected,
      graphics_prep: graphicsPrepStage,
      announcer: {
        speaking: announcer._speaking,
        backend: 'prerendered-opus',
        last_start_ms: Math.round(announcer._lastVoiceStartMs || 0),
        last_start_age_ms: announcer._lastVoiceStartAt
          ? Math.round(now - announcer._lastVoiceStartAt)
          : null,
      },
      analytics: {
        queued_events: analytics.queue.length,
        queued_bytes: analytics.outboxBytes(),
        delivery_failures: analytics.deliveryFailures,
        storage_failures: analytics.storageFailures,
        last_successful_flush_at: analytics.lastSuccessfulFlushAt,
      },
      render: pipeline.stats(),
    });
  }

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
  } else if (window.__game?.frozenCam) {
    // capture harness owns the camera
  } else if (phase === 'menu' || phase === 'shop' || phase === 'intro' || phase === 'dead' || phase === 'champion') {
    // slow orbit backdrop
    const a = t * 0.08;
    camera.position.set(Math.sin(a) * 16, 7 + Math.sin(t * 0.3) * 1, Math.cos(a) * 16);
    camera.lookAt(0, 1.2, 0);
  }

  pipeline.render(t);
}
tick();
