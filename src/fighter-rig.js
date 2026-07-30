import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { surface, fighterUniform } from './materials.js';

/**
 * Runtime rig for the authored fighter: a skinned mesh, a two-layer animation state
 * machine, a procedural aim pass, and bone-parented hitbox proxies.
 *
 * Two layers, because a fighter has to do two things at once. The **base** layer is
 * locomotion (idle / walk / run / crouch), crossfaded on a speed-and-stance graph.
 * The **additive** layer carries everything the upper body does over the top — aiming,
 * firing, reloading, throwing, flinching — as deltas from the rest pose, so a
 * reload plays correctly whether the fighter is standing still or sprinting.
 *
 * Hitboxes are invisible boxes parented to bones. The visual mesh is never the
 * collision surface: that separation is what lets the mesh be as detailed as it
 * likes while combat keeps cheap, stable, well-shaped boxes to raycast against, and
 * it means a fighter's hitboxes follow his animation for free.
 */

const MODEL_URL = '/assets/models/fighter.glb';

// Clips that layer over locomotion. Converted to additive on load.
const ADDITIVE = new Set(['aim_pose', 'fire', 'reload', 'throw', 'hit_react', 'heal']);
// Full-body one-shots that take over completely.
const DEATHS = ['death_front', 'death_back', 'death_collapse'];

/**
 * How fast each locomotion clip's stride carries the body at timeScale 1, in m/s.
 * The rig scales playback by actual speed over this, which is what stops feet
 * sliding — the single most obvious tell of an unpolished character.
 */
const CLIP_SPEED = {
  walk: 1.05,
  run: 2.40,
  crouch_walk: 0.85,
};

const BONE_LENGTH = {
  head: 0.22, chest: 0.16, spine: 0.18, hips: 0.14,
  upperarm_l: 0.26, forearm_l: 0.23, upperarm_r: 0.26, forearm_r: 0.23,
  thigh_l: 0.42, shin_l: 0.43, thigh_r: 0.42, shin_r: 0.43,
};

/**
 * Hitbox layout: [bone, part, width, depth, lengthScale, lengthOffset].
 *
 * Boxes run along the bone's local Y (glTF armature nodes keep Blender's
 * bone-Y-along-the-bone convention). `lengthScale` and `lengthOffset` are fractions
 * of the bone's length, so the boxes stay right if a bone is retuned.
 *
 * Two boxes share the `torso` part name so chest and abdomen are both torso hits;
 * `part` is what the damage model reads, not the mesh identity.
 */
const HITBOXES = [
  ['head', 'head', 0.25, 0.25, 1.05, 0.5],
  ['chest', 'torso', 0.40, 0.28, 1.35, 0.45],
  ['spine', 'torso', 0.34, 0.25, 1.15, 0.45],
  ['upperarm_l', 'armL', 0.17, 0.17, 1.1, 0.5],
  ['forearm_l', 'armL', 0.15, 0.15, 1.25, 0.5],
  ['upperarm_r', 'armR', 0.17, 0.17, 1.1, 0.5],
  ['forearm_r', 'armR', 0.15, 0.15, 1.25, 0.5],
  ['thigh_l', 'legL', 0.20, 0.20, 1.05, 0.5],
  ['shin_l', 'legL', 0.17, 0.17, 1.1, 0.5],
  ['thigh_r', 'legR', 0.20, 0.20, 1.05, 0.5],
  ['shin_r', 'legR', 0.17, 0.17, 1.1, 0.5],
];

let loadPromise = null;
let asset = null;

/** Kick off the fighter load. Safe to call repeatedly; the request happens once. */
export function preloadFighter() {
  if (!loadPromise) {
    loadPromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      const clips = new Map();
      for (const clip of gltf.animations) {
        if (ADDITIVE.has(clip.name)) {
          // Subtracts the clip's own first frame, turning the pose into a delta that
          // can be added on top of whatever the legs are doing.
          THREE.AnimationUtils.makeClipAdditive(clip);
        }
        clips.set(clip.name, clip);
      }
      asset = { scene: gltf.scene, clips };
      return asset;
    }).catch((err) => {
      console.error('[fighter-rig] could not load the fighter model', err);
      return null;
    });
  }
  return loadPromise;
}

export function fighterReady() { return asset !== null; }

export class FighterRig {
  /**
   * @param {object} opts
   * @param {number} opts.uniformColor squad colour for the fatigues
   * @param {number} opts.scale        height multiplier (natural size variety)
   * @param {boolean} opts.debugHitboxes render the collision proxies
   */
  constructor({ uniformColor = 0x2b2d26, scale = 1, debugHitboxes = false } = {}) {
    if (!asset) throw new Error('FighterRig created before the model finished loading');

    this.group = new THREE.Group();
    this.root = cloneSkinned(asset.scene);
    this.root.scale.setScalar(scale);
    this.group.add(this.root);
    this.scale = scale;

    this.bones = new Map();
    this.skinned = [];
    this.root.traverse((o) => {
      if (o.isBone) this.bones.set(o.name, o);
      if (o.isSkinnedMesh) {
        o.frustumCulled = false;   // a skinned bounding box is stale once animated
        o.castShadow = true;
        o.receiveShadow = true;
        this.skinned.push(o);
      }
    });

    // Bind materials: shared body atlas, per-squad uniform.
    const body = surface('TD_fighter_body');
    const uniform = fighterUniform(uniformColor);
    for (const mesh of this.skinned) {
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => (/uniform/i.test(m.name) ? uniform : body))
        : body;
    }

