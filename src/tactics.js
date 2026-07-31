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
