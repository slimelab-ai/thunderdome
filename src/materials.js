import * as THREE from 'three';
import { versioned } from './asset-version.js';

/**
 * The material library.
 *
 * Assets never carry their own textures. Blender exports geometry with materials
 * named `TD_*` (see `tools/blender/td_lib.py`), and `bindAuthoredMaterials` swaps
 * each name for one shared `MeshStandardMaterial` from this registry. The whole
 * arena therefore runs on ~10 materials and ~10 textures no matter how many props
 * are in it, and a texture change needs no model rebuild.
 *
 * UVs are world-scaled, not per-object 0..1. A 4 m wall and a 1 m crate show the
 * same size of concrete aggregate, and every surface can share one texture instance
 * because nothing needs a bespoke `repeat`.
 */

const TEX_DIR = '/assets/textures';
const loader = new THREE.TextureLoader();
const cache = new Map();

// Anisotropy is capped by hardware; 8 is plenty for floors seen at grazing angles.
let maxAnisotropy = 8;
export function setMaxAnisotropy(v) { maxAnisotropy = Math.max(1, Math.min(16, v)); }

function tex(file, { srgb = false } = {}) {
  const key = `${file}:${srgb}`;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(versioned(`${TEX_DIR}/${file}.webp`));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Colour maps are sRGB-encoded; normal and ORM maps are raw data and must not be
  // decoded, or the lighting is quietly wrong everywhere.
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = maxAnisotropy;
  cache.set(key, t);
  return t;
}

/**
 * Build a standard material from a baked set: `<name>.webp`, `<name>_n.webp`,
 * `<name>_orm.webp`.
 *
 * ORM packs AO/roughness/metalness into R/G/B. three.js reads a different channel
 * from the same texture for each map, so pointing all three at one image is both
 * correct and free.
 */
function fromSet(name, overrides = {}, { hasAlbedo = true } = {}) {
  const normalMap = tex(`${name}_n`);
  const orm = tex(`${name}_orm`);
  const params = {
    normalMap,
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    // The maps supply the variation; these are the multipliers on top of them.
    roughness: 1,
    metalness: 1,
    ...overrides,
  };
  if (hasAlbedo) params.map = tex(name, { srgb: true });
  return new THREE.MeshStandardMaterial(params);
}

let registry = null;

export function materials() {
  if (registry) return registry;
  const grungeNormal = tex('detail_grunge_n');
  const grungeOrm = tex('detail_grunge_orm');

  // Painted/plastic surfaces have no bespoke texture set — they take a tint plus the
  // shared grunge normal so they still catch light like beaten-up objects.
  const painted = (color, { roughness = 0.7, metalness = 0.0 } = {}) => new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    normalMap: grungeNormal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    aoMap: grungeOrm,
    roughness,
    metalness,
  });

  registry = {
    TD_concrete: fromSet('concrete_floor', { normalScale: new THREE.Vector2(0.55, 0.55) }),
    TD_concrete_wall: fromSet('concrete_wall', { normalScale: new THREE.Vector2(0.6, 0.6) }),
    // Multipliers below 1 on top of the maps: a fully polished diamond plate seen at
    // the grazing angles you get across a gantry sparkled badly, because the tread
    // normal is high-frequency and specular does not antialias.
    TD_steel_plate: fromSet('steel_plate', {
      roughness: 1.35,
      metalness: 0.78,
      normalScale: new THREE.Vector2(0.7, 0.7),
    }),
    TD_steel_painted: fromSet('steel_painted'),
    TD_gunmetal: fromSet('gunmetal'),
    // Fighters have exactly two slots. The body atlas is shared by every fighter in
    // the match; the uniform is tinted per squad by `fighterUniform` below.
    TD_fighter_body: fromSet('fighter_kit', { normalScale: new THREE.Vector2(0.7, 0.7) }),
    TD_fighter_uniform: fromSet('fighter_kit', { normalScale: new THREE.Vector2(0.7, 0.7) }),
    TD_chainlink: fromSet('chainlink', {
      // Blended, not cut. An alphaTest cut against faded mip levels made the whole
      // cage fizz with rainbow speckle at distance — the wires are barely a pixel
      // wide up on the mezzanine. Blending lets the mip chain fade them smoothly.
      // depthWrite stays off so the crowd behind (drawn in the opaque pass) shows
      // through correctly instead of fighting the fence for the depth buffer.
      transparent: true,
      depthWrite: false,
      alphaTest: 0,
      side: THREE.DoubleSide,
      // Deliberately un-shiny. A sub-pixel-wide metallic wire aliases through its
      // specular highlight no matter what the alpha does, and real chain-link thirty
      // metres away is a grey haze, not a row of chrome highlights.
      roughness: 0.82,
      metalness: 0.2,
      normalScale: new THREE.Vector2(0.3, 0.3),
    }),
    TD_rust: painted(0x53301c, { roughness: 0.94 }),
    TD_orange: painted(0xd8420f, { roughness: 0.66 }),
    TD_gold: painted(0xb08a2e, { roughness: 0.34, metalness: 0.95 }),
    TD_rubber: painted(0x111114, { roughness: 0.95 }),
    TD_wood: painted(0x4b3320, { roughness: 0.82 }),
    TD_cloth: painted(0x2b2d26, { roughness: 0.93 }),
    TD_webbing: painted(0x17181b, { roughness: 0.62, metalness: 0.25 }),
    TD_skin: painted(0x9a6b52, { roughness: 0.7 }),
    TD_glass: new THREE.MeshPhysicalMaterial({
      color: 0x0a1216, roughness: 0.14, metalness: 0,
      transparent: true, opacity: 0.55, envMapIntensity: 1.6,
    }),
    TD_emissive_red: new THREE.MeshStandardMaterial({
      color: 0x2a0406, emissive: 0xff2028, emissiveIntensity: 2.6, roughness: 0.5,
    }),
  };
  return registry;
}

