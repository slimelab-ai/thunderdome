// VFX review: fire a burst into a wall, bleed a fighter, and set off a grenade, then
// capture mid-effect. Everything here drives the real emitters through the real call
// sites, so what the frame shows is what a firefight shows.
const g = window.__game;
const T = g.THREE;
document.querySelectorAll('.screen').forEach((n) => { n.style.display = 'none'; });

g.fight('circuits', 8);
g.step(1 / 60, 40);

const p = g.player;
p.pos.set(0, 0, 6);
p.yaw = 0;            // player yaw 0 faces -Z
p.pitch = -0.02;
g.step(1 / 60, 2);

const fx = g.world.fx;
const origin = new T.Vector3(p.pos.x, p.pos.y + 1.55, p.pos.z);
const dir = new T.Vector3(0, -0.04, -1).normalize();

// Wall impacts: sparks, dust and bullet holes across the gate screen ahead.
for (let i = 0; i < 14; i++) {
  const d = dir.clone();
  d.x += (Math.random() - 0.5) * 0.22;
  d.y += (Math.random() - 0.5) * 0.10;
  d.normalize();
  const hit = origin.clone().addScaledVector(d, 4.4);
  fx.sparks(hit, d);
  fx.tracer(origin.clone().addScaledVector(d, 0.5), hit);
}

// Muzzle flash and ejected cases at the player's gun.
const muzzle = new T.Vector3();
p.currentVM.muzzle.getWorldPosition(muzzle);
fx.muzzleFlash(muzzle, dir);
const right = new T.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
for (let i = 0; i < 6; i++) fx.ejectCasing(muzzle, right);

// Blood off a fighter, sprayed along the shot.
const foe = g.world.combatants.find((c) => c.alive);
if (foe) {
  const at = new T.Vector3(foe.pos.x, foe.pos.y + 1.3, foe.pos.z);
  for (let i = 0; i < 3; i++) fx.blood(at, dir);
  fx.bloodPool(foe.pos);
}

// Explosion off to one side, so its smoke column does not cover everything else.
fx.explosion(new T.Vector3(p.pos.x - 3.6, 0.4, p.pos.z - 5.2));

// Advance a little so particles have spread but nothing has died yet.
g.step(1 / 60, 12);

console.log('DIAG vfx ' + JSON.stringify({
  hotLive: fx.hot.state.filter((s) => s.life > 0).length,
  softLive: fx.soft.state.filter((s) => s.life > 0).length,
  decalsVisible: Object.values(fx.decalState).flat().filter((d) => d.life > 0).length,
  casingsLive: fx.casingState.filter((c) => c.life > 0).length,
  tracersVisible: fx.tracers.filter((t) => t.life > 0).length,
}));
