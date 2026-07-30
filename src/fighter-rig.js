import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { surface, fighterUniform } from './materials.js';
import { SUPPORT_GRIP } from './weapons.js';

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
const ADDITIVE = new Set([
  'aim_pose', 'fire', 'reload', 'throw', 'hit_react', 'heal',
  'aim_up', 'aim_down', 'aim_left', 'aim_right', 'lean_l', 'lean_r',
]);
// Full-body one-shots that take over completely.
const DEATHS = ['death_front', 'death_back', 'death_collapse'];
// Clips during which the support hand is somewhere other than the weapon.
//
// Split by how they end. A reload or a throw runs its length and is done, so a timer
// is right. Bandaging is held until the fighter is finished, which can be much longer
// than the clip — timing that one out puts his hand back on the rifle halfway through
// dressing a wound.
const HAND_LEAVES = new Set(['reload', 'throw']);
const HAND_SUSTAINED = new Set(['heal']);

/**
 * The lower-body blendspace, Unreal-style.
 *
 * Each gait has four directional cycles; the runtime weights whichever are adjacent to
 * the actual direction of travel, so a fighter strafing gets a cross-step rather than
 * a forward walk played while sliding sideways. `stride` is the ground distance one
 * full cycle covers, which is what keeps the feet planted: playback is driven by
 * distance travelled, not by a clock.
 */
// The eight poles, in order of increasing angle from straight ahead. Must match
// DIRS in tools/blender/fighter.py — the clip names, the order and the strides are one
// table split across two languages.
const DIRS = ['f', 'fr', 'r', 'br', 'b', 'bl', 'l', 'fl'];
// Unit (rightward, forward) for each pole.
const POLE = DIRS.map((_, i) => [Math.sin(i * Math.PI / 4), Math.cos(i * Math.PI / 4)]);

/**
 * Ground covered per cycle, per pole, in metres. Ordered as DIRS.
 *
 * These are measured, not chosen. `npm run fightercheck` walks the rig in every
 * direction, watches what the planted foot actually gives back, and prints this table;
 * these are its numbers, with mirror pairs averaged so measurement noise does not end
 * up baked in as an asymmetry. They start life as the strides the clips were authored to in
 * tools/blender/fighter.py, but authoring rounds them — resampling to whole frames,
 * linear keys clipping a corner, a leg reaching its limit at the extreme of a stride —
 * so the number that belongs here is what came out, not what went in. Re-run the bench
 * after any change to the gait specs and paste the table it prints.
 */
// `speed` is where a gait takes over, not how fast it plays -- playback comes from the
// stride. Combatants move at about 3 m/s and sprint at 4.4, so the walk/run crossover
// sits low enough that ordinary advancing already reads as a jog.
const GAITS = {
  walk: { prefix: 'walk', strides: [1.34, 1.00, 0.85, 1.00, 1.34, 1.00, 0.85, 1.00], speed: 1.5 },
  run: { prefix: 'run', strides: [2.13, 1.59, 1.40, 1.59, 2.13, 1.59, 1.40, 1.59], speed: 3.6 },
  crouch: { prefix: 'crouch', strides: [0.81, 0.66, 0.59, 0.66, 0.81, 0.66, 0.59, 0.66], speed: 1.4 },
};

