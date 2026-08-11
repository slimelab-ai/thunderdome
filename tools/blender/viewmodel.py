"""Authors the first-person arms.

    npm run assets:models -- viewmodel

Output: public/assets/models/fp_arms.glb — a skinned pair of arms, 9 bones, two
material slots, and the clip set the viewmodel state machine plays.

Three conventions matter here, and two of them are *different* from the fighter:

**The weapon socket sits at the origin with identity orientation.** Weapons attach to
it, so the arms wrap around whatever the player is holding without moving it. That
also means every bit of existing viewmodel maths in src/player.js — the hip/ADS lerp,
the kick, the sway — keeps working untouched, because the weapon still ends up
exactly where it used to be relative to `vmRoot`.

**The right arm is on +X.** The fighter's right hand is at -X because he faces the
camera; here we are looking out through the player's own eyes, so his right hand is on
the right of the screen.

**Forward is +Y**, matching the weapon pack — the exporter's Y-up conversion turns
Blender +Y into glTF -Z, which is where the barrels point.
"""

import bpy
import math
import os
import sys
from mathutils import Vector

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from td_lib import (  # noqa: E402
    reset, cube, sphere, segment, atlas_uv, export, log, apply_modifiers, auto_smooth,
)

D = math.radians

BODY = "TD_fighter_body"          # gloves and skin
UNIFORM = "TD_fighter_uniform"    # sleeves, tinted per squad at runtime

# (name, parent, head, tail, weight scope)
#
# The arms come in from the bottom corners of the screen and meet at the weapon: the
# right hand at the grip (the origin), the left hand forward on the handguard.
# Grip targets, in weapon space. The socket is the arms' origin *and* the weapon's
# origin, so these are read straight off tools/blender/weapons.py: the rifle's pistol
# grip sits at (0, -0.09, -0.055) and its handguard at (0, 0.26, +0.036). Hands that
# do not land on those points read as floating next to the gun, which is exactly how
# the first build looked.
GRIP_R = (0.012, -0.075, -0.050)
GRIP_L = (-0.012, 0.250, 0.010)

BONES = [
    ("vm_root",     None,        (0, 0, 0),                (0, 0.08, 0)),
    ("upperarm_r",  "vm_root",   (0.24, -0.52, -0.38),     (0.15, -0.32, -0.25)),
    ("forearm_r",   "upperarm_r", (0.15, -0.32, -0.25),    (0.050, -0.155, -0.125)),
    ("hand_r",      "forearm_r", (0.050, -0.155, -0.125),  GRIP_R),
    ("upperarm_l",  "vm_root",   (-0.27, -0.30, -0.36),    (-0.19, -0.07, -0.21)),
    ("forearm_l",   "upperarm_l", (-0.19, -0.07, -0.21),   (-0.055, 0.155, -0.055)),
    ("hand_l",      "forearm_l", (-0.055, 0.155, -0.055),  GRIP_L),
    # Weapon socket: points up (Blender +Z) with its roll set so the local frame comes
    # out as glTF identity — X right, Y up, Z back. A weapon parented here needs no
    # transform of its own.
    ("weapon",      "hand_r",    (0, 0, 0),                (0, 0, 0.08)),
]

ROLL_OVERRIDE = {"weapon": Vector((0, -1, 0))}
SOCKETS = {"weapon"}

PART_BONES = {}


def part(o, band, bones):
    atlas_uv(o, band)
    PART_BONES[o.name] = tuple(bones)
    return o


def build_arms():
    """Sleeved forearms, gloved hands. Seen from 40 cm, so the hands get the detail."""
    parts = []
    P = parts.append

    for side, sx in (("r", 1), ("l", -1)):
        ua = f"upperarm_{side}"
        fa = f"forearm_{side}"
        hd = f"hand_{side}"
        bone = {b[0]: b for b in BONES}
        P(part(segment(f"Upper sleeve {side}", bone[ua][2], bone[ua][3], 0.058, 0.050, UNIFORM),
               "cloth", (ua, fa)))
        P(part(segment(f"Fore sleeve {side}", bone[fa][2], bone[fa][3], 0.050, 0.040, UNIFORM),
               "cloth", (fa, ua, hd)))
        P(part(sphere(f"Elbow {side}", bone[fa][2], 0.052, UNIFORM, 10, 6), "cloth", (fa, ua)))
        # Cuff: the visual break between sleeve and glove, and the thing that makes a
        # bare tapered cylinder read as an arm in a jacket.
        P(part(segment(f"Cuff {side}", bone[hd][2], bone[hd][3], 0.046, 0.042, BODY, vertices=10),
               "gear", (hd, fa)))

        # The hand is built *around* the grip point, so the fist closes on the weapon
        # rather than ending next to it.
        hx, hy, hz = bone[hd][3]
        P(part(cube(f"Palm {side}", (hx + sx * 0.030, hy, hz - 0.004), (0.048, 0.080, 0.078),
                    BODY, 0.014), "rubber", (hd,)))
        # Fingers wrap under and across the weapon; the thumb comes over the top. That
        # closed silhouette is what reads as "gripping" at 40 cm.
        for i, off in enumerate((-0.024, 0.0, 0.024)):
            P(part(cube(f"Finger {side}{i}", (hx + sx * 0.006, hy + off, hz - 0.036),
                        (0.052, 0.020, 0.044), BODY, 0.009,
                        rotation=(0, 0, 0)), "rubber", (hd,)))
        P(part(cube(f"Thumb {side}", (hx + sx * 0.012, hy + 0.012, hz + 0.030),
                    (0.056, 0.024, 0.022), BODY, 0.009,
                    rotation=(0, D(sx * 10), 0)), "rubber", (hd,)))
    return parts


