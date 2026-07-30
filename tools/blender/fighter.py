"""Authors the skinned fighter and its animation set.

    npm run assets:models -- fighter

Output: public/assets/models/fighter.glb — one skinned mesh, 20 bones, two material
slots, and the clip library the runtime state machine blends (see
src/fighter-rig.js).

Design decisions worth knowing before editing:

**Two material slots, not one and not eight.** `TD_fighter_body` covers everything
that is never team-coloured (skin, helmet, webbing, boots); `TD_fighter_uniform` is
the shirt and trousers, tinted per squad at runtime. Two draw calls per fighter,
and squad colour still reads instantly across the pit.

**UVs are atlas bands.** `fighter_kit` is one texture with horizontal bands — skin,
cloth, gear, rubber. Each part cube-projects for world-scale detail, then has its V
squeezed into its band. So one texture dresses the whole fighter.

**Weights are baked by inverse distance, not by Blender's auto-weighting.** Heat-map
auto weights need watertight, connected geometry; this body is a pile of separate
primitives, which auto-weighting handles badly (limbs grabbing the torso, feet
grabbing the shins). Inverse-distance-to-bone-segment with a per-bone bias is
deterministic, debuggable, and gives smooth joints on low-poly limbs.

**Upper-body clips are authored to be made additive at runtime.** `aim_pose`, `fire`,
`reload`, `throw` and `hit_react` only touch spine/chest/arm bones and are keyed
against the same rest pose, so `AnimationUtils.makeClipAdditive` can layer them over
any locomotion clip. Locomotion and deaths are full-body and play normally.
"""

import bpy
import math
import os
import sys
from mathutils import Vector

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from td_lib import reset, cube, cyl, sphere, export, log, apply_modifiers, auto_smooth  # noqa: E402

D = math.radians

# ---------------------------------------------------------------- atlas bands
# V ranges in fighter_kit.webp (see tools/textures/bake.js).
BANDS = {
    "skin":   (0.02, 0.23),
    "cloth":  (0.27, 0.53),
    "gear":   (0.57, 0.73),
    "rubber": (0.77, 0.98),
}

BODY = "TD_fighter_body"
UNIFORM = "TD_fighter_uniform"

# ---------------------------------------------------------------- skeleton
# (name, parent, head, tail, connected, weight_bias)
#
# Forward is -Y: the glTF exporter's Y-up conversion maps Blender -Y to glTF +Z, and
# the game rotates combatants with `atan2(dx, dz)`, which makes local +Z forward.
#
# weight_bias scales a bone's pull during weight baking. Torso bones sit close to the
# limb roots, so without a bias the chest steals the shoulders and the hips steal the
# thighs.
BONES = [
    ("hips",       None,        (0, 0, 0.98), (0, 0, 1.12), False, 0.8),
    ("spine",      "hips",      (0, 0, 1.12), (0, 0, 1.30), True,  0.9),
    ("chest",      "spine",     (0, 0, 1.30), (0, 0, 1.46), True,  0.9),
    ("neck",       "chest",     (0, 0, 1.46), (0, 0, 1.56), True,  0.7),
    ("head",       "neck",      (0, 0, 1.56), (0, 0, 1.78), True,  1.1),

    ("shoulder_l", "chest",     (0.05, 0, 1.43), (0.19, 0, 1.44), False, 0.9),
    ("upperarm_l", "shoulder_l", (0.19, 0, 1.44), (0.19, 0, 1.18), True, 1.0),
    ("forearm_l",  "upperarm_l", (0.19, 0, 1.18), (0.19, 0, 0.95), True, 1.0),
    ("hand_l",     "forearm_l",  (0.19, 0, 0.95), (0.19, 0, 0.84), True, 1.2),

    ("shoulder_r", "chest",     (-0.05, 0, 1.43), (-0.19, 0, 1.44), False, 0.9),
    ("upperarm_r", "shoulder_r", (-0.19, 0, 1.44), (-0.19, 0, 1.18), True, 1.0),
    ("forearm_r",  "upperarm_r", (-0.19, 0, 1.18), (-0.19, 0, 0.95), True, 1.0),
    ("hand_r",     "forearm_r",  (-0.19, 0, 0.95), (-0.19, 0, 0.84), True, 1.2),

    ("thigh_l",    "hips",      (0.105, 0, 0.94), (0.105, 0, 0.52), False, 1.0),
    ("shin_l",     "thigh_l",   (0.105, 0, 0.52), (0.105, 0, 0.09), True,  1.0),
    ("foot_l",     "shin_l",    (0.105, 0, 0.09), (0.105, -0.17, 0.04), True, 1.2),

    ("thigh_r",    "hips",      (-0.105, 0, 0.94), (-0.105, 0, 0.52), False, 1.0),
    ("shin_r",     "thigh_r",   (-0.105, 0, 0.52), (-0.105, 0, 0.09), True,  1.0),
    ("foot_r",     "shin_r",    (-0.105, 0, 0.09), (-0.105, -0.17, 0.04), True, 1.2),

    # Attachment socket. The runtime parents weapon models to this node instead of
    # guessing a hand offset, so a rifle and a knife both sit in the fist correctly.
    #
    # The socket runs *forward*, with its roll set so local -Z points down the barrel
    # and local +Y is the weapon's up. Weapon meshes are built with the barrel along
    # -Z, so a gun attaches with an identity transform and no per-weapon fudge.
    #
    # Pointing it forward rather than up is the whole trick: a firing grip holds the
    # barrel roughly *parallel to the forearm*, so the socket has to follow the arm's
    # axis. An up-pointing socket (out of the top of the fist) meant that raising the
    # arm to aim rotated the gun to point at the ceiling.
    ("weapon",     "hand_r",    (-0.19, -0.05, 0.90), (-0.19, -0.19, 0.90), False, 0.0),
]

