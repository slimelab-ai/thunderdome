import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { surface, fighterUniform } from './materials.js';
import { GRIP_ANCHOR, SUPPORT_GRIP } from './weapons.js';

/**
 * First-person arms.
 *
 * The arms asset carries a weapon socket at its own origin with identity
 * orientation, so a weapon parented to it lands exactly where the bare weapon used to
 * sit under `vmRoot`. Everything in `Player` that positions the viewmodel — the
 * hip/ADS lerp, the recoil kick, the walk sway — keeps working unchanged; the arms
 * simply wrap around it.
 *
 * Clips split the way they do on the fighter, and for the same reason. `fire` is
 * additive, so a recoil impulse layers over whatever else is playing. `reload`,
 * `draw` and `melee` are full-body for the arms: the support hand leaves the weapon
 * entirely, which no additive layer can express without fighting the idle sway.
 */

const MODEL_URL = '/assets/models/fp_arms.glb';
const ADDITIVE = new Set(['fire']);
// Clips that move the support arm, and therefore need the grip pins to let go.
// Clips that move the support arm off the weapon, and therefore need the grip pins to
// let go. `draw` is deliberately *not* one of them: releasing the pins during the draw
// left the support hand at its rest position — the rifle handguard — which on a pistol
// is out past the muzzle, so equipping a pistol looked like grabbing the barrel.
const SUPPORT_ARM_CLIPS = new Set(['reload', 'reload_pistol', 'reload_shell', 'melee']);

// Where the right hand actually closes, in the arms' own space (the hand_r bone tail
// from tools/blender/viewmodel.py). Weapons are offset so their grip lands here.
const FIST = [0.012, -0.050, 0.075];

/** Which reload clip a weapon uses. Anything unlisted gets the magazine-swap one. */
const RELOAD_CLIP = { pistol: 'reload_pistol', shotgun: 'reload_shell' };

/**
 * Where the support hand belongs, per weapon and per phase, in the weapon's own
 * model space. The arm is then solved to reach it.
 *
 * This replaced a growing pile of hand-authored angles. Every support-hand pose that
 * was posed by hand in Blender missed its mark — the magazine hand grabbed at air
 * beside the well, the shell hand came at the loading port from above, the pump hand
 * did not move with the pump — while the two that were numerically fitted against a
 * real target landed. Rather than fit each remaining case by hand, the hand now
 * *aims* at a point on the weapon, so it is right by construction and stays right
 * when the weapon geometry changes.
 *
 * `carry` is where the hand rides normally. `pump`/`mag`/`port`/`rack` are the phase
 * targets. A missing phase falls back to `carry`.
 */
// `carry` comes from the shared SUPPORT_GRIP table in weapons.js — the third-person
// fighter holds the same weapon and needs the same point on it. Everything else here
// is reload choreography, which only the first-person arms perform.
const SUPPORT_TARGET = {
  pistol: {
    mag: [0.012, -0.130, 0.060],     // magazine well, below the grip
    rack: [0, 0.055, 0.040],         // over the top of the slide, at its rear
  },
  smg: { mag: [0, -0.070, -0.055] },
  rifle: { mag: [0, -0.078, -0.02] },
  dmr: { mag: [0, -0.075, -0.01] },
  shotgun: { port: [0, -0.012, -0.02] },   // loading port, under the receiver
};
for (const [id, grip] of Object.entries(SUPPORT_GRIP)) {
  if (SUPPORT_TARGET[id]) SUPPORT_TARGET[id].carry = grip;
}

/** Phase windows within a reload clip, as fractions of its duration. */
const RELOAD_PHASES = {
  reload_pistol: [
    { until: 0.30, target: 'mag' },   // hand to the magazine well
    { until: 0.42, target: 'away' },  // out of frame for a fresh magazine
    { until: 0.60, target: 'mag' },   // seat it
    { until: 0.90, target: 'rack' },  // over the top, work the slide
  ],
  reload_shell: [
    { until: 0.32, target: 'away' },  // down to the belt for a shell
    { until: 0.62, target: 'port' },  // up into the loading port
  ],
  reload: [
    { until: 0.30, target: 'mag' },
    { until: 0.46, target: 'away' },
    { until: 0.66, target: 'mag' },
  ],
};