def flatten_and_join(parts):
    for o in parts:
        apply_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = "fp_arms"
    auto_smooth(o, 40)
    return o


def set_roll(bone, name):
    """Same convention as the fighter: local X pinned to world X, so rotation about X
    is flexion. See tools/blender/fighter.py for why this is not left to Blender."""
    if name in ROLL_OVERRIDE:
        bone.align_roll(ROLL_OVERRIDE[name])
        return
    y = (bone.tail - bone.head).normalized()
    z = Vector((1, 0, 0)).cross(y)
    if z.length < 1e-4:
        z = Vector((0, 0, 1))
    bone.align_roll(z)


def build_armature():
    bpy.ops.object.armature_add(location=(0, 0, 0))
    rig = bpy.context.object
    rig.name = "fp_rig"
    rig.data.name = "fp_rig"
    bpy.ops.object.mode_set(mode="EDIT")
    edit = rig.data.edit_bones
    for b in list(edit):
        edit.remove(b)
    made = {}
    for name, parent, head, tail in BONES:
        b = edit.new(name)
        b.head = Vector(head)
        b.tail = Vector(tail)
        if parent:
            b.parent = made[parent]
        set_roll(b, name)
        made[name] = b
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def point_segment_distance(p, a, b):
    ab = b - a
    denom = ab.dot(ab)
    if denom < 1e-9:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / denom))
    return (p - (a + ab * t)).length


BONE_SEGMENTS = {n: (Vector(h), Vector(t)) for n, _p, h, t in BONES if n not in SOCKETS}


def bake_part_weights(parts, max_influences=3, falloff=4.0):
    """Scoped inverse-distance weights, exactly as for the fighter: each part is only
    weighted to the bones that anatomically drive it."""
    for o in parts:
        scope = PART_BONES[o.name]
        for name in scope:
            if name not in o.vertex_groups:
                o.vertex_groups.new(name=name)
        groups = {g.name: g for g in o.vertex_groups}
        segs = [(n, *BONE_SEGMENTS[n]) for n in scope]
        for v in o.data.vertices:
            p = o.matrix_world @ v.co
            scored = sorted(
                (max(point_segment_distance(p, a, b), 1e-4), n) for n, a, b in segs
            )[:max_influences]
            weights = [(n, 1.0 / (d ** falloff)) for d, n in scored]
            norm = sum(w for _n, w in weights)
            for n, w in weights:
                groups[n].add([v.index], w / norm, "REPLACE")


def attach_to_rig(body, rig):
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_NAME")


# ---------------------------------------------------------------- animation

def new_action(rig, name):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    if not rig.animation_data:
        rig.animation_data_create()
    rig.animation_data.action = action
    return action


def key(rig, frame, pose, loc=None):
    for bone_name, rot in pose.items():
        pb = rig.pose.bones[bone_name]
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (D(rot[0]), D(rot[1]), D(rot[2]))
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc:
        for bone_name, v in loc.items():
            pb = rig.pose.bones[bone_name]
            pb.location = v
            pb.keyframe_insert("location", frame=frame)


def clear_pose(rig):
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)


ZERO = {n: (0, 0, 0) for n, _p, _h, _t in BONES}


def anim_idle(rig):
    """Breathing drift. Small — a viewmodel that wanders is nauseating at 60 fps."""
    new_action(rig, "idle")
    clear_pose(rig)
    for f, s in ((1, 0), (70, 1), (139, 0)):
        key(rig, f, {
            "vm_root": (s * 0.6, s * 0.35, 0),
            "upperarm_r": (s * 0.9, 0, 0),
            "upperarm_l": (s * 0.7, 0, 0),
        }, loc={"vm_root": (0, 0, s * 0.004)})


