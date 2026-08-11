// Character turntable. Hides the arena and lights the fighters neutrally, which is
// how you actually judge a character mesh — inside the pit everything is either in a
// sodium pool or in shadow, and neither tells you whether the model is right.
//
// The camera is the *player's* camera: during a match the player controller owns it
// every frame, so parking a free camera here would just be overwritten.
const g = window.__game;
const T = g.THREE;
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });

g.fight('circuits', 5);
g.step(1 / 60, 20);

const fighters = new Set(g.world.combatants.map((c) => c.group));

// strip the arena back to a neutral studio
for (const child of [...g.scene.children]) {
  if (child.isLight) { child.intensity = 0; continue; }
  if (child === g.camera || fighters.has(child) || child.userData.__studio) continue;
  child.visible = false;
}
g.scene.fog = null;
g.scene.background = new T.Color(0x14161a);

// Sits at the fighters' foot height, not y=0. The arena's colliders are hidden but
// still drive terrain-following, so a fighter standing on the centre slab is at
// y=0.55 and would appear to float above a floor pinned to zero.
const floor = new T.Mesh(
  new T.PlaneGeometry(40, 40),
  new T.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.userData.__studio = true;
g.scene.add(floor);

// three-point studio rig
const key = new T.DirectionalLight(0xfff0dd, 3.0);
key.position.set(5, 7, 7);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -6; key.shadow.camera.right = 6;
key.shadow.camera.top = 6; key.shadow.camera.bottom = -2;
const fill = new T.DirectionalLight(0x9fb6d8, 1.0);
fill.position.set(-6, 3, 5);
const rim = new T.DirectionalLight(0xffffff, 2.2);
rim.position.set(-2, 4, -8);
const amb = new T.AmbientLight(0xffffff, 0.4);
for (const l of [key, fill, rim, amb]) { l.userData.__studio = true; g.scene.add(l); }

// `close` frames a single fighter at review distance; otherwise the whole squad
// lines up. Override with --eval "window.__poseWide = true" for the line-up.
const wide = !!window.__poseWide;
const cast = g.world.combatants.filter((c) => c.alive);
cast.forEach((c, i) => {
  c.pos.set(wide ? -2.7 + i * 1.35 : (i === 0 ? 0 : 40), 0, 0);
  c.yaw = wide ? 0 : -0.6;            // three-quarter view reads a silhouette best
  c.group.position.copy(c.pos);
  c.group.rotation.set(0, c.yaw, 0);
  c.target = null;                    // stop the AI dragging them out of the line
  c.thinkTimer = 999;
});

// The player *is* the camera: stand it back from the line at chest height.
// Player yaw 0 already faces -Z (see src/player.js) — the opposite sign convention
// from combatants, whose `atan2(dx, dz)` makes +Z forward.
g.player.pos.set(0, 0, wide ? 5.0 : 2.4);
g.player.yaw = 0;
g.player.pitch = wide ? -0.06 : -0.12;
g.step(1 / 60, 5);
floor.position.y = cast[0].pos.y;      // now that terrain-follow has settled
g.step(1 / 60, 40);                   // let the clips settle into their blends

console.log('DIAG fighters ' + cast.length
  + ' clips=' + [...cast[0].rig.actions.keys()].join(',')
  + ' locomotion=' + cast.map((c) => c.rig.locomotion?.getClip().name).join('/'));
