import * as THREE from 'three';

export const PART_MULT = { head: 3.2, torso: 1.0, armL: 0.6, armR: 0.6, legL: 0.6, legR: 0.6 };

const _v = new THREE.Vector3();
const _ba = new THREE.Vector3();
const _oa = new THREE.Vector3();
const _oc = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _head = new THREE.Vector3();
const _radial = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _n = new THREE.Vector3();
const _playerFacing = new THREE.Vector3(0, 0, -1);
const _aimAlt = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _toBody = new THREE.Vector3();
const _wallPoint = new THREE.Vector3();
const _wallNormal = new THREE.Vector3();
const _broadCandidates = [];
// Sphere at chest height covering a whole fighter — head, boots, outstretched arms,
// a carried shield — with slack. Generosity here only costs a narrow-phase test.
const _BROAD_R = 2.0;

/**
 * Where a ray meets the world.
 *
 * Accepts either the world or a bare array of colliders. Given the world, and once
 * its triangle collider has been built, rays run against the *real geometry* and the
 * box colliders sit this out entirely — they have to, because a box is always at
 * least as big as the thing inside it, so testing both would just reinstate the box.
 *
 * The boxes remain the answer for movement, and remain the answer for rays until the
 * props have streamed in. See src/meshcollider.js for why the split is drawn here.
 */
function raySolids(src) {
  if (Array.isArray(src)) return null;
  const s = src && src.solids;
  return s && s.ready ? s : null;
}
function rayBoxes(src) {
  return Array.isArray(src) ? src : (src && src.colliders) || [];
}

// Distance to nearest wall/obstacle along ray (also floor plane y=0).
// Returns {dist, point, normal}.
// `outPoint` receives the impact point when given; callers probing many directions a
// frame (the spectator orbit, per-pellet fire) pass a scratch vector instead of
// paying an allocation per probe.
// `normal` is the hit surface's normal, oriented back toward the shooter — what a
// decal should lie flat against. It rides in a shared scratch (consume it before
// the next wallHit call) and is null on the box-collider path, which reports only
// a distance: props still streaming in, and the few seconds of a fresh page load.
export function wallHit(src, origin, dir, maxDist = 200, outPoint = null) {
  let best = maxDist;
  let normal = null;
  const solids = raySolids(src);
  if (solids) {
    const t = solids.raycast(origin, dir, maxDist, _wallNormal);
    if (t !== null && t < best) { best = t; normal = _wallNormal; }
  }
  for (const box of solids ? [] : rayBoxes(src)) {
    const t = box.raycast(origin, dir);
    if (t !== null && t < best) best = t;
  }
  if (dir.y < -1e-6) {
    const t = -origin.y / dir.y;
    if (t > 0 && t < best) { best = t; normal = _wallNormal.set(0, 1, 0); }
  }
  // The BVH tests double-sided, so the triangle's winding is meaningless; the side
  // facing the shooter is by definition the side the ray came from.
  if (normal && normal.dot(dir) > 0) normal.negate();
  const point = (outPoint || new THREE.Vector3()).copy(origin).addScaledVector(dir, best);
  return { dist: best, point, normal };
}

// Line of sight between two points (true if unobstructed by arena geometry).
export function hasLoS(src, from, to) {
  const solids = raySolids(src);
  if (solids) return !solids.blocked(from, to);
  const colliders = rayBoxes(src);
  const dir = _v.copy(to).sub(from);
  const dist = dir.length();
  if (dist < 0.001) return true;
  dir.normalize();
  // Any box the sightline actually crosses must have its world AABB overlap the
  // segment's. Most of the arena is nowhere near any one sightline, so rejecting on
  // six comparisons beats running a full slab test against every collider.
  //
  // The AABB is a hint, not a requirement: anything exposing `raycast` is still a
  // valid collider here, and one without bounds simply skips the broadphase.
  const x0 = from.x < to.x ? from.x : to.x, x1 = from.x < to.x ? to.x : from.x;
  const y0 = from.y < to.y ? from.y : to.y, y1 = from.y < to.y ? to.y : from.y;
  const z0 = from.z < to.z ? from.z : to.z, z1 = from.z < to.z ? to.z : from.z;
  for (const box of colliders) {
    const min = box.min, max = box.max;
    if (min && (min.x > x1 || max.x < x0 || min.y > y1 || max.y < y0 || min.z > z1 || max.z < z0)) continue;
    const t = box.raycast(from, dir);
    if (t !== null && t < dist - 0.1) return false;
  }
  return true;
}

