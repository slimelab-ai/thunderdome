/* eslint-env browser */
/**
 * Browser-side texture bakery. Runs inside headless Chrome (see generate.mjs) so
 * it gets Canvas2D and a real WebP encoder for free.
 *
 * Every set returns { albedo, normal, orm } canvases at the same resolution.
 * ORM packs Ambient Occlusion in R, Roughness in G, Metalness in B — the glTF
 * convention, which three.js reads by pointing aoMap/roughnessMap/metalnessMap at
 * one texture.
 *
 * All sets tile seamlessly: draws wrap by stamping every feature nine times
 * (offset by ±size) rather than by mirroring, which would show a visible seam
 * axis on a floor this large.
 */
(() => {
  // ---------------------------------------------------------------- utilities

  const canvas = (size) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  };

  // Deterministic PRNG: a texture set must be byte-identical between runs or every
  // asset rebuild shows up as a spurious diff.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // Value noise with a hashed integer lattice — cheap, tiles exactly when the
  // lattice period divides the texture size.
  function makeNoise(seed, period) {
    const rand = rng(seed);
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    const smooth = (t) => t * t * (3 - 2 * t);
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
      const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period;
      const sx = smooth(xf), sy = smooth(yf);
      const a = grid[y0 * period + x0], b = grid[y0 * period + x1];
      const c = grid[y1 * period + x0], d = grid[y1 * period + x1];
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    };
  }

  function fbm(seed, size, baseCells, octaves) {
    const layers = [];
    for (let o = 0; o < octaves; o++) {
      const cells = baseCells * (1 << o);
      if (size % cells !== 0) break;           // keep every octave tiling
      layers.push({ n: makeNoise(seed + o * 7919, cells), scale: cells / size, amp: 1 / (1 << o) });
    }
    const norm = layers.reduce((s, l) => s + l.amp, 0);
    return (x, y) => {
      let v = 0;
      for (const l of layers) v += l.n(x * l.scale, y * l.scale) * l.amp;
      return v / norm;
    };
  }

  // Stamp a draw callback nine times so anything crossing an edge reappears on the
  // opposite side. The cost is trivial and it removes all seam special-casing.
  function wrapped(ctx, size, draw) {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.save();
        ctx.translate(ox * size, oy * size);
        draw(ctx);
        ctx.restore();
      }
    }
  }

  /**
   * Separable box blur over a wrapping height field.
   *
   * Deriving normals straight from per-texel noise produces essentially white-noise
   * normals, and normal maps do not antialias: mipmapping averages the *vectors*,
   * which is not the same as averaging the *shading*, so the surface fizzes with
   * salt-and-pepper specular at any distance. Every surface in the first pass
   * shimmered for exactly this reason. Low-passing the height first keeps the bump
   * detail the albedo implies while giving the normal a feature size the filter can
   * actually resolve.
   */
  function blurHeight(height, size, radius) {
    if (radius < 1) return height;
    const tmp = new Float32Array(size * size);
    const out = new Float32Array(size * size);
    const n = radius * 2 + 1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += height[y * size + (((x + k) % size) + size) % size];
        tmp[y * size + x] = sum / n;
      }
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += tmp[((((y + k) % size) + size) % size) * size + x];
        out[y * size + x] = sum / n;
      }
    }
    return out;
  }

  // Height → tangent-space normal via Sobel. Heights arrive as a Float32Array in
  // 0..1; strength is in "height units per texel".
  function heightToNormal(height, size, strength, blur = 2) {
    height = blurHeight(height, size, blur);
    const out = canvas(size);
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(size, size);
    const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        let nx = -dx * strength, ny = -dy * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const i = (y * size + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  // Cheap screen-space-free AO: how much lower is this texel than its neighbourhood.
  function heightToAO(height, size, radius, strength) {
    const ao = new Float32Array(size * size);
    const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
    const taps = [];
    for (let a = 0; a < 8; a++) taps.push([Math.round(Math.cos(a / 8 * 6.283) * radius), Math.round(Math.sin(a / 8 * 6.283) * radius)]);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const h = at(x, y);
        let occl = 0;
        for (const [tx, ty] of taps) occl += Math.max(0, at(x + tx, y + ty) - h);
        ao[y * size + x] = 1 - Math.min(1, (occl / taps.length) * strength);
      }
    }
    return ao;
  }

  // Pack AO/roughness/metalness. `rough` and `metal` may be numbers or Float32Arrays.
  function packORM(size, ao, rough, metal) {
    const out = canvas(size);
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(size, size);
    const pick = (v, i) => (typeof v === 'number' ? v : v[i]);
    for (let i = 0; i < size * size; i++) {
      const p = i * 4;
      img.data[p] = Math.max(0, Math.min(1, pick(ao, i))) * 255;
      img.data[p + 1] = Math.max(0, Math.min(1, pick(rough, i))) * 255;
      img.data[p + 2] = Math.max(0, Math.min(1, pick(metal, i))) * 255;
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // ------------------------------------------------------------------- sets

  const SETS = {};

  /**
   * Poured concrete slab: aggregate speckle, form-line seams, spider cracks,
   * damp patches (the roughness variation that stops it reading as plastic) and
   * old blood that has soaked in rather than sat on top.
   */
  SETS.concrete_floor = (size = 1024) => {
    const rand = rng(0x51ab);
    const grain = fbm(0x1234, size, 8, 5);
    const blotch = fbm(0x99aa, size, 4, 3);
    const fine = fbm(0x5150, size, 64, 2);

    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] = grain(x, y) * 0.55 + fine(x, y) * 0.45;
      }
    }

    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    // base tone modulated by the same noise the height uses, so bumps and colour agree
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const h = height[i];
        const b = blotch(x, y);
        const v = lerp(0.26, 0.37, h) * lerp(0.82, 1.12, b);
        const p = i * 4;
        img.data[p] = clamp01(v * 1.02) * 255;
        img.data[p + 1] = clamp01(v * 1.0) * 255;
        img.data[p + 2] = clamp01(v * 1.03) * 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // aggregate: exposed stones where the surface has worn through
    wrapped(ctx, size, (c) => {
      for (let i = 0; i < 900; i++) {
        const x = rand() * size, y = rand() * size, r = 1 + rand() * 2.4;
        c.fillStyle = `rgba(${150 + rand() * 40 | 0},${148 + rand() * 40 | 0},${146 + rand() * 40 | 0},${0.04 + rand() * 0.06})`;
        c.beginPath(); c.arc(x, y, r, 0, 6.284); c.fill();
      }
    });

    // form-line seams on a grid — reads as poured bays, gives the eye scale
    const bay = size / 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = size / 340;
    for (let i = 0; i < 2; i++) {
      ctx.beginPath(); ctx.moveTo(i * bay, 0); ctx.lineTo(i * bay, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * bay); ctx.lineTo(size, i * bay); ctx.stroke();
    }

    // spider cracks radiating from a few impact points
    wrapped(ctx, size, (c) => {
      c.strokeStyle = 'rgba(0,0,0,0.42)';
      for (let n = 0; n < 7; n++) {
        const cx = rand() * size, cy = rand() * size;
        const legs = 3 + (rand() * 3 | 0);
        for (let l = 0; l < legs; l++) {
          let x = cx, y = cy, a = rand() * 6.284;
          c.lineWidth = size / 700;
          c.beginPath(); c.moveTo(x, y);
          for (let s = 0; s < 9; s++) {
            a += (rand() - 0.5) * 0.9;
            const step = size / 90 * (1 + rand());
            x += Math.cos(a) * step; y += Math.sin(a) * step;
            c.lineTo(x, y);
          }
          c.stroke();
        }
      }
    });

    // Soaked-in blood: multiply so it darkens the concrete rather than coating it.
    // Stains are drawn as smeared ellipses at random angles — perfect circles read
    // as polka dots, which is exactly how the first pass looked.
    ctx.globalCompositeOperation = 'multiply';
    wrapped(ctx, size, (c) => {
      for (let i = 0; i < 7; i++) {
        const x = rand() * size, y = rand() * size, r = size * (0.03 + rand() * 0.055);
        c.save();
        c.translate(x, y);
        c.rotate(rand() * 6.284);
        c.scale(1, 0.34 + rand() * 0.4);              // smear along the drag direction
        const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, 'rgba(150,96,92,1)');
        g.addColorStop(0.55, 'rgba(205,175,172,1)');
        g.addColorStop(1, 'rgba(255,255,255,1)');
        c.fillStyle = g;
        c.beginPath(); c.arc(0, 0, r, 0, 6.284); c.fill();
        c.restore();
      }
    });
    ctx.globalCompositeOperation = 'source-over';

    // roughness: damp patches are smoother, and they follow the blotch noise so
    // the wet areas sit in the low spots like real standing water
    const rough = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const damp = clamp01((blotch(x, y) - 0.52) * 3.4);
        rough[i] = lerp(lerp(0.93, 0.86, height[i]), 0.42, damp);
      }
    }
    const ao = heightToAO(height, size, 5, 5.5);
    return { albedo: alb, normal: heightToNormal(height, size, 7.5, 3), orm: packORM(size, ao, rough, 0.02) };
  };

  /** Board-formed wall concrete: horizontal shutter lines, streaked water staining. */
  SETS.concrete_wall = (size = 1024) => {
    const rand = rng(0x77c1);
    const grain = fbm(0x2468, size, 8, 5);
    const fine = fbm(0xbeef, size, 64, 2);
    const streak = fbm(0xfeed, size, 16, 3);

    const height = new Float32Array(size * size);
    const boards = 8;                             // shuttering board height in texels
    const bh = size / boards;
    for (let y = 0; y < size; y++) {
      const inBoard = (y % bh) / bh;
      // a proud lip at each board joint
      const joint = Math.exp(-((inBoard < 0.5 ? inBoard : 1 - inBoard) * bh) / 2.2) * 0.5;
      for (let x = 0; x < size; x++) {
        height[y * size + x] = grain(x, y) * 0.4 + fine(x, y) * 0.3 + joint * 0.3;
      }
    }

    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        // vertical damp streaks running down from each joint
        const s = clamp01(streak(x * 0.25, y * 2) * 1.2 - 0.35);
        const v = lerp(0.24, 0.34, height[i]) * lerp(1.0, 0.72, s);
        const p = i * 4;
        img.data[p] = clamp01(v) * 255;
        img.data[p + 1] = clamp01(v * 0.99) * 255;
        img.data[p + 2] = clamp01(v * 1.02) * 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // tie-rod holes, in a regular grid like real formwork
    wrapped(ctx, size, (c) => {
      for (let gy = 0; gy < 4; gy++) {
        for (let gx = 0; gx < 4; gx++) {
          const x = (gx + 0.5) * size / 4, y = (gy + 0.5) * size / 4;
          const r = size / 150;
          const g = c.createRadialGradient(x, y, 0, x, y, r * 2);
          g.addColorStop(0, 'rgba(10,10,12,0.85)');
          g.addColorStop(1, 'rgba(10,10,12,0)');
          c.fillStyle = g;
          c.beginPath(); c.arc(x, y, r * 2, 0, 6.284); c.fill();
        }
      }
    });
    // rust weep from the tie rods
    ctx.globalCompositeOperation = 'multiply';
    wrapped(ctx, size, (c) => {
      for (let gy = 0; gy < 4; gy++) {
        for (let gx = 0; gx < 4; gx++) {
          const x = (gx + 0.5) * size / 4, y = (gy + 0.5) * size / 4;
          const g = c.createLinearGradient(x, y, x, y + size / 9);
          g.addColorStop(0, 'rgba(168,116,74,1)');
          g.addColorStop(1, 'rgba(255,255,255,1)');
          c.fillStyle = g;
          c.fillRect(x - size / 240, y, size / 120, size / 9);
        }
      }
    });
    ctx.globalCompositeOperation = 'source-over';

    const rough = new Float32Array(size * size);
    for (let i = 0; i < rough.length; i++) rough[i] = lerp(0.96, 0.88, height[i]);
    const ao = heightToAO(height, size, 4, 6);
    return { albedo: alb, normal: heightToNormal(height, size, 7.0, 3), orm: packORM(size, ao, rough, 0.0) };
  };

  /** Raised-diamond deck plate. Structural, walked-on, scuffed to bare metal. */
  SETS.steel_plate = (size = 512) => {
    const rand = rng(0x3c1d);
    const fine = fbm(0x1a2b, size, 32, 3);
    const wear = fbm(0x9f0e, size, 8, 3);

    const height = new Float32Array(size * size);
    const cell = size / 8;                        // diamond pitch
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // offset diamond lozenges, the standard tread pattern: every other row
        // shifts half a pitch so the treads interlock. The flat top is explicit —
        // a smooth falloff made the treads read as soft blobs, not pressed steel.
        const v = ((y / cell) % 1);
        const row = Math.floor(y / cell) % 2;
        const su = ((x / cell) + (row ? 0.5 : 0)) % 1;
        const d = Math.abs(su - 0.5) * 2 + Math.abs(v - 0.5) * 2;
        const lozenge = clamp01((1 - d * 1.05) * 2.6);
        height[y * size + x] = lozenge * 0.8 + fine(x, y) * 0.2;
      }
    }

    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const w = wear(x, y);
        // A metal's albedo IS its specular reflectance — steel sits near 0.55 linear.
        // Painting it near-black (as the first pass did) renders as literal black
        // metal no matter how good the environment map is. Grime darkens from there.
        const v = lerp(0.30, 0.62, height[i]) * lerp(0.72, 1.12, w);
        const p = i * 4;
        img.data[p] = clamp01(v * 1.0) * 255;
        img.data[p + 1] = clamp01(v * 1.02) * 255;
        img.data[p + 2] = clamp01(v * 1.08) * 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    wrapped(ctx, size, (c) => {
      c.strokeStyle = 'rgba(190,196,205,0.10)';
      c.lineWidth = 1;
      for (let i = 0; i < 260; i++) {                  // scratches
        const x = rand() * size, y = rand() * size, a = rand() * 6.284, l = 4 + rand() * 40;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
      }
    });

    const rough = new Float32Array(size * size);
    const metal = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const w = wear(x, y);
        rough[i] = lerp(0.62, 0.30, height[i] * w);   // treads polished by boots
        metal[i] = lerp(0.55, 0.95, clamp01(height[i] * 1.4));
      }
    }
    const ao = heightToAO(height, size, 3, 7);
    return { albedo: alb, normal: heightToNormal(height, size, 16, 2), orm: packORM(size, ao, rough, metal) };
  };

  /**
   * Painted structural steel. Three states, masked separately, because they are
   * physically different materials: intact paint (a dielectric — metalness ~0),
   * rust bloom where water sat (also a dielectric, very rough), and bare steel
   * scoured back to metal on the impact edges (metalness ~0.9). Tagging the paint
   * itself as metallic, as the first pass did, is what makes painted props look
   * like they were dipped in chrome.
   */
  SETS.steel_painted = (size = 512) => {
    const rand = rng(0x6ba7);
    const chip = fbm(0x4c4c, size, 16, 4);
    const rustN = fbm(0x8e31, size, 8, 3);
    const fine = fbm(0x2020, size, 64, 2);
    const masks = (x, y) => {
      const bare = clamp01((chip(x, y) - 0.62) * 5);          // scoured to metal
      const rust = clamp01((rustN(x, y) - 0.5) * 3) * (1 - bare);
      return { bare, rust };
    };
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const { bare, rust } = masks(x, y);
        // paint sits proud of bare metal; rust scabs sit proud of paint
        height[i] = fine(x, y) * 0.3 - bare * 0.3 + rust * 0.25 + 0.35;
      }
    }
    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const { bare, rust } = masks(x, y);
        const paint = [0.106, 0.114, 0.129];           // #1b1d21 league structure grey
        const rustCol = [0.30, 0.125, 0.05];
        const steel = [0.52, 0.54, 0.57];
        const p = i * 4;
        const j = lerp(0.9, 1.1, fine(x, y));
        for (let ch = 0; ch < 3; ch++) {
          const v = lerp(lerp(paint[ch], rustCol[ch], rust), steel[ch], bare);
          img.data[p + ch] = clamp01(v * j) * 255;
        }
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    wrapped(ctx, size, (c) => {
      c.strokeStyle = 'rgba(210,215,225,0.07)';
      for (let i = 0; i < 140; i++) {
        const x = rand() * size, y = rand() * size, a = rand() * 6.284, l = 3 + rand() * 26;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
      }
    });

    const rough = new Float32Array(size * size);
    const metal = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const { bare, rust } = masks(x, y);
        rough[i] = lerp(lerp(0.52, 0.93, rust), 0.38, bare);
        metal[i] = lerp(lerp(0.04, 0.0, rust), 0.9, bare);
      }
    }
    const ao = heightToAO(height, size, 3, 5);
    return { albedo: alb, normal: heightToNormal(height, size, 6.5, 3), orm: packORM(size, ao, rough, metal) };
  };

  /** Chain-link fence with a real alpha cut, woven rather than two crossed lines. */
  SETS.chainlink = (size = 512) => {
    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    // Chunky wires on purpose. A thin, physically accurate weave loses coverage in
    // the mip chain, and an alphaTest cut against a faded mip level flickers into
    // rainbow fizz across the whole cage at distance.
    const pitch = size / 5;
    const wire = size / 38;
    // Each strand is a zig-zag that alternates over/under, so the weave reads at
    // an angle instead of looking like printed mesh.
    const strand = (dir) => {
      ctx.lineCap = 'round';
      for (let k = -2; k < 10; k++) {
        ctx.beginPath();
        for (let i = -1; i <= 7; i++) {
          const x = i * pitch;
          const y = (k * pitch) + (i % 2 === 0 ? 0 : pitch) * dir;
          if (i === -1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineWidth = wire * 1.7;
        ctx.strokeStyle = 'rgba(8,9,11,0.85)';         // dark core = contact shadow
        ctx.stroke();
        ctx.lineWidth = wire;
        ctx.strokeStyle = 'rgba(148,142,132,1)';
        ctx.stroke();
      }
    };
    strand(1);
    strand(-1);

    // Normal/ORM are flat-ish: the alpha cut carries the shape, and a strong normal
    // on a 2-pixel wire just aliases.
    const height = new Float32Array(size * size);
    const data = ctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < size * size; i++) height[i] = data[i * 4 + 3] / 255 * 0.6;
    return {
      albedo: alb,
      normal: heightToNormal(height, size, 5, 1),
      orm: packORM(size, 1, 0.5, 0.85),
    };
  };

  /**
   * Detail grunge normal, overlaid on authored props at high tiling frequency so
   * a 900-triangle crate still catches light like a beaten object. One set,
   * reused everywhere — the trim-sheet trick applied to normals.
   */
  SETS.detail_grunge = (size = 512) => {
    const fine = fbm(0xd17a, size, 32, 4);
    const scratch = fbm(0x0f1e, size, 8, 2);
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        height[y * size + x] = fine(x, y) * 0.7 + clamp01(scratch(x * 4, y * 0.5) - 0.45) * 0.3;
      }
    }
    const rough = new Float32Array(size * size);
    for (let i = 0; i < rough.length; i++) rough[i] = lerp(0.35, 0.75, height[i]);
    return {
      albedo: null,
      normal: heightToNormal(height, size, 5.5, 3),
      orm: packORM(size, heightToAO(height, size, 3, 4), rough, 0),
    };
  };

  /**
   * Fighter kit atlas. One 1024 map covers a whole fighter: skin, fatigues, webbing,
   * boots and armour laid out in bands the UVs sample from, which keeps every
   * combatant at one draw call and one texture.
   *
   * Layout (V from top): 0.00–0.25 skin, 0.25–0.55 fatigues, 0.55–0.75 webbing/
   * armour, 0.75–1.00 boots/gloves.
   */
  SETS.fighter_kit = (size = 1024) => {
    const rand = rng(0xf1a7);
    const cloth = fbm(0xc10a, size, 128, 2);
    const wear = fbm(0x77d1, size, 16, 3);
    const pore = fbm(0x5c1a, size, 256, 2);

    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    const img = ctx.createImageData(size, size);
    const bands = [
      { to: 0.25, base: [0.62, 0.44, 0.34], kind: 'skin' },
      { to: 0.55, base: [0.20, 0.21, 0.17], kind: 'cloth' },
      { to: 0.75, base: [0.10, 0.10, 0.11], kind: 'gear' },
      { to: 1.01, base: [0.055, 0.05, 0.05], kind: 'rubber' },
    ];
    for (let y = 0; y < size; y++) {
      const v = y / size;
      const band = bands.find((b) => v < b.to);
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        let j;
        if (band.kind === 'skin') j = lerp(0.9, 1.1, pore(x, y));
        else if (band.kind === 'cloth') j = lerp(0.78, 1.2, cloth(x, y)) * lerp(0.85, 1.15, wear(x, y));
        else j = lerp(0.85, 1.15, cloth(x, y));
        const p = i * 4;
        img.data[p] = clamp01(band.base[0] * j) * 255;
        img.data[p + 1] = clamp01(band.base[1] * j) * 255;
        img.data[p + 2] = clamp01(band.base[2] * j) * 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // stitched seams across the fatigues band, and grime at the hems
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.setLineDash([size / 220, size / 220]);
    ctx.lineWidth = Math.max(1, size / 700);
    for (let i = 0; i < 10; i++) {
      const y = size * (0.26 + i * 0.028);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 40; i++) {
      const x = rand() * size, y = size * (0.25 + rand() * 0.75), r = size * (0.01 + rand() * 0.05);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(120,105,90,1)');
      g.addColorStop(1, 'rgba(255,255,255,1)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.284); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    const height = new Float32Array(size * size);
    const rough = new Float32Array(size * size);
    const metal = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      const v = y / size;
      const band = bands.find((b) => v < b.to);
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (band.kind === 'skin') { height[i] = pore(x, y) * 0.3; rough[i] = 0.68; metal[i] = 0; }
        else if (band.kind === 'cloth') { height[i] = cloth(x, y) * 0.8; rough[i] = 0.92; metal[i] = 0; }
        else if (band.kind === 'gear') { height[i] = cloth(x, y) * 0.6 + 0.2; rough[i] = 0.55; metal[i] = 0.35; }
        else { height[i] = cloth(x, y) * 0.5; rough[i] = 0.8; metal[i] = 0.05; }
      }
    }
    return {
      albedo: alb,
      normal: heightToNormal(height, size, 6, 2),
      orm: packORM(size, heightToAO(height, size, 3, 3), rough, metal),
    };
  };

  /** Gunmetal: the one material every weapon shares. */
  SETS.gunmetal = (size = 512) => {
    const rand = rng(0x9e2a);
    const fine = fbm(0x33aa, size, 64, 3);
    const wear = fbm(0x1c3d, size, 12, 3);
    const height = new Float32Array(size * size);
    for (let i = 0; i < height.length; i++) height[i] = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) height[y * size + x] = fine(x, y) * 0.5;

    const alb = canvas(size);
    const ctx = alb.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        // bluing worn back to bright steel on high-wear noise; both are metal, so
        // both stay in metal-reflectance range rather than going near-black
        const w = clamp01((wear(x, y) - 0.58) * 3.5);
        const v = lerp(0.22, 0.55, w) * lerp(0.92, 1.08, fine(x, y));
        const p = i * 4;
        img.data[p] = clamp01(v * 1.0) * 255;
        img.data[p + 1] = clamp01(v * 1.01) * 255;
        img.data[p + 2] = clamp01(v * 1.06) * 255;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    wrapped(ctx, size, (c) => {
      c.strokeStyle = 'rgba(200,206,216,0.10)';
      for (let i = 0; i < 200; i++) {
        const x = rand() * size, y = rand() * size, a = rand() * 6.284, l = 3 + rand() * 22;
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
      }
    });
    const rough = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        rough[i] = lerp(0.44, 0.24, clamp01((wear(x, y) - 0.58) * 3.5));
      }
    }
    return {
      albedo: alb,
      normal: heightToNormal(height, size, 4.5, 2),
      orm: packORM(size, 1, rough, 0.92),
    };
  };

  // ---------------------------------------------------------------- driver API

  window.__bake = {
    list: () => Object.keys(SETS),
    run(name, size) {
      const set = SETS[name](size);
      const out = {};
      for (const [channel, cv] of Object.entries(set)) {
        if (!cv) continue;
        // Everything ships as WebP. Lossless PNG normals came out at 2.7 MB each —
        // an unshippable 15 MB library — because per-texel noise is incompressible.
        // High-quality lossy WebP costs a little precision in the normal's low bits,
        // which is invisible on grime, and lands two orders of magnitude smaller.
        out[channel] = cv.toDataURL('image/webp', channel === 'albedo' ? 0.9 : 0.94);
      }
      return out;
    },
  };
})();
