import * as THREE from 'three';
import { versioned } from './asset-version.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Collider, CylinderCollider } from './collider.js';
import { surface, worldUV, bindAuthoredMaterials } from './materials.js';
import { MeshCollider, collectTriangles } from './meshcollider.js';

// Arena footprint: X in [-W/2, W/2], Z in [-D/2, D/2]. Player gate south (+Z), enemy gate north (-Z).
export const ARENA = { W: 44, D: 32, WALL_H: 5 };

const propLoader = new GLTFLoader();
const propCache = new Map();

/**
 * Prop placement batching.
 *
 * Props are queued during the build and resolved once, as `InstancedMesh` batches —
 * every arena block in the pit is one draw call per material instead of one per
 * block. That is where the draw-call budget was going: twenty blocks and eight
 * crates, each a separate cloned `Group` with two to four material groups, came to
 * well over a hundred calls on their own.
 *
 * Batching is only correct because the props are *identical geometry at different
 * transforms* — the per-placement size differences are non-uniform scales baked into
 * the instance matrix, not different meshes.
 */
class PropBatcher {
  constructor() {
    this.queued = new Map();   // file -> [{ matrix, fallback }]
  }

  /** Queue one placement. Cheap and synchronous; nothing loads until `resolve`. */
  place(file, position, rotationY, scale, fallback) {
    const matrix = new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0)),
      scale,
    );
    if (!this.queued.has(file)) this.queued.set(file, []);
    this.queued.get(file).push({ matrix, fallback });
  }

  /** Load every queued prop and build its batches. Returns a promise per file. */
  resolve(scene) {
    const pending = [];
    for (const [file, placements] of this.queued) {
      let entry = propCache.get(file);
      if (!entry) {
        entry = propLoader.loadAsync(versioned(`/assets/models/${file}.glb`)).then((gltf) => {
          bindAuthoredMaterials(gltf.scene);
          return gltf;
        });
        propCache.set(file, entry);
      }
      pending.push(Promise.resolve(entry)
        .then((gltf) => this._build(scene, gltf.scene, placements))
        .catch((err) => {
          console.warn(`Could not load authored prop ${file}; using primitive fallbacks.`, err);
          propCache.delete(file);
          for (const p of placements) p.fallback?.();
        }));
    }
    return Promise.allSettled(pending);
  }

  _build(scene, source, placements) {
    source.updateMatrixWorld(true);
    const combined = new THREE.Matrix4();
    source.traverse((child) => {
      if (!child.isMesh) return;
      const mesh = new THREE.InstancedMesh(child.geometry, child.material, placements.length);
      placements.forEach((p, i) => {
        // The prop's own transform inside the GLB has to compose with the placement,
        // or a mesh that sits off-origin in its file lands in the wrong spot.
        combined.multiplyMatrices(p.matrix, child.matrixWorld);
        mesh.setMatrixAt(i, combined);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // A batch spans the whole arena, so its bounding sphere is never a useful cull
      // and computing one from instances would only cost time.
      mesh.frustumCulled = false;
      scene.add(mesh);
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

/**
 * Signage is the one place canvas textures still earn their keep: the art is text,
 * it changes with game state, and it is emissive rather than lit.
 */
function neonSignTex(text, color = '#ff2233', sub = '') {
  return canvasTex(1024, 256, (ctx) => {
    ctx.fillStyle = '#08080b';
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
    ctx.fillStyle = '#07090a'; ctx.fillRect(0, 0, 512, 512);
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

/** The jumbotron: scanline-striped house branding, the brightest thing in the room. */
function jumbotronTex() {
  return canvasTex(1024, 512, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#2a0206');
    g.addColorStop(1, '#08060a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
    ctx.textAlign = 'center';
    ctx.shadowColor = '#ff2833'; ctx.shadowBlur = 60;
    ctx.fillStyle = '#ff3641';
    ctx.font = '900 210px Impact, Arial Black, sans-serif';
    ctx.fillText('THUNDER', 512, 210);
    ctx.fillStyle = '#ffe9a8';
    ctx.shadowColor = '#ffb92e';
    ctx.font = '900 170px Impact, Arial Black, sans-serif';
    ctx.fillText('DOME', 512, 370);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#8a8f98';
    ctx.font = '700 44px Consolas, monospace';
    ctx.fillText('NO REFUNDS · NO DOCTORS', 512, 452);
    // scanlines: what makes it read as a screen instead of a painted board
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    for (let y = 0; y < 512; y += 4) ctx.fillRect(0, y, 1024, 2);
  });
}

export function buildArena(scene) {
  const { W, D, WALL_H } = ARENA;
  const colliders = [];      // THREE.Box3 solid obstacles
  const lights = [];         // dimmable lights for LIGHTS OUT
  const crowd = [];          // animated crowd instances
  const dynamic = [];        // {update(t)} misc animated things
  const housePractical = []; // emissive materials on the house circuit (dim with LIGHTS OUT)
  const props = new PropBatcher();

  const addCollider = (cx, cy, cz, w, h, d, ry = 0) => {
    colliders.push(new Collider(cx, cy, cz, w, h, d, ry));
  };

  const M = {
    concrete: surface('TD_concrete'),
    wall: surface('TD_concrete_wall'),
    plate: surface('TD_steel_plate'),
    painted: surface('TD_steel_painted'),
    rust: surface('TD_rust'),
    orange: surface('TD_orange'),
    wood: surface('TD_wood'),
    chainlink: surface('TD_chainlink'),
  };

  /** Box mesh with world-scaled UVs, so it can share the arena's one material. */
  const boxGeo = (w, h, d, tile = 2) => worldUV(new THREE.BoxGeometry(w, h, d), tile);

  // ---------- floor ----------
  const floor = new THREE.Mesh(worldUV(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), 2.4), M.concrete);
  floor.receiveShadow = true;
  scene.add(floor);

  // ring markings — a decal over the concrete, not part of its texture, so the pit
  // can be re-liveried without rebaking the floor
  const ringTex = canvasTex(512, 512, (ctx) => {
    ctx.clearRect(0, 0, 512, 512);
    ctx.strokeStyle = 'rgba(227,36,43,0.55)'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(256, 256, 200, 0, 7); ctx.stroke();
    ctx.font = '900 90px Impact'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(227,36,43,0.42)';
    ctx.fillText('TDX', 256, 290);
  });
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 11),
    new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  // Paint on the concrete. The floor under it is what stops a round.
  ring.userData.noCollide = true;
  scene.add(ring);

  // ---------- walls ----------
  const mkWall = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(boxGeo(w, h, d, 2.6), M.wall);
    m.position.set(x, y, z);
    m.receiveShadow = true;
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

  // upper mezzanine ring where the crowd stands: four slabs around the opening
  const mkSlab = (w, d, x, z) => {
    const s = new THREE.Mesh(boxGeo(w, 0.6, d, 2), M.painted);
    s.position.set(x, WALL_H + 0.3, z);
    s.receiveShadow = true;
    scene.add(s);
  };
  mkSlab(W + 12, 5, 0, -D / 2 - 3);
  mkSlab(W + 12, 5, 0, D / 2 + 3);
  mkSlab(5, D + 12, -W / 2 - 3, 0);
  mkSlab(5, D + 12, W / 2 + 3, 0);

  const visualBox = (w, h, d, x, y, z, mat = M.painted, ry = 0, rz = 0, tile = 2) => {
    const m = new THREE.Mesh(boxGeo(w, h, d, tile), mat);
    m.position.set(x, y, z); m.rotation.set(0, ry, rz);
    m.castShadow = true; m.receiveShadow = true; scene.add(m);
    return m;
  };

  /**
   * Instanced repeats. Anything appearing more than a handful of times goes through
   * here — the mezzanine beams alone were 22 separate draw calls.
   */
  const instanced = (geo, mat, transforms, { shadow = true } = {}) => {
    const mesh = new THREE.InstancedMesh(geo, mat, transforms.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    transforms.forEach((t, i) => {
      e.set(t.rx || 0, t.ry || 0, t.rz || 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q, t.scale || one);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    scene.add(mesh);
    return mesh;
  };

  // Heavy underside beams stop the mezzanine reading as four floating boxes.
  const beamsZ = [], beamsX = [];
  for (let x = -W / 2; x <= W / 2; x += 4) {
    beamsZ.push({ x, y: WALL_H - 0.05, z: -D / 2 - 2.7 });
    beamsZ.push({ x, y: WALL_H - 0.05, z: D / 2 + 2.7 });
  }
  for (let z = -D / 2; z <= D / 2; z += 4) {
    beamsX.push({ x: -W / 2 - 2.7, y: WALL_H - 0.05, z });
    beamsX.push({ x: W / 2 + 2.7, y: WALL_H - 0.05, z });
  }
  instanced(boxGeo(0.18, 0.55, 4.8, 1.2), M.painted, beamsZ);
  instanced(boxGeo(4.8, 0.55, 0.18, 1.2), M.painted, beamsX);

  // ---------- the cage ----------
  // Chain-link panels with posts and rails. Panels keep their own mesh (the alpha
  // cut needs correct sorting against the crowd); posts and rails are instanced.
  const posts = [], rails = [];
  const mkFence = (w, x, z, ry) => {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, 2.2), M.chainlink);
    // Scale the plane's 0..1 UVs to world size so the weave is the same physical size
    // on the long and short walls. The tile is deliberately coarse: a fine weave loses
    // coverage in its mips and the alphaTest cut then flickers across the whole cage.
    const FENCE_TILE = 1.6;                                  // metres per texture repeat
    const uv = panel.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) * w) / FENCE_TILE, (uv.getY(i) * 2.2) / FENCE_TILE);
    }
    uv.needsUpdate = true;
    panel.position.set(x, WALL_H + 1.4, z);
    panel.rotation.y = ry;
    panel.receiveShadow = true;
    scene.add(panel);

    const c = Math.cos(ry), s = Math.sin(ry);
    const along = (t) => ({ x: x + c * t, z: z - s * t });
    for (const py of [-1.1, 1.1]) {
      rails.push({ x, y: WALL_H + 1.4 + py, z, ry, scale: new THREE.Vector3(w / 4 + 0.04, 1, 1) });
    }
    for (let t = -w / 2; t <= w / 2 + 0.01; t += 3.2) {
      const p = along(t);
      posts.push({ x: p.x, y: WALL_H + 1.4, z: p.z, ry });
    }
  };
  mkFence(W, 0, -D / 2, 0);
  mkFence(W, 0, D / 2, Math.PI);
  mkFence(D, -W / 2, 0, Math.PI / 2);
  mkFence(D, W / 2, 0, -Math.PI / 2);
  instanced(boxGeo(4, 0.1, 0.1, 1), M.painted, rails);
  instanced(boxGeo(0.14, 2.55, 0.14, 1), M.painted, posts);

  // ---------- crowd ----------
  // Instanced silhouettes: a few hundred bodies for two draw calls. They are lit
  // (not flat black) so the mezzanine reads as a place with people in it, but kept
  // dark enough that they never compete with fighters for attention.
  const crowdMat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.95 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x1b1a1c, roughness: 0.9 });
  const ringPts = [];
  for (let x = -W / 2 - 1; x <= W / 2 + 1; x += 1.4) { ringPts.push([x, -D / 2 - 1.6]); ringPts.push([x, D / 2 + 1.6]); }
  for (let z = -D / 2 - 1; z <= D / 2 + 1; z += 1.4) { ringPts.push([-W / 2 - 1.6, z]); ringPts.push([W / 2 + 1.6, z]); }
  const people = [];
  for (const [x, z] of ringPts) {
    if (Math.random() < 0.14) continue;
    const h = 0.9 + Math.random() * 0.5;
    people.push({
      x: x + (Math.random() - 0.5) * 0.4,
      y: WALL_H + 0.6,
      z: z + (Math.random() - 0.5) * 0.4,
      h,
      w: 0.55 + Math.random() * 0.2,
      ry: (Math.random() - 0.5) * 0.6,
      phase: Math.random() * 7,
    });
  }
  const bodyMesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.55, 3, 6), crowdMat, people.length);
  const headMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 7, 5), headMat, people.length);
  bodyMesh.castShadow = headMesh.castShadow = false;   // the crowd is behind the cage; shadows there cost and show nothing
  bodyMesh.frustumCulled = headMesh.frustumCulled = false;
  // Scenery behind the cage: never cover, never an obstruction.
  bodyMesh.userData.noCollide = headMesh.userData.noCollide = true;
  scene.add(bodyMesh, headMesh);
  crowd.push({ bodyMesh, headMesh, people });

  // ---------- cover objects ----------
  const addBox = (mat, cx, cz, w, h, d, ry = 0) => {
    const m = new THREE.Mesh(boxGeo(w, h, d), mat);
    m.position.set(cx, h / 2, cz);
    m.rotation.y = ry;
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    addCollider(cx, 0, cz, w, h, d, ry);
    return m;
  };

  const addBarrel = (cx, cz) => {
    props.place('hazard_barrel', new THREE.Vector3(cx, 0, cz), Math.random() * 6.28, new THREE.Vector3(1, 1, 1), () => {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 12), M.rust);
      b.position.set(cx, 0.55, cz);
      b.castShadow = true;
      scene.add(b);
    });
    // The authored drum is round; a box proxy created four invisible collision
    // corners around every barrel. Match the outer steel hoops exactly instead.
    colliders.push(new CylinderCollider(cx, 0, cz, 0.43, 1.113));
  };

  /**
   * An authored prop scaled to (w, h, d), with a bounding-box collider to match.
   *
   * The box is honestly the prop's bounds, and that is now the right thing for it to
   * be: it is a movement volume, not a shooting surface. Rays go through the arena's
   * real triangles (see src/meshcollider.js), so there is no longer any reason to
   * shave the box toward the silhouette — and every reason not to, since a box
   * smaller than the thing inside it lets a walking fighter clip into the geometry.
   */
  const addAuthoredBox = (file, fallbackMat, cx, cz, w, h, d, ry, nativeSize) => {
    const fallback = () => {
      const m = new THREE.Mesh(boxGeo(w, h, d), fallbackMat);
      m.position.set(cx, h / 2, cz);
      m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    };
    props.place(
      file, new THREE.Vector3(cx, 0, cz), ry,
      new THREE.Vector3(w / nativeSize.x, h / nativeSize.y, d / nativeSize.z),
      fallback,
    );
    addCollider(cx, 0, cz, w, h, d, ry);
  };

  // Native bounds include armor caps/feet, not only each asset's concrete core.
  const arenaBlockSize = new THREE.Vector3(7.95, 2.65, 1.057);
  const addArenaBlock = (cx, cz, w, h, d, ry = 0) =>
    addAuthoredBox('arena_block', M.concrete, cx, cz, w, h, d, ry, arenaBlockSize);

  // central raised slab + pillars
  addBox(M.concrete, 0, 0, 5, 0.55, 5);
  const pillarPos = [[-9, -6], [9, -6], [-9, 6], [9, 6]];
  for (const [x, z] of pillarPos) {
    addBox(M.concrete, x, z, 1.4, WALL_H, 1.4);
  }

  // crates & stacks
  const crateSize = new THREE.Vector3(2.15, 1.37, 1.857);
  addAuthoredBox('weapons_crate', M.wood, -15, -9, 2.2, 1.4, 1.8, 0.2, crateSize);
  addAuthoredBox('weapons_crate', M.wood, -14.4, -8.3, 1.4, 2.6, 1.4, 0.5, crateSize);
  addAuthoredBox('weapons_crate', M.wood, 15, 9, 1.8, 1.4, 2.2, -0.3, crateSize);
  addAuthoredBox('weapons_crate', M.wood, 14.2, 8.2, 1.4, 2.6, 1.4, 0.1, crateSize);
  addAuthoredBox('weapons_crate', M.wood, -4, 10, 1.8, 1.2, 2.1, 0.4, crateSize);
  addAuthoredBox('weapons_crate', M.wood, 5, -10.5, 2.1, 1.2, 1.8, -0.2, crateSize);
  addAuthoredBox('weapons_crate', M.wood, 13, -6, 1.6, 1.1, 1.9, 0.9, crateSize);
  addAuthoredBox('weapons_crate', M.wood, -13, 6, 1.9, 1.1, 1.6, 0.3, crateSize);

  // low sandbag-style walls (shoot over standing, hide crouched)
  const barrierSize = new THREE.Vector3(4.15, 1.18, 0.92);
  addAuthoredBox('concrete_barricade', M.painted, -6, -3.5, 4.2, 1.05, 0.6, 0, barrierSize);
  addAuthoredBox('concrete_barricade', M.painted, 6, 3.5, 4.2, 1.05, 0.6, 0, barrierSize);
  addAuthoredBox('concrete_barricade', M.painted, -13, 1, 3.4, 1.05, 0.7, 0.5, barrierSize);
  addAuthoredBox('concrete_barricade', M.painted, 13, -1, 3.4, 1.05, 0.7, 0.5, barrierSize);

  // ---- sightline breakers: no spawn-to-spawn LOS ----
  // gate screens: a full-height wall shields each spawn; you exit around its edges
  addArenaBlock(0, -10.5, 8, 2.6, 0.9);
  addArenaBlock(0, 10.5, 8, 2.6, 0.9, Math.PI);
  // angled wing walls flanking each screen: covered diagonal lanes out of the pocket,
  // so leaving spawn isn't a coin-flip between two watched gaps
  addArenaBlock(-7, 11.6, 3.6, 2.5, 0.8, -0.55);
  addArenaBlock(7, 11.6, 3.6, 2.5, 0.8, 0.55);
  addArenaBlock(-7, -11.6, 3.6, 2.5, 0.8, 0.55);
  addArenaBlock(7, -11.6, 3.6, 2.5, 0.8, -0.55);
  // tall crates shadowing the mid-flank runs (cover-hop routes toward the gantries)
  addBox(M.wood, -10.5, 8.3, 1.7, 2.4, 1.7, 0.3);
  addBox(M.wood, 10.5, -8.3, 1.7, 2.4, 1.7, -0.3);
  // central monolith rising from the slab — kills the middle lane
  addArenaBlock(0, 0, 6, 2.8, 1.6);
  addBox(M.concrete, 9, -11, 1.2, 2.4, 3, 0);
  addBox(M.concrete, -9, 11, 1.2, 2.4, 3, 0);

  // ---- verticality: flank gantries (2.25m platforms, stair runs both ends) ----
  const addRaisedBox = (mat, cx, baseY, cz, w, h, d) => {
    const m = new THREE.Mesh(boxGeo(w, h, d), mat);
    m.position.set(cx, baseY + h / 2, cz);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    addCollider(cx, baseY, cz, w, h, d);
  };
  const addAuthoredRaisedBox = (file, fallbackMat, cx, baseY, cz, w, h, d, nativeSize) => {
    const fallback = () => {
      const m = new THREE.Mesh(boxGeo(w, h, d), fallbackMat);
      m.position.set(cx, baseY + h / 2, cz);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    };
    props.place(
      file, new THREE.Vector3(cx, baseY, cz), 0,
      new THREE.Vector3(w / nativeSize.x, h / nativeSize.y, d / nativeSize.z),
      fallback,
    );
    addCollider(cx, baseY, cz, w, h, d);
  };
  const nosings = [];
  const gantry = (gx) => {
    const inner = gx > 0 ? gx - 2.5 : gx + 2.5; // arena-facing edge x
    // hollow deck on legs — you can fight underneath it
    addAuthoredRaisedBox('gantry_deck', M.plate, gx, 1.95, 0, 5, 0.3, 4, new THREE.Vector3(5, 0.3, 4));
    for (const [lx, lz] of [[-2.2, -1.7], [2.2, -1.7], [-2.2, 1.7], [2.2, 1.7]]) {
      addBox(M.painted, gx + lx, lz, 0.3, 1.95, 0.3);
    }
    // stair runs, north and south: 4 steps × 0.45 rise × 0.8 deep
    for (let i = 1; i <= 4; i++) {
      const top = 2.25 - 0.45 * i;
      const zOff = 2 + (i - 0.5) * 0.8;
      addBox(M.concrete, gx, zOff, 4, top, 0.8);
      addBox(M.concrete, gx, -zOff, 4, top, 0.8);
      // Steel nosings catch light and clarify each stair tread at combat distance.
      nosings.push({ x: gx, y: top + 0.04, z: zOff - 0.34 });
      nosings.push({ x: gx, y: top + 0.04, z: -zOff + 0.34 });
    }
    // shoot-over rail on the arena-facing edge (cover when crouched up top)
    addRaisedBox(M.plate, inner + (gx > 0 ? -0.15 : 0.15), 2.25, 0, 0.25, 0.95, 4);
  };
  gantry(16.5);
  gantry(-16.5);
  instanced(boxGeo(4.04, 0.08, 0.12, 1), M.plate, nosings);

  // wrecked car
  props.place('wrecked_car', new THREE.Vector3(8, 0, -8.5), 0.4, new THREE.Vector3(1, 1, 1), () => {
    const car = new THREE.Group();
    const carBody = new THREE.Mesh(boxGeo(4.2, 1.1, 1.9), M.rust);
    carBody.position.y = 0.75;
    const carTop = new THREE.Mesh(boxGeo(2.2, 0.7, 1.7), M.rust);
    carTop.position.set(-0.3, 1.6, 0);
    car.add(carBody, carTop);
    car.position.set(8, 0, -8.5);
    car.rotation.y = 0.4;
    scene.add(car);
  });
  // Two boxes, because a car is not one.
  //
  // This was a single 4.2 x 1.65 slab, which is the height of the *cabin* applied
  // along the whole length. Measured against the model, the boot sits at 1.12 and the
  // bonnet at 1.15-1.20 — so roughly two fifths of the car was carrying half a metre
  // of invisible wall at exactly standing eye height. Line up a shot across the
  // bonnet at someone on the far side and the round stops in clear air. 38% of shots
  // taken past this prop were being eaten that way, the worst by 1.32 m.
  //
  // Offsets are along the car's own long axis; the world conversion is three's RotY,
  // the same one `Collider` inverts (local x → world x·cos, z·−sin).
  {
    const CX = 8, CZ = -8.5, YAW = 0.4;
    const cos = Math.cos(YAW), sin = Math.sin(YAW);
    // Body: the full footprint, at the height of the lower bodywork.
    addCollider(CX, 0, CZ, 4.2, 1.22, 2.02, YAW);
    // Cabin: measured to span the middle 2.4 m, centred a little aft of the axle line.
    const u = -0.25;
    addCollider(CX + u * cos, 0, CZ - u * sin, 2.4, 1.67, 1.9, YAW);
  }

  // barrels
  addBarrel(-2.2, -12.5); addBarrel(-3.1, -12.1); addBarrel(2.4, 12.4); addBarrel(3.3, 12.0);
  addBarrel(-18.5, -11); addBarrel(18.5, 11); addBarrel(-11, 11.5); addBarrel(11, -12);

  // ---------- gates ----------
  const mkGate = (z, rot) => {
    props.place('arena_gate', new THREE.Vector3(0, 0, z), rot, new THREE.Vector3(1, 1, 1), () => {
      const frame = new THREE.Mesh(boxGeo(4.6, 3.6, 0.6), M.painted);
      frame.position.set(0, 1.8, z);
      frame.rotation.y = rot;
      scene.add(frame);
    });
  };
  mkGate(-D / 2 - 0.1, 0);
  mkGate(D / 2 + 0.1, Math.PI);

  // ---------- signage ----------
  // Emissive standard materials, not MeshBasic: they take part in tone mapping and
  // give the bloom pass something with real headroom to pick up.
  const mkSign = (tex, w, h, x, y, z, ry, intensity = 1.9) => {
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff,
      emissiveIntensity: intensity, color: 0x0a0a0c, roughness: 0.6,
    });
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    s.position.set(x, y, z);
    s.rotation.y = ry;
    scene.add(s);
    return s;
  };
  mkSign(neonSignTex('THE PIT', '#ff2233', 'UNDERGROUND KILL LEAGUE'), 12, 3, 0, WALL_H + 2.6, -D / 2 - 0.4, 0);
  mkSign(neonSignTex('BLOOD PAYS', '#ffb92e'), 10, 2.5, 0, WALL_H + 2.4, D / 2 + 0.4, Math.PI);
  mkSign(neonSignTex('NO MERCY', '#86ff3c'), 8, 2, -W / 2 - 0.4, WALL_H + 2.2, 0, Math.PI / 2, 1.5);
  const odds = mkSign(oddsBoardTex(['HOUSE  ALWAYS', 'WINS', '', 'YOU    9 : 1']), 5, 5, W / 2 + 0.4, WALL_H + 2.8, 0, -Math.PI / 2, 1.4);

  // Jumbotron slung over the north end — the room's brightest practical, and the
  // thing that makes the pit feel like a venue rather than a basement.
  const jumbo = mkSign(jumbotronTex(), 13, 6.5, 0, WALL_H + 5.6, -D / 2 + 1.2, 0, 2.4);
  jumbo.rotation.x = 0.16;
  const jumboFrame = visualBox(13.6, 0.5, 0.5, 0, WALL_H + 8.9, -D / 2 + 1.4, M.painted);
  for (const x of [-5.5, 5.5]) {
    visualBox(0.22, 3.6, 0.22, x, WALL_H + 7.1, -D / 2 + 1.5, M.painted, 0, 0, 1);
  }
  void jumboFrame;

  // ---------- roof ----------
  // A real slab overhead. Without it the lamp rig hangs in a black void, the room
  // has no ceiling for the fog to sit under, and nothing catches the uplight — the
  // art bible's "blacks are never #000" rule fails at the top of every frame.
  const roof = new THREE.Mesh(boxGeo(W + 14, 0.8, D + 14, 3), M.concrete);
  roof.position.y = 14.2;
  roof.receiveShadow = true;
  scene.add(roof);
  // exposed roof trusses, catching the lamp rig's uplight
  const trusses = [];
  for (let x = -W / 2 - 4; x <= W / 2 + 4; x += 6) trusses.push({ x, y: 13.5, z: 0 });
  instanced(boxGeo(0.3, 0.6, D + 12, 2), M.painted, trusses, { shadow: false });

  // ---------- lighting ----------
  // Two temperatures only: warm sodium key from the lamp rig, cool mercury fill from
  // the mezzanine. Red exists only where a red sign or strobe exists.
  scene.fog = new THREE.FogExp2(0x0e0f14, 0.0125);

  // Sky colour is the cool mercury bounce, ground colour the warm sodium bounce off
  // the concrete. This one light does most of the work of separating the two
  // temperatures across the whole room.
  // Fill is carrying more than the art bible's nominal 15% because the key is
  // directly overhead: with only a top light, every *vertical* surface in the pit —
  // which is all of the cover you have to read to play — went to near-black. The
  // hemisphere's cool sky against its warm ground bounce is what keeps those faces
  // legible while still separating the two temperatures.
  const hemi = new THREE.HemisphereLight(0x7791b8, 0x4a3524, 1.3);
  scene.add(hemi);
  lights.push({ light: hemi, base: 1.3 });

  const amb = new THREE.AmbientLight(0x2b3040, 0.45);
  scene.add(amb);
  lights.push({ light: amb, base: 0.45 });

  // The key. One shadow-casting source keeps shadow direction legible — a fighter
  // reads his own shadow to judge where he is standing.
  const overhead = new THREE.SpotLight(0xffd6a0, 820, 46, 0.86, 0.7, 1.7);
  overhead.position.set(0, 16, 0);
  overhead.target.position.set(0, 0, 0);
  overhead.castShadow = true;
  overhead.shadow.camera.near = 4;
  overhead.shadow.camera.far = 42;
  // Bevel-heavy authored props expose the default zero-bias shadow acne badly,
  // especially at grazing angles on the gantry. Offset receiver samples just
  // enough to keep real contact shadows without the moire/triangle crawl.
  overhead.shadow.bias = -0.00035;
  overhead.shadow.normalBias = 0.045;
  scene.add(overhead, overhead.target);
  lights.push({ light: overhead, base: 820 });

  // Visible suspended lighting rig. Every glow in the room traces to one of these.
  const lampLens = new THREE.MeshStandardMaterial({
    color: 0x1a150e, emissive: 0xffca82, emissiveIntensity: 3.4, roughness: 0.4,
  });
  housePractical.push({ material: lampLens, base: 3.4 });
  const conduits = [];
  for (const x of [-12, -4, 4, 12]) conduits.push({ x, y: 12.2, z: 0 });
  instanced(boxGeo(0.18, 0.18, 22, 1), M.painted, conduits);
  for (const z of [-11, 11]) visualBox(30, 0.18, 0.18, 0, 12.2, z, M.painted, 0, 0, 1);

  const housings = [], lenses = [];
  const lampPositions = [];
  for (const x of [-12, -4, 4, 12]) {
    for (const z of [-8, 0, 8]) {
      housings.push({ x, y: 11.85, z });
      lenses.push({ x, y: 11.635, z, rx: Math.PI / 2 });
      lampPositions.push([x, z]);
    }
  }
  instanced(new THREE.CylinderGeometry(0.48, 0.34, 0.42, 12), M.painted, housings);
  instanced(new THREE.CircleGeometry(0.31, 16), lampLens, lenses, { shadow: false });

  // Sodium spill from the rig itself: cheap point lights with no shadow, one per
  // corner of the rig rather than one per fixture, which would be twelve lights.
  // Kept deliberately short-range so the floor reads as pools of light with dark
  // between them — an evenly lit floor looked like beach sand.
  for (const [x, z] of [[-9, -6], [9, -6], [-9, 6], [9, 6]]) {
    const p = new THREE.PointLight(0xffb46a, 62, 17, 2.2);
    p.position.set(x, 8.2, z);
    scene.add(p);
    lights.push({ light: p, base: 62 });
  }

  // Mercury service lighting on the mezzanine: the only cool source, and the reason
  // the cage steel reads blue-grey against the warm floor. Four of them, at the
  // corners, so the cool side is a rim on everything rather than a patch on one wall.
  for (const [x, z] of [[-W / 2 + 2, -D / 4], [W / 2 - 2, -D / 4], [-W / 2 + 2, D / 4], [W / 2 - 2, D / 4]]) {
    // Mounted low and angled in, so they rake across the vertical faces of cover
    // rather than washing the floor the overhead key already owns.
    const p = new THREE.PointLight(0x8fb4dc, 190, 34, 1.6);
    p.position.set(x, WALL_H - 1.2, z);
    scene.add(p);
    lights.push({ light: p, base: 190 });
  }

  // Sweeping showlights: warm and cool, matching the two-temperature rule.
  //
  // Stage lighting is for the room, not the fighters. As first written these were
  // 420-intensity spots with a 15-degree cone and 58 m of reach, hung over the middle
  // of the arena and panning across the *floor* with no shadows — so a bright pool the
  // size of a truck slid around the pit, through walls, lighting up whoever it
  // crossed. It reads as a spotlight tracking the enemy team, because that is exactly
  // what it is doing.
  //
  // They now hang outside the pit and rake the walls and the crowd above head height,
  // sweeping along the perimeter rather than across the ground. That keeps the show —
  // the beams still move, the room still feels lit for an audience — while the surface
  // people actually fight on is lit only by the fixtures that are supposed to light
  // it. No shadow maps needed either, because the cones never cross the play space:
  // two more shadow-casting lights would have tripled this scene's shadow cost to fix
  // a problem better solved by pointing them somewhere sensible.
  const sweepers = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const sp = new THREE.SpotLight(i === 0 ? 0xffc27a : 0x9fb6d8, 190, 40, 0.34, 0.8, 1.8);
    sp.position.set(side * (W / 2 + 3), 12, side * (D / 2 + 2));
    scene.add(sp, sp.target);
    sweepers.push(sp);
    lights.push({ light: sp, base: 190 });
  }
  dynamic.push({
    update(t) {
      // Along the far walls, at and above the top of the barrier — never the floor.
      sweepers[0].target.position.set(Math.sin(t * 0.45) * (W / 2 - 1), 4.2 + Math.sin(t * 0.6) * 1.6, D / 2 - 1);
      sweepers[1].target.position.set(Math.cos(t * 0.38) * (W / 2 - 1), 4.4 + Math.cos(t * 0.7) * 1.6, -(D / 2 - 1));
    },
  });

  // A single failing ballast. One flickering lamp does more for "this place is
  // condemned" than any amount of texture grime.
  const flicker = new THREE.PointLight(0xffb46a, 40, 16, 2.0);
  flicker.position.set(lampPositions[2][0], 9.2, lampPositions[2][1]);
  scene.add(flicker);
  dynamic.push({
    update(t) {
      const n = Math.sin(t * 37) * Math.sin(t * 11.3) * Math.sin(t * 2.7);
      const dying = n > 0.55 ? 0.15 : 1;
      flicker.intensity = 40 * dying * (0.85 + Math.sin(t * 60) * 0.15);
    },
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
      new THREE.Vector3(0, 0, -D / 2 + 4), // liquidation swarm strategies field six
    ],
  };

  /**
   * What actually stops a bullet.
   *
   * Deliberately a rule about the scene rather than a list built alongside it: the
   * arena is assembled in thirty places and a parallel list would rot the first time
   * someone added a prop without remembering it. The exclusions are the whole of the
   * judgement, and there are only four kinds.
   */
  const isSolid = (o) => {
    if (o.userData.noCollide) return false;        // ring paint, crowd
    if (o.isSkinnedMesh) return false;             // fighters carry their own hitboxes
    if (o.layers.mask !== 1) return false;         // fx pools: light and haze
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    // Chain-link is drawn as a blended sheet whose alpha is most of the image; treating
    // it as a wall would make the cage bulletproof.
    return !ms.some((m) => m && m.transparent);
  };

  // A live handle, so `world.solids` can be wired up before the geometry exists. Until
  // the props land it is empty, and an empty collider stops nothing — during those few
  // hundred milliseconds the box colliders are still the fallback for rays.
  const solids = {
    mesh: new MeshCollider(new Float32Array(0)),
    raycast(o, d, maxDist) { return this.mesh.raycast(o, d, maxDist); },
    blocked(a, b2) { return this.mesh.blocked(a, b2); },
    get ready() { return this.mesh.count > 0; },
    get triangles() { return this.mesh.count; },
  };

  // Built once the authored props have landed — before that the scene is fallback
  // primitives and the instanced batches are empty.
  const solidsReady = props.resolve(scene).then(() => {
    solids.mesh = new MeshCollider(collectTriangles(scene, isSolid));
    return solids;
  });

  return {
    colliders, lights, crowd, dynamic, spawns, strobe, oddsSign: odds,
    solids,
    propsReady: solidsReady,

    /** Shadow resolution follows the quality tier. */
    setShadowMapSize(size) {
      overhead.shadow.mapSize.set(size, size);
      overhead.shadow.map?.dispose();
      overhead.shadow.map = null;
    },

    /**
     * House-circuit dimmer, driven by LIGHTS OUT and the BROWNOUT mutator.
     *
     * Lamp lenses go dark with the lights they belong to; signage and the jumbotron
     * do not, because they are on the promoter's supply and because a pitch-black
     * room with no landmarks is unplayable rather than tense.
     */
    setLightFactor(f) {
      for (const l of lights) l.light.intensity = l.base * f;
      for (const p of housePractical) p.material.emissiveIntensity = p.base * f;
    },
  };
}

export function updateArenaAmbience(arena, t) {
  // The crowd is instanced, so the sway is a matrix write per person rather than a
  // scene-graph update. Standing, bobbing, occasionally surging.
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (const group of arena.crowd) {
    const { bodyMesh, headMesh, people } = group;
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const bob = Math.sin(t * 2.2 + p.phase) * 0.05;
      const lean = Math.sin(t * 1.3 + p.phase * 1.7) * 0.05;
      e.set(0, p.ry, lean);
      q.setFromEuler(e);
      pos.set(p.x, p.y + bob + p.h * 0.5, p.z);
      scl.set(p.w / 0.44, p.h / 0.99, 1);
      m.compose(pos, q, scl);
      bodyMesh.setMatrixAt(i, m);
      pos.set(p.x - Math.sin(lean) * p.h, p.y + bob + p.h + 0.13, p.z);
      scl.set(1, 1, 1);
      m.compose(pos, q, scl);
      headMesh.setMatrixAt(i, m);
    }
    bodyMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
  }
  for (const d of arena.dynamic) d.update(t);
}