    // Snapshot the bind pose before the mixer ever runs. `pinBone` needs a rest
    // rotation to build absolute poses from, and after the first mixer update the
    // bones' local quaternions are animation output, not rest.
    this.restQuat = new Map();
    for (const [name, bone] of this.bones) this.restQuat.set(name, bone.quaternion.clone());
    this.pinned = new Map();

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = new Map();
    for (const [name, clip] of asset.clips) {
      const action = this.mixer.clipAction(clip);
      if (ADDITIVE.has(name)) {
        action.blendMode = THREE.AdditiveAnimationBlendMode;
        action.loop = name === 'aim_pose' ? THREE.LoopOnce : THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      action.enabled = true;
      this.actions.set(name, action);
    }

    // base locomotion layer
    this.locomotion = null;
    this._playLocomotion('idle', 0);

    // additive aim, held at weight
    this.aimAction = this.actions.get('aim_pose');
    this.aimAction.play();
    this.aimAction.paused = true;
    this.aimAction.time = this.aimAction.getClip().duration;   // hold the shouldered pose
    this.aimAction.setEffectiveWeight(0);
    this.aimWeight = 0;

    this.weaponSocket = this.bones.get('weapon') || this.bones.get('hand_r');
    this.dead = false;
    this.aimPitch = 0;
    this._aimPitchTarget = 0;
    // Bones the procedural aim writes to, and the un-aimed rotation each had last
    // frame. See `update` for why keeping this is not optional.
    this._aimBones = ['chest', 'head'].map((n) => this.bones.get(n)).filter(Boolean);
    this._preAim = this._aimBones.map((b) => b.quaternion.clone());

    this.hitboxes = this._buildHitboxes(debugHitboxes);
  }

