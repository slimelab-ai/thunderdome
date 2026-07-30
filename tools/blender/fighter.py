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
from mathutils import Vector, Matrix

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
UPPERARM_LEN, FOREARM_LEN = 0.26, 0.23
HAND_LEN = 0.11               # wrist to closed fist

# Where the support hand goes on each weapon, in weapon space. Must match SUPPORT_GRIP
# in src/weapons.js: the runtime solves the left arm to the same point every frame, and
# the authored pose exists so it has almost nothing left to do. The rifle is used here
# because it is the common case and the longest reach that has to work.
RIFLE_GRIP = Vector((0.0, 0.036, -0.20))

# Two weapon-holding poses, as *targets* rather than angles.
#
# `wrist` is where the firing hand sits and `barrel` which way the weapon points, both
# in Blender world axes: forward is -Y, up is +Z, his right is -X.
#
# Hand-authored angles are what put the weapon out at arm's length off his right hip,
# 80 cm from a 60 cm arm, so the support hand could not have reached it in any pose. A
# target you can measure cannot go wrong that way: `npm run fightercheck` reports the
# distance from the left fist to the handguard, in every stance.
HOLDS = {
    # Low ready: weapon in tight, muzzle down a little, elbows in.
    "carry": dict(wrist=(-0.135, -0.20, 1.24), barrel=(0.02, -1.0, -0.16)),
    # Shouldered: butt into the right pec, barrel level down the sightline.
    "aim": dict(wrist=(-0.115, -0.235, 1.345), barrel=(0.015, -1.0, 0.0)),
}


def solve_hold(rig, wrist, barrel, grip=RIFLE_GRIP):
    """Pose both arms around a weapon held at `wrist` pointing along `barrel`.

    The right arm is solved to the wrist and the hand rotated so the weapon socket's
    bore runs down `barrel`. The weapon's grip point then falls out of that pose, and
    the left arm is solved to *it* — which is the only way the two hands end up on the
    same object. Posing them independently is how they came to be 20 cm apart.
    """
    barrel = Vector(barrel).normalized()
    out = {}

    # Right arm. Elbow leads back and down; a forward-pointing elbow is a broken arm.
    pose, err = solve_two_bone(rig, "upperarm_r", "forearm_r", "hand_r",
                               UPPERARM_LEN, FOREARM_LEN, wrist,
                               Vector((0.0, 1.0, -0.4)).normalized(),
                               Vector((0.0, -0.35, -1.0)).normalized())
    out.update(pose)
    _apply(rig, out)

    # Turn the hand so the bore runs where it is asked to. The socket is a child of the
    # hand with a fixed rest offset, so this is one minimal-arc rotation: take the
    # socket's bore direction onto the target, expressed in the hand's own frame.
    bones = rig.data.bones
    f_hand = parent_frame(rig, "hand_r")
    k = (bones["hand_r"].matrix_local.inverted() @ bones["weapon"].matrix_local).to_3x3()
    bore_local = k @ Vector((0.0, 0.0, -1.0))
    want_local = f_hand.to_3x3().inverted() @ barrel
    e = bore_local.normalized().rotation_difference(want_local.normalized()).to_euler("XYZ")
    out["hand_r"] = (math.degrees(e.x), math.degrees(e.y), math.degrees(e.z))
    _apply(rig, out)

    # Where the weapon's grip point ended up, now that the weapon is actually placed.
    grip_world = parent_frame(rig, "weapon") @ Vector(grip)

    # Left arm to the grip. Two-bone IK lands the *wrist*, and the fist is a hand's
    # length beyond it, so aim the wrist short along the line it will approach from.
    # Iterating twice is enough to converge; skipping it leaves the fist a hand short
    # of the handguard, which looks exactly like not gripping it.
    elbow = parent_frame(rig, "forearm_l").translation
    wrist_l = grip_world.copy()
    for _ in range(3):
        approach = (grip_world - elbow).normalized()
        wrist_l = grip_world - approach * HAND_LEN
        pose_l, err_l = solve_two_bone(rig, "upperarm_l", "forearm_l", "hand_l",
                                       UPPERARM_LEN, FOREARM_LEN, wrist_l,
                                       Vector((0.0, 1.0, -0.25)).normalized(), approach)
        out.update(pose_l)
        _apply(rig, out)
        elbow = parent_frame(rig, "forearm_l").translation
    fist = parent_frame(rig, "hand_l") @ Vector((0.0, HAND_LEN, 0.0))
    return out, max(err, (fist - grip_world).length)


