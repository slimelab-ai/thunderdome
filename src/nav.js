import * as THREE from 'three';
import { groundHeight, STEP_REACH, STAND_LIMIT } from './combat.js';

// Multi-layer 3D navmesh over the arena.
//
// Every grid cell can hold MULTIPLE walkable surfaces (the floor under a deck AND the
// deck itself), each a node with a real y. Nodes link to neighbors by walk edges
// (|Δy| ≤ STEP_LINK — stair runs), and by one-way DROP edges (walking off a ledge).
// A* with real costs, then string-pulling smoothing over walkable lines.
// Built once per arena; the graph is ~1500 nodes, so search cost is negligible.

const CELL = 1.0;
const STEP_LINK = 1.0;  // max rise between adjacent cells (stairs pass, sheer ledges don't)
const MAX_DROP = 3.5;   // max height an agent will deliberately walk off
const CLEAR = 1.75;     // standing headroom required above a surface
const PAD = 0.45;       // agent radius clearance

const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Binary min-heap over (node id, f) pairs.
 *
 * Ids and priorities sit in two parallel arrays rather than one array of `{id, f}`
 * records, and the sift loops swap through a temporary rather than destructuring.
 * Both allocated — an object per push, an array per swap — inside the loops A* spends
 * all its time in. `clear` lets one heap serve every search instead of one per path.
 *
 * The comparisons are unchanged, so the pop order, and therefore which of several
 * equal-cost routes a search returns, is exactly what it was.
 */
class MinHeap {
  constructor() { this.ids = []; this.fs = []; this.n = 0; }
  clear() { this.n = 0; }
  push(id, f) {
    const ids = this.ids, fs = this.fs;
    let i = this.n++;
    ids[i] = id; fs[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= fs[i]) break;
      const ti = ids[p]; ids[p] = ids[i]; ids[i] = ti;
      const tf = fs[p]; fs[p] = fs[i]; fs[i] = tf;
      i = p;
    }
  }
  pop() {
    const ids = this.ids, fs = this.fs;
    const top = ids[0];
    const last = --this.n;
    if (last > 0) {
      ids[0] = ids[last]; fs[0] = fs[last];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < last && fs[l] < fs[m]) m = l;
        if (r < last && fs[r] < fs[m]) m = r;
        if (m === i) break;
        const ti = ids[m]; ids[m] = ids[i]; ids[i] = ti;
        const tf = fs[m]; fs[m] = fs[i]; fs[i] = tf;
        i = m;
      }
    }
    return top;
  }
  get size() { return this.n; }
}