# Bones whose roll is set explicitly rather than by the X-axis convention below.
# The socket's local Z must be world up so that its -Z (the barrel) tracks the arm.
ROLL_OVERRIDE = {"weapon": Vector((0, 0, 1))}

BIAS = {b[0]: b[5] for b in BONES}
SOCKETS = {"weapon"}


# ---------------------------------------------------------------- geometry

def atlas_uv(o, band):
    """Squeeze this part's V coordinate into its atlas band, keeping U tiling."""
    v0, v1 = BANDS[band]
    span = v1 - v0
    uvs = o.data.uv_layers.active.data
    for loop in uvs:
        u, v = loop.uv
        loop.uv = (u, v0 + (v % 1.0) * span)


# Which bones each part may be weighted to.
#
# This scoping is the difference between a rig that works and one that smears. Pure
# geometric weighting looks reasonable until you notice the shoulder bones run
# straight through the top of the chest box: those corner vertices sat almost exactly
# on the bone segment, took nearly all their weight from it, and the torso stretched
# into a flat slab the moment the arms moved. A part is only ever weighted to the
# bones that anatomically drive it, and inverse distance smooths the joints *within*
# that set.
PART_BONES = {}


def part(name, band, material, kind, bones=(), **kw):
    """One body part: a primitive, cube-projected, then banded into the atlas."""
    if kind == "cube":
        o = cube(name, kw["loc"], kw["size"], material, kw.get("bevel", 0.02),
                 kw.get("rotation", (0, 0, 0)), uv_scale=kw.get("uv", 1.6))
    elif kind == "cyl":
        o = cyl(name, kw["loc"], kw["r"], kw["depth"], material, kw.get("verts", 10),
                kw.get("rotation", (0, 0, 0)), kw.get("bevel", 0.012), uv_scale=kw.get("uv", 1.6))
    else:
        o = sphere(name, kw["loc"], kw["r"], material, kw.get("segments", 12),
                   kw.get("rings", 7), uv_scale=kw.get("uv", 1.6))
    atlas_uv(o, band)
    if not bones:
        raise ValueError(f"part {name} declares no bone scope")
    PART_BONES[o.name] = tuple(bones)
    return o


def build_body():
    """A lean, kitted fighter. Silhouette first: pads and boots read at 30 m."""
    parts = []
    P = parts.append

    HEAD = ("head", "neck")
    TORSO_UP = ("chest", "spine", "neck")

    # --- head ---
    P(part("Skull", "skin", BODY, "sphere", bones=HEAD, loc=(0, 0, 1.665), r=0.115, segments=12, rings=7))
    P(part("Jaw", "skin", BODY, "cube", bones=HEAD, loc=(0, -0.045, 1.60), size=(0.15, 0.13, 0.10), bevel=0.03))
    # Helmet: the strongest silhouette cue at distance, so it gets the brim.
    P(part("Helmet", "gear", BODY, "sphere", bones=("head",), loc=(0, 0.004, 1.685), r=0.128, segments=12, rings=7))
    P(part("Helmet brim", "gear", BODY, "cube", bones=("head",), loc=(0, -0.10, 1.665), size=(0.20, 0.11, 0.045), bevel=0.02))
    P(part("Helmet rail", "gear", BODY, "cube", bones=("head",), loc=(0.115, 0.01, 1.70), size=(0.03, 0.16, 0.03), bevel=0.008))

    # --- torso ---
    P(part("Neck", "skin", BODY, "cyl", bones=("neck", "head", "chest"), loc=(0, 0, 1.505), r=0.055, depth=0.10, verts=8))
    P(part("Chest", "cloth", UNIFORM, "cube", bones=TORSO_UP, loc=(0, 0, 1.36), size=(0.36, 0.21, 0.24), bevel=0.055))
    P(part("Abdomen", "cloth", UNIFORM, "cube", bones=("spine", "hips", "chest"), loc=(0, 0, 1.145), size=(0.30, 0.19, 0.22), bevel=0.05))
    # Plate carrier over the chest, cut so the uniform shows at the shoulders. Rigid
    # to the chest alone: body armour does not flex.
    P(part("Carrier", "gear", BODY, "cube", bones=("chest",), loc=(0, 0, 1.335), size=(0.375, 0.245, 0.30), bevel=0.035))
    P(part("Carrier collar", "gear", BODY, "cube", bones=("chest",), loc=(0, 0, 1.475), size=(0.28, 0.22, 0.045), bevel=0.02))
    for y, z in ((-0.135, 1.28), (-0.135, 1.375)):
        P(part("Mag pouch", "gear", BODY, "cube", bones=("chest",), loc=(0.085, y, z), size=(0.10, 0.06, 0.075), bevel=0.012))
    P(part("Radio", "gear", BODY, "cube", bones=("chest",), loc=(-0.115, 0.115, 1.40), size=(0.07, 0.05, 0.14), bevel=0.014))
    P(part("Belt", "gear", BODY, "cube", bones=("hips",), loc=(0, 0, 1.02), size=(0.315, 0.21, 0.06), bevel=0.02))

    # --- arms ---
    for side, sx in (("l", 1), ("r", -1)):
        P(part(f"Shoulder pad {side}", "gear", BODY, "sphere", bones=(f"shoulder_{side}", f"upperarm_{side}"),
               loc=(sx * 0.185, 0, 1.415), r=0.085, segments=9, rings=5))
        P(part(f"Upperarm {side}", "cloth", UNIFORM, "cyl",
               bones=(f"upperarm_{side}", f"shoulder_{side}", f"forearm_{side}"),
               loc=(sx * 0.19, 0, 1.315), r=0.055, depth=0.235, verts=10))
        P(part(f"Elbow {side}", "gear", BODY, "sphere", bones=(f"upperarm_{side}", f"forearm_{side}"),
               loc=(sx * 0.19, 0, 1.185), r=0.052, segments=8, rings=5))
        P(part(f"Forearm {side}", "cloth", UNIFORM, "cyl",
               bones=(f"forearm_{side}", f"upperarm_{side}", f"hand_{side}"),
               loc=(sx * 0.19, 0, 1.07), r=0.046, depth=0.215, verts=10))
        P(part(f"Glove {side}", "rubber", BODY, "cube", bones=(f"hand_{side}", f"forearm_{side}"),
               loc=(sx * 0.19, -0.01, 0.90), size=(0.075, 0.10, 0.14), bevel=0.028))

    # --- legs ---
    for side, sx in (("l", 1), ("r", -1)):
        P(part(f"Thigh {side}", "cloth", UNIFORM, "cyl",
               bones=(f"thigh_{side}", "hips", f"shin_{side}"),
               loc=(sx * 0.105, 0, 0.755), r=0.075, depth=0.40, verts=10))
        P(part(f"Knee pad {side}", "gear", BODY, "cube", bones=(f"thigh_{side}", f"shin_{side}"),
               loc=(sx * 0.105, -0.055, 0.535), size=(0.115, 0.075, 0.115), bevel=0.03))
        P(part(f"Shin {side}", "cloth", UNIFORM, "cyl",
               bones=(f"shin_{side}", f"thigh_{side}", f"foot_{side}"),
               loc=(sx * 0.105, 0, 0.315), r=0.060, depth=0.40, verts=10))
        P(part(f"Boot {side}", "rubber", BODY, "cube", bones=(f"foot_{side}", f"shin_{side}"),
               loc=(sx * 0.105, -0.035, 0.105), size=(0.115, 0.175, 0.16), bevel=0.03))
        P(part(f"Sole {side}", "rubber", BODY, "cube", bones=(f"foot_{side}",),
               loc=(sx * 0.105, -0.045, 0.022), size=(0.125, 0.235, 0.045), bevel=0.014))
    return parts


