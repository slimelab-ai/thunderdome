# THUNDERDOME — Art Bible

The rules every mesh, texture and light in this game answers to. If a change makes
a frame prettier but breaks a rule here, the rule wins.

## 1. The pitch, visually

An illegal blood sport in a drained municipal reservoir. Nobody built this room to
look good — they bolted a cage into a concrete box, hung stolen work lamps over it,
and sold tickets. Cheap spectacle over structural rot.

Reference triangle: **Fight Club basement** (grime, sodium, damp) × **Mad Max
Thunderdome** (welded cage, scrap dressing) × **a Vegas undercard** (garish
sponsor light, jumbotron, red carpet ring).

Three words: **wet concrete, sodium haze, blood.**

## 2. Palette

Colour is *motivated* — every hue in a frame traces to a light source or a painted
surface you could point at. No abstract mood lights.

| Role | Value | Where it comes from |
| --- | --- | --- |
| Concrete base | `#3a3d42` → `#6b6e73` | walls, floor, cover |
| Cage / structure steel | `#25272b`, metal 0.9 | fence posts, gantries, beams |
| Sodium key | `#ffb46a` | the overhead work-lamp rig |
| Mercury fill | `#8fa8c8` | mezzanine service lighting |
| League red | `#e3242b` | signage, ring paint, exit lights |
| League gold | `#ffb92e` | sponsor trim, boss mask, payout UI |
| Hazard orange | `#ff5a1a` | barricade stripes, fire, molotov |
| Blood | `#5c0d10` fresh → `#2a0608` dried | decals, pools, splatter |

**Two light temperatures, never three.** Warm sodium is the key; cold mercury is
the fill. Red is an accent that only ever comes from a visible sign or strobe.
The old per-corner red/green/blue/cyan point lights are banned — they turned the
pit into a bowling alley.

**Blacks are never `#000`.** Fog and a floor-bounce ambient keep the darkest pixel
around `#0d0e11`, so silhouettes read against shadow instead of vanishing.

## 3. Lighting rules

1. One dominant key: the suspended lamp rig, warm, casting the only real shadows.
2. Fill is ambient + hemisphere only — cheap, directionless, cool, ~15% of key.
3. Every emissive surface has a physical fixture behind it. A glow with no lamp is
   a bug.
4. Practicals (signs, lenses, jumbotron) carry the frame's sparkle via bloom. They
   are `emissiveIntensity` on a standard material, not `MeshBasicMaterial`.
5. Fog is warm-tinted and thin (`FogExp2`, ~0.012). It exists to give depth
   ordering to a large dark room, not to hide draw distance.
6. `LIGHTS OUT` dims the key and fill to near zero and lets the red strobe and
   emissives carry the room — which only works if rules 3 and 4 hold.

## 4. Material standard

Everything is `MeshStandardMaterial` (or `MeshPhysicalMaterial` for glass). No
`MeshLambertMaterial`, no `MeshBasicMaterial` on anything that should receive light.
Metal needs an environment map to look like metal, so the PMREM env is not optional.

| Surface | Metalness | Roughness | Maps |
| --- | --- | --- | --- |
| Concrete | 0.0 | 0.82–0.96, blotchy | albedo, normal, ORM |
| Painted steel | 0.55 | 0.4–0.6 | albedo, normal, ORM |
| Bare/scratched steel | 0.9 | 0.3–0.5 | albedo, normal, ORM |
| Rubber / cloth | 0.0 | 0.9 | albedo, normal |
| Skin | 0.0 | 0.7 | albedo, normal |
| Glass | 0.0 | 0.1 | transmission |

Roughness variation is what sells wet concrete — a constant roughness reads as
plastic. Every concrete texture set ships a roughness map with damp patches.

Texture sets are generated, not hand-painted: `tools/textures/` writes tiling
albedo/normal/ORM triplets as WebP. Trim-sheet philosophy — a small number of
tiling sets reused everywhere, scaled per surface, beats one bespoke texture per
prop.

## 5. Poly and draw budgets

Target: 60 fps at 1080p on integrated graphics, 30 fps on a mid phone at 0.75×
resolution. That means **draw calls are the budget**, not triangles.

| Asset | Tris | Bones | Materials | Actual |
| --- | --- | --- | --- | --- |
| Fighter (skinned) | ≤ 2,800 | ≤ 24 | 2 | 2,928 tris, 20 bones |
| Weapon world model | ≤ 1,100 | — | 1 | 260–580 tris |
| Viewmodel arms | ≤ 4,000 | ≤ 20 | 2 | 1,336 tris, 9 bones |
| Arena prop | ≤ 1,200 | — | 2–4 | 708–1,424 tris |

Budget overages are reported by the build (`** OVER BUDGET **` in the asset log)
rather than enforced, so a deliberate overage shows up in review instead of silently
passing. The fighter is 4% over and staying that way — the cost is in the helmet and
shoulder spheres, which are exactly the silhouette the budget exists to protect.

Scene budget: **≤ 220 draw calls** in a live match. Anything that repeats more
than eight times is an `InstancedMesh` (crowd, mezzanine beams, lamp fixtures,
fence posts, stair nosings).

> **Current state: ~175, met.** The route was 978 → 321 (instancing the repeats and
> joining each prop into one mesh at export) → 175 (batching *placements*, so all
> twenty arena blocks are one `InstancedMesh` per material rather than twenty cloned
> `Group`s). Fighters are two calls each.

