"""Authors the arena prop pack.

    npm run assets:models -- props_arena

Every prop is joined into a single mesh before export, so a prop costs one draw
call per material rather than one per bolt — the previous pack shipped 15–25
separate objects each and the live arena was spending 978 draw calls on them.

Materials are canonical `TD_*` names only; the runtime binds the real textures
(see src/materials.js). Native dimensions are load-bearing: src/arena.js scales
each instance by `target / nativeSize`, so changing an overall size here means
changing the matching constant there.
"""

import sys
import os
import math

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from td_lib import (  # noqa: E402
    reset, cube, cyl, tube, torus, join, export, log,
)

# Texel density: one texture repeat per 2 metres, matching what the texture sets
# in tools/textures are authored for.
UV = 0.5


def weapons_crate():
    """Native 2.15 × 1.76 × 1.37 (X × Y × Z-up)."""
    reset()
    cube("Shell", (0, 0, 0.665), (2.15, 1.76, 1.27), "TD_wood", 0.07, uv_scale=UV)
    for x in (-0.92, 0.92):
        for y in (-0.79, 0.79):
            cube("Corner", (x, y, 0.7), (0.16, 0.12, 1.28), "TD_steel_painted", 0.018, uv_scale=UV)
    for z in (0.12, 1.22):
        for y in (-0.84, 0.84):
            cube("Rail", (0, y, z), (2.0, 0.1, 0.12), "TD_steel_painted", 0.012, uv_scale=UV)
    cube("Lid seam", (0, 0, 1.355), (1.9, 1.55, 0.09), "TD_steel_painted", 0.018, uv_scale=UV)
    for x in (-0.48, 0.48):
        cube("Latch", (x, -0.91, 0.83), (0.26, 0.09, 0.38), "TD_steel_painted", 0.02, uv_scale=UV)
    # A physical hazard stripe plate reads at FPS distance without texture memory.
    cube("Warning plate", (0, -0.92, 0.52), (0.62, 0.06, 0.28), "TD_orange", 0.01, uv_scale=UV)
    for x in (-0.25, 0, 0.25):
        cube("Stripe", (x, -0.958, 0.52), (0.09, 0.018, 0.34), "TD_steel_painted", 0,
             rotation=(0, math.radians(25), 0), uv_scale=UV)
    # stencilled crate markings as geometry, so they survive any texture change
    for y in (-0.2, 0.1, 0.4):
        cube("Stencil bar", (0.55, y, 1.28), (0.5, 0.07, 0.02), "TD_steel_painted", 0, uv_scale=UV)
    join("weapons_crate")
    export("weapons_crate", budget=1200)


def hazard_barrel():
    """Native radius 0.43, height 1.113."""
    reset()
    cyl("Drum", (0, 0, 0.535), 0.405, 0.99, "TD_rust", vertices=20, bevel=0.025, uv_scale=UV)
    for z in (0.08, 0.32, 0.78, 1.02):
        cyl("Hoop", (0, 0, z), 0.43, 0.075, "TD_steel_painted", vertices=16, bevel=0.01, uv_scale=UV)
    cyl("Top", (0, 0, 1.055), 0.395, 0.045, "TD_steel_painted", vertices=20, bevel=0.01, uv_scale=UV)
    cyl("Cap", (0.18, 0.03, 1.095), 0.055, 0.035, "TD_orange", vertices=12, bevel=0.008, uv_scale=UV)
    # Raised vertical warning bars give the silhouette a branded arena feel.
    for angle in range(0, 360, 90):
        a = math.radians(angle)
        cube("Warning slash", (0.414 * math.cos(a), 0.414 * math.sin(a), 0.55),
             (0.025, 0.11, 0.34), "TD_orange", 0.005, rotation=(0, 0, a), uv_scale=UV)
    join("hazard_barrel")
    export("hazard_barrel", budget=1200)


def concrete_barricade():
    """Native 4.15 × 0.92 × 1.18."""
    reset()
    cube("Body", (0, 0, 0.62), (4.15, 0.56, 0.74), "TD_concrete", 0.065, uv_scale=UV)
    for x in (-1.55, 1.55):
        cube("Foot", (x, 0, 0.18), (0.82, 0.92, 0.36), "TD_concrete", 0.045, uv_scale=UV)
    cube("Top rail", (0, 0, 1.045), (3.7, 0.62, 0.10), "TD_steel_painted", 0.018, uv_scale=UV)
    for x in (-1.6, -0.8, 0, 0.8, 1.6):
        cube("Hazard stripe", (x, -0.302, 0.66), (0.42, 0.025, 0.3), "TD_orange", 0.008,
             rotation=(0, math.radians(-28), 0), uv_scale=UV)
    for x in (-1.78, 1.78):
        cyl("Rebar loop", (x, 0, 1.12), 0.06, 0.28, "TD_rust", vertices=10,
            rotation=(math.pi / 2, 0, 0), bevel=0.008, uv_scale=UV)
    # cracked corner: a chunk knocked out of one end, so the barricade is not
    # bilaterally perfect and reads as used
    cube("Spall", (-2.02, 0.2, 0.95), (0.3, 0.26, 0.26), "TD_concrete", 0.02,
         rotation=(0.4, 0.3, 0.2), uv_scale=UV)
    join("concrete_barricade")
    export("concrete_barricade", budget=1200)


def wrecked_car():
    """Native ~4.3 × 1.9 × 1.7."""
    reset()
    cube("Lower body", (0, 0, 0.72), (4.05, 1.82, 0.82), "TD_rust", 0.14, uv_scale=UV)
    cube("Crushed cabin", (-0.28, 0, 1.34), (2.15, 1.62, 0.58), "TD_rust", 0.10,
         rotation=(0, math.radians(-3), 0), uv_scale=UV)
    for x, y, z, w, rot in ((0.68, -0.825, 1.38, 0.72, -12), (-1.02, -0.825, 1.34, 0.55, 11)):
        cube("Windshield", (x, y, z), (w, 0.035, 0.42 if w > 0.6 else 0.36), "TD_glass", 0.015,
             rotation=(0, math.radians(rot), 0), uv_scale=UV)
    cube("Torn hood", (1.43, 0, 1.11), (1.08, 1.68, 0.09), "TD_rust", 0.025,
         rotation=(0, math.radians(-6), 0), uv_scale=UV)
    cube("Rear deck", (-1.48, 0, 1.03), (0.84, 1.7, 0.10), "TD_steel_painted", 0.025, uv_scale=UV)
    for x in (-1.35, 1.32):
        for y in (-0.91, 0.91):
            torus("Wheel", (x, y, 0.48), 0.29, 0.105, "TD_rubber",
                  rotation=(math.pi / 2, 0, 0), major_segments=12, minor_segments=5, uv_scale=UV)
            cyl("Hub", (x, y, 0.48), 0.13, 0.08, "TD_steel_painted", vertices=10,
                rotation=(math.pi / 2, 0, 0), bevel=0.008, uv_scale=UV)
    cube("Bent bumper", (2.03, 0.14, 0.55), (0.13, 1.55, 0.15), "TD_steel_painted", 0.025,
         rotation=(0, 0, math.radians(5)), uv_scale=UV)
    cube("Door scar", (0.0, -0.935, 0.91), (1.02, 0.04, 0.52), "TD_steel_painted", 0.012, uv_scale=UV)
    join("wrecked_car")
    export("wrecked_car", budget=1600)


