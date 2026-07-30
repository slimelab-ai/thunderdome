// The locomotion blendspace, laid out as itself.
//
// Eight fighters in a row, each travelling a different heading while all facing the
// camera — which is exactly the case the blendspace exists for and the one a normal
// match screenshot can never show, because a fighter chasing someone is always
// travelling where he looks. Anything wrong with a strafe or a backpedal is visible
// here and nowhere else.
//
// The rigs are built directly rather than borrowed from the match roster: a roster is
// however many fighters the rank happens to field, and this needs exactly eight.
//
//   node tools/shot.mjs out.png --pose locomotion
//   node tools/shot.mjs out.png --pose locomotion --wait 4000
const g = window.__game;
const T = g.THREE;
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });

g.fight('circuits', 5);
g.step(1 / 60, 20);

// Strip the arena and the match back to an empty studio.
for (const child of [...g.scene.children]) {
  if (child.isLight) { child.intensity = 0; continue; }
  if (child === g.camera) continue;
  child.visible = false;
}
for (const c of g.world.combatants) { c.update = () => {}; c.group.visible = false; }
if (g.player?.vmRoot) g.player.vmRoot.visible = false;
g.scene.fog = null;
g.scene.background = new T.Color(0x171a1f);

const floor = new T.Mesh(
  new T.PlaneGeometry(120, 120),
  new T.MeshStandardMaterial({ color: 0x2c3037, roughness: 0.92 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
g.scene.add(floor);

// A grid, because a foot skating is invisible against a blank floor and unmistakable
// against a reference it can be compared to.
const grid = new T.GridHelper(60, 60, 0x4b535f, 0x3a414a);
grid.position.y = 0.003;
g.scene.add(grid);

const key = new T.DirectionalLight(0xfff2e0, 3.1);
key.position.set(8, 11, 9);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -12; key.shadow.camera.right = 12;
key.shadow.camera.top = 8; key.shadow.camera.bottom = -6;
const fill = new T.DirectionalLight(0x9fb6d8, 1.1);
fill.position.set(-9, 4, 8);
const rim = new T.DirectionalLight(0xffffff, 2.2);
rim.position.set(-3, 5, -11);
for (const l of [key, fill, rim, new T.AmbientLight(0xffffff, 0.5)]) g.scene.add(l);

const params = new URLSearchParams(location.search);
const speed = Number(params.get('gaitSpeed')) || 3.0;
const crouch = params.has('crouched');

// Eight headings, all facing the camera, laid out in the order the blendspace stores
// them: straight ahead first, then round to the left.
const rigs = [];
for (let i = 0; i < 8; i++) {
  const rig = new g.FighterRig({ uniformColor: [0x2b4a2d, 0x3a3550][i % 2], scale: 1 });
  const a = (i / 8) * Math.PI * 2;
  rig.group.position.set(-3.9 + (i % 4) * 2.6, 0, i < 4 ? 2.6 : 0.0);
  g.scene.add(rig.group);
  rigs.push({ rig, mx: Math.sin(a), mz: Math.cos(a) });
}

// Drive the rigs by hand. No AI, no world — whatever this shows is the rig's doing.
let t = 0;
const drive = () => {
  const dt = 1 / 60;
  t += dt;
  for (const { rig, mx, mz } of rigs) {
    rig.setStance(speed, crouch, mx, mz);
    rig.setAimWeight(1);
    // Sweep the aim offset so the upper body is doing something a still frame can
    // read: tracking a target across his front while his legs carry him somewhere
    // else is the whole reason the two layers are separate.
    rig.setAim(Math.sin(t * 0.8) * 0.35, Math.sin(t * 0.55) * 0.6);
    rig.update(dt);
  }
  // The viewmodel is re-shown by the match step every frame, so hide it here.
  if (g.player?.vmRoot) g.player.vmRoot.visible = false;
  requestAnimationFrame(drive);
};
drive();

// The camera rides the player during a match — `freeCam` only applies outside one —
// so park the player instead of trying to take the camera off him.
g.player.pos.set(0, 1.5, 8.2);
g.player.yaw = 0;
g.player.pitch = -0.10;