// Ray vs player capsule (vertical). Returns {dist, point, yRel} or null.
/**
 * Ray against a capsule: the segment a-b, swept by `radius`.
 *
 * Analytic, because the marching version this replaces sampled every 0.35 m and the
 * player's head band is 0.22 m tall — so whether a headshot registered came down to
 * where the samples happened to land, and mostly they landed either side of it.
 * Nobody could shoot the player in the face, and no amount of aiming changed that.
 *
 * Returns the near intersection with the distance along the ray, the point, and `t`,
 * the position along the capsule's axis as a fraction. `t` is what part assignment is
 * built on, so it has to be exact rather than quantised.
 */
export function rayVsCapsule(origin, dir, a, b, radius, maxDist) {
  _ba.copy(b).sub(a);
  _oa.copy(origin).sub(a);
  const baba = _ba.dot(_ba);
  const bard = _ba.dot(dir);
  const baoa = _ba.dot(_oa);
  const rdoa = dir.dot(_oa);
  const oaoa = _oa.dot(_oa);

  let best = Infinity;
  let axial = 0;

  // Body: the cylinder between the two end caps.
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - radius * radius * baba;
  const h = B * B - A * C;
  if (h >= 0 && Math.abs(A) > 1e-9) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (t >= 0 && y > 0 && y < baba) { best = t; axial = y / baba; }
  }

  // Caps: a sphere at each end. Checked even when the body hit, because a shot that
  // clips only the top of the head never touches the cylinder at all. Written out
  // rather than looped over a pair table, which allocated three arrays per ray.
  _oc.copy(origin).sub(a);
  let bb = dir.dot(_oc);
  let hh = bb * bb - (_oc.dot(_oc) - radius * radius);
  if (hh >= 0) {
    const t = -bb - Math.sqrt(hh);
    if (t >= 0 && t < best) { best = t; axial = 0; }
  }
  _oc.copy(origin).sub(b);
  bb = dir.dot(_oc);
  hh = bb * bb - (_oc.dot(_oc) - radius * radius);
  if (hh >= 0) {
    const t = -bb - Math.sqrt(hh);
    if (t >= 0 && t < best) { best = t; axial = 1; }
  }

  if (!Number.isFinite(best) || best > maxDist) return null;
  return {
    dist: best,
    point: new THREE.Vector3().copy(origin).addScaledVector(dir, best),
    t: axial,
  };
}

/**
 * The player's hit volume, as a body capsule and a head sphere.
 *
 * Heights are fractions of standing height. One fat cylinder from boots to scalp was
 * what stood in for this, 0.76 m across at every height, with the head an arbitrary
 * band near the top of it.
 */
export const PLAYER_HITBOX = {
  height: 1.73,
  bodyRadius: 0.30,   // ~0.60 m across the shoulders
  bodyLow: 0.34,      // centre of the lower end cap
  bodyHigh: 1.22,     // centre of the upper end cap: the shoulders, not the skull
  headRadius: 0.15,
  headY: 1.57,        // fallback only; the head really sits on the camera
  // Below this fraction of the body capsule is legs, above it torso.
  legTop: 0.42,
  // A hit further than this fraction of the radius from the axis, in the torso band,
  // is an arm — they hang outboard of the ribs, which is a fact about where they are
  // rather than a die roll. The old model gave every torso hit a flat 28% chance of
  // being an arm no matter where it landed.
  armEdge: 0.55,
};

