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

- Locomotion is a **2D blendspace**: three gaits (`walk`, `run`, `crouch`) × eight
  headings (`f fr r br b bl l fl`), plus `idle` and `crouch_idle`.
- Upper body is an **additive layer**: `aim_pose`, `fire`, `reload`, `throw`, `heal`
  play over whatever the legs are doing.
- Aim tracking is an **aim offset** — four authored additive poles (`aim_up`,
  `aim_down`, `aim_left`, `aim_right`) blended by pitch and yaw.
- Leaning is an authored additive pose too (`lean_l`, `lean_r`), not a roll of the
  whole fighter.
- Deaths are authored clips (`death_front`, `death_back`, `death_collapse`)
  chosen by hit direction, not a rotation lerp.
- Hitboxes are invisible proxy boxes parented to bones. The visual mesh is never
  the collision surface — that is what lets the mesh get as detailed as it likes.

### 6.1 The locomotion blendspace

Roughly how Unreal does it, and for the same reasons.

**Eight poles, not four.** Four is enough to name every direction but not to represent
one: blending a forward cycle with a sideways one gives a foot travelling neither, and
the measured result was a diagonal walk sliding 2.9 m/s while both its parents were
clean. Eight puts an authored clip within 22° of any heading. Only the two poles
bracketing the heading ever carry weight, blended by angle.

**One clock for every clip.** Directional cycles do not keep their own time. All of
them run at `timeScale = 0` and the runtime writes `action.time` from a single shared
phase. Two clips crossfaded at independent times have one foot planting while the
other lifts, and the result slides — a blend is only a blend if the poses agree about
where in the stride they are. Every clip in a gait is authored to the same length and
puts the left foot at the leading end of its step at phase 0, whichever way "leading"
points for that clip.

**Phase advances on distance, not on time.** `phase += speed * dt / stride`. This is
the whole reason the feet stay planted: at any speed, one cycle of clip covers one
cycle's worth of ground, so a limping fighter's stride slows with him for free and
nothing needs a playback-rate hack.

**Legs are solved, not posed.** The locomotion clips are generated by authoring a
*foot path over the ground* — an explicit stance phase in which the foot does not move
at all, then a swing arc — and solving two-bone IK for the joint angles, against the
posed hips so the bounce and the sway are accounted for rather than fought. The solver
checks its own residual and the build fails if any leg misses its target by more than
2 mm. Hand-keying thigh and knee angles instead is what made the first walk skate: an
FK leg has no notion of the floor.

**Stride lengths are measured, not chosen.** `npm run fightercheck` walks the rig in
every direction, watches what the planted foot actually gives back, and prints the
table that belongs in `GAITS`. Authoring rounds the authored numbers — resampling to
whole frames, linear keys clipping a corner, a leg reaching its limit at the extreme of
a stride — so what goes in the runtime is what came out, not what went in. Re-run it
after any change to the gait specs.

**Strides blend as vectors.** Blending a forward stride with a rightward one produces
a foot travelling the diagonal, and the diagonal of two half-weighted perpendicular
strides is 0.71 of either, not the 1.0 a scalar average gives. Averaging the numbers
instead of the vectors slid every diagonal by 40%.

**Gameplay state is not continuous, and the rig must not care.** Speed and heading
arrive as whatever this frame happened to produce: a fighter who reaches his goal drops
from 4.6 m/s to zero in one frame, and one frame of a fighter shoved sideways by
collision resolution points anywhere at all. Fed in raw, the first cut a deep leaning
run pose straight to idle and threw the head 20 cm in a single frame, and the second
swung the blendspace heading past 60 degrees between frames — which, since the poles
either side of the circle lean opposite ways, read as fighters snapping between leaning
left and leaning right twice every five seconds. Both are damped inside the rig, where
every caller gets it: the move blend eases over time as well as over speed, and the
heading is both averaged and rate-limited so a full reversal takes about a third of a
second.

### 6.2 Holding the weapon

