// The triangle collider that shots, sightlines and leaning all run through.
//
// A BVH is the kind of structure that returns plausible answers when it is subtly
// wrong — an off-by-one in a split leaves a handful of triangles unreachable, and the
// symptom is a bullet through a wall once in a hundred shots, which nobody can
// reproduce. So the important test here is not the hand-worked example: it is the
// randomised comparison against brute force, which is the only thing that can catch a
// triangle the traversal never visits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshCollider } from '../src/meshcollider.js';

/** Two triangles forming an axis-aligned quad on the plane x = px. */
function wallQuad(px, y0, y1, z0, z1) {
  return [
    px, y0, z0, px, y1, z0, px, y1, z1,
    px, y0, z0, px, y1, z1, px, y0, z1,
  ];
}

/** A closed box, as 12 triangles. */
function boxTris(cx, cy, cz, w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d).translate(cx, cy, cz);
  const pos = g.attributes.position;
  const idx = g.index;
  const out = [];
  for (let i = 0; i < idx.count; i++) {
    const v = idx.getX(i);
    out.push(pos.getX(v), pos.getY(v), pos.getZ(v));
  }
  return out;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

test('a ray meets a wall at the wall, not at its bounding box', () => {
  const mc = new MeshCollider(new Float32Array(wallQuad(2, 0, 3, -5, 5)));
  const t = mc.raycast(V(0, 1.5, 0), V(1, 0, 0), 10);
  assert.ok(t !== null, 'missed a wall dead ahead');
  assert.ok(Math.abs(t - 2) < 1e-4, `hit at ${t}, expected 2`);
});

test('a ray that passes the edge of a wall is not stopped by it', () => {
  // The wall spans z −5..5; this one goes by at z = 6.
  const mc = new MeshCollider(new Float32Array(wallQuad(2, 0, 3, -5, 5)));
  assert.equal(mc.raycast(V(0, 1.5, 6), V(1, 0, 0), 10), null);
  // And over the top of it.
  assert.equal(mc.raycast(V(0, 4, 0), V(1, 0, 0), 10), null);
});

test('maxDist is respected', () => {
  const mc = new MeshCollider(new Float32Array(wallQuad(2, 0, 3, -5, 5)));
  assert.equal(mc.raycast(V(0, 1.5, 0), V(1, 0, 0), 1.5), null);
  assert.ok(mc.raycast(V(0, 1.5, 0), V(1, 0, 0), 2.5) !== null);
});

test('the nearest of several surfaces wins', () => {
  const mc = new MeshCollider(new Float32Array([
    ...wallQuad(5, 0, 3, -5, 5),
    ...wallQuad(2, 0, 3, -5, 5),
    ...wallQuad(8, 0, 3, -5, 5),
  ]));
  const t = mc.raycast(V(0, 1.5, 0), V(1, 0, 0), 20);
  assert.ok(Math.abs(t - 2) < 1e-4, `hit at ${t}, expected the nearest wall at 2`);
});

test('blocked() answers sightlines both ways', () => {
  const mc = new MeshCollider(new Float32Array(wallQuad(2, 0, 3, -5, 5)));
  assert.equal(mc.blocked(V(0, 1.5, 0), V(4, 1.5, 0)), true);
  assert.equal(mc.blocked(V(0, 1.5, 6), V(4, 1.5, 6)), false, 'past the end of the wall');
  // A segment that stops short of the wall is not blocked by it.
  assert.equal(mc.blocked(V(0, 1.5, 0), V(1.5, 1.5, 0)), false);
});

test('a target standing flush against a wall is still visible', () => {
  // The chest point of someone hugging cover sits a couple of centimetres off the
  // surface. Without the end slack the wall they are leaning on blocks the sightline
  // to them, and nobody in cover can ever be shot.
  const mc = new MeshCollider(new Float32Array(wallQuad(2, 0, 3, -5, 5)));
  assert.equal(mc.blocked(V(0, 1.5, 0), V(1.97, 1.5, 0)), false, 'flush against the wall');
  // But the wall still blocks anything genuinely on the far side of it.
  assert.equal(mc.blocked(V(0, 1.5, 0), V(2.5, 1.5, 0)), true, 'through the wall');
  // And the slack is only at the far end: a wall right in front of the shooter blocks.
  assert.equal(mc.blocked(V(1.95, 1.5, 0), V(6, 1.5, 0)), true, 'muzzle against the wall');
});