def flatten_and_join(parts):
    """Apply every transform, then join into one mesh.

    Location has to be applied too, not just rotation and scale: the weight bake
    below works in mesh-local space, and if the parts keep their object offsets that
    space no longer matches the armature's.
    """
    for o in parts:
        apply_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    body = bpy.context.object
    body.name = "fighter"
    auto_smooth(body, 40)
    return body


# ---------------------------------------------------------------- rig

def build_armature():
    bpy.ops.object.armature_add(location=(0, 0, 0))
    rig = bpy.context.object
    rig.name = "fighter_rig"
    rig.data.name = "fighter_rig"
    bpy.ops.object.mode_set(mode="EDIT")
    edit = rig.data.edit_bones
    for b in list(edit):
        edit.remove(b)                      # drop the default bone
    made = {}
    for name, parent, head, tail, connected, _bias in BONES:
        b = edit.new(name)
        b.head = Vector(head)
        b.tail = Vector(tail)
        if parent:
            b.parent = made[parent]
            b.use_connect = connected
        set_roll(b, name)
        made[name] = b
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def set_roll(bone, name):
    """Force every bone's local X axis to world +X.

    This is the single most important convention in the file. Blender picks a bone's
    roll automatically, and the roll decides which euler component is flexion. Left
    to its own devices it gave the arm bones a roll where rotating about local X
    *abducted* the arm sideways instead of swinging it forward — so the first build
    came out in a splayed T-pose no matter what the animation data said.

    With local X pinned to world +X, rotation about X is always in the world YZ
    (sagittal) plane, which means:
      * on a downward-pointing limb, +X swings the limb backwards
      * on an upward-pointing spine bone, +X leans it forwards
    and every pose in this file can be read at a glance.

    `align_roll` aligns the bone's *Z* axis, and X = Y × Z, so the Z we want is
    X × Y = (1,0,0) × bone_direction.
    """
    if name in ROLL_OVERRIDE:
        bone.align_roll(ROLL_OVERRIDE[name])
        return
    y = (bone.tail - bone.head).normalized()
    z = Vector((1, 0, 0)).cross(y)
    if z.length < 1e-4:
        # The bone runs along world X (the shoulders), so X-to-world-X is meaningless.
        # Point Z up instead: rotation about local X then raises and drops the
        # shoulder, and rotation about local Z swings it forward and back.
        z = Vector((0, 0, 1))
    bone.align_roll(z)


def point_segment_distance(p, a, b):
    ab = b - a
    denom = ab.dot(ab)
    if denom < 1e-9:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / denom))
    return (p - (a + ab * t)).length


BONE_SEGMENTS = {
    name: (Vector(head), Vector(tail), bias)
    for name, _parent, head, tail, _c, bias in BONES
    if name not in SOCKETS                            # sockets must not pull geometry
}