def arena_gate():
    """Native 4.55 × 0.62 × 3.6."""
    reset()
    for x in (-2.05, 2.05):
        cube("Post", (x, 0, 1.8), (0.45, 0.58, 3.6), "TD_steel_painted", 0.055, uv_scale=UV)
    cube("Header", (0, 0, 3.38), (4.55, 0.62, 0.42), "TD_steel_painted", 0.055, uv_scale=UV)
    cube("Threshold", (0, 0, 0.12), (4.55, 0.62, 0.24), "TD_rust", 0.035, uv_scale=UV)
    for x in (-1.65, -1.22, -0.79, -0.36, 0.07, 0.50, 0.93, 1.36, 1.65):
        tube("Bar", (x, 0, 1.74), 0.055, 3.05, "TD_steel_painted", vertices=8, uv_scale=UV)
    cube("Cross brace", (0, 0.04, 1.75), (3.62, 0.10, 0.13), "TD_rust", 0.02,
         rotation=(0, math.radians(-28), 0), uv_scale=UV)
    # The gate sign is the one lit element on the prop: an emissive plate over the
    # threshold, so each spawn tunnel glows red before the fighters walk out.
    cube("TDX plate", (0, -0.34, 2.72), (1.0, 0.07, 0.42), "TD_emissive_red", 0.025, uv_scale=UV)
    for x in (-1.9, 1.9):
        cyl("Hinge", (x, 0.24, 1.8), 0.09, 3.2, "TD_rust", vertices=8, uv_scale=UV)
    join("arena_gate")
    export("arena_gate", budget=1600)


def gantry_deck():
    """Native 5.0 × 4.0 × 0.3."""
    reset()
    cube("Deck plate", (0, 0, 0.15), (4.95, 3.95, 0.18), "TD_steel_plate", 0.03, uv_scale=UV)
    # Leave positive clearance above the plate. Merely touching its top face
    # produces unstable depth/shadow results after WebGL shadow projection.
    for x in (-2.25, -1.5, -0.75, 0, 0.75, 1.5, 2.25):
        cube("Deck rib", (x, 0, 0.265), (0.09, 3.8, 0.05), "TD_rust", 0.008, uv_scale=UV)
    for y in (-1.78, 1.78):
        cube("Edge beam", (0, y, 0.15), (5.0, 0.16, 0.30), "TD_steel_painted", 0.02, uv_scale=UV)
    for x in (-2.32, 2.32):
        cube("End beam", (x, 0, 0.15), (0.16, 4.0, 0.30), "TD_steel_painted", 0.02, uv_scale=UV)
    for x in (-1.55, 0, 1.55):
        cube("Safety mark", (x, -1.875, 0.25), (0.65, 0.035, 0.10), "TD_orange", 0.006, uv_scale=UV)
    join("gantry_deck")
    export("gantry_deck", budget=1200)


def arena_block():
    """Modular armored concrete cover. Native 7.95 × 1.057 × 2.65.

    Scaled non-uniformly at runtime for spawn screens, wing walls and the centre
    monolith, which is why the detail shells must stay clear of the body: touching
    faces z-fight once the instance is squashed.
    """
    reset()
    cube("Concrete core", (0, 0, 1.3), (7.9, 0.82, 2.48), "TD_concrete", 0.12, uv_scale=UV)
    cube("Steel cap", (0, 0, 2.57), (7.95, 0.94, 0.16), "TD_steel_painted", 0.035, uv_scale=UV)
    cube("Steel foot", (0, 0, 0.11), (7.95, 1.04, 0.22), "TD_steel_painted", 0.035, uv_scale=UV)
    for x in (-3.65, 3.65):
        cube("End armor", (x, 0, 1.3), (0.35, 0.98, 2.42), "TD_steel_painted", 0.045, uv_scale=UV)
        for z in (0.5, 1.3, 2.1):
            cyl("Armor bolt", (x, -0.51, z), 0.075, 0.055, "TD_orange",
                vertices=8, rotation=(math.pi / 2, 0, 0), bevel=0.008, uv_scale=UV)
    cube("Hazard inset", (0, -0.465, 1.36), (2.65, 0.055, 0.52), "TD_steel_painted", 0.018, uv_scale=UV)
    for x in (-0.92, -0.46, 0, 0.46, 0.92):
        cube("Hazard slash", (x, -0.502, 1.36), (0.20, 0.025, 0.58), "TD_orange",
             0.006, rotation=(0, math.radians(-24), 0), uv_scale=UV)
    join("arena_block")
    export("arena_block", budget=2000)


weapons_crate()
hazard_barrel()
concrete_barricade()
wrecked_car()
arena_gate()
gantry_deck()
arena_block()
log("Arena prop pack complete")