def anim_fire(rig):
    """Recoil. Additive at runtime, so these are deltas from the rest pose.

    Sign matters and was wrong: `vm_root` points forward, so a *positive* X rotation
    takes the muzzle up. The original keys were negative, which pitched every weapon's
    barrel down under recoil while the camera kicked up — the two fighting each other.
    """
    new_action(rig, "fire")
    clear_pose(rig)
    z = {"vm_root": (0, 0, 0), "upperarm_r": (0, 0, 0), "upperarm_l": (0, 0, 0),
         "forearm_r": (0, 0, 0), "forearm_l": (0, 0, 0)}
    key(rig, 1, z, loc={"vm_root": (0, 0, 0)})
    key(rig, 3, {"vm_root": (7.0, 1.6, 0), "upperarm_r": (4.5, 0, 0),
                 "upperarm_l": (3.5, 0, 0), "forearm_r": (-3.0, 0, 0),
                 "forearm_l": (-2.4, 0, 0)}, loc={"vm_root": (0, -0.030, 0.008)})
    key(rig, 9, {"vm_root": (1.8, 0.4, 0), "upperarm_r": (1.2, 0, 0),
                 "upperarm_l": (0.9, 0, 0), "forearm_r": (-0.8, 0, 0),
                 "forearm_l": (-0.6, 0, 0)}, loc={"vm_root": (0, -0.008, 0.002)})
    key(rig, 16, z, loc={"vm_root": (0, 0, 0)})


def anim_reload(rig):
    """Mag out, fresh mag in, slap, back on target.

    Full-body for the arms: the support hand leaves the handguard entirely, which no
    additive layer could express without fighting the idle sway.
    """
    new_action(rig, "reload")
    clear_pose(rig)
    key(rig, 1, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})
    # tilt the weapon inboard so the magazine well is visible
    key(rig, 8, {**ZERO, "vm_root": (-14, 16, 9), "upperarm_r": (-6, 0, 0),
                 "upperarm_l": (10, 0, -16), "forearm_l": (16, 0, 0)},
        loc={"vm_root": (0, -0.05, -0.03), "hand_l": (0, 0, 0)})
    # support hand drops away with the spent magazine
    key(rig, 18, {**ZERO, "vm_root": (-16, 18, 11), "upperarm_r": (-7, 0, 0),
                  "upperarm_l": (34, 0, -22), "forearm_l": (40, 0, 0), "hand_l": (-24, 0, 0)},
        loc={"vm_root": (0, -0.06, -0.035), "hand_l": (0, -0.02, -0.10)})
    # reaching for a fresh one, out of frame
    key(rig, 28, {**ZERO, "vm_root": (-15, 17, 10), "upperarm_r": (-7, 0, 0),
                  "upperarm_l": (46, 0, -26), "forearm_l": (52, 0, 0), "hand_l": (-30, 0, 0)},
        loc={"vm_root": (0, -0.055, -0.032), "hand_l": (0, -0.03, -0.16)})
    # seating it
    key(rig, 40, {**ZERO, "vm_root": (-12, 14, 8), "upperarm_r": (-5, 0, 0),
                  "upperarm_l": (14, 0, -14), "forearm_l": (20, 0, 0), "hand_l": (-8, 0, 0)},
        loc={"vm_root": (0, -0.045, -0.026), "hand_l": (0, 0, -0.02)})
    # slap, then settle back on target
    key(rig, 47, {**ZERO, "vm_root": (-5, 5, 3), "upperarm_l": (2, 0, -3), "forearm_l": (4, 0, 0)},
        loc={"vm_root": (0, -0.014, -0.008), "hand_l": (0, 0, 0)})
    key(rig, 58, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})


def anim_draw(rig):
    """Weapon swings up into view. Plays on every weapon switch."""
    new_action(rig, "draw")
    clear_pose(rig)
    key(rig, 1, {**ZERO, "vm_root": (-46, 0, 16), "upperarm_r": (-16, 0, 0), "upperarm_l": (-14, 0, 0)},
        loc={"vm_root": (0, -0.06, -0.26)})
    key(rig, 12, {**ZERO, "vm_root": (7, 0, -3), "upperarm_r": (3, 0, 0), "upperarm_l": (2, 0, 0)},
        loc={"vm_root": (0, 0.012, 0.02)})
    key(rig, 20, ZERO, loc={"vm_root": (0, 0, 0)})