**Both hands are solved from the weapon, not posed independently.** There are two
holds — carry and shouldered — and each is authored as a *target*: where the firing
wrist sits and which way the bore points. The right arm is solved to that, the hand is
turned so the socket's bore runs down the barrel, and then the weapon's grip point
falls out of the resulting pose and the left arm is solved to *it*. That order is the
whole trick. Posing the two arms independently is how every fighter came to carry his
rifle at arm's length off his right hip with his support hand gripping air 20 cm away —
and worse, with the handguard 80 cm from a 60 cm arm, no runtime IK could have saved it
either.

At runtime a two-bone CCD keeps the left fist on the grip as the weapon moves with the
walk, the aim offset and the recoil. It warm-starts, for the reason in the traps below.
It lets go — eased, not cut — while a clip has the hand somewhere else, and a shieldman
opts out entirely by pinning his support arm.

**The torso is bladed, and it stays bladed.** Both holds turn the spine and chest so
the support side leads, the way anyone stands behind a weapon; without it the fighter
is square on to the target with a rifle held across a flat chest — technically holding
it, and reading as a mannequin. The blade is applied *before* the arms are solved, and
the arm targets are in world space, so blading costs nothing at the grip: the arms
simply come out different. Locomotion adds its counter-rotation on top of the bladed
stance rather than replacing it, so taking a step does not square him up.

**The head does not ride the chest.** A head sits about 1.4 m above the hips, and every
degree of pelvis roll is five centimetres up there. Authored honestly, the pelvis put
9 cm of rise and 10 cm of side-to-side into the head and the fighters read as
bobbleheads. The bounce and sway are deliberately below life, and the roll terms up the
spine sum to roughly zero at the neck, so the pelvis still works and the head stays
level. Measured: 2.7 cm rise and 3.9 cm sway at a walk, 4.8 and 5.0 at a run.

**Bots aim down sights.** Shouldering is a state with a cost and a payoff: it takes
about a third of a second, it slows the fighter by a third while it is up, and it
roughly halves his group size. He will not take a shot at range until he is settled,
which is the visible tell that he is aiming rather than hosing. Measured over six
matches, fights resolve in 13.4 s with it against 14.1 s without, on 30% fewer shots —
so the pacing is unchanged and the shots that are taken mean something.

**The recoil impulse is not restarted while it is still reading.** `fire` is additive,
and resetting an additive clip puts it back at its zero frame — so an automatic weapon
retriggering every five frames pinned it to nothing and the fighters fired without
moving at all. Past the peak, restarting is what makes sustained fire punch.

An **aim offset** replaces rotating the spine in code. An authored pose distributes the
turn across spine, chest, neck and head the way a body does; the procedural version bent
one joint and read as a broken neck. Yaw is what lets a fighter track a target beside
him without turning his feet. The poles touch spine and above only, so they layer over
any locomotion clip without disturbing the legs — which the bench checks explicitly, by
sweeping aim and lean at a standstill and requiring the feet not to move at all.

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

The weapon's own parts move with the hand that works them — the slide cycles during
the rack, the magazine drops and reseats, the pump strokes — so the animation and the
mechanism agree. A hand miming an action the weapon does not perform is the single
biggest tell that a reload was retargeted from another weapon.

**Fit poses in the space you will apply them in.** Angles fitted in the runtime do not
survive transplanting into Blender pose keys — the two do not compose euler rotations
the same way, and a rack pose that measured 2 cm off the slide in the browser landed
24 cm off once baked into the clip. The pistol's rack grip is therefore applied as a
runtime pose over the clip, which also keeps it measurable: every grip in the game is
checked as a distance from the fist to the part of the weapon it should be holding.

Grip poses are **fitted, not eyeballed**. A two-handed pistol grip needs the support
hand just below and behind the firing hand, and no single joint reaches it — lowering
the shoulder also swings the hand forward past the muzzle. `tools/poses/hands.js`
reports both hand positions in camera space so the pose can be solved against a
target instead of nudged.

