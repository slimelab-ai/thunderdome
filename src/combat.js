import * as THREE from 'three';

export const PART_MULT = { head: 3.2, torso: 1.0, armL: 0.6, armR: 0.6, legL: 0.6, legR: 0.6 };

const _v = new THREE.Vector3();
const _leanFeet = new THREE.Vector3();
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
export function rayVsCapsule(origin, dir, feet, height, radius, maxDist) {
  const step = 0.35;
  const p = new THREE.Vector3().copy(origin);
  for (let d = 0; d < maxDist; d += step) {
    p.copy(origin).addScaledVector(dir, d);
    const dx = p.x - feet.x, dz = p.z - feet.z;
    if (dx * dx + dz * dz < radius * radius && p.y > feet.y && p.y < feet.y + height) {
      return { dist: d, point: p.clone(), yRel: p.y - feet.y };
    }
  }
  return null;
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

  // player capsule (only hostile shots) — leaning shifts the exposed capsule sideways
  let playerHit = null;
  const pp = world.playerProxy;
  if (shooter.team !== 'player' && pp.alive) {
    _leanFeet.set(pp.pos.x + (pp.leanX || 0), pp.pos.y, pp.pos.z + (pp.leanZ || 0));
    const cap = rayVsCapsule(origin, dir, _leanFeet, 1.7 * pp.heightScale, 0.38, Math.min(wall.dist, fleshHit ? fleshHit.dist : wall.dist));
    if (cap) {
      let part;
      const y = cap.yRel / pp.heightScale;
      if (y > 1.48) part = 'head';
      else if (y > 0.85) part = Math.random() < 0.28 ? (Math.random() < 0.5 ? 'armL' : 'armR') : 'torso';
      else part = Math.random() < 0.5 ? 'legL' : 'legR';
      playerHit = { part, point: cap.point, dist: cap.dist };
    }
  }

  // resolve nearest
  const gMult = world.globalDmgMult || 1; // BLOOD RULES etc.
  if (playerHit && (!fleshHit || playerHit.dist < fleshHit.dist)) {
    const dmg = computeDamage(weapon, playerHit.part, playerHit.dist) * dmgScale * gMult;
    world.onPlayerDamaged(dmg, playerHit.part, origin);
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