def bake_part_weights(parts, max_influences=3, falloff=4.0):
    """Bake skin weights per part, before the join.

    Each part is weighted only to the bones its `PART_BONES` scope allows, with
    inverse distance (d^-falloff) blending across the joints inside that scope.
    falloff=4 keeps a limb crisp along its length while still smoothing over an
    elbow or knee, so joints bend instead of shearing.

    This has to happen before `join`, because after joining there is no way to tell
    which vertices came from which part — and the scope is the entire point.
    Vertex groups merge by name during the join.
    """
    total_verts = 0
    for o in parts:
        scope = PART_BONES[o.name]
        for name in scope:
            if name not in o.vertex_groups:
                o.vertex_groups.new(name=name)
        groups = {g.name: g for g in o.vertex_groups}
        segments = [(n, *BONE_SEGMENTS[n]) for n in scope]
        for v in o.data.vertices:
            # Parts still carry their object offsets at this point; bone positions are
            # in world space, so the vertex has to be too.
            p = o.matrix_world @ v.co
            scored = sorted(
                (max(point_segment_distance(p, a, b), 1e-4) / max(bias, 1e-3), n)
                for n, a, b, bias in segments
            )[:max_influences]
            weights = [(n, 1.0 / (d ** falloff)) for d, n in scored]
            norm = sum(w for _n, w in weights)
            for n, w in weights:
                groups[n].add([v.index], w / norm, "REPLACE")
        total_verts += len(o.data.vertices)
    log(f"  baked scoped weights for {total_verts} verts across {len(parts)} parts")


def attach_to_rig(body, rig):
    """Parent the joined mesh to the armature, keeping the baked weights.

    ARMATURE_NAME creates vertex groups for any bone that has none yet (the socket)
    and leaves existing groups — and therefore the bake — untouched.
    """
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_NAME")


# ---------------------------------------------------------------- animation

def new_action(rig, name):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True             # survive the export-time purge
    if not rig.animation_data:
        rig.animation_data_create()
    rig.animation_data.action = action
    return action


def hips_loc(down=0.0, forward=0.0):
    """Root translation in the hips bone's own local space.

    Pose-bone location is expressed along the *bone's* axes, not the world's, and the
    hips bone points up. With this file's roll convention (local X pinned to world X)
    that makes local Y = up and local Z = forward. Writing a "drop" into Z — which is
    what the first pass did — slides the fighter backwards instead of lowering him,
    so the crouch folded the legs while the hips stayed put and the feet came off the
    floor, and the death clips slid bodies backwards instead of laying them down.

    Positive `down` lowers the fighter; positive `forward` moves him the way he faces.
    """
    return (0.0, -down, forward)


def key(rig, frame, pose, extra_loc=None):
    """Key a set of bone rotations (degrees, XYZ euler) at one frame.

    Only the bones named here are keyed. That is what keeps the upper-body clips
    layerable: a clip with no leg channels leaves the legs to the locomotion layer.
    """
    for bone_name, rot in pose.items():
        pb = rig.pose.bones[bone_name]
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (D(rot[0]), D(rot[1]), D(rot[2]))
        pb.keyframe_insert("rotation_euler", frame=frame)
    if extra_loc:
        for bone_name, loc in extra_loc.items():
            pb = rig.pose.bones[bone_name]
            pb.location = loc
            pb.keyframe_insert("location", frame=frame)


def clear_pose(rig):
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


# Rest-ish combat stance, reused as the base of the locomotion clips: knees soft,
# weight forward, weapon arm up. A fighter standing perfectly straight reads as a
# mannequin.
# Weapon arm: the upperarm and forearm flexions must sum to about -90°, which puts
# the forearm — and therefore the barrel, which runs along it — level and pointing
# forward. Keep the sum near -90 in any pose that has the weapon up, or the gun tips
# toward the ceiling.
#
# The split between the two matters as much as the sum. Spreading it evenly (-44/-46)
# pushed the elbow forward and left the fighter holding the gun out at arm's length
# like a torch. Most of the bend belongs in the elbow: the upper arm stays close to
# the ribs and the weapon sits in tight at chest height.
ARM_R = (-16, 8, 0)
FOREARM_R = (-74, 0, 0)
ARM_L = (-18, -12, -22)       # support arm reaches across to the handguard
FOREARM_L = (-70, 0, 0)

STANCE = {
    "hips": (2, 0, 0), "spine": (4, 0, 0), "chest": (2, 0, 0), "neck": (-3, 0, 0),
    "shoulder_r": (0, 0, -4), "upperarm_r": ARM_R, "forearm_r": FOREARM_R,
    "hand_r": (0, 0, 0),
    "shoulder_l": (0, 0, 6), "upperarm_l": ARM_L, "forearm_l": FOREARM_L,
    "hand_l": (0, 0, 0),
    "thigh_l": (-5, 0, 1), "shin_l": (9, 0, 0), "foot_l": (-5, 0, 0),
    "thigh_r": (-5, 0, -1), "shin_r": (9, 0, 0), "foot_r": (-5, 0, 0),
}


def merged(*poses):
    out = {}
    for p in poses:
        out.update(p)
    return out


