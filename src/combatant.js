import * as THREE from 'three';

import { NO_OCCLUDE_LAYER } from './layers.js';
import { WEAPONS, buildHeldGun } from './weapons.js';
import {
  fireRay, applySpread, hasLoS, resolveCircle, groundHeight, STEP_REACH,
  playerAimPoint,
} from './combat.js';
import { ITEM_TYPES } from './items.js';
import { audio } from './audio.js';
import { FighterRig } from './fighter-rig.js';
import { surface } from './materials.js';
import {
  coordinatedBreachLane, offsetBreachGoal, safeBreachLane, LANE_ABANDON,
  shouldSprintAtTarget, searchProbe, SEARCH_PROBES, electOverwatch, isCovered,
  lanesSpokenFor,
} from './tactics.js';
import {
  ContactMemory, contactRadius, withinVision, worthGrenading, clampToArena,
} from './perception.js';
import {
  SuppressionMap, SUPPRESSION, SUPPRESSING, coverStep, stepOutOfLane, worthSuppressing,
  laneSeverity, laneQuietFor, timeSinceFired,
} from './suppression.js';

const UP = new THREE.Vector3(0, 1, 0);
const _peekEye = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aimTmp = new THREE.Vector3();
const _scanAim = new THREE.Vector3();
const _scanEye = new THREE.Vector3();
const _targetBelief = new THREE.Vector3();
const _laneFrom = new THREE.Vector3();
const _laneTo = new THREE.Vector3();
const _routePoint = new THREE.Vector3();
const _suppressAt = new THREE.Vector3();
const _shieldInRoot = new THREE.Matrix4();
const _shieldWant = new THREE.Matrix4();
const _shieldLocal = new THREE.Matrix4();
const _shieldPos = new THREE.Vector3();
const _shieldQuat = new THREE.Quaternion();
const _shieldEuler = new THREE.Euler();
const _shieldScl = new THREE.Vector3();
const _shieldOne = new THREE.Vector3(1, 1, 1);
const _nadeVel = new THREE.Vector3();
const _nadeLand = new THREE.Vector3();
const _eyeSelf = new THREE.Vector3();
const _aimHold = new THREE.Vector3();
const _moveAcc = new THREE.Vector3();
const _rotTmp = new THREE.Vector3();
const _fireDir = new THREE.Vector3();
const _sdirTmp = new THREE.Vector3();
const _shareMates = [];
const EMPTY_SQUAD = [];

/**
 * The living members of one team, computed at most once per team per simulated
 * frame. Three separate places in the update used to re-filter the full combatant
 * list per fighter per frame (overwatch election, intel sharing, breach surveys) —
 * thirty-odd array allocations a frame for an answer that only changes when someone
 * dies, which is why `die()` drops the cache.
 */
function aliveSquad(world, team) {
  let cache = world._squadCache;
  const stamp = world.simTime ?? 0;
  if (!cache || cache.stamp !== stamp) {
    cache = world._squadCache = { stamp, teams: new Map() };
  }
  let list = cache.teams.get(team);
  if (!list) {
    list = world.combatants.filter(c => c.alive && c.team === team);
    cache.teams.set(team, list);
  }
  return list;
}

/** How often a fighter sweeps every hostile for line of sight, in seconds. */
const SCAN_PERIOD = 0.18;

/** How often he re-checks whether the ground he is on is being covered. */
const SUPPRESSION_PERIOD = 0.22;

/**
 * Total seconds a fighter will refuse to advance before going anyway.
 *
 * Holding re-ups itself for as long as the lane stays hot, which against someone who
 * simply never stops firing is forever — a fighter jinking behind a crate until the
 * match times out. So there is a budget.
 *
 * Twelve seconds rather than the five it started at. Five had a squad breaking cover
 * into a rifle that was still firing, because a timer said so, and dying one at a
 * time — the exact behaviour the model exists to prevent, arrived at from the other
 * direction. The pit already has an answer to a player who roots in one spot: the
 * crowd gets bored at fourteen seconds and management drops fire on him at
 * twenty-two. The bots do not need to suicide to break a camp; they need to outlast
 * it, and this budget is sized to hand the problem to the mechanic that owns it.
 */
const HOLD_BUDGET = 12;

/**
 * How finely to check a candidate route for incoming fire.
 *
 * Every metre and a half of it, rather than at four fixed fractions of the way.
 * A beaten zone is a *thin* thing — a couple of metres of corridor — and four
 * samples on a twenty metre route are eight metres apart, so the lane fell straight
 * between two of them. Measured on the lane-test map: a route whose sampled points
 * landed at (-7.9, -5.9) and (-13, -4.1), either side of a crossing at x = -9,
 * scored 0.13 and was chosen as the safest of eleven, and the fighter who walked it
 * was dead four seconds later. Everything downstream was reasoning correctly about
 * a route nobody had actually looked at.
 *
 * Weight still ramps toward the destination, because ending in a beaten zone is
 * worse than crossing one, but no stretch of the walk goes unexamined now.
 */
/**
 * What crossing ground costs relative to stopping on it, and what a gap in the
 * firing knocks off that again.
 *
 * The model refused every route that touched a beaten zone, which against anybody
 * holding a real angle means refusing every route. A man who sprints through two
 * metres of it to reach a better position has done the right thing; a man who walks
 * to a spot inside it and stays has not, and only the destination weight should
 * speak to that.
 */
/**
 * How long the fire has to have stopped before a crossing counts as a gap.
 *
 * Shorter than a reload and longer than the beat between bursts, so a man waits out
 * a magazine change without being fooled by the pause inside one.
 */
const GAP_SECONDS = 0.45;

const TRANSIT_DISCOUNT = 0.4;
const LULL_DISCOUNT = 0.45;
const LULL_SECONDS = 0.6;

const ROUTE_STEP = 1.5;
const ROUTE_MIN_SAMPLES = 4;
const ROUTE_MAX_SAMPLES = 20;
const routeSampleWeight = (t) => 0.5 + 2.5 * t * t;

/** Scratch for the walked polyline a route cost is measured along. */
const _routeLegs = [];
const _routeGoal = new THREE.Vector3();

/**
 * The point `t` of the way along a polyline, by distance walked on the floor.
 *
 * Fractions have to be of *path* length, not of the straight line — the whole point
 * of costing the real route is that a flank is longer than the gap it covers.
 */
function pointAlongPath(points, t, out) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  const last = points[points.length - 1];
  if (total < 1e-4) return out.set(last.x, last.y, last.z);
  let want = total * t;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (want <= seg || i === points.length - 1) {
      const f = seg > 1e-6 ? Math.min(1, want / seg) : 1;
      return out.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
    }
    want -= seg;
  }
  return out.set(last.x, last.y, last.z);
}

/** Sprinting boots are loud. One footfall report per this many seconds. */
const SPRINT_NOISE_PERIOD = 0.45;

/**
 * How far leaning out actually carries the muzzle sideways, in metres.
 *
 * Measured off the rig by `npm run fightercheck`, which prints it. Anything larger
 * here just makes fighters lean out and find nothing, because the shot comes from the
 * real barrel either way.
 */
const PEEK_REACH = 0.29;

/**
 * Riot-shield carry stance.
 *
 * The left arm brings the shield up and across so it fronts the torso; the right arm
 * is pushed *wide* so the weapon clears the shield's edge. That last part is the
 * whole point — with a normal weapon stance the gun sits behind the shield and the
 * fighter appears to fire straight through it. Held out past the edge, he reads as
 * peeking around his own cover to shoot, which is what a shieldman actually does.
 *
 * The head is deliberately left unpinned so the procedural aim pitch still tracks
 * targets, and the shield's top edge sits below eye level so he looks over it.
 *
 * Angles are radians, in the bone-local convention from tools/blender/fighter.py:
 * X is flexion, Z is abduction.
 */
const SHIELD_CARRY = {
  upperarm_l: [-0.45, 0, -0.62],   // up and adducted across the chest
  forearm_l: [-1.30, 0, 0],        // elbow folded so the forearm runs across the body
  hand_l: [0, 0, 0],
  shoulder_r: [0, 0, -0.18],
  upperarm_r: [-0.30, 0.10, 0.80], // abducted wide: the weapon clears the shield edge
  forearm_r: [-1.10, 0, 0],
};

/** Aiming: the shield squares up and drops, the gun arm comes over the top of it. */
const SHIELD_AIM = {
  upperarm_l: [-0.72, 0, -0.50],
  forearm_l: [-1.45, 0, 0],
  hand_l: [0, 0, 0],
  shoulder_r: [0, 0, -0.05],
  upperarm_r: [-0.52, 0.05, 0.34],  // brought in: he is behind the sights, not waving
  forearm_r: [-1.25, 0, 0],
};

/** Turtled: elbow tucked under, everything folded down behind the plate. */
const SHIELD_TURTLE = {
  upperarm_l: [-0.16, 0, -0.30],
  forearm_l: [-1.72, 0, 0],
  hand_l: [0, 0, 0],
  shoulder_r: [0, 0, -0.30],
  upperarm_r: [0.22, 0.10, 0.42],   // gun pulled in against the chest, behind cover
  forearm_r: [-1.55, 0, 0],
};

/** Running: dropped to his side and carried like the heavy slab it is. */
const SHIELD_RUN = {
  upperarm_l: [0.30, 0, -0.10],     // hanging, swinging low with the stride
  forearm_l: [-0.34, 0, 0],
  hand_l: [0, 0, 0],
};

/** Every bone any shield stance touches, so a stance change can release the last. */
const SHIELD_BONES = [
  'upperarm_l', 'forearm_l', 'hand_l', 'shoulder_r', 'upperarm_r', 'forearm_r',
];

/**
 * How the shieldman holds the thing, and what each way of holding it costs him.
 *
 * The shield is a real mesh in the hit model, not a damage modifier — so *where it
 * is* decides what it stops, and these stances are the whole balance lever. A plate
 * fronting the torso genuinely eats the rounds that hit it; the same plate hanging
 * off a sprinting man's arm genuinely does not, because it is not between anything.
 * Nothing below needs a rule saying "no protection while running": the geometry
 * already says it.
 *
 * `place` is where the shield sits in the fighter's own frame — metres, +Z forward,
 * +X his left, Y up from his feet — and is *solved* onto whatever bone carries it,
 * never hand-tuned. That is the only reason five stances are maintainable: the arm
 * poses are readable, the placements are readable, and the ugly composition of
 * Eulers against a triple-rotated bone is arithmetic done at build time.
 *
 * `spread` is the accuracy tax, relative to firing without one. Shooting around a
 * slab you are also holding up is genuinely awful, and shouldering the weapon is
 * what claws it back — which is what gives the counterplay something to work with:
 * a hip-firing shieldman is close to harmless, and an aiming one has his head out.
 */
const SHIELD_STANCES = {
  // Standing: angled to his left so the gun arm reaches around the right edge.
  carry: {
    parent: 'hand_l', pose: SHIELD_CARRY,
    place: { x: 0.11, y: 1.00, z: 0.33, yaw: 0.38 },
    speed: 0.66, spread: 3.2, presenting: true,
  },
  // Aiming: squared up and lowered, head and gun arm exposed over the top edge.
  aim: {
    parent: 'hand_l', pose: SHIELD_AIM,
    place: { x: 0.05, y: 0.86, z: 0.35, yaw: 0.16 },
    speed: 0.60, spread: 1.5, presenting: true,
  },
  // Turtled: flush with the ground, and he ducks below the top edge to match.
  turtle: {
    parent: 'hand_l', pose: SHIELD_TURTLE,
    place: { x: 0.00, y: 0.49, z: 0.30, yaw: 0 },
    speed: 0.80, spread: 4.5, presenting: true, crouch: 0.5,
  },
  // Running: down at his side, edge-on to the front. Stops nothing, and is meant to.
  sprint: {
    parent: 'hand_l', pose: SHIELD_RUN,
    place: { x: 0.42, y: 0.62, z: 0.00, yaw: 1.45, roll: 0.22 },
    speed: 0.86, spread: 3.2, presenting: false,
  },
  // Two-handed weapon: slung across his back, where it protects him from nothing he
  // is looking at.
  stowed: {
    parent: 'chest', pose: null,
    place: { x: 0, y: 1.04, z: -0.25, yaw: Math.PI },
    speed: 0.92, spread: 1.0, presenting: false,
  },
};

/**
 * What a shield fronting you does to your opinion of a target.
 *
 * Sized against the terms in `ContactMemory.best`, where being visible is worth 100:
 * large enough that any other visible enemy is a better idea, small enough that a
 * shieldman in the open still beats a rumour of somebody else. Shooting the plate is
 * donating ammunition, and the squad should act like it knows that.
 */
const SHIELD_TARGET_PENALTY = 42;

/**
 * How far a raised shield spoils the ground in front of it, and how wide.
 *
 * The dot is looser than the one used to decide whether the plate is between two
 * particular points, because this is about where a man should *walk*, and walking to
 * the edge of an arc a shieldman can simply turn is not the win it looks like.
 */
const SHIELD_ARC_RANGE = 18;
const SHIELD_ARC_DOT = 0.2;

/**
 * Shield placement on the left hand.
 *
 * Solved, not guessed: these are the local position and rotation that put the shield
 * squarely in front of the torso — centre 1.00 m up, 0.34 m forward, facing +Z, so
 * its top edge lands just under eye level and he looks *over* it. Hand-tuning Euler
 * angles against a bone that is already rotated three ways produced a shield floating
 * diagonally above the fighter's head.
 *
 * If `SHIELD_CARRY` changes, re-solve rather than nudge: `tools/poses/stances.js`
 * reports the shield's box in the fighter's own frame, its clearance from the gun,
 * and where the top edge sits relative to the eyes.
 */
const SHIELD_OFFSET = {
  x: -0.490, y: -0.081, z: -0.013,
  rx: -1.584, ry: -0.161, rz: -0.700,
};

function nameTagSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '700 30px Arial';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const w = ctx.measureText(name).width + 24;
  ctx.fillRect(128 - w / 2, 10, w, 42);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 41);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  sp.scale.set(1.5, 0.375, 1);
  // A label is not a surface. Left on the default layer, the occlusion pass treats the
  // quad as geometry and darkens it — and because that pass re-renders with an override
  // material, which does not billboard, the dark patch lands at whatever angle the raw
  // quad happens to face. That is the black rectangle sitting askew behind the name.
  // See src/layers.js.
  sp.layers.set(NO_OCCLUDE_LAYER);
  return sp;
}