def anim_melee(rig):
    """Knife slash: wind up high and right, cut down-left, recover.

    A cut, not a stab, and the reason is the grip. The knife is canted across the view
    by `GRIP_ROT` in src/viewmodel.js so that the flat of the blade faces the camera —
    without that a six-millimetre blade pointed down the view axis is edge-on and
    literally invisible. But a blade held across the view cannot also lead a forward
    thrust, and the version this replaces tried: it drove the fist 22 cm forward while
    the point travelled only 15 cm, so at full extension the tip was three centimetres
    *behind* the fist. That is a punch with a knife held sideways.

    Measured from the model, the edge faces down and to the left in camera space, so
    the cut travels down and to the left and the edge leads it. Forward travel is
    small on purpose — a slash reaches across, not out.

    `tools/_knifetrace.mjs`-style tracing is the only way to check any of this: the
    clip is a third of a second, the game's own loop advances it between screenshots,
    and sampling it by eye reports whatever moment the timing happened to land on.
    """
    # The off hand, keyed on every frame of this clip.
    #
    # `melee` is in SUPPORT_ARM_CLIPS, so the runtime lets go of the knife's support
    # pins while it plays — and every bone this clip does not key falls to ZERO, which
    # is the rig's rest pose with *both* hands out on a rifle handguard. Measured, the
    # left fist went from 16 cm behind the camera (tucked, correct for a knife) to
    # 63 cm in front of it: mid-slash the off hand flew forward and gripped a weapon
    # that is not there. Keying it here is what keeps it out of the way.
    OFF = {"upperarm_l": (62, 0, -16), "forearm_l": (36, 0, 0), "hand_l": (0, 0, 0)}

    new_action(rig, "melee")
    clear_pose(rig)
    key(rig, 1, {**ZERO, **OFF}, loc={"vm_root": (0, 0, 0)})
    # Wind up: hand back, up and outboard, blade cocked over the shoulder.
    #
    # Every number below is smaller than it wants to be, and that is the point. The
    # first pass swung a 117 cm arc, which is a lovely sweep and puts the blade in the
    # bottom-left corner behind the health bar for a quarter of the clip — the player
    # sees the knife leave and come back, not a cut. `vm_root`'s roll is the worst
    # offender: the hand sits 35 cm off that axis, so every degree of it moves the
    # blade a long way.
    key(rig, 6, {**ZERO, **OFF, "upperarm_l": (58, 0, -22), "vm_root": (-9, 0, 10), "upperarm_r": (11, 0, -7),
                 "forearm_r": (-16, 0, 0)},
        loc={"vm_root": (0.055, -0.050, 0.050)})
    # The cut. Down and across to the left, with a modest reach forward — the edge is
    # travelling the way it points, which is the whole difference between a slash that
    # reads and a fist waved at the screen.
    key(rig, 11, {**ZERO, **OFF, "upperarm_l": (66, 0, -10), "vm_root": (5, 0, -14), "upperarm_r": (-7, 0, 8),
                  "forearm_r": (11, 0, 0)},
        loc={"vm_root": (-0.080, 0.080, -0.045)})
    # Follow-through, short. The blade carries past the target before the arm checks.
    key(rig, 14, {**ZERO, **OFF, "upperarm_l": (68, 0, -8), "vm_root": (7, 0, -18), "upperarm_r": (-9, 0, 10),
                  "forearm_r": (13, 0, 0)},
        loc={"vm_root": (-0.105, 0.055, -0.065)})
    key(rig, 24, {**ZERO, **OFF}, loc={"vm_root": (0, 0, 0)})



