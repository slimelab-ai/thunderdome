// Animation review: one fighter per state, side by side on a neutral studio floor.
//
// Rank 5 (THE HOUNDS OF VRY) is used because its roster is five distinct fighters
// including one shield and one medic. Left to right:
//   idle · crouch · walk · shieldman · death
const g = window.__game;
const T = g.THREE;
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });

g.fight('circuits', 5);
g.step(1 / 60, 20);

const fighters = new Set(g.world.combatants.map((c) => c.group));
for (const child of [...g.scene.children]) {
  if (child.isLight) { child.intensity = 0; continue; }
  if (child === g.camera || fighters.has(child) || child.userData.__studio) continue;
  child.visible = false;
}
g.scene.fog = null;
g.scene.background = new T.Color(0x14161a);

const floor = new T.Mesh(
  new T.PlaneGeometry(60, 60),
  new T.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.userData.__studio = true;
g.scene.add(floor);

const key = new T.DirectionalLight(0xfff0dd, 3.0);
key.position.set(6, 8, 8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -8; key.shadow.camera.right = 8;
key.shadow.camera.top = 8; key.shadow.camera.bottom = -3;
const fill = new T.DirectionalLight(0x9fb6d8, 1.0);
fill.position.set(-7, 3, 6);
const rim = new T.DirectionalLight(0xffffff, 2.0);
rim.position.set(-2, 4, -9);
const amb = new T.AmbientLight(0xffffff, 0.4);
for (const l of [key, fill, rim, amb]) { l.userData.__studio = true; g.scene.add(l); }

// Assign each state to a distinct fighter, shield archetype first so it always gets
// the shield slot. Falling back to `||` on a short roster silently gave one fighter
// two states, which is why an earlier capture showed four figures for five slots.
const pool = g.world.combatants
  .filter((c) => c.alive)
  .sort((a, b) => (b.archetype === 'shield' ? 1 : 0) - (a.archetype === 'shield' ? 1 : 0));
const shieldman = pool.shift();                      // guaranteed to be the shield
const cast = [];
for (const [state, who] of [
  ['idle', pool[0]], ['crouch', pool[1]], ['walk', pool[2]],
  ['shield', shieldman], ['death', pool[3]],
]) {
  if (who && !cast.some(([c]) => c === who)) cast.push([who, state]);
}

cast.forEach(([c, state], i) => {
  c.pos.set(-2.6 + i * 1.3, 0, 0);
  c.yaw = -0.5;
  c.group.position.copy(c.pos);
  c.group.rotation.set(0, c.yaw, 0);
  c.target = null;
  c.thinkTimer = 1e6;
  c.__state = state;
});

// Pin each fighter's stance by overriding setStance on that instance, rather than
// calling it once. Combatant.update calls setStance itself every frame, and the
// capture happens seconds of real render loop later — asserting a stance imperatively
// looks right in a diagnostic taken immediately afterwards and is long gone by the
// time the screenshot is taken.
for (const [c, state] of cast) {
  const orig = c.rig.setStance.bind(c.rig);
  if (state === 'crouch') { c.crouchK = 0.72; c.rig.setStance = () => orig(0, true); }
  else if (state === 'walk') c.rig.setStance = () => orig(1.6, false);
  else if (state === 'death') c.rig.die(1, false);       // sticks: update() returns early
  else c.rig.setStance = () => orig(0, false);
}
for (let f = 0; f < 100; f++) g.step(1 / 60, 1);

g.player.pos.set(0, 0, 4.6);
g.player.yaw = 0;
g.player.pitch = -0.10;
g.step(1 / 60, 2);
floor.position.y = 0;

// Two numbers per fighter, because they answer different questions. `foot` says
// whether he is standing on the floor (the original bug lifted it). `head` says
// whether a crouch actually crouches — in a real crouch the feet stay planted and
// the head is what drops, so foot height alone cannot tell you.
const report = cast.map(([c, state]) => {
  const v = new T.Vector3();
  c.rig.bones.get('foot_l').getWorldPosition(v);
  const foot = v.y - c.pos.y;
  c.rig.bones.get('head').getWorldPosition(v);
  return `${state}[foot=${foot.toFixed(3)} head=${(v.y - c.pos.y).toFixed(3)}]`;
});
console.log('DIAG stances ' + report.join(' '));
