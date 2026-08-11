// First-person combat frame: real match, real fighters, viewmodel in hand.
// The camera is aimed at whichever enemy is actually alive after the opening rush,
// rather than at a fixed heading that a spawn screen might be standing in.
const g = window.__game;
g.fight('circuits', 8);
g.step(1 / 60, 90);

const p = g.player;
p.pos.set(-2, 0, 6);
const foe = g.world.combatants
  .filter((c) => c.team === 'enemy' && c.alive)
  .sort((a, b) => a.pos.distanceTo(p.pos) - b.pos.distanceTo(p.pos))[0];
if (foe) {
  // Player forward is (-sin yaw, -cos yaw): yaw 0 faces -Z, the reverse of the
  // combatant convention. Getting this backwards points the camera at empty floor.
  p.yaw = Math.atan2(-(foe.pos.x - p.pos.x), -(foe.pos.z - p.pos.z));
  const flat = Math.hypot(foe.pos.x - p.pos.x, foe.pos.z - p.pos.z);
  p.pitch = Math.atan2((foe.pos.y + 1.2) - (p.pos.y + 1.6), flat);
}
g.step(1 / 60, 2);