/**
 * The player's head sits on his camera.
 *
 * Not at a fixed height over his feet, and not at a fraction of his lean — at the
 * point he is actually looking from. That identity is the whole guarantee: if he can
 * see you, you can shoot him in the head. Deriving it instead left the hittable head
 * 5 cm short of where he was peeking from and 10 cm above where he was looking from
 * (the camera drops as it leans, which nothing else knew about), and around a tight
 * corner 5 cm is the entire difference between a sightline and a wall.
 *
 * `pp.eye` is set by the player each frame. The fallback keeps the old derivation for
 * callers that have not got one.
 */
function playerEye(pp, out) {
  if (pp.eye) return out.copy(pp.eye);
  const s = pp.heightScale || 1;
  const y = PLAYER_HITBOX.headY * s;
  const k = y / PLAYER_HITBOX.height;
  return out.set(pp.pos.x + (pp.leanX || 0) * k, pp.pos.y + y, pp.pos.z + (pp.leanZ || 0) * k);
}

/**
 * A point on the player's body axis at height `y` above his feet, in world space.
 *
 * The axis runs from between his boots to his eye, so a lean pivots about the feet:
 * the head swings out, the boots stay put. Translating the whole volume sideways —
 * which is what this replaces — carried his legs around the corner with him.
 */
function playerAxisPoint(pp, y, out) {
  playerEye(pp, _eye);
  const eyeH = _eye.y - pp.pos.y;
  const k = eyeH > 1e-3 ? y / eyeH : 0;
  return out.set(
    pp.pos.x + (_eye.x - pp.pos.x) * k,
    pp.pos.y + y,
    pp.pos.z + (_eye.z - pp.pos.z) * k,
  );
}

/** Resolve a hostile ray against the player. */
export function rayVsPlayer(origin, dir, pp, maxDist) {
  const H = PLAYER_HITBOX;
  const s = pp.heightScale || 1;

  playerAxisPoint(pp, H.bodyLow * s, _capA);
  playerAxisPoint(pp, H.bodyHigh * s, _capB);
  playerEye(pp, _head);

  const body = rayVsCapsule(origin, dir, _capA, _capB, H.bodyRadius * s, maxDist);
  const head = rayVsCapsule(origin, dir, _head, _head, H.headRadius * s, maxDist);

  // The head wins overlaps.
  //
  // The shoulders are wider than the skull, so at the top of the chest the body
  // capsule is entered *before* the head sphere even on a shot going straight through
  // the face — nearest-surface-wins reported the lower half of every head as a
  // shoulder. A round that passes through the head sphere at all went through his
  // head, unless it went a long way through his body first.
  if (head && (!body || head.dist <= body.dist + 0.25)) {
    return { part: 'head', point: head.point, dist: head.dist };
  }
  if (!body) return null;

  // How close to the body's centre line the round actually passed, and which side of
  // it. Both come from the *ray*, not from the impact point: an impact is on the
  // surface by definition, so its distance from the axis is always exactly the radius
  // and every single hit read as an arm.
  const { offset, side } = _impact(origin, dir, _capA, _capB);
  let part;
  if (body.t < H.legTop) part = side < 0 ? 'legL' : 'legR';
  else if (offset / (H.bodyRadius * s) > H.armEdge) part = side < 0 ? 'armL' : 'armR';
  else part = 'torso';
  return { part, point: body.point, dist: body.dist };
}

/**
 * Where a ray passed relative to a body axis: how far off the centre line, and which
 * side, in the player's own left/right.
 */
