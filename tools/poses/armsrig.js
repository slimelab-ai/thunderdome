// Third-person view of the first-person arms.
//
// Judging arm topology from inside the viewmodel does not work: from the player's own
// eyes the two forearms overlap in screen space no matter how they are routed, so a
// crossed-over arm and a correct one look similar. This lifts the whole viewmodel out
// of the camera and puts it in the world, seen from the side and slightly above,
// where the path each arm takes is unambiguous.
//
//   --pre "window.__handsWeapon='pistol'; window.__rigView='side'"   (side | front | top)
const g = window.__game;
const T = g.THREE;
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });

g.fight('circuits', 8);
g.step(1 / 60, 20);

for (const child of [...g.scene.children]) {
  if (child.isLight) { child.intensity = 0; continue; }
  if (child === g.camera || child.userData.__studio) continue;
  child.visible = false;
}
g.scene.fog = null;
g.scene.background = new T.Color(0x20242b);

const p = g.player;
const want = window.__handsWeapon || 'pistol';
if (want === 'knife') p.drawKnife();
else { p.slots = [want]; p.slotIdx = 0; p.knifeOut = false; p._mountViewmodel(); }
p.mag = p.weapon.mag;
g.step(1 / 60, 150);            // let the draw finish and the grip pins settle

// Lift the viewmodel out of the camera and pin it in the world. Freezing its matrix
// is what stops Player.update's hip/ADS lerp from moving it back every frame.
const rig = p.vmRoot;
g.scene.add(rig);
rig.position.set(0, 1.2, 0);
rig.rotation.set(0, 0, 0);
rig.scale.setScalar(1);
rig.updateMatrix();
rig.matrixAutoUpdate = false;

const studio = new T.Group();
studio.userData.__studio = true;
const key = new T.DirectionalLight(0xfff2e2, 3.0);
key.position.set(2, 3, 2);
const fill = new T.DirectionalLight(0x9fb6d8, 1.2);
fill.position.set(-2, 1, 2);
studio.add(key, fill, new T.AmbientLight(0xffffff, 1.6));
g.scene.add(studio);

// A floor grid gives the eye a reference for depth.
const grid = new T.GridHelper(4, 16, 0x3a4048, 0x2a2f36);
grid.position.y = 0.6;
grid.userData.__studio = true;
g.scene.add(grid);

// Aim the *player* at the rig, not `freeCam`: during a match the player controller
// rewrites the camera every frame, so a parked free camera is gone by capture time.
const VIEWS = {
  side:  { pos: [1.15, -0.30], look: [0, -0.28] },
  front: { pos: [0.05, -1.35], look: [0, -0.25] },
  top:   { pos: [0.30, -0.32], look: [0, -0.30], pitch: -1.15 },
};
const view = VIEWS[window.__rigView || 'side'];
const eye = 1.62;
p.pos.set(view.pos[0], 0, view.pos[1]);
p.yaw = Math.atan2(-(view.look[0] - view.pos[0]), -(view.look[1] - view.pos[1]));
const flat = Math.hypot(view.look[0] - view.pos[0], view.look[1] - view.pos[1]);
p.pitch = view.pitch ?? Math.atan2(1.18 - eye, flat);
g.step(1 / 60, 2);

// Report the arm paths in the rig's own space, sampled along each forearm rather than
// only at the elbow — a forearm can sweep across its opposite number while both
// endpoints stay on their own side.
const inv = new T.Matrix4().copy(rig.matrixWorld).invert();
const local = (o, x = 0, y = 0, z = 0) => {
  const v = new T.Vector3(x, y, z);
  o.localToWorld(v);
  return v.applyMatrix4(inv);
};
const vm = p.arms;
const HAND_LEN = 0.123;
const fistL = local(vm.bones.get('hand_l'), 0, HAND_LEN, 0);
const fistR = local(vm.bones.get('hand_r'), 0, HAND_LEN, 0);
const wristL = local(vm.bones.get('hand_l'));
const wristR = local(vm.bones.get('hand_r'));
const elbowL = local(vm.bones.get('forearm_l'));
const elbowR = local(vm.bones.get('forearm_r'));
// Sample the forearms: left must stay left of right along the whole segment.
let worst = -Infinity;
for (let t = 0; t <= 1.001; t += 0.1) {
  const l = elbowL.clone().lerp(wristL, t);
  const r = elbowR.clone().lerp(wristR, t);
  worst = Math.max(worst, l.x - r.x);
}
console.log('DIAG rig ' + JSON.stringify({
  weapon: p.weapon.id,
  fistGap: +fistL.distanceTo(fistR).toFixed(3),
  wristGapX: +(wristR.x - wristL.x).toFixed(3),
  worstForearmOverlap: +worst.toFixed(3),
  // `crossed` is only meaningful when both hands grip the *same* place. On a rifle or
  // shotgun the hands are legitimately far apart along the weapon, so the forearms
  // converge from opposite sides and this sampling flags a perfectly correct pose.
  crossed: fistL.distanceTo(fistR) < 0.15 ? worst > -0.01 : 'n/a (hands apart)',
}));
