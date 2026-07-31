// The player's hit volume.
//
// This is the one piece of combat geometry with no visible representation — there is
// no third-person player model to look at — so it can be wrong indefinitely without
// anybody noticing. It was: the resolver marched the ray in 0.35 m steps against a
// head band 0.22 m tall, so whether a headshot registered came down to where the
// samples happened to land. Mostly they landed either side of it.
//
// These tests fire rays at known parts of a known body and assert what comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  rayVsCapsule, rayVsPlayer, PLAYER_HITBOX, setPlayerFacing, playerAimPoint, hasLoS,
} from '../src/combat.js';

const H = PLAYER_HITBOX;

/** A player standing at the origin, facing -Z, optionally leaning and/or crouched. */
function proxy({ lean = 0, crouch = false, x = 0, z = 0 } = {}) {
  setPlayerFacing(new THREE.Vector3(0, 0, -1));
  return {
    pos: new THREE.Vector3(x, 0, z),
    heightScale: crouch ? 0.75 : 1,
    // Leaning to his right, which facing -Z means -X.
    leanX: -lean, leanZ: 0, alive: true,
  };
}

/** Fire horizontally from `from` at height `y`, straight along +Z toward the body. */
function shootAt(pp, y, { fromZ = 6, offsetX = 0 } = {}) {
  const origin = new THREE.Vector3(offsetX, y, fromZ);
  const dir = new THREE.Vector3(0, 0, -1);
  return rayVsPlayer(origin, dir, pp, 50);
}

test('a shot at head height hits the head, every time', () => {
  const pp = proxy();
  // Sweep the whole head, not one lucky height. The marching resolver passed a
  // single-sample version of this test and failed most of the sweep.
  for (let y = H.headY - H.headRadius * 0.7; y <= H.headY + H.headRadius * 0.7; y += 0.01) {
    const hit = shootAt(pp, y);
    assert.ok(hit, `no hit at y=${y.toFixed(3)}`);
    assert.equal(hit.part, 'head', `y=${y.toFixed(3)} reported ${hit.part}`);
  }
});

test('chest height is a torso hit and knee height is a leg hit', () => {
  const pp = proxy();
  assert.equal(shootAt(pp, 1.20).part, 'torso');
  assert.equal(shootAt(pp, 0.45).part, 'legR');
});

test('the outboard edge of the torso is an arm, and the side is the right side', () => {
  const pp = proxy();
  // Facing -Z with +Y up, his right hand points along +X.
  const right = shootAt(pp, 1.20, { offsetX: H.bodyRadius * 0.85 });
  const left = shootAt(pp, 1.20, { offsetX: -H.bodyRadius * 0.85 });
  assert.equal(right.part, 'armR');
  assert.equal(left.part, 'armL');
});

test('nothing above the scalp or below the boots connects', () => {
  const pp = proxy();
  assert.equal(shootAt(pp, H.height + 0.05), null);
  assert.equal(shootAt(pp, -0.05), null);
});

test('crouching lowers the whole volume, head included', () => {
  const standing = proxy();
  const crouched = proxy({ crouch: true });
  assert.equal(shootAt(standing, H.headY).part, 'head');
  // The standing head line now passes over a crouched player entirely.
  assert.equal(shootAt(crouched, H.headY), null);
  assert.equal(shootAt(crouched, H.headY * 0.75).part, 'head');
});

test('a lean pivots about the feet: the head swings out, the boots stay put', () => {
  const pp = proxy({ lean: 0.5 });
  // The head has moved most of the way; a shot down the old centre line misses it.
  assert.equal(shootAt(pp, H.headY), null);
  const swung = shootAt(pp, H.headY, { offsetX: -0.5 * (H.headY / H.height) });
  assert.ok(swung, 'the leaned head is not where the tilt says it is');
  assert.equal(swung.part, 'head');
  // The boots have barely moved: still hittable on the original centre line.
  const feet = shootAt(pp, 0.45);
  assert.ok(feet, 'leaning teleported the legs out of cover');
  assert.match(feet.part, /^leg/);
});

test('the near intersection is returned, not whichever surface is checked first', () => {
  const pp = proxy();
  const hit = shootAt(pp, 1.20, { fromZ: 6 });
  // Front of the body: 6 m minus the body radius, give or take the capsule curve.
  assert.ok(Math.abs(hit.dist - (6 - H.bodyRadius)) < 0.02,
    `entered at ${hit.dist.toFixed(3)} m, expected ~${(6 - H.bodyRadius).toFixed(3)}`);
});

test('rayVsCapsule reports position along its own axis', () => {
  const a = new THREE.Vector3(0, 0, 0);
  const b = new THREE.Vector3(0, 2, 0);
  const dir = new THREE.Vector3(0, 0, -1);
  const low = rayVsCapsule(new THREE.Vector3(0, 0.5, 5), dir, a, b, 0.3, 50);
  const high = rayVsCapsule(new THREE.Vector3(0, 1.5, 5), dir, a, b, 0.3, 50);
  assert.ok(Math.abs(low.t - 0.25) < 1e-6, `t=${low.t}`);
  assert.ok(Math.abs(high.t - 0.75) < 1e-6, `t=${high.t}`);
});

test('a shot that only clips the top of the skull still counts', () => {
  const pp = proxy();
  // Grazing the cap well above where any cylinder would reach.
  const hit = shootAt(pp, H.headY + H.headRadius * 0.9);
  assert.ok(hit, 'the head cap is not being tested');
  assert.equal(hit.part, 'head');
});

test('a ray pointing away from the player never hits him', () => {
  const pp = proxy();
  const hit = rayVsPlayer(new THREE.Vector3(0, 1.2, 6), new THREE.Vector3(0, 0, 1), pp, 50);
  assert.equal(hit, null);
});