export class Combatant {
  /**
   * opts: { name, team ('player'|'enemy'), weaponId, skill: {spreadMult, reaction, speedMult},
   *         hp, shirt, armor (0..0.6 mitigation), boss, scale, aggro }
   */
  constructor(opts) {
    this.name = opts.name;
    this.team = opts.team;
    this.weaponId = opts.weaponId;
    this.skill = opts.skill;
    this.maxHp = opts.hp;
    this.hp = opts.hp;
    this.armor = opts.armor || 0;
    // per-part mitigation (Tarkov-style slots); plain `armor` maps to body for enemies
    this.armorParts = opts.armorParts || { head: 0, body: opts.armor || 0, limbs: 0 };
    this.boss = !!opts.boss;
    this.archetype = opts.archetype || null; // 'medic' | 'shield' | 'rusher' | 'marksman'
    this.damageMult = opts.damageMult || 1;
    this.damageTakenMult = opts.damageTakenMult || 1;
    this.healingMult = opts.healingMult || 1;
    this.medicCooldownMult = opts.medicCooldownMult || 1;
    this.scale = opts.scale || (0.95 + Math.random() * 0.09); // natural height variety
    this.mendCd = 4;
    this.mendT = 0;
    this.mendTarget = null;
    // soft combat role — a weighting nudge, not a hard rule:
    // pointman pushes, flanker routes wide, support holds angles, shadow escorts the boss
    this.role = opts.role || 'pointman';
    // live ammo: {ammoType: rounds}. Everyone burns real rounds; a dry fighter
    // switches guns, and a fighter with nothing left pulls the knife and charges.
    this.ammoPools = {};
    this.gunOptions = [opts.weaponId];
    this.shirt = opts.shirt;
    this.alive = true;
    this.isPlayer = false;

    this.armDmg = 0;   // 0..1 → worse aim
    this.legDmg = 0;   // 0..1 → slower, limp

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.radius = 0.42 * this.scale;
    this.baseSpeed = (2.9 + Math.random() * 0.3) * (opts.skill.speedMult || 1) * (this.boss ? 0.85 : 1) * (this.archetype === 'rusher' ? 1.3 : 1);

    // AI state
    this.target = null;
    /**
     * Everything this fighter believes about where the enemy is. Nothing in the AI
     * below reads a hostile transform for navigation — it reads this.
     */
    this.perception = new ContactMemory({ owner: this });
    /** The belief currently being acted on, or null when he has genuinely lost you. */
    this.contact = null;
    /** Which angles are being worked, and how hard. */
    this.suppression = new SuppressionMap();
    /** The lane presently covering the ground he is standing on, if any. */
    this.pinnedBy = null;
    this.coverGoal = null;
    this.suppressT = Math.random() * SUPPRESSION_PERIOD;
    /** Seconds left of refusing to advance because every way in is covered. */
    this.holdT = 0;
    /** ...and how much of the budget for doing so he has already spent. */
    this.holdSpent = 0;
    this.senseT = Math.random() * SCAN_PERIOD;
    /** Seconds left of sweeping the head at a pause. */
    this.scanningT = 0;
    this.composed = false;
    this.sprintNoiseT = 0;
    /** Where to sweep when the picture is empty. */
    this.huntGoal = new THREE.Vector3();
    this.huntT = 0;
    this.thinkTimer = Math.random() * 0.3;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 1 + Math.random() * 1.5;
    this.avoidT = 0;
    this.avoidSide = 1;
    this.navSeed = 1 + ((Math.random() * 0x7fffffff) | 0);
    this.flankSide = Math.random() < 0.5 ? -1 : 1;
    this.cautionT = 0;
    this.repathT = Math.random() * 0.5; // stagger so agents don't all path the same frame
    this._straightOK = true;
    // supplies (assigned at spawn by rank/tier)
    this.nades = 0;
    this.nadeCd = 6 + Math.random() * 8;
    this.healKits = 0;
    this.splints = 0;
    this.healingT = 0;
    this.healingKind = null;
    this.sinceHit = 99;
    // stance: crouch cycling + cosmetic lean so heads aren't all at one height
    this.crouchK = 1;
    this.stanceCrouch = false;
    this.stanceTimer = 0.5 + Math.random() * 2;
    this.leanK = 0;
    this.peekSide = 0;
    /** Seconds left committed to the current lean, and until the next one is allowed. */
    this.peekT = 0;
    this.peekCd = 0;
    /** Rounds left in the current burst of area fire. */
    this.suppressLeft = 0;
    // Aiming down sights, 0..1.
    //
    // Bots used to shoot the instant their reaction timer expired, from whatever pose
    // the walk happened to be in, which is why none of them ever looked like they were
    // aiming. Now shouldering is a state with a cost: it takes time, it slows him
    // down, and it is worth it because his shots land.
    this.adsK = 0;
    this.wantsAds = false;
    // Last frame's world displacement, kept so the locomotion blendspace can be told
    // which way he is actually travelling rather than assuming it is where he faces.
    this._moveDX = 0;
    this._moveDZ = 0;
    this.sprintNow = false;
    this.openingGoal = new THREE.Vector3();
    this.openingT = 0;
    // patience: holding an angle too long without moving triggers a push
    this.stallAnchor = { x: 0, z: 0 };
    this.stallT = 0;
    this.pushT = 0;
    this.breachT = 0;
    this.breachTarget = null;
    this.breachGoal = new THREE.Vector3();
    this.breachLane = 0;
    this.breachStaging = false;
    this.breachCost = 0;
    this.breachGoalSafe = true;
    /** Frontal fire on the plate: get low and keep coming. */
    this.shieldWall = false;
    /** Which way the plate is being held, and what that costs. */
    this.shieldStance = null;
    this.shieldPresenting = false;
    this.shieldSpeedMult = 1;
    this.shieldSpreadMult = 1;
    this.shieldCrouch = null;
    /** Elected to hold a shieldman's attention while the squad goes round him. */
    this.baiting = false;
    /** What squadmates have told him they are doing. Never read off them. */
    this.knownLanes = new Map();
    /** Holding the angle for the squad, or moving behind somebody who is. */
    this.onOverwatch = false;
    this.covered = false;
    this.cooldown = 0.5 + Math.random();
    this.burstLeft = this._burstSize();
    this.reactionLeft = 0;
    this.hadLoS = false;
    this.animPhase = Math.random() * 6;
    this.moveAmount = 0;
    this.deathT = -1;
    this.fadeT = 0;

    this._buildBody();
  }

  _burstSize() {
    const w = WEAPONS[this.weaponId];
    if (w.auto) return w.rpm > 700 ? 5 + (Math.random() * 3 | 0) : 3 + (Math.random() * 2 | 0);
    return 1;
  }

  _poolFor(weaponId) {
    const t = ITEM_TYPES[weaponId]?.ammo;
    return t ? (this.ammoPools[t] || 0) : 0;
  }

  // out of rounds for the current gun: fall back to a fed gun, or the knife
  _switchDry(world) {
    const previous = this.weaponId;
    let next = 'knife';
    let bestTier = -2;
    for (const id of this.gunOptions) {
      if (id === this.weaponId || WEAPONS[id].melee) continue;
      if (this._poolFor(id) > 0 && WEAPONS[id].tier > bestTier) { bestTier = WEAPONS[id].tier; next = id; }
    }
    this.weaponId = next;
    this.rig.weaponSocket.remove(this.gun);
    this.gun = buildHeldGun(next);
    this.rig.weaponSocket.add(this.gun);
    this.rig.setWeapon(next, this.gun);
    this.rig.trigger('reload');       // swapping to a fed gun reads as working the weapon
    this.burstLeft = this._burstSize();
    this.cooldown = 0.5;
    world.onCombatEvent?.('weapon_switch', this, { from: previous, to: next, reason: 'dry' });
  }