/** Fetch one shared material by canonical name. Throws on a typo rather than hiding it. */
export function surface(name) {
  const m = materials()[name];
  if (!m) throw new Error(`unknown surface: ${name}`);
  return m;
}

const uniformCache = new Map();

/**
 * A squad's uniform material: the shared fighter atlas tinted by squad colour.
 *
 * Cached by colour, so a five-strong squad shares one material and the whole cast
 * costs a handful. Squad colour is gameplay information — you have to be able to tell
 * at a glance who is on your side — so it multiplies the atlas rather than replacing
 * it, keeping the cloth weave and grime.
 */
export function fighterUniform(color) {
  const key = new THREE.Color(color).getHex();
  if (uniformCache.has(key)) return uniformCache.get(key);
  const m = surface('TD_fighter_uniform').clone();
  m.color = new THREE.Color(key);
  uniformCache.set(key, m);
  return m;
}

/**
 * World-scale box projection.
 *
 * Procedural geometry built in JS (walls, slabs, stair treads) arrives with 0..1
 * UVs that stretch the texture to whatever the box's proportions happen to be. This
 * rewrites UVs from world position on the dominant normal axis, so texel density is
 * uniform across every surface in the arena and one shared material can serve all
 * of them.
 *
 * `tileMeters` is how many metres one texture repeat covers — 2 m matches the
 * density the texture sets are authored for.
 */
export function worldUV(geometry, tileMeters = 2, offset = new THREE.Vector3()) {
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  if (!nor) geometry.computeVertexNormals();
  const uv = new Float32Array(pos.count * 2);
  const s = 1 / tileMeters;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i) + offset.x, py = pos.getY(i) + offset.y, pz = pos.getZ(i) + offset.z;
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = px; v = pz; }        // floor / ceiling
    else if (nx >= nz) { u = pz; v = py; }               // wall facing X
    else { u = px; v = py; }                             // wall facing Z
    uv[i * 2] = u * s;
    uv[i * 2 + 1] = v * s;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // aoMap samples uv2 in older three, uv in current — set both so the packed ORM's
  // AO channel is applied either way.
  geometry.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
  return geometry;
}

/**
 * Swap the placeholder materials in a loaded GLB for the shared registry ones.
 *
 * Blender's exporter writes material names with a `.001`-style suffix when a name
 * collides, so the lookup strips that. An unmapped name is a pipeline bug worth
 * shouting about rather than silently rendering grey.
 */
export function bindAuthoredMaterials(root, { warn = true } = {}) {
  const reg = materials();
  const missing = new Set();
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const apply = (mat) => {
      const base = mat?.name?.replace(/\.\d+$/, '');
      const found = reg[base];
      if (found) return found;
      if (base) missing.add(base);
      return reg.TD_concrete;
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(apply)
      : apply(child.material);
  });
  if (warn && missing.size) {
    console.warn('[materials] authored names with no registry entry:', [...missing].join(', '));
  }
  return root;
}
