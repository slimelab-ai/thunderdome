"""Shared authoring library for every Thunderdome Blender script.

Import it from a sibling script:

    import sys, os
    sys.path.append(os.path.dirname(__file__))
    from td_lib import *

Two things here matter beyond convenience:

**Material convention.** Assets do not ship their own textures. Every material is
named from `MATERIALS` below, and at load time the runtime swaps each one for a
shared `MeshStandardMaterial` carrying the baked PBR set (see `src/materials.js`).
That keeps GLBs in the tens of kilobytes, gives the whole arena one steel material
instead of thirty, and means a texture change needs no model rebuild.

**Version compatibility.** Blender removed `mesh.use_auto_smooth` in 4.1, which
silently broke the original prop script — it had been authored against 4.0 and
every rebuild died on the first bevel. `auto_smooth()` handles both.
"""

import bpy
import math
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
MODELS = os.path.join(ROOT, "public/assets/models")
os.makedirs(MODELS, exist_ok=True)

IS_41_PLUS = bpy.app.version >= (4, 1, 0)

# Canonical material names. Base colour/metallic/roughness here are the Blender-side
# preview and the runtime fallback if a name is ever missing from the JS registry;
# the shipped look comes from the texture set the runtime binds to the same name.
MATERIALS = {
    "TD_concrete":      ((0.32, 0.33, 0.35), 0.0, 0.92),
    "TD_steel_painted": ((0.10, 0.11, 0.13), 0.05, 0.55),
    "TD_steel_plate":   ((0.42, 0.44, 0.47), 0.90, 0.42),
    "TD_rust":          ((0.30, 0.12, 0.05), 0.0, 0.90),
    "TD_gunmetal":      ((0.26, 0.27, 0.29), 0.92, 0.36),
    "TD_orange":        ((0.92, 0.20, 0.02), 0.0, 0.68),
    "TD_gold":          ((0.78, 0.60, 0.20), 0.95, 0.30),
    "TD_rubber":        ((0.035, 0.035, 0.04), 0.0, 0.92),
    "TD_glass":         ((0.05, 0.07, 0.08), 0.0, 0.18),
    "TD_skin":          ((0.60, 0.42, 0.33), 0.0, 0.68),
    "TD_cloth":         ((0.19, 0.20, 0.17), 0.0, 0.90),
    "TD_webbing":       ((0.09, 0.09, 0.10), 0.25, 0.60),
    # Fighters carry exactly two slots: everything that is never team-coloured
    # (skin, helmet, webbing, boots) and the uniform, which the runtime tints per
    # squad. Two draw calls per fighter, four materials for the whole cast.
    "TD_fighter_body":  ((0.42, 0.34, 0.29), 0.05, 0.70),
    "TD_fighter_uniform": ((0.19, 0.20, 0.17), 0.0, 0.90),
    "TD_wood":          ((0.28, 0.17, 0.09), 0.0, 0.80),
    "TD_emissive_red":  ((0.85, 0.06, 0.06), 0.0, 0.45),
}


def log(*args):
    print(*args)
    sys.stdout.flush()


def reset():
    """Empty the scene, including orphaned datablocks from the previous asset."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for blocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials,
                   bpy.data.armatures, bpy.data.actions, bpy.data.objects):
        for block in list(blocks):
            if block.users == 0:
                blocks.remove(block)


_mat_cache = {}


def mat(name):
    """Fetch (creating once) one of the canonical materials."""
    if name not in MATERIALS:
        raise KeyError(f"{name} is not a canonical material; add it to MATERIALS")
    if name in _mat_cache and name in bpy.data.materials:
        return bpy.data.materials[name]
    color, metallic, roughness = MATERIALS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.diffuse_color = (*color, 1)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if name.startswith("TD_emissive"):
        bsdf.inputs["Emission Color"].default_value = (*color, 1)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    _mat_cache[name] = m
    return m


def auto_smooth(o, angle_deg=38):
    """Shade smooth with a sharp-edge angle, on any Blender from 3.x to 4.4+."""
    angle = math.radians(angle_deg)
    if IS_41_PLUS:
        # 4.1 replaced the mesh flag with a "Smooth by Angle" geometry-nodes modifier
        # that the operator adds for us. It must be applied after any bevel, which is
        # why this is called at the end of each primitive helper.
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.shade_auto_smooth(angle=angle)
    else:
        o.data.use_auto_smooth = True
        o.data.auto_smooth_angle = angle


def _finish(o, material, bevel, bevel_segments=None, smooth=True, uv_scale=1.0):
    o.data.materials.append(mat(material) if isinstance(material, str) else material)
    if bevel:
        m = o.modifiers.new("Worn edges", "BEVEL")
        m.width = bevel
        # A two-segment bevel on a 3 cm bolt costs the same geometry as one on a 3 m
        # slab and is invisible. Small details get a single segment, which roughly
        # halved the prop pack's triangle count.
        m.segments = bevel_segments if bevel_segments else (2 if bevel >= 0.03 else 1)
        m.limit_method = "ANGLE"
        m.angle_limit = math.radians(30)
        o.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
    box_uv(o, uv_scale)
    if smooth:
        auto_smooth(o)
    return o


def box_uv(o, scale=1.0):
    """Cube-project UVs at uniform world texel density.

    Tiling trim textures need world-scale UVs, not a per-object 0..1 unwrap: two
    props of different sizes must show the same size of concrete aggregate. Cube
    projection at a fixed cube size gives exactly that.
    """
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=1.0 / max(1e-4, scale), correct_aspect=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def cube(name, loc, size, material, bevel=0.025, rotation=(0, 0, 0), uv_scale=1.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rotation)
    o = bpy.context.object
    o.name = name
    o.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(o, material, bevel, uv_scale=uv_scale)


def cyl(name, loc, radius, depth, material, vertices=16, rotation=(0, 0, 0),
        bevel=0.015, uv_scale=1.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth,
                                        location=loc, rotation=rotation)
    o = bpy.context.object
    o.name = name
    return _finish(o, material, bevel, uv_scale=uv_scale)


def tube(name, loc, radius, depth, material, vertices=12, rotation=(0, 0, 0), uv_scale=1.0):
    """Open-ended cylinder — cheaper than `cyl` for bars whose caps are never seen."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth,
                                        location=loc, rotation=rotation,
                                        end_fill_type="NOTHING")
    o = bpy.context.object
    o.name = name
    return _finish(o, material, 0, uv_scale=uv_scale)


def sphere(name, loc, radius, material, segments=16, rings=8, uv_scale=1.0):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings,
                                         radius=radius, location=loc)
    o = bpy.context.object
    o.name = name
    return _finish(o, material, 0, uv_scale=uv_scale)


def torus(name, loc, major_radius, minor_radius, material, rotation=(0, 0, 0),
          major_segments=16, minor_segments=6, uv_scale=1.0):
    bpy.ops.mesh.primitive_torus_add(
        align="WORLD", major_segments=major_segments, minor_segments=minor_segments,
        location=loc, rotation=rotation,
        major_radius=major_radius, minor_radius=minor_radius,
    )
    o = bpy.context.object
    o.name = name
    return _finish(o, material, 0, uv_scale=uv_scale)



# Horizontal V bands in fighter_kit.webp (see tools/textures/bake.js). Parts
# cube-project for world-scale detail, then have their V squeezed into a band, so one
# texture dresses a whole character — and the same one dresses the viewmodel arms.
ATLAS_BANDS = {
    "skin":   (0.02, 0.23),
    "cloth":  (0.27, 0.53),
    "gear":   (0.57, 0.73),
    "rubber": (0.77, 0.98),
}


def atlas_uv(o, band):
    """Squeeze this object's V coordinate into its atlas band, keeping U tiling."""
    v0, v1 = ATLAS_BANDS[band]
    span = v1 - v0
    for loop in o.data.uv_layers.active.data:
        u, v = loop.uv
        loop.uv = (u, v0 + (v % 1.0) * span)


def segment(name, head, tail, r0, r1, material, bevel=0.004, uv_scale=1.6, vertices=10):
    """A tapered limb segment running from `head` to `tail`.

    Cylinders are created along their own Z, so the direction is turned into a
    rotation with `to_track_quat`. Building limbs from bone endpoints rather than
    hand-placed cylinders means the mesh cannot drift out of alignment with the rig.
    """
    from mathutils import Vector
    h, t = Vector(head), Vector(tail)
    d = t - h
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices, radius1=r0, radius2=r1, depth=d.length,
        location=(h + t) / 2, rotation=d.to_track_quat("Z", "Y").to_euler(),
    )
    o = bpy.context.object
    o.name = name
    return _finish(o, material, bevel, uv_scale=uv_scale)

def join(name, objects=None):
    """Merge objects into one mesh: one prop should be one draw call per material.

    Modifiers are applied first. `object.join()` keeps only the *active* object's
    modifier stack, so joining before applying silently throws away every bevel and
    weighted-normal on the other parts — the props would flatten out with no
    explanation.
    """
    if objects is None:
        objects = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in objects:
        apply_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    return o


def apply_modifiers(o):
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except RuntimeError as err:
            log(f"  could not apply {m.name} on {o.name}: {err}")


def tri_count():
    total = 0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        o.data.calc_loop_triangles()
        total += len(o.data.loop_triangles)
    return total


def export(name, animations=False, budget=None):
    """Export the whole scene as a GLB into public/assets/models.

    `budget` is the art-bible triangle ceiling for this asset; exceeding it is a
    warning in the build log, not a failure, so a deliberate overage is visible in
    review rather than silent.
    """
    bpy.ops.object.select_all(action="SELECT")
    tris = tri_count()
    path = os.path.join(MODELS, name + ".glb")
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    if animations:
        kwargs.update(
            export_animations=True,
            export_animation_mode="ACTIONS",   # one glTF animation per Blender action
            export_bake_animation=True,
            export_optimize_animation_size=True,
            export_anim_single_armature=True,
            export_skins=True,
            export_influence_nb=4,
        )
    else:
        kwargs.update(export_animations=False, export_skins=False)
    bpy.ops.export_scene.gltf(**kwargs)
    size_kb = os.path.getsize(path) / 1024
    warn = ""
    if budget and tris > budget:
        warn = f"  ** OVER BUDGET ({budget} tris) **"
    log(f"Exported {name}.glb  {tris} tris  {size_kb:.0f}kB{warn}")
