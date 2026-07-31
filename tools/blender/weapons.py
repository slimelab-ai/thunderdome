"""Authors the weapon pack.

    npm run assets:models -- weapons

One GLB per weapon: `pistol`, `smg`, `shotgun`, `rifle`, `dmr`, `knife`.

**Orientation.** The barrel runs along Blender +Y, which the exporter's Y-up
conversion turns into glTF -Z, and "up" is Blender +Z → glTF +Y. That matches both
the fighter's hand socket (whose local -Z tracks the forearm) and the first-person
viewmodel convention in src/weapons.js, so a weapon attaches with an identity
transform in either place. The origin is at the grip, where a hand closes on it.

**Named moving parts.** Static geometry is joined into `body`, but the parts that
move when the weapon is worked — `slide`, `mag`, `bolt`, `pump` — stay separate
objects so the runtime can animate them (see `animateWeaponParts` in src/weapons.js).
A gun whose slide cycles when it fires reads as a mechanism instead of a prop, and
it is the cheapest possible way to make firing legible in first person.

**Sights stay separate too, and every weapon has a matched pair.** `sight_rear` and
`sight_front` are exported unjoined so the runtime can read the line between them and
put it on the camera's axis when the player aims. That is the whole of the ironsight
system: aiming is not a hand-tuned offset per weapon, it is a solve against the sights
that are actually modelled, so a weapon whose sights move is still aimed correctly and
a new weapon needs nothing but a pair of sights.

The two must be at the same height above the bore, or close to it — the line between
them *is* the aiming line, and the barrel is placed relative to it, not the other way
round. A scope is the same idea with the ocular and the objective standing in for the
rear and front.
"""

import sys
import os
import math

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from td_lib import reset, cube, cyl, tube, join, export, log  # noqa: E402

METAL = "TD_gunmetal"
DARK = "TD_steel_painted"
GRIP = "TD_rubber"
WOOD = "TD_wood"

# Weapons are seen from 30 cm in first person, so they get a denser texel rate than
# the arena: one repeat per 25 cm.
UV = 4.0


def finish(name, moving=(), budget=900):
    """Join everything except the moving parts and the sights, then export.

    Sights are held out of the join because the runtime has to find them: the aiming
    transform is solved from where they actually are, so they cannot be baked into an
    anonymous mesh. Failing to export a matched pair is a build error rather than a
    weapon that quietly cannot be aimed.
    """
    import bpy
    keep = {m.name for m in moving} | {"sight_rear", "sight_front"}
    have = {o.name for o in bpy.data.objects if o.type == "MESH"}
    missing = {"sight_rear", "sight_front"} - have
    if missing and name != "knife":
        raise RuntimeError(f"{name}: no {', '.join(sorted(missing))} — it cannot be aimed")
    statics = [o for o in bpy.data.objects if o.type == "MESH" and o.name not in keep]
    if statics:
        join("body", statics)
    export(name, budget=budget)


def pistol():
    reset()
    slide = cube("slide", (0, 0.06, 0.035), (0.036, 0.20, 0.048), METAL, 0.008, uv_scale=UV)
    cube("frame", (0, 0.03, -0.005), (0.032, 0.15, 0.042), DARK, 0.008, uv_scale=UV)
    cube("grip", (0, -0.025, -0.075), (0.034, 0.055, 0.115), GRIP, 0.012,
         rotation=(math.radians(-12), 0, 0), uv_scale=UV)
    cube("trigger guard", (0, 0.012, -0.028), (0.020, 0.055, 0.012), DARK, 0.004, uv_scale=UV)
    tube("barrel", (0, 0.145, 0.035), 0.009, 0.05, METAL, vertices=8,
         rotation=(math.radians(90), 0, 0), uv_scale=UV)
    cube("sight_rear", (0, -0.028, 0.064), (0.026, 0.012, 0.010), DARK, 0.002, uv_scale=UV)
    cube("sight_front", (0, 0.145, 0.064), (0.006, 0.010, 0.012), DARK, 0.002, uv_scale=UV)
    mag = cube("mag", (0, -0.012, -0.09), (0.026, 0.040, 0.10), DARK, 0.006, uv_scale=UV)
    finish("pistol", moving=(slide, mag), budget=700)


def smg():
    reset()
    cube("receiver", (0, 0.08, 0.03), (0.042, 0.28, 0.062), METAL, 0.008, uv_scale=UV)
    bolt = cube("bolt", (0.028, 0.10, 0.052), (0.016, 0.09, 0.024), DARK, 0.004, uv_scale=UV)
    cube("handguard", (0, 0.24, 0.028), (0.036, 0.14, 0.044), DARK, 0.008, uv_scale=UV)
    tube("barrel", (0, 0.35, 0.032), 0.008, 0.10, METAL, vertices=8,
         rotation=(math.radians(90), 0, 0), uv_scale=UV)
    cube("muzzle brake", (0, 0.40, 0.032), (0.022, 0.045, 0.022), DARK, 0.005, uv_scale=UV)
    cube("grip", (0, -0.03, -0.06), (0.032, 0.050, 0.12), GRIP, 0.012,
         rotation=(math.radians(-10), 0, 0), uv_scale=UV)
    mag = cube("mag", (0, 0.055, -0.10), (0.028, 0.055, 0.16), DARK, 0.006,
               rotation=(math.radians(4), 0, 0), uv_scale=UV)
    cube("stock strut", (0, -0.13, 0.03), (0.020, 0.16, 0.020), DARK, 0.005, uv_scale=UV)
    cube("stock plate", (0, -0.21, 0.015), (0.055, 0.020, 0.075), DARK, 0.008, uv_scale=UV)
    cube("top rail", (0, 0.10, 0.066), (0.020, 0.16, 0.010), DARK, 0.002, uv_scale=UV)
    # Flip-up irons on the rail. The SMG had a rail and nothing on it, so there was no
    # line to aim along at all.
    cube("sight_rear", (0, 0.035, 0.080), (0.024, 0.010, 0.018), DARK, 0.002, uv_scale=UV)
    cube("sight_front", (0, 0.335, 0.080), (0.007, 0.010, 0.018), DARK, 0.002, uv_scale=UV)
    finish("smg", moving=(bolt, mag), budget=900)


def shotgun():
    reset()
    tube("barrel", (0, 0.34, 0.045), 0.0135, 0.62, METAL, vertices=10,
         rotation=(math.radians(90), 0, 0), uv_scale=UV)
    tube("tube", (0, 0.30, 0.010), 0.0125, 0.50, DARK, vertices=8,
         rotation=(math.radians(90), 0, 0), uv_scale=UV)
    pump = cube("pump", (0, 0.24, 0.012), (0.048, 0.13, 0.050), WOOD, 0.014, uv_scale=UV)
    cube("receiver", (0, 0.03, 0.030), (0.044, 0.20, 0.070), METAL, 0.010, uv_scale=UV)
    cube("ejection port", (0.024, 0.06, 0.042), (0.010, 0.075, 0.030), DARK, 0.003, uv_scale=UV)
    cube("grip wrist", (0, -0.09, -0.020), (0.040, 0.11, 0.070), WOOD, 0.016,
         rotation=(math.radians(-14), 0, 0), uv_scale=UV)
    cube("stock", (0, -0.22, -0.010), (0.048, 0.18, 0.090), WOOD, 0.018,
         rotation=(math.radians(-6), 0, 0), uv_scale=UV)
    cube("butt plate", (0, -0.305, -0.020), (0.050, 0.016, 0.100), GRIP, 0.006, uv_scale=UV)
    # A bead alone has no rear reference, so aiming one is guesswork. The notch on the
    # receiver gives the pair a line; the bead keeps its silhouette.
    cube("sight_front", (0, 0.63, 0.062), (0.007, 0.010, 0.014), DARK, 0.002, uv_scale=UV)
    cube("sight_rear", (0, -0.045, 0.066), (0.024, 0.012, 0.010), DARK, 0.002, uv_scale=UV)
    finish("shotgun", moving=(pump,), budget=900)


def rifle():
    reset()
    cube("receiver", (0, 0.06, 0.035), (0.042, 0.26, 0.070), METAL, 0.009, uv_scale=UV)
    bolt = cube("bolt", (0.026, 0.10, 0.058), (0.018, 0.10, 0.026), DARK, 0.004, uv_scale=UV)
    cube("handguard", (0, 0.26, 0.036), (0.044, 0.20, 0.056), WOOD, 0.012, uv_scale=UV)
    cube("gas block", (0, 0.37, 0.062), (0.026, 0.06, 0.030), DARK, 0.006, uv_scale=UV)
    tube("barrel", (0, 0.44, 0.038), 0.0085, 0.20, METAL, vertices=8,
         rotation=(math.radians(90), 0, 0), uv_scale=UV)
    cube("muzzle device", (0, 0.545, 0.038), (0.024, 0.055, 0.024), DARK, 0.005, uv_scale=UV)
    # curved magazine, faked with two segments — a real curve costs geometry nobody sees
    mag = cube("mag", (0, 0.00, -0.075), (0.030, 0.062, 0.13), DARK, 0.007,
               rotation=(math.radians(10), 0, 0), uv_scale=UV)
    cube("mag lower", (0, -0.035, -0.175), (0.030, 0.060, 0.075), DARK, 0.007,
         rotation=(math.radians(26), 0, 0), uv_scale=UV)
    cube("grip", (0, -0.09, -0.055), (0.032, 0.050, 0.115), GRIP, 0.012,
         rotation=(math.radians(-14), 0, 0), uv_scale=UV)
    cube("stock", (0, -0.22, 0.010), (0.042, 0.20, 0.085), WOOD, 0.016,
         rotation=(math.radians(-5), 0, 0), uv_scale=UV)
    cube("sight_rear", (0, -0.06, 0.076), (0.022, 0.020, 0.016), DARK, 0.003, uv_scale=UV)
    cube("sight_front", (0, 0.40, 0.082), (0.008, 0.012, 0.022), DARK, 0.002, uv_scale=UV)
    finish("rifle", moving=(bolt, mag), budget=1000)


def dmr():
    reset()
    cube("receiver", (0, 0.05, 0.035), (0.044, 0.32, 0.072), METAL, 0.009, uv_scale=UV)
    bolt = cube("bolt", (0.027, 0.10, 0.058), (0.018, 0.11, 0.026), DARK, 0.004, uv_scale=UV)
    tube("barrel", (0, 0.42, 0.040), 0.0095, 0.42, METAL, vertices=10,
         rotation=(math.radians(90), 0, 0), uv_scale=UV)
    cube("handguard", (0, 0.30, 0.038), (0.040, 0.22, 0.050), DARK, 0.010, uv_scale=UV)
    cube("suppressor", (0, 0.65, 0.040), (0.030, 0.11, 0.030), DARK, 0.008, uv_scale=UV)
    # scope: the DMR's whole silhouette cue
    cyl("scope body", (0, 0.10, 0.105), 0.021, 0.24, DARK, vertices=12,
        rotation=(math.radians(90), 0, 0), uv_scale=UV)
    cyl("sight_front", (0, 0.23, 0.105), 0.027, 0.05, DARK, vertices=12,
        rotation=(math.radians(90), 0, 0), uv_scale=UV)
    # Ocular bell. The scope had no back end, which looked odd and left the sight line
    # with only one point to be defined by.
    cyl("sight_rear", (0, -0.035, 0.105), 0.025, 0.05, DARK, vertices=12,
        rotation=(math.radians(90), 0, 0), uv_scale=UV)
    for y in (0.02, 0.18):
        cube("scope ring", (0, y, 0.088), (0.022, 0.020, 0.040), METAL, 0.004, uv_scale=UV)
    mag = cube("mag", (0, -0.01, -0.070), (0.028, 0.055, 0.115), DARK, 0.007,
               rotation=(math.radians(6), 0, 0), uv_scale=UV)
    cube("grip", (0, -0.10, -0.050), (0.032, 0.050, 0.115), GRIP, 0.012,
         rotation=(math.radians(-14), 0, 0), uv_scale=UV)
    cube("stock", (0, -0.24, 0.012), (0.044, 0.22, 0.090), DARK, 0.016,
         rotation=(math.radians(-4), 0, 0), uv_scale=UV)
    cube("cheek riser", (0, -0.23, 0.062), (0.036, 0.14, 0.024), GRIP, 0.008, uv_scale=UV)
    finish("dmr", moving=(bolt, mag), budget=1100)


def knife():
    reset()
    # Big, bright, edge-forward. It has to read instantly as a knife at a glance.
    cube("blade", (0, 0.14, 0.010), (0.006, 0.22, 0.042), METAL, 0.002, uv_scale=UV)
    cube("edge", (0, 0.14, -0.014), (0.003, 0.22, 0.014), METAL, 0.001, uv_scale=UV)
    cube("tip", (0, 0.27, 0.004), (0.005, 0.05, 0.026), METAL, 0.002,
         rotation=(0, 0, math.radians(-6)), uv_scale=UV)
    cube("fuller", (0.004, 0.14, 0.016), (0.002, 0.17, 0.010), DARK, 0, uv_scale=UV)
    cube("guard", (0, 0.022, 0.004), (0.030, 0.014, 0.058), DARK, 0.004, uv_scale=UV)
    cube("handle", (0, -0.055, 0.004), (0.024, 0.115, 0.032), GRIP, 0.010, uv_scale=UV)
    cube("pommel", (0, -0.118, 0.004), (0.026, 0.014, 0.034), DARK, 0.004, uv_scale=UV)
    finish("knife", budget=500)


for build in (pistol, smg, shotgun, rifle, dmr, knife):
    build()
log("Weapon pack complete")
