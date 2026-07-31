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
const _raycaster = new THREE.Raycaster();

// Distance to nearest wall/obstacle along ray (also floor plane y=0). Returns {dist, point}.
export function wallHit(colliders, origin, dir, maxDist = 200) {
  let best = maxDist;
  for (const box of colliders) {
    const t = box.raycast(origin, dir);
    if (t !== null && t < best) best = t;
  }
  if (dir.y < -1e-6) {
    const t = -origin.y / dir.y;
    if (t > 0 && t < best) best = t;
  }
  const point = new THREE.Vector3().copy(origin).addScaledVector(dir, best);
  return { dist: best, point };
}

// Line of sight between two points (true if unobstructed by arena colliders).
export function hasLoS(colliders, from, to) {
  const dir = _v.copy(to).sub(from);
  const dist = dir.length();
  if (dist < 0.001) return true;
  dir.normalize();
  for (const box of colliders) {
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
  // clips only the top of the head never touches the cylinder at all.
  for (const [centre, at] of [[a, 0], [b, 1]]) {
    _oc.copy(origin).sub(centre);
    const bb = dir.dot(_oc);
    const cc = _oc.dot(_oc) - radius * radius;
    const hh = bb * bb - cc;
    if (hh < 0) continue;
    const t = -bb - Math.sqrt(hh);
    if (t >= 0 && t < best) { best = t; axial = at; }
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
  headY: 1.57,        // sits on the eye line; see Player.eyeHeight
  // Below this fraction of the body capsule is legs, above it torso.
  legTop: 0.42,
  // A hit further than this fraction of the radius from the axis, in the torso band,
  // is an arm — they hang outboard of the ribs, which is a fact about where they are
  // rather than a die roll. The old model gave every torso hit a flat 28% chance of
  // being an arm no matter where it landed.
  armEdge: 0.55,
};

/**
 * Resolve a hostile ray against the player.
 *
 * A lean pivots about the feet: the head swings out, the boots stay put. The model
 * this replaces translated the whole cylinder sideways, so leaning around a corner
 * carried the player's legs out with it and exposed them to fire nobody could see
 * the source of.
 */
export function rayVsPlayer(origin, dir, pp, maxDist) {
  const H = PLAYER_HITBOX;
  const s = pp.heightScale || 1;
  const lx = pp.leanX || 0, lz = pp.leanZ || 0;
  const tilt = (y) => y / H.height;      // how much of the lean has arrived by height y

  _capA.set(pp.pos.x + lx * tilt(H.bodyLow * s), pp.pos.y + H.bodyLow * s,
    pp.pos.z + lz * tilt(H.bodyLow * s));
  _capB.set(pp.pos.x + lx * tilt(H.bodyHigh * s), pp.pos.y + H.bodyHigh * s,
    pp.pos.z + lz * tilt(H.bodyHigh * s));
  _head.set(pp.pos.x + lx * tilt(H.headY * s), pp.pos.y + H.headY * s,
    pp.pos.z + lz * tilt(H.headY * s));

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
export function playerAimPoint(colliders, from, pp, out = new THREE.Vector3()) {
  const H = PLAYER_HITBOX;
  const s = pp.heightScale || 1;
  const at = (y, o) => o.set(
    pp.pos.x + (pp.leanX || 0) * (y / H.height),
    pp.pos.y + y * s,
    pp.pos.z + (pp.leanZ || 0) * (y / H.height),
  );
  at(1.15, out);
  if (hasLoS(colliders, from, out)) return out;
  at(H.headY, _aimAlt);
  if (hasLoS(colliders, from, _aimAlt)) return out.copy(_aimAlt);
  return at(1.15, out);
}

// Apply angular spread (degrees) to a direction.
export function applySpread(dir, spreadDeg) {
  const spread = THREE.MathUtils.degToRad(spreadDeg);
  const out = dir.clone();
  // random offset in disc perpendicular to dir
  const perp1 = new THREE.Vector3(0, 1, 0).cross(dir);
  if (perp1.lengthSq() < 0.001) perp1.set(1, 0, 0);
  perp1.normalize();
  const perp2 = new THREE.Vector3().crossVectors(dir, perp1).normalize();
  const ang = Math.random() * Math.PI * 2;
  const r = (Math.random() + Math.random()) * 0.5 * spread; // triangular distribution, denser center
  out.addScaledVector(perp1, Math.cos(ang) * r).addScaledVector(perp2, Math.sin(ang) * r).normalize();
  return out;
}

/**
 * Fire one hitscan ray through the world.
 * world: { colliders, hitMeshes, playerProxy, fx }
 * shooter: { team, isPlayer? }
 * Returns { type: 'wall'|'flesh'|'player'|'miss', point, part?, combatant?, dist }
 */
export function fireRay(world, shooter, origin, dir, weapon, dmgScale = 1, maxDist = 200) {
  const wall = wallHit(world.colliders, origin, dir, maxDist);

  // combatant part meshes
  _raycaster.set(origin, dir);
  _raycaster.far = wall.dist;
  let fleshHit = null;
  const hits = _raycaster.intersectObjects(world.hitMeshes, false);
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
  if (wall.dist < 199) return { type: 'wall', point: wall.point, dist: wall.dist };
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