  _buildHitboxes(debug) {
    const mat = debug
      ? new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true })
      : null;
    const out = [];
    for (const [boneName, part, w, d, lenScale, lenOffset] of HITBOXES) {
      const bone = this.bones.get(boneName);
      if (!bone) continue;
      const len = (BONE_LENGTH[boneName] ?? 0.2) * lenScale;
      const geo = new THREE.BoxGeometry(w, len, d);
      const mesh = new THREE.Mesh(geo, mat || HIDDEN_MATERIAL);
      mesh.position.y = (BONE_LENGTH[boneName] ?? 0.2) * lenOffset;
      // Invisible, but three's raycaster ignores `visible`, so combat still hits it
      // and it costs nothing to draw.
      mesh.visible = !!debug;
      mesh.userData = { part };
      bone.add(mesh);
      out.push(mesh);
    }
    return out;
  }

  /** Tag every hitbox with its owner so combat can resolve a hit back to a fighter. */
  bindOwner(combatant) {
    for (const m of this.hitboxes) m.userData.combatant = combatant;
  }

  _playLocomotion(name, fade = 0.2, timeScale = 1) {
    const next = this.actions.get(name);
    if (!next) return;
    next.timeScale = timeScale;
    if (this.locomotion === next) return;
    next.reset().setEffectiveWeight(1).play();
    if (this.locomotion) this.locomotion.crossFadeTo(next, fade, true);
    this.locomotion = next;
  }

  /**
   * Drive the base layer from gameplay state.
   * @param {number} speed    metres per second, actual
   * @param {boolean} crouching
   */
  setStance(speed, crouching) {
    if (this.dead) return;
    const moving = speed > 0.35;
    let name;
    if (crouching) name = moving ? 'crouch_walk' : 'crouch_idle';
    else if (!moving) name = 'idle';
    else name = speed > 3.4 ? 'run' : 'walk';

    // Match playback to real speed so the feet stay planted. Clamped: a heavily
    // leg-wounded fighter limping at 1 m/s should look slow, not frozen.
    const ref = CLIP_SPEED[name];
    const timeScale = ref ? THREE.MathUtils.clamp(speed / ref, 0.45, 1.9) : 1;
    if (this.locomotion === this.actions.get(name)) {
      this.locomotion.timeScale = timeScale;
    } else {
      this._playLocomotion(name, 0.18, timeScale);
    }
  }

  /** 0 = weapon down, 1 = shouldered and on target. */
  setAimWeight(w) {
    this.aimWeight = THREE.MathUtils.clamp(w, 0, 1);
  }

  /**
   * Where the fighter is looking, as a pitch in radians. Applied procedurally after
   * the mixer runs, split across chest and head, so a fighter shooting up at a
   * gantry actually leans back and looks up.
   */
  setAimPitch(radians) {
    this._aimPitchTarget = THREE.MathUtils.clamp(radians, -0.6, 0.6);
  }

  /** Fire off a one-shot additive clip. Retriggering restarts it. */
  trigger(name, weight = 1) {
    if (this.dead) return;
    const action = this.actions.get(name);
    if (!action) return;
    action.reset();
    action.setEffectiveWeight(weight);
    action.paused = false;
    action.play();
  }

  /** Stop a sustained additive clip such as `heal`. */
  stop(name, fade = 0.2) {
    const action = this.actions.get(name);
    if (action) action.fadeOut(fade);
  }

  /**
   * Collapse. `hitDirection` is the dot of the shot direction with the fighter's
   * facing: positive means shot from the front.
   */
  die(hitDirection = 1, headshot = false) {
    if (this.dead) return;
    this.dead = true;
    const name = headshot ? 'death_collapse' : (hitDirection > 0 ? 'death_front' : 'death_back');
    for (const [n, action] of this.actions) {
      if (n === name) continue;
      action.fadeOut(0.12);
    }
    const death = this.actions.get(name) || this.actions.get(DEATHS[0]);
    death.reset();
    death.blendMode = THREE.NormalAnimationBlendMode;
    death.loop = THREE.LoopOnce;
    death.clampWhenFinished = true;
    death.setEffectiveWeight(1);
    death.timeScale = 1;
    death.play();
    this.locomotion = death;
    return name;
  }

  update(dt) {
    // Weights are set every frame rather than on transition: aim comes and goes
    // continuously as targets appear, and easing it here keeps the shoulder-up smooth
    // without a state machine for it.
    const current = this.aimAction.getEffectiveWeight();
    this.aimAction.setEffectiveWeight(current + (this.aimWeight - current) * Math.min(1, dt * 9));

    // Undo last frame's procedural aim before the mixer runs.
    //
    // The aim pass *multiplies* a pitch onto the chest and head. That is only safe if
    // the mixer overwrites those bones every frame — and it does not: a clip with no
    // channel for a bone leaves it untouched, so the offset compounds, and a fighter's
    // head rotates a little further every frame until it has spun all the way round.
    // Restoring the pre-aim rotation first makes the pass idempotent. When the mixer
    // does write the bone, this restore is simply overwritten and costs nothing.
    for (let i = 0; i < this._aimBones.length; i++) {
      this._aimBones[i].quaternion.copy(this._preAim[i]);
    }

    this.mixer.update(dt);

    for (let i = 0; i < this._aimBones.length; i++) {
      this._preAim[i].copy(this._aimBones[i].quaternion);
    }

    // Procedural aim, after the mixer so it composes on top of the animation rather
    // than being overwritten by it.
    if (!this.dead) {
      this.aimPitch += (this._aimPitchTarget - this.aimPitch) * Math.min(1, dt * 8);
      if (Math.abs(this.aimPitch) > 1e-4) {
        this._pitchBone('chest', this.aimPitch * 0.55);
        this._pitchBone('head', this.aimPitch * 0.45);
      }
      // Pins last: they are absolute, so anything above them is deliberately ignored.
      if (this.pinned.size) this._applyPins();
    }
  }

  _pitchBone(name, radians) {
    const bone = this.bones.get(name);
    if (!bone) return;
    _q.setFromAxisAngle(_X, radians);
    bone.quaternion.multiply(_q);
  }

  /**
   * Hold a bone at a fixed pose, overriding whatever the clips say.
   *
   * Multiplying onto the animated rotation (the way the aim pitch does) is not enough
   * when the point is to stop the bone moving: the underlying swing still comes
   * through. This replaces the rotation outright, relative to the bind pose. Used for
   * the shieldman's support arm, which has to stay locked behind the shield instead of
   * swinging through the walk cycle.
   *
   * Pass `null` to release.
   */
  pinBone(name, euler) {
    if (!this.bones.has(name)) return;
    if (!euler) { this.pinned.delete(name); return; }
    this.pinned.set(name, new THREE.Euler(euler[0], euler[1], euler[2]));
  }

  _applyPins() {
    for (const [name, euler] of this.pinned) {
      const bone = this.bones.get(name);
      bone.quaternion.copy(this.restQuat.get(name)).multiply(_q.setFromEuler(euler));
    }
  }

  /** Fade the whole fighter out (corpse cleanup). */
  setOpacity(op) {
    for (const mesh of this.skinned) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        // Materials are shared between fighters, so fading has to happen on a private
        // copy or every corpse takes the whole cast with it.
        if (!m.userData.__perInstance) continue;
        m.transparent = op < 1;
        m.opacity = op;
      }
    }
  }

  /**
   * Give this fighter private material copies. Only done when something needs to
   * mutate them (the corpse fade), because it costs the shared-material win.
   */
  privatizeMaterials() {
    for (const mesh of this.skinned) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const copies = mats.map((m) => {
        const c = m.clone();
        c.userData.__perInstance = true;
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? copies : copies[0];
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}

const _q = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);

/**
 * One shared material for every hitbox proxy. It never renders (the meshes are
 * invisible) but three still wants a material object on a Mesh.
 */
const HIDDEN_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });
