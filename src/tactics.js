const BREACH_LANES = [0, -1, 1, -2, 2];

export function coordinatedBreachLane(squad, fighter) {
  const ordered = [...squad].sort((a, b) => {
    const supportA = a.role === 'support' ? 0 : 1;
    const supportB = b.role === 'support' ? 0 : 1;
    return supportA - supportB || (a.navSeed || 0) - (b.navSeed || 0);
  });
  const index = ordered.indexOf(fighter);
  if (index < 0) return 0;
  if (index < BREACH_LANES.length) return BREACH_LANES[index];
  const magnitude = 3 + Math.floor((index - BREACH_LANES.length) / 2);
  return index % 2 ? -magnitude : magnitude;
}

export function offsetBreachGoal(target, attacker, lane, {
  innerWidth = 5,
  outerStep = 3,
  xLimit = 20,
  zLimit = 14.5,
} = {}) {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const distance = Math.hypot(dx, dz) || 1;
  const fx = dx / distance;
  const fz = dz / distance;
  const width = lane === 0 ? 0 : Math.sign(lane) *
    (innerWidth + Math.max(0, Math.abs(lane) - 1) * outerStep);
  return {
    x: Math.max(-xLimit, Math.min(xLimit, target.x + -fz * width)),
    y: target.y || 0,
    z: Math.max(-zLimit, Math.min(zLimit, target.z + fx * width)),
  };
}

export function shouldSprintAtTarget({ sight, melee = false, distance = 0, legDamage = 0 }) {
  if (legDamage >= 0.6) return false;
  if (melee) return distance > 3;
  return !sight;
}

/**
 * Where to look next, having arrived at a last-known position and found nobody.
 *
 * Ordered the way a fighter clearing a room actually works it: push through the
 * point first, in case they kept going; then the cover either side of it, which is
 * where somebody who stopped would be; then back toward the approach, in case they
 * slipped past. Offsets are relative to the direction the searcher came *from*, so
 * the pattern is oriented to the fight rather than to the world axes.
 *
 * Crucially finite. A bot that probes forever is a bot that never loses you, which
 * is the omniscience this whole system exists to remove — when the list runs out,
 * the contact goes with it.
 */
const SEARCH_PATTERN = [
  { forward: 1.0, lateral: 0 },
  { forward: 0.15, lateral: -1 },
  { forward: 0.15, lateral: 1 },
  { forward: -0.7, lateral: -0.7 },
  { forward: -0.7, lateral: 0.7 },
];

export const SEARCH_PROBES = SEARCH_PATTERN.length;

export function searchProbe(lastKnown, searcher, radius, index, {
  minRadius = 2.5,
  maxRadius = 9,
  xLimit = 20,
  zLimit = 14.5,
} = {}) {
  const step = SEARCH_PATTERN[Math.max(0, Math.min(index, SEARCH_PATTERN.length - 1))];
  const dx = lastKnown.x - searcher.x;
  const dz = lastKnown.z - searcher.z;
  const distance = Math.hypot(dx, dz) || 1;
  const fx = dx / distance;
  const fz = dz / distance;
  const r = Math.max(minRadius, Math.min(radius, maxRadius));
  const x = lastKnown.x + fx * step.forward * r + -fz * step.lateral * r;
  const z = lastKnown.z + fz * step.forward * r + fx * step.lateral * r;
  return {
    x: Math.max(-xLimit, Math.min(xLimit, x)),
    y: lastKnown.y || 0,
    z: Math.max(-zLimit, Math.min(zLimit, z)),
  };
}
