import * as THREE from 'three';

/**
 * Triangle-accurate collision for everything that fires a ray.
 *
 * The arena used to answer every ray query with hand-authored boxes, one per prop.
 * That is fine for deciding whether a fighter can walk somewhere and wrong for
 * everything a player can see. A box around a car is the height of its cabin along
 * the whole length, so shots lined up over the bonnet died in mid-air; a box around a
 * capped wall is 18 cm proud of the wall, so leaning out from a corner clamps early
 * and a round grazing the edge stops before it reaches the edge. Tuning the boxes
 * closer only moves the error around — the geometry is not box-shaped, and the player
 * is close enough to it to notice.
 *
 * So rays run against the real triangles. Movement keeps the boxes: a swept capsule
 * against a simplified hull is the right tool for locomotion, its failure mode is a
 * wall that feels a couple of centimetres thick, and nobody can see that. What they
 * can see is where their bullets go.
 *
 * The structure is a bounding-volume hierarchy over triangle centroids, split on the
 * widest axis at the median. Flat typed arrays throughout: the LOS query runs several
 * times per fighter per frame and this must not allocate.
 */

const _v = new THREE.Vector3();

const LEAF_SIZE = 8;          // triangles per leaf; below this, splitting costs more than it saves
const EPS = 1e-7;

export class MeshCollider {
  /**
   * @param {Float32Array} tris flat world-space triangles, 9 floats each
   */
  constructor(tris) {
    this.tris = tris;
    this.count = tris.length / 9;
    // index[i] is the triangle sitting at slot i; the build permutes this rather than
    // the (much larger) vertex data.
    this.index = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) this.index[i] = i;

