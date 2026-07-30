# THUNDERDOME

A first-person arena shooter set in an underground kill league. Squads of mercenaries
fight to the death for money while a tournament master commentates and rigs the show.

Based on the pitch: underground UFC with guns. You start with nothing but a pistol,
climb ten ranks of increasingly dangerous squads, and everything is ultra-lethal —
2–3 body shots kill, a hit to your arm ruins your aim, a hit to your leg makes you limp.

Two modes share the same arena, inventory, combatants, and black-market catalog:

- **Circuits** is the ranked ladder career.
- **Liquidation** is a two-squad economic war. Equal bankrolls arrive through ten
  alternating draft rounds, both squads trade against the same scarce AMM item pools,
  and repeated self-bet bouts continue until one bankroll falls below zero. Liquidation
  sales receive the full live pool quote; Circuits keeps its 55% liquidation rate.

## Run it

```
npm install
npm run dev
```

Open http://localhost:5173 in a real browser (pointer lock needs one).

## How it plays

- **Controls**: WASD + mouse, LMB fire, RMB aim-down-sights, R reload, Shift sprint,
  C toggle crouch (sprint/jump stands you up), Space jump — or **clamber** up ledges
  and crates when you're facing one, Q/E **lean** around corners (leaning exposes
  part of your hitbox, and you can't lean through walls), 1–5 / scroll to switch
  weapons, Esc pauses. Starting a fight enters fullscreen; on Chromium the Keyboard
  Lock API captures shortcuts like Ctrl+W outright. Firefox has no keyboard lock, so
  a live bout arms a leave-page confirmation instead — a reflexive Ctrl+W asks
  before killing your run. No binding uses Ctrl.
- **Gamepad**: any standard-mapping pad (Xbox tested). Sticks move/aim with an
  exponential response curve, RT fire, LT ADS, A jump/clamber, B crouch, X reload,
  Y swap, LB/R3 knife, RB frag, L3 sprint, d-pad up/down medkit/splint, d-pad
  left/right lean, Start pauses/resumes.
- **Touch (mobile)**: standard mobile-FPS layout — floating left thumbstick moves
  (slam it forward to sprint), drag anywhere on the right to aim (including while
  holding FIRE), buttons for ADS (toggle), jump, reload, crouch, swap, knife,
  grenade, medkit, splint, pause.
- **Aim assist** (controller + touch only, never mouse): Apex-style — sensitivity
  friction inside a slow cone around a visible enemy plus a small rotational pull
  while you're actively steering or shooting. Tunables live in `src/input.js`
  (`window.__game.tuning` at runtime for live tweaking on device).
- **Locational damage** (both directions): headshots are lethal, arm hits multiply
  weapon spread and recoil, leg hits cut movement speed and add a limp. Applies to
  you *and* every AI fighter — shoot a rifleman in the arm and watch him spray.
- **The ladder**: Rank 10 (two sewer rats with pistols) up to Rank 1 — GOLIATH,
  a 650 HP armored champion with a gold mask, and his honor guard.
- **Blood money**: kills, headshots and win purses pay out. Spend it in the black
  market between bouts: 5 weapons (pistol → SMG → shotgun → rifle → DMR), modular
  armor slots (helmet / vest / limb pads, two tiers each), consumables (medkits [H],
  splint kits [V], frag grenades [G]), 3 training tracks (marksmanship / cardio /
  pain tolerance), and up to five hired mercenaries — rookie, veteran, elite tiers
  set base stats; upgrade or sell them anytime. Every recruit signs on with just a
  pistol: buy +CREW weapon and armor copies into the stash and fit each merc with
  the per-member KIT editor. Recruits are permanent — knocked out mid-match, back
  next bout at half health. Wounds carry over for everyone (you included): pay the
  MEDICAL bill between bouts or fight hurt. Go into debt to the house and your
  career ends at the wrong end of a pistol.
  Squads roll an opening play each match (flanks, splits, gantry rushes), and
  bots sprint, corner-peek with a real lean,
  crouch with an articulated pose, bandage themselves, throw frags at hiding spots,
  and surge if you let a standoff drag. VULTURE speaks his commentary out loud
  (Web Speech API — no audio assets).
- **The tournament master**: VULTURE commentates every kill and randomly "spices
  things up": LIGHTS OUT, GAS LEAK, MOLOTOV RAIN, CARE PACKAGE, CROWD FRENZY
  (double payout).
- Career auto-saves to localStorage. Death costs you 15% of your bankroll and a
  rematch. Beat Rank 1 to take the belt.

## Tech

Vite + Three.js. The visual side is documented in full in [docs/ART.md](docs/ART.md) —
palette, lighting rules, material standard, poly/draw budgets and animation rules.
The short version:

- **Forward pipeline with a post chain** in `src/render.js`: HDR scene → GTAO → bloom →
  ACES tone map → SMAA → colour grade (split-tone, vignette, grain, chromatic
  aberration). Four quality tiers, auto-selected from the device on first run and
  overridable at runtime, plus adaptive resolution that trims the render scale when
  frames run long. Ambient occlusion is `ultra` only — it is the most expensive pass
  and the least missed in a room this dark.
- **PBR throughout.** Every surface is a `MeshStandardMaterial` fed by a baked
  albedo/normal/ORM set. A reflection probe rendered from inside the pit provides the
  environment map, so cage steel and gunmetal actually read as metal.