def anim_idle(rig):
    new_action(rig, "idle")
    clear_pose(rig)
    # A slow breath in the spine and a tiny weapon-hand drift. 3 s cycle.
    for f, s in ((1, 0), (46, 1), (91, 0)):
        key(rig, f, merged(STANCE, {
            "spine": (4 - s * 1.5, 0, 0),
            "chest": (2 + s * 2.0, 0, 0),
            "neck": (-3 - s * 1.5, 0, 0),
            "upperarm_r": (ARM_R[0] + s * 2.5, ARM_R[1], ARM_R[2]),
            "upperarm_l": (ARM_L[0] + s * 2.0, ARM_L[1], ARM_L[2]),
            "head": (0, s * 2.0, 0),
        }))


def _walk_cycle(rig, name, length, stride, arm, lean, bounce):
    """Four-key contact/pass walk or run cycle, mirrored at the half-way point."""
    new_action(rig, name)
    clear_pose(rig)

    def half(f, sign):
        # sign=+1: left leg forward. Arms oppose legs.
        key(rig, f, merged(STANCE, {
            "hips": (lean, 0, -sign * 2.5),
            "spine": (lean * 0.6, sign * 3.0, 0),
            "chest": (2, -sign * 4.0, 0),
            "thigh_l": (-stride * sign, 0, 2),
            "shin_l": (max(4, stride * 0.55 * (1 + sign)), 0, 0),
            "foot_l": (-6 + stride * 0.25 * sign, 0, 0),
            "thigh_r": (stride * sign, 0, -2),
            "shin_r": (max(4, stride * 0.55 * (1 - sign)), 0, 0),
            "foot_r": (-6 - stride * 0.25 * sign, 0, 0),
            # The weapon arm keeps the gun up; only the support arm swings fully.
            "upperarm_l": (ARM_L[0] - arm * sign, ARM_L[1], ARM_L[2]),
            "upperarm_r": (ARM_R[0] + arm * 0.25 * sign, ARM_R[1], ARM_R[2]),
        }, ), extra_loc={"hips": hips_loc(down=abs(bounce))})

    def pass_pose(f, sign):
        key(rig, f, merged(STANCE, {
            "hips": (lean, 0, 0),
            "thigh_l": (-stride * 0.15 * sign, 0, 2),
            "shin_l": (stride * 0.7, 0, 0),
            "thigh_r": (stride * 0.15 * sign, 0, -2),
            "shin_r": (stride * 0.7, 0, 0),
            "upperarm_l": ARM_L,
            "upperarm_r": ARM_R,
        }), extra_loc={"hips": hips_loc(down=-abs(bounce))})

    q = (length - 1) / 4.0
    half(1, 1)
    pass_pose(1 + q, 1)
    half(1 + 2 * q, -1)
    pass_pose(1 + 3 * q, -1)
    half(length, 1)                        # closes the loop exactly


def anim_walk(rig):
    _walk_cycle(rig, "walk", 33, stride=26, arm=20, lean=6, bounce=0.02)


def anim_run(rig):
    _walk_cycle(rig, "run", 23, stride=44, arm=34, lean=13, bounce=0.045)


# A real combat crouch, not a slight bend. The first pass dropped the head only 25 cm,
# which was visually indistinguishable from standing and — worse — left the *visible*
# head 20 cm above the eye height the AI actually fires and sights from
# (`Combatant.eyePos`, 1.55 x crouchK). CROUCH_HEAD_DROP below keeps the two in step.
CROUCH = {
    "hips": (20, 0, 0), "spine": (15, 0, 0), "chest": (8, 0, 0), "neck": (-16, 0, 0),
    "thigh_l": (-96, 0, 5), "shin_l": (112, 0, 0), "foot_l": (-24, 0, 0),
    "thigh_r": (-96, 0, -5), "shin_r": (112, 0, 0), "foot_r": (-24, 0, 0),
    "upperarm_r": (ARM_R[0] + 2, ARM_R[1] + 2, ARM_R[2]), "forearm_r": (FOREARM_R[0] - 2, 0, 0),
    "upperarm_l": (ARM_L[0] + 2, ARM_L[1], ARM_L[2]), "forearm_l": (FOREARM_L[0] - 2, 0, 0),
}


def anim_crouch_idle(rig):
    new_action(rig, "crouch_idle")
    clear_pose(rig)
    for f, s in ((1, 0), (56, 1), (111, 0)):
        key(rig, f, merged(STANCE, CROUCH, {
            "spine": (10 - s * 1.5, 0, 0),
            "chest": (6 + s * 1.5, 0, 0),
        }), extra_loc={"hips": hips_loc(down=0.42)})


def anim_crouch_walk(rig):
    new_action(rig, "crouch_walk")
    clear_pose(rig)
    # Duck-walk: short strides, hips stay low the whole cycle.
    for i, (f, sign) in enumerate(((1, 1), (13, 0), (25, -1), (37, 0), (49, 1))):
        key(rig, f, merged(STANCE, CROUCH, {
            "thigh_l": (-72 - sign * 16, 0, 4),
            "shin_l": (88 + sign * 8, 0, 0),
            "thigh_r": (-72 + sign * 16, 0, -4),
            "shin_r": (88 - sign * 8, 0, 0),
            "hips": (14, 0, -sign * 2),
        }), extra_loc={"hips": hips_loc(down=0.42 - (0.012 if i % 2 else 0))})