test('a hit is found from inside a closed box, not missed', () => {
  const mc = new MeshCollider(new Float32Array(boxTris(0, 1, 0, 2, 2, 2)));
  // Standing in the middle, firing out: the far face is 1 m away.
  const t = mc.raycast(V(0, 1, 0), V(1, 0, 0), 5);
  assert.ok(t !== null && Math.abs(t - 1) < 1e-4, `got ${t}, expected 1`);
});

test('geometry wound inward still stops a ray', () => {
  // Reversed winding: a one-sided test would let everything through.
  const q = wallQuad(2, 0, 3, -5, 5);
  const flipped = [];
  for (let i = 0; i < q.length; i += 9) {
    flipped.push(q[i], q[i + 1], q[i + 2], q[i + 6], q[i + 7], q[i + 8], q[i + 3], q[i + 4], q[i + 5]);
  }
  const mc = new MeshCollider(new Float32Array(flipped));
  assert.ok(mc.raycast(V(0, 1.5, 0), V(1, 0, 0), 10) !== null);
});

test('an empty collider is inert rather than broken', () => {
  const mc = new MeshCollider(new Float32Array(0));
  assert.equal(mc.raycast(V(0, 0, 0), V(1, 0, 0), 10), null);
  assert.equal(mc.blocked(V(0, 0, 0), V(1, 0, 0)), false);
});

test('the hierarchy reaches every triangle: 400 random rays against brute force', () => {
  // Enough boxes, scattered widely enough, to force a deep tree with both crowded and
  // empty regions — the shape that a midpoint split handles badly and the shape an
  // arena actually is.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const tris = [];
  for (let i = 0; i < 90; i++) {
    const cluster = i < 60 ? 4 : 40;          // most packed together, some far out
    tris.push(...boxTris(
      (rnd() - 0.5) * cluster, rnd() * 3, (rnd() - 0.5) * cluster,
      0.4 + rnd() * 2, 0.4 + rnd() * 3, 0.4 + rnd() * 2,
    ));
  }
  const data = new Float32Array(tris);
  const mc = new MeshCollider(data);
  assert.ok(mc.count > 1000, `only ${mc.count} triangles, not enough to exercise the tree`);

  // Brute force: every triangle, no hierarchy.
  const flat = new MeshCollider(data);
  const brute = (o, d, max) => {
    let best = max;
    for (let i = 0; i < flat.count; i++) {
      const t = flat._tri(i, o.x, o.y, o.z, d.x, d.y, d.z, best);
      if (t >= 0 && t < best) best = t;
    }
    return best < max ? best : null;
  };

  let checked = 0;
  for (let i = 0; i < 400; i++) {
    // Fire from a ring toward a point in the crowded middle, so most rays cross real
    // geometry. Random directions from random origins mostly sail off into nothing and
    // prove very little.
    const ang = rnd() * Math.PI * 2, r = 12 + rnd() * 14;
    const o = V(Math.cos(ang) * r, rnd() * 4, Math.sin(ang) * r);
    const aim = V((rnd() - 0.5) * 8, rnd() * 3, (rnd() - 0.5) * 8);
    const d = aim.sub(o).normalize();
    const a = mc.raycast(o, d, 100);
    const b = brute(o, d, 100);
    if (a === null || b === null) {
      assert.equal(a === null, b === null,
        `ray ${i} disagrees: hierarchy ${a}, brute force ${b}`);
    } else {
      assert.ok(Math.abs(a - b) < 1e-3, `ray ${i} hit at ${a}, brute force says ${b}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} rays actually hit anything; the test proved little`);
});