def _apply(rig, pose):
    for name, rot in pose.items():
        pb = rig.pose.bones[name]
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (D(rot[0]), D(rot[1]), D(rot[2]))
    bpy.context.view_layer.update()


# Filled in by `fit_holds` once the armature exists, because they are solved, not typed.
CARRY_ARMS = {}
AIM_ARMS = {}

STANCE = {
    "hips": (2, 0, 0), "spine": (4, 0, 0), "chest": (2, 0, 0), "neck": (-3, 0, 0),
    "shoulder_r": (0, 0, -4), "shoulder_l": (0, 0, 6),
    "thigh_l": (-5, 0, 1), "shin_l": (9, 0, 0), "foot_l": (-5, 0, 0),
    "thigh_r": (-5, 0, -1), "shin_r": (9, 0, 0), "foot_r": (-5, 0, 0),
}


def fit_holds(rig):
    """Solve the two weapon holds and fold the carry pose into STANCE.

    Runs before any clip is authored, because every clip builds on STANCE.
    """
    for name, spec in HOLDS.items():
        clear_pose(rig)
        _apply(rig, {"spine": (4, 0, 0), "chest": (2, 0, 0),
                     "shoulder_r": (0, 0, -4), "shoulder_l": (0, 0, 6)})
        pose, err = solve_hold(rig, Vector(spec["wrist"]), spec["barrel"])
        if err > 0.02:
            raise RuntimeError(f"{name} hold: hands missed the weapon by {err * 1000:.0f} mm")
        (CARRY_ARMS if name == "carry" else AIM_ARMS).update(pose)
        log(f"  {name} hold solved, worst hand error {err * 1000:.1f} mm")
    STANCE.update(CARRY_ARMS)
    clear_pose(rig)


def arm(name, dx=0.0, dy=0.0, dz=0.0):
    """A solved carry-pose arm angle, nudged. Clips that want a little arm swing on top
    of the hold ask for it this way instead of naming a constant that no longer exists.
    """
    base = CARRY_ARMS[name]
    return (base[0] + dx, base[1] + dy, base[2] + dz)


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
            "upperarm_r": arm("upperarm_r", dx=s * 2.5),
            "upperarm_l": arm("upperarm_l", dx=s * 2.0),
            "head": (0, s * 2.0, 0),
        }))


# ---------------------------------------------------------------- leg IK
#
# Locomotion legs are solved, not posed.
#
# The first version of these clips keyed thigh and knee angles directly, and it was
# wrong in a way no amount of tweaking fixes: an FK leg has no notion of the floor, so
# the "planted" foot drifts, and the whole walk skates. Worse, the sliding rate depends
# on the stride distance the runtime happens to be configured with, so it cannot even
# be corrected downstream.
#
# Solving instead means the trajectory is authored where it is meaningful — as a foot
# path over the ground, with an explicit stance phase in which the foot does not move
# at all — and the joint angles fall out. Foot sliding then becomes arithmetic rather
# than art direction: the stride the runtime advances by is exactly the stride the feet
# were drawn against, and `npm run fightercheck` measures that it is.

THIGH_LEN, SHIN_LEN = 0.42, 0.43
ANKLE_Z = 0.09
HIP_X = 0.105
# Where the hip joint sits at rest. Every hip height in GAIT_SPECS is an absolute
# world height, and the drop written into the hips bone is the difference from this.
# Treating a gait's hip height as a *relative* drop instead put the crouch's hips
# 20 cm too high, which pushed the ankle targets outside the leg's reach and quietly
# truncated the step — caught only because the solver checks its own residual.
HIP_REST_Z = 0.94


