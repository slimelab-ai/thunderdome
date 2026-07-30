import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { surface, fighterUniform } from './materials.js';

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
const SUPPORT_ARM_CLIPS = new Set(['reload', 'melee', 'draw']);

/**
 * Where the support hand goes, per weapon, as bone rotations in radians.
 *
 * The rest pose already reaches a rifle-length handguard, so most weapons need
 * nothing. The outliers are the two-handed-grip weapons and the knife: a pistol is
 * held with both hands together at the grip, and a knife has no support hand at all,
 * so that arm swings down out of frame rather than hovering emptily beside the blade.
 */
const SUPPORT_POSE = {
  // Fitted under constraints, not just fitted. A two-handed pistol grip needs the
  // support hand at the firing hand, and one joint cannot get there — lowering the
  // shoulder alone swings the hand forward past the muzzle. But solving for hand
  // *position* alone is not enough either: the first fit reached the target by
  // folding the left arm across the right one, which looked like the fighter had tied
  // himself in a knot. The search now rejects any pose whose left elbow is not
  // clearly left of the right elbow, and prefers small angles among what is left.
  pistol: {
    upperarm_l: [-0.20, 0.50, -0.30],
    forearm_l: [1.50, 0, 0],
    hand_l: [-0.30, 0, 0],
  },
  shotgun: {
    upperarm_l: [-0.06, 0, -0.05],
    forearm_l: [-0.05, 0, 0],
    hand_l: [0, 0, 0],
  },
  dmr: {
    upperarm_l: [-0.10, 0, -0.06],
    forearm_l: [-0.12, 0, 0],
    hand_l: [0, 0, 0],
  },
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
      const { id, group } = this.pendingWeapon;
      this.pendingWeapon = null;
      this.setWeapon(id, group);
    }
  }

  /**
   * Put a weapon in the hands.
   *
   * The caller owns the weapon model (Player caches one per weapon), so this only
   * re-parents it and adjusts the support hand.
   */
  setWeapon(id, group) {
    if (!this.ready) { this.pendingWeapon = { id, group }; return; }
    if (this.heldGroup && this.heldGroup !== group) this.socket.remove(this.heldGroup);
    this.heldGroup = group;
    if (group.parent !== this.socket) this.socket.add(group);

    this.pinned.clear();
    const pose = SUPPORT_POSE[id];
    if (pose) for (const [bone, euler] of Object.entries(pose)) this.pinned.set(bone, euler);

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
    if (this.current && this.current !== action) this.current.stop();
    action.reset();
    action.timeScale = seconds ? action.getClip().duration / seconds : 1;
    action.setEffectiveWeight(1);
    action.play();
    this.current = action;
  }

  /** Recoil impulse, layered over whatever else is running. */
  fire() {
    if (!this.ready) return;
    const action = this.actions.get('fire');
    action.reset();
    action.setEffectiveWeight(1);
    action.play();
  }

  reload(seconds) { this.play('reload', seconds); }
  melee(seconds) { this.play('melee', seconds); }

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
    if (this.pinWeight > 0.002) {
      for (const [name, euler] of this.pinned) {
        const bone = this.bones.get(name);
        if (!bone) continue;
        _e.set(euler[0], euler[1], euler[2]);
        _q.copy(this.restQuat.get(name)).multiply(_q2.setFromEuler(_e));
        bone.quaternion.slerp(_q, this.pinWeight);
      }
    }
  }
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
