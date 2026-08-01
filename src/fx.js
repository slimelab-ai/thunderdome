import * as THREE from 'three';
import { NO_OCCLUDE_LAYER } from './layers.js';

// Effects are drawn but are not surfaces; see src/layers.js for why that needs its
// own layer. Re-exported under the old name so nothing else has to move.
export { NO_OCCLUDE_LAYER as FX_NO_AO_LAYER } from './layers.js';

/**
 * Combat VFX.
 *
 * Everything here is pooled and allocation-free at runtime — a firefight spawns
 * hundreds of effects a second and the one thing that must not happen is a garbage
 * collection in the middle of one.
 *
 * Three systems:
 *
 * - **Particles**, in two `Points` pools split by blend mode. Additive for anything
 *   that emits light (sparks, embers, muzzle grit); alpha for anything that blocks it
 *   (smoke, dust, blood mist). They cannot share a pool: additive smoke never reads as
 *   smoke, and alpha-blended sparks never read as hot. Two draw calls total.
 * - **Decals**, quads oriented to the surface they hit, pooled and age-sorted.
 * - **Debris**, one instanced mesh of shell casings with cheap physics.
 *
 * Particles use a custom shader rather than `PointsMaterial` because per-particle
 * size and alpha are what separate a spark shower from a cloud of identical squares,
 * and `PointsMaterial` supports neither.
 */

const MAX_PARTICLES = 700;      // per pool
const MAX_TRACERS = 48;
const MAX_DECALS = 48;
const MAX_CASINGS = 40;

// ---------------------------------------------------------------- textures

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round dot. The alpha falloff is what stops particles reading as squares. */
function dotTexture() {
  return canvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Lumpy puff for smoke and dust — a plain gradient reads as a glow, not a cloud. */
function smokeTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 26; i++) {
      const r = s * (0.10 + rnd() * 0.20);
      const a = rnd() * 6.283, d = rnd() * s * 0.26;
      const x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.30)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    }
    // fade the rim so the billboard's square edge never shows
    const edge = ctx.createRadialGradient(s / 2, s / 2, s * 0.30, s / 2, s / 2, s / 2);
    edge.addColorStop(0, 'rgba(255,255,255,1)');
    edge.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Four-point flare for the muzzle. */
function flashTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const core = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.30);
    core.addColorStop(0, 'rgba(255,250,235,1)');
    core.addColorStop(0.5, 'rgba(255,205,120,0.75)');
    core.addColorStop(1, 'rgba(255,150,40,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(255,225,170,0.75)';
    ctx.lineWidth = s / 22;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const len = i % 2 === 0 ? s * 0.46 : s * 0.30;
      ctx.beginPath();
      ctx.moveTo(s / 2, s / 2);
      ctx.lineTo(s / 2 + Math.cos(a) * len, s / 2 + Math.sin(a) * len);
      ctx.stroke();
    }
  });
}

/** Bullet hole: dark pit, bright spall ring, radial cracks. */
function bulletHoleTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(190,185,178,0.55)';
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.30, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(150,145,138,0.5)';
    ctx.lineWidth = s / 40;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * 6.283 + 0.4;
      ctx.beginPath();
      ctx.moveTo(s / 2 + Math.cos(a) * s * 0.16, s / 2 + Math.sin(a) * s * 0.16);
      ctx.lineTo(s / 2 + Math.cos(a) * s * 0.42, s / 2 + Math.sin(a) * s * 0.42);
      ctx.stroke();
    }
    const pit = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.19);
    pit.addColorStop(0, 'rgba(6,6,8,0.95)');
    pit.addColorStop(0.7, 'rgba(20,18,18,0.8)');
    pit.addColorStop(1, 'rgba(30,28,28,0)');
    ctx.fillStyle = pit;
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.19, 0, 6.283); ctx.fill();
  });
}

