// Oriented-box collider (yaw rotation about Y). Every solid in the arena is one of
// these; yaw=0 boxes take the same fast paths. `min`/`max` expose the world AABB —
// valid for Y-range tests and broadphase only. All exact XZ geometry goes through
// the methods, which work in the box's local frame.

export class Collider {
  constructor(cx, baseY, cz, w, h, d, yaw = 0) {
    this.cx = cx; this.cz = cz;
    this.hw = w / 2; this.hd = d / 2;
    this.yaw = yaw;
    this.cos = Math.cos(yaw); this.sin = Math.sin(yaw);
    const ew = Math.abs(this.cos) * w + Math.abs(this.sin) * d;
    const ed = Math.abs(this.sin) * w + Math.abs(this.cos) * d;
    this.min = { x: cx - ew / 2, y: baseY, z: cz - ed / 2 };
    this.max = { x: cx + ew / 2, y: baseY + h, z: cz + ed / 2 };
  }

  // world→local is the inverse of three.js RotY(yaw): local (x,z) → world (x·cos + z·sin, −x·sin + z·cos)
  _lx(dx, dz) { return dx * this.cos - dz * this.sin; }
  _lz(dx, dz) { return dx * this.sin + dz * this.cos; }

  containsXZ(x, z, pad = 0) {
    // broadphase AABB reject (exact for yaw=0)
    if (x < this.min.x - pad || x > this.max.x + pad || z < this.min.z - pad || z > this.max.z + pad) return false;
    if (this.yaw === 0) return true;
    const dx = x - this.cx, dz = z - this.cz;
    return Math.abs(this._lx(dx, dz)) <= this.hw + pad && Math.abs(this._lz(dx, dz)) <= this.hd + pad;
  }

  // closest point on the footprint boundary/interior to (x,z); writes {x,z} into out
  closestXZ(x, z, out) {
    const dx = x - this.cx, dz = z - this.cz;
    const lx = Math.max(-this.hw, Math.min(this.hw, this._lx(dx, dz)));
    const lz = Math.max(-this.hd, Math.min(this.hd, this._lz(dx, dz)));
    out.x = this.cx + lx * this.cos + lz * this.sin;
    out.z = this.cz - lx * this.sin + lz * this.cos;
    return out;
  }

  // clamp a point to lie inside the footprint with a margin; writes {x,z} into out
  clampInsideXZ(x, z, margin, out) {
    const dx = x - this.cx, dz = z - this.cz;
    const m = Math.max(0.01, margin);
    const lx = Math.max(-this.hw + m, Math.min(this.hw - m, this._lx(dx, dz)));
    const lz = Math.max(-this.hd + m, Math.min(this.hd - m, this._lz(dx, dz)));
    out.x = this.cx + lx * this.cos + lz * this.sin;
    out.z = this.cz - lx * this.sin + lz * this.cos;
    return out;
  }

  // push a circle at pos {x,z} (mutated) with `radius` out of the footprint
  pushCircleXZ(pos, radius) {
    // broadphase AABB reject
    if (pos.x < this.min.x - radius || pos.x > this.max.x + radius ||
        pos.z < this.min.z - radius || pos.z > this.max.z + radius) return false;
    const dx = pos.x - this.cx, dz = pos.z - this.cz;
    const lx = this._lx(dx, dz), lz = this._lz(dx, dz);
    const ax = Math.abs(lx), az = Math.abs(lz);
    if (ax < this.hw && az < this.hd) {
      // center inside: exit along the local axis with least penetration
      let nlx = lx, nlz = lz;
      if (this.hw - ax < this.hd - az) nlx = Math.sign(lx || 1) * (this.hw + radius);
      else nlz = Math.sign(lz || 1) * (this.hd + radius);
      pos.x = this.cx + nlx * this.cos + nlz * this.sin;
      pos.z = this.cz - nlx * this.sin + nlz * this.cos;
      return true;
    }
    const clx = Math.max(-this.hw, Math.min(this.hw, lx));
    const clz = Math.max(-this.hd, Math.min(this.hd, lz));
    const ddx = lx - clx, ddz = lz - clz;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 >= radius * radius || d2 < 1e-12) return false;
    const dst = Math.sqrt(d2);
    const nlx = clx + (ddx / dst) * radius;
    const nlz = clz + (ddz / dst) * radius;
    pos.x = this.cx + nlx * this.cos + nlz * this.sin;
    pos.z = this.cz - nlx * this.sin + nlz * this.cos;
    return true;
  }

  // ray (origin Vector3-like, dir normalized Vector3-like) vs the oriented box.
  // Returns entry distance t ≥ 0, or null on miss. Origin inside → 0.
  //
  // The three slabs are written out rather than looped over a table of them. This is
  // the innermost function of line of sight, wall probing and every AI scan — tens of
  // millions of calls a minute — and building four throwaway arrays per call to
  // describe three fixed axes cost more than the arithmetic it was wrapping.
  raycast(o, d) {
    const ox = o.x - this.cx, oz = o.z - this.cz;
    const lox = this._lx(ox, oz), loz = this._lz(ox, oz);
    const ldx = this._lx(d.x, d.z), ldz = this._lz(d.x, d.z);
    let tmin = -Infinity, tmax = Infinity;

    // Local X slab.
    if (ldx < 1e-9 && ldx > -1e-9) {
      if (lox < -this.hw || lox > this.hw) return null;
    } else {
      const inv = 1 / ldx;
      let t0 = (-this.hw - lox) * inv, t1 = (this.hw - lox) * inv;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) return null;
    }

    // World Y slab — height is unaffected by the box's yaw.
    if (d.y < 1e-9 && d.y > -1e-9) {
      if (o.y < this.min.y || o.y > this.max.y) return null;
    } else {
      const inv = 1 / d.y;
      let t0 = (this.min.y - o.y) * inv, t1 = (this.max.y - o.y) * inv;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) return null;
    }

    // Local Z slab.
    if (ldz < 1e-9 && ldz > -1e-9) {
      if (loz < -this.hd || loz > this.hd) return null;
    } else {
      const inv = 1 / ldz;
      let t0 = (-this.hd - loz) * inv, t1 = (this.hd - loz) * inv;
      if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
      if (t0 > tmin) tmin = t0;
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) return null;
    }

    if (tmax < 0) return null;
    return tmin >= 0 ? tmin : 0;
  }

  // does the footprint overlap an axis-aligned rect [x0,x1]×[z0,z1]? (2D SAT)
  overlapsRect(x0, z0, x1, z1) {
    if (this.min.x >= x1 || this.max.x <= x0 || this.min.z >= z1 || this.max.z <= z0) return false;
    if (this.yaw === 0) return true;
    const rhx = (x1 - x0) / 2, rhz = (z1 - z0) / 2;
    const dx = (x0 + x1) / 2 - this.cx, dz = (z0 + z1) / 2 - this.cz;
    if (Math.abs(this._lx(dx, dz)) > this.hw + rhx * Math.abs(this.cos) + rhz * Math.abs(this.sin)) return false;
    if (Math.abs(this._lz(dx, dz)) > this.hd + rhx * Math.abs(this.sin) + rhz * Math.abs(this.cos)) return false;
    return true;
  }
}