// Additive poles sampled by aim pitch and yaw, and by lean.
const AIM_POLES = ['aim_up', 'aim_down', 'aim_left', 'aim_right'];
const LEAN_POLES = ['lean_l', 'lean_r'];
// How far the poles were authored to reach, in radians. Aim beyond this clamps.
const AIM_RANGE = { pitch: 0.42, yaw: 0.50 };
// Fastest the blendspace heading may swing, in radians per second. A full reversal
// takes about a third of a second, which is roughly how long it takes a person.
const MAX_TURN = 10.0;

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
        action.loop = THREE.LoopOnce;
        action.clampWhenFinished = true;
      }
      action.enabled = true;
      this.actions.set(name, action);
    }

    // --- base layer: the locomotion blendspace ---
    //
    // Every cycle in every gait runs at once, at weight zero until it is needed, and
    // none of them keep their own clock: `timeScale = 0` and `update` writes `.time`
    // from one shared phase. That is what makes the blend legal. Two clips crossfaded
    // at independent times will have one foot planting while the other lifts, and the
    // result slides -- the blend is only a blend if the poses agree about where in the
    // stride they are.
    this._loco = [];
    for (const [gait, spec] of Object.entries(GAITS)) {
      const entry = { gait, strides: spec.strides, speed: spec.speed, actions: [] };
      for (const dir of DIRS) {
        const action = this.actions.get(`${spec.prefix}_${dir}`);
        if (!action) continue;
        action.play();
        action.timeScale = 0;
        action.setEffectiveWeight(0);
        entry.actions.push(action);
        entry.duration = action.getClip().duration;
      }
      if (entry.actions.length === DIRS.length) this._loco.push(entry);
    }
    this.idleAction = this.actions.get('idle');
    this.crouchIdleAction = this.actions.get('crouch_idle');
    for (const a of [this.idleAction, this.crouchIdleAction]) {
      if (a) { a.play(); a.setEffectiveWeight(0); }
    }
    if (this.idleAction) this.idleAction.setEffectiveWeight(1);
    this.locomotion = this.idleAction;

    this.phase = 0;
    this._dirW = new Float32Array(8);
    this._speed = 0;
    this._speedK = 0;
    this._moveK = 0;
    this._crouchK = 0;
    this._crouching = false;
    // Direction of travel in the fighter's own frame: x right, z forward. `_want` is
    // what the caller last asked for, `_avg` the smoothed version of it, `_move` the
    // rate-limited heading the blendspace actually runs on.
    this._wantX = 0; this._wantZ = 1;
    this._avgX = 0; this._avgZ = 1;
    this._moveX = 0; this._moveZ = 1;

    // --- additive layer: aim pose, aim offset, lean ---
    this.aimAction = this.actions.get('aim_pose');
    this.aimAction.play();
    this.aimAction.paused = true;
    this.aimAction.time = this.aimAction.getClip().duration;   // hold the shouldered pose
    this.aimAction.setEffectiveWeight(0);
    this.aimWeight = 0;

    // Poles are held at their final frame; only the weight ever changes. Being
    // additive, they sum onto the locomotion pose instead of replacing it, so the
    // legs keep walking while the spine turns to follow a target.
    this._poles = new Map();
    for (const name of [...AIM_POLES, ...LEAN_POLES]) {
      const action = this.actions.get(name);
      if (!action) continue;
      action.play();
      action.paused = true;
      action.time = action.getClip().duration;
      action.setEffectiveWeight(0);
      this._poles.set(name, { action });
    }

    this.weaponSocket = this.bones.get('weapon') || this.bones.get('hand_r');

    // Support arm, solved rather than posed.
    //
    // The stance pose reaches for a rifle-length handguard and that was the whole of
    // it, so every fighter carried his weapon one-handed with his left hand out in
    // front of him holding nothing. A pose cannot do this job: the grip point is a
    // different place on every weapon, and it moves with the aim offset, the walk and
    // the recoil. Declare the point and solve the arm to it — the same thing the
    // first-person arms do, for the same reason.
    this._ikChain = ['forearm_l', 'upperarm_l'].map((n) => this.bones.get(n)).filter(Boolean);
    this._handL = this.bones.get('hand_l');
    this._grip = null;          // Vector3 in weapon space
    this._weapon = null;        // the held weapon's Object3D
    this._ikWarm = null;
    this._preSupport = this._ikChain.map((b) => b.quaternion.clone());
    this._supportK = 0;
    this.supportWeight = 1;
    // Counts down while a clip has the support hand somewhere else entirely.
    this._handBusy = 0;
    this.dead = false;
    this.aimPitch = 0;
    this.aimYaw = 0;
    this._aimPitchTarget = 0;
    this._aimYawTarget = 0;
    this.lean = 0;
    this._leanTarget = 0;

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

  /**
   * Drive the base layer from gameplay state.
   *
   * @param {number} speed     metres per second, actual
   * @param {boolean} crouching
   * @param {number} [moveX]   rightward component of travel, in the fighter's frame
   * @param {number} [moveZ]   forward component of travel, in the fighter's frame
   *
   * `moveX`/`moveZ` need not be normalised -- only the direction is read. Omit them
   * and the fighter is assumed to be moving where he faces, which is what a rig with
   * no strafe information used to do.
   */
  setStance(speed, crouching, moveX = 0, moveZ = 1) {
    if (this.dead) return;
    this._speed = speed;
    this._crouching = crouching;
    const len = Math.hypot(moveX, moveZ);
    if (len > 1e-4) { this._wantX = moveX / len; this._wantZ = moveZ / len; }
  }

  /**
   * Turn the blendspace heading toward where the body is actually going.
   *
   * The caller hands over one frame's displacement, and one frame of a fighter shoved
   * sideways by collision resolution points anywhere at all. Fed straight in, the
   * heading swung more than 60 degrees in a single frame about twice every five
   * seconds, and since the poles either side of the circle lean opposite ways, that
   * read as a fighter snapping between leaning left and leaning right — plus a 32 cm
   * single-frame jump in his head.
   *
   * Two damping stages, because one is not enough. Averaging alone still lets a
   * sustained reversal cut through zero and come out the far side instantly; a rate
   * limit alone still tracks every jitter, just smoothly. Together the heading turns
   * the way a body turns, and a genuine 180 takes about a third of a second.
   */
  _steerHeading(dt) {
    const k = Math.min(1, dt * 9);
    this._avgX += ((this._wantX ?? 0) - this._avgX) * k;
    this._avgZ += ((this._wantZ ?? 1) - this._avgZ) * k;
    if (Math.hypot(this._avgX, this._avgZ) < 1e-3) return;   // mid-reversal, hold

    const want = Math.atan2(this._avgX, this._avgZ);
    const now = Math.atan2(this._moveX, this._moveZ);
    let d = want - now;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = Math.min(Math.abs(d), MAX_TURN * dt) * Math.sign(d);
    const a = now + step;
    this._moveX = Math.sin(a);
    this._moveZ = Math.cos(a);
  }

  /**
   * Resolve the blendspace and write every base-layer weight. Runs before the mixer.
   */
  _updateLocomotion(dt) {
    const speed = this._speed;
    this._steerHeading(dt);
    // Crouch is eased rather than switched: dropping stance mid-stride otherwise pops
    // the hips down a foot in a single frame.
    this._crouchK += ((this._crouching ? 1 : 0) - this._crouchK) * Math.min(1, dt * 10);
    const crouchK = this._crouchK;

    // How much of the body is moving at all.
    //
    // Eased over time, not just shaped by speed. Gameplay speed is not continuous —
    // a fighter who reaches his goal goes from 4.6 m/s to zero in one frame — and
    // reading it directly cut a deep, leaning run pose straight to idle, which threw
    // his head 20 cm in a single frame. Every worst-case pop measured in a live match
    // was this and nothing else.
    const moveTarget = THREE.MathUtils.smoothstep(speed, 0.25, 0.85);
    this._moveK += (moveTarget - this._moveK) * Math.min(1, dt * 7);
    const moveK = this._moveK;
    // The walk/run split is eased for the same reason: decelerating through the
    // crossover should be a transition, not a switch.
    this._speedK += (speed - this._speedK) * Math.min(1, dt * 6);

    // Directional weights: the two poles bracketing the heading, blended by angle.
    // Only ever two, so the pose is an interpolation between neighbours rather than a
    // soup of four, and at a pole it is that clip exactly.
    const dirW = this._dirW;
    dirW.fill(0);
    let a = Math.atan2(this._moveX, this._moveZ) / (Math.PI / 4);
    if (a < 0) a += 8;
    const lo = Math.floor(a) % 8;
    const frac = a - Math.floor(a);
    dirW[lo] = 1 - frac;
    dirW[(lo + 1) % 8] = frac;

    // Gait weights. Walk and run blend against each other on speed; crouch is a
    // separate axis that fades in over both.
    const runK = THREE.MathUtils.clamp(
      (this._speedK - GAITS.walk.speed) / (GAITS.run.speed - GAITS.walk.speed), 0, 1);
    const gaitW = {
      walk: moveK * (1 - crouchK) * (1 - runK),
      run: moveK * (1 - crouchK) * runK,
      crouch: moveK * crouchK,
    };

    // Advance the shared phase by ground distance, not by elapsed time. This is the
    // whole reason the feet stay planted: at any speed, one cycle of clip covers one
    // cycle's worth of ground.
    //
    // The stride is blended exactly the way the poses are, over both axes. It has to
    // be: a cross-step covers less ground than a forward stride, so a single number
    // per gait is right in one direction and sliding in the other three. The values
    // in GAITS are not estimates — `npm run fightercheck` solves for them from the
    // measured motion of the planted foot and prints the table.
    // The strides are summed as *vectors*, not as scalars, and that distinction is the
    // whole diagonal problem. Blending a forward cycle with a rightward one produces a
    // foot that travels the diagonal, and the diagonal of two half-weighted
    // perpendicular strides is 0.71 of either — not the 1.0 a scalar average gives.
    // Averaging the numbers instead of the vectors slid every diagonal by 40%.
    let sx = 0, sz = 0, gaitTotal = 0;
    for (const entry of this._loco) {
      const w = gaitW[entry.gait] || 0;
      if (w <= 1e-4) continue;
      for (let i = 0; i < 8; i++) {
        if (dirW[i] <= 0) continue;
        const k = w * dirW[i] * entry.strides[i];
        sx += k * POLE[i][0];
        sz += k * POLE[i][1];
      }
      gaitTotal += w;
    }
    // Projected onto the actual heading, because only the component along it cancels
    // the body's motion; anything perpendicular is slide the blend cannot avoid.
    const stride = gaitTotal > 1e-4
      ? Math.max(0.2, Math.abs(sx * this._moveX + sz * this._moveZ) / gaitTotal)
      : GAITS.walk.strides[0];
    this.phase = (this.phase + (speed * dt) / stride) % 1;
    if (this.phase < 0) this.phase += 1;

    for (const entry of this._loco) {
      const gw = gaitW[entry.gait] || 0;
      for (let i = 0; i < 8; i++) {
        const action = entry.actions[i];
        action.setEffectiveWeight(gw * dirW[i]);
        if (gw > 1e-4 && dirW[i] > 0) action.time = this.phase * entry.duration;
      }
    }

    const rest = 1 - moveK;
    if (this.idleAction) this.idleAction.setEffectiveWeight(rest * (1 - crouchK));
    if (this.crouchIdleAction) this.crouchIdleAction.setEffectiveWeight(rest * crouchK);
  }

  /** 0 = weapon down, 1 = shouldered and on target. */
  setAimWeight(w) {
    this.aimWeight = THREE.MathUtils.clamp(w, 0, 1);
  }

  /**
   * Where the fighter is looking, relative to where his hips face.
   *
   * This drives the aim offset -- four authored additive poles blended by pitch and
   * yaw -- rather than rotating the spine in code. An authored pose distributes the
   * turn across spine, chest, neck and head the way a body actually does; the
   * procedural version bent one joint and read as a broken neck. Yaw is what lets a
   * fighter track a target beside him without turning his feet.
   *
   * @param {number} pitch radians, positive is up
   * @param {number} yaw   radians, positive is to his left
   */
  setAim(pitch, yaw = 0) {
    this._aimPitchTarget = THREE.MathUtils.clamp(pitch, -0.8, 0.8);
    this._aimYawTarget = THREE.MathUtils.clamp(yaw, -0.9, 0.9);
  }

  /** Back-compat: pitch only. */
  setAimPitch(radians) { this.setAim(radians, this._aimYawTarget); }

  /**
   * Lean out from cover. -1 is hard left, +1 hard right.
   *
   * Rolling the whole object was what this used to be, which pivots the fighter about
   * a point between his feet and lifts one boot clear of the floor. A lean is a spine
   * bend, so it is an authored additive pose like the aim offset.
   */
  setLean(k) { this._leanTarget = THREE.MathUtils.clamp(k, -1, 1); }

  /**
   * Tell the rig which weapon is in the fist, so the support arm knows where to reach.
   * Pass `null` when the hands are empty.
   */
  setWeapon(weaponId, group) {
    const grip = SUPPORT_GRIP[weaponId];
    this._weapon = grip ? group : null;
    this._grip = grip ? new THREE.Vector3(grip[0], grip[1], grip[2]) : null;
    this._ikWarm = null;   // a new weapon is a new reach; do not resume into it
  }

  /**
   * Fire off a one-shot additive clip. Retriggering restarts it.
   *
   * Except for `fire`, which is not restarted until it has had time to read.
   * Resetting an additive impulse puts it back at its zero frame, so an automatic
   * weapon at 700 rpm retriggered it every 5 frames and the recoil never got past
   * nothing — the fighters fired without moving at all. Past the peak, restarting is
   * what makes sustained fire punch.
   */
  trigger(name, weight = 1) {
    if (this.dead) return;
    const action = this.actions.get(name);
    if (!action) return;
    const clip = action.getClip();
    if (name === 'fire' && action.isRunning() && action.time < clip.duration * 0.30) {
      action.setEffectiveWeight(weight);
      return;
    }
    // These take the support hand off the weapon entirely, so the IK has to let go or
    // it drags the hand straight back to the handguard mid-reload.
    if (HAND_LEAVES.has(name)) this._handBusy = clip.duration;
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
    if (!this.dead) {
      const current = this.aimAction.getEffectiveWeight();
      this.aimAction.setEffectiveWeight(current + (this.aimWeight - current) * Math.min(1, dt * 9));

      this._updateLocomotion(dt);

      // Ease towards the requested aim, then split it across the poles. Both poles on
      // an axis are never active at once, so the additive sum stays inside the range
      // the poses were authored for and the spine cannot fold past its limit.
      const k = Math.min(1, dt * 9);
      this.aimPitch += (this._aimPitchTarget - this.aimPitch) * k;
      this.aimYaw += (this._aimYawTarget - this.aimYaw) * k;
      this.lean += (this._leanTarget - this.lean) * Math.min(1, dt * 7);

      const p = THREE.MathUtils.clamp(this.aimPitch / AIM_RANGE.pitch, -1, 1);
      const y = THREE.MathUtils.clamp(this.aimYaw / AIM_RANGE.yaw, -1, 1);
      this._setPole('aim_up', Math.max(0, p));
      this._setPole('aim_down', Math.max(0, -p));
      this._setPole('aim_left', Math.max(0, y));
      this._setPole('aim_right', Math.max(0, -y));
      this._setPole('lean_l', Math.max(0, -this.lean));
      this._setPole('lean_r', Math.max(0, this.lean));
    }

    this.mixer.update(dt);

    if (!this.dead) {
      // Pins first: they are absolute overrides, and the support solve has to run
      // against the pose that will actually be drawn.
      if (this.pinned.size) this._applyPins();
      this._handBusy = Math.max(0, this._handBusy - dt);
      this._solveSupportHand(dt);
    }
  }

  /**
   * Two-bone CCD pulling the left fist onto the weapon's support grip.
   *
   * Runs after the mixer so it composes on top of the animation instead of being
   * overwritten by it, and warm-starts from last frame: the mixer rewrites these bones
   * from the clip every frame, so a solver that cold-starts closes only part of the
   * gap and is reset before it finishes. That failure mode is not obvious — the hand
   * converges perfectly in isolation and still trails by 10 cm forever.
   */
  _solveSupportHand(dt) {
    let busy = this._handBusy > 0;
    if (!busy) {
      for (const name of HAND_SUSTAINED) {
        const action = this.actions.get(name);
        // `isRunning` matters as much as the weight: an action that was never played
        // still reports its default weight of 1, so a weight test alone declares the
        // hand busy from the moment the rig is built.
        if (action && action.isRunning() && action.getEffectiveWeight() > 0.15) { busy = true; break; }
      }
    }
    // A shieldman pins his support arm, which is also how he opts out of the grip.
    const want = this.pinned.has('upperarm_l') || busy ? 0 : this.supportWeight;
    // Ease, so letting go for a reload and taking hold again are movements rather
    // than cuts.
    this._supportK += (want - this._supportK) * Math.min(1, dt * 8);
    if (this._supportK < 0.02 || !this._grip || !this._weapon || !this._handL) {
      this._ikWarm = null;
      return;
    }
    const chain = this._ikChain;
    if (chain.length < 2) return;

    _ikTarget.copy(this._grip);
    this._weapon.updateMatrixWorld(true);
    this._weapon.localToWorld(_ikTarget);

    // Snapshot the clip's own arm before anything touches it. It is what the solved
    // arm blends back towards when the fighter lets go, and it has to be captured
    // before the warm start overwrites the chain.
    for (let i = 0; i < chain.length; i++) this._preSupport[i].copy(chain[i].quaternion);

    if (this._ikWarm) {
      for (let i = 0; i < chain.length; i++) chain[i].quaternion.copy(this._ikWarm[i]);
      chain[chain.length - 1].updateMatrixWorld(true);
    }

    for (let pass = 0; pass < 4; pass++) {
      for (const bone of chain) {
        bone.getWorldPosition(_bonePos);
        _fist.set(0, HAND_LENGTH, 0);
        this._handL.localToWorld(_fist);
        _from.copy(_fist).sub(_bonePos);
        _to.copy(_ikTarget).sub(_bonePos);
        if (_from.lengthSq() < 1e-8 || _to.lengthSq() < 1e-8) continue;
        _q.setFromUnitVectors(_from.normalize(), _to.normalize());
        bone.getWorldQuaternion(_q2);
        bone.parent.getWorldQuaternion(_parentQ);
        bone.quaternion.copy(_parentQ.invert()).multiply(_q).multiply(_q2);
        bone.updateMatrixWorld(true);
      }
    }

    if (!this._ikWarm) this._ikWarm = chain.map((b) => b.quaternion.clone());
    else for (let i = 0; i < chain.length; i++) this._ikWarm[i].copy(chain[i].quaternion);

    // Blend the solved arm back towards the clip's own arm as the weight drops, so a
    // fighter letting go does it over a few frames instead of snapping.
    if (this._supportK < 0.999) {
      for (let i = 0; i < chain.length; i++) {
        chain[i].quaternion.slerp(this._preSupport[i], 1 - this._supportK);
      }
      chain[chain.length - 1].updateMatrixWorld(true);
    }
  }

  _setPole(name, weight) {
    const pole = this._poles.get(name);
    if (pole) pole.action.setEffectiveWeight(weight);
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
const _q2 = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _ikTarget = new THREE.Vector3();
const _bonePos = new THREE.Vector3();
const _fist = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();

// Hand bone head to closed fist, from the bone table in tools/blender/fighter.py.
// The IK aims the *fist*, not the wrist: solving for the wrist leaves the hand
// dangling a hand's length short of what it is supposed to be holding.
const HAND_LENGTH = 0.11;

/**
 * One shared material for every hitbox proxy. It never renders (the meshes are
 * invisible) but three still wants a material object on a Mesh.
 */
const HIDDEN_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });
