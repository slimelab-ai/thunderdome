import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Collider } from './collider.js';

// Arena footprint: X in [-W/2, W/2], Z in [-D/2, D/2]. Player gate south (+Z), enemy gate north (-Z).
export const ARENA = { W: 44, D: 32, WALL_H: 5 };

const propLoader = new GLTFLoader();
const propCache = new Map();

function loadProp(scene, file, position, rotationY, scale, fallback) {
  const install = (source) => {
    const prop = source.clone(true);
    prop.position.copy(position);
    prop.rotation.y = rotationY;
    prop.scale.copy(scale);
    prop.traverse((child) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    scene.add(prop);
  };
  let entry = propCache.get(file);
  if (!entry) {
    entry = propLoader.loadAsync(`/assets/models/${file}.glb`).then((gltf) => {
      propCache.set(file, gltf);
      return gltf;
    });
    propCache.set(file, entry);
  }
  if (entry.scene) {
    install(entry.scene);
  } else {
    // NB: pending waiters must unwrap .scene themselves — handing `install` the raw
    // GLTF result made every instance after the first silently fall back to primitives
    entry.then((gltf) => install(gltf.scene)).catch((err) => {
      console.warn(`Could not load authored prop ${file}; using primitive fallback.`, err);
      propCache.delete(file);
      fallback();
    });
  }
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function concreteTex(base = '#3a3a3e', size = 512) {
  return canvasTex(size, size, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 5000; i++) {
      const v = Math.random() * 30 - 15;
      ctx.fillStyle = `rgba(${128 + v},${128 + v},${132 + v},0.08)`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
    // cracks
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      let x = Math.random() * size, y = Math.random() * size;
      ctx.moveTo(x, y);
      for (let j = 0; j < 6; j++) { x += Math.random() * 60 - 30; y += Math.random() * 60 - 30; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    // old blood stains
    for (let i = 0; i < 9; i++) {
      const x = Math.random() * size, y = Math.random() * size, r = 8 + Math.random() * 30;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(70,10,10,0.35)');
      g.addColorStop(1, 'rgba(70,10,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    // grime edges
    const gr = ctx.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.7);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, size, size);
  });
}

function neonSignTex(text, color = '#ff2233', sub = '') {
  return canvasTex(1024, 256, (ctx) => {
    ctx.fillStyle = '#050507';
    ctx.fillRect(0, 0, 1024, 256);
    ctx.textAlign = 'center';
    ctx.font = '900 130px Impact, Arial Black, sans-serif';
    ctx.shadowColor = color; ctx.shadowBlur = 45;
    ctx.fillStyle = color;
    ctx.fillText(text, 512, sub ? 140 : 165);
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#fff';
    ctx.font = '900 124px Impact, Arial Black, sans-serif';
    ctx.globalAlpha = 0.25;
    ctx.fillText(text, 512, sub ? 140 : 165);
    ctx.globalAlpha = 1;
    if (sub) {
      ctx.shadowBlur = 12; ctx.shadowColor = '#ffb92e';
      ctx.fillStyle = '#ffb92e';
      ctx.font = '700 44px Impact, Arial Black, sans-serif';
      ctx.fillText(sub, 512, 210);
    }
  });
}

function oddsBoardTex(lines) {
  return canvasTex(512, 512, (ctx) => {
    ctx.fillStyle = '#0a0c0a'; ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#1d2a1d'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, 504, 504);
    ctx.font = '700 40px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.shadowColor = '#3fda5f'; ctx.shadowBlur = 8;
    ctx.fillStyle = '#3fda5f';
    ctx.fillText('TONIGHT’S ODDS', 30, 70);
    ctx.font = '400 34px Consolas, monospace';
    lines.forEach((l, i) => ctx.fillText(l, 30, 140 + i * 56));
  });
}

export function buildArena(scene) {
  const { W, D, WALL_H } = ARENA;
  const colliders = [];      // THREE.Box3 solid obstacles
  const lights = [];         // dimmable lights for LIGHTS OUT
  const crowd = [];          // animated crowd silhouettes
  const dynamic = [];        // {update(t)} misc animated things

  const addCollider = (cx, cy, cz, w, h, d, ry = 0) => {
    colliders.push(new Collider(cx, cy, cz, w, h, d, ry));
  };

  // ---------- floor ----------
  const floorTex = concreteTex('#38383c');
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(6, 4);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshLambertMaterial({ map: floorTex })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // ring markings
  const ringTex = canvasTex(512, 512, (ctx) => {
    ctx.clearRect(0, 0, 512, 512);
    ctx.strokeStyle = 'rgba(227,36,43,0.5)'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(256, 256, 200, 0, 7); ctx.stroke();
    ctx.font = '900 90px Impact'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(227,36,43,0.4)';
    ctx.fillText('TDX', 256, 290);
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // ---------- walls ----------
  const wallTex = concreteTex('#26262b');
  wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
  wallTex.repeat.set(5, 1);
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
  const mkWall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z);
    scene.add(m);
  };
  mkWall(W + 2, WALL_H, 1, 0, WALL_H / 2, -D / 2 - 0.5);
  mkWall(W + 2, WALL_H, 1, 0, WALL_H / 2, D / 2 + 0.5);
  mkWall(1, WALL_H, D + 2, -W / 2 - 0.5, WALL_H / 2, 0);
  mkWall(1, WALL_H, D + 2, W / 2 + 0.5, WALL_H / 2, 0);
  addCollider(0, 0, -D / 2 - 0.5, W + 4, WALL_H, 1);
  addCollider(0, 0, D / 2 + 0.5, W + 4, WALL_H, 1);
  addCollider(-W / 2 - 0.5, 0, 0, 1, WALL_H, D + 4);
  addCollider(W / 2 + 0.5, 0, 0, 1, WALL_H, D + 4);

  // upper mezzanine ring (visual, above walls) where the crowd stands
  const mezz = new THREE.Mesh(
    new THREE.BoxGeometry(W + 10, 0.6, D + 10),
    new THREE.MeshLambertMaterial({ color: 0x141418 })
  );
  mezz.position.y = WALL_H + 0.3;
  // punch a hole illusion: actually build 4 slabs around the opening
  scene.remove(mezz);
  const slabMat = new THREE.MeshLambertMaterial({ color: 0x111115 });
  const mkSlab = (w, d, x, z) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.6, d), slabMat);
    s.position.set(x, WALL_H + 0.3, z);
    scene.add(s);
  };
  mkSlab(W + 12, 5, 0, -D / 2 - 3);
  mkSlab(W + 12, 5, 0, D / 2 + 3);
  mkSlab(5, D + 12, -W / 2 - 3, 0);
  mkSlab(5, D + 12, W / 2 + 3, 0);

  // rusty cage fence above walls (visual)
  const fenceMat = new THREE.MeshBasicMaterial({ color: 0x0c0c10, transparent: true, opacity: 0.7, wireframe: true });
  const mkFence = (w, x, z, ry) => {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(w, 2.2, Math.round(w / 1.2), 3), fenceMat);
    f.position.set(x, WALL_H + 1.4, z);
    f.rotation.y = ry;
    scene.add(f);
  };
  mkFence(W, 0, -D / 2, 0);
  mkFence(W, 0, D / 2, Math.PI);
  mkFence(D, -W / 2, 0, Math.PI / 2);
  mkFence(D, W / 2, 0, -Math.PI / 2);

  // ---------- crowd silhouettes ----------
  const crowdMat = new THREE.MeshBasicMaterial({ color: 0x060608 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0x08080b });
  const ringPts = [];
  for (let x = -W / 2 - 1; x <= W / 2 + 1; x += 1.4) { ringPts.push([x, -D / 2 - 1.6]); ringPts.push([x, D / 2 + 1.6]); }
  for (let z = -D / 2 - 1; z <= D / 2 + 1; z += 1.4) { ringPts.push([-W / 2 - 1.6, z]); ringPts.push([W / 2 + 1.6, z]); }
  for (const [x, z] of ringPts) {
    if (Math.random() < 0.18) continue;
    const h = 0.9 + Math.random() * 0.5;
    const person = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55 + Math.random() * 0.2, h, 0.35), crowdMat);
    body.position.y = h / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), headMat);
    head.position.y = h + 0.16;
    person.add(body, head);
    person.position.set(x + (Math.random() - 0.5) * 0.4, WALL_H + 0.6, z + (Math.random() - 0.5) * 0.4);
    person.userData.phase = Math.random() * 7;
    person.userData.baseY = person.position.y;
    scene.add(person);
    crowd.push(person);
  }

  // ---------- cover objects ----------
  const crateTex = concreteTex('#4a3d2a', 256);
  const crateMat = new THREE.MeshLambertMaterial({ map: crateTex });
  const metalMat = new THREE.MeshLambertMaterial({ color: 0x5c636b });
  const rustMat = new THREE.MeshLambertMaterial({ color: 0x5a3a26 });
  const concMat = new THREE.MeshLambertMaterial({ map: concreteTex('#45454a', 256) });

  // Props can rotate freely — colliders are true OBBs matching the mesh exactly.
  const addBox = (mat, cx, cz, w, h, d, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(cx, h / 2, cz);
    m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    addCollider(cx, 0, cz, w, h, d, ry);
    return m;
  };

  const addBarrel = (cx, cz) => {
    loadProp(scene, 'hazard_barrel', new THREE.Vector3(cx, 0, cz), 0, new THREE.Vector3(1, 1, 1), () => {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 10), rustMat);
      b.position.set(cx, 0.55, cz);
      b.castShadow = true;
      scene.add(b);
    });
    addCollider(cx, 0, cz, 0.85, 1.1, 0.85);
  };

  const addAuthoredBox = (file, fallbackMat, cx, cz, w, h, d, ry, nativeSize) => {
    const fallback = () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), fallbackMat);
      m.position.set(cx, h / 2, cz);
      m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    };
    loadProp(
      scene, file, new THREE.Vector3(cx, 0, cz), ry,
      new THREE.Vector3(w / nativeSize.x, h / nativeSize.y, d / nativeSize.z),
      fallback,
    );
    addCollider(cx, 0, cz, w, h, d, ry);
  };

  // central raised slab + pillars
  addBox(concMat, 0, 0, 5, 0.55, 5);
  const pillarPos = [[-9, -6], [9, -6], [-9, 6], [9, 6]];
  for (const [x, z] of pillarPos) {
    addBox(concMat, x, z, 1.4, WALL_H, 1.4);
  }

  // crates & stacks
  const crateSize = new THREE.Vector3(2.2, 1.4, 1.8);
  addAuthoredBox('weapons_crate', crateMat, -15, -9, 2.2, 1.4, 1.8, 0.2, crateSize);
  addAuthoredBox('weapons_crate', crateMat, -14.4, -8.3, 1.4, 2.6, 1.4, 0.5, crateSize);
  addAuthoredBox('weapons_crate', crateMat, 15, 9, 1.8, 1.4, 2.2, -0.3, crateSize);
  addAuthoredBox('weapons_crate', crateMat, 14.2, 8.2, 1.4, 2.6, 1.4, 0.1, crateSize);
  addAuthoredBox('weapons_crate', crateMat, -4, 10, 1.8, 1.2, 2.1, 0.4, crateSize);
  addAuthoredBox('weapons_crate', crateMat, 5, -10.5, 2.1, 1.2, 1.8, -0.2, crateSize);
  addAuthoredBox('weapons_crate', crateMat, 13, -6, 1.6, 1.1, 1.9, 0.9, crateSize);
  addAuthoredBox('weapons_crate', crateMat, -13, 6, 1.9, 1.1, 1.6, 0.3, crateSize);

  // low sandbag-style walls (shoot over standing, hide crouched)
  const barrierSize = new THREE.Vector3(4.2, 1.05, 0.6);
  addAuthoredBox('concrete_barricade', metalMat, -6, -3.5, 4.2, 1.05, 0.6, 0, barrierSize);
  addAuthoredBox('concrete_barricade', metalMat, 6, 3.5, 4.2, 1.05, 0.6, 0, barrierSize);
  addAuthoredBox('concrete_barricade', metalMat, -13, 1, 3.4, 1.05, 0.7, 0.5, barrierSize);
  addAuthoredBox('concrete_barricade', metalMat, 13, -1, 3.4, 1.05, 0.7, 0.5, barrierSize);

  // ---- sightline breakers: no spawn-to-spawn LOS ----
  // gate screens: a full-height wall shields each spawn; you exit around its edges
  addBox(concMat, 0, -10.5, 8, 2.6, 0.9);
  addBox(concMat, 0, 10.5, 8, 2.6, 0.9);
  // angled wing walls flanking each screen: covered diagonal lanes out of the pocket,
  // so leaving spawn isn't a coin-flip between two watched gaps
  addBox(concMat, -7, 11.6, 3.6, 2.5, 0.8, -0.55);
  addBox(concMat, 7, 11.6, 3.6, 2.5, 0.8, 0.55);
  addBox(concMat, -7, -11.6, 3.6, 2.5, 0.8, 0.55);
  addBox(concMat, 7, -11.6, 3.6, 2.5, 0.8, -0.55);
  // tall crates shadowing the mid-flank runs (cover-hop routes toward the gantries)
  addBox(crateMat, -10.5, 8.3, 1.7, 2.4, 1.7, 0.3);
  addBox(crateMat, 10.5, -8.3, 1.7, 2.4, 1.7, -0.3);
  // central monolith rising from the slab — kills the middle lane
  addBox(concMat, 0, 0, 6, 2.8, 1.6);
  addBox(concMat, 9, -11, 1.2, 2.4, 3, 0);
  addBox(concMat, -9, 11, 1.2, 2.4, 3, 0);

  // ---- verticality: flank gantries (2.25m platforms, stair runs both ends) ----
  const addRaisedBox = (mat, cx, baseY, cz, w, h, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(cx, baseY + h / 2, cz);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    addCollider(cx, baseY, cz, w, h, d);
  };
  const addAuthoredRaisedBox = (file, fallbackMat, cx, baseY, cz, w, h, d, nativeSize) => {
    const fallback = () => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), fallbackMat);
      m.position.set(cx, baseY + h / 2, cz);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    };
    loadProp(
      scene, file, new THREE.Vector3(cx, baseY, cz), 0,
      new THREE.Vector3(w / nativeSize.x, h / nativeSize.y, d / nativeSize.z),
      fallback,
    );
    addCollider(cx, baseY, cz, w, h, d);
  };
  const gantry = (gx) => {
    const inner = gx > 0 ? gx - 2.5 : gx + 2.5; // arena-facing edge x
    // hollow deck on legs — you can fight underneath it
    addAuthoredRaisedBox('gantry_deck', concMat, gx, 1.95, 0, 5, 0.3, 4, new THREE.Vector3(5, 0.3, 4));
    for (const [lx, lz] of [[-2.2, -1.7], [2.2, -1.7], [-2.2, 1.7], [2.2, 1.7]]) {
      addBox(metalMat, gx + lx, lz, 0.3, 1.95, 0.3);
    }
    // stair runs, north and south: 4 steps × 0.45 rise × 0.8 deep
    for (let i = 1; i <= 4; i++) {
      const top = 2.25 - 0.45 * i;
      const zOff = 2 + (i - 0.5) * 0.8;
      addBox(concMat, gx, zOff, 4, top, 0.8);
      addBox(concMat, gx, -zOff, 4, top, 0.8);
    }
    // shoot-over rail on the arena-facing edge (cover when crouched up top)
    addRaisedBox(metalMat, inner + (gx > 0 ? -0.15 : 0.15), 2.25, 0, 0.25, 0.95, 4);
  };
  gantry(16.5);
  gantry(-16.5);

  // wrecked car
  loadProp(scene, 'wrecked_car', new THREE.Vector3(8, 0, -8.5), 0.4, new THREE.Vector3(1, 1, 1), () => {
    const car = new THREE.Group();
    const carBody = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.1, 1.9), new THREE.MeshLambertMaterial({ color: 0x3a2f2f }));
    carBody.position.y = 0.75;
    const carTop = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 1.7), new THREE.MeshLambertMaterial({ color: 0x2c2424 }));
    carTop.position.set(-0.3, 1.6, 0);
    car.add(carBody, carTop);
    car.position.set(8, 0, -8.5);
    car.rotation.y = 0.4;
    scene.add(car);
  });
  addCollider(8, 0, -8.5, 4.2, 2, 1.9, 0.4);

  // barrels
  addBarrel(-2.2, -12.5); addBarrel(-3.1, -12.1); addBarrel(2.4, 12.4); addBarrel(3.3, 12.0);
  addBarrel(-18.5, -11); addBarrel(18.5, 11); addBarrel(-11, 11.5); addBarrel(11, -12);

  // ---------- gates ----------
  const gateMat = new THREE.MeshLambertMaterial({ color: 0x191920 });
  const mkGate = (z, rot) => {
    loadProp(scene, 'arena_gate', new THREE.Vector3(0, 0, z), rot, new THREE.Vector3(1, 1, 1), () => {
      const gate = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.6, 0.6), gateMat);
      frame.position.y = 1.8;
      gate.add(frame);
      gate.position.set(0, 0, z);
      gate.rotation.y = rot;
      scene.add(gate);
    });
  };
  mkGate(-D / 2 - 0.1, 0);
  mkGate(D / 2 + 0.1, Math.PI);

  // ---------- signage ----------
  const mkSign = (tex, w, h, x, y, z, ry) => {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: false }));
    s.position.set(x, y, z);
    s.rotation.y = ry;
    scene.add(s);
    return s;
  };
  mkSign(neonSignTex('THE PIT', '#ff2233', 'UNDERGROUND KILL LEAGUE'), 12, 3, 0, WALL_H + 2.6, -D / 2 - 0.4, 0);
  mkSign(neonSignTex('BLOOD PAYS', '#ffb92e'), 10, 2.5, 0, WALL_H + 2.4, D / 2 + 0.4, Math.PI);
  mkSign(neonSignTex('NO MERCY', '#86ff3c'), 8, 2, -W / 2 - 0.4, WALL_H + 2.2, 0, Math.PI / 2);
  const odds = mkSign(oddsBoardTex(['HOUSE  ALWAYS', 'WINS', '', 'YOU    9 : 1']), 5, 5, W / 2 + 0.4, WALL_H + 2.8, 0, -Math.PI / 2);

  // ---------- lighting ----------
  scene.fog = new THREE.FogExp2(0x07070a, 0.011);
  const hemi = new THREE.HemisphereLight(0x6a6a7a, 0x1e1a18, 1.15);
  scene.add(hemi);
  lights.push({ light: hemi, base: 1.15 });

  const amb = new THREE.AmbientLight(0x30303a, 0.7);
  scene.add(amb);
  lights.push({ light: amb, base: 0.7 });

  const overhead = new THREE.SpotLight(0xfff2dd, 900, 60, 1.05, 0.5, 1.4);
  overhead.position.set(0, 16, 0);
  overhead.target.position.set(0, 0, 0);
  overhead.castShadow = true;
  overhead.shadow.mapSize.set(1024, 1024);
  overhead.shadow.camera.near = 4;
  overhead.shadow.camera.far = 40;
  scene.add(overhead, overhead.target);
  lights.push({ light: overhead, base: 900 });

  // colored corner spots
  const cornerCols = [0xff3040, 0x3060ff, 0xffb92e, 0x30ff80];
  [[-W / 2 + 3, -D / 2 + 3], [W / 2 - 3, -D / 2 + 3], [-W / 2 + 3, D / 2 - 3], [W / 2 - 3, D / 2 - 3]].forEach(([x, z], i) => {
    const p = new THREE.PointLight(cornerCols[i], 140, 32, 1.7);
    p.position.set(x, WALL_H + 1.5, z);
    scene.add(p);
    lights.push({ light: p, base: 140 });
  });

  // sweeping spotlights
  const sweepers = [];
  for (let i = 0; i < 2; i++) {
    const sp = new THREE.SpotLight(i === 0 ? 0xff4455 : 0x66aaff, 500, 55, 0.3, 0.5, 1.6);
    sp.position.set(i === 0 ? -10 : 10, 15, 0);
    scene.add(sp, sp.target);
    sweepers.push(sp);
    lights.push({ light: sp, base: 500 });
  }
  dynamic.push({
    update(t) {
      sweepers[0].target.position.set(Math.sin(t * 0.45) * 15, 0, Math.cos(t * 0.32) * 10);
      sweepers[1].target.position.set(Math.cos(t * 0.38) * 15, 0, Math.sin(t * 0.5) * 10);
    }
  });

  // red emergency strobe (used by LIGHTS OUT — off normally)
  const strobe = new THREE.PointLight(0xff2020, 0, 45, 1.2);
  strobe.position.set(0, WALL_H + 3, 0);
  scene.add(strobe);

  // spawn points
  const spawns = {
    player: new THREE.Vector3(0, 0, D / 2 - 2.5),
    playerCrew: [
      new THREE.Vector3(-2.2, 0, D / 2 - 2), new THREE.Vector3(2.2, 0, D / 2 - 2),
      new THREE.Vector3(-4.2, 0, D / 2 - 3), new THREE.Vector3(4.2, 0, D / 2 - 3),
      new THREE.Vector3(0, 0, D / 2 - 4),
    ],
    enemy: [
      new THREE.Vector3(0, 0, -D / 2 + 2.5),
      new THREE.Vector3(-3, 0, -D / 2 + 2),
      new THREE.Vector3(3, 0, -D / 2 + 2),
      new THREE.Vector3(-6, 0, -D / 2 + 3),
      new THREE.Vector3(6, 0, -D / 2 + 3),
    ],
  };

  return { colliders, lights, crowd, dynamic, spawns, strobe, oddsSign: odds };
}

export function updateArenaAmbience(arena, t) {
  for (const p of arena.crowd) {
    p.position.y = p.userData.baseY + Math.sin(t * 2.2 + p.userData.phase) * 0.05;
  }
  for (const d of arena.dynamic) d.update(t);
}