function _impact(origin, dir, a, b) {
  _axis.copy(b).sub(a).normalize();
  _n.crossVectors(dir, _axis);
  const len = _n.length();
  _radial.copy(a).sub(origin);
  if (len < 1e-6) {
    // Ray along the body axis — straight down from above, or straight up. No
    // meaningful side; call it centre.
    return { offset: 0, side: 1 };
  }
  _n.divideScalar(len);
  const d = _radial.dot(_n);                 // axis is this far along n from the ray
  // The ray sits on the opposite side, so its lateral displacement is -d * n.
  const rx = -_playerFacing.z, rz = _playerFacing.x;   // the player's right
  const lateral = -d * (_n.x * rx + _n.z * rz);
  return { offset: Math.abs(d), side: lateral < 0 ? -1 : 1 };
}

/** Set by the world each frame so limb sides mean the player's left and right. */
export function setPlayerFacing(v) { _playerFacing.copy(v); }

/**
 * Where a shooter at `from` should aim at the player, given he may be leaning.
 *
 * Chest first, because that is what anyone shoots at. Head if the chest is not there
 * to be hit. Lives here rather than in the AI because it has to agree with
 * `rayVsPlayer` about where the player's body actually is — the two reading the lean
 * differently is how a fighter comes to aim at a point his own bullets cannot reach.
 *
 * The AI used to aim at a fixed point over the player's feet with no lean term at
 * all, so a player peeking a corner was aimed at *through* the wall he was peeking
 * past, and his exposed head drew no fire whatsoever.
 */
export function playerAimPoint(src, from, pp, out = new THREE.Vector3()) {
  const s = pp.heightScale || 1;
  playerAxisPoint(pp, 1.15 * s, out);
  if (hasLoS(src, from, out)) return out;
  playerEye(pp, _aimAlt);
  if (hasLoS(src, from, _aimAlt)) return out.copy(_aimAlt);
  return playerAxisPoint(pp, 1.15 * s, out);
}

// Apply angular spread (degrees) to a direction. Writes into `out` when given —
// this runs once per pellet, so a shotgun blast used to allocate 24 vectors.
const _spreadP1 = new THREE.Vector3();
const _spreadP2 = new THREE.Vector3();
export function applySpread(dir, spreadDeg, out = new THREE.Vector3()) {
  const spread = THREE.MathUtils.degToRad(spreadDeg);
  out.copy(dir);
  // random offset in disc perpendicular to dir
  _spreadP1.set(0, 1, 0).cross(dir);
  if (_spreadP1.lengthSq() < 0.001) _spreadP1.set(1, 0, 0);
  _spreadP1.normalize();
  _spreadP2.crossVectors(dir, _spreadP1).normalize();
  const ang = Math.random() * Math.PI * 2;
  const r = (Math.random() + Math.random()) * 0.5 * spread; // triangular distribution, denser center
  return out.addScaledVector(_spreadP1, Math.cos(ang) * r).addScaledVector(_spreadP2, Math.sin(ang) * r).normalize();
}

/**
 * Fire one hitscan ray through the world.
 * world: { colliders, hitMeshes, playerProxy, fx }
 * shooter: { team, isPlayer? }
 * Returns { type: 'wall'|'flesh'|'player'|'miss', point, part?, combatant?, dist }
 */