/** Soft scorch ring for explosions. */
function scorchTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Blood splat: irregular blob with cast-off droplets. */
function bloodTexture() {
  return canvasTexture(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    ctx.fillStyle = 'rgba(74,7,10,0.92)';
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * 6.283;
      const r = s * (0.22 + rnd() * 0.10);
      const x = s / 2 + Math.cos(a) * r, y = s / 2 + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
    for (let i = 0; i < 22; i++) {
      const a = rnd() * 6.283, d = s * (0.26 + rnd() * 0.22);
      const r = s * (0.012 + rnd() * 0.035);
      ctx.fillStyle = `rgba(74,7,10,${0.5 + rnd() * 0.4})`;
      ctx.beginPath();
      ctx.arc(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, r, 0, 6.283);
      ctx.fill();
    }
  });
}

// ---------------------------------------------------------------- particles

const PARTICLE_VERT = /* glsl */`
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uScale;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective size attenuation. uScale carries the projection and viewport, so a
    // 5 cm ember is 5 cm at any resolution or field of view.
    gl_PointSize = max(1.0, size * uScale / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    if (tex.a * vAlpha < 0.01) discard;
    gl_FragColor = vec4(vColor, tex.a * vAlpha);
  }
`;

class ParticlePool {
  constructor(scene, { map, blending, depthWrite = false }) {
    this.count = MAX_PARTICLES;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.count * 3);
    this.col = new Float32Array(this.count * 3);
    this.size = new Float32Array(this.count);
    this.alpha = new Float32Array(this.count);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: { value: 500 } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite,
      blending,
      vertexColors: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    // Light and haze, not geometry — kept out of the AO prepass.
    this.points.layers.set(NO_OCCLUDE_LAYER);
    scene.add(this.points);