def anim_aim_pose(rig):
    """Upper body only: shouldered weapon, head down to the sights.

    Frame 1 must be the rest pose. `AnimationUtils.makeClipAdditive` takes its
    reference from the clip's first frame, so a clip that opens already in the aim
    pose subtracts itself to nothing and layers zero. Opening from rest also gives
    the shoulder-up a real transition instead of a pop.
    """
    new_action(rig, "aim_pose")
    clear_pose(rig)
    # Deltas, not absolutes. The upperarm and forearm contributions cancel so the
    # barrel stays level while the weapon comes up to the shoulder line — an aim pose
    # that adds net flexion just points the gun higher.
    aim = {
        "spine": (2, 0, 0), "chest": (2, -6, 0), "neck": (6, 0, 0), "head": (3, -3, 0),
        "shoulder_r": (0, 0, -12), "upperarm_r": (-16, 4, 0), "forearm_r": (16, 0, 0),
        "shoulder_l": (0, 0, 14), "upperarm_l": (-14, -8, -6), "forearm_l": (14, 0, 0),
    }
    zero = {k: (0, 0, 0) for k in aim}
    key(rig, 1, zero)
    key(rig, 10, aim)
    key(rig, 20, aim)


def anim_fire(rig):
    """Recoil impulse. Additive at runtime, so these are deltas from the rest pose."""
    new_action(rig, "fire")
    clear_pose(rig)
    key(rig, 1, {"chest": (0, 0, 0), "upperarm_r": (0, 0, 0), "upperarm_l": (0, 0, 0),
                 "neck": (0, 0, 0), "shoulder_r": (0, 0, 0)})
    key(rig, 3, {"chest": (-7, 0, 0), "upperarm_r": (9, 0, 0), "upperarm_l": (7, 0, 0),
                 "neck": (-5, 0, 0), "shoulder_r": (0, 0, 5)})
    key(rig, 10, {"chest": (-1.5, 0, 0), "upperarm_r": (2, 0, 0), "upperarm_l": (1.5, 0, 0),
                  "neck": (-1, 0, 0), "shoulder_r": (0, 0, 1)})
    key(rig, 16, {"chest": (0, 0, 0), "upperarm_r": (0, 0, 0), "upperarm_l": (0, 0, 0),
                  "neck": (0, 0, 0), "shoulder_r": (0, 0, 0)})


def anim_reload(rig):
    """Mag out, mag in, slap. Additive: only the arms and a little spine."""
    new_action(rig, "reload")
    clear_pose(rig)
    zero = {"chest": (0, 0, 0), "spine": (0, 0, 0),
            "upperarm_r": (0, 0, 0), "forearm_r": (0, 0, 0), "hand_r": (0, 0, 0),
            "upperarm_l": (0, 0, 0), "forearm_l": (0, 0, 0), "hand_l": (0, 0, 0)}
    key(rig, 1, zero)
    # bring the weapon in and drop the support hand to the mag well
    key(rig, 10, {"chest": (6, 0, 0), "spine": (3, 0, 0),
                  "upperarm_r": (12, 0, 0), "forearm_r": (-18, 0, 0), "hand_r": (0, 0, -14),
                  "upperarm_l": (26, 0, 12), "forearm_l": (24, 0, 0), "hand_l": (0, 0, 20)})
    # mag away, hand reaches to the pouch
    key(rig, 22, {"chest": (9, 0, 0), "spine": (4, 0, 0),
                  "upperarm_r": (10, 0, 0), "forearm_r": (-14, 0, 0), "hand_r": (0, 0, -10),
                  "upperarm_l": (54, 0, 26), "forearm_l": (46, 0, 0), "hand_l": (0, 0, 8)})
    # fresh mag seated
    key(rig, 34, {"chest": (6, 0, 0), "spine": (3, 0, 0),
                  "upperarm_r": (12, 0, 0), "forearm_r": (-18, 0, 0), "hand_r": (0, 0, -14),
                  "upperarm_l": (22, 0, 10), "forearm_l": (20, 0, 0), "hand_l": (0, 0, 24)})
    # slap and back on target
    key(rig, 40, {"chest": (2, 0, 0), "spine": (1, 0, 0),
                  "upperarm_r": (4, 0, 0), "forearm_r": (-6, 0, 0), "hand_r": (0, 0, -4),
                  "upperarm_l": (8, 0, 0), "forearm_l": (6, 0, 0), "hand_l": (0, 0, 6)})
    key(rig, 48, zero)


def anim_throw(rig):
    """Overhand grenade throw, upper body only."""
    new_action(rig, "throw")
    clear_pose(rig)
    zero = {"chest": (0, 0, 0), "spine": (0, 0, 0), "neck": (0, 0, 0),
            "upperarm_l": (0, 0, 0), "forearm_l": (0, 0, 0),
            "upperarm_r": (0, 0, 0), "forearm_r": (0, 0, 0)}
    key(rig, 1, zero)
    key(rig, 12, {"chest": (-14, 18, 0), "spine": (-6, 8, 0), "neck": (4, 0, 0),
                  "upperarm_l": (-58, 0, -34), "forearm_l": (-84, 0, 0),
                  "upperarm_r": (6, 0, 0), "forearm_r": (0, 0, 0)})
    key(rig, 20, {"chest": (16, -20, 0), "spine": (10, -10, 0), "neck": (-6, 0, 0),
                  "upperarm_l": (58, 0, 20), "forearm_l": (-14, 0, 0),
                  "upperarm_r": (-8, 0, 0), "forearm_r": (0, 0, 0)})
    key(rig, 34, zero)