export class NavMesh {
  constructor(colliders, minX = -22, maxX = 22, minZ = -16, maxZ = 16) {
    this.colliders = colliders;
    this.minX = minX; this.minZ = minZ;
    this.w = Math.ceil((maxX - minX) / CELL);
    this.h = Math.ceil((maxZ - minZ) / CELL);

    // ---- build nodes: every clear walkable surface in every cell ----
    this.nodes = [];                    // {x, z, y, edges: [{to, cost}]}
    this.cellNodes = new Array(this.w * this.h);
    for (let i = 0; i < this.w; i++) {
      for (let j = 0; j < this.h; j++) {
        const cx = minX + (i + 0.5) * CELL, cz = minZ + (j + 0.5) * CELL;
        const x0 = cx - CELL / 2 - PAD, x1 = cx + CELL / 2 + PAD;
        const z0 = cz - CELL / 2 - PAD, z1 = cz + CELL / 2 + PAD;

        // candidate surface heights: arena floor + every standable box top under the center
        const cands = [0];
        for (const b of colliders) {
          if (b.max.y > STAND_LIMIT) continue;
          if (b.containsXZ(cx, cz, 0.2)) cands.push(b.max.y);
        }
        cands.sort((a, b) => a - b);

        const ids = [];
        let lastY = -99;
        for (const h of cands) {
          if (h - lastY < 0.1) continue; // dedup near-equal heights
          // clearance: nothing solid occupying the standing space above this surface
          // (boxes topping out within a step's reach are stairs, not obstructions)
          let clear = true;
          for (const b of colliders) {
            if (b.max.y <= h + STEP_REACH || b.min.y >= h + CLEAR) continue;
            if (b.overlapsRect(x0, z0, x1, z1)) { clear = false; break; }
          }
          if (!clear) continue;
          lastY = h;
          ids.push(this.nodes.length);
          this.nodes.push({ x: cx, z: cz, y: h, edges: [] });
        }
        this.cellNodes[j * this.w + i] = ids;
      }
    }

    // ---- build edges ----
    for (let i = 0; i < this.w; i++) {
      for (let j = 0; j < this.h; j++) {
        for (const a of this.cellNodes[j * this.w + i]) {
          const na = this.nodes[a];
          for (const [di, dj] of NEI) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= this.w || jj >= this.h) continue;
            const distH = (di && dj) ? CELL * 1.414 : CELL;
            for (const b of this.cellNodes[jj * this.w + ii]) {
              const nb = this.nodes[b];
              const dy = nb.y - na.y;
              if (Math.abs(dy) <= STEP_LINK) {
                // diagonal corner-cutting guard: both orthogonal cells need a compatible surface
                if (di && dj && !(this._hasCompatible(i + di, j, na.y) && this._hasCompatible(i, j + dj, na.y))) continue;
                na.edges.push({ to: b, cost: distH * (1 + Math.abs(dy) * 0.3) });
              } else if (dy < 0 && -dy <= MAX_DROP) {
                // one-way drop off a ledge
                na.edges.push({ to: b, cost: distH + (-dy) * 2 });
              }
            }
          }
        }
      }
    }
  }

  _hasCompatible(i, j, y) {
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
    for (const id of this.cellNodes[j * this.w + i]) {
      if (Math.abs(this.nodes[id].y - y) <= STEP_LINK) return true;
    }
    return false;
  }

  // nearest node to a world position (searches outward a few cells if needed)
  nodeAt(x, z, y) {
    const ci = Math.min(this.w - 1, Math.max(0, Math.floor((x - this.minX) / CELL)));
    const cj = Math.min(this.h - 1, Math.max(0, Math.floor((z - this.minZ) / CELL)));
    for (let r = 0; r <= 4; r++) {
      let best = -1, bestScore = Infinity;
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
          for (const id of this.cellNodes[j * this.w + i]) {
            const n = this.nodes[id];
            const score = Math.abs(n.y - y) * 2 + Math.hypot(n.x - x, n.z - z);
            if (score < bestScore) { bestScore = score; best = id; }
          }
        }
      }
      if (best !== -1) return best;
    }
    return -1;
  }

  // Can an agent walk a straight line a→b (no path needed)? Marches ground height,
  // fails on blocked headroom, un-steppable rises, or drops taller than a step.
  walkableLine(ax, az, ay, bx, bz, by) {
    const dx = bx - ax, dz = bz - az;
    const d = Math.hypot(dx, dz);
    if (d > 24) return false;
    const steps = Math.max(1, Math.ceil(d / 0.65));
    let y = ay;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const px = ax + dx * t, pz = az + dz * t;
      const g = groundHeight(this.colliders, px, pz, y);
      if (Math.abs(g - y) > STEP_REACH + 0.05) return false;
      y = g;
      for (const box of this.colliders) {
        if (box.max.y - y <= STEP_REACH || box.min.y > y + 1.5) continue;
        if (box.containsXZ(px, pz, PAD)) return false;
      }
    }
    return Math.abs(y - by) <= 0.8;
  }

  // A* → smoothed Vector3 waypoints (with real y), or null.
  // seed (optional): deterministic per-agent cost jitter, so squadmates split across
  // near-tied routes instead of forming a single-file line down the one optimal path.
  // side (optional, ±1): persistent flank preference — penalizes nodes on the other
  // side of the target so part of the squad envelops instead of stacking one corner.
  findPath(from, to, seed = 0, side = 0) {
    const start = this.nodeAt(from.x, from.z, from.y);
    const goal = this.nodeAt(to.x, to.z, to.y);
    if (start === -1 || goal === -1) return null;
    if (start === goal) {
      const n = this.nodes[goal];
      return [new THREE.Vector3(n.x, n.y, n.z)];
    }

    const N = this.nodes.length;
    // Search state is reused between calls and validated by a generation stamp: a node
    // whose stamp is not this search's has no score yet, which is what filling with
    // Infinity used to say. Three fresh typed arrays and their clears — about 20 KB a
    // call over this graph — cost more than the search itself on the short paths bots
    // ask for several times a second.
    if (!this._gScore || this._gScore.length < N) {
      this._gScore = new Float64Array(N);
      this._came = new Int32Array(N);
      this._stamp = new Int32Array(N);
      this._closed = new Int32Array(N);
      this._heap = new MinHeap();
      this._generation = 0;
    }
    const gScore = this._gScore, came = this._came;
    const stamp = this._stamp, closed = this._closed;
    // Stamps are compared for equality, so they only have to outlast one search. Reset
    // before the counter could reach a value already sitting in the arrays.
    if (this._generation >= 0x7ffffffe) {
      stamp.fill(0); closed.fill(0); this._generation = 0;
    }
    const gen = ++this._generation;
    const open = this._heap;
    open.clear();

    const gn = this.nodes[goal];
    const heur = (id) => {
      const n = this.nodes[id];
      return Math.hypot(n.x - gn.x, n.z - gn.z) + Math.abs(n.y - gn.y) * 1.5;
    };
    gScore[start] = 0; came[start] = -1; stamp[start] = gen;
    open.push(start, heur(start));
    let found = false;

    while (open.size) {
      const id = open.pop();
      if (closed[id] === gen) continue;
      if (id === goal) { found = true; break; }
      closed[id] = gen;
      const n = this.nodes[id];
      for (const e of n.edges) {
        if (closed[e.to] === gen) continue;
        let g = gScore[id] + e.cost;
        if (seed) {
          let hsh = (e.to * 2654435761 + seed) >>> 0;
          hsh ^= hsh >> 13;
          g += (hsh % 1000) / 1000 * 0.9;
        }
        if (side) {
          const nx = this.nodes[e.to].x - gn.x;
          if (nx * side < -1.5) g += 0.55;
        }
        if (stamp[e.to] !== gen || g < gScore[e.to]) {
          gScore[e.to] = g;
          came[e.to] = id;
          stamp[e.to] = gen;
          open.push(e.to, g + heur(e.to));
        }
      }
    }
    if (!found) return null;

    // reconstruct
    const raw = [];
    for (let cur = goal; cur !== -1 && raw.length < 900; cur = came[cur]) {
      const n = this.nodes[cur];
      raw.push(new THREE.Vector3(n.x, n.y, n.z));
      if (cur === start) break;
    }
    raw.reverse();

    // string-pulling: greedily skip to the furthest waypoint reachable in a straight walk
    // (windowed to keep cost bounded; drops are never smoothed across)
    const out = [];
    let i = 0;
    while (i < raw.length - 1) {
      let j = Math.min(i + 7, raw.length - 1);
      for (; j > i + 1; j--) {
        if (raw[j].y - raw[i].y < -STEP_REACH) continue; // don't smooth over a drop edge
        if (this.walkableLine(raw[i].x, raw[i].z, raw[i].y, raw[j].x, raw[j].z, raw[j].y)) break;
      }
      out.push(raw[j]);
      i = j;
    }
    return out.length ? out : [raw[raw.length - 1]];
  }
}