- **Shared material registry** (`src/materials.js`). Assets ship geometry only, with
  materials named `TD_*`; the runtime binds the real textures. The whole arena runs
  on about ten materials, and UVs are world-scaled so a wall and a crate show the
  same size of aggregate.
- **First-person arms** (`src/viewmodel.js`) wrapped around the same authored weapon
  the world uses, with draw/reload/melee clips time-scaled to each weapon's own
  durations and per-weapon grip pins for the support hand.
- **Skinned fighters** (`src/fighter-rig.js`). One 20-bone skinned mesh with a
  two-layer animation state machine: locomotion crossfades on a speed/stance graph,
  and aim/fire/reload/throw/flinch layer over it as additive clips. Hitboxes are
  invisible boxes parented to bones, so combat raycasts follow the animation and the
  visual mesh is never the collision surface.
- **Everything is reproducible output.** No `.blend` files, no hand-edited textures:
  geometry comes from headless Blender scripts and textures from a Canvas2D bakery
  that runs in headless Chrome.
- **Audio ships no assets either** — every sound is synthesized with WebAudio
  (per-weapon gunshots, crowd ambience that roars on kills, klaxons, ricochets), and
  VULTURE's commentary is spoken through the Web Speech API.

```sh
npm run assets          # textures then models
npm run assets:tex      # tools/textures/*.mjs  → public/assets/textures/*.webp
npm run assets:models   # tools/blender/*.py    → public/assets/models/*.glb
npm run assets:models -- fighter    # just one script
```

Look changes are reviewed by script rather than by eye-balling a running game:

```sh
npm run dev
node tools/shot.mjs shots/arena.png --pose arena     # lighting reference frame
node tools/shot.mjs shots/f.png --pose fighters      # character turntable
node tools/shot.mjs shots/m.png --pose match         # live first-person frame
node tools/shot.mjs shots/d.png --pose diag          # draw calls + scene report
```

| File | What it is |
| --- | --- |
| `src/main.js` | Game state machine, match lifecycle, squads/ranks, events, economy, save |
| `src/render.js` | Render pipeline: post-processing chain, quality tiers, reflection probe |
| `src/materials.js` | Shared PBR material registry, world-scale UV projection, GLB material binding |
| `src/player.js` | FPS controller: movement, ADS, recoil/bloom, limb-damage effects, viewmodel |
| `src/input.js` | Gamepad polling, exponential stick curves, aim assist (friction + rotational pull) |
| `src/touch.js` | Mobile touch UI: virtual thumbstick, drag-aim surface, action buttons |
| `src/fighter-rig.js` | Skinned fighter: animation state machine, additive upper body, bone hitboxes |
| `src/combatant.js` | Squad AI for both teams, driving the rig above |
| `src/combat.js` | Hitscan ballistics, spread, wall/capsule intersection, damage model |
| `src/arena.js` | The pit: geometry, colliders, lighting rig, crowd, signage, flank gantries |
| `src/nav.js` | Multi-layer 3D navmesh: per-surface nodes (floor + decks overlap), walk/drop links, A*, string-pulling |
| `src/weapons.js` | Weapon stats, authored models, moving-part animation |
| `src/viewmodel.js` | First-person arms: clip state machine, per-weapon grip pins |
| `src/fx.js` | Pooled particles, tracers, muzzle flash, blood decals |
| `src/announcer.js` | VULTURE's commentary library and ticker |
| `src/ui.js` | HUD, body-damage diagram, killfeed, shop, screens |
| `src/audio.js` | Synthesized audio engine |
| `tools/blender/` | Headless Blender authoring: shared library, arena props, fighter, weapons |
| `tools/textures/` | Canvas2D PBR texture bakery, run in headless Chrome |
| `tools/shot.mjs` | Scripted visual capture harness and its poses |

Debug: `window.__game` exposes `{world, match, player, phase, career, renderer, camera,
scene, pipeline, stats, step(dt, n), setLocked(v), setQuality(tier), fight(mode, rank),
freeCam(pos, look)}` for headless simulation and capture. `__game.stats` reports the
live quality tier, render scale, draw calls and render time.

## Gameplay analytics

The Docker stack includes an append-only collector behind `POST /api/analytics`.
The browser batches schema-versioned, client-unverified events; the collector adds
receipt time and a salted source hash, then writes one NDJSON file per UTC day to
the `analytics-data` volume. Core events cover Liquidation AI decisions and market
actions, draft funding, match entry/exit squad states, and kills.

The collector creates a private source-hash salt on first boot and retains it in
the analytics volume. Set `ANALYTICS_IP_SALT` only to override that value. Daily
files older than `ANALYTICS_RETENTION_DAYS` (90 by default) are removed automatically.
To inspect a day without copying it out of the volume:

```sh
docker exec thunderdome_analytics sh -c 'tail -n 20 /data/events-$(date -u +%F).ndjson'
```

### Private synthetic Liquidation wars

The repository also has a Node-only simulation harness. It is not imported by the
website or included in the browser build. Two copies of the Liquidation bot shop
against one shared market, fight a seeded event-level combat model, and persist the
strategy and combat stream for offline analysis.

```sh
npm run simulate:liquidation -- --matches 10 --seed 20260730
```

Each batch is written under `data/synthetic-liquidation/` as raw `events.ndjson`,
per-war results, a JSON aggregate, and a ten-war Markdown report. Use `--output`
to put batches on a persistent analysis volume.