def parent_frame(rig, name):
    """The bone's rest frame carried by its posed parent.

    Blender composes a pose bone as `parent.matrix @ parent_rest⁻¹ @ rest @ basis`.
    Everything up to `basis` is what a solver needs: the frame the bone would sit in
    if its own pose were identity. Reading it from the *posed* parent is what makes
    the legs follow the hips instead of fighting them, so the bounce, the sway and the
    crouch all come out of one solve.
    """
    bone = rig.data.bones[name]
    if bone.parent is None:
        return bone.matrix_local.copy()
    return (rig.pose.bones[bone.parent.name].matrix
            @ bone.parent.matrix_local.inverted()
            @ bone.matrix_local)


def _swing_to(frame, world_dir):
    """Pose euler that swings a bone's own axis onto `world_dir`.

    Minimal-arc, so the bone picks up no roll it was not asked for — which matters,
    because an unwanted twist in a thigh shows up as a foot pointing sideways.
    """
    local = frame.to_3x3().inverted() @ Vector(world_dir).normalized()
    return Vector((0.0, 1.0, 0.0)).rotation_difference(local).to_euler("XYZ")


def solve_leg(rig, s, ankle, toe_dir):
    """Two-bone analytic IK for one leg. See `solve_two_bone`."""
    return solve_two_bone(rig, f"thigh_{s}", f"shin_{s}", f"foot_{s}",
                          THIGH_LEN, SHIN_LEN, ankle, Vector((0.0, -1.0, 0.0)), toe_dir)


def solve_two_bone(rig, upper_n, lower_n, tip_n, a, b, target, pole, tip_dir):
    """Two-bone analytic IK for a limb, in armature space.

    `target` is where the tip joint must end up — the ankle for a leg, the wrist for
    an arm — and `tip_dir` which way the last bone points from there. `pole` is the
    direction the middle joint leads: forward for a knee, backward for an elbow.

    Returns euler triples in degrees, ready for `key`, plus the residual, so the caller
    can assert the solve actually landed. An IK that silently misses is worse than no
    IK, because the clip still looks plausible in a still frame — which is exactly how
    every fighter came to hold his rifle at arm's length with his other hand gripping
    air 20 cm away from the handguard.
    """
    bones = rig.data.bones
    target = Vector(target)

    f1 = parent_frame(rig, upper_n)
    root = f1.translation
    v = target - root
    # Clamp short of full extension: a perfectly straight limb is the singular case
    # where the middle joint's direction is undefined, and it reads as a stiff peg.
    length = min(v.length, (a + b) * 0.995)
    vh = v.normalized()
    cos_a = max(-1.0, min(1.0, (a * a + length * length - b * b) / (2 * a * length)))
    axis = vh.cross(pole)
    if axis.length < 1e-4:
        axis = Vector((-1.0, 0.0, 0.0))
    upper_dir = Matrix.Rotation(math.acos(cos_a), 3, axis.normalized()) @ vh
    mid = root + upper_dir * a
    lower_dir = (target - mid).normalized()

    e_u = _swing_to(f1, upper_dir)
    m1 = f1 @ e_u.to_matrix().to_4x4()
    f2 = m1 @ bones[upper_n].matrix_local.inverted() @ bones[lower_n].matrix_local
    e_l = _swing_to(f2, lower_dir)
    m2 = f2 @ e_l.to_matrix().to_4x4()
    f3 = m2 @ bones[lower_n].matrix_local.inverted() @ bones[tip_n].matrix_local
    e_t = _swing_to(f3, tip_dir)

    deg = lambda e: (math.degrees(e.x), math.degrees(e.y), math.degrees(e.z))
    return ({upper_n: deg(e_u), lower_n: deg(e_l), tip_n: deg(e_t)},
            (f3.translation - target).length)