// Where "away" is: down and back, out of the bottom of the frame.
const AWAY_OFFSET = [0.02, -0.34, 0.16];

/**
 * Where the support hand goes, per weapon, as bone rotations in radians.
 *
 * The rest pose already reaches a rifle-length handguard, so most weapons need
 * nothing. The outliers are the two-handed-grip weapons and the knife: a pistol is
 * held with both hands together at the grip, and a knife has no support hand at all,
 * so that arm swings down out of frame rather than hovering emptily beside the blade.
 */
const SUPPORT_POSE = {
  // Fitted against the *fists*, under a no-crossing constraint.
  //
  // Two earlier attempts at this were wrong in instructive ways. The first solved for
  // hand position with no constraint at all and reached the target by folding the left
  // arm across the right one. The second added an elbow check — but compared bone
  // *positions*, which for a hand bone is the wrist, not where the hand closes. That
  // pose scored 3.5 cm of "hand gap" while the fists were actually 20 cm apart and the
  // forearms still swept across each other.
  //
  // The fit that produced these numbers measures the fist (the hand bone's tail),
  // samples both forearms along their length to reject any overlap, and requires the
  // left wrist to stay 10 cm clear to the left. Result: fists 1 cm apart, forearms
  // 10 cm clear. `tools/poses/armsrig.js` reports all three from outside the
  // viewmodel, which is the only place the arm paths are actually legible.
  pistol: {
    upperarm_l: [-0.75, 0.35, -0.20],
    forearm_l: [1.80, 0, 0],
    hand_l: [-0.30, 0, 0],
  },
  shotgun: {
    upperarm_l: [-0.06, 0, -0.05],
    forearm_l: [-0.05, 0, 0],
    hand_l: [0, 0, 0],
  },
  // No entry for the DMR or the rifle on purpose. Both have long handguards that the
  // rest pose already reaches — a fit over the support arm's whole range could not
  // beat leaving it alone, and the hand-authored DMR offset that used to be here put
  // the fist 15 cm off the handguard where the rest pose puts it 8 cm.
  knife: {
    upperarm_l: [1.15, 0, -0.30],
    forearm_l: [0.55, 0, 0],
    hand_l: [0, 0, 0],
  },
};

let loadPromise = null;
let asset = null;

export function preloadViewmodel() {
  if (!loadPromise) {
    loadPromise = new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      const clips = new Map();
      for (const clip of gltf.animations) {
        if (ADDITIVE.has(clip.name)) THREE.AnimationUtils.makeClipAdditive(clip);
        clips.set(clip.name, clip);
      }
      asset = { scene: gltf.scene, clips };
      return asset;
    }).catch((err) => {
      console.error('[viewmodel] could not load the first-person arms', err);
      return null;
    });
  }
  return loadPromise;
}

export function viewmodelReady() { return asset !== null; }

export class ViewModel {
  /** @param {THREE.Object3D} vmRoot the player's existing viewmodel transform */
  constructor(vmRoot, { uniformColor = 0x2b2d26 } = {}) {
    this.vmRoot = vmRoot;
    this.ready = false;
    this.pendingWeapon = null;
    this.uniformColor = uniformColor;
    preloadViewmodel().then(() => this._build());
  }

  _build() {
    if (!asset || this.ready) return;
    this.root = cloneSkinned(asset.scene);
    this.vmRoot.add(this.root);

    this.bones = new Map();
    this.root.traverse((o) => {
      if (o.isBone) this.bones.set(o.name, o);
      if (o.isSkinnedMesh) {
        o.frustumCulled = false;
        // The arms live in view space, a few centimetres from the near plane. Casting
        // or receiving world shadows from there produces nothing but artefacts.
        o.castShadow = false;
        o.receiveShadow = false;
        const body = surface('TD_fighter_body');
        const uniform = fighterUniform(this.uniformColor);
        o.material = Array.isArray(o.material)
          ? o.material.map((m) => (/uniform/i.test(m.name) ? uniform : body))
          : body;
      }
    });

    this.socket = this.bones.get('weapon');
    // Solved from the elbow up, so the shoulder gets the last word on reach.
    this._ikChain = [this.bones.get('forearm_l'), this.bones.get('upperarm_l')].filter(Boolean);
    this.restQuat = new Map();
    for (const [name, bone] of this.bones) this.restQuat.set(name, bone.quaternion.clone());
    this.pinned = new Map();

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = new Map();
    for (const [name, clip] of asset.clips) {
      const action = this.mixer.clipAction(clip);
      if (ADDITIVE.has(name)) {
        action.blendMode = THREE.AdditiveAnimationBlendMode;
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      } else if (name !== 'idle') {
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
    }
    this.idle = this.actions.get('idle');
    this.idle.play();
    this.current = null;         // the full-body clip currently overriding idle
    this.idleWeight = 1;
    this.pinWeight = 1;
    // Weights are driven every frame rather than crossfaded. Two normal-blend actions
    // touching the same bones at weight 1 blend 50/50, so an override clip has to
    // take idle's weight down as it comes up, not simply play on top of it.
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === this.current) this.current = null;
    });
    this.ready = true;

    if (this.pendingWeapon) {
      const { id, group, parts } = this.pendingWeapon;
      this.pendingWeapon = null;
      this.setWeapon(id, group, parts);
    }
  }

  /**
   * Put a weapon in the hands.
   *
   * The caller owns the weapon model (Player caches one per weapon), so this only
   * re-parents it and adjusts the support hand.
   */
  setWeapon(id, group, parts = null) {
    if (!this.ready) { this.pendingWeapon = { id, group, parts }; return; }
    if (this.heldGroup && this.heldGroup !== group) this.socket.remove(this.heldGroup);
    this.heldGroup = group;
    this.weaponId = id;
    this.parts = parts;
    if (group.parent !== this.socket) this.socket.add(group);

    // Offset the weapon so its grip meets the fist. Without this every weapon is held
    // by whatever part of it happens to sit at its origin — for the pistol, 5 cm of
    // empty air behind the grip.
    const anchor = GRIP_ANCHOR[id];
    if (anchor) {
      group.position.set(FIST[0] - anchor[0], FIST[1] - anchor[1], FIST[2] - anchor[2]);
    } else {
      group.position.set(0, 0, 0);
    }

    this.pinned.clear();
    const pose = SUPPORT_POSE[id];
    if (pose) for (const [bone, euler] of Object.entries(pose)) this.pinned.set(bone, euler);

    this.reloadClip = RELOAD_CLIP[id] || 'reload';
    this._ikWarm = null;      // a new weapon means a new grip; do not resume the old one
    this._smoothedLocal = null;   // nor smooth from the old weapon's grip point
    this.play('draw', 1);
  }

  /**
   * Play a full-body arm clip, optionally stretched to a duration.
   *
   * Reload times vary per weapon (1.25 s to 2.4 s); the clip is authored once and
   * time-scaled to fit, so the mag seats when the weapon says it does.
   */
  play(name, seconds = null) {
    if (!this.ready) return;
    const action = this.actions.get(name);
    if (!action) return;
    const prev = this.current;
    action.reset();
    action.timeScale = seconds ? action.getClip().duration / seconds : 1;
    action.setEffectiveWeight(1);
    action.play();
    // Blend, do not cut. Stopping the old clip and starting the new one on the same
    // frame teleports the weapon from one pose to the other — 5 cm at the shotgun's
    // muzzle when a shell reload begins, which is a visible flick. Two frames of
    // crossfade is short enough that no action feels soft and long enough that none
    // of them pop.
    if (prev && prev !== action) prev.crossFadeTo(action, PLAY_FADE, true);
    this.current = action;
  }

  /**
   * Recoil impulse, layered over whatever else is running.
   *
   * Restarting mid-deflection is a discontinuity: the clip snaps from 7 degrees of
   * kick back to zero, which on a rifle throws the muzzle 8 cm in a single frame. An
   * automatic weapon retriggers faster than the clip runs, so the restart is only
   * taken once the pose has come back down; before that the shot rides the existing
   * deflection, which is what sustained fire looks like anyway.
   */
  fire() {
    if (!this.ready) return;
    const action = this.actions.get('fire');
    const clip = action.getClip();
    const settled = !action.isRunning() || action.time > clip.duration * 0.45;
    if (settled) action.reset();
    action.setEffectiveWeight(1);
    action.play();
  }

  /** Reload, using whichever clip this weapon's action calls for. */
  reload(seconds) { this.play(this.reloadClip || 'reload', seconds); }
  melee(seconds) { this.play('melee', seconds); }
  /** One shell into the tube; called once per round on a shell-loaded weapon. */
  loadShell(seconds) { this.play('reload_shell', seconds); }
  /** Work the pump between shots. */
  pump(seconds) { this.play('pump', seconds); }

  /** Blend a set of bone rotations in, `weight` 0..1, relative to the bind pose. */
  _applyPose(pose, weight) {
    const entries = pose instanceof Map ? pose : Object.entries(pose);
    for (const [name, euler] of entries) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      _e.set(euler[0], euler[1], euler[2]);
      _q.copy(this.restQuat.get(name)).multiply(_q2.setFromEuler(_e));
      bone.quaternion.slerp(_q, weight);
    }
  }

  /**
   * Which point on the weapon the support hand should be on this frame.
   *
   * Returns a world position, or null to leave the animation alone.
   */
  _supportTarget() {
    const targets = SUPPORT_TARGET[this.weaponId];
    if (!targets || !this.heldGroup) return null;

    let key = 'carry';
    const clipName = this.current?.getClip().name;
    const phases = clipName && RELOAD_PHASES[clipName];
    if (phases) {
      const clip = this.current.getClip();
      const t = clip.duration > 0 ? this.current.time / clip.duration : 0;
      for (const phase of phases) {
        if (t <= phase.until) { key = phase.target; break; }
      }
    }

    const local = targets[key] || targets.carry;
    _ikTarget.fromArray(local);

    if (key === 'away') {
      // Off the weapon entirely: down and back, out of the bottom of the frame, so it
      // reads as "gone to the pouch" rather than hovering beside the gun.
      _ikTarget.fromArray(targets.carry);
      _ikTarget.x += AWAY_OFFSET[0];
      _ikTarget.y += AWAY_OFFSET[1];
      _ikTarget.z += AWAY_OFFSET[2];
    } else if (key === 'carry' && this.weaponId === 'shotgun' && this.parts?.pump) {
      // Targets on a moving part track that part, so the hand travels *with* the
      // mechanism rather than watching it slide out from under itself.
      _ikTarget.z = this.parts.pump.position.z + PUMP_GRIP_Z;
    } else if (key === 'rack' && this.parts?.slide) {
      _ikTarget.z = local[2] + (this.parts.slide.position.z - this.parts.slide.userData.restZ);
    }

    // Smoothing happens in the *weapon's* space, not the world's.
    //
    // Smoothing a world-space target makes the hand lag the whole viewmodel: walking,
    // sway and camera motion move the target every frame, the filter trails it, and
    // the hand visibly drags behind the gun it is holding. In weapon space the target
    // is near-constant and only a phase change moves it — which is the only thing that
    // wanted smoothing in the first place.
    if (!this._smoothedLocal) this._smoothedLocal = _ikTarget.clone();
    else if (this._smoothedLocal.distanceToSquared(_ikTarget) > 0.36) this._smoothedLocal.copy(_ikTarget);
    else this._smoothedLocal.lerp(_ikTarget, Math.min(1, (this._smoothDt || 0.016) * 6));
    _ikTarget.copy(this._smoothedLocal);

    return this.heldGroup.localToWorld(_ikTarget);
  }

  /**
   * Two-bone CCD onto the support target.
   *
   * Cyclic coordinate descent rather than an analytic solve: it needs no special
   * cases for unreachable targets (it simply stretches toward them), it starts from
   * whatever the animation is already doing so the elbow keeps a natural bearing, and
   * a handful of iterations converges a two-bone chain even when a phase change jumps
   * the target across the weapon in a single frame.
   */
  _solveSupportHand() {
    const target = this._supportTarget();
    if (!target) return;
    const chain = this._ikChain;
    const hand = this.bones.get('hand_l');
    if (!chain || !hand) return;

    // Warm start from last frame's solution.
    //
    // The mixer rewrites these bones from the clip every frame, so without this the
    // solver cold-starts from the animation pose each time and only closes part of
    // the gap — the hand trailed the magazine well by 11 cm forever, converging and
    // being reset in the same breath. Resuming from where it got to last frame makes
    // convergence cumulative, and the support arm is IK-owned anyway.
    if (this._ikWarm) {
      for (let i = 0; i < chain.length; i++) chain[i].quaternion.copy(this._ikWarm[i]);
      chain[chain.length - 1].updateMatrixWorld(true);
    }

    for (let pass = 0; pass < 6; pass++) {
      for (const bone of chain) {
        bone.getWorldPosition(_bonePos);
        _fist.set(0, HAND_LENGTH, 0);
        hand.localToWorld(_fist);

        _from.copy(_fist).sub(_bonePos);
        _to.copy(target).sub(_bonePos);
        if (_from.lengthSq() < 1e-8 || _to.lengthSq() < 1e-8) continue;
        _from.normalize();
        _to.normalize();

        _q.setFromUnitVectors(_from, _to);
        bone.getWorldQuaternion(_q2);
        bone.parent.getWorldQuaternion(_parentQ);
        // newLocal = parentWorld⁻¹ · delta · boneWorld
        bone.quaternion.copy(_parentQ.invert()).multiply(_q).multiply(_q2);
        bone.updateMatrixWorld(true);
      }
    }

    if (!this._ikWarm) this._ikWarm = chain.map((b) => b.quaternion.clone());
    else for (let i = 0; i < chain.length; i++) this._ikWarm[i].copy(chain[i].quaternion);
  }

  update(dt) {
    if (!this.ready) return;

    // Idle yields to whatever full-body clip is running.
    const wantIdle = this.current ? 0 : 1;
    this.idleWeight += (wantIdle - this.idleWeight) * Math.min(1, dt * 12);
    this.idle.setEffectiveWeight(this.idleWeight);

    this.mixer.update(dt);

    // Support-hand pins hold the grip against the idle sway — but they must *release*
    // for any clip that moves the support arm, or a reload would play with the left
    // arm frozen on a handguard it is supposed to have let go of.
    const releasing = this.current && SUPPORT_ARM_CLIPS.has(this.current.getClip().name);
    this.pinWeight += ((releasing ? 0 : 1) - this.pinWeight) * Math.min(1, dt * 10);
    if (this.pinWeight > 0.002) this._applyPose(this.pinned, this.pinWeight);

    // Aim the support hand at whatever it should be holding right now.
    this._smoothDt = dt;
    this._solveSupportHand();
  }
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _ikTarget = new THREE.Vector3();
const _bonePos = new THREE.Vector3();
const _fist = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

// Distance from the hand bone to the closed fist, from tools/blender/viewmodel.py.
const HAND_LENGTH = 0.123;

// Seconds of crossfade between viewmodel actions.
const PLAY_FADE = 0.035;
// Where along the pump the hand grips, relative to the pump part's own origin.
const PUMP_GRIP_Z = 0;
