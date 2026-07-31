// Every weapon, aimed. One row hip, one row down the sights.
//
//   node tools/shot.mjs out.png --pose ads
//   node tools/shot.mjs out.png --pose ads --url "http://localhost:5173/?weapon=dmr"
const g = window.__game;
document.querySelectorAll('.screen, #hud').forEach((n) => { n.style.display = 'none'; });
const params = new URLSearchParams(location.search);
const id = params.get('weapon') || 'rifle';

g.sandbox(['pistol', 'smg', 'shotgun', 'rifle', 'dmr']);
g.step(1 / 60, 30);
const p = g.player;
p.alive = true; p.hp = p.maxHp; g.setLocked(true);
p.slots = [id]; p.slotIdx = 0; p.knifeOut = false;
p._mountViewmodel();
p.mag = p.weapon.mag;
g.step(1 / 60, 160);
// The capture free-runs after this, and the live tick calls `input.update`, which
// rewrites `adsHeld` from the real mouse every frame. Holding it here is the only way
// the weapon is still up when the shutter opens.
const wantAds = !params.has('hip');
const hold = () => { p.adsHeld = wantAds; p.mag = p.weapon.mag; requestAnimationFrame(hold); };
hold();
g.step(1 / 60, 90);

// Something to aim at, dead centre, so the sight picture can be judged against a
// target rather than against empty floor.
const T = g.THREE;
const dir = new T.Vector3();
g.camera.getWorldDirection(dir);
const mark = new T.Mesh(
  new T.SphereGeometry(0.12, 16, 12),
  new T.MeshBasicMaterial({ color: 0xff3020 }),
);
mark.position.copy(g.camera.position).addScaledVector(dir, 12);
g.scene.add(mark);