# ---------------------------------------------------------------- locomotion
#
# One entry per gait. `stride` is the ground distance a full cycle covers and it is the
# same number the runtime is configured with in src/fighter-rig.js — that identity is
# the whole design. `duty` is the fraction of the cycle each foot spends planted; above
# 0.5 the two stance windows overlap and the fighter always has a foot down (a walk),
# below 0.5 there is a flight phase (a run).
#
# `sag` lowers the hips off full leg extension. It is not a style choice: the ankle has
# to stay inside a sphere of radius 0.85 m around the hip, and a longer stride pushes
# the foot further out, so a longer stride *requires* more bend. Too little and the leg
# hits its limit at the extremes of the step and the stride quietly truncates.
GAIT_SPECS = {
    "walk":   dict(length=33, stride=1.32, side_stride=0.86, duty=0.60, lift=0.10,
                   sag=0.135, bounce=0.022, sway=0.022, arm=20, lean=5, hip_z=0.94),
    "run":    dict(length=33, stride=2.20, side_stride=1.44, duty=0.42, lift=0.20,
                   sag=0.175, bounce=0.045, sway=0.030, arm=36, lean=12, hip_z=0.94),
    "crouch": dict(length=41, stride=0.84, side_stride=0.60, duty=0.64, lift=0.07,
                   sag=0.030, bounce=0.012, sway=0.018, arm=9, lean=4, hip_z=0.74),
}

# The blendspace poles, in order of increasing angle from straight ahead.
#
# Eight, not four. Four is enough to *name* every direction but not to represent one:
# blending a forward cycle with a sideways one gives a foot that travels neither, and
# the measured mismatch was a diagonal walk sliding 2.9 m/s while both its parents were
# clean. Eight poles put an authored clip within 22 degrees of any heading, which is
# what Unreal's standard locomotion blendspace does and for the same reason.
DIRS = ["f", "fr", "r", "br", "b", "bl", "l", "fl"]


def dir_vec(i):
    """Pole `i` as (rightward, forward) components of travel."""
    a = i * math.pi / 4
    return math.sin(a), math.cos(a)


def dir_world(i):
    """Pole `i` in Blender world axes. The fighter faces -Y, so his right is -X."""
    right, fwd = dir_vec(i)
    return -right, -fwd


def dir_stride(i, spec):
    """Stride for one pole, off the ellipse through the forward and sideways strides.

    A side shuffle genuinely covers less ground per cycle than a forward stride, so the
    blendspace is not isotropic; an ellipse is the natural interpolation between the
    two axes and keeps neighbouring poles close enough that the blend between them
    stays honest.
    """
    right, fwd = dir_vec(i)
    a, b = spec["stride"], spec["side_stride"]
    return 1.0 / math.hypot(fwd / a, right / b)


def _foot_path(u, amp, duty, lift, travel):
    """Where one foot is at cycle phase `u`, as an offset from its own centre.

    Stance runs the foot backwards in a straight line at a constant rate; that is the
    part that has to be exactly right, because it is the part the ground sees. Swing
    arcs it forward over the top. `amp` is half the stance excursion, and it is tied to
    the stride by `amp = stride * duty / 2` — during stance the body covers
    `stride * duty` of ground, and the foot has to give back precisely that much.
    """
    u = u % 1.0
    if u < duty:
        t = u / duty
        along, height = amp * (1.0 - 2.0 * t), 0.0
    else:
        t = (u - duty) / (1.0 - duty)
        along, height = amp * (2.0 * t - 1.0), lift * math.sin(math.pi * t)
    return travel[0] * along, travel[1] * along, height