// Vertical cylinder collider for round props. It intentionally exposes the same
// interface as Collider so movement, bullets, LOS, ground-height and nav code do
// not need shape-specific branches.
export class CylinderCollider {
  constructor(cx, baseY, cz, radius, height) {
    this.cx = cx; this.cz = cz; this.radius = radius;
    this.min = { x: cx - radius, y: baseY, z: cz - radius };
    this.max = { x: cx + radius, y: baseY + height, z: cz + radius };
  }

  containsXZ(x, z, pad = 0) {
    const r = this.radius + pad;
    return (x - this.cx) ** 2 + (z - this.cz) ** 2 <= r * r;
  }

  closestXZ(x, z, out) {
    const dx = x - this.cx, dz = z - this.cz;
    const dist = Math.hypot(dx, dz);
    if (dist <= this.radius) { out.x = x; out.z = z; return out; }
    const s = this.radius / dist;
    out.x = this.cx + dx * s; out.z = this.cz + dz * s;
    return out;
  }

  clampInsideXZ(x, z, margin, out) {
    const dx = x - this.cx, dz = z - this.cz;
    const limit = Math.max(0.01, this.radius - Math.max(0.01, margin));
    const dist = Math.hypot(dx, dz);
    const s = dist > limit ? limit / dist : 1;
    out.x = this.cx + dx * s; out.z = this.cz + dz * s;
    return out;
  }

  pushCircleXZ(pos, radius) {
    const dx = pos.x - this.cx, dz = pos.z - this.cz;
    const limit = this.radius + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= limit * limit) return false;
    const dist = Math.sqrt(d2);
    const nx = dist > 1e-9 ? dx / dist : 1;
    const nz = dist > 1e-9 ? dz / dist : 0;
    pos.x = this.cx + nx * limit; pos.z = this.cz + nz * limit;
    return true;
  }

  raycast(o, d) {
    let y0 = -Infinity, y1 = Infinity;
    if (Math.abs(d.y) < 1e-9) {
      if (o.y < this.min.y || o.y > this.max.y) return null;
    } else {
      y0 = (this.min.y - o.y) / d.y; y1 = (this.max.y - o.y) / d.y;
      // A plain temporary rather than a destructured swap, which allocates an array
      // on every call in a function the LOS loop hits once per barrel per ray.
      if (y0 > y1) { const tmp = y0; y0 = y1; y1 = tmp; }
    }
    const ox = o.x - this.cx, oz = o.z - this.cz;
    const a = d.x * d.x + d.z * d.z;
    let x0 = -Infinity, x1 = Infinity;
    if (a < 1e-12) {
      if (ox * ox + oz * oz > this.radius * this.radius) return null;
    } else {
      const b = 2 * (ox * d.x + oz * d.z);
      const c = ox * ox + oz * oz - this.radius * this.radius;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const root = Math.sqrt(disc);
      x0 = (-b - root) / (2 * a); x1 = (-b + root) / (2 * a);
    }
    const enter = Math.max(x0, y0), exit = Math.min(x1, y1);
    if (enter > exit || exit < 0) return null;
    return Math.max(0, enter);
  }

  overlapsRect(x0, z0, x1, z1) {
    const x = Math.max(x0, Math.min(this.cx, x1));
    const z = Math.max(z0, Math.min(this.cz, z1));
    return (x - this.cx) ** 2 + (z - this.cz) ** 2 < this.radius * this.radius;
  }
}
