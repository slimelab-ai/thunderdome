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

  _lx(dx, dz) { return dx * this.cos + dz * this.sin; }
  _lz(dx, dz) { return -dx * this.sin + dz * this.cos; }

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
    out.x = this.cx + lx * this.cos - lz * this.sin;
    out.z = this.cz + lx * this.sin + lz * this.cos;
    return out;
  }

  // clamp a point to lie inside the footprint with a margin; writes {x,z} into out
  clampInsideXZ(x, z, margin, out) {
    const dx = x - this.cx, dz = z - this.cz;
    const m = Math.max(0.01, margin);
    const lx = Math.max(-this.hw + m, Math.min(this.hw - m, this._lx(dx, dz)));
    const lz = Math.max(-this.hd + m, Math.min(this.hd - m, this._lz(dx, dz)));
    out.x = this.cx + lx * this.cos - lz * this.sin;
    out.z = this.cz + lx * this.sin + lz * this.cos;
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
      pos.x = this.cx + nlx * this.cos - nlz * this.sin;
      pos.z = this.cz + nlx * this.sin + nlz * this.cos;
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
    pos.x = this.cx + nlx * this.cos - nlz * this.sin;
    pos.z = this.cz + nlx * this.sin + nlz * this.cos;
    return true;
  }

  // ray (origin Vector3-like, dir normalized Vector3-like) vs the oriented box.
  // Returns entry distance t ≥ 0, or null on miss. Origin inside → 0.
  raycast(o, d) {
    const ox = o.x - this.cx, oz = o.z - this.cz;
    const lox = this._lx(ox, oz), loz = this._lz(ox, oz);
    const ldx = this._lx(d.x, d.z), ldz = this._lz(d.x, d.z);
    let tmin = -Infinity, tmax = Infinity;
    const slabs = [
      [lox, ldx, -this.hw, this.hw],
      [o.y, d.y, this.min.y, this.max.y],
      [loz, ldz, -this.hd, this.hd],
    ];
    for (const [ro, rd, lo, hi] of slabs) {
      if (Math.abs(rd) < 1e-9) {
        if (ro < lo || ro > hi) return null;
        continue;
      }
      let t0 = (lo - ro) / rd, t1 = (hi - ro) / rd;
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