def _stride_cycle(rig, name, index, spec, base=None, torso=None):
    """One locomotion cycle in one direction of travel.

    Directions are `f`, `b`, `l`, `r`. They exist as separate clips because that is
    what a blendspace needs: the runtime weights whichever are adjacent to the actual
    direction of travel, so a fighter strafing gets a real cross-step rather than a
    forward walk played while sliding sideways.

    **Every clip in a blendspace must share a phase.** All four directions here have
    the same length and, at phase 0, put the left foot at the leading end of its step —
    whichever way "leading" happens to point for that clip. The runtime drives them all
    from one clock. Get this convention wrong in a single clip and that clip still
    looks fine on its own, while every diagonal that blends it collapses: an earlier
    lateral pair moved both feet the same way at once, and the diagonal blend measured
    0.10 m of foot travel against 0.55 m for the pure forward.
    """
    base = base or {}
    torso = torso or {}
    new_action(rig, name)
    clear_pose(rig)

    travel = dir_world(index)
    right, fwd = dir_vec(index)
    # How sideways this pole is, 0 straight ahead to 1 straight across. Everything that
    # differs between a stride and a shuffle scales on it, so the eight clips form a
    # continuum instead of two families with a seam between them.
    lateral = abs(right)
    stride = dir_stride(index, spec)
    duty, lift = spec["duty"], spec["lift"]
    amp = stride * duty / 2.0
    length = spec["length"]
    # Backwards travel gets a smaller body lean and a flatter arm swing; running
    # backwards while leaning back is how you fall over.
    lean_scale = (1.0 - lateral * 0.65) * (fwd if fwd > 0 else fwd * 0.4)

    # Sample the cycle densely *and* land a sample exactly on every stance/swing
    # boundary, for both feet. Keys are interpolated linearly, so a boundary that falls
    # between two samples gets its corner rounded off — which shortens the stance the
    # whole design is built on, and does it silently.
    # One sample per exported frame, so nothing is lost to resampling. The clip length
    # has to be able to hold the keys: a 23-frame run cycle sampled 24 times collapsed
    # pairs of keys onto the same frame and quietly shortened the stride by 6%.
    phases = sorted({round(i / (length - 1.0), 6) for i in range(length)}
                    | {round(duty, 6), round((duty + 0.5) % 1.0, 6), 0.5})
    residual = 0.0
    for u in phases:
        frame = 1 + u * (length - 1)

        # --- hips and torso, posed first so the legs can be solved against them ---
        hips_z = spec["hip_z"] - spec["sag"] - spec["bounce"] * math.cos(4 * math.pi * u)
        # Weight shifts toward whichever foot is planted; without it a walk looks like
        # a puppet sliding along a rail.
        sway = spec["sway"] * math.cos(2 * math.pi * (u - duty / 2))
        swing = math.sin(2 * math.pi * u)          # +1 = left leg leading
        body_lean = spec["lean"] * lean_scale

        counter = 1.0 - lateral * 0.6      # arms and shoulders quieten in a shuffle
        pose = merged(STANCE, torso, {
            "hips": (body_lean, 0, -swing * 2.0 * counter),
            "spine": (body_lean * 0.6, swing * 3.0 * counter, -right * 4.0),
            "chest": (2, -swing * 4.0 * counter, 0),
            "upperarm_l": arm("upperarm_l", dx=-spec["arm"] * swing * counter),
            "upperarm_r": arm("upperarm_r", dx=spec["arm"] * 0.25 * swing * counter),
        })
        for bone_name, rot in pose.items():
            pb = rig.pose.bones[bone_name]
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (D(rot[0]), D(rot[1]), D(rot[2]))
        hips_pb = rig.pose.bones["hips"]
        # Lateral shift goes straight into the bone's local X, which the roll
        # convention pins to world X.
        hips_pb.location = (sway,) + hips_loc(down=HIP_REST_Z - hips_z)[1:]
        # The solve reads the *posed* hips, so the depsgraph has to have caught up.
        bpy.context.view_layer.update()

        # --- legs, solved against the floor ---
        legs = {}
        for side, phase_off, x0 in (("l", 0.0, HIP_X), ("r", 0.5, -HIP_X)):
            dx, dy, dz = _foot_path(u + phase_off, amp, duty, lift, travel)
            # Lateral steps bring the feet close together; a small outward bias keeps
            # them from passing through each other at the crossover.
            bias = (0.035 if side == "l" else -0.035) * lateral
            ankle = (x0 + dx + bias, dy, ANKLE_Z + dz)
            # Toe tips down through the swing so the foot rolls off and lands heel
            # first rather than slapping down flat.
            roll = -0.35 if (u + phase_off) % 1.0 > duty else 0.15
            # Feet stay pointing where he faces as the step goes sideways — nobody
            # turns their feet out to strafe with a weapon up. Blending the toe
            # direction on `lateral` is what keeps the eight clips a continuum.
            aim_y = travel[1] * (1.0 - lateral) - lateral
            toe = Vector((travel[0] * (1.0 - lateral * 0.65), aim_y, roll)).normalized()
            solved, err = solve_leg(rig, side, ankle, toe)
            residual = max(residual, err)
            legs.update(solved)

        key(rig, frame, merged(pose, base, legs),
            extra_loc={"hips": (sway,) + hips_loc(down=HIP_REST_Z - hips_z)[1:]})

    if residual > 2e-3:
        raise RuntimeError(f"{name}: leg IK missed its target by {residual * 1000:.1f} mm")
    # Linear interpolation between dense samples. Bezier handles overshoot a stance
    # segment, which puts the planted foot back in motion at exactly the moment the
    # whole design says it must not move.
    for fcurve in rig.animation_data.action.fcurves:
        for kp in fcurve.keyframe_points:
            kp.interpolation = "LINEAR"