    // Centroids, precomputed: the split needs them on every level.
    this.cent = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const o = i * 9;
      this.cent[i * 3] = (tris[o] + tris[o + 3] + tris[o + 6]) / 3;
      this.cent[i * 3 + 1] = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3;
      this.cent[i * 3 + 2] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
    }

    // Nodes: [minx,miny,minz, maxx,maxy,maxz, leftOrStart, countOrZero] per node.
    // countOrZero > 0 marks a leaf. A binary tree over N leaves has < 2N nodes.
    const maxNodes = Math.max(1, 2 * Math.ceil(this.count / LEAF_SIZE) + 1) * 2;
    this.nodes = new Float32Array(maxNodes * 8);
    this.nodeCount = 0;
    if (this.count) this._build(0, this.count);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(this.nodes[0], this.nodes[1], this.nodes[2]),
      new THREE.Vector3(this.nodes[3], this.nodes[4], this.nodes[5]),
    );
  }

  _build(start, end) {
    const node = this.nodeCount++;
    const b = node * 8;
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = start; i < end; i++) {
      const o = this.index[i] * 9;
      for (let k = 0; k < 9; k += 3) {
        const x = this.tris[o + k], y = this.tris[o + k + 1], z = this.tris[o + k + 2];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
      }
    }
    this.nodes[b] = minx; this.nodes[b + 1] = miny; this.nodes[b + 2] = minz;
    this.nodes[b + 3] = maxx; this.nodes[b + 4] = maxy; this.nodes[b + 5] = maxz;

    const n = end - start;
    if (n <= LEAF_SIZE) {
      this.nodes[b + 6] = start;
      this.nodes[b + 7] = n;               // > 0 ⇒ leaf
      return node;
    }

    // Split on the widest axis of the centroid spread, at the median. Median rather
    // than the midpoint so a dense cluster beside a sparse one still divides evenly —
    // an arena is exactly that shape, a few crowded props in a lot of empty floor.
    const ax = maxx - minx, ay = maxy - miny, az = maxz - minz;
    const axis = ax > ay ? (ax > az ? 0 : 2) : (ay > az ? 1 : 2);
    const mid = (start + end) >> 1;
    this._nth(start, end, mid, axis);

    this.nodes[b + 7] = 0;                 // interior
    this._build(start, mid);               // left child is always the next node
    this.nodes[b + 6] = this._build(mid, end);
    return node;
  }

  /** Quickselect on `index` so slot `nth` holds the median centroid on `axis`. */
  _nth(start, end, nth, axis) {
    let lo = start, hi = end - 1;
    while (lo < hi) {
      const pivot = this.cent[this.index[(lo + hi) >> 1] * 3 + axis];
      let i = lo, j = hi;
      while (i <= j) {
        while (this.cent[this.index[i] * 3 + axis] < pivot) i++;
        while (this.cent[this.index[j] * 3 + axis] > pivot) j--;
        if (i <= j) {
          const t = this.index[i]; this.index[i] = this.index[j]; this.index[j] = t;
          i++; j--;
        }
      }
      if (nth <= j) hi = j;
      else if (nth >= i) lo = i;
      else break;
    }
  }

  /** Slab test against a node's box. Returns entry distance, or Infinity for a miss. */
  _slab(b, ox, oy, oz, ix, iy, iz, maxT) {
    let t0 = (this.nodes[b] - ox) * ix, t1 = (this.nodes[b + 3] - ox) * ix;
    let tmin = t0 < t1 ? t0 : t1, tmax = t0 < t1 ? t1 : t0;
    t0 = (this.nodes[b + 1] - oy) * iy; t1 = (this.nodes[b + 4] - oy) * iy;
    const ymin = t0 < t1 ? t0 : t1, ymax = t0 < t1 ? t1 : t0;
    if (ymin > tmin) tmin = ymin;
    if (ymax < tmax) tmax = ymax;
    t0 = (this.nodes[b + 2] - oz) * iz; t1 = (this.nodes[b + 5] - oz) * iz;
    const zmin = t0 < t1 ? t0 : t1, zmax = t0 < t1 ? t1 : t0;
    if (zmin > tmin) tmin = zmin;
    if (zmax < tmax) tmax = zmax;
    if (tmax < 0 || tmin > tmax || tmin > maxT) return Infinity;
    return tmin > 0 ? tmin : 0;
  }

  /**
   * Möller–Trumbore. Returns t along the ray, or -1.
   *
   * Scalars rather than Vector3s throughout. This is the innermost loop of every
   * sightline in the game — a few hundred calls per query, tens of queries per frame —
   * and going through Vector3's methods for the cross products cost about four times
   * what the arithmetic does.
   *
   * Double-sided on purpose: arena geometry is not reliably wound outward, and a
   * one-sided test would let rounds through anything modelled inside-out.
   */
  _tri(i, ox, oy, oz, dx, dy, dz, maxT) {
    const t = this.tris;
    const o = this.index[i] * 9;
    const ax = t[o], ay = t[o + 1], az = t[o + 2];
    const e1x = t[o + 3] - ax, e1y = t[o + 4] - ay, e1z = t[o + 5] - az;
    const e2x = t[o + 6] - ax, e2y = t[o + 7] - ay, e2z = t[o + 8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -EPS && det < EPS) return -1;
    const inv = 1 / det;
    const sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return (hit > EPS && hit <= maxT) ? hit : -1;
  }

  /**
   * Nearest hit along a ray. `dir` must be normalised.
   * Returns the distance, or `null` for a clear ray — matching `Collider.raycast`, so
   * a MeshCollider can stand in wherever one of those does.
   *
   * `outNormal`, when given, receives the hit triangle's geometric normal —
   * unoriented, since the mesh is tested double-sided; callers that care which way
   * it faces orient it against the ray themselves. Costs one cross product, and
   * only on a hit.
   */
  raycast(origin, dir, maxDist = Infinity, outNormal = null) {
    if (!this.count) return null;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    let best = maxDist;
    let bestTri = -1;
    const stack = _stack;
    let sp = 0;
    stack[sp++] = 0;
    _stackT[0] = 0;
    while (sp) {
      const node = stack[--sp];
      // The entry distance was computed when this node was queued and is carried with
      // it. `best` may have tightened since, and if the whole node now sits beyond it
      // there is nothing here worth opening — no second slab test needed to know that.
      if (_stackT[sp] >= best) continue;
      const b = node * 8;
      const n = this.nodes[b + 7];
      if (n > 0) {
        const start = this.nodes[b + 6];
        for (let i = start; i < start + n; i++) {
          const t = this._tri(i, ox, oy, oz, dx, dy, dz, best);
          if (t >= 0 && t < best) { best = t; bestTri = i; }
        }
      } else {
        // Nearest child first, so `best` shrinks as early as possible and the far
        // subtree is usually rejected outright rather than traversed. Descending in
        // node order instead costs about three times as much on a long shot down the
        // arena, because nothing prunes until the very end.
        const l = node + 1, r = this.nodes[b + 6];
        const tl = this._slab(l * 8, ox, oy, oz, ix, iy, iz, best);
        const tr = this._slab(r * 8, ox, oy, oz, ix, iy, iz, best);
        if (tl <= tr) {
          if (tr !== Infinity) { _stackT[sp] = tr; stack[sp++] = r; }
          if (tl !== Infinity) { _stackT[sp] = tl; stack[sp++] = l; }
        } else {
          if (tl !== Infinity) { _stackT[sp] = tl; stack[sp++] = l; }
          if (tr !== Infinity) { _stackT[sp] = tr; stack[sp++] = r; }
        }
      }
    }
    if (best >= maxDist) return null;
    if (outNormal && bestTri >= 0) this._triNormal(bestTri, outNormal);
    return best;
  }

  /** Geometric normal of triangle `i` (an index into the BVH's ordering). */
  _triNormal(i, out) {
    const t = this.tris;
    const o = this.index[i] * 9;
    const ax = t[o], ay = t[o + 1], az = t[o + 2];
    const e1x = t[o + 3] - ax, e1y = t[o + 4] - ay, e1z = t[o + 5] - az;
    const e2x = t[o + 6] - ax, e2y = t[o + 7] - ay, e2z = t[o + 8] - az;
    return out.set(
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x,
    ).normalize();
  }

  /**
   * Is the straight line between two points blocked? Stops at the first triangle
   * rather than finding the nearest, which is most of the cost of a sightline.
   */
  blocked(from, to, slack = 0.1) {
    if (!this.count) return false;
    _v.copy(to).sub(from);
    const full = _v.length();
    // Ignore the last few centimetres. A fighter standing flush against a wall has a
    // chest point that is *almost* on the surface, and without this a sightline to it
    // is blocked by the very thing they are standing against — so nobody could ever be
    // shot while hugging cover. The box path had the same allowance; dropping it when
    // this took over would have been a silent change to who can see whom.
    const dist = full - slack;
    if (dist < 1e-6) return false;
    _v.multiplyScalar(1 / full);
    const ox = from.x, oy = from.y, oz = from.z;
    const dx = _v.x, dy = _v.y, dz = _v.z;
    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    const stack = _stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const node = stack[--sp];
      const b = node * 8;
      if (this._slab(b, ox, oy, oz, ix, iy, iz, dist) === Infinity) continue;
      const n = this.nodes[b + 7];
      if (n > 0) {
        const start = this.nodes[b + 6];
        for (let i = start; i < start + n; i++) {
          if (this._tri(i, ox, oy, oz, dx, dy, dz, dist) >= 0) return true;
        }
      } else {
        stack[sp++] = node + 1;
        stack[sp++] = this.nodes[b + 6];
      }
    }
    return false;
  }
}