### 6.3 Hit volumes

Fighters are hit through invisible boxes parented to bones; the player is hit through a
capsule and a head sphere. Neither has a visible representation, so both can be wrong
indefinitely without anybody noticing — and both were.

**The player's resolver is analytic.** It used to march the ray in 0.35 m steps against
a head band 0.22 m tall, so whether a headshot registered came down to where the samples
happened to land, and mostly they landed either side of it. Nobody could shoot the
player in the face and no amount of aiming changed that. It is a proper ray-capsule
intersection now, with a separate head sphere, and `test/hitbox.test.js` sweeps the
whole head rather than sampling one lucky height.

**The head wins overlaps.** Shoulders are wider than a skull, so at the top of the chest
the body capsule is entered before the head sphere even on a shot going straight through
the face — nearest-surface-wins reported the lower half of every head as a shoulder.

**A lean pivots about the feet.** The head swings out, the boots stay put. Translating
the whole capsule sideways carried the player's legs around the corner with him and
exposed them to fire he had no way to account for.

**Limb assignment comes from the ray, not the impact point.** An impact is on the
surface by definition, so its distance from the body axis is always exactly the radius —
measuring *that* made every hit an arm. What matters is how close to the centre line the
round passed, which is a property of the ray.

**The AI's aim point and the hit model must agree.** They are the same function over the
same lean now. The AI used to aim at a fixed point over the player's feet with no lean
term at all, so a player peeking a corner was being aimed at *through* the wall he was
peeking past, and his exposed head drew no fire at all. Chest first, head if the chest
is not there to be hit.

**Cover the whole fighter.** There was no hitbox on the hips — a 16 cm band across the
widest part of the body, at gut height, that rounds passed straight through — and none
on the hands or feet. Coverage went from 88% to 99% of the drawn silhouette. Limb boxes
are sized close to the limb: a box around a cylinder overhangs it by about 27% whatever
you do, and anything past that is a fighter being hit where he visibly is not.

## 7. VFX rules

**A shot comes from the barrel, and is drawn from the barrel, and those are the same
point.** Not a point derived from where the shooter is standing — the actual muzzle
node on the actual weapon, after the animation, the lean and the aim offset have all
been applied. Third-person fire used to be cast from the shooter's *eye* and drawn from
a point 0.6 m down the line from it, which put tracers half a metre off the gun on
average and 1.65 m off at worst. Sharing one origin also makes a backwards tracer
impossible: the streak cannot start beyond an impact that is measured from the same
place.

**A tracer is anchored at the muzzle end, not centred on the flight path.** Centring it
put a 13 m streak in the middle of a 30 m shot — a bolt hanging in mid-air with nothing
joining it to the weapon, and near enough to whoever was being shot at that fire from
off to one side read as coming from directly behind them. Where a tracer starts is the
only cue the receiving end has about where it came from.

**A fighter cannot shoot from further out than his body reaches.** The corner peek used
to fire from a point 0.6 m outside the fighter, against a lean worth a quarter of that
— an angle that did not exist from the other end, which is the precise definition of an
unfair peek. `npm run fightercheck` measures how far a lean actually carries the muzzle
(29 cm) and combat sizes its peek off that number. Past it, the fighter has to step out,
and stepping out is visible.

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

## 8. Verifying an animation

Do not sign off an animation from a screenshot. A still frame cannot show the two
faults that matter most, and both of them shipped: a pose can be correct at every
keyframe and still *teleport* between them, and a recoil that kicks the muzzle the
wrong way looks perfectly fine frozen. Both are only visible in the change over time.

```sh
npm run dev                     # in one terminal
npm run animcheck               # every weapon, every action
npm run animcheck -- --weapon rifle --verbose
```

For looking at something yourself rather than measuring it, boot straight into an
empty arena with the loadout you need:

```
http://localhost:5173/?sandbox=rifle,shotgun     # nothing shoots back, invulnerable
http://localhost:5173/?sandbox                   # every weapon
http://localhost:5173/?sandbox=dmr&god=0         # hazards still hurt
```

or `__game.sandbox('rifle')` from the console. Animation work needs long uninterrupted
looks at a weapon in the real renderer, and a live bout does not allow it — the
fighters kill you, the match ends, and the thing you were studying is gone.

`tools/animcheck.mjs` plays each first-person action frame by frame and measures the
**final world transform** of what the player actually looks at — the muzzle, both
fists, the moving parts — then asserts:

| Check | Catches |
| --- | --- |
| `jump` | largest single-frame movement of any tracked point — snapping |
| `reach` | distance from the support fist to the thing it should be holding |
| `recoil` | which way the barrel *and* the camera pitch when the weapon fires |
| `fired` | that the weapon discharged at all, so the rest means something |
| `finite` | no NaN reached the final transform |

It exits non-zero, so it gates an asset change.

`tools/fightercheck.mjs` (`npm run fightercheck`) is the third-person equivalent. It
drives a bare `FighterRig` with no AI, no world and no camera, walks it at every
heading — every pole *and* every midpoint between poles, which is where a blendspace is
at its worst — and asserts:

| Check | Catches |
| --- | --- |
| `used` vs `want` | the configured stride against the one the feet actually ask for |
| `slip` | how far the planted foot wanders across the floor while it is down |
| `pop` | biggest single-frame foot move as a multiple of the typical one |
| `sink` | a foot below the floor |
| `air` | both feet off the ground in a walk |
| `grip` | distance from the left fist to the weapon it is holding, per weapon, standing / walking / crouched / firing |
| `recoil` | that the muzzle actually swings under sustained automatic fire |
| bore height | the shouldered weapon's bore against the sight line — a weapon carried at the chest cannot clear cover its owner can see over |
| peek reach | how far a lean carries the muzzle, which is what combat may size its corner peek to |
| coverage | fraction of the drawn fighter the bone hitboxes actually cover, how much sticks out past him, and whether skull hits come back as head hits |
| transitions | worst single-frame head movement and blendspace churn through a dead stop, a standing start, an instant reversal, and per-frame heading noise |
| bob | how far the head rides up and down and side to side over one cycle |
| locked | the feet must not move *at all* when only aim or lean changes |
| reach | aim pitch, aim yaw and lean each sweep far enough, and the right way |

It also prints the solved stride table to paste into `GAITS`.

`tools/poses/locomotion.js` (`node tools/shot.mjs out.png --pose locomotion`) is the
matching view: eight fighters on a marked floor, each travelling a different heading
while all facing the camera. A match screenshot can never show this, because a fighter
chasing someone always travels where he looks — so a broken strafe or backpedal is
visible here and nowhere else. Add `?gaitSpeed=4.4` for the run, `?crouched` for the
crouch.

**A verification view must be one where the fault would be visible.** Two separate
bugs survived a screenshot each because the view could not have shown them: a crossed
pistol grip needed a third-person view of the *viewmodel* (`--pose armsrig`), and a
sliding foot needs a floor with a grid on it and a fighter walking sideways.

**Prefer a metric that cannot be fooled by the thing it is measuring.** Half the wrong
answers in the locomotion pass came from the bench, not the animation: a planted-foot
detector keyed on height caught the first frames of the swing and reported every gait
as needing a 27% shorter stride; tightening it then rejected the real stance on
*blended* poses, where the planted foot wobbles a few millimetres. Both were confident
and both were wrong. Deriving stance from the foot's direction of travel needs no
threshold and survives any blend. Likewise a per-frame slide speed cannot tell drift
from ripple — measure displacement from where the foot landed.

**Measure the composed result, not the inputs.** Every one of these bugs was invisible
in the thing being edited and obvious in the final transform. A keyframe that looks
sensible in isolation composes with a bind pose, a parent bone's roll, an additive
layer, an IK pass and a camera transform before a player sees it; check the end of
that chain.