def anim_locomotion(rig):
    """Directional cycles for standing gaits: the lower-body blendspace."""
    for gait in ("walk", "run"):
        for i, d in enumerate(DIRS):
            _stride_cycle(rig, f"{gait}_{d}", i, GAIT_SPECS[gait])


# A real combat crouch, not a slight bend. The first pass dropped the head only 25 cm,
# which was visually indistinguishable from standing and — worse — left the *visible*
# head 20 cm above the eye height the AI actually fires and sights from
# (`Combatant.eyePos`, 1.55 x crouchK). CROUCH_HEAD_DROP below keeps the two in step.
CROUCH = {
    "hips": (20, 0, 0), "spine": (15, 0, 0), "chest": (8, 0, 0), "neck": (-16, 0, 0),
    "thigh_l": (-96, 0, 5), "shin_l": (112, 0, 0), "foot_l": (-24, 0, 0),
    "thigh_r": (-96, 0, -5), "shin_r": (112, 0, 0), "foot_r": (-24, 0, 0),
}
# No arm entries: the solved carry hold in STANCE already has both hands on the
# weapon, and a crouch does not change how a weapon is held. Nudging the arms here is
# how they used to drift out of the grip a couple of degrees at a time.


def anim_crouch_idle(rig):
    new_action(rig, "crouch_idle")
    clear_pose(rig)
    for f, s in ((1, 0), (56, 1), (111, 0)):
        key(rig, f, merged(STANCE, CROUCH, {
            "spine": (10 - s * 1.5, 0, 0),
            "chest": (6 + s * 1.5, 0, 0),
        }), extra_loc={"hips": hips_loc(down=0.42)})


def anim_crouch_locomotion(rig):
    """Crouched directional cycles. Same blendspace, shorter stride, hips held low.

    Only the *torso* half of CROUCH is passed through. Its leg angles are what a
    standing-still crouch needs; here the hips are simply dropped to `hip_z` and the
    legs are solved to reach the floor from there, which is the same thing done
    honestly — and it keeps the feet planted, which hand-keyed crouch legs did not.
    """
    torso = {k: v for k, v in CROUCH.items() if not k.startswith(("thigh", "shin", "foot"))}
    for i, d in enumerate(DIRS):
        _stride_cycle(rig, f"crouch_{d}", i, GAIT_SPECS["crouch"], torso=torso)


def _unused_anim_crouch_walk(rig):
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
    """Upper body only: the shouldered hold, layered over the carry hold.

    Frame 1 is the *carry* pose, not zero. `AnimationUtils.makeClipAdditive` takes its
    reference from the clip's first frame, so opening from carry makes the delta
    exactly "carry to shouldered" — which is what has to be added on top of a
    locomotion clip, since those are all built on the carry stance. Opening from zero
    would add the whole hold a second time and point the weapon at the ceiling.

    Both poses are solved (see `HOLDS`), so bringing the weapon up moves the support
    hand *with* it rather than leaving it behind.
    """
    new_action(rig, "aim_pose")
    clear_pose(rig)
    lift = {"spine": (2, 0, 0), "chest": (2, -5, 0), "neck": (5, 0, 0), "head": (3, -2, 0),
            "shoulder_r": (0, 0, -9), "shoulder_l": (0, 0, 10)}
    rest = {k: (0, 0, 0) for k in lift}
    key(rig, 1, merged(rest, CARRY_ARMS))
    key(rig, 10, merged(lift, AIM_ARMS))
    key(rig, 20, merged(lift, AIM_ARMS))