// One shared traversal stack. These queries are strictly synchronous and never
// re-enter, and a fresh array per LOS check is the kind of allocation that shows up
// as a garbage collection in the middle of a firefight.
const _stack = new Int32Array(64);
// Entry distance for each queued node, so a pop can be rejected against the
// current best hit without repeating the slab test that produced it.
const _stackT = new Float32Array(64);

/**
 * Collect world-space triangles from a subtree.
 *
 * `accept(mesh)` decides what is solid. It has to be an explicit choice: the crowd,
 * the chain-link, the muzzle flashes and the fighters are all visible meshes that must
 * not stop a bullet, and half of them would if this guessed.
 */
export function collectTriangles(root, accept) {
  const out = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !accept(o)) return;
    const geo = o.geometry;
    const pos = geo.attributes.position;
    if (!pos) return;
    const idx = geo.index;
    const n = idx ? idx.count : pos.count;
    const instances = o.isInstancedMesh ? o.count : 1;
    for (let inst = 0; inst < instances; inst++) {
      if (o.isInstancedMesh) {
        o.getMatrixAt(inst, m);
        m.premultiply(o.matrixWorld);
      } else {
        m.copy(o.matrixWorld);
      }
      for (let i = 0; i < n; i++) {
        const vi = idx ? idx.getX(i) : i;
        v.fromBufferAttribute(pos, vi).applyMatrix4(m);
        out.push(v.x, v.y, v.z);
      }
    }
  });
  return new Float32Array(out);
}