export function fireRay(world, shooter, origin, dir, weapon, dmgScale = 1, maxDist = 200) {
  // The wall point rides in a shared scratch: every caller consumes `res.point`
  // (a tracer endpoint, a spark burst) before firing the next ray.
  const wall = wallHit(world, origin, dir, maxDist, _wallPoint);

  // combatant part meshes
  _raycaster.set(origin, dir);
  _raycaster.far = wall.dist;
  let fleshHit = null;
  // Broad-phase first: a fighter is a roughly man-sized target, so any fighter whose
  // chest passes further than _BROAD_R from the ray line cannot be hit, and his 16
  // part meshes (each a matrix inversion plus a triangle pass inside the raycaster)
  // are never tested. Ten fighters put ~160 meshes in `hitMeshes`; a typical shot
  // threads near one or two of them. Worlds without a combatants list (some test
  // harnesses) keep the exhaustive path.
  let meshes = world.hitMeshes;
  if (world.combatants) {
    _broadCandidates.length = 0;
    for (const c of world.combatants) {
      if (!c.alive || !c.parts) continue;
      if (c.team === shooter.team && !shooter.isPlayer) continue;
      _toBody.set(c.pos.x - origin.x, c.pos.y + 1.0 - origin.y, c.pos.z - origin.z);
      const along = _toBody.dot(dir);
      const reach = _BROAD_R * (c.scale || 1);
      if (along < -reach || along > wall.dist + reach) continue;
      if (_toBody.lengthSq() - along * along > reach * reach) continue;
      for (const p of c.parts) _broadCandidates.push(p);
    }
    meshes = _broadCandidates;
  }
  const hits = _raycaster.intersectObjects(meshes, false);
  for (const h of hits) {
    const c = h.object.userData.combatant;
    if (!c || !c.alive) continue;
    // AI never bullet-teamkills; the PLAYER's rounds hit whoever is in the lane
    if (c.team === shooter.team && !shooter.isPlayer) continue;
    fleshHit = { combatant: c, part: h.object.userData.part, point: h.point, dist: h.distance };
    break;
  }

  // player hit volume (only hostile shots)
  let playerHit = null;
  const pp = world.playerProxy;
  if (shooter.team !== 'player' && pp.alive) {
    if (world.playerAim) setPlayerFacing(world.playerAim);
    playerHit = rayVsPlayer(origin, dir, pp,
      Math.min(wall.dist, fleshHit ? fleshHit.dist : wall.dist));
  }

  // resolve nearest
  const gMult = world.globalDmgMult || 1; // BLOOD RULES etc.
  if (playerHit && (!fleshHit || playerHit.dist < fleshHit.dist)) {
    const dmg = computeDamage(weapon, playerHit.part, playerHit.dist) * dmgScale * gMult;
    world.onPlayerDamaged(dmg, playerHit.part, origin, shooter, playerHit.dist);
    return { type: 'player', ...playerHit };
  }
  if (fleshHit) {
    const dmg = computeDamage(weapon, fleshHit.part, fleshHit.dist) * dmgScale * gMult;
    // `dir` lets the hit VFX spray along the bullet's path instead of puffing
    // symmetrically out of the wound.
    fleshHit.combatant.applyDamage(world, fleshHit.part, dmg, shooter, fleshHit.point, dir);
    return { type: 'flesh', ...fleshHit };
  }
  if (wall.dist < 199) return { type: 'wall', point: wall.point, dist: wall.dist, normal: wall.normal };
  return { type: 'miss', point: wall.point, dist: wall.dist };
}

export function computeDamage(weapon, part, dist) {
  let dmg = weapon.dmg * (PART_MULT[part] ?? 1);
  if (weapon.falloff && dist > weapon.falloff) {
    dmg *= Math.max(0.25, 1 - (dist - weapon.falloff) / 25);
  }
  return dmg;
}

export const STEP_REACH = 0.55;   // max ledge height walked up without jumping/mantling
export const STAND_LIMIT = 2.8;   // boxes taller than this are walls, never floors

// Highest standable surface under (x,z) reachable from height y (0 = arena floor).
export function groundHeight(colliders, x, z, y, pad = 0.25) {
  let g = 0;
  for (const box of colliders) {
    if (box.max.y > STAND_LIMIT) continue;
    if (box.max.y - y <= STEP_REACH && box.containsXZ(x, z, pad)) {
      g = Math.max(g, box.max.y);
    }
  }
  return g;
}

// Push a circle (x,z at pos, given radius) out of collider boxes. Mutates pos.
// standY: the walker's current foot height — boxes low enough to step onto don't push.
export function resolveCircle(pos, radius, colliders, standY = 0) {
  for (const box of colliders) {
    if (box.max.y - standY <= STEP_REACH && box.max.y <= STAND_LIMIT) continue;
    if (box.max.y < standY + 0.2 || box.min.y > standY + 1.6) continue;
    box.pushCircleXZ(pos, radius);
  }
}