def anim_reload_pistol(rig):
    """Pistol reload: magazine out of the grip, fresh one in, then rack the slide.

    Deliberately *not* shaped like the rifle reload. A pistol is a small object held
    close, so the whole sequence happens near the face: the weapon rolls hard inboard
    to bring the magazine well into view, comes back toward the camera rather than
    dipping away, and the support hand finishes by coming over the *top* of the slide
    instead of returning to a handguard the weapon does not have.

    Frame timings here are load-bearing — `WEAPONS.pistol.slideRack` cues the slide's
    own travel off the same normalised progress, so the mechanism moves when the hand
    that works it does.
    """
    new_action(rig, "reload_pistol")
    clear_pose(rig)
    key(rig, 1, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})
    # roll hard inboard and draw the weapon in close
    key(rig, 8, {**ZERO, "vm_root": (-6, 26, 34), "upperarm_r": (-10, 0, 0),
                 "forearm_r": (12, 0, 0),
                 "upperarm_l": (20, 0, -14), "forearm_l": (28, 0, 0)},
        loc={"vm_root": (-0.03, 0.03, -0.05), "hand_l": (0, -0.04, -0.05)})
    # magazine gone; support hand drops out of frame for a fresh one
    key(rig, 16, {**ZERO, "vm_root": (-7, 28, 36), "upperarm_r": (-11, 0, 0),
                  "forearm_r": (13, 0, 0),
                  "upperarm_l": (46, 0, -20), "forearm_l": (54, 0, 0), "hand_l": (-30, 0, 0)},
        loc={"vm_root": (-0.032, 0.032, -0.055), "hand_l": (0, -0.06, -0.16)})
    # fresh magazine driven up into the grip
    key(rig, 27, {**ZERO, "vm_root": (-5, 22, 30), "upperarm_r": (-9, 0, 0),
                  "forearm_r": (10, 0, 0),
                  "upperarm_l": (16, 0, -12), "forearm_l": (24, 0, 0), "hand_l": (-8, 0, 0)},
        loc={"vm_root": (-0.026, 0.026, -0.045), "hand_l": (0, -0.015, -0.02)})
    # Support hand onto the *slide* and hauls it back. These angles are fitted, not
    # eyeballed: the fist has to land on the rear of the slide, which is 11 cm above
    # and 2.5 cm forward of the firing hand. Miming the motion out in front of the
    # weapon — which is what the first version did — reads as a rifle reload with a
    # pistol in shot.
    key(rig, 34, {**ZERO, "vm_root": (-2, 12, 16), "upperarm_r": (-5, 0, 0),
                  "upperarm_l": (-29, 17, 0), "forearm_l": (72, 0, 0), "hand_l": (17, 0, 0)},
        loc={"vm_root": (-0.012, 0.014, -0.022)})
    # slide released, hand lifting off the top
    key(rig, 40, {**ZERO, "vm_root": (-1, 7, 9), "upperarm_l": (-22, 14, -4),
                  "forearm_l": (58, 0, 0), "hand_l": (12, 0, 0)},
        loc={"vm_root": (-0.006, 0.008, -0.012)})
    key(rig, 50, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})


def anim_reload_shell(rig):
    """One shotgun shell into the loading port, then back to the pump.

    Played once per shell, so it has to start and end exactly on the carry pose or a
    six-shell reload visibly stutters between rounds.
    """
    new_action(rig, "reload_shell")
    clear_pose(rig)
    key(rig, 1, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})
    # weapon rolls over to expose the underside port; hand drops to the belt
    key(rig, 6, {**ZERO, "vm_root": (-8, 6, 26), "upperarm_l": (30, 0, -14),
                 "forearm_l": (34, 0, 0), "hand_l": (-20, 0, 0)},
        loc={"vm_root": (0, -0.03, -0.02), "hand_l": (0, -0.06, -0.09)})
    # shell pushed up into the port
    key(rig, 12, {**ZERO, "vm_root": (-9, 7, 28), "upperarm_l": (10, 0, -8),
                  "forearm_l": (16, 0, 0), "hand_l": (-6, 0, 0)},
        loc={"vm_root": (0, -0.032, -0.022), "hand_l": (0, 0.01, -0.015)})
    key(rig, 20, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})


def anim_pump(rig):
    """Working the pump between shots. Support hand strokes back, then forward."""
    new_action(rig, "pump")
    clear_pose(rig)
    key(rig, 1, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})
    key(rig, 5, {**ZERO, "vm_root": (-5, 0, 3), "upperarm_l": (6, 0, -4),
                 "forearm_l": (14, 0, 0)},
        loc={"vm_root": (0, -0.012, 0.004), "hand_l": (0, -0.085, 0)})
    key(rig, 11, {**ZERO, "vm_root": (2, 0, -1), "upperarm_l": (-2, 0, 0),
                  "forearm_l": (-4, 0, 0)},
        loc={"vm_root": (0, 0.004, -0.002), "hand_l": (0, 0.012, 0)})
    key(rig, 16, ZERO, loc={"vm_root": (0, 0, 0), "hand_l": (0, 0, 0)})


CLIPS = [anim_idle, anim_fire, anim_reload, anim_draw, anim_melee,
         anim_reload_pistol, anim_reload_shell, anim_pump]


def main():
    reset()
    parts = build_arms()
    bake_part_weights(parts)
    body = flatten_and_join(parts)
    rig = build_armature()
    attach_to_rig(body, rig)

    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    for clip in CLIPS:
        clip(rig)
    bpy.ops.object.mode_set(mode="OBJECT")
    rig.animation_data.action = None

    log(f"  {len(bpy.data.actions)} clips: {', '.join(a.name for a in bpy.data.actions)}")
    export("fp_arms", animations=True, budget=2600)


main()