def anim_hit_react(rig):
    """Short flinch. Additive, so it reads over running, crouching or aiming."""
    new_action(rig, "hit_react")
    clear_pose(rig)
    zero = {"chest": (0, 0, 0), "spine": (0, 0, 0), "neck": (0, 0, 0), "head": (0, 0, 0),
            "upperarm_r": (0, 0, 0), "upperarm_l": (0, 0, 0)}
    key(rig, 1, zero)
    key(rig, 4, {"chest": (-13, 5, 0), "spine": (-7, 0, 0), "neck": (-10, 0, 0),
                 "head": (-8, 4, 0), "upperarm_r": (10, 0, 0), "upperarm_l": (12, 0, 0)})
    key(rig, 12, {"chest": (-3, 1, 0), "spine": (-2, 0, 0), "neck": (-3, 0, 0),
                  "head": (-2, 1, 0), "upperarm_r": (3, 0, 0), "upperarm_l": (3, 0, 0)})
    key(rig, 20, zero)


def anim_death_front(rig):
    """Shot from the front: knees buckle, body folds backwards flat onto its back.

    The end pose has to be genuinely *flat*, not merely leaning a long way back. With
    the hips rotated -90 the spine lies horizontal pointing backwards, and because the
    thighs inherit that rotation, a thigh angle near zero puts the legs horizontal
    pointing forwards. Leaving the legs folded (as the first pass did) left them
    sticking into the air, and no amount of dropping the hips fixes that — it just
    buries the body.

    Heights are not authored at all: `plant_on_floor` measures the posed mesh and
    lowers the hips until the lowest vertex touches the ground.
    """
    new_action(rig, "death_front")
    clear_pose(rig)
    key(rig, 1, STANCE, extra_loc={"hips": hips_loc()})
    key(rig, 7, merged(STANCE, {
        "chest": (-22, 0, 0), "spine": (-14, 0, 0), "neck": (-18, 0, 0), "head": (-10, 0, 0),
        "upperarm_r": (24, 0, -20), "upperarm_l": (22, 0, 20),
        "thigh_l": (-26, 0, 4), "shin_l": (34, 0, 0),
        "thigh_r": (-24, 0, -4), "shin_r": (30, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.10)})
    key(rig, 20, merged(STANCE, {
        "hips": (-55, 0, 0), "spine": (-8, 0, 0), "chest": (-12, 0, 0),
        "neck": (-18, 0, 0), "head": (-14, 0, 0),
        "upperarm_r": (40, 0, -46), "forearm_r": (-20, 0, 0),
        "upperarm_l": (38, 0, 46), "forearm_l": (-24, 0, 0),
        "thigh_l": (20, 0, 8), "shin_l": (40, 0, 0),
        "thigh_r": (18, 0, -8), "shin_r": (36, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.45, forward=-0.20)})
    key(rig, 34, merged(STANCE, {
        "hips": (-90, 0, 3), "spine": (-4, 0, 0), "chest": (-6, 4, 0),
        "neck": (-12, 6, 0), "head": (-8, 8, 0),
        "upperarm_r": (46, 0, -66), "forearm_r": (-12, 0, 0),
        "upperarm_l": (44, 0, 62), "forearm_l": (-16, 0, 0),
        "thigh_l": (8, 0, 12), "shin_l": (12, 0, 0), "foot_l": (-25, 0, 0),
        "thigh_r": (6, 0, -10), "shin_r": (10, 0, 0), "foot_r": (-25, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.80, forward=-0.35)})


def anim_death_back(rig):
    """Shot from behind: pitches forward and lands face down.

    Mirror of the above — hips at +90 lay the spine horizontal *forwards*, and the
    inherited rotation puts near-zero thighs horizontal pointing backwards, so the
    legs trail behind the torso.
    """
    new_action(rig, "death_back")
    clear_pose(rig)
    key(rig, 1, STANCE, extra_loc={"hips": hips_loc()})
    key(rig, 8, merged(STANCE, {
        "hips": (18, 0, 0), "chest": (26, 0, 0), "spine": (18, 0, 0), "neck": (14, 0, 0),
        "upperarm_r": (-28, 0, -16), "upperarm_l": (-26, 0, 16),
        "thigh_l": (-34, 0, 4), "shin_l": (48, 0, 0),
        "thigh_r": (-30, 0, -4), "shin_r": (44, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.18)})
    key(rig, 22, merged(STANCE, {
        "hips": (60, 0, 0), "spine": (8, 0, 0), "chest": (12, 0, 0),
        "neck": (22, 0, 0), "head": (16, 0, 0),
        "upperarm_r": (-58, 0, -40), "forearm_r": (-26, 0, 0),
        "upperarm_l": (-56, 0, 40), "forearm_l": (-28, 0, 0),
        "thigh_l": (-10, 0, 6), "shin_l": (26, 0, 0),
        "thigh_r": (-8, 0, -6), "shin_r": (22, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.42, forward=0.24)})
    key(rig, 36, merged(STANCE, {
        "hips": (90, 0, -4), "spine": (3, 0, 0), "chest": (6, -5, 0),
        "neck": (20, 0, 0), "head": (12, -6, 0),
        "upperarm_r": (-66, 0, -56), "forearm_r": (-18, 0, 0),
        "upperarm_l": (-64, 0, 54), "forearm_l": (-20, 0, 0),
        "thigh_l": (-6, 0, 8), "shin_l": (10, 0, 0), "foot_l": (-14, 0, 0),
        "thigh_r": (-4, 0, -8), "shin_r": (8, 0, 0), "foot_r": (-14, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.80, forward=0.40)})


def anim_death_collapse(rig):
    """Headshot: no bracing at all. Folds and drops where he stood, on his side."""
    new_action(rig, "death_collapse")
    clear_pose(rig)
    key(rig, 1, STANCE, extra_loc={"hips": hips_loc()})
    key(rig, 10, merged(STANCE, {
        "hips": (26, 0, 8), "spine": (14, 0, 0), "chest": (18, 8, 0),
        "neck": (16, 0, 0), "head": (20, 10, 0),
        "upperarm_r": (-12, 0, -26), "upperarm_l": (-10, 0, 26),
        "thigh_l": (-84, 0, 8), "shin_l": (96, 0, 0),
        "thigh_r": (-80, 0, -8), "shin_r": (92, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.50)})
    key(rig, 26, merged(STANCE, {
        "hips": (62, 0, 18), "spine": (14, 0, 0), "chest": (20, 14, 0),
        "neck": (20, 0, 0), "head": (24, 16, 0),
        "upperarm_r": (-26, 0, -52), "forearm_r": (-34, 0, 0),
        "upperarm_l": (-22, 0, 48), "forearm_l": (-30, 0, 0),
        "thigh_l": (-70, 0, 16), "shin_l": (100, 0, 0), "foot_l": (-8, 0, 0),
        "thigh_r": (-66, 0, -14), "shin_r": (96, 0, 0), "foot_r": (-8, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.86, forward=0.10)})


def anim_heal(rig):
    """Bandaging: weapon hand drops, support hand works at the torso."""
    new_action(rig, "heal")
    clear_pose(rig)
    zero = {"chest": (0, 0, 0), "spine": (0, 0, 0), "neck": (0, 0, 0),
            "upperarm_r": (0, 0, 0), "forearm_r": (0, 0, 0),
            "upperarm_l": (0, 0, 0), "forearm_l": (0, 0, 0)}
    key(rig, 1, zero)
    working = {"chest": (10, 0, 0), "spine": (6, 0, 0), "neck": (-14, 0, 0),
               "upperarm_r": (44, 0, -14), "forearm_r": (-34, 0, 0),
               "upperarm_l": (30, 0, 18), "forearm_l": (-46, 0, 0)}
    key(rig, 10, working)
    for i, f in enumerate((20, 30, 40)):
        s = 1 if i % 2 == 0 else -1
        key(rig, f, merged(working, {
            "upperarm_l": (30 + s * 10, 0, 18 + s * 6),
            "forearm_l": (-46 - s * 12, 0, 0),
            "chest": (10 + s * 3, 0, 0),
        }))
    key(rig, 52, zero)



# Clips whose keyed hips height is measured rather than authored. Anything where the
# body is meant to be in contact with the ground belongs here; walk and run are
# deliberately excluded, because planting every keyframe would flatten their vertical
# bounce to nothing.
PLANTED = ("crouch_idle", "crouch_walk", "death_front", "death_back", "death_collapse")


def plant_on_floor(rig, body, clip_names=PLANTED, floor=0.0):
    """Lower each keyed frame until the posed mesh's lowest vertex sits on the floor.

    Authoring contact heights by hand does not work: the height that puts a fighter's
    boots on the ground is a consequence of every rotation in the chain, so any pose
    tweak silently breaks it. This measures the actual deformed mesh instead.

    One pass is exact. The hips bone points up, so its local Y maps 1:1 to world Z —
    a correction of d lowers the whole mesh by exactly d.
    """
    scene = bpy.context.scene
    for name in clip_names:
        action = bpy.data.actions.get(name)
        if not action:
            continue
        rig.animation_data.action = action
        curves = {fc.array_index: fc for fc in action.fcurves
                  if fc.data_path == 'pose.bones["hips"].location'}
        if 1 not in curves:
            log(f"  plant: {name} has no hips height channel, skipped")
            continue
        frames = sorted({round(kp.co[0]) for kp in curves[1].keyframe_points})
        fixes = []
        for f in frames:
            scene.frame_set(f)
            bpy.context.view_layer.update()
            deps = bpy.context.evaluated_depsgraph_get()
            ev = body.evaluated_get(deps)
            mesh = ev.to_mesh()
            mw = ev.matrix_world
            low = min((mw @ v.co).z for v in mesh.vertices)
            ev.to_mesh_clear()
            correction = low - floor
            if abs(correction) < 0.002:
                continue
            pb = rig.pose.bones["hips"]
            pb.location = (pb.location[0], pb.location[1] - correction, pb.location[2])
            pb.keyframe_insert("location", frame=f)
            fixes.append(f"{f}:{-correction:+.3f}")
        log(f"  planted {name} {' '.join(fixes) if fixes else '(already flat)'}")

CLIPS = [
    anim_idle, anim_walk, anim_run, anim_crouch_idle, anim_crouch_walk,
    anim_aim_pose, anim_fire, anim_reload, anim_throw, anim_hit_react, anim_heal,
    anim_death_front, anim_death_back, anim_death_collapse,
]


def main():
    reset()
    parts = build_body()
    bake_part_weights(parts)
    body = flatten_and_join(parts)
    rig = build_armature()
    attach_to_rig(body, rig)

    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    for clip in CLIPS:
        clip(rig)
    plant_on_floor(rig, body)
    bpy.ops.object.mode_set(mode="OBJECT")
    rig.animation_data.action = None        # ship no default pose

    log(f"  {len(bpy.data.actions)} clips: {', '.join(a.name for a in bpy.data.actions)}")
    export("fighter", animations=True, budget=2800)


main()
