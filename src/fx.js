import * as THREE from 'three';

const MAX_PARTICLES = 600;
const MAX_TRACERS = 48;

export class FX {
  constructor(scene) {
    this.scene = scene;

    // ---- particle pool (Points) ----
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    const mat = new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.particles = new Array(MAX_PARTICLES).fill(null).map(() => ({ life: 0, vel: new THREE.Vector3(), grav: 9 }));
    this.pCursor = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) this.pPos[i * 3 + 1] = -100;

    // ---- tracer pool ----
    this.tracers = [];
    const tGeo = new THREE.BoxGeometry(0.018, 0.018, 1);
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }
    this.tCursor = 0;

    // ---- muzzle flash light (shared) ----
    this.flashLight = new THREE.PointLight(0xffc060, 0, 9, 2);
    scene.add(this.flashLight);
    this.flashTime = 0;

    // ---- blood decals ----
    this.decals = [];
    this.decalGeo = new THREE.CircleGeometry(0.5, 12);
  }

  spawnParticles(pos, count, { color = [0.6, 0.02, 0.02], spread = 2.5, up = 1.5, grav = 9, jitterColor = 0.15 } = {}) {
    for (let n = 0; n < count; n++) {
      const i = this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;
      const p = this.particles[i];
      p.life = 0.45 + Math.random() * 0.4;
      p.grav = grav;
      p.vel.set((Math.random() - 0.5) * spread, Math.random() * up + 0.4, (Math.random() - 0.5) * spread);
      this.pPos[i * 3] = pos.x; this.pPos[i * 3 + 1] = pos.y; this.pPos[i * 3 + 2] = pos.z;
      const j = (Math.random() - 0.5) * jitterColor;
      this.pCol[i * 3] = color[0] + j; this.pCol[i * 3 + 1] = color[1] + j * 0.4; this.pCol[i * 3 + 2] = color[2] + j * 0.4;
    }
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  blood(pos) { this.spawnParticles(pos, 14, { color: [0.55, 0.02, 0.03], spread: 2.2, up: 1.6 }); }
  sparks(pos) { this.spawnParticles(pos, 8, { color: [1.0, 0.75, 0.3], spread: 3.4, up: 2.2, grav: 6 }); }
  gasPuff(pos) { this.spawnParticles(pos, 2, { color: [0.35, 0.8, 0.25], spread: 0.8, up: 0.9, grav: -0.4 }); }
  fireEmber(pos) { this.spawnParticles(pos, 2, { color: [1.0, 0.5, 0.1], spread: 0.7, up: 1.8, grav: -1.2 }); }

  tracer(from, to) {
    const t = this.tracers[this.tCursor = (this.tCursor + 1) % MAX_TRACERS];
    const m = t.mesh;
    const len = from.distanceTo(to);
    if (len < 0.5) return;
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.lookAt(to);
    m.scale.set(1, 1, len);
    m.material.opacity = 0.75;
    m.visible = true;
    t.life = 0.07;
  }

  muzzleFlash(pos) {
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = 26;
    this.flashTime = 0.05;
  }

  bloodPool(pos) {
    const m = new THREE.Mesh(this.decalGeo, new THREE.MeshBasicMaterial({ color: 0x3d0508, transparent: true, opacity: 0.85, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, pos.y + 0.015 + this.decals.length * 0.0004, pos.z);
    m.scale.set(0.2, 0.2, 0.2);
    this.scene.add(m);
    this.decals.push({ mesh: m, age: 0 });
    if (this.decals.length > 24) {
      const old = this.decals.shift();
      this.scene.remove(old.mesh);
      old.mesh.material.dispose();
    }
  }

  update(dt) {
    // particles
    const pos = this.pPos;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vel.y -= p.grav * dt;
      pos[i * 3] += p.vel.x * dt;
      pos[i * 3 + 1] += p.vel.y * dt;
      pos[i * 3 + 2] += p.vel.z * dt;
      if (pos[i * 3 + 1] < 0.02 && p.grav > 0) { pos[i * 3 + 1] = 0.02; p.vel.set(0, 0, 0); }
      if (p.life <= 0) pos[i * 3 + 1] = -100;
    }
    this.points.geometry.attributes.position.needsUpdate = true;

    // tracers
    for (const t of this.tracers) {
      if (!t.mesh.visible) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / 0.07) * 0.75;
      if (t.life <= 0) t.mesh.visible = false;
    }

    // flash
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      if (this.flashTime <= 0) this.flashLight.intensity = 0;
      else this.flashLight.intensity *= 0.75;
    }

    // decals grow in
    for (const d of this.decals) {
      if (d.age < 1.2) {
        d.age += dt;
        const s = 0.2 + Math.min(1, d.age / 1.2) * 0.9;
        d.mesh.scale.set(s, s, s);
      }
    }
  }
}