test('maxDist is respected, so cover in front of the player still stops a round', () => {
  const pp = proxy();
  const origin = new THREE.Vector3(0, 1.2, 6);
  const dir = new THREE.Vector3(0, 0, -1);
  assert.ok(rayVsPlayer(origin, dir, pp, 50));
  assert.equal(rayVsPlayer(origin, dir, pp, 3), null);
});

// ---- where the AI decides to aim ----
//
// The scenario the hit model exists for: a player peeking a corner, chest behind the
// wall, head out past it. Testing it live is impractical (it needs a specific bit of
// arena geometry to happen under a specific bot), so the decision lives in combat.js
// as a function over colliders and gets a wall built for it here.

/** The smallest thing `hasLoS` will accept: an axis-aligned box that can be hit. */
function wall(minX, minY, minZ, maxX, maxY, maxZ) {
  return {
    raycast(from, dir) {
      let t0 = 0, t1 = Infinity;
      for (const [o, d, lo, hi] of [
        [from.x, dir.x, minX, maxX], [from.y, dir.y, minY, maxY], [from.z, dir.z, minZ, maxZ],
      ]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
        let a = (lo - o) / d, b = (hi - o) / d;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) return null;
      }
      return t0;
    },
  };
}

test('with nothing in the way, the AI aims at the chest', () => {
  const pp = proxy();
  const from = new THREE.Vector3(0, 1.5, 8);
  const aim = playerAimPoint([], from, pp);
  assert.ok(Math.abs(aim.y - 1.15) < 1e-6, `aimed at y=${aim.y}`);
});

test('a player peeking a corner gets shot in the face', () => {
  // Leaning hard to his right, which facing -Z puts at -X.
  const pp = proxy({ lean: 0.55 });
  const from = new THREE.Vector3(0, 1.5, 8);
  // A wall covering the chest line but not the swung-out head. The head sits at
  // x = -0.55 * (1.57/1.73) = -0.50; the chest at -0.55 * (1.15/1.73) = -0.37.
  const cover = [wall(-0.44, 0, 1.5, 4, 1.45, 2.5)];
  const chest = new THREE.Vector3(pp.pos.x + pp.leanX * (1.15 / H.height), 1.15, pp.pos.z);
  assert.equal(hasLoS(cover, from, chest), false, 'the test wall does not cover the chest');

  const aim = playerAimPoint(cover, from, pp);
  assert.ok(aim.y > 1.4, `aimed at y=${aim.y.toFixed(2)}, expected the head`);
  assert.ok(Math.abs(aim.x - pp.leanX * (H.headY / H.height)) < 1e-6,
    'the aim point does not track the lean the hit model applies');
});

test('the aim point and the hit model agree about where the player is', () => {
  // Whatever the AI aims at must be something its own bullets can hit, or fighters
  // shoot at a point that is not him.
  for (const lean of [0, 0.3, -0.55]) {
    const pp = proxy({ lean: -lean });
    const from = new THREE.Vector3(0, 1.5, 8);
    const aim = playerAimPoint([], from, pp);
    const dir = aim.clone().sub(from).normalize();
    const hit = rayVsPlayer(from, dir, pp, 50);
    assert.ok(hit, `lean ${lean}: aiming where the AI aims misses the player entirely`);
  }
});

test('with the player fully behind cover the aim falls back to the chest', () => {
  const pp = proxy();
  const from = new THREE.Vector3(0, 1.5, 8);
  const cover = [wall(-4, 0, 1.5, 4, 3, 2.5)];
  const aim = playerAimPoint(cover, from, pp);
  assert.ok(Math.abs(aim.y - 1.15) < 1e-6, 'should fall back to the chest, not stay at the head');
});

test('the head hitbox sits on the camera, so seeing is being seen', () => {
  // The invariant the whole peek case rests on: if the player can see a point, that
  // point can shoot him in the head. Deriving the head from a lean fraction instead
  // put it 5 cm short of where he was peeking from — which around a tight corner is
  // the difference between a sightline and a wall.
  const pp = proxy({ lean: 0.55 });
  pp.eye = new THREE.Vector3(0.42, 1.51, 0);      // leaned out and dropped, as the camera does
  const from = new THREE.Vector3(3, 1.5, 8);
  const dir = pp.eye.clone().sub(from).normalize();
  const hit = rayVsPlayer(from, dir, pp, 50);
  assert.ok(hit, 'a ray straight down the sightline misses him entirely');
  assert.equal(hit.part, 'head');
});

test('the AI aims at the camera when only the head is exposed', () => {
  const pp = proxy({ lean: 0.55 });
  pp.eye = new THREE.Vector3(0.42, 1.51, 0);
  const from = new THREE.Vector3(3, 1.5, 8);
  // Cover across everything below the eye.
  const cover = [wall(-4, 0, 0.4, 4, 1.42, 1.2)];
  const aim = playerAimPoint(cover, from, pp);
  assert.ok(aim.distanceTo(pp.eye) < 1e-6, `aimed at ${aim.toArray()}, expected the camera`);
});

test('the body still hangs off the camera, so the legs stay behind cover', () => {
  const pp = proxy({ lean: 0.55 });
  pp.eye = new THREE.Vector3(0.42, 1.51, 0);
  // Chest is partway out along the axis from the boots to the eye.
  const chest = playerAimPoint([], new THREE.Vector3(0, 1.5, 8), pp);
  assert.ok(chest.x > 0 && chest.x < pp.eye.x, `chest x=${chest.x.toFixed(2)} is not between boots and eye`);
  // Boots have not moved.
  const feet = shootAt(pp, 0.45);
  assert.ok(feet, 'the legs left the ground');
  assert.match(feet.part, /^leg/);
});