    this.state = new Array(this.count).fill(null).map(() => ({
      life: 0, maxLife: 1, vel: new THREE.Vector3(),
      grav: 9, drag: 0, size0: 0.1, size1: 0.1, fade: 1,
    }));
    this.cursor = 0;
    for (let i = 0; i < this.count; i++) this.alpha[i] = 0;
  }

  spawn(x, y, z, opts) {
    const i = this.cursor = (this.cursor + 1) % this.count;
    const p = this.state[i];
    p.maxLife = p.life = opts.life;
    p.vel.copy(opts.vel);
    p.grav = opts.grav;
    p.drag = opts.drag ?? 0;
    p.size0 = opts.size0;
    p.size1 = opts.size1 ?? opts.size0;
    p.fade = opts.fade ?? 1;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.col[i * 3] = opts.color[0];
    this.col[i * 3 + 1] = opts.color[1];
    this.col[i * 3 + 2] = opts.color[2];
    this.size[i] = opts.size0;
    this.alpha[i] = p.fade;
    return i;
  }

  update(dt, floorY = 0.02) {
    const { pos, size, alpha, state } = this;
    let live = false;
    for (let i = 0; i < this.count; i++) {
      const p = state[i];
      if (p.life <= 0) continue;
      live = true;
      p.life -= dt;
      if (p.life <= 0) { alpha[i] = 0; continue; }
      const k = 1 - p.life / p.maxLife;          // 0 at birth, 1 at death
      p.vel.y -= p.grav * dt;
      if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      pos[i * 3] += p.vel.x * dt;
      pos[i * 3 + 1] += p.vel.y * dt;
      pos[i * 3 + 2] += p.vel.z * dt;
      // Falling debris settles on the floor instead of dropping through it.
      if (pos[i * 3 + 1] < floorY && p.grav > 0) {
        pos[i * 3 + 1] = floorY;
        p.vel.set(0, 0, 0);
      }
      size[i] = p.size0 + (p.size1 - p.size0) * k;
      alpha[i] = p.fade * (1 - k * k);           // slow start, quick finish
    }
    if (live) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.size.needsUpdate = true;
      this.points.geometry.attributes.alpha.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------- FX

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
// Enough that a firefight never has two shooters sharing one.
const MAX_FLASHES = 8;
const FLASH_LIFE = 0.045;
// Lights are dearer than sprites, so fewer; the pool only has to cover shooters
// firing within 45 ms of each other.
const MAX_FLASH_LIGHTS = 5;
// Metres. Bounds how far a flash can light anything, walls included.
const FLASH_LIGHT_RANGE = 3.5;

const _tracerDir = new THREE.Vector3();
const _decalPos = new THREE.Vector3();
const _decalNormal = new THREE.Vector3();
// Scratch for the casing transform, hoisted so the update loop allocates nothing.
const _m = new THREE.Matrix4();
const _cq = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const FORWARD = new THREE.Vector3(0, 0, 1);

export class FX {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera used to keep particle size in world units
   */
  constructor(scene, camera = null) {
    this.scene = scene;
    this.camera = camera;

    const dot = dotTexture();
    this.hot = new ParticlePool(scene, { map: dot, blending: THREE.AdditiveBlending });
    this.soft = new ParticlePool(scene, { map: smokeTexture(), blending: THREE.NormalBlending });

    // ---- tracers ----
    this.tracers = [];
    const tGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    const tMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tGeo, tMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.layers.set(NO_OCCLUDE_LAYER);
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0, maxLife: 0.06 });
    }
    this.tCursor = 0;

    // ---- muzzle flash ----
    //
    // A pool, not one sprite. There was a single flash for the whole game and whoever
    // fired last took it, so an enemy shooting across the pit stole the flash off the
    // player's own weapon mid-burst.
    const flashTex = flashTexture();
    this.flashes = [];
    for (let i = 0; i < MAX_FLASHES; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flashTex, color: 0xffd9a0, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0,
      }));
      sprite.visible = false;
      sprite.layers.set(NO_OCCLUDE_LAYER);
      scene.add(sprite);
      this.flashes.push({ sprite, life: 0, maxLife: FLASH_LIFE, peak: 1, near: false });
    }
    this.fCursor = 0;
    // Explosions, which genuinely light a room.
    this.flashLight = new THREE.PointLight(0xffc060, 0, 9, 2);
    scene.add(this.flashLight);
    this.flashTime = 0;

    // Muzzle flash lights: a pool, one per shooter, deliberately short-ranged.
    //
    // A firefight in the dark needs these — when the house lights drop, the flashes
    // are the only thing lighting the room. What it does not need is what was here
    // before: one 9 m light teleporting to whoever fired last and sitting on the floor
    // around them for a third of every second, which read as a lamp following each
    // enemy about.
    //
    // FLASH_LIGHT_RANGE is the fix for shining through walls. Point lights do not cast
    // shadows here — six shadow faces per flash is not affordable — so the range is
    // what bounds the leak: a flash cannot light anything more than 3.5 m away,
    // through a wall or otherwise, and certainly not across the arena.
    this.flashLights = [];
    for (let i = 0; i < MAX_FLASH_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffc060, 0, FLASH_LIGHT_RANGE, 2);
      scene.add(light);
      this.flashLights.push({ light, life: 0 });
    }
    this.lCursor = 0;
    this._clock = 0;
    // Last flash per shooter, so sustained fire from any one of them dims — not just
    // the player's. Weak, because combatants are removed when they die.
    this._lastFlashBy = new WeakMap();
    this._lastPlayerFlash = -1;

    // ---- decals ----
    this.decalTextures = {
      hole: bulletHoleTexture(),
      blood: bloodTexture(),
      scorch: scorchTexture(),
    };
    this.decals = [];
    this.decalGeo = new THREE.PlaneGeometry(1, 1);
    this.decalCursor = 0;
    for (let i = 0; i < MAX_DECALS; i++) {
      const m = new THREE.Mesh(this.decalGeo, new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      m.visible = false;
      m.layers.set(NO_OCCLUDE_LAYER);
      scene.add(m);
      this.decals.push({ mesh: m, age: 0, life: 0, grow: 0, base: 1 });
    }

    // ---- shell casings ----
    const casingMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.9 });
    this.casings = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.022, 5), casingMat, MAX_CASINGS,
    );
    this.casings.frustumCulled = false;
    this.casings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.casings);
    this.casingState = new Array(MAX_CASINGS).fill(null).map(() => ({
      life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(),
      rot: new THREE.Euler(),
    }));
    this.casingCursor = 0;
    this._hideAllCasings();
  }

  _hideAllCasings() {
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < MAX_CASINGS; i++) this.casings.setMatrixAt(i, m);
    this.casings.instanceMatrix.needsUpdate = true;
  }

  // -------------------------------------------------------------- emitters

  /**
   * Blood. `dir` is the bullet's travel direction when known, so spray carries on
   * through the target instead of puffing symmetrically out of it.
   */
  blood(pos, dir = null) {
    for (let i = 0; i < 12; i++) {
      _v.set((Math.random() - 0.5) * 2.2, Math.random() * 1.7 + 0.3, (Math.random() - 0.5) * 2.2);
      if (dir) _v.addScaledVector(dir, 2.6 + Math.random() * 3.4);
      this.hot.spawn(pos.x, pos.y, pos.z, {
        life: 0.35 + Math.random() * 0.3, vel: _v, grav: 11,
        color: [0.45, 0.02, 0.03], size0: 0.05 + Math.random() * 0.04, size1: 0.02, fade: 0.95,
      });
    }
    // A short-lived mist sells the hit at distance, where individual droplets vanish.
    for (let i = 0; i < 3; i++) {
      _v.set((Math.random() - 0.5) * 0.7, Math.random() * 0.5, (Math.random() - 0.5) * 0.7);
      this.soft.spawn(pos.x, pos.y, pos.z, {
        life: 0.4 + Math.random() * 0.25, vel: _v, grav: 1.2, drag: 2.4,
        color: [0.30, 0.03, 0.04], size0: 0.12, size1: 0.42, fade: 0.5,
      });
    }
  }

  /** Wall impact: hot spall, a dust puff, and a hole. `dir` orients all three. */
  sparks(pos, dir = null) {
    for (let i = 0; i < 9; i++) {
      _v.set((Math.random() - 0.5) * 3.4, Math.random() * 2.2 + 0.4, (Math.random() - 0.5) * 3.4);
      if (dir) _v.addScaledVector(dir, -(2 + Math.random() * 4));   // spall comes back at the shooter
      this.hot.spawn(pos.x, pos.y, pos.z, {
        life: 0.18 + Math.random() * 0.22, vel: _v, grav: 7,
        color: [1.0, 0.72, 0.28], size0: 0.045, size1: 0.008, fade: 1,
      });
    }
    for (let i = 0; i < 2; i++) {
      _v.set((Math.random() - 0.5) * 0.5, Math.random() * 0.4 + 0.1, (Math.random() - 0.5) * 0.5);
      this.soft.spawn(pos.x, pos.y, pos.z, {
        life: 0.5 + Math.random() * 0.4, vel: _v, grav: -0.3, drag: 1.8,
        color: [0.42, 0.40, 0.37], size0: 0.08, size1: 0.34, fade: 0.24,
      });
    }
    if (dir) this.decal('hole', pos, dir, 0.12 + Math.random() * 0.06, 26, 0.85);
  }

  gasPuff(pos) {
    _v.set((Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.5);
    this.soft.spawn(pos.x, pos.y, pos.z, {
      life: 1.4, vel: _v, grav: -0.5, drag: 0.8,
      color: [0.32, 0.72, 0.24], size0: 0.3, size1: 1.3, fade: 0.30,
    });
  }

  fireEmber(pos) {
    _v.set((Math.random() - 0.5) * 0.7, 1.2 + Math.random() * 1.4, (Math.random() - 0.5) * 0.7);
    this.hot.spawn(pos.x, pos.y, pos.z, {
      life: 0.7 + Math.random() * 0.5, vel: _v, grav: -1.4,
      color: [1.0, 0.45, 0.10], size0: 0.07, size1: 0.015, fade: 1,
    });
    if (Math.random() < 0.4) {
      _v.set((Math.random() - 0.5) * 0.4, 0.9 + Math.random(), (Math.random() - 0.5) * 0.4);
      this.soft.spawn(pos.x, pos.y + 0.2, pos.z, {
        life: 1.1, vel: _v, grav: -0.7, drag: 0.9,
        color: [0.12, 0.11, 0.10], size0: 0.25, size1: 1.1, fade: 0.34,
      });
    }
  }

  tracer(from, to) {
    const len = from.distanceTo(to);
    if (len < 0.5) return;
    const t = this.tracers[this.tCursor = (this.tCursor + 1) % MAX_TRACERS];
    const m = t.mesh;
    // Shorter than the flight path, so the round reads as a bolt in motion rather
    // than a wire connecting the muzzle to the impact — but anchored at the *muzzle*
    // end, not centred on the path.
    //
    // Centring it put a 13 m streak in the middle of a 30 m shot: a bolt hanging in
    // mid-air with nothing joining it to the weapon, and near enough to whoever was
    // being shot at that fire from off to one side read as coming from right behind
    // them. Where a tracer starts is the only cue the receiving end has about where
    // it came from.
    const span = Math.min(len, 4 + len * 0.35);
    _tracerDir.copy(to).sub(from).divideScalar(len);
    m.position.copy(from).addScaledVector(_tracerDir, span * 0.5);
    m.lookAt(to);
    m.scale.set(1, 1, span);
    m.material.opacity = 0.85;
    m.visible = true;
    t.life = t.maxLife;
  }

  /**
   * Muzzle flash: a billboard flare and some grit.
   *
   * `near` marks the player's own weapon, 40 cm from the camera, where the same flash
   * covers a hundred times the screen it does on someone across the pit.
   *
   * Sustained fire is deliberately dimmer than the first round. An automatic at
   * 700 rpm retriggers this every 86 ms against a 50 ms decay, so every frame of a
   * burst was drawn at full opacity, additively, through bloom — a solid white block
   * over the sights for as long as the trigger was held. Real eyes and real cameras
   * both stop responding linearly under that; here it just has to stop blinding.
   */
  muzzleFlash(pos, dir = null, { near = false, source = null } = {}) {
    // Time since *this* shooter last fired. Sustained fire dims for everyone, not
    // only the player: an enemy holding down an automatic strobed at full brightness
    // every frame of the burst.
    let last = -1;
    if (near) { last = this._lastPlayerFlash; this._lastPlayerFlash = this._clock; }
    else if (source) { last = this._lastFlashBy.get(source) ?? -1; this._lastFlashBy.set(source, this._clock); }
    const gap = this._clock - last;
    const sustained = last >= 0 && gap < 0.20;
    // Full brightness for a first shot, falling to a third under sustained fire.
    const peak = sustained ? 0.30 + 0.35 * (gap / 0.20) : 1;

    const f = this.flashes[this.fCursor = (this.fCursor + 1) % MAX_FLASHES];
    f.sprite.position.copy(pos);
    // Small. The flash sits ~40 cm from the first-person camera, so a size that looks
    // reasonable in world terms fills a third of the screen and blinds the shot you
    // are trying to place.
    // The world flash is the smaller of the two. It is additive and it blooms, so a
    // generous one turns into a flare visible from the far end of the arena — the
    // opposite of what a distant muzzle flash should read as.
    const s = (near ? 0.10 + Math.random() * 0.05 : 0.085 + Math.random() * 0.04)
      * (sustained ? 0.78 : 1);
    f.sprite.scale.set(s, s, s);
    f.sprite.material.rotation = Math.random() * Math.PI;
    f.sprite.material.opacity = peak;
    f.sprite.visible = true;
    f.life = FLASH_LIFE;
    f.peak = peak;
    f.near = near;

    const fl = this.flashLights[this.lCursor = (this.lCursor + 1) % MAX_FLASH_LIGHTS];
    fl.light.position.copy(pos);
    fl.light.intensity = (near ? 7 : 5.5) * peak;
    fl.life = FLASH_LIFE;

    for (let i = 0; i < 4; i++) {
      _v.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6);
      if (dir) _v.addScaledVector(dir, 3 + Math.random() * 5);
      this.hot.spawn(pos.x, pos.y, pos.z, {
        life: 0.10 + Math.random() * 0.10, vel: _v, grav: 3,
        color: [1.0, 0.66, 0.24], size0: 0.028, size1: 0.005, fade: 0.9,
      });
    }
    _v.set((Math.random() - 0.5) * 0.3, 0.25, (Math.random() - 0.5) * 0.3);
    if (dir) _v.addScaledVector(dir, 1.2);
    this.soft.spawn(pos.x, pos.y, pos.z, {
      life: 0.5, vel: _v, grav: -0.4, drag: 2.2,
      color: [0.34, 0.32, 0.30], size0: 0.10, size1: 0.55, fade: 0.28,
    });
  }

  /** Eject a spent case. `right` is the shooter's right vector. */
  ejectCasing(pos, right) {
    const i = this.casingCursor = (this.casingCursor + 1) % MAX_CASINGS;
    const c = this.casingState[i];
    c.life = 2.2;
    c.pos.copy(pos);
    c.vel.set(
      right.x * (1.6 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.4,
      1.4 + Math.random() * 0.8,
      right.z * (1.6 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.4,
    );
    c.spin.set(12 + Math.random() * 14, 8 + Math.random() * 12, 6 + Math.random() * 10);
    c.rot.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
  }

  explosion(pos) {
    for (let i = 0; i < 34; i++) {
      _v.set((Math.random() - 0.5) * 9, Math.random() * 6 + 1, (Math.random() - 0.5) * 9);
      this.hot.spawn(pos.x, pos.y, pos.z, {
        life: 0.35 + Math.random() * 0.4, vel: _v, grav: 9,
        color: [1.0, 0.62, 0.20], size0: 0.16, size1: 0.02, fade: 1,
      });
    }
    for (let i = 0; i < 16; i++) {
      _v.set((Math.random() - 0.5) * 4.5, Math.random() * 3 + 0.5, (Math.random() - 0.5) * 4.5);
      this.soft.spawn(pos.x, pos.y + 0.2, pos.z, {
        life: 1.1 + Math.random() * 0.9, vel: _v, grav: -0.6, drag: 1.3,
        color: [0.16, 0.15, 0.14], size0: 0.4, size1: 2.6, fade: 0.5,
      });
    }
    this.flashLight.position.set(pos.x, pos.y + 0.6, pos.z);
    this.flashLight.intensity = 220;
    this.flashTime = 0.22;
    _decalPos.set(pos.x, Math.max(0.02, pos.y - 0.06), pos.z);
    this.decal('scorch', _decalPos, UP, 2.4, 1.2, 0.85);
  }

  bloodPool(pos) {
    _decalPos.set(pos.x, pos.y + 0.02, pos.z);
    _decalNormal.set(0, 1, 0);
    this.decal('blood', _decalPos, _decalNormal, 1.1, 1.4, 0.9);
  }

  /**
   * Place a decal on a surface.
   *
   * `normal` is the surface it lies on. For bullet impacts the true face normal would
   * need the collider to report which face it hit; the shot direction is used instead,
   * which is within a few degrees for anything but a grazing hit and needs no changes
   * to the ballistics path. `polygonOffset` on the material keeps it off the wall.
   */
  decal(kind, pos, normal, size, growTime, opacity) {
    const d = this.decals[this.decalCursor = (this.decalCursor + 1) % MAX_DECALS];
    const map = this.decalTextures[kind];
    d.mesh.material.map = map;
    d.mesh.material.color.set(kind === 'scorch' ? 0x0e0d0c : 0xffffff);
    d.mesh.material.needsUpdate = true;
    _n.copy(normal).normalize();
    if (_n.lengthSq() < 0.5) _n.set(0, 1, 0);
    // Decals face *out* of the surface, so flip an inbound shot direction.
    if (kind === 'hole') _n.negate();
    _q.setFromUnitVectors(FORWARD, _n);
    d.mesh.quaternion.copy(_q);
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    d.mesh.position.copy(pos).addScaledVector(_n, 0.015);
    d.base = size;
    d.grow = growTime;
    d.age = 0;
    d.life = kind === 'hole' ? 30 : 999;
    d.mesh.scale.setScalar(growTime > 1 ? size * 0.2 : size);
    d.mesh.material.opacity = opacity;
    d.peak = opacity;
    d.mesh.visible = true;
  }

  // -------------------------------------------------------------- update

  update(dt) {
    this._clock += dt;
    // Keep particle size in world units: the shader needs the projection scale and
    // the viewport height, which change with the window and the adaptive resolution.
    if (this.camera) {
      const scale = this.camera.projectionMatrix.elements[5] * window.innerHeight * 0.5;
      this.hot.material.uniforms.uScale.value = scale;
      this.soft.material.uniforms.uScale.value = scale;
    }
    this.hot.update(dt);
    this.soft.update(dt);

    for (const t of this.tracers) {
      if (!t.mesh.visible) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / t.maxLife) * 0.85;
      if (t.life <= 0) t.mesh.visible = false;
    }

    for (const f of this.flashes) {
      if (!f.sprite.visible) continue;
      f.life -= dt;
      if (f.life <= 0) { f.sprite.visible = false; f.sprite.material.opacity = 0; continue; }
      f.sprite.material.opacity = (f.life / f.maxLife) * f.peak;
    }

    for (const fl of this.flashLights) {
      if (fl.life <= 0) continue;
      fl.life -= dt;
      if (fl.life <= 0) fl.light.intensity = 0;
      else fl.light.intensity *= 0.62;
    }

    // Explosions only.
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) this.flashLight.intensity = 0;
      else this.flashLight.intensity *= 0.75;
    }

    this._updateCasings(dt);

    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      d.age += dt;
      if (d.age < d.grow) {
        const k = d.age / d.grow;
        d.mesh.scale.setScalar(d.base * (0.2 + 0.8 * k));
      }
      if (d.life < 900) {
        // Bullet holes fade out; blood and scorch stay for the bout.
        const remaining = d.life - d.age;
        if (remaining < 4) d.mesh.material.opacity = d.peak * Math.max(0, remaining / 4);
        if (remaining <= 0) d.mesh.visible = false;
      }
    }
  }

  _updateCasings(dt) {
    let any = false;
    for (let i = 0; i < MAX_CASINGS; i++) {
      const c = this.casingState[i];
      if (c.life <= 0) continue;
      any = true;
      c.life -= dt;
      c.vel.y -= 13 * dt;
      c.pos.addScaledVector(c.vel, dt);
      if (c.pos.y < 0.012) {
        c.pos.y = 0.012;
        // One lossy bounce, then it lies there until it expires.
        if (c.vel.y < -0.4) { c.vel.y *= -0.32; c.vel.x *= 0.5; c.vel.z *= 0.5; c.spin.multiplyScalar(0.4); }
        else { c.vel.set(0, 0, 0); c.spin.set(0, 0, 0); }
      }
      c.rot.x += c.spin.x * dt; c.rot.y += c.spin.y * dt; c.rot.z += c.spin.z * dt;
      if (c.life <= 0) {
        _m.makeScale(0, 0, 0);          // retired: collapse it rather than hide the batch
      } else {
        _cq.setFromEuler(c.rot);
        _m.compose(c.pos, _cq, _one);
      }
      this.casings.setMatrixAt(i, _m);
    }
    if (any) this.casings.instanceMatrix.needsUpdate = true;
  }
}