Four traps live in the harness itself, and each one produced confident, wrong output
before it was found — a test bed that lies is worse than none:

- **Force `camera.updateMatrixWorld` before sampling.** `step` simulates but does not
  render, and `camera.matrixWorld` only refreshes at render time — so viewmodel
  transforms read one frame stale while IK-updated bones read current. That mismatch
  reported a perfectly placed hand as 30 cm off.
- **Isolate the bench from the match.** A live bout shoots back, and a dead player's
  update returns early. Every measurement after the first weapon silently froze, and
  the stuck pose was reported as a targeting error.
- **Baseline before the trigger, not after.** Sampling only after firing meant frame 0
  already held the recoil at full deflection, so the series that followed was the kick
  *decaying* — and every weapon read as recoiling downwards.
- **Automatic weapons read `triggerHeld`, semi-automatics `triggerQueued`.** Setting
  only one meant half the armoury was never tested while reporting clean.

## 9. Traps

Every one of these shipped a visible bug before it was understood. They are recorded
because each cost a full round of "fixed it" / "no you didn't", and every one of them
will recur the moment someone adds a weapon or a clip.

**Forward is −Z, rearward is +Z.** Barrels point down −Z (every entry in `MUZZLE` is
negative). A slide, bolt or pump being worked therefore travels **+Z**. This was
inverted for the whole life of the mechanism — with a comment cheerfully asserting
the opposite — so every gun in the game pushed its action forward when it cycled.

**A hand bone sits at the wrist, not where the hand closes.** Measure the fist: the
bone position plus its length along local Y. A grip check that compared bone positions
reported two hands 3.5 cm apart while the fists were 20 cm apart and the forearms were
crossed. If a metric cannot distinguish the fault from success, it is worse than no
metric, because it ends arguments in the wrong direction.

**Verify from a view where the fault is visible.** From inside the viewmodel the two
forearms overlap in screen space no matter how they are routed, so a crossed arm and a
correct one look identical. `tools/poses/armsrig.js` exists solely because there was
no such view, and the bug survived three "fixes" as a result.

**Pose-bone location is in the bone's own axes.** The hips bone points up, so its local
Y is up and its local Z is *forward*. Writing a "drop" into Z slides the fighter
backwards: the crouch folded the legs while the hips stayed put and the feet came off
the floor, and the death clips slid bodies backwards instead of laying them down.

**Bone roll decides which euler component is flexion.** Left to Blender's automatic
roll, rotating an arm bone about local X *abducted* it sideways, and the fighter built
in a splayed T-pose no matter what the animation data said. Every rig here pins local X
to world X explicitly (`set_roll`).

**Positive Z abduction pulls a limb toward the midline**, not away. The death clips were
authored assuming the opposite, so the splay meant to fling limbs apart drove them
across each other and the corpse came out with its wrists and ankles swapped.

**Blender and three.js do not compose euler rotations the same way.** Angles fitted in
the runtime do not survive being transplanted into Blender pose keys: a rack grip
measured 2 cm off the slide in the browser landed 24 cm off once baked into the clip.
Fit in the space you will apply in.

**Procedural offsets that multiply onto a bone compound.** The aim pass multiplied a
pitch onto the chest and head each frame, which is only safe if the mixer overwrites
those bones each frame — and a clip with no channel for a bone does not. Heads rotated
a little further every frame until they had spun all the way around. Restore the
pre-offset rotation before the mixer runs.

**IK must warm-start.** The mixer rewrites the arm from the clip every frame, so a
solver that cold-starts from the animation pose closes only part of the gap and is
reset before it finishes — the support hand trailed the magazine well by 11 cm forever
while converging perfectly in isolation. Resume from last frame's solution.

**Damping a signal at the source beats damping it at every consumer.** Smoothing the
heading inside `setStance` fixes it for the AI, the capture poses and the test bench at
once. The alternative — asking every caller to hand over a clean direction — is the
version where one of them forgets.

