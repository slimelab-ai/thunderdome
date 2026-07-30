// First-person arms review. Shows the held pose for whichever weapon is selected,
// against a plain backdrop so the hands read rather than the arena.
//
//   --eval "window.__handsWeapon='rifle'"   (before the pose: use --pre style ordering)
//   --eval "window.__game.player.arms.reload(1.8)"  to catch a reload mid-clip
const g = window.__game;
const T = g.THREE;
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });

g.fight('circuits', 8);
g.step(1 / 60, 20);

// Plain backdrop: the arena's own lighting is all pools and shadow, which is exactly
// wrong for judging whether a hand is gripping a handguard.
for (const child of [...g.scene.children]) {
  if (child.isLight) { child.intensity = 0; continue; }
  if (child === g.camera || child.userData.__studio) continue;
  child.visible = false;
}
g.scene.fog = null;
g.scene.background = new T.Color(0x1b1e24);

// The arms face away from the viewer, so world lights backlight them. The review
// light has to ride the camera, the way a real viewmodel fill light does.
const camLight = new T.PointLight(0xfff2e2, 14, 6, 1.6);
camLight.position.set(0.3, 0.15, 0.4);
g.camera.add(camLight);
const rim = new T.PointLight(0x9fb6d8, 6, 5, 1.6);
rim.position.set(-0.6, 0.3, -0.8);
g.camera.add(rim);
const amb = new T.AmbientLight(0xffffff, 0.9);
amb.userData.__studio = true;
g.scene.add(amb);

const p = g.player;
p.pos.set(0, 0, 6);
p.yaw = 0;
p.pitch = 0;

// Give the player the whole armoury so any weapon can be selected for review.
p.slots = ['pistol', 'rifle'];
p.knifeOut = false;
const want = window.__handsWeapon || 'rifle';
if (want === 'knife') p.drawKnife();
else {
  p.slots = [want];
  p.slotIdx = 0;
  p._mountViewmodel();
}
p.mag = p.weapon.mag;

// Let the draw clip finish so this is the held pose, not the swing-up. The draw is
// time-scaled to a second, and the mixer needs to run past its end for the `finished`
// event to hand control back to idle.
g.step(1 / 60, 150);

const vm = p.arms;
console.log('DIAG hands ' + JSON.stringify({
  weapon: p.weapon.id,
  ready: vm.ready,
  socketHasWeapon: !!(vm.socket && vm.heldGroup && vm.heldGroup.parent === vm.socket),
  clip: vm.current ? vm.current.getClip().name : 'idle',
  idleWeight: +vm.idleWeight.toFixed(2),
  pinWeight: +vm.pinWeight.toFixed(2),
  pins: [...vm.pinned.keys()],
}));