# Aim offset.
#
# Unreal builds these as a 2D grid of additive poses sampled by the aim pitch and yaw;
# this is the same idea with four poles and the runtime doing the bilinear blend. It
# replaces rotating the spine procedurally, which bent the fighter like a hinge — a
# real aim offset twists through the whole chain and takes the head and shoulders with
# it, which is what makes an aiming pose read as aiming rather than as leaning.
#
# Every pose here touches spine, chest, neck and head only, so it layers over any
# locomotion clip without disturbing the legs.
AIM_POLES = {
    "aim_up":    {"spine": (-9, 0, 0), "chest": (-13, 0, 0), "neck": (-10, 0, 0), "head": (-8, 0, 0)},
    "aim_down":  {"spine": (11, 0, 0), "chest": (16, 0, 0), "neck": (9, 0, 0), "head": (7, 0, 0)},
    "aim_left":  {"spine": (0, 14, 0), "chest": (0, 20, 0), "neck": (0, 10, 0), "head": (0, 9, 0)},
    "aim_right": {"spine": (0, -14, 0), "chest": (0, -20, 0), "neck": (0, -10, 0), "head": (0, -9, 0)},
}


def anim_aim_offsets(rig):
    """Four additive poles. Frame 1 is rest so `makeClipAdditive` reads a true delta."""
    for name, pose in AIM_POLES.items():
        new_action(rig, name)
        clear_pose(rig)
        zero = {k: (0, 0, 0) for k in pose}
        key(rig, 1, zero)
        key(rig, 6, pose)
        key(rig, 12, pose)


def anim_lean(rig):
    """Leaning out from cover, as a spine bend rather than tipping the whole body.

    Rolling the root was what the runtime did before, which pivots the fighter about
    his feet and lifts one boot off the floor. A lean is a spine action.
    """
    # Sign verified by measurement, not by deriving it: it depends on this file's roll
    # convention, Blender's axes and the glTF Y-up flip all at once, and the first
    # version had it backwards — which puts a fighter out of the opposite side of cover
    # from the one combat believes he is exposing. `npm run fightercheck` checks it.
    for name, sign in (("lean_l", -1), ("lean_r", 1)):
        new_action(rig, name)
        clear_pose(rig)
        # Spine and up only. Keying the hips here bent the legs with the torso and
        # walked the fighter's feet 6 cm sideways when he leaned — the same class of
        # fault as rolling the whole object, just one bone further down.
        pose = {
            "spine": (0, 0, sign * 14), "chest": (0, 0, sign * 16),
            "neck": (0, 0, sign * 7), "head": (0, 0, sign * 6),
        }
        key(rig, 1, {k: (0, 0, 0) for k in pose})
        key(rig, 8, pose)
        key(rig, 14, pose)


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


