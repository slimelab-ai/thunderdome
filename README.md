# THUNDERDOME

A first-person arena shooter set in an underground kill league. Squads of mercenaries
fight to the death for money while a tournament master commentates and rigs the show.

Based on the pitch: underground UFC with guns. You start with nothing but a pistol,
climb ten ranks of increasingly dangerous squads, and everything is ultra-lethal —
2–3 body shots kill, a hit to your arm ruins your aim, a hit to your leg makes you limp.

Two modes share the same arena, inventory, combatants, and black-market catalog:

- **Circuits** is the ranked ladder career.
- **Attrition** is a two-squad economic war. Equal bankrolls arrive through ten
  alternating draft rounds, both squads trade against the same scarce AMM item pools,
  and repeated self-bet bouts continue until one bankroll falls below zero. Attrition
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

Vite + Three.js. Signature arena props are authored as optimized GLB models in
headless Blender; the environment around them remains procedural, textures are
generated on canvas (concrete grime, neon signage, odds board), and every sound is
synthesized with WebAudio (per-weapon gunshots, crowd ambience that roars on kills,
klaxons, ricochets).

Regenerate the arena prop pack with
`blender --background --python tools/blender/generate_arena_props.py`.

| File | What it is |
| --- | --- |
| `src/main.js` | Game state machine, match lifecycle, squads/ranks, events, economy, save |
| `src/player.js` | FPS controller: movement, ADS, recoil/bloom, limb-damage effects, viewmodel |
| `src/combatant.js` | Humanoid rigs with per-limb hitboxes + full squad AI (both teams) |
| `src/combat.js` | Hitscan ballistics, spread, wall/capsule intersection, damage model |
| `src/arena.js` | The pit: geometry, colliders, lighting rig, crowd, signage, flank gantries |
| `src/nav.js` | Multi-layer 3D navmesh: per-surface nodes (floor + decks overlap), walk/drop links, A*, string-pulling |
| `src/weapons.js` | Weapon stats + procedural viewmodels |
| `src/fx.js` | Pooled particles, tracers, muzzle flash, blood decals |
| `src/announcer.js` | VULTURE's commentary library and ticker |
| `src/ui.js` | HUD, body-damage diagram, killfeed, shop, screens |
| `src/audio.js` | Synthesized audio engine |

Debug: `window.__game` exposes `{world, match, player, phase, career, step(dt, n), setLocked(v)}`
for headless simulation of match frames.