  _buildBody() {
    const s = this.scale;
    this.rig = new FighterRig({ uniformColor: this.shirt, scale: s });
    this.rig.bindOwner(this);
    this.group = this.rig.group;

    const bone = (name) => this.rig.bones.get(name);

    // Held weapon rides the authored hand socket, so a rifle and a knife both sit in
    // the fist and follow every animation without a hand-tuned offset per clip.
    this.gun = buildHeldGun(this.weaponId);
    this.rig.weaponSocket.add(this.gun);
    this.rig.setWeapon(this.weaponId, this.gun);

    // Extra armour reads as extra plate. The base fighter already wears a carrier;
    // this is the visible difference between a rookie and a kitted veteran.
    if (this.armorParts.body > 0) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.30, 0.10), surface('TD_steel_painted'));
      // The chest bone's local +Z is forward (its roll pins local X to world X),
      // so a positive Z offset puts the plate on the chest and a negative one hides
      // it on his back.
      plate.position.set(0, 0.07, 0.15);
      plate.castShadow = true;
      plate.userData = { combatant: this, part: 'torso' };
      bone('chest')?.add(plate);
      this.extraPlate = plate;
    }
    if (this.armorParts.head > 0) {
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 7), surface('TD_steel_painted'));
      lid.position.y = 0.11;
      lid.scale.set(1, 0.85, 1.05);
      lid.castShadow = true;
      bone('head')?.add(lid);   // cosmetic: the rig's head box already covers it
    }

    // The boss's gold mask is a separate mesh on the head bone: the fighter atlas is
    // shared by the whole cast, so tinting one head is not an option.
    if (this.boss) {
      const mask = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8), surface('TD_gold'));
      mask.position.set(0, 0.10, 0.01);
      mask.scale.set(1, 0.95, 1.02);
      mask.castShadow = true;
      mask.userData = { combatant: this, part: 'head' };
      bone('head')?.add(mask);
      const eye = new THREE.Mesh(
        new THREE.BoxGeometry(0.20, 0.035, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff2020, emissiveIntensity: 3 }),
      );
      eye.position.set(0, 0.11, 0.14);
      bone('head')?.add(eye);
    }

    // archetype dressing, parented to the bones it belongs on
    if (this.archetype === 'shield') {
      // Carried in the left hand, and posed rather than bolted on.
      //
      // The shield has two jobs that pull against each other: it has to be a *stable*
      // frontal barrier (the archetype's rule is "torso immune from the front", so the
      // protected angle must be readable), and it has to be genuinely held, so it
      // falls with the arm when he dies and moves like a carried object. Parenting it
      // to the torso got stability by giving up the second; leaving the arm animated
      // got the second by giving up the first.
      //
      // The answer is to pin the carry pose. The shield rides the hand, but the arm
      // that holds it is held in `SHIELD_CARRY` against the locomotion and aim layers,
      // so it is hand-held and still presents a fixed angle.
      const shield = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.95, 0.06), surface('TD_steel_painted'));
      shield.position.set(SHIELD_OFFSET.x, SHIELD_OFFSET.y, SHIELD_OFFSET.z);
      shield.rotation.set(SHIELD_OFFSET.rx, SHIELD_OFFSET.ry, SHIELD_OFFSET.rz);
      shield.castShadow = true;
      shield.userData = { combatant: this, part: 'shield' };
      bone('hand_l')?.add(shield);
      this.shieldMesh = shield;
      // Solved once, here, against the bind pose — five stances' worth of local
      // transforms, each derived by asking where the carrying bone ends up when the
      // arm is posed that way and inverting it. Hand-tuning one of these produced a
      // shield floating diagonally above a fighter's head; hand-tuning five was
      // never going to happen.
      this._setShieldStance(this._shieldStanceName(false));
    } else if (this.archetype === 'medic') {
      const cross = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.16, 0.02),
        new THREE.MeshStandardMaterial({ color: 0xd8d8d8, emissive: 0xff3030, emissiveIntensity: 0.25 }),
      );
      cross.position.set(0.09, 0.06, 0.15);
      bone('chest')?.add(cross);
    } else if (this.archetype === 'rusher') {
      // Warm paint, not a lamp.
      //
      // At 1.6 this cleared the bloom threshold (0.82, see src/render.js) and became a
      // glowing ring on a man's head, readable across the whole arena — and the rusher
      // is the archetype that sprints at you from an angle, so it announced every
      // flank before it arrived. Archetype markers have to stay under that threshold;
      // the medic's cross at 0.25 always did, which is why only this one gave the game
      // away.
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.29, 0.05, 0.29),
        new THREE.MeshStandardMaterial({ color: 0x902a08, emissive: 0xff5a1a, emissiveIntensity: 0.3 }),
      );
      band.position.y = 0.135;
      bone('head')?.add(band);
    }

    // name tag — crew only; giant red enemy labels made targets trivial to spot
    if (this.team === 'player') {
      this.tag = nameTagSprite(this.name, '#86ff3c');
      this.tag.position.y = 1.95 * s;
      this.tag.material.opacity = 0.55;
      this.tag.scale.multiplyScalar(0.75);
      this.group.add(this.tag);
    } else {
      this.tag = { visible: false }; // stub so death code can hide it uniformly
    }

    // Hitboxes are the rig's bone-parented proxies plus any prop that should eat
    // shots in its own right.
    this.parts = [...this.rig.hitboxes];
    if (this.extraPlate) this.parts.push(this.extraPlate);
    if (this.shieldMesh) this.parts.push(this.shieldMesh); // the shield physically eats frontal shots
  }

  addTo(world, pos) {
    this.pos.copy(pos);
    // Where he came in. Not knowledge of the enemy — knowledge of the pit, which is
    // what a fighter with no contact at all sweeps toward.
    this.spawnPos = pos.clone();
    this.group.position.copy(pos);
    world.scene.add(this.group);
    world.combatants.push(this);
    for (const p of this.parts) world.hitMeshes.push(p);
    if (this.archetype === 'marksman') {
      // the laser IS the telegraph — see red, move
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      this.laser = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.7 }));
      this.laser.visible = false;
      this.laser.frustumCulled = false;
      world.scene.add(this.laser);
    }
    this.group.updateMatrixWorld(true);
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.55 * this.scale * this.crouchK, this.pos.z);
  }

  /**
   * The barrel tip, in the world, as drawn.
   *
   * Not a point derived from where the fighter is standing — the actual node on the
   * actual weapon, after the animation, the lean and the aim offset have all been
   * applied. Shots are fired from here and drawn from here, and those being the same
   * point is the whole guarantee: if a round can reach you, the weapon that fired it
   * was somewhere you could see.
   *
   * Falls back to the eye before the weapon has loaded.
   */
  /** A two-handed weapon puts the shield on his back; there is no third arm. */
  get twoHanded() { return !WEAPONS[this.weaponId]?.oneHanded; }

  muzzleWorld(out = new THREE.Vector3()) {
    const m = this.gun && this.gun.userData.muzzle;
    if (!m) return this.eyePos(out);
    this.group.updateMatrixWorld(true);
    return out.setFromMatrixPosition(m.matrixWorld);
  }
  aimPoint(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.15 * this.scale * this.crouchK, this.pos.z);
  }

  applyDamage(world, part, dmg, shooter, point, dir = null) {
    if (!this.alive) return;
    if (part === 'shield') { dmg *= 0.06; world.fx.sparks(point, dir, null, false); audio.ricochet(); }
    // Crack and thump: being hit gives up roughly where it came from, and only
    // roughly. Gated on `sinceHit` so a burst — or a shotgun — is one noise rather
    // than one per round that lands.
    if (shooter?.pos && shooter.team !== this.team && this.sinceHit > 0.5) {
      world.emitNoise?.(shooter, shooter.pos, 'impact');
      // ...and he shouts, which is how the rest of the squad finds out that *this
      // spot* is where you get shot, without each of them having to discover it.
      const told = world.reportHit?.(this, this.pos) ?? 0;
      world.onCombatEvent?.('hit_ground', this, {
        shooter: shooter.isPlayer ? 'YOU' : shooter.name || null,
        told,
        at: [this.pos.x, this.pos.y, this.pos.z].map(v => +v.toFixed(2)),
      });
      if (dmg > this.maxHp * 0.12) {
        audio.hurt(1.2 / (1 + this.pos.distanceTo(world.cameraPos) * 0.09));
      }
    }
    this.sinceHit = 0;
    this.healingT = 0; // getting shot interrupts bandaging
    this.mendT = 0;
    if (part === 'torso') dmg *= (1 - this.armorParts.body);
    else if (part === 'head') dmg *= (1 - this.armorParts.head);
    else dmg *= (1 - this.armorParts.limbs);
    dmg *= this.damageTakenMult;
    if (this.boss && part === 'head') dmg *= 0.55; // gold mask
    const hpBefore = this.hp;
    this.hp -= dmg;
    world.onDamage?.(shooter, this, Math.min(hpBefore, Math.max(0, dmg)));

    if (part === 'armL' || part === 'armR') this.armDmg = Math.min(1, this.armDmg + 0.4);
    if (part === 'legL' || part === 'legR') this.legDmg = Math.min(1, this.legDmg + 0.4);

    if (part !== 'shield') {
      world.fx.blood(point, dir);
      if (this.hp > 0) this.rig.trigger('hit_react', part === 'head' ? 1 : 0.75);
    }
    const camDist = point.distanceTo(world.cameraPos);
    if (camDist < 25 && part !== 'shield') audio.hitFlesh();

    if (this.hp <= 0) {
      this.die(world, shooter, part);
    } else if (shooter.isPlayer) {
      world.onHitmarker(false, part === 'head');
    }
  }

  die(world, killer, part) {
    this.alive = false;
    this.deathT = 0;
    this.tag.visible = false;
    // Which authored collapse plays depends on where the shot came from, so a
    // fighter shot in the back falls forward. Headshots skip the bracing entirely.
    let fromFront = 1;
    if (killer?.pos) {
      const toKiller = _aimTmp.set(killer.pos.x - this.pos.x, 0, killer.pos.z - this.pos.z);
      fromFront = toKiller.x * Math.sin(this.yaw) + toKiller.z * Math.cos(this.yaw);
    }
    this.rig.die(fromFront, part === 'head');
    // The squad rosters changed mid-frame; whoever updates after this fighter died
    // must not elect him to overwatch or hand him intel.
    world._squadCache = null;
    if (this.laser) this.laser.visible = false;
    if (this.bountyMarker) { this.group.remove(this.bountyMarker); this.bountyMarker = null; }
    this.bountyRevealed = false;
    // remove hitboxes
    world.hitMeshes = world.hitMeshes.filter(m => m.userData.combatant !== this);
    audio.hurt();
    // Squadmates who watch this go down get cautious, and — the part that actually
    // stops the single-file feed — they remember *the angle that did it*. Caution is
    // a couple of seconds of jinking; a deadly lane is a piece of ground the squad
    // will route around for the next nine, however quiet it goes.
    const now = world.simTime ?? 0;
    for (const c of world.combatants) {
      if (c === this || !c.alive || c.team !== this.team) continue;
      if (killer?.pos) c.suppression?.record(killer.pos, SUPPRESSION.kill, now, { deadly: true });
      if (c.archetype !== 'rusher' && c.pos.distanceTo(this.pos) < 9) {
        c.cautionT = Math.max(c.cautionT, 0.9 + Math.random() * 1.1);
      }
    }
    world.onKill(killer, this, part);
    if (killer.isPlayer) world.onHitmarker(true, part === 'head');
  }

  update(world, dt) {
    if (!this.alive) {
      // The collapse is an authored clip now, so all this has to do is keep the mixer
      // running, drop the blood pool once the body is down, and fade the corpse out.
      this.deathT += dt;
      this.rig.update(dt);
      if (this.deathT > 1.1 && !this.pooled) {
        this.pooled = true;
        world.fx.bloodPool(this.pos);
      }
      if (this.deathT > 6) {
        if (!this.fadingOwn) {
          // Fighter materials are shared across the cast; fading has to happen on
          // private copies or one corpse takes every fighter with it.
          this.fadingOwn = true;
          this.rig.privatizeMaterials();
        }
        this.fadeT += dt;
        const op = Math.max(0, 1 - this.fadeT / 1.5);
        this.rig.setOpacity(op);
        if (op <= 0) this.group.visible = false;
      }
      return;
    }

    const w = WEAPONS[this.weaponId];
    this.cooldown -= dt;
    this.thinkTimer -= dt;
    this.strafeTimer -= dt;
    this.sinceHit += dt;
    this.nadeCd -= dt;
    if (this.cautionT > 0) this.cautionT -= dt;

    // bandaging channel: crouched, helpless, healing
    if (this.healingT > 0) {
      this.healingT -= dt;
      if (this.healingT <= 0) {
        if (this.healingKind === 'splint') {
          this.armDmg = 0;
          this.legDmg = 0;
        } else {
          this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.45);
        }
        this.healingKind = null;
      }
    }

    // medics keep their squad in the fight
    if (this.archetype === 'medic') {
      this.mendCd -= dt;
      if (this.mendT > 0) {
        this.mendT -= dt;
        if (this.mendT <= 0 && this.mendTarget?.alive) {
          const t = this.mendTarget;
          const hpBefore = t.hp;
          t.hp = Math.min(t.maxHp, t.hp + t.maxHp * 0.4 * this.healingMult);
          t.armDmg = 0; t.legDmg = 0;
          world.onSupport?.(this, Math.max(0, t.hp - hpBefore));
          this.mendCd = 9 * this.medicCooldownMult;
          this.mendTarget = null;
        }
      } else if (this.mendCd <= 0 && this.sinceHit > 1.5 && (!this.mendTarget || !this.mendTarget.alive)) {
        this.mendTarget = null;
        let bd = 13 * 13;
        for (const c of world.combatants) {
          if (c === this || !c.alive || c.team !== this.team) continue;
          if (c.hp < c.maxHp * 0.6) {
            const d = this.pos.distanceToSquared(c.pos);
            if (d < bd) { bd = d; this.mendTarget = c; }
          }
        }
      }
    }

    // patience meter: parked in one spot with a live target → eventually surge
    const sdx = this.pos.x - this.stallAnchor.x, sdz = this.pos.z - this.stallAnchor.z;
    if (sdx * sdx + sdz * sdz > 9) {
      this.stallAnchor.x = this.pos.x; this.stallAnchor.z = this.pos.z;
      this.stallT = 0;
    } else if (this.target && !this.pinnedBy && this.holdT <= 0) {
      // Standing still because an angle is being worked is not impatience, and the
      // surge it used to earn walked him out of cover and into the open on a timer.
      // The patience meter is for a fighter who has run out of ideas, not one who is
      // waiting out a gun — the hold has its own budget for that.
      this.stallT += dt;
      if (this.stallT > (this.role === 'support' ? 13 : 8)) {
        this.stallT = 0;
        this.pushT = 3.5 + Math.random() * 1.5;
      }
    }
    if (this.pushT > 0) this.pushT -= dt;
    if (this.breachT > 0) this.breachT -= dt;

    // Stance cycling and jinking are for being shot at. A fighter who believes he
    // is safe — nothing hot on his map, no enemy in view — used to run the full
    // combat fidget anyway, bobbing and cutting between decisions like a man under
    // fire, which reads as glitching rather than as caution. Composed until there
    // is a reason not to be; the fidgets return the moment danger does.
    this.composed = !this.suppression.anyDanger(world.simTime ?? 0) && !this.contact?.visible;
    this.stanceTimer -= dt;
    if (this.stanceTimer <= 0) {
      this.stanceCrouch = !this.composed && !this.stanceCrouch && Math.random() < 0.45;
      this.stanceTimer = this.stanceCrouch ? 0.9 + Math.random() * 1.1 : 1.1 + Math.random() * 1.9;
    }

    // ---- perceive ----
    // Sweep every hostile for an actual sightline, then age the picture. Everything
    // downstream navigates on what comes out of here, not on the live transforms.
    const now = world.simTime ?? (this._clock = (this._clock ?? 0) + dt);
    this.senseT -= dt;
    if (this.senseT <= 0) {
      this.senseT = SCAN_PERIOD * (0.85 + Math.random() * 0.3);
      this._scan(world, now);
    }
    for (const gone of this.perception.tick(now)) {
      world.onCombatEvent?.('contact_lost', this, {
        target: gone.entity?.isPlayer ? 'YOU' : gone.entity?.name || null,
        kind: gone.kind,
        age: +(now - gone.t).toFixed(2),
        probes: gone.probes,
      });
    }
    // Sprinting boots give a fighter away. He pays the same price the player does.
    this.sprintNoiseT -= dt;
    if (this.sprintNow && this.sprintNoiseT <= 0) {
      this.sprintNoiseT = SPRINT_NOISE_PERIOD;
      world.emitNoise?.(this, this.pos, 'sprint');
    }

    // ---- suppression ----
    // Am I standing in something's beaten zone, and if so where is out of it?
    // Rushers were told and do not care, which is the whole archetype.
    this.suppression.decayTo(now);
    if (this.holdT > 0) {
      this.holdT -= dt;
      this.holdSpent += dt;
    } else if (!this.pinnedBy) {
      // The budget refills once he is out of it, but slowly, so a fighter who has
      // just spent five seconds pinned does not immediately buy another five.
      this.holdSpent = Math.max(0, this.holdSpent - dt * 0.5);
    }
    this.suppressT -= dt;
    // Rushers used to skip this entirely, which made them blind rather than brave.
    // A rusher should take the short way and accept the crossing — he still does,
    // because the lane chooser and the break-for-cover branch both exempt him — but
    // knowing where the beaten zone is lets him sprint across it instead of jogging
    // into it and stopping. Charging is the archetype; not noticing is a bug.
    if (this.suppressT <= 0) {
      this.suppressT = SUPPRESSION_PERIOD * (0.85 + Math.random() * 0.3);
      const before = this.pinnedBy;
      const sees = (from, to) => this._dangerSees(world, from, to);
      // The shield wall: a frontal hot lane is his cue, not his problem. He gets
      // low behind the plate and keeps coming — crouched, so his head drops below
      // the shield's top edge in the actual hitbox geometry, weapon down because
      // hip fire past the edge is what the carry pose is built for. This is the
      // boldness the archetype promises, and it is conditional on facing: fire on
      // his flank pins him like anybody else, because the shield is not there.
      this.shieldWall = false;
      if (this.archetype === 'shield' && this.suppression.anyHot(now)) {
        for (const lane of this.suppression.lanes) {
          if (lane.heat >= 3.5 && this._shieldFronts(lane)) { this.shieldWall = true; break; }
        }
      }
      this.pinnedBy = this.suppression.anyHot(now)
        ? this.suppression.covering(this.aimPoint(_routePoint), sees, now)
        : null;
      // Searching for cover costs fifteen sightlines; confirming the piece he is
      // already running to costs one. Only re-solve when the lane changes or the
      // spot he picked has stopped being cover.
      if (!this.pinnedBy) {
        this.coverGoal = null;
      } else if (!this.coverGoal || this.pinnedBy !== before ||
                 sees(this.pinnedBy, _routePoint.set(this.coverGoal.x, this.coverGoal.y + 1.15, this.coverGoal.z))) {
        const standable = (p) => this._standable(world, p);
        this.coverGoal = coverStep(this.pinnedBy, this.pos, sees, { standable })
          // Nowhere hidden within reach is not a reason to stay on the line. Cover is
          // the good outcome; being off the line is the necessary one.
          || stepOutOfLane(this.pinnedBy, this.pos, standable);
      }
      if (before && !this.pinnedBy) {
        // He just made it out of the lane. Settle here for a beat rather than
        // stepping straight back into it — without this he oscillates on the edge of
        // cover, which looks worse than never having taken cover at all.
        this.holdT = Math.max(this.holdT, 1.2 + Math.random() * 1.2);
      }
      // Getting a fighter to use the cover on his own side: four attempts, four
      // losses, so the record is here instead of the code.
      //
      //   walk him to a coverStep spot ......... deaths 14->18/30, damage 80.7k->68.1k
      //   bias his jink toward the unswept side  deaths 18->22/30, damage 71k->55.7k
      //   the same, gated so only the rusher and
      //   shieldman accept being exposed ....... damage 11.5k->8.4k, deaths unchanged
      //   the overwatch setter only, who has
      //   stopped advancing anyway ............. damage 1,744->981, +7% survival
      //
      // The third ran against a holder who *swings* onto whatever shows, built
      // precisely because the first two might only have measured badly for want of a
      // scenario that punishes exposure. It did punish it, and cover-seeking still
      // lost. The fourth removed the last excuse — the setter has already stopped
      // advancing, so the steps cost him no firing time in principle — and lost too.
      //
      // Four mechanisms, one result, so it is the premise that is wrong rather than
      // the implementations. Movement and fire are exclusive here: a fighter who is
      // walking is not shooting, and against an opponent who cannot be killed,
      // surviving longer while shooting less is not winning. Cover will only start
      // paying when a fighter can relocate without going quiet — which is a firing
      // -while-moving mechanism, not another way of choosing where to stand.
      //
      // The finding underneath is larger than the positioning. Against a holder who
      // turns, the squad loses all thirty of thirty however they stand, at every
      // accuracy worth calling a player. Their answer to a held angle is to shoot
      // back from wherever they are, and that answer does not work — which is a
      // question about suppressing and displacing as a squad, not about where one
      // man puts his feet.
      // Fighting *from* cover, rather than wherever the walk happened to end, is
      // the obvious next thing and it does not work. A fighter who has flanked wide
      // is out of the beaten zone and so not pinned, and he stands in the open
      // trading with a man behind a wall — the cover on his side goes unused, which
      // looks wrong and is wrong. But moving him onto it costs more than it saves:
      // using the target position as the thing to hide from and  to find
      // the spot, deaths went 14 to 18 of 30 and damage put on the shooter fell from
      // 80,700 to 68,100. He spends the fight relocating instead of shooting, and is
      // exposed while he does it. Whatever fixes this has to keep his weapon on the
      // target while he moves, which is a different mechanism to this one.
      // A committed lane is re-examined while he walks it.
      //
      // The route was costed once, at the moment of commitment, and then honoured for
      // the next six to eleven seconds no matter what happened in them. That is the
      // largest remaining way a fighter ends up in the open: he picks a clean lane,
      // sets off, the gun shifts onto it, and nothing in him is still asking. Eighty
      // three percent of the trips into a beaten zone that were left came from a
      // commitment made before the danger existed.
      //
      // Held for a beat first, so a lane cannot be abandoned the instant it is taken
      // and the two decisions oscillate.
      // Lane 0 was excluded from this check, which is precisely backwards: lane 0 is
      // the one that runs straight at him. A fighter who commits in the first half
      // second — before a shot has been fired, when every route costs nothing —
      // walks the centre and nothing re-examines it, which is the walking-straight-in
      // you see at the start of a fight.
      // ...but never re-decided from *inside* the zone. Every option a man standing
      // in the bullets can pick involves crossing more of them, and the one he keeps
      // picking is the one he just came from — cross, flinch, dive straight back.
      // Mid-zone, the decision was made; the only good move left is finishing it.
      if (this.breachT > 0 && this.breachTarget === this.target && !this.pinnedBy &&
          now - (this._breachAt ?? -99) > 0.8 && this.suppression.anyDanger(now) &&
          this._routeCost(world, this.breachGoal, now) >= LANE_ABANDON) {
        this.breachT = 0;   // re-decide on the next think, with the fire as it is now
        world.onCombatEvent?.('breach_abandoned', this, {
          lane: this.breachLane,
          target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
        });
      }
      if (this.pinnedBy && !before) {
        world.onCombatEvent?.('suppressed', this, {
          lane: [this.pinnedBy.x, this.pinnedBy.y, this.pinnedBy.z].map(v => +v.toFixed(2)),
          heat: +this.pinnedBy.heat.toFixed(2),
          kills: this.pinnedBy.kills,
          range: +Math.hypot(this.pinnedBy.x - this.pos.x, this.pinnedBy.z - this.pos.z).toFixed(2),
          cover_found: !!this.coverGoal,
        });
      }
    }

    // ---- acquire target ----
    if (this.thinkTimer <= 0 || (this.target && !this._targetAlive())) {
      this.thinkTimer = 0.35 + Math.random() * 0.25;
      const previousTarget = this.target;
      this.contact = this.perception.best(now, {
        from: this.pos, current: this.target,
        // Shooting a shield is donating ammunition. Anyone else visible is a better
        // idea — unless he is the man elected to hold its attention, who is supposed
        // to be looking straight at it.
        penalty: (e) => (!this.baiting && this._shieldFacingMe(e) ? SHIELD_TARGET_PENALTY : 0),
      });
      this.target = this.contact?.entity || null;
      if (this.target !== previousTarget) {
        world.onCombatEvent?.('target_change', this, {
          from: previousTarget?.isPlayer ? 'YOU' : previousTarget?.name || null,
          to: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
          via: this.contact?.kind || null,
        });
      }
    } else if (this.target) {
      // Keep the record pointer live: `tick` may have replaced or dropped it.
      this.contact = this.perception.get(this.target);
      if (!this.contact) this.target = null;
    }

    // ---- one man on the front of the shield, everyone else around it ----
    //
    // A shieldman fronting the squad is a problem nobody solves by shooting him, and
    // a squad that all correctly decides to go round him leaves nobody keeping him
    // looking the wrong way. So exactly one is elected to stand in the arc and keep
    // his attention: the furthest back, because the shieldman's return fire is
    // dreadful at range and the bait is meant to survive being bait.
    //
    // Elected, not assigned, on the same cadence as everything else — it survives the
    // bait dying, and the job passes to whoever is still looking at him.
    this.baiting = false;
    if (this.target && this._shieldFacingMe(this.target)) {
      let bait = null, bestScore = -Infinity;
      for (const c of world.combatants) {
        if (!c.alive || c.team !== this.team || typeof c._shieldFacingMe !== 'function') continue;
        if (!c._shieldFacingMe(this.target)) continue;
        if (c !== this && c.target !== this.target) continue;
        const score = c.pos.distanceTo(this.target.pos) + (c.coverGoal ? 3 : 0);
        if (score > bestScore) { bestScore = score; bait = c; }
      }
      this.baiting = bait === this;
    }

    // ---- bounding ----
    // Somebody holds the angle; everybody else moves behind it. Elected rather than
    // assigned so it survives men dying, and re-elected on the think cadence so the
    // job passes to whoever still has eyes on.
    if (this.target) {
      const squad = aliveSquad(world, this.team);
      const setter = electOverwatch(squad, this.target);
      const wasSetter = this.onOverwatch;
      this.onOverwatch = setter === this;
      this.covered = isCovered(setter, this, now);
      if (this.onOverwatch && !wasSetter) {
        world.onCombatEvent?.('overwatch_set', this, {
          target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
          squad: squad.length,
        });
      }
    } else {
      this.onOverwatch = false;
      this.covered = false;
    }

    const speedMult = 1 - this.legDmg * 0.45;
    let moving = false;
    const move = _moveAcc.set(0, 0, 0);

    // ---- hazard avoidance ----
    let fleeing = false;
    for (const z of world.zones) {
      const dx = this.pos.x - z.x, dz = this.pos.z - z.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < (z.r + 1.5) * (z.r + 1.5)) {
        const d = Math.max(0.01, Math.sqrt(d2));
        move.x += (dx / d) * 3; move.z += (dz / d) * 3;
        fleeing = true;
      }
    }
    // live grenades: everyone scatters — except rushers, who were warned and do not care
    if (world.grenades && this.archetype !== 'rusher') for (const gr of world.grenades) {
      const dx = this.pos.x - gr.pos.x, dz = this.pos.z - gr.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 6.5 * 6.5) {
        const d = Math.max(0.01, Math.sqrt(d2));
        move.x += (dx / d) * 4; move.z += (dz / d) * 4;
        fleeing = true;
      }
    }

    this._traveling = false;
    this._strafing = false;
    this.sprintNow = false;

    if (this.target && !fleeing && this.healingT <= 0 && this.mendT <= 0) {
      // geometric sightline to target — with no sight, range means nothing: keep hunting
      const eye = this.eyePos(_eyeSelf);
      const aim = this.target.isPlayer
        ? _aimHold.copy(playerAimPoint(world, eye, world.playerProxy, _aimTmp))
        : this.target.aimPoint(_aimHold);
      // Re-checked every frame for the fighter he is actually engaging, because the
      // moment sight breaks is the moment the belief freezes, and a scan-cadence
      // answer would leave him tracking a live transform for a fifth of a second.
      const sight = hasLoS(world, eye, aim) &&
        withinVision(this.pos, this.yaw, this.target.pos);
      if (sight) {
        // How wide the search had grown at the moment he re-found them. Captured
        // before the sighting collapses it to zero, because it is the number that
        // says whether he walked onto a stale belief or never really lost contact.
        this._reacquireRadius = !this.contact ? null
          : this.contact.visible ? 0
            : contactRadius(this.contact, now);
        this.contact = this.perception.see(this.target, this.target.pos, now);
        // Call it in. The squad converges on where *he* saw them, a beat later.
        _shareMates.length = 0;
        for (const c of aliveSquad(world, this.team)) if (c !== this) _shareMates.push(c);
        this.perception.share(this.target, now, _shareMates);
      } else if (this.contact?.visible) {
        this.perception.markUnseen(this.target, now);
        world.onCombatEvent?.('contact_broken', this, {
          target: this.target.isPlayer ? 'YOU' : this.target.name || null,
          last_known: [this.contact.x, this.contact.y, this.contact.z].map(v => +v.toFixed(2)),
        });
      }

      // Where he *believes* the target is — the whole point of the exercise. While he
      // can see them this is the truth; the instant he cannot, it is a memory that
      // stops moving, and every route below is planned against it.
      const belief = this.contact || { x: this.pos.x, y: this.pos.y, z: this.pos.z, error: 0, t: now };
      const uncertainty = this.contact ? contactRadius(this.contact, now) : 0;
      const tp = this._searchGoal(belief, uncertainty, sight, now, world, _targetBelief);
      const dx = tp.x - this.pos.x, dz = tp.z - this.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const fx = dx / (dist || 1), fz = dz / (dist || 1);
      const engage = w.aiRange * (this.boss ? 1.15 : 1) * (this.role === 'support' ? 1.35 : 1);

      if (this.strafeTimer <= 0) {
        this.strafeDir *= -1;
        this.strafeTimer = 1.1 + Math.random() * 1.6;
      }

      // Corner peek: body stays covered, lean the weapon out sideways for an angle.
      //
      // PEEK_REACH is how far leaning actually carries the muzzle, measured off the
      // rig — not a number picked to make the AI effective. It used to be 0.6 m
      // against a lean worth about a quarter of that, so a fighter could shoot from a
      // point two thirds of a metre outside his own body: an angle that did not exist
      // from the other end, which is exactly what an unfair peek is.
      //
      // The shot itself is fired from the real muzzle regardless of what this decides,
      // so the worst a wrong guess here can do is make him lean out and find nothing.
      // A peek is *committed to*, not re-decided every frame.
      //
      // Recomputing it per frame meant a fighter who leaned out far enough to see
      // immediately stopped having a reason to lean, snapped back, re-found the angle
      // and leaned again — a flicker several times a second that is unreadable to
      // shoot at and looks nothing like working a corner. He now commits for the best
      // part of a second, and waits a beat before the next one, so the rhythm is
      // something the other side can actually play against.
      this.peekT -= dt;
      this.peekCd -= dt;
      if (this.peekT <= 0) this.peekSide = 0;
      // A lean already under way is abandoned the moment that side starts being
      // worked. Commitment is what makes a peek readable; committing to lean into
      // something that has opened up since is just a slower way of dying.
      if (this.peekSide && this._peekSwept(world, this.peekSide, fx, fz, now)) {
        this.peekSide = 0;
        this.peekT = 0;
        this.peekCd = Math.max(this.peekCd, 0.6 + Math.random() * 0.5);
      }
      let peekRefused = false;
      if (this.peekSide === 0 && this.peekCd <= 0 && !sight && dist < engage * 1.8) {
        for (const side of [this.strafeDir, -this.strafeDir]) {
          _peekEye.set(eye.x + -fz * PEEK_REACH * side, eye.y, eye.z + fx * PEEK_REACH * side);
          if (!hasLoS(world, _peekEye, aim)) continue;
          // An angle that exists is not the same as an angle worth taking. Without
          // this the whole suppression model stopped at the edge of cover: a fighter
          // would sit out a hot lane correctly, work the safe corner a few times, and
          // then lean straight into the one being worked because the geometry said
          // there was a shot there.
          if (this._peekSwept(world, side, fx, fz, now)) { peekRefused = true; continue; }
          this.peekSide = side;
          this.peekT = 0.75 + Math.random() * 0.6;
          this.peekCd = this.peekT + 0.55 + Math.random() * 0.5;
          break;
        }
      }
      // Refusing the angle has to mean *staying put*. On its own, blocking the peek
      // only sent him down the travel branch instead — and walking into the lane is
      // strictly worse than leaning into it, because a lean is over in a second. The
      // first cut of this fix measurably got more of them killed for exactly that
      // reason: 84 rounds to wipe the squad before, 65 after.
      if (peekRefused && this.peekSide === 0 && this.holdSpent < HOLD_BUDGET) {
        this.holdT = Math.max(this.holdT, 0.5 + Math.random() * 0.6);
      }

      // patch up when hurt and out of contact
      if (this.healKits > 0 && this.hp < this.maxHp * 0.38 && this.sinceHit > 2.2 && (!sight || dist > engage * 1.6)) {
        this.healKits--;
        this.healingT = 2.1;
        this.healingKind = 'medkit';
      } else if (this.splints > 0 && Math.max(this.armDmg, this.legDmg) >= 0.4 &&
        this.sinceHit > 2.2 && (!sight || dist > engage * 1.6)) {
        this.splints--;
        this.healingT = 1.8;
        this.healingKind = 'splint';
      }
      // Frag the target's hiding spot when we can't get an angle — but only a spot he
      // has actual reason to believe in.
      //
      // This is where the old model was at its worst: a grenade thrown at the live
      // transform of somebody the thrower had never seen, arcing round a corner onto
      // a player who had done everything right. Now it costs a recent sighting or a
      // tight enough sound fix, and it lands on the *belief* — so a frag chases where
      // you were, and repositioning beats it.
      const fraggable = worthGrenading(this.contact, now);
      if (this.healingT <= 0 && this.nades > 0 && this.nadeCd <= 0 && !sight && fraggable &&
        dist > 6 && dist < 18 && world.throwGrenade && Math.random() < dt * 0.55) {
        const ndx = tp.x - this.pos.x, ndz = tp.z - this.pos.z;
        const nd = Math.hypot(ndx, ndz) || 1;
        const nspd = Math.min(12.5, Math.max(7, nd * 0.78));
        const eye = this.eyePos();
        // Where the grenade will actually come down, walked along the real arc.
        //
        // The first version of this check sniffed the opening metres of the throw
        // and called it clear — but a wall seven metres out on a fifteen metre arc
        // bounces the grenade back just as surely as one at arm's length, and that
        // is exactly what kept happening: grenades pinballing off mid-range walls
        // into their own squad. The judgement everyone makes before throwing is not
        // "is my arm clear", it is "where does this land" — so that is what is
        // computed, and every acceptance test runs against the predicted landing
        // rather than against the point he wishes it would reach.
        _nadeVel.set((ndx / nd) * nspd, 4.3, (ndz / nd) * nspd);
        const landing = this._predictGrenadeLanding(world, eye, _nadeVel, _nadeLand);
        // Within most of the blast of the belief. The throw formula lands short at
        // range — it always has, the seven metre blast simply forgave it — so the
        // acceptance is blast-sized rather than pinpoint.
        const onTarget = Math.hypot(landing.x - tp.x, landing.z - tp.z) < 5.5;
        const clearOfSelf = Math.hypot(landing.x - this.pos.x, landing.z - this.pos.z) > 6;
        let friendlyInBlast = false;
        for (const c of world.combatants) {
          if (c === this || !c.alive || c.team !== this.team) continue;
          const bdx = c.pos.x - landing.x, bdz = c.pos.z - landing.z;
          if (bdx * bdx + bdz * bdz < 8 * 8) { friendlyInBlast = true; break; }
        }
        if (!friendlyInBlast && this.team === 'player' && world.playerProxy.alive) {
          const bdx = world.playerProxy.pos.x - landing.x, bdz = world.playerProxy.pos.z - landing.z;
          if (bdx * bdx + bdz * bdz < 8 * 8) friendlyInBlast = true;
        }
        if (!onTarget || !clearOfSelf) {
          this.nadeCd = 2.5;   // wrong spot, not wrong idea — try again from a better one
        } else if (!friendlyInBlast) {
          this.nades--;
          this.nadeCd = 13 + Math.random() * 8;
          const jit = () => 1 + (Math.random() - 0.5) * 0.14;
          this.rig.trigger('throw');
          world.throwGrenade(eye, new THREE.Vector3(_nadeVel.x * jit(), 4.3, _nadeVel.z * jit()), this);
          world.onCombatEvent?.('grenade_throw', this, {
            target: this.target?.name || null, range: dist,
            landing: [landing.x, landing.z].map(v => +v.toFixed(1)),
          });
        } else {
          this.nadeCd = 2; // re-evaluate shortly
        }
      }

      // close-range fighters storm high ground; long-range fighters hold and shoot up
      const heightGap = tp.y - this.pos.y;
      const pushHigh = heightGap > 0.8 && w.aiRange <= 15 && this.role !== 'support';
      this._onVerticalRoute = false;

      // opening play: run the assigned lane until contact, arrival, or the whistle
      if (this.openingT > 0) {
        this.openingT -= dt;
        const odx = this.openingGoal.x - this.pos.x, odz = this.openingGoal.z - this.pos.z;
        if (sight || this.sinceHit < 0.6 || odx * odx + odz * odz < 2.2 * 2.2) this.openingT = 0;
      }
      const opening = this.openingT > 0;

      // medic en route to a patient
      const assist = this.archetype === 'medic' && this.mendTarget?.alive && this.mendCd <= 0;
      if (assist) {
        const adx = this.mendTarget.pos.x - this.pos.x, adz = this.mendTarget.pos.z - this.pos.z;
        if (adx * adx + adz * adz < 2.2 * 2.2) this.mendT = 1.6;
      }

      const blindPush = !sight && !this.peekSide;
      if (blindPush && dist > 5 &&
          (this.breachT <= 0 || this.breachTarget !== this.target) &&
          // One lane survey per simulated frame, squad-wide. The survey below prices
          // up to 22 lanes, each with BVH sightline samples and often an A* search —
          // fine alone, but breach timers are seeded together at match start, so
          // several fighters used to run it in the *same* frame and land a visible
          // hitch. A fighter who defers keeps walking his old heading and re-asks
          // next frame; nothing observable changes but the spacing.
          world._laneSurveyAt !== now) {
        world._laneSurveyAt = now;
        const squad = aliveSquad(world, this.team);
        const assigned = coordinatedBreachLane(squad, this);
        // The squad's assignment still comes first — a crossfire is only a crossfire
        // if the lanes stay spread. It gets overruled only by ground that is being
        // actively covered, which is the one thing worth breaking formation over.
        const sideByLane = new Map();
        const taken = lanesSpokenFor(this.knownLanes, this.target, now);
        // Discounting contested ground for a covered man was tried here, to buy back
        // some pressure on the near side. It changed nothing measurable at 0.5 or at
        // 0.75 — byte-identical runs — because covering fire does not actually stop
        // the man being covered from being seen, so the route that was lethal stays
        // lethal and the cheapest one still wins. Near-side pressure needs somebody
        // whose *job* is to draw the angle, not a fighter who was going to route
        // round anyway and got a discount.
        // Ground in front of a raised shield is worth nothing to stand on, however
        // cheap it is to reach — so it is priced as though it were half-covered, and
        // the lanes that come round his edge win on merit. This is what turns "don't
        // shoot the plate" into "go somewhere the plate isn't".
        const fronted = this.target && !this.baiting && this._shieldFacingMe(this.target)
          ? this.target : null;
        const goalPenalty = fronted ? (goal) => {
          const gx = goal.x - fronted.pos.x, gz = goal.z - fronted.pos.z;
          const gd = Math.hypot(gx, gz) || 1;
          const dot = (gx / gd) * Math.sin(fronted.yaw) + (gz / gd) * Math.cos(fronted.yaw);
          return dot > 0.34 ? 0.55 : 0;
        } : null;
        const priced = safeBreachLane(tp, this.pos, assigned, (goal, lane) => {
          const { cost, side } = this._routeCostBothWays(world, goal, now);
          sideByLane.set(lane, side);
          return cost;
        }, { taken, goalPenalty });
        // The rusher gets the same survey and a different conclusion. He is never
        // pinned down and never routes the long way — but he was previously handed
        // the squad assignment untested, which on the centre lane is a charge
        // straight down the barrel. Brave is picking the cheapest way in and going
        // anyway; walking the worst one because nobody looked is just stupid.
        const choice = this.archetype === 'rusher' ? { ...priced, covered: false } : priced;
        // Walk it the way it was costed.
        this.breachSide = sideByLane.get(choice.lane) ?? this.flankSide;
        this.breachLane = choice.lane;
        this.breachTarget = this.target;
        this.breachGoal.set(choice.goal.x, choice.goal.y, choice.goal.z);
        // A staging point is short of the target, so it has to be walked to even on
        // the centre lane — otherwise lane 0 falls through to "go straight at him"
        // and the whole point of staging is thrown away.
        this.breachStaging = !!choice.staging;
        this.breachCost = choice.cost ?? 0;
        _routePoint.set(choice.goal.x, this.pos.y + 1.15 * this.scale, choice.goal.z);
        this.breachGoalSafe = !this._groundIsDangerous(world, _routePoint, now);
        // Say it out loud. Squadmates near enough to hear leave this lane alone,
        // which is what fans the squad across the angles — and the ones out of
        // earshot will not, which is the honest cost of being out of earshot.
        world.callLane?.(this, this.breachLane, this.target);
        this._breachAt = now;
        // A lane taken to get away from incoming fire is committed to for longer than
        // a routine one. Re-deciding on the usual six-second cadence sent a fighter
        // who had successfully broken right back toward the corner he had just left,
        // because from his new position the old lane scored fine again.
        this.breachT = choice.lane !== assigned ? 11 : 6;
        if (choice.covered && this.holdSpent < HOLD_BUDGET) {
          // Every way in is being worked. Hold — the gun has to stop eventually, and
          // walking in one at a time until it does is how a squad gets fed to a
          // doorway. Re-decide the moment the hold runs out, not in six seconds.
          this.holdT = 1.6 + Math.random() * 1.4;
          this.breachT = this.holdT;
          world.onCombatEvent?.('pinned_down', this, {
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            hold: +this.holdT.toFixed(2),
            heat: this.pinnedBy ? +this.pinnedBy.heat.toFixed(2) : null,
          });
        } else if (choice.lane !== assigned) {
          world.onCombatEvent?.('lane_rerouted', this, {
            from: assigned, to: choice.lane,
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            goal: [choice.goal.x, choice.goal.y, choice.goal.z].map(v => +v.toFixed(2)),
          });
        }
        if (this.breachLane !== 0) {
          world.onCombatEvent?.('breach_commit', this, {
            lane: this.breachLane,
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            goal: [choice.goal.x, choice.goal.y, choice.goal.z].map(value => +value.toFixed(2)),
          });
        }
      }
      const breachDistance = this.pos.distanceToSquared(this.breachGoal);
      const breaching = (this.breachLane !== 0 || this.breachStaging) &&
        this.breachTarget === this.target &&
        this.breachT > 0 && breachDistance > 2.2 * 2.2;
      if (!breaching && this.breachT > 0 && breachDistance <= 2.2 * 2.2) this.breachT = 0;

      // One fighter establishes the direct sightline. Side lanes remain committed
      // through momentary contact so the squad creates an actual crossfire.
      let needTravel = dist > engage || blindPush || breaching || pushHigh || this.pushT > 0 || assist;

      // Wait at the edge for the gap, then run it.
      //
      // The route is priced when it is committed to, which is almost never the moment
      // a reload happens — so a fighter who had correctly decided to cross set off
      // into a lane that was mid-burst, and not one crossing in twenty landed in a
      // break. *Whether* to cross is a routing question; *when* is one you can only
      // answer standing at the edge, listening. He holds while rounds are still
      // coming out and goes the moment they stop.
      this.waitingForGap = false;
      if (needTravel && !assist && this.holdSpent < HOLD_BUDGET && this.archetype !== 'rusher') {
        // Mid-peek is not the moment to wander off. The peek cycle and the travel
        // urge ran on separate clocks: lean, cooldown, and during the cooldown
        // `blindPush` said go — so he took half a step toward the breach, the
        // cooldown expired, and he stepped back to lean again, twitching at the
        // corner for as long as both wanted him. The report from the spectator seat
        // was exactly right: two options, no decision. Committing to a peek now
        // commits to the corner until the cycle is done — look, and maybe fire, and
        // *then* choose where to walk.
        const midPeek = this.peekCd > 0 && !sight && dist < engage * 1.8;
        // And whoever he is and wherever he is going: if the next few steps are into
        // ground something is firing down *right now*, he waits for the gap. This
        // was gated on a committed side-lane, so direct pursuit — dist > engage,
        // lane 0, no breach entry at all — walked straight into a working gun.
        _routePoint.set(this.pos.x + fx * 2.5, this.pos.y + 1.15 * this.scale, this.pos.z + fz * 2.5);
        // An edge is somewhere you are not yet in the fire. Standing IN the zone,
        // this gate used to trigger anyway and stop him there to jink — mid-lane,
        // under the gun, waiting for a gap in the thing currently hitting him.
        const intoFire = !this.pinnedBy && timeSinceFired(this.suppression, now) < GAP_SECONDS &&
          ((breaching && this.breachCost > 0) || this._groundIsDangerous(world, _routePoint, now));
        if (midPeek || intoFire) {
          needTravel = false;
          this.waitingForGap = intoFire;
          this._strafing = true;
          // Jink at the edge only while something is actually shooting; a composed
          // man at a quiet corner stands and looks.
          if (!this.composed) {
            move.x += -fz * this.strafeDir * 0.5; move.z += fx * this.strafeDir * 0.5;
          }
          this.holdSpent += dt;
        }
      }

      // The man on overwatch does not advance. His job is the enemy's attention, and
      // he cannot hold it while walking — a lowered weapon covers nobody.
      if (this.onOverwatch && !assist && sight) needTravel = false;
      // And nobody crosses worked ground unescorted. This is the whole mechanism:
      // the crossings that kill people are the ones taken while every squadmate is
      // also moving, so the enemy is free to watch the one lane that matters. If the
      // route is clean he goes regardless — bounding is for contested ground.
      if (!this.onOverwatch && !assist && !this.covered &&
          this.breachT > 0 && this.breachCost > 0 && this.holdSpent < HOLD_BUDGET) {
        needTravel = false;
        this._strafing = true;
      }
      // Standing in a lane somebody is working: getting out of it outranks
      // everything below, including the breach he is committed to.
      //
      // Deliberately *not* conditioned on having lost sight of the shooter. That was
      // the first attempt and it barely moved the numbers, because against a genuinely
      // commanding angle a fighter can see the gun perfectly well — he is standing in
      // the open being shot by it. Trading from open ground against a held rifle is
      // the losing half of the exchange every time; the answer is to take cover and
      // fight from there, which the peek machinery below already knows how to do.
      //
      // Nowhere to go reads as carry on, never as stand still and die.
      // A man mid-crossing with safe ground committed ahead FINISHES. Breaking for
      // whatever cover is nearest used to outrank that, and the nearest cover from
      // the middle of a lane is very often the piece he just left — so he crossed
      // halfway, rethought, and dove back through the bullets he had already paid
      // for. The far side was the plan and it is still there.
      const finishingCrossing = !!this.pinnedBy && this.breachT > 0 &&
        this.breachTarget === this.target && this.breachGoalSafe;
      const breakingCover = !!this.pinnedBy && !!this.coverGoal && !assist &&
        !finishingCrossing && this.archetype !== 'rusher';
      if (breakingCover) {
        this._traveling = true;
        // Run, the whole way, until he is off the line.
        //
        // This used to sprint only when the cover was more than a few metres off, so
        // he could keep shooting over the last stretch — but the last stretch is
        // inside the beaten zone by definition. A lowered weapon for a second and a
        // half is a trade worth making every time, because the fighter who makes it
        // is alive afterwards and firing for the rest of the match; the one who kept
        // his sights up across the open is not firing at all.
        this.sprintNow = this.legDmg < 0.6;
        this._steerToward(world, dt, this.coverGoal.x, this.pos.y, this.coverGoal.z, move);
      } else if (this.peekSide && !sight) {
        // Working a corner outranks holding behind it.
        //
        // This branch used to sit below the hold, which made it unreachable in the
        // one situation it exists for: a fighter who has taken cover has no sight, so
        // `needTravel` is true, so the hold branch caught him and he sat there. Three
        // riflemen would take cover from a player and then simply never shoot at him
        // again. Cover is a place to fight *from*.
        this._strafing = true;
        move.x += -fz * this.peekSide * 0.5;
        move.z += fx * this.peekSide * 0.5;
      } else if ((needTravel || opening) && !assist &&
                 (this.cautionT > 0 || (this.holdT > 0 && this.holdSpent < HOLD_BUDGET))) {
        // A squadmate just died up ahead, or every approach is covered: hold the
        // angle and jink rather than feeding the corner one man at a time.
        this._strafing = true;
        this._jinkAwayFromFire(world, fx, fz, now);
        move.x += -fz * this.strafeDir * 0.7; move.z += fx * this.strafeDir * 0.7;
      } else if (needTravel || opening) {
        this._traveling = true;
        let gx, gz, gy;
        if (opening) {
          gx = this.openingGoal.x; gz = this.openingGoal.z; gy = this.openingGoal.y || 0;
        } else if (assist) {
          gx = this.mendTarget.pos.x; gz = this.mendTarget.pos.z; gy = this.mendTarget.pos.y;
        } else if (breaching) {
          gx = this.breachGoal.x; gz = this.breachGoal.z; gy = this.breachGoal.y;
        } else if (this.role === 'shadow' && this.team === 'player' && !sight &&
                   Math.hypot(world.playerProxy.pos.x - this.pos.x, world.playerProxy.pos.z - this.pos.z) > 8) {
          // bodyguard: never stray far from the boss while out of contact
          gx = world.playerProxy.pos.x; gz = world.playerProxy.pos.z; gy = world.playerProxy.pos.y;
        } else {
          gx = tp.x; gz = tp.z; gy = tp.y;
        }
        // A firearm user lowers out of sprint on visual contact, even while
        // continuing toward a committed breach goal. Distance alone used to
        // keep the gun down across a completely visible gap.
        this.sprintNow = this.shieldWall ? false : shouldSprintAtTarget({
          sight: sight || this.peekSide !== 0,
          melee: !!w.melee,
          distance: dist,
          legDamage: this.legDmg,
          // Knowing the route crosses fire is itself the reason to run it. He used to
          // only sprint once he was already standing in the beaten zone, which is a
          // second too late to be the point.
          crossingFire: !!this.pinnedBy || (breaching && this.breachCost > 0),
        });
        // Committed lanes are walked the way they were costed; everything else
        // keeps the fighter's own habitual flank preference.
        this._steerToward(world, dt, gx, gy, gz, move,
          breaching ? (this.breachSide ?? this.flankSide) : this.flankSide);
      } else if (dist < engage * 0.45 && this.weaponId !== 'shotgun' && !w.melee && heightGap < 0.8) {
        this._strafing = true;
        this._jinkAwayFromFire(world, fx, fz, now);
        if (this._ledgeAhead(world, -fx, -fz)) {
          // backing up would mean falling off — hold and strafe instead
          if (this._ledgeAhead(world, -fz * this.strafeDir, fx * this.strafeDir)) this.strafeDir *= -1;
          move.x += -fz * this.strafeDir * 0.8; move.z += fx * this.strafeDir * 0.8;
        } else {
          move.x -= fx * 0.8; move.z -= fz * 0.8;
          move.x += -fz * this.strafeDir * 0.6; move.z += fx * this.strafeDir * 0.6;
        }
      } else if (this.weaponId === 'shotgun' && dist > 3) {
        move.x += fx; move.z += fz;
      } else {
        this._strafing = true;
        this._jinkAwayFromFire(world, fx, fz, now);
        if (this._ledgeAhead(world, -fz * this.strafeDir, fx * this.strafeDir)) this.strafeDir *= -1;
        move.x += -fz * this.strafeDir; move.z += fx * this.strafeDir;
      }

      // Face what he is doing, which is not always the target.
      //
      // He faced the target's believed position unconditionally — through walls,
      // while sprinting the other way — which produced two things you could see from
      // the spectator seat: a squad staring at a shooter none of them had line on,
      // and "sprints" played as slow sideways shuffles, because the run was a strafe
      // relative to a body pointed at the enemy. Travelling blind, or at a sprint,
      // he looks where he is going; the wide vision cone still catches most of what
      // matters, and anything it misses is what a man running with his head down
      // genuinely misses.
      const targetYaw = Math.atan2(dx, dz);
      let faceYaw = targetYaw;
      if (this._traveling && (this.sprintNow || !sight) && move.lengthSq() > 0.01) {
        faceYaw = Math.atan2(move.x, move.z);
      }
      let turn = faceYaw - this.yaw;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      this.yaw += turn * Math.min(1, dt * 7);
      // Paused at a probe point: the head sweeps. This is the looking-for-angles the
      // pause exists for, and it is also what feeds the vision cone new ground.
      if (this.scanningT > 0) {
        this.scanningT -= dt;
        this.yaw += Math.sin(now * 2.1 + this.animPhase) * dt * 1.6;
      }
      // Aim error toward the *target*, which is what gates firing — a man looking
      // down his own route has a large one, and correctly cannot shoot behind
      // himself while running.
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;

      // ---- shooting ----
      // dry gun? switch to a fed one, or pull the knife
      if (!w.melee && ITEM_TYPES[this.weaponId]?.ammo && this._poolFor(this.weaponId) <= 0) {
        this._switchDry(world);
      }
      // Where the weapon actually is, and what it can actually see from there.
      //
      // A peek only earns a shot once the fighter has leaned far enough that his
      // weapon is genuinely clear of the corner. Deciding to peek and firing in the
      // same frame is how a bot shoots you from behind a wall he has not come out
      // from behind yet.
      const muzzle = this.muzzleWorld(_muzzle);
      const muzzleSight = (sight || this.peekSide !== 0)
        && hasLoS(world, muzzle, aim)
        && !this._friendlyInLine(world, muzzle, aim);
      // Everything above navigates on the belief; everything from here down is about
      // a target the weapon can genuinely see, so it measures the real gap. Using the
      // remembered distance to time a shot would let a stale memory tighten or widen
      // a group that is actually being aimed at a body in plain view.
      const fireDist = muzzleSight ? this.pos.distanceTo(this.target.pos) : dist;
      const visibleTarget = fireDist < engage * 2.2 && muzzleSight;
      const los = visibleTarget && !this.sprintNow;

      // marksman laser telegraph
      if (this.laser) {
        this.laser.visible = los && this.alive;
        if (this.laser.visible) {
          const pts = this.laser.geometry.attributes.position.array;
          pts[0] = muzzle.x; pts[1] = muzzle.y; pts[2] = muzzle.z;
          pts[3] = aim.x; pts[4] = aim.y; pts[5] = aim.z;
          this.laser.geometry.attributes.position.needsUpdate = true;
        }
      }

      // point-blank surprises get answered fast; long-range spotting takes longer
      if (visibleTarget && !this.hadLoS) {
        this.reactionLeft = this.skill.reaction * (0.7 + Math.random() * 0.6) *
          Math.min(1.2, Math.max(0.35, fireDist / 12));
        world.onCombatEvent?.('sight_acquired', this, {
          target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
          range: +fireDist.toFixed(2),
          sprinting: this.sprintNow,
          role: this.role,
          // How wrong he was a moment ago — the number that says whether he walked
          // onto you or merely re-found what he never really lost.
          searched_from: this._reacquireRadius == null ? null : +this._reacquireRadius.toFixed(2),
        });
      }
      // Recognition begins while the weapon is coming up; firing still requires
      // the separate sprint, ADS, reaction, and aim gates below.
      this.hadLoS = visibleTarget;
      if (this.reactionLeft > 0) this.reactionLeft -= dt;

      // Shoulder the weapon when there is something to shoot at a range worth aiming
      // at. Inside knife range nobody bothers, and a sprinting fighter has the weapon
      // down by definition.
      // The gun comes up when he stops, not while he is crossing open ground.
      //
      // Shouldering costs a third of his speed, so aiming *while walking into the
      // open* is the worst of both — slow and exposed, and it is what you see when a
      // fighter strolls into a lane with his sights up instead of leaning out of the
      // corner he just left. Standing still behind something, or leaning, he aims.
      // Gated on travelling at all, not merely on travelling through a known lane.
      // The reactive shooter punishes being seen anywhere, and "walked straight out
      // into the open with his sights up" was the exact report — a man outside any
      // recorded beaten zone still ADS-strolled into view. Moving is moving: the gun
      // comes up when the feet stop.
      // A man carrying his own cover is not walking in the open. The rule that keeps
      // fighters from ADS-strolling into a lane exists because aiming costs a third
      // of your speed and buys nothing while exposed — but the shieldman is behind a
      // plate the entire time, which is the one case where the premise fails. Without
      // the exemption he reached the aimed stance for fifteen percent of a fight and
      // spent the rest firing at three times the spread, which is not a tank with a
      // trade-off, just a slow man who cannot shoot.
      const walkingExposed = this._traveling && !this.shieldPresenting;
      this.wantsAds = los && !this.sprintNow && !w.melee && fireDist > 2.2 && !walkingExposed &&
        !this.shieldWall;
      // Up in about a third of a second, down slower — a fighter who has just been
      // shot at keeps his weapon up for a moment.
      const adsRate = this.wantsAds ? 3.4 : 2.0;
      this.adsK += ((this.wantsAds ? 1 : 0) - this.adsK) * Math.min(1, dt * adsRate);
      // Settled enough to shoot. Close in he fires from the hip; at distance he has to
      // actually get the weapon up first, which is the visible tell that he is aiming.
      const settled = this.adsK > Math.min(0.62, 0.12 + fireDist * 0.045);

      if (w.melee && los && this.reactionLeft <= 0 && this.cooldown <= 0 && fireDist < w.meleeRange) {
        // slash
        const mdmg = w.dmg * this.damageMult * (this.team === 'enemy' ? world.enemyDmgScale : 1) * (world.globalDmgMult || 1);
        if (this.target.isPlayer) world.onPlayerDamaged(mdmg, Math.random() < 0.2 ? 'armL' : 'torso', this.pos);
        else this.target.applyDamage(world, 'torso', mdmg, this, this.target.aimPoint());
        audio.slash(1.2 / (1 + eye.distanceTo(world.cameraPos) * 0.09));
        this.cooldown = 60 / w.rpm;
      } else if (!w.melee && los && settled && this.reactionLeft <= 0 && this.cooldown <= 0 && Math.abs(dy) < 0.35) {
        // The round leaves the barrel, wherever the barrel happens to be. Leaning
        // around a corner moves it because the animation moves it, not because the
        // shot gets a private offset the fighter's body never took.
        const fireEye = muzzle;
        const dir = _fireDir.copy(aim).sub(fireEye).normalize();
        const distFactor = 0.7 + fireDist / 30;
        // A shouldered weapon groups roughly twice as tight as a hip-fired one. This
        // is the mechanical half of the ADS state: without it, taking the time to aim
        // would be pure cost and the AI would be strictly worse for doing it.
        // ...and firing around a slab he is also holding up is as bad as it sounds.
        const spreadDeg = w.spread * this.skill.spreadMult * (1 + this.armDmg * 1.4)
          * distFactor * (this.crouchK < 0.9 ? 0.8 : 1) * (1.35 - 0.72 * this.adsK)
          * this.shieldSpreadMult;
        const volley = this._sendRounds(world, w, fireEye, dir, spreadDeg);
        world.onCombatEvent?.('shot', this, {
          target: this.target?.name || null, weapon: this.weaponId, range: fireDist,
          line_of_sight: los, role: this.role, suppressive: false,
          pellets: volley.pellets, hits: volley.hits,
        });
        this.burstLeft--;
        if (this.burstLeft <= 0) {
          this.burstLeft = this._burstSize();
          this.cooldown = (60 / w.rpm) + 0.5 + Math.random() * 0.5 + (w.auto ? 0.2 : 0);
        } else {
          this.cooldown = 60 / w.rpm;
        }
      } else if (!w.melee && !los && this.cooldown <= 0 && !this.sprintNow &&
                 this.reactionLeft <= 0 && this.contact && !this.contact.visible &&
                 worthSuppressing({
                   radius: uncertainty, age: now - this.contact.t,
                   rounds: this._poolFor(this.weaponId),
                   // On overwatch he is the reason anyone else can move, so he
                   // shoots at ground on the same terms a support gunner does.
                   role: this.onOverwatch ? 'support' : this.role,
                   auto: this.onOverwatch || !!w.auto,
                 })) {
        // Area fire at a place, not a person.
        //
        // The missing half of the model: fighters knew how to be suppressed and never
        // how to suppress, so a squad that lost sight went silent and handed the
        // initiative straight back. Against a player that read as three men with
        // rifles waiting politely while he reloaded.
        //
        // It only happens onto a belief tight enough for the rounds to land somewhere
        // that matters, and only along a line the muzzle can genuinely send them —
        // otherwise he is shooting the wall in front of his own face.
        _suppressAt.set(this.contact.x, (this.contact.y || 0) + 1.05, this.contact.z);
        if (hasLoS(world, muzzle, _suppressAt)) {
          const fireEye = muzzle;
          const dir = _fireDir.copy(_suppressAt).sub(fireEye).normalize();
          const spreadDeg = this.shieldSpreadMult * w.spread * this.skill.spreadMult * (1 + this.armDmg * 1.4)
            * (0.7 + dist / 30) + SUPPRESSING.spread;
          const volley = this._sendRounds(world, w, fireEye, dir, spreadDeg);
          world.onCombatEvent?.('shot', this, {
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            weapon: this.weaponId, range: +dist.toFixed(2),
            line_of_sight: false, role: this.role, suppressive: true,
            belief_error: +uncertainty.toFixed(2),
            pellets: volley.pellets, hits: volley.hits,
          });
          this.suppressLeft--;
          if (this.suppressLeft <= 0) {
            this.suppressLeft = 2 + (Math.random() * 3 | 0);
            this.cooldown = 0.8 + Math.random() * 0.9;
          } else {
            this.cooldown = 60 / w.rpm;
          }
        } else {
          this.cooldown = 0.4;   // no line to it; look again shortly
        }
      }
      // Nothing in view: let the weapon down.
    } else if (!this.target && !fleeing && this.healingT <= 0 && this.mendT <= 0) {
      // Nobody on the board at all: no sighting, no sound, nothing called in.
      //
      // The old AI could never reach this state — it always had the nearest enemy
      // transform to walk at — so "idle" meant standing still and swaying. A fighter
      // who has genuinely lost everyone has to go and *find* someone, or the removal
      // of omniscience just turns into a stalemate where both squads mill about.
      this._huntFor(world, dt, now, move);
    }

    // ---- clear the boss's line of fire ---- (crew only, and only when he's SHOOTING)
    // They react to gunfire like people: a beat late, imperfectly. Your gaze moves no one,
    // and a merc crossing you mid-burst can absolutely eat a round — that one's on you.
    if (this.team === 'player' && world.playerProxy.alive && world.playerAim) {
      const now = performance.now() / 1000;
      const firing = world.playerFiredAt && now - world.playerFiredAt < 1.2;
      if (firing) {
        if (now - (this._ffSeen || -99) > 1.6) this._ffNotice = now + 0.15 + Math.random() * 0.35; // fresh burst → reaction time
        this._ffSeen = now;
        if (now >= this._ffNotice) {
          const pp = world.playerProxy;
          const rx = this.pos.x - pp.pos.x, rz = this.pos.z - pp.pos.z;
          const along = rx * world.playerAim.x + rz * world.playerAim.z;
          if (along > 0.3 && along < 12) {
            const px = rx - world.playerAim.x * along, pz = rz - world.playerAim.z * along;
            const pd = Math.hypot(px, pz);
            if (pd < 1.1) {
              const strength = (1.1 - pd) * 1.7;
              if (pd > 0.05) { move.x += (px / pd) * strength; move.z += (pz / pd) * strength; }
              else { move.x += -world.playerAim.z * strength; move.z += world.playerAim.x * strength; }
            }
          }
        }
      }
    }

    // ---- separation ---- (suspended on stairs/ledge routes: shoving = falling)
    if (!this._onVerticalRoute) for (const c of world.combatants) {
      if (c === this || !c.alive) continue;
      const dx = this.pos.x - c.pos.x, dz = this.pos.z - c.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.3 * 1.3 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        move.x += (dx / d) * (1.3 - d) * 1.5;
        move.z += (dz / d) * (1.3 - d) * 1.5;
      }
    }

    // ---- steering + movement ----
    if (move.lengthSq() > 0.01) {
      move.normalize();
      // wall-following with side commitment: flipping sides every frame stalls
      // against wide walls, so once blocked we pick a side and hold it until clear
      // sample along the path, not just the endpoint — thin walls hide between samples otherwise
      const isBlocked = (dir) => {
        // march the walked height along the ray — a ledge that's a wall from HERE
        // may be a mere step from the stair we'll be standing on by then
        let y = this.pos.y;
        for (const t of [0.8, 1.5, 2.2]) {
          const px = this.pos.x + dir.x * t, pz = this.pos.z + dir.z * t;
          y = groundHeight(world.colliders, px, pz, y);
          for (const box of world.colliders) {
            if (box.max.y - y <= STEP_REACH || box.min.y > y + 1.5) continue;
            if (box.containsXZ(px, pz, this.radius)) return true;
          }
        }
        return false;
      };
      // One shared scratch: every candidate is either rejected by isBlocked or
      // becomes `chosen` and ends the search, so the next call never clobbers a
      // direction still in use. The closure it replaces allocated a vector per
      // probe — up to nine per fighter per frame while wall-following.
      const rot = (v, a) => _rotTmp.copy(v).applyAxisAngle(UP, a);

      // stuck detector: wanting to move but going nowhere → burst in a random direction
      this.progressT = (this.progressT ?? 1.2) - dt;
      if (this.progressT <= 0) {
        const moved = this.lastProgressPos ? this.pos.distanceTo(this.lastProgressPos) : 99;
        if (moved < 0.5) {
          this.jiggleT = 0.7 + Math.random() * 0.7;
          const a = Math.random() * Math.PI * 2;
          (this.jiggleDir ||= new THREE.Vector3()).set(Math.cos(a), 0, Math.sin(a));
        }
        (this.lastProgressPos ||= new THREE.Vector3()).copy(this.pos);
        this.progressT = 1.2;
      }

      let chosen = null;
      if (this.jiggleT > 0) {
        this.jiggleT -= dt;
        if (!isBlocked(this.jiggleDir)) chosen = this.jiggleDir;
        else this.jiggleT = 0;
      }
      if (this.avoidT > 0) this.avoidT -= dt;
      if (chosen) {
        // committed jiggle
      } else if (!isBlocked(move)) {
        chosen = move;
        this.avoidT = 0;
      } else {
        if (this.avoidT <= 0) {
          const left = !isBlocked(rot(move, 0.9)), right = !isBlocked(rot(move, -0.9));
          this.avoidSide = left && !right ? 1 : right && !left ? -1 : (Math.random() < 0.5 ? 1 : -1);
          this.avoidT = 0.9 + Math.random() * 0.6;
        }
        for (const a of [0.6, 0.95, 1.3, 1.65]) {
          const cand = rot(move, a * this.avoidSide);
          if (!isBlocked(cand)) { chosen = cand; break; }
        }
        if (!chosen) for (const a of [0.6, 0.95, 1.3, 1.65]) {
          const cand = rot(move, -a * this.avoidSide);
          if (!isBlocked(cand)) { chosen = cand; break; }
        }
        if (!chosen) chosen = rot(move, 2.6 * (this.avoidSide || 1));
      }
      // Shouldered weapon costs pace. It is what makes an aiming fighter read as
      // committed to the shot instead of jogging past with a gun up.
      // The slab weighs what a slab weighs. Held up in front it is worst, slung on
      // his back it is nearly free, and dropping it to his side is the whole reason
      // a shieldman would ever break into a run.
      const spd = this.baseSpeed * speedMult * (this.crouchK < 0.9 ? 0.55 : 1)
        * (this.sprintNow ? 1.45 : 1) * (1 - 0.32 * this.adsK) * this.shieldSpeedMult;
      const px = this.pos.x, pz = this.pos.z;
      this.pos.addScaledVector(chosen, spd * dt);
      resolveCircle(this.pos, this.radius, world.colliders, this.pos.y);
      // Speed *actually achieved*, not speed intended: a fighter grinding along a wall
      // should not play a full-speed run cycle on the spot.
      this.currentSpeed = dt > 0 ? Math.hypot(this.pos.x - px, this.pos.z - pz) / dt : 0;
      this._moveDX = this.pos.x - px;
      this._moveDZ = this.pos.z - pz;
      moving = true;
      this.animPhase += dt * spd * 2.6;
      this.moveAmount = Math.min(1, this.moveAmount + dt * 6);
    } else {
      this.currentSpeed = 0;
      this.moveAmount = Math.max(0, this.moveAmount - dt * 6);
    }

    // clamp to arena
    this.pos.x = Math.max(-21, Math.min(21, this.pos.x));
    this.pos.z = Math.max(-15, Math.min(15, this.pos.z));

    // terrain-follow: climb stairs / platforms, drop off ledges
    const gY = groundHeight(world.colliders, this.pos.x, this.pos.z, this.pos.y);
    this.pos.y += (gY - this.pos.y) * Math.min(1, dt * 10);
    if (Math.abs(gY - this.pos.y) < 0.02) this.pos.y = gY;

    // ---- pose ----
    // crouchK stays the gameplay value that eyePos/aimPoint and the hit model read;
    // the visible squat comes from the authored crouch clips, which are keyed to
    // roughly the same head height.
    const wantCrouch = this.healingT > 0 || this.mendT > 0 || this.shieldWall ||
      (this._strafing && this.stanceCrouch) || (this.cautionT > 0 && !this._traveling);
    // Stance is chosen from what he is doing, and then decides how deep he ducks: a
    // turtling shieldman goes lower than an ordinary crouch, because the point is to
    // get his head behind a plate whose top edge is under a metre.
    this._setShieldStance(this._shieldStanceName(wantCrouch));
    this._placeShield();
    const crouchTo = wantCrouch ? (this.shieldCrouch ?? 0.72) : 1;
    this.crouchK += (crouchTo - this.crouchK) * Math.min(1, dt * 8);
    // peeking leans harder than plain strafing. Sign: positive is to his right, which
    // is exactly where the peek eye offsets for side=+1.
    // The strafe-lean belongs to actual strafing. Keyed on intent alone it flapped
    // in time with the micro-jink — leaning back and forth on the spot, every frame,
    // which from above read as the model breaking. Standing men do not lean.
    const leanTarget = this.peekSide ? this.peekSide
      : (this._strafing && (this._animSpeed ?? 0) > 0.5 ? this.strafeDir * 0.35 : 0);
    this.leanK += (leanTarget - this.leanK) * Math.min(1, dt * 6);

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;

    // ---- drive the animation rig ----
    // Which way he is travelling *in his own frame*, so the blendspace can pick a
    // cross-step over a forward walk. Local +Z is forward (see the yaw convention at
    // the top of the steering code); local +X is therefore his left, so the rightward
    // component carries a minus sign.
    //
    // The animation reads a *smoothed* velocity, not the raw frame delta. A fighter
    // holding at a corner micro-jinks — half a step left, half a step right, wall
    // contact rotating the leftovers — and feeding those raw deltas to the blendspace
    // played a full walk cycle on the spot with the direction flapping sign every
    // frame. Averaged as a vector, oscillation cancels to nothing and he stands;
    // genuine travel passes through untouched. The deadband kills the residue.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // Net displacement over the last twenty-odd frames, not an average velocity. An
    // EMA was tried first and the jink swings are slower than any usable smoothing
    // constant, so it faithfully tracked each one and the rig was still fed a walk
    // ninety percent of the time he stood still. Where he IS versus where he WAS a
    // third of a second ago cannot be fooled by oscillation: back-and-forth nets to
    // nothing, real travel passes through whole.
    if (!this._trail) { this._trail = []; this._trailAt = 0; }
    const T = 30;
    if (this._trail.length < T) this._trail.push({ x: this.pos.x, z: this.pos.z });
    else {
      const slot = this._trail[this._trailAt];
      slot.x = this.pos.x; slot.z = this.pos.z;
      this._trailAt = (this._trailAt + 1) % T;
    }
    const oldest = this._trail.length < T ? this._trail[0] : this._trail[this._trailAt % this._trail.length];
    const window = Math.max(dt, (this._trail.length - 1) * dt);
    const nx = this.pos.x - oldest.x, nz = this.pos.z - oldest.z;
    let animSpeed = Math.hypot(nx, nz) / window;
    // 0.6 m/s: below the slowest genuine gait (a crouched limp is ~0.9), above what
    // half a second of jinking nets. Anything under it is shuffling, and shuffling
    // is standing as far as the legs are concerned.
    if (animSpeed < 0.6) animSpeed = 0;
    this._animSpeed = animSpeed;
    const wdx = animSpeed > 0 ? nx / Math.max(1, this._trail.length - 1) : 0;
    const wdz = animSpeed > 0 ? nz / Math.max(1, this._trail.length - 1) : 0;
    const localF = wdx * sy + wdz * cy;
    const localR = -(wdx * cy - wdz * sy);
    // A limping fighter's stride slows with him, because the blendspace advances on
    // distance travelled — the leg wound is visible in the walk, not just the numbers.
    this.rig.setStance(animSpeed, this.crouchK < 0.9, localR, localF);
    // Lean is a spine bend in the rig now, not a roll of the whole object: rolling
    // pivoted him about his feet and lifted a boot off the floor.
    this.rig.setLean(this.leanK);
    // The weapon comes up on the same curve the accuracy does, so what the player
    // sees and what the dice see are the same number.
    if (!this.target || this.sprintNow) this.adsK = Math.max(0, this.adsK - dt * 2.0);
    this.rig.setAimWeight(this.adsK);
    if (this.target) {
      // He points the weapon where he *thinks* they are. Aiming the rig at the live
      // transform was the most visible tell of the old model: a fighter tracking you
      // through solid concrete, muzzle following you along the far side of a wall.
      const tp = this.contact && !this.contact.visible
        ? _aimTmp.set(this.contact.x, (this.contact.y || 0) + 1.25, this.contact.z)
        : this.target.isPlayer
          ? _aimTmp.set(this.target.pos.x, this.target.pos.y + 1.25, this.target.pos.z)
          : this.target.aimPoint(_aimTmp);
      const flat = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z);
      // Yaw is what the hips have not caught up to yet. Feeding it to the aim offset
      // means he tracks a target beside him by twisting, then turns his feet — rather
      // than the whole body snapping round as one rigid piece.
      let dy = Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z) - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.rig.setAim(
        Math.atan2(tp.y - (this.pos.y + 1.35 * this.scale), Math.max(0.4, flat)), dy);
    } else {
      this.rig.setAim(0, 0);
    }
    // Bandaging is a sustained additive clip; start it once on the rising edge.
    const patching = this.healingT > 0 || this.mendT > 0;
    if (patching && !this._patchAnim) { this.rig.trigger('heal'); this._patchAnim = true; }
    else if (!patching && this._patchAnim) { this.rig.stop('heal'); this._patchAnim = false; }

    this.rig.update(dt);
  }

  /**
   * Route to a world point through the navmesh, accumulating into `move`.
   *
   * Lifted out of the engagement branch verbatim so a fighter with no contact can
   * use the same pathing to go looking. `walkableLine` is expensive, so the straight
   * -line test runs on the repath cadence rather than every frame.
   */
  _steerToward(world, dt, gx, gy, gz, move, side = this.flankSide) {
    this.repathT = (this.repathT ?? 0) - dt;
    if (this.repathT <= 0) {
      this.repathT = 0.45 + Math.random() * 0.35;
      this._straightOK = world.nav ? world.nav.walkableLine(this.pos.x, this.pos.z, this.pos.y, gx, gz, gy) : true;
      if (this._straightOK) {
        this.path = null;
      } else {
        this.path = world.nav.findPath(this.pos, { x: gx, y: gy, z: gz }, this.navSeed, side);
        this.pathIdx = 0;
      }
    }
    if (this._straightOK || !this.path || !this.path.length) {
      const gd = Math.hypot(gx - this.pos.x, gz - this.pos.z) || 1;
      move.x += (gx - this.pos.x) / gd; move.z += (gz - this.pos.z) / gd;
      return;
    }
    const reached = (wp) => {
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      return dx * dx + dz * dz < 0.9 * 0.9 && Math.abs(wp.y - this.pos.y) < 1.2;
    };
    while (this.pathIdx < this.path.length - 1 && reached(this.path[this.pathIdx])) this.pathIdx++;
    const goal = this.path[Math.min(this.pathIdx, this.path.length - 1)];
    this._onVerticalRoute = Math.abs((goal.y ?? this.pos.y) - this.pos.y) > 0.25;
    const gdx = goal.x - this.pos.x, gdz = goal.z - this.pos.z;
    const gd = Math.hypot(gdx, gdz) || 1;
    move.x += gdx / gd; move.z += gdz / gd;
  }

  /**
   * Where to walk, given a belief.
   *
   * While the target is in sight this is simply where they are. Once sight breaks it
   * is the last-known position — and once he has *reached* the last-known position
   * and found an empty corner, it becomes a finite sweep of the ground around it:
   * push through, check the cover either side, then back toward his own approach.
   *
   * When that sweep runs out, the contact is dropped. That is the part that keeps
   * this honest — a searcher who never gives up is an omniscient searcher wearing a
   * costume.
   */
  _searchGoal(belief, uncertainty, sight, now, world, out) {
    const contact = this.contact;
    if (sight || !contact || contact.visible) return out.set(belief.x, belief.y, belief.z);

    const name = () => (contact.entity?.isPlayer ? 'YOU' : contact.entity?.name || null);
    const arrived = (goal, reach) => {
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z;
      return dx * dx + dz * dz < reach * reach;
    };
    // Close enough counts as arrived: the belief has an error radius, so insisting on
    // standing exactly on a remembered point is precision the fighter does not have.
    const reach = Math.max(2, Math.min(uncertainty, 6) * 0.6);

    if (!contact.probeGoal) {
      if (!arrived(contact, reach)) return out.set(contact.x, contact.y, contact.z);
      contact.probeFrom = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    } else if (arrived(contact.probeGoal, 1.8)) {
      // Arriving somewhere is a moment to look, not a trigger for the next order.
      // Probes chained instantly, so a searcher snapped a new heading the frame he
      // reached the old one — read from above as jittering between decisions. He
      // stands a beat, sweeps his eyes, and then moves; the pause is where the
      // looking happens, and it is also simply what a person does.
      if (contact.pauseUntil === undefined) {
        contact.pauseUntil = now + 0.7 + this.perception.rng() * 0.7;
      }
      if (now < contact.pauseUntil) {
        this.scanningT = 0.2;
        return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
      }
      contact.pauseUntil = undefined;
      contact.probes++;
      if (contact.probes >= SEARCH_PROBES) {
        // Swept every angle and found nothing. He has lost you, properly.
        this.perception.forget(contact.entity);
        world.onCombatEvent?.('search_exhausted', this, {
          target: name(),
          last_known: [contact.x, contact.y, contact.z].map(v => +v.toFixed(2)),
          age: +(now - contact.t).toFixed(2),
        });
        return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
      }
    } else {
      return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
    }

    contact.probeGoal = clampToArena(
      searchProbe(contact, contact.probeFrom || this.pos, uncertainty, contact.probes));
    world.onCombatEvent?.('search_probe', this, {
      target: name(),
      probe: contact.probes,
      radius: +uncertainty.toFixed(2),
      goal: [contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z].map(v => +v.toFixed(2)),
    });
    return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
  }

  /**
   * Sweep the pit with nothing to go on.
   *
   * Priority is the last unexplained bang, then the far side of the arena from where
   * he came in — which is knowledge of the *venue*, not of the enemy. He walks it
   * with the weapon up rather than sprinting, because he is clearing ground, not
   * chasing a contact.
   */
  _huntFor(world, dt, now, move) {
    // A medic with a patient has a job before he has a hunt. Walking to the wounded
    // lived only inside the has-target branch, so a medic who had lost contact with
    // the enemy — which is most of a fight spent behind cover — went looking for
    // somebody to fight instead of treating the man bleeding next to him.
    if (this.archetype === 'medic' && this.mendTarget?.alive && this.mendCd <= 0) {
      const adx = this.mendTarget.pos.x - this.pos.x, adz = this.mendTarget.pos.z - this.pos.z;
      if (adx * adx + adz * adz < 2.2 * 2.2) { this.mendT = 1.6; return; }
      this._traveling = true;
      this._steerToward(world, dt, this.mendTarget.pos.x, this.mendTarget.pos.y, this.mendTarget.pos.z, move);
      return;
    }
    // Being shot at by somebody you cannot even find is the clearest case there is:
    // get off the X first, look for him second.
    if (this.pinnedBy && this.coverGoal) {
      this._traveling = true;
      this.sprintNow = this.legDmg < 0.6;
      this._steerToward(world, dt, this.coverGoal.x, this.pos.y, this.coverGoal.z, move);
      // This early return used to skip every yaw update in the function, so the dash
      // ran on whatever heading he last held — a full-speed sprint played sideways
      // or backwards, which is the fast weird scuttling you can see from above. A
      // sprinter faces his feet.
      if (move.lengthSq() > 0.01) {
        let turn = Math.atan2(move.x, move.z) - this.yaw;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        this.yaw += turn * Math.min(1, dt * 7);
      }
      return;
    }
    const disturbance = this.perception.disturbance;
    if (disturbance && disturbance.t > (this._huntFrom ?? -Infinity)) {
      this._huntFrom = disturbance.t;
      this.huntGoal.set(disturbance.x, disturbance.y, disturbance.z);
      this.huntT = 9;
      world.onCombatEvent?.('search_disturbance', this, {
        goal: [disturbance.x, disturbance.y, disturbance.z].map(v => +v.toFixed(2)),
      });
    }
    this.huntT -= dt;
    const dx = this.huntGoal.x - this.pos.x, dz = this.huntGoal.z - this.pos.z;
    if (this.huntT <= 0 || dx * dx + dz * dz < 2.5 * 2.5) {
      // Away from his own corner, with enough spread that a squad fans out instead of
      // filing to the same spot.
      const anchorX = -(this.spawnPos?.x ?? this.pos.x);
      const anchorZ = -(this.spawnPos?.z ?? this.pos.z);
      this.huntGoal.set(
        Math.max(-19, Math.min(19, anchorX * 0.7 + (Math.random() - 0.5) * 18)),
        0,
        Math.max(-13, Math.min(13, anchorZ * 0.7 + (Math.random() - 0.5) * 14)),
      );
      this.huntT = 7 + Math.random() * 5;
    }
    this._traveling = true;
    this._steerToward(world, dt, this.huntGoal.x, this.huntGoal.y, this.huntGoal.z, move);
    const yaw = Math.atan2(this.huntGoal.x - this.pos.x, this.huntGoal.z - this.pos.z);
    let dy = yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    // Slower than the lock-on turn: he is looking around, not tracking anyone.
    this.yaw += dy * Math.min(1, dt * 2.6);
    // ...and the head keeps sweeping either side of his line of travel, which is what
    // gives the field of view something to find.
    this.yaw += Math.sin(now * 0.9 + this.animPhase) * dt * 0.7;
  }

  /**
   * Could he actually stand at this point?
   *
   * A piece of "cover" inside a crate is a fighter grinding into it until the fire
   * stops, which is one of the ways these two systems produced a bot stuck on the
   * spot. Same reachability test the steering uses, so the two agree about what is
   * walkable.
   */
  _standable(world, point) {
    const gy = groundHeight(world.colliders, point.x, point.z, this.pos.y);
    if (Math.abs(gy - this.pos.y) > 1.2) return false;
    for (const box of world.colliders) {
      if (box.max.y - gy <= STEP_REACH || box.min.y > gy + 1.5) continue;
      if (box.containsXZ(point.x, point.z, this.radius)) return false;
    }
    return true;
  }

  /**
   * Pick the side to jink toward, when one side is swept and the other is not.
   *
   * A fighter trading at the edge of a lane drifts into it, because his strafe
   * alternates on a timer and half of "round" is "across". This was tried once
   * before at every range and measured worse — but that was while a lane was a
   * *circle*, so both sides read as lethal and the choice was a coin flip wearing a
   * jacket. With an arc there is a side that genuinely is not his, and picking it is
   * the difference between circling a man and walking through his sights.
   *
   * Only when something is actually hot; otherwise the jink stays random, which is
   * what makes a fighter hard to lead.
   */
  _jinkAwayFromFire(world, fx, fz, now, reach = 2.5) {
    if (!this.suppression.anyDanger(now)) return;
    // Re-decided a few times a second, not per frame. At the edge of an arc the
    // two sides can trade places sample to sample, and a per-frame re-pick turned
    // that boundary noise into a fighter vibrating in place.
    if (now - (this._jinkAt ?? -9) < 0.35) return;
    this._jinkAt = now;
    const chestY = this.pos.y + 1.15 * this.scale;
    let safest = 0;
    for (const side of [this.strafeDir, -this.strafeDir]) {
      _routePoint.set(this.pos.x + -fz * reach * side, chestY, this.pos.z + fx * reach * side);
      if (!this._groundIsDangerous(world, _routePoint, now)) { safest = side; break; }
    }
    if (safest) this.strafeDir = safest;
  }

  /**
   * Where a grenade thrown from `eye` at `vel` first comes down, approximately.
   *
   * The same ballistics `updateGrenades` runs — gravity 13, fuse 2.8 — walked in
   * coarse steps until the arc meets a wall or the floor. Bounces damp the
   * horizontal velocity by half against walls and a quarter on the floor, so the
   * first contact is where the grenade effectively stays; simulating the pinball
   * after it buys accuracy nobody needs at the cost everyone pays.
   */
  _predictGrenadeLanding(world, eye, vel, out) {
    // A mirror of updateGrenades, not an approximation of it. Two earlier attempts
    // guessed — first that the grenade stays where it first lands, then that it
    // skitters and stops — and both were wrong in ways that mattered: real grenades
    // keep their horizontal speed except at a bounce, so they slide like pucks to
    // roughly where they were aimed, and a wall mid-arc *reflects* one back the way
    // it came, which is the entire self-bombing mechanism this exists to predict.
    // Same gravity, same floor and wall bounces, same fuse, coarser steps.
    let px = eye.x, py = eye.y, pz = eye.z;
    let vx = vel.x, vy = vel.y, vz = vel.z;
    const dt = 1 / 30;
    for (let i = 0; i < 84; i++) {
      vy -= 13 * dt;
      const prevX = px, prevZ = pz;
      px += vx * dt; py += vy * dt; pz += vz * dt;
      let floorY = 0;
      for (const box of world.colliders) {
        if (box.max.y <= 3 && box.containsXZ(px, pz, 0.09) && py > box.max.y - 0.2) {
          floorY = Math.max(floorY, box.max.y);
        }
      }
      if (py < floorY + 0.09 && vy < 0) {
        py = floorY + 0.09;
        vy *= -0.36;
        vx *= 0.72; vz *= 0.72;
        if (Math.abs(vy) < 0.6) vy = 0;
      }
      for (const box of world.colliders) {
        if (py > box.max.y || py < box.min.y) continue;
        if (box.containsXZ(px, pz, 0.09) && !box.containsXZ(prevX, prevZ, 0.09)) {
          const p = { x: px, z: pz };
          box.pushCircleXZ(p, 0.12);
          const nx = p.x - px, nz = p.z - pz;
          const nl = Math.hypot(nx, nz) || 1;
          const dot = (vx * nx + vz * nz) / nl;
          vx -= 2 * dot * (nx / nl); vz -= 2 * dot * (nz / nl);
          vx *= 0.5; vz *= 0.5;
          px = p.x; pz = p.z;
          break;
        }
      }
    }
    return out.set(px, py, pz);
  }

  // would moving 0.9m in (dx,dz) walk us off a >0.8m ledge?
  _ledgeAhead(world, dx, dz) {
    const d = Math.hypot(dx, dz) || 1;
    const px = this.pos.x + (dx / d) * 0.9, pz = this.pos.z + (dz / d) * 0.9;
    const g = groundHeight(world.colliders, px, pz, this.pos.y);
    return this.pos.y - g > 0.8;
  }

  _targetAlive() {
    const t = this.target;
    return t && t.alive;
  }

  /**
   * Sweep every hostile for a sightline and write what he finds into memory.
   *
   * This replaces `_acquire`, which walked the live roster and returned whoever was
   * nearest — through walls, from behind, at any range. Target selection now happens
   * in `ContactMemory.best`, over beliefs, and this is the only thing in the AI that
   * is allowed to look at a hostile transform at all.
   *
   * The fighter he is already engaging gets re-checked every frame in the main loop;
   * this is the wider sweep that finds *new* people, on a slower cadence.
   */
  _scan(world, now) {
    const eye = this.eyePos(_scanEye);
    const look = (hostile) => {
      if (!hostile.alive) return;
      if (!withinVision(this.pos, this.yaw, hostile.pos)) {
        this.perception.markUnseen(hostile, now);
        return;
      }
      const aim = hostile.isPlayer
        ? playerAimPoint(world, eye, world.playerProxy, _scanAim)
        : hostile.aimPoint(_scanAim);
      if (hasLoS(world, eye, aim)) this.perception.see(hostile, hostile.pos, now);
      else this.perception.markUnseen(hostile, now);
    };
    if (this.team === 'enemy') look(world.playerProxy);
    for (const c of world.combatants) if (c.team !== this.team) look(c);
  }

  /**
   * A squadmate has called the lane he is taking.
   *
   * Kept per caller, so a man changing his mind replaces his own call rather than
   * adding a second one. Only ever reached through `world.callLane`, which decides
   * who was close enough to hear it — this fighter never reads a squadmate's
   * intentions, he is only ever told them.
   */
  hearLaneCall(caller, lane, target, now) {
    this.knownLanes.set(caller, { lane, target, at: now });
  }
  /**
   * A noise reached him. Only ever called through `world.emitNoise`.
   *
   * A gunshot does two separate jobs, and conflating them was the bug: it is a
   * rough fix on *where he is*, and it is evidence that *that angle is being
   * worked*. The second one accumulates — one round is nothing, twenty into the
   * same doorway is a reason to go round.
   */
  hearNoise(source, pos, kind, now, weight = 1, dir = null) {
    const contact = this.perception.hear(source, pos, kind, this.pos, now);
    // Gated on the contact, which is falsy exactly when the noise was out of
    // earshot — a fighter cannot be pinned by fire he cannot hear.
    if (contact && kind === 'gunshot') {
      this.suppression.record(pos, SUPPRESSION.shot * weight, now, { dir });
    }
    return contact;
  }

  /**
   * Send one weapon's worth of rounds down `dir` from `from`.
   *
   * Shared by aimed fire and area fire so the two cannot drift apart on the things
   * that have to stay true of both: the rounds leave the real muzzle, they cost real
   * ammunition, and they make the noise that gives the shooter away.
   */
  _sendRounds(world, w, from, dir, spreadDeg) {
    let hits = 0;
    for (let i = 0; i < w.pellets; i++) {
      const sdir = applySpread(dir, spreadDeg + (w.pellets > 1 ? 3.5 : 0), _sdirTmp);
      const res = fireRay(world, this, from, sdir, w,
        this.damageMult * (this.team === 'enemy' ? world.enemyDmgScale : 1));
      if (res.type === 'flesh' || res.type === 'player') hits++;
      world.fx.tracer(from, res.point);
      if (res.type === 'wall') { world.fx.sparks(res.point, sdir, res.normal); if (Math.random() < 0.3) audio.ricochet(); }
    }
    audio.shot(w.sound, 1.2 / (1 + from.distanceTo(world.cameraPos) * 0.09));
    world.fx.muzzleFlash(from, dir, { source: this });
    this.rig.trigger('fire');
    // Firing is a decision to be located. Everyone hostile inside earshot gets a
    // rough fix on the muzzle — the loudest, cheapest way to give yourself away.
    world.emitNoise?.(this, from, 'gunshot', w.suppression ?? 1, dir);
    const ammoT = ITEM_TYPES[this.weaponId]?.ammo;
    if (ammoT) this.ammoPools[ammoT] = Math.max(0, (this.ammoPools[ammoT] || 0) - 1);
    this.shotsFired = (this.shotsFired || 0) + 1;
    // When he last put a round out, which is what 'covering' means to the
    // rest of the squad — an elected setter holding his fire covers nobody.
    this.lastShotAt = world.simTime ?? 0;
    return { pellets: w.pellets, hits };
  }

  /**
   * Derive each stance's shield transform from where it wants the shield to *be*.
   *
   * For every stance: pose the arm, look at where the carrying bone has ended up in
   * the fighter's own frame, and invert it against the desired placement. What comes
   * out is the local position and rotation that puts the plate exactly there. Done
   * at build time against the bind pose, so it is deterministic and costs nothing
   * per frame — the same reference frame the original single hand-solved offset used.
   */
  _placeShield() {
    const st = SHIELD_STANCES[this.shieldStance];
    if (!st || !this.shieldMesh || !this.alive) return;
    const carrier = this.rig.bones.get(st.parent);
    const root = this.rig.root;
    if (!carrier) return;
    // Solved against the bones as they are *this frame*, not against the bind pose.
    //
    // Caching one transform per stance was the obvious thing and was wrong by up to
    // twenty centimetres: the plate hangs off the hand, the hand hangs off a spine
    // that is breathing and walking, so a placement solved once drifts with the
    // animation. Twenty centimetres is the difference between a shield flush with
    // the floor and one buried in it — and because the plate is a real hitbox, it is
    // also the difference between a head being covered and not. The balance is the
    // geometry, so the geometry gets solved properly.
    //
    // Deliberately only while he is alive: a corpse stops re-solving and the plate
    // keeps its last local transform, so it falls with the arm the way a carried
    // object should.
    _shieldInRoot.copy(root.matrixWorld).invert().multiply(carrier.matrixWorld);
    _shieldWant.compose(
      _shieldPos.set(st.place.x, st.place.y, st.place.z),
      _shieldQuat.setFromEuler(
        _shieldEuler.set(st.place.pitch || 0, st.place.yaw || 0, st.place.roll || 0),
      ),
      _shieldOne,
    );
    _shieldLocal.multiplyMatrices(_shieldInRoot.invert(), _shieldWant);
    _shieldLocal.decompose(this.shieldMesh.position, this.shieldMesh.quaternion, _shieldScl);
    this.shieldMesh.scale.set(1, 1, 1);
  }

  /** Which way he is holding it this frame. */
  _shieldStanceName(wantCrouch) {
    if (this.twoHanded) return 'stowed';
    if (this.sprintNow) return 'sprint';
    if (wantCrouch) return 'turtle';
    if (this.adsK > 0.45) return 'aim';
    return 'carry';
  }

  /** Move the plate, repose the arm, and re-price him. Only on a change. */
  _setShieldStance(name) {
    if (!this.shieldMesh || this.shieldStance === name) return;
    const st = SHIELD_STANCES[name];
    if (!st) return;
    this.shieldStance = name;
    for (const b of SHIELD_BONES) this.rig.pinBone(b, null);
    if (st.pose) for (const [b, euler] of Object.entries(st.pose)) this.rig.pinBone(b, euler);
    const carrier = this.rig.bones.get(st.parent);
    if (carrier && this.shieldMesh.parent !== carrier) carrier.add(this.shieldMesh);
    this.shieldPresenting = !!st.presenting;
    this.shieldSpeedMult = st.speed;
    this.shieldSpreadMult = st.spread;
    this.shieldCrouch = st.crouch ?? null;
  }

  /**
   * Is `other` a shieldman with his plate between us?
   *
   * The question every other fighter on the map should be asking before committing
   * to a shot, because the answer decides whether shooting is worth anything at all.
   */
  _shieldFacingMe(other) {
    if (!other?.alive || other.archetype !== 'shield' || !other.shieldPresenting) return false;
    const dx = this.pos.x - other.pos.x, dz = this.pos.z - other.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    return (dx / d) * Math.sin(other.yaw) + (dz / d) * Math.cos(other.yaw) > 0.34;
  }

  /** Line of sight between two loose `{x, y, z}` points, without allocating. */
  _laneSees(world, from, to) {
    return hasLoS(
      world,
      _laneFrom.set(from.x, from.y, from.z),
      _laneTo.set(to.x, to.y, to.z),
    );
  }

  /**
   * Is a friendly shieldman planted between `from` and `to`, facing the fire?
   *
   * A carried riot shield is a wall that walks, and the squad should treat it as
   * one: ground behind it prices as covered, which is what makes the others stack
   * up behind him instead of spreading into the open beside him. Facing matters —
   * a shield pointed the wrong way is a man, not a wall.
   */
  _shieldBlocks(world, team, from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return false;
    for (const c of world.combatants) {
      if (!c.alive || c.team !== team || c.archetype !== 'shield') continue;
      // Only while he is actually holding it up. A man sprinting with it at his hip
      // is cover for nobody, and the squad stacking behind him as though he were was
      // the worst version of this feature.
      if (!c.shieldPresenting) continue;
      const t = ((c.pos.x - from.x) * dx + (c.pos.z - from.z) * dz) / (len * len);
      if (t < 0.05 || t > 0.95) continue;
      const px = from.x + dx * t, pz = from.z + dz * t;
      if (Math.hypot(c.pos.x - px, c.pos.z - pz) > 0.7) continue;
      // Shield toward the threat: his facing within ~70 degrees of the line back
      // to the muzzle.
      const md = Math.hypot(from.x - c.pos.x, from.z - c.pos.z) || 1;
      const facingDot = ((from.x - c.pos.x) / md) * Math.sin(c.yaw)
        + ((from.z - c.pos.z) / md) * Math.cos(c.yaw);
      if (facingDot > 0.34) return true;
    }
    return false;
  }

  /**
   * Is any living squadmate standing in this fire line?
   *
   * Bodies are soft cover to the danger model — no one plans a route on the
   * assumption a friend will keep standing there — but they are a hard reason not
   * to pull the trigger. AI rounds pass through friendlies by design, and the
   * visible result was a squad shooting through each other's backs; the round may
   * not hurt the man in front, but firing it reads as absurd and the shot was
   * never clean. Blocked shooters keep strafing, which is what clears the lane.
   */
  _friendlyInLine(world, from, to) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return false;
    for (const c of world.combatants) {
      if (c === this || !c.alive || c.team !== this.team) continue;
      const t = ((c.pos.x - from.x) * dx + (c.pos.z - from.z) * dz) / (len * len);
      if (t < 0.04 || t > 0.96) continue;
      const px = from.x + dx * t, pz = from.z + dz * t;
      if (Math.hypot(c.pos.x - px, c.pos.z - pz) < 0.5) return true;
    }
    return false;
  }

  /** Is this lane coming at my shield? Only a shieldman ever asks. */
  _shieldFronts(lane) {
    if (this.archetype !== 'shield' || !this.shieldPresenting) return false;
    const dx = lane.x - this.pos.x, dz = lane.z - this.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    return (dx / d) * Math.sin(this.yaw) + (dz / d) * Math.cos(this.yaw) > 0.5;
  }

  /**
   * The sight callback the danger model runs on: walls, then the walking wall.
   *
   * His own shield first — fire from the front is his to ignore, which is the
   * boldness the archetype is for — then any squadmate's shield planted across the
   * line, which is what lets everyone else treat the man as cover.
   */
  _dangerSees(world, from, to) {
    if (this._shieldFronts(from)) return false;
    if (!this._laneSees(world, from, to)) return false;
    return !this._shieldBlocks(world, this.team, from, to);
  }

  /**
   * Would leaning out this side put him in something's beaten zone?
   *
   * Checked at the lean itself and again a metre out, because a peek is not a lean —
   * the body steps sideways with it, so the question is whether the ground he ends up
   * on is being worked, not just the 29 cm the weapon travels.
   */
  _peekSwept(world, side, fx, fz, now) {
    if (!this.suppression.anyDanger(now)) return false;
    const chest = this.pos.y + 1.15 * this.scale;
    for (const reach of [PEEK_REACH, 1.1]) {
      _routePoint.set(
        this.pos.x + -fz * reach * side,
        chest,
        this.pos.z + fx * reach * side,
      );
      if (this._groundIsDangerous(world, _routePoint, now)) return true;
    }
    return false;
  }

  /**
   * Is this piece of ground being worked, or has it already got somebody hit?
   *
   * The two questions are answered separately on purpose. A lane is an inference
   * about a gun and needs a sightline to mean anything; a mark is a fact about a spot
   * and does not care where the fire came from, which is what makes it survive the
   * shooter relocating.
   */
  _groundIsDangerous(world, point, now) {
    if (this.suppression.markedAt(point, now)) return true;
    if (this._inEnemyShieldArc(world, point)) return true;
    return !!this.suppression.covering(point, (from, to) => this._dangerSees(world, from, to), now);
  }

  /**
   * Is this ground in front of an enemy who is holding a shield up?
   *
   * Refusing to *shoot* a fronted shieldman turned out to be half an idea, and
   * measured worse than none: the squad correctly stopped targeting the plates,
   * picked the rifleman standing behind them instead, and then walked into the
   * shield arcs anyway on the way to him — ninety-nine percent of their
   * shield-facing time spent square in front of one, shooting past it at somebody
   * else. Not aiming at a shield is not the same as not standing in front of one.
   *
   * So the arc is *ground*, priced by the same machinery as a beaten zone. Routes,
   * breach lanes and cover choices all consult this already, so "go round him"
   * needs no separate plan and no coordination — the cheap way in simply stops
   * running through his frontage. That is what makes the flank emergent rather than
   * scripted: nobody is told to flank, the front is just expensive.
   */
  _inEnemyShieldArc(world, point) {
    for (const c of world.combatants) {
      if (!c.alive || c.team === this.team || c.archetype !== 'shield') continue;
      if (!c.shieldPresenting) continue;
      const dx = point.x - c.pos.x, dz = point.z - c.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > SHIELD_ARC_RANGE * SHIELD_ARC_RANGE) continue;
      const d = Math.sqrt(d2) || 1;
      if ((dx / d) * Math.sin(c.yaw) + (dz / d) * Math.cos(c.yaw) > SHIELD_ARC_DOT) return true;
    }
    return false;
  }

  /**
   * How much of the way to `goal` is ground somebody is presently covering, 0..1.
   *
   * Weighted hard toward the far end. A fighter who reroutes is already standing in
   * the beaten zone, so the near samples are covered whichever way he goes — count
   * them equally and every escape scores as badly as staying put, which is how a
   * squad ends up cowering behind one crate with a clear route four steps to its
   * right. What separates a good lane from a bad one is where it *ends*.
   *
   * Bails immediately when nothing is hot, which is most of the time.
   */
  _routeCost(world, goal, now, side = this.flankSide) {
    if (!this.suppression.anyDanger(now)) return 0;
    const sees = (from, to) => this._dangerSees(world, from, to);
    const chest = this.pos.y + 1.15 * this.scale;
    const legs = this._routeLegs(world, goal, side);
    let walked = 0;
    for (let i = 1; i < legs.length; i++) {
      walked += Math.hypot(legs[i].x - legs[i - 1].x, legs[i].z - legs[i - 1].z);
    }
    const steps = Math.max(ROUTE_MIN_SAMPLES,
      Math.min(ROUTE_MAX_SAMPLES, Math.ceil(walked / ROUTE_STEP)));
    let swept = 0;
    let total = 0;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const weight = routeSampleWeight(t);
      total += weight;
      pointAlongPath(legs, t, _routePoint);
      _routePoint.y = chest;
      // Priced by how hard the lane is being worked, not merely by whether it is
      // hot. Crossing stays cheap against a few opportunist rounds and becomes
      // prohibitive against a rifle that has been sawing down the corridor.
      const lane = this.suppression.covering(_routePoint, sees, now);
      if (lane) {
        let bite = laneSeverity(lane, now);
        // Ground you run across is not ground you stand on. A destination inside the
        // beaten zone is still refused outright, but the crossing on the way to
        // somewhere better is a second and a half at a sprint, and pricing it as
        // though he were going to stop there is what left the squad with no way in
        // at all. Quiet lanes are cheaper again — a reload or a turn onto somebody
        // else is exactly the moment to take the gap.
        if (t < 1) {
          bite *= TRANSIT_DISCOUNT;
          if (laneQuietFor(lane, now) > LULL_SECONDS) bite *= LULL_DISCOUNT;
        }
        swept += weight * bite;
        continue;
      }
      // Ground that has already taken somebody counts heavier than ground merely
      // presumed covered — a bite is worth more than a bang. Marks he is standing
      // inside are skipped: a hit lands a stride from the cover the victim was quite
      // correctly using, so counting it makes every route out of his own position
      // expensive and pushes him into the open to escape a blob at his feet.
      swept += weight * this.suppression.markWeightAt(_routePoint, now, this.pos);
    }
    return Math.min(1, swept / Math.max(1e-6, total));
  }

  /**
   * The polyline this fighter would actually walk to reach `goal`.
   *
   * Costing a straight line was the routing bug. Movement goes through the navmesh,
   * so around a held corner the straight line to a flank goal clips the wall the
   * flank exists to use — it samples ground the shooter cannot see, scores clean, and
   * the fighter then walks a real path straight through the beaten zone. Cost and
   * movement now ask the navmesh the same question in the same way, so a lane is
   * scored on the route it actually commits him to.
   */
  _routeLegs(world, goal, side = this.flankSide) {
    _routeLegs.length = 0;
    _routeLegs.push(this.pos);
    const gy = goal.y ?? this.pos.y;
    const straight = world.nav
      ? world.nav.walkableLine(this.pos.x, this.pos.z, this.pos.y, goal.x, goal.z, gy)
      : true;
    if (!straight) {
      const path = world.nav.findPath(this.pos, { x: goal.x, y: gy, z: goal.z },
        this.navSeed, side);
      if (path && path.length) _routeLegs.push(...path);
    }
    _routeLegs.push(_routeGoal.set(goal.x, gy, goal.z));
    return _routeLegs;
  }

  /**
   * The cheaper of the two ways round to `goal`, and which way that was.
   *
   * A goal on the far side of the pit is only safe if you *get there* the far way,
   * and the navmesh optimises distance, so left round the obstacle is what it hands
   * back even when the goal is on the right. That made the whole far side unusable:
   * the destination was clean, the shortest path to it went straight down the beaten
   * zone, the cost came back high, and the lane was thrown out. Asking the pathfinder
   * for both sides and keeping the better one is what turns "somewhere safe to stand"
   * into "a safe way of getting there".
   *
   * The side that won is carried to the commitment, because a route costed one way
   * round and then walked the other is the straight-line bug over again.
   */
  _routeCostBothWays(world, goal, now) {
    const own = this._routeCost(world, goal, now, this.flankSide);
    // Only worth asking the pathfinder for the other way round when the way it
    // prefers is genuinely bad. Costing both sides of every candidate doubled the
    // route work for no measurable gain, and route sampling is dense now.
    if (own < LANE_ABANDON) return { cost: own, side: this.flankSide };
    const other = this._routeCost(world, goal, now, -this.flankSide);
    return other < own
      ? { cost: other, side: -this.flankSide }
      : { cost: own, side: this.flankSide };
  }

  removeFrom(world) {
    if (this.laser) world.scene.remove(this.laser);
    this.rig.dispose();
    world.scene.remove(this.group);
    world.hitMeshes = world.hitMeshes.filter(m => m.userData.combatant !== this);
    const i = world.combatants.indexOf(this);
    if (i >= 0) world.combatants.splice(i, 1);
  }
}