# Abduction sign: on these bones a *positive* Z rotation pulls the limb toward the
# midline. The death clips were authored with the opposite assumption, so the splay
# that was meant to fling arms and legs apart drove them across each other — the
# corpse ended up with its wrists and ankles swapped. Verified by measuring hand and
# foot X in the fighter's own frame; see tools/poses/stances.js.


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
        "upperarm_r": (24, 0, 20), "upperarm_l": (22, 0, -20),
        "thigh_l": (-26, 0, -4), "shin_l": (34, 0, 0),
        "thigh_r": (-24, 0, 4), "shin_r": (30, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.10)})
    key(rig, 20, merged(STANCE, {
        "hips": (-55, 0, 0), "spine": (-8, 0, 0), "chest": (-12, 0, 0),
        "neck": (-18, 0, 0), "head": (-14, 0, 0),
        "upperarm_r": (40, 0, 46), "forearm_r": (-20, 0, 0),
        "upperarm_l": (38, 0, -46), "forearm_l": (-24, 0, 0),
        "thigh_l": (20, 0, -8), "shin_l": (40, 0, 0),
        "thigh_r": (18, 0, 8), "shin_r": (36, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.45, forward=-0.20)})
    key(rig, 34, merged(STANCE, {
        "hips": (-90, 0, 3), "spine": (-4, 0, 0), "chest": (-6, 4, 0),
        "neck": (-12, 6, 0), "head": (-8, 8, 0),
        "upperarm_r": (46, 0, 66), "forearm_r": (-12, 0, 0),
        "upperarm_l": (44, 0, -62), "forearm_l": (-16, 0, 0),
        "thigh_l": (8, 0, -12), "shin_l": (12, 0, 0), "foot_l": (-25, 0, 0),
        "thigh_r": (6, 0, 10), "shin_r": (10, 0, 0), "foot_r": (-25, 0, 0),
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
        "upperarm_r": (-28, 0, 16), "upperarm_l": (-26, 0, -16),
        "thigh_l": (-34, 0, -4), "shin_l": (48, 0, 0),
        "thigh_r": (-30, 0, 4), "shin_r": (44, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.18)})
    key(rig, 22, merged(STANCE, {
        "hips": (60, 0, 0), "spine": (8, 0, 0), "chest": (12, 0, 0),
        "neck": (22, 0, 0), "head": (16, 0, 0),
        "upperarm_r": (-58, 0, 40), "forearm_r": (-26, 0, 0),
        "upperarm_l": (-56, 0, -40), "forearm_l": (-28, 0, 0),
        "thigh_l": (-10, 0, -6), "shin_l": (26, 0, 0),
        "thigh_r": (-8, 0, 6), "shin_r": (22, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.42, forward=0.24)})
    key(rig, 36, merged(STANCE, {
        "hips": (90, 0, -4), "spine": (3, 0, 0), "chest": (6, -5, 0),
        "neck": (20, 0, 0), "head": (12, -6, 0),
        "upperarm_r": (-66, 0, 56), "forearm_r": (-18, 0, 0),
        "upperarm_l": (-64, 0, -54), "forearm_l": (-20, 0, 0),
        "thigh_l": (-6, 0, -8), "shin_l": (10, 0, 0), "foot_l": (-14, 0, 0),
        "thigh_r": (-4, 0, 8), "shin_r": (8, 0, 0), "foot_r": (-14, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.80, forward=0.40)})


def anim_death_collapse(rig):
    """Headshot: no bracing at all. Folds and drops where he stood, on his side."""
    new_action(rig, "death_collapse")
    clear_pose(rig)
    key(rig, 1, STANCE, extra_loc={"hips": hips_loc()})
    key(rig, 10, merged(STANCE, {
        "hips": (26, 0, 8), "spine": (14, 0, 0), "chest": (18, 8, 0),
        "neck": (16, 0, 0), "head": (20, 10, 0),
        "upperarm_r": (-12, 0, 26), "upperarm_l": (-10, 0, -26),
        "thigh_l": (-84, 0, -8), "shin_l": (96, 0, 0),
        "thigh_r": (-80, 0, 8), "shin_r": (92, 0, 0),
    }), extra_loc={"hips": hips_loc(down=0.50)})
    key(rig, 26, merged(STANCE, {
        "hips": (62, 0, 18), "spine": (14, 0, 0), "chest": (20, 14, 0),
        "neck": (20, 0, 0), "head": (24, 16, 0),
        "upperarm_r": (-26, 0, 52), "forearm_r": (-34, 0, 0),
        "upperarm_l": (-22, 0, -48), "forearm_l": (-30, 0, 0),
        "thigh_l": (-70, 0, -16), "shin_l": (100, 0, 0), "foot_l": (-8, 0, 0),
        "thigh_r": (-66, 0, 14), "shin_r": (96, 0, 0), "foot_r": (-8, 0, 0),
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
    anim_idle, anim_locomotion, anim_crouch_idle, anim_crouch_locomotion,
    anim_aim_pose, anim_aim_offsets, anim_lean,
    anim_fire, anim_reload, anim_throw, anim_hit_react, anim_heal,
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
    fit_holds(rig)          # solves the arm poses every clip below is built on
    for clip in CLIPS:
        clip(rig)
    plant_on_floor(rig, body)
    bpy.ops.object.mode_set(mode="OBJECT")
    rig.animation_data.action = None        # ship no default pose

    log(f"  {len(bpy.data.actions)} clips: {', '.join(a.name for a in bpy.data.actions)}")
    export("fighter", animations=True, budget=2800)


main()