Resolution is adaptive on top of the tier: `RenderPipeline` measures its own render
time and trims `renderScale` toward 0.62 when frames run long, restoring it when
there is headroom. The measurement is a slow average with a cooldown, because a
resolution that oscillates looks worse than one that is simply lower. `__game.stats`
reports what it has settled on.

## 6. Animation rules

Fighters are skinned meshes driven by authored clips, blended by a state machine —
never by per-frame Euler writes to limb transforms.

- Locomotion: `idle`, `walk`, `run`, `crouch_idle`, `crouch_walk`, blended on a
  speed/stance graph with crossfades of 0.15–0.25 s.
- Upper body is an **additive layer**: `aim`, `fire`, `reload`, `throw`, `heal`
  play over whatever the legs are doing.
- Aim tracking is procedural on top of animation — spine and neck bones rotate
  toward the target, clamped, so a fighter's gun points where he shoots.
- Deaths are authored clips (`death_front`, `death_back`, `death_collapse`)
  chosen by hit direction, not a rotation lerp.
- Hitboxes are invisible proxy boxes parented to bones. The visual mesh is never
  the collision surface — that is what lets the mesh get as detailed as it likes.

Weapons animate their own parts (slide, bolt, pump, magazine) so firing and reloading
are mechanically legible at first-person distance. Static geometry is joined into a
`body` object at export; the movers stay separate and named, and the runtime finds
them by name.

The first-person viewmodel is a rigged pair of arms (`fp_arms.glb`, 9 bones) wrapped
around the same authored weapon the world uses. Its weapon socket sits at the arms'
own origin with identity orientation, so a weapon parented there lands exactly where
the bare weapon used to — every bit of viewmodel maths in `src/player.js` (the
hip/ADS lerp, the kick, the sway) is untouched by the arms existing.

The clip split mirrors the fighter's, for the same reason. `fire` is additive so a
recoil impulse layers over anything. `reload`, `draw` and `melee` are full-body for
the arms, because the support hand leaves the weapon entirely, which no additive
layer can express without fighting the idle sway. Clips are time-scaled to the
weapon's own reload and swing durations, so the magazine seats when the weapon says
it does.

Per-weapon grips are bone pins, not separate clip sets: the rest pose already reaches
a rifle-length handguard, and only the outliers need anything — a pistol held with
both hands together, a knife whose support arm swings out of frame. Those pins
release while a *reload* is playing, or the left arm stays frozen on a handguard it
is supposed to have let go of. They deliberately do **not** release during the draw:
that left the support hand at its rest position, which on a pistol is out past the
muzzle, so equipping one looked like grabbing the barrel.

Weapons are also offset so their grip meets the fist. They were authored with the
origin nominally at the grip, but in practice each one's grip geometry sits somewhere
slightly different — a pistol's is 5 cm behind and 2.5 cm below its origin — and
without the offset the hand closes on whatever happens to be at the origin.

Reloads that are mechanically different get their own clip rather than a stretched
generic one: `reload_pistol` drops a magazine out of the grip and racks the slide
afterwards, and `reload_shell` feeds a single round and returns to the carry pose, so
it can be replayed once per shell without stuttering between rounds. A pump action
gets a `pump` stroke between shots, and firing is locked out until it completes.

Grip poses are **fitted, not eyeballed**. A two-handed pistol grip needs the support
hand just below and behind the firing hand, and no single joint reaches it — lowering
the shoulder also swings the hand forward past the muzzle. `tools/poses/hands.js`
reports both hand positions in camera space so the pose can be solved against a
target instead of nudged.

## 7. VFX rules

Effects are pooled and allocate nothing at runtime. A firefight spawns hundreds of
emitters a second, and a garbage collection in the middle of one is a visible hitch.

- **Two particle pools, split by blend mode.** Additive for anything that emits light
  (sparks, embers, muzzle grit); alpha for anything that blocks it (smoke, dust, blood
  mist). They cannot share: additive smoke never reads as smoke, and alpha-blended
  sparks never read as hot. Two draw calls for every particle in the game.
- **Per-particle size and alpha**, via a custom shader. `PointsMaterial` supports
  neither, and they are exactly what separates a spark shower from a cloud of
  identical squares. Size is in world units — the shader takes the projection scale
  and viewport so a 5 cm ember is 5 cm at any resolution.
- **Effects carry direction.** Blood sprays along the bullet's path, wall spall comes
  back at the shooter, cases eject to the shooter's right. A symmetric puff reads as a
  placeholder.
- **Decals orient to the surface** and use polygon offset rather than a height
  fudge. Bullet holes expire; blood and scorch stay for the bout.
- **The muzzle flash is small.** It sits ~40 cm from the first-person camera, so a
  world-plausible size fills a third of the screen and blinds the shot being placed.
  The point light does the work of making it feel bright.

## 8. Pipeline

Nothing in `public/assets/` is hand-edited; it is all reproducible output.

```sh
npm run assets          # everything below, in order
npm run assets:tex      # tools/textures/*.mjs  → public/assets/textures/*.webp
npm run assets:models   # tools/blender/*.py    → public/assets/models/*.glb
```

Blender runs headless (`blender --background --python`). Scripts are the source of
truth for geometry — there are no `.blend` files in the repo, so a model change is
a reviewable diff.

Visual review is also scripted, so a look change can be checked without a human at
a keyboard:

```sh
npm run dev             # in one terminal
node tools/shot.mjs shots/arena.png --pose arena
```

Poses live in `tools/poses/`. `arena` is the lighting reference frame, `fighters`
is the character turntable, `match` is a live first-person combat frame.
