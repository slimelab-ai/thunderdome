"""Generate Thunderdome's low-poly arena prop pack with headless Blender.

Run from the repository root:
  blender --background --python tools/blender/generate_arena_props.py
"""

import bpy
import math
import os


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
OUT = os.path.join(ROOT, "public/assets/models")
os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def mat(name, color, metallic=0.0, roughness=0.7):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return m


def cube(name, loc, scale, material, bevel=0.025, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rotation)
    o = bpy.context.object
    o.name = name
    o.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material)
    if bevel:
        o.data.use_auto_smooth = True
        mod = o.modifiers.new("Worn edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        o.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    return o


def cyl(name, loc, radius, depth, material, vertices=16, rotation=(0, 0, 0), bevel=0.015):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(material)
    if bevel:
        o.data.use_auto_smooth = True
        mod = o.modifiers.new("Worn edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        o.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    return o


def torus(name, loc, major_radius, minor_radius, material, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        align="WORLD", major_segments=16, minor_segments=6,
        location=loc, rotation=rotation,
        major_radius=major_radius, minor_radius=minor_radius,
    )
    o = bpy.context.object
    o.name = name
    o.data.materials.append(material)
    o.data.use_auto_smooth = True
    o.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    return o


def export(name):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, name + ".glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )
    print("Exported", name)


def weapons_crate():
    reset()
    green = mat("Army paint", (0.12, 0.17, 0.12), metallic=0.15, roughness=0.82)
    dark = mat("Scraped steel", (0.055, 0.065, 0.06), metallic=0.75, roughness=0.4)
    yellow = mat("Warning paint", (0.9, 0.48, 0.025), metallic=0.05, roughness=0.65)
    cube("Crate shell", (0, 0, 0.665), (2.15, 1.76, 1.27), green, 0.07)
    for x in (-0.92, 0.92):
        cube("Corner armor", (x, -0.79, 0.7), (0.16, 0.12, 1.28), dark, 0.018)
        cube("Corner armor", (x, 0.79, 0.7), (0.16, 0.12, 1.28), dark, 0.018)
    for z in (0.12, 1.22):
        cube("Edge rail", (0, -0.84, z), (2.0, 0.1, 0.12), dark, 0.012)
        cube("Edge rail", (0, 0.84, z), (2.0, 0.1, 0.12), dark, 0.012)
    # Keep detail shells clear of the body. Intersections here become z-fighting
    # after non-uniform instance scaling in the arena.
    cube("Lid seam", (0, 0, 1.355), (1.9, 1.55, 0.09), dark, 0.018)
    cube("Latch", (-0.48, -0.91, 0.83), (0.26, 0.09, 0.38), dark, 0.02)
    cube("Latch", (0.48, -0.91, 0.83), (0.26, 0.09, 0.38), dark, 0.02)
    # A physical hazard stripe plate reads at FPS distance without texture memory.
    cube("Warning plate", (0, -0.92, 0.52), (0.62, 0.06, 0.28), yellow, 0.01)
    for x in (-0.25, 0, 0.25):
        cube("Stripe cut", (x, -0.958, 0.52), (0.09, 0.018, 0.34), dark, 0, rotation=(0, math.radians(25), 0))
    export("weapons_crate")


def hazard_barrel():
    reset()
    red = mat("Oxide red", (0.30, 0.045, 0.035), metallic=0.5, roughness=0.62)
    steel = mat("Bare steel", (0.12, 0.13, 0.13), metallic=0.82, roughness=0.38)
    cream = mat("Faded stencil", (0.72, 0.62, 0.3), metallic=0.1, roughness=0.75)
    cyl("Drum", (0, 0, 0.535), 0.405, 0.99, red, vertices=20, bevel=0.025)
    for z in (0.08, 0.32, 0.78, 1.02):
        cyl("Steel hoop", (0, 0, z), 0.43, 0.075, steel, vertices=20, bevel=0.01)
    cyl("Top", (0, 0, 1.055), 0.395, 0.045, steel, vertices=20, bevel=0.01)
    cyl("Cap", (0.18, 0.03, 1.095), 0.055, 0.035, cream, vertices=12, bevel=0.008)
    # Raised vertical warning bars give the silhouette a branded arena feel.
    for angle in range(0, 360, 90):
        a = math.radians(angle)
        cube("Warning slash", (0.414 * math.cos(a), 0.414 * math.sin(a), 0.55),
             (0.025, 0.11, 0.34), cream, 0.005, rotation=(0, 0, a))
    export("hazard_barrel")


def concrete_barricade():
    reset()
    concrete = mat("Dirty concrete", (0.28, 0.29, 0.30), roughness=0.96)
    steel = mat("Exposed rebar", (0.07, 0.075, 0.08), metallic=0.85, roughness=0.5)
    orange = mat("League orange", (0.92, 0.2, 0.025), roughness=0.72)
    cube("Barrier body", (0, 0, 0.62), (4.15, 0.56, 0.74), concrete, 0.065)
    cube("Left foot", (-1.55, 0, 0.18), (0.82, 0.92, 0.36), concrete, 0.045)
    cube("Right foot", (1.55, 0, 0.18), (0.82, 0.92, 0.36), concrete, 0.045)
    cube("Top rail", (0, 0, 1.045), (3.7, 0.62, 0.10), steel, 0.018)
    for x in (-1.6, -0.8, 0, 0.8, 1.6):
        cube("Hazard stripe", (x, -0.302, 0.66), (0.42, 0.025, 0.3), orange, 0.008,
             rotation=(0, math.radians(-28), 0))
    for x in (-1.78, 1.78):
        cyl("Rebar loop", (x, 0, 1.12), 0.06, 0.28, steel, vertices=10, rotation=(math.pi / 2, 0, 0), bevel=0.008)
    export("concrete_barricade")


def wrecked_car():
    reset()
    paint = mat("Burnt burgundy", (0.16, 0.035, 0.03), metallic=0.45, roughness=0.72)
    bare = mat("Scorched steel", (0.075, 0.07, 0.065), metallic=0.82, roughness=0.48)
    glass = mat("Smoked glass", (0.018, 0.035, 0.045), metallic=0.2, roughness=0.28)
    rubber = mat("Shredded tire", (0.012, 0.012, 0.014), roughness=0.95)
    rust = mat("Rust", (0.32, 0.085, 0.025), metallic=0.25, roughness=0.9)
    cube("Lower body", (0, 0, 0.72), (4.05, 1.82, 0.82), paint, 0.14)
    cube("Crushed cabin", (-0.28, 0, 1.34), (2.15, 1.62, 0.58), paint, 0.10, rotation=(0, math.radians(-3), 0))
    cube("Front windshield", (0.68, -0.825, 1.38), (0.72, 0.035, 0.42), glass, 0.015, rotation=(0, math.radians(-12), 0))
    cube("Rear windshield", (-1.02, -0.825, 1.34), (0.55, 0.035, 0.36), glass, 0.015, rotation=(0, math.radians(11), 0))
    cube("Torn hood", (1.43, 0, 1.11), (1.08, 1.68, 0.09), rust, 0.025, rotation=(0, math.radians(-6), 0))
    cube("Rear deck", (-1.48, 0, 1.03), (0.84, 1.7, 0.10), bare, 0.025)
    for x in (-1.35, 1.32):
        for y in (-0.91, 0.91):
            torus("Wheel", (x, y, 0.48), 0.29, 0.105, rubber, rotation=(math.pi / 2, 0, 0))
            cyl("Hub", (x, y, 0.48), 0.13, 0.08, bare, vertices=12, rotation=(math.pi / 2, 0, 0), bevel=0.008)
    cube("Bent bumper", (2.03, 0.14, 0.55), (0.13, 1.55, 0.15), bare, 0.025, rotation=(0, 0, math.radians(5)))
    cube("Missing door scar", (0.0, -0.935, 0.91), (1.02, 0.04, 0.52), bare, 0.012)
    export("wrecked_car")


def arena_gate():
    reset()
    steel = mat("Blackened steel", (0.035, 0.038, 0.045), metallic=0.85, roughness=0.44)
    rust = mat("Gate rust", (0.30, 0.075, 0.02), metallic=0.35, roughness=0.88)
    red = mat("Gate warning red", (0.72, 0.025, 0.02), metallic=0.1, roughness=0.62)
    cube("Left post", (-2.05, 0, 1.8), (0.45, 0.58, 3.6), steel, 0.055)
    cube("Right post", (2.05, 0, 1.8), (0.45, 0.58, 3.6), steel, 0.055)
    cube("Header", (0, 0, 3.38), (4.55, 0.62, 0.42), steel, 0.055)
    cube("Threshold", (0, 0, 0.12), (4.55, 0.62, 0.24), rust, 0.035)
    for x in (-1.65, -1.22, -0.79, -0.36, 0.07, 0.50, 0.93, 1.36, 1.65):
        cyl("Gate bar", (x, 0, 1.74), 0.055, 3.05, steel, vertices=10, bevel=0.01)
    cube("Cross brace", (0, 0.04, 1.75), (3.62, 0.10, 0.13), rust, 0.02, rotation=(0, math.radians(-28), 0))
    cube("TDX plate", (0, -0.34, 2.72), (1.0, 0.07, 0.42), red, 0.025)
    export("arena_gate")


def gantry_deck():
    reset()
    steel = mat("Gantry steel", (0.07, 0.08, 0.09), metallic=0.88, roughness=0.46)
    rust = mat("Gantry rust", (0.27, 0.065, 0.018), metallic=0.38, roughness=0.84)
    orange = mat("Safety orange", (0.92, 0.18, 0.018), roughness=0.68)
    cube("Deck plate", (0, 0, 0.15), (4.95, 3.95, 0.22), steel, 0.035)
    for x in (-2.25, -1.5, -0.75, 0, 0.75, 1.5, 2.25):
        cube("Deck rib", (x, 0, 0.295), (0.09, 3.8, 0.07), rust, 0.012)
    for y in (-1.78, 1.78):
        cube("Edge beam", (0, y, 0.08), (5.0, 0.16, 0.34), steel, 0.025)
    for x in (-2.32, 2.32):
        cube("End beam", (x, 0, 0.08), (0.16, 4.0, 0.34), steel, 0.025)
    for x in (-1.55, 0, 1.55):
        cube("Safety mark", (x, -1.875, 0.20), (0.65, 0.035, 0.16), orange, 0.008)
    export("gantry_deck")


weapons_crate()
hazard_barrel()
concrete_barricade()
wrecked_car()
arena_gate()
gantry_deck()
print("Arena prop pack complete:", OUT)