**A resolver that samples cannot see anything smaller than its step.** The player's hit
model marched in 0.35 m steps past a 0.22 m head. Every part of the system around it was
correct and headshots still did not work.

**Geometry that overlaps needs a stated winner.** Two volumes sharing a region resolve
by whichever the ray reaches first, which is almost never the answer a player expects
— a shot through the face entered the shoulder capsule first and was scored as an arm.

**A gameplay offset with no matching visual is a cheat, whatever it was meant to be.**
The peek offset, the tracer origin and the fire origin were three different points, and
the one the player could see was none of them. Anything that decides whether a shot
lands should come off the drawn pose, so that "he shot me from there" and "I could see
him there" cannot come apart.

**Two hands on one object cannot be posed separately.** Author one of them from the
object and derive the other. Both fighter arms were hand-keyed toward a rifle that was
itself hand-keyed, and the result was a weapon held out at arm's length with the support
hand 20 cm from the handguard — in every clip, on every weapon, for the whole game.

**An additive one-shot that is reset faster than it plays contributes nothing.** The
recoil clip peaks three frames in; an automatic weapon retriggered it every five, and
`reset()` puts an additive clip back at its zero frame. The fighters fired without
moving and the clip was perfectly correct.

**A local that shadows a parameter of the same name is invisible in review.** The
locomotion generator takes a `base` pose and later built a local `base` from the
stance; the keyed torso then no longer matched the one the legs had been solved
against, and the run came out 66% airborne. It looked like an animation problem and
was a scoping problem — caught only because the bench measures ground contact.

**An action that was never played still reports its default weight of 1.** Testing
`getEffectiveWeight()` alone to decide whether a clip is active declares every clip
active from the moment the rig is built — which switched the support-hand IK off
permanently the first time it was tried. Test `isRunning()` too.

**An FK leg has no notion of the floor.** Keying thigh and knee angles gives a walk
that skates, and the skating rate depends on the stride distance the runtime happens to
be configured with, so it cannot even be corrected downstream. Author the foot's path
over the ground and solve the joints.

**A blendspace only blends if every clip agrees about phase.** The lateral cycles were
authored with both feet moving the same way at once — fine on its own, and it collapsed
every diagonal that blended it: 0.10 m of foot travel against 0.55 m for the pure
forward. On these bones, making both feet move the same *world* direction takes
opposite Z values on the two thighs, and making them oppose — which is what a gait is —
takes the *same* value on both.

**A pose's own axis is not a world axis.** The lean pose keyed the hips as well as the
spine, and rotating the hips carries the legs, so the fighter's feet slid 6 cm sideways
when he leaned. Same class of fault as rolling the whole object, one bone further down.
Additive poses meant to layer over locomotion must touch spine and above only.

**A gait's hip height is absolute; the value written into the bone is a difference.**
Treating one as the other put the crouch's hips 20 cm too high, which pushed the ankle
targets outside the leg's reach and silently truncated the step. Only the solver's
residual check caught it.

**A clip cannot hold more keys than it has frames.** A 23-frame run cycle sampled 24
times collapsed pairs of keys onto the same exported frame and shortened the stride by
6%. Sample once per frame.

**Signs that cross three conventions are not worth deriving.** Which way `lean_r` leans
depends on this file's roll convention, Blender's axes and the glTF Y-up flip at once;
reasoning it out got it backwards, which puts a fighter out of the opposite side of
cover from the one combat believes he is exposing. Measure it.

**Aim the hand; do not pose it.** Every support-hand position that was posed by hand in
Blender missed its mark — the magazine hand grabbed at air, the shell hand came at the
loading port from above, the pump hand did not move with the pump. Targets are declared
as points on the weapon (`SUPPORT_TARGET`) and the arm is solved to reach them, so they
are right by construction and survive the weapon geometry changing.

## 10. Pipeline

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
