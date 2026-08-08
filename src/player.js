import * as THREE from 'three';
import {
  WEAPONS, buildViewmodel, animateWeaponParts, solveSightAlignment, adsRelief, planReload,
  cycleTime, rackTime, magDropAt, MAG_OUT_AT, MAG_IN_AT,
} from './weapons.js';
import { Recoil, RecoilPattern } from './recoil.js';
import { ViewModel } from './viewmodel.js';
import { fireRay, applySpread, resolveCircle, wallHit, STEP_REACH, STAND_LIMIT } from './combat.js';
import { ITEM_TYPES, countInPack, useFromPack, ammoInPack, consumeAmmo, makeCharacter } from './items.js';
import { audio } from './audio.js';

// Scratch vectors for shell ejection, hoisted out of the fire path.
const _hipPos = new THREE.Vector3();
const _hipQuat = new THREE.Quaternion();
const _adsPos = new THREE.Vector3();
const _adsQuat = new THREE.Quaternion();
const _kickQuat = new THREE.Quaternion();
const _kickEuler = new THREE.Euler();
const _sRear = new THREE.Vector3();
const _sFront = new THREE.Vector3();
const _sUp = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();
const _casingRight = new THREE.Vector3();
const _casingAt = new THREE.Vector3();

const EYE_STAND = 1.62;
const EYE_CROUCH = 1.08;
const BASE_FOV = 75;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
// Camera roll per metre of lean offset. At 0.5 a full 0.55 m peek rolls about sixteen
// degrees, which is the range cover shooters use: the horizon tilting is the only
// feedback a first-person player gets that they are leaning at all. It was 0.3 — nine
// and a half degrees — which reads as the camera sliding sideways rather than as the
// body going with it, and is most of why the fighters looked like they leaned further
// when in fact they lean half as far.
const LEAN_ROLL = 0.5;

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    camera.rotation.order = 'YXZ';

    this.pos = new THREE.Vector3(0, 0, 12);   // feet
    this.vel = new THREE.Vector3();
    this.yaw = 0;                              // face -Z (enemy gate)
    this.pitch = 0;
    this.onGround = true;
    this.crouching = false;
    this.sprinting = false;

    this.maxHp = 100;
    this.hp = 100;
    this.alive = true;
    this.armDmg = 0;
    this.legDmg = 0;
    this.armor = { head: 0, body: 0, limbs: 0, limbAccum: 0 };  // per-slot mitigation
    this.character = makeCharacter();  // live ref to career.playerCh: pack = meds/ammo
    this.weightMult = 1;
    this.magBySlot = [];               // mags persist per gun — no free refills on switch
    this.chamberBySlot = [];           // and so does whether each one has a round up
    this.knifeOut = false;             // knife lives on [3], not the scroll cycle
    this.swingT = 0;                   // viewmodel slash arc
    this._lungeT = 0;
    this._lungeTarget = null;
    this.healing = null;               // {kind, label, t, dur}
    this.throwCd = 0;
    this.skills = { aim: 0, cardio: 0, tough: 0 };
    this.progressStats = {
      maxHp: 100, spreadMult: 1, speedMult: 1, reloadMult: 1,
      damageTakenMult: 1, killHeal: 8,
    };
    this.damageTakenMult = 1;

    // weapons
    this.slots = ['pistol'];
    this.slotIdx = 0;
    this.mag = WEAPONS.pistol.mag;
    this.reloading = 0;
    this.shellLoading = false;   // shotgun-style: feeding one round at a time
    this.pumpT = 0;              // pump-action stroke in progress
    // Seconds until the weapon in hand is usable after a swap, and until it is back up
    // after being carried low through a sprint. Both from DogEater, whose rule is that
    // every action costs time and the state you were in decides how much.
    this.swapT = 0;
    this.holsterT = 0;
    this._swapDur = 0;
    this._swapFrom = WEAPONS.pistol;   // what is being put away, for its `holster`
    this.raiseT = 0;
    this.reloadFromEmpty = false;      // did this reload begin with a dead chamber?
    // A reload is a thing you can be *part way through*, not a timer that either runs
    // or does not. Sprinting, healing, throwing and swapping all break one off where it
    // stands and keep the progress: the magazine may be lying out of the well with only
    // the chambered round in the gun, and that is a legitimate state to be caught in.
    // Pressing reload again picks up from there rather than starting over.
    this.reloadPaused = false;
    this.reloadDur = 0;                // how long the magazine change in progress takes
    this.rackT = 0;                    // seconds left of the rack that follows a dry swap
    this.rackDur = 0;
    this.reloadBySlot = [];            // partial reloads survive a weapon swap, per slot
    // The chambered round, as real state rather than as bookkeeping.
    //
    // `mag` is the magazine alone; this is the one round sitting in the chamber on top
    // of it. Firing empties the chamber and the action cycles it full again a moment
    // later, taking that round out of the magazine — so ammunition leaves the magazine
    // when the bolt strips it, not when the trigger breaks. Everything people expect of
    // a chambered round falls out of that: the extra round on a tactical reload, the
    // last shot you can still take with an empty magazine, and the dead trigger after
    // it. See `cycleTime` in src/weapons.js.
    this.chambered = true;
    this.chamberT = 0;                 // seconds until the action finishes cycling
    this.chamberDur = 0;
    this.fireCooldown = 0;
    this.triggerHeld = false;
    this.triggerQueued = false;
    this.ads = 0;            // 0..1
    this.adsHeld = false;
    this.bloom = 0;          // recoil bloom
    // Recoil is an offset on top of the aim, not a change to it. See src/recoil.js.
    this.recoil = new Recoil();
    this.recoilPattern = new RecoilPattern(this.weapon);
    this.kick = 0;           // viewmodel kick (eased toward kickTarget)
    this.kickTarget = 0;
    this.bobT = 0;
    this.stepAcc = 0;
    this.deathT = 0;
    this.shakeT = 0;
    this.lean = 0;          // -1 left … +1 right (smoothed)
    this.leanAmount = 0;    // world-units of current camera offset (post wall-clamp)
    this.mantle = null;     // {from, to, t, dur} while clambering
    this.mantleCooldown = 0;

    this.keys = {};
    this.padMoveX = 0;        // analog move intent from gamepad / touch stick
    this.padMoveZ = 0;
    this.sprintHeld = false;  // sprint intent from controller L3 / touch stick slam
    this.sprintNoiseT = 0;    // how long until the next footfall the enemy can hear

    // viewmodel rig
    this.vmRoot = new THREE.Group();
    camera.add(this.vmRoot);
    this.vmRoot.position.set(0.22, -0.22, -0.42);
    this.vmRoot.scale.setScalar(0.85);

    // small fill light so the gun (and immediate surroundings) read in the dark
    const fill = new THREE.PointLight(0xfff0e0, 1.1, 2.4, 2);
    fill.position.set(0.1, 0.1, 0.1);
    camera.add(fill);
    this.viewmodels = {};
    // First-person arms. The weapon parents into the arms' socket, which sits at the
    // arms' origin, so everything below that positions `vmRoot` is unaffected.
    this.arms = new ViewModel(this.vmRoot);
    this._mountViewmodel();

    this.stats = { kills: 0, headshots: 0, deaths: 0, earned: 0, matchKills: 0, matchHeadshots: 0 };
  }

  get weapon() {
    if (this.knifeOut || !this.slots.length) return WEAPONS.knife;
    return WEAPONS[this.slots[this.slotIdx]];
  }
  get eyeHeight() { return this.crouching ? EYE_CROUCH : EYE_STAND; }
  get heightScale() { return this.crouching ? 0.75 : 1; }
  get speedMult() {
    return (1 - this.legDmg * 0.45) * (this.progressStats.speedMult || 1) * (this.weightMult || 1)
      * (this.weapon.melee ? 1.14 : 1); // blade out, feet light
  }

  // ---------- ammo (real rounds out of the backpack — no exceptions) ----------
  ammoType() { return ITEM_TYPES[this.weapon.id]?.ammo || null; }
  reserve() {
    if (this.weapon.melee) return Infinity; // a knife never runs dry
    if (this.infiniteAmmo) return Infinity;  // firing range only; live bouts always use the pack
    const t = this.ammoType();
    return t ? ammoInPack(this.character, t) : 0;
  }
  loadMagsFromPack() {
    this.magBySlot = this.slots.map((id) => {
      const w = WEAPONS[id];
      if (w.melee) return 0;
      if (this.infiniteAmmo) return w.mag;
      const t = ITEM_TYPES[id]?.ammo;
      if (!t) return 0;
      return consumeAmmo(this.character, t, w.mag);
    });
    // Everything comes off the rack loaded: a full magazine and a round chambered.
    this.chamberBySlot = this.magBySlot.map((m) => m > 0);
    this.mag = this.magBySlot[this.slotIdx] ?? 0;
    this.chambered = this.chamberBySlot[this.slotIdx] ?? false;
  }

  _mountViewmodel() {
    // A new weapon is a new pattern, and a fresh index: the first round out of a
    // freshly drawn gun is the top of its spray, not wherever the last one left off.
    if (this.recoilPattern) this.recoilPattern.set(this.weapon);
    const id = this.weapon.id;
    if (!this.viewmodels[id]) this.viewmodels[id] = buildViewmodel(id);
    this.currentVM = this.viewmodels[id];
    // The arms take ownership of the weapon group and play the draw.
    this.arms.setWeapon(id, this.currentVM.group, this.currentVM.parts);
  }

  resetForMatch(spawn, yaw = 0) {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.hp = this.maxHp = this.progressStats.maxHp || 100;
    this.alive = true;
    this.armDmg = 0; this.legDmg = 0;
    this.mag = this.weapon.mag;
    this.reloading = 0; this.shellLoading = false; this.pumpT = 0;
    this.swapT = 0; this.holsterT = 0; this._swapDur = 0; this.raiseT = 0;
    this.reloadFromEmpty = false;
    this.reloadPaused = false; this.rackT = 0; this.rackDur = 0; this.reloadBySlot = [];
    this.chambered = this.mag > 0; this.chamberT = 0; this.chamberDur = 0;
    this.fireCooldown = 0; this.bloom = 0;
    this.recoil.reset();
    this.deathT = 0;
    this.stats.matchKills = 0; this.stats.matchHeadshots = 0;
    this.triggerHeld = false; this.adsHeld = false; this.ads = 0;
    this.crouchToggled = false;
    this.lean = 0; this.leanAmount = 0; this.leanToggle = 0; this.mantle = null; this.mantleCooldown = 0;
    this.healing = null; this.throwCd = 0;
    this.knifeOut = this.slots.length === 0;
    this.swingT = 0; this._lungeT = 0; this._lungeTarget = null;
  }

  healLimbs() { this.armDmg = 0; this.legDmg = 0; }

  // ---------- input ----------
  onMouseMove(dx, dy) {
    if (!this.alive) return;
    const sens = 0.0021 * (1 - this.ads * 0.45);
    // Through the recoil first.
    //
    // Input that opposes the current kick is spent cancelling it rather than moving
    // the aim, so pulling down on a climbing gun returns the sights to where they were
    // pointing and stops there. Adding recoil straight to the pitch instead — which is
    // what this used to do — means every correction drags the aim below where it
    // started, and the player is fighting their own compensation as well as the gun.
    const look = this.recoil.applyLook(dx * sens * RAD2DEG, -dy * sens * RAD2DEG);
    this.yaw -= look.x * DEG2RAD;
    this.pitch += look.y * DEG2RAD;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
  }

  // analog look from controller stick / touch drag — deltas already in radians
  addLook(dYaw, dPitch) {
    if (!this.alive) return;
    // Recoil.applyLook uses screen-space degrees: +x turns right while player yaw
    // decreases to turn right, and +y pitches up. Convert the requested analog
    // camera delta into that same convention so mouse, touch and gamepad all spend
    // opposing input against recoil before moving the underlying aim.
    const look = this.recoil.applyLook(-dYaw * RAD2DEG, dPitch * RAD2DEG);
    this.yaw -= look.x * DEG2RAD;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + look.y * DEG2RAD));
  }

  onMouseDown(btn) {
    if (btn === 0) { this.triggerHeld = true; this.triggerQueued = true; }
    if (btn === 2) this.adsHeld = true;
  }
  onMouseUp(btn) {
    if (btn === 0) this.triggerHeld = false;
    if (btn === 2) this.adsHeld = false;
  }

  onKey(code, down) {
    this.keys[code] = down;
    if (!down) {
      // lean key released: long hold = hold-to-lean (stand back up);
      // short tap = toggle (stand only if we were already leaning that side)
      if (code === 'KeyQ' || code === 'KeyE') {
        const side = code === 'KeyE' ? 1 : -1;
        const held = performance.now() / 1000 - (this._leanDownAt || 0);
        if (held >= 0.3) this.leanToggle = 0;
        else if (this._leanPrev === side) this.leanToggle = 0;
      }
      return;
    }
    if (code === 'KeyR') this.startReload();
    if (code === 'KeyC') this.crouchToggled = !this.crouchToggled;
    if (code === 'Space') this.spacePressed = true; // edge, consumed by update
    if (code === 'Digit3') this.drawKnife();
    if (code === 'KeyH') this.startHeal('medkit');
    if (code === 'KeyV') this.startHeal('splint');
    if (code === 'KeyG') this.throwGrenade();
    // hybrid lean: tap toggles, holding past 0.3s behaves like hold-to-lean (release = stand)
    if (code === 'KeyQ' || code === 'KeyE') {
      const side = code === 'KeyE' ? 1 : -1;
      this._leanDownAt = performance.now() / 1000;
      this._leanPrev = this.leanToggle;
      this.leanToggle = side;
    }
    if (code === 'Digit1' || code === 'Digit2') {
      const n = parseInt(code.slice(5)) - 1;
      if (n < this.slots.length && (n !== this.slotIdx || this.knifeOut)) this.switchTo(n);
    }
  }

  clearInput() {
    this.keys = {};
    this.triggerHeld = false;
    this.adsHeld = false;
    this.sprinting = false;
    this.padMoveX = 0;
    this.padMoveZ = 0;
    this.sprintHeld = false;
  }

  startHeal(kind) {
    if (!this.alive || this.healing) return;
    // Both hands go to the kit, so whatever they were doing to the weapon stops.
    this.interruptReload();
    if (kind === 'medkit') {
      if (countInPack(this.character, 'medkit') <= 0 || this.hp >= this.maxHp - 1) return;
      this.healing = { kind, label: 'PATCHING UP…', t: 0, dur: 2.2 };
    } else {
      if (countInPack(this.character, 'splint') <= 0 || (this.armDmg < 0.05 && this.legDmg < 0.05)) return;
      this.healing = { kind, label: 'SPLINTING…', t: 0, dur: 1.8 };
    }
    audio.reload(0);
  }

  cancelHeal() { this.healing = null; }

  throwGrenade() {
    if (!this.alive || this.healing || this.throwCd > 0 || countInPack(this.character, 'grenade') <= 0) return;
    this.interruptReload();   // the support hand is throwing, not feeding a magazine
    useFromPack(this.character, 'grenade');
    this.throwCd = 0.7;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const origin = this.camera.position.clone().addScaledVector(dir, 0.35);
    const vel = dir.clone().multiplyScalar(11.5);
    vel.y += 3.6;
    this.world.throwGrenade(origin, vel, this.world.playerShooter);
    this.kickTarget = Math.min(1, (this.kickTarget ?? 0) + 0.7);
  }

  // scroll cycles GUNS only; scrolling while the knife is out returns to the last gun
  onWheel(deltaY) {
    if (!this.slots.length) return;
    if (this.knifeOut) return this.switchTo(this.slotIdx);
    if (this.slots.length < 2) return;
    const n = (this.slotIdx + (deltaY > 0 ? 1 : -1) + this.slots.length) % this.slots.length;
    this.switchTo(n);
  }

  switchTo(n) {
    if (!this.knifeOut) {
      this.magBySlot[this.slotIdx] = this.mag;   // mags stay as you left them
      this.chamberBySlot[this.slotIdx] = this.chambered;
      this._stashReload(this.slotIdx);
    }
    this.knifeOut = false;
    this.slotIdx = n;
    this.mag = this.magBySlot[n] ?? 0;
    // A weapon you put away with a round up still has one when you pick it back up.
    this.chambered = this.chamberBySlot[n] ?? (this.mag > 0);
    this.chamberT = 0;
    this._restoreReload(n);
    this._beginSwap();
    this.kickTarget = 0.6;
    this._mountViewmodel();
    audio.reload(0);
  }

  /**
   * Put a part-done reload away with the weapon, and take it back out with it.
   *
   * Swapping off a rifle whose magazine is half changed and swapping back has to find
   * the rifle as it was left: magazine out, one in the chamber, half a change still
   * owed. Anything else and a swap is a free reload cancel, which is the cheapest way
   * there is to make the whole mechanic not matter.
   */
  _stashReload(slot) {
    this.interruptReload();
    this.reloadBySlot[slot] = this.reloading > 0 || this.rackT > 0
      ? { t: this.reloading, dur: this.reloadDur, rackT: this.rackT, rackDur: this.rackDur }
      : null;
  }

  _restoreReload(slot) {
    const held = slot >= 0 ? this.reloadBySlot[slot] : null;
    this.shellLoading = false;
    this.reloading = held?.t ?? 0;
    this.reloadDur = held?.dur ?? 0;
    this.rackT = held?.rackT ?? 0;
    this.rackDur = held?.rackDur ?? 0;
    this.reloadPaused = this.reloading > 0 || this.rackT > 0;
  }

  /**
   * Charge a swap: the outgoing weapon goes away, then the incoming one comes up.
   *
   * Called *after* `slotIdx` moves, so `this.weapon` is already the new one and
   * `_swapFrom` is whatever was in hand. A swap used to be free, which made a sidearm
   * a magazine you could reach in no time — run the rifle dry, tap 1, keep shooting.
   * Now it costs the old weapon's `holster` plus the new one's `draw`, and the two
   * halves are what make the numbers worth balancing: a DMR is slow to put down as
   * well as slow to bring up.
   */
  _beginSwap() {
    const mult = this.progressStats.swapMult || 1;
    const out = this._swapFrom || this.weapon;
    this.holsterT = (out.holster ?? 0.3) * mult;
    this.swapT = this.holsterT + (this.weapon.draw ?? 0.4) * mult;
    this._swapDur = this.swapT;
    this._swapFrom = this.weapon;
  }

  drawKnife() {
    if (this.knifeOut || !this.alive) return;
    if (this.slots.length) {
      this.magBySlot[this.slotIdx] = this.mag;
      this.chamberBySlot[this.slotIdx] = this.chambered;
      this._stashReload(this.slotIdx);
    }
    this.knifeOut = true;
    this._restoreReload(-1);
    this._beginSwap();
    this.kickTarget = 0.8;
    this._mountViewmodel();
    audio.slash(0.4);
  }

  /**
   * Strip the next round out of the magazine and put it in the chamber.
   *
   * The one place ammunition leaves the magazine. Called when the action finishes
   * cycling after a shot, and at the end of a reload that had to send the bolt home.
   * A magazine with nothing in it simply fails to feed, which leaves the chamber empty
   * and the trigger dead until the player reloads — the click after the last round.
   */
  _loadChamber() {
    if (this.chambered) return;
    // Nothing to strip from: the magazine is out of the weapon, or on its way out. This
    // is what makes firing the chambered round during a magazine change cost something —
    // the action cycles onto an empty chamber and stays there until the fresh magazine is
    // in and the bolt has been worked, which is a rack the reload did not originally owe.
    if (this.reloading > 0 && !this.shellLoading) return;
    if (this.mag <= 0) return;
    // Always out of the magazine, including on the firing range. `infiniteAmmo` means
    // the *pack* never runs out, so reloading costs nothing — it does not mean the
    // magazine never empties. Short-circuiting here left the range with a magazine
    // that never moved, which hid the entire mechanic in the one place built for
    // trying weapons out.
    this.mag--;
    this.chambered = true;
  }

  /**
   * Is a magazine change under way and actually running, as opposed to frozen part-done?
   *
   * The distinction matters everywhere the reload gates something. A running reload
   * blocks aiming and drives the arms; a paused one blocks nothing — the player is
   * standing there with the magazine out and whatever is in the chamber, free to aim,
   * fire it and move.
   */
  get reloadActive() { return !this.reloadPaused && (this.reloading > 0 || this.rackT > 0); }

  /**
   * Is the magazine out of the well?
   *
   * True over the middle of a magazine change — between the old one being stripped and
   * the new one seating — including while that change is paused. The gun holds only
   * what is in the chamber, and the action has nothing to feed from.
   */
  get magazineOut() {
    if (this.shellLoading || this.reloading <= 0 || this.reloadDur <= 0) return false;
    const done = (this.reloadDur - this.reloading) / this.reloadDur;
    return done >= MAG_OUT_AT && done < MAG_IN_AT;
  }

  /** Rounds the player actually has in hand: the magazine plus whatever is chambered. */
  get roundsInWeapon() {
    return (this.magazineOut ? 0 : this.mag) + (this.chambered ? 1 : 0);
  }

  /**
   * Break off a reload where it stands, keeping the progress.
   *
   * Running, healing, splinting, throwing and putting the weapon away all do this. The
   * reload does not restart afterwards and it does not complete — it waits, and the
   * player is left holding whatever state the interruption caught them in. Feeding a
   * shotgun is the one exception: each shell is its own complete action, so stopping
   * between them simply stops, which `cancelShellReload` already does.
   */
  interruptReload() {
    if (this.shellLoading) { this.cancelShellReload(); return; }
    if (this.reloadPaused || (this.reloading <= 0 && this.rackT <= 0)) return;
    this.reloadPaused = true;
    this.arms.pauseClip();
  }

  /** Pick a paused reload back up from where it stopped. */
  _resumeReload() {
    this.reloadPaused = false;
    if (this.rackT > 0) return;   // the rack has no body clip; the hand IK carries it
    const at = this.reloadDur > 0 ? 1 - this.reloading / this.reloadDur : 0;
    this.arms.reload(this.reloadDur, at);
    audio.reload(0);
  }

  startReload() {
    const w = this.weapon;
    if (w.melee || !this.alive) return;
    if (this.swapT > 0 || this.raiseT > 0) return;   // the weapon is not up yet
    // A reload already part-done is resumed, not restarted. This is the other half of
    // interrupting one: the progress is kept, so breaking off to shoot or to run costs
    // the time you were interrupted for and not the whole magazine change again.
    if (this.reloadPaused) { this._resumeReload(); return; }
    // Full means a full magazine *and* a round up. Topping up a full magazine when the
    // chamber is dead is still a reload worth doing — it is the rack.
    const full = this.mag >= w.mag && this.chambered;
    if (this.reloading > 0 || this.rackT > 0 || full) return;
    if (this.reserve() <= 0) { audio.dryFire(); return; } // nothing left in the pack
    const mult = this.progressStats.reloadMult || 1;
    if (this.weapon.shellReload) {
      // Shell by shell. Each round is its own timer and its own animation, and the
      // player can break off and fire whatever is already in the tube.
      this.shellLoading = true;
      this.reloadFromEmpty = !this.chambered;
      this.reloading = this.weapon.shellReload * mult;
      this.reloadDur = this.reloading;
      this.arms.loadShell(this.reloading);
      audio.reload(0);
      return;
    }
    // The magazine change, and only that. Whether a rack follows is decided when the
    // fresh magazine seats, not here — see the completion in `update`.
    const plan = planReload(w, this.mag, this.reserve(), this.chambered, mult);
    this.reloadFromEmpty = !plan.chambered;
    this.reloading = plan.duration;
    this.reloadDur = this.reloading;
    this.rackT = 0; this.rackDur = 0;
    this.arms.reload(this.reloading);
    audio.reload(0);
    setTimeout(() => { if (this.reloadActive) audio.reload(1); }, this.reloading * 600);
  }

  /** Abandon a shell-by-shell reload, keeping whatever has already been fed. */
  cancelShellReload() {
    if (!this.shellLoading) return;
    this.shellLoading = false;
    this.reloading = 0;
  }

  currentSpread() {
    const w = this.weapon;
    const moveSpeed = Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z);
    const base = THREE.MathUtils.lerp(w.spread, w.adsSpread, this.ads);
    const moveMult = 1 + moveSpeed * 0.14 + (this.onGround ? 0 : 0.9);
    const crouchMult = this.crouching ? 0.7 : 1;
    const injured = 1 + this.armDmg * 1.6;
    return (base * moveMult * crouchMult * injured + this.bloom) * (this.progressStats.spreadMult || 1);
  }

  // ---------- damage ----------
  takeDamage(dmg, part, fromPos) {
    if (!this.alive) return;
    if (part === 'torso') dmg *= (1 - this.armor.body);
    else if (part === 'head') dmg *= (1 - this.armor.head);
    else dmg *= (1 - this.armor.limbs);
    dmg *= 0.8; // player grit
    dmg *= this.damageTakenMult || 1;
    this.hp -= dmg;
    const accum = 0.34 * (1 - this.armor.limbAccum);
    if (part === 'armL' || part === 'armR') this.armDmg = Math.min(1, this.armDmg + accum);
    if (part === 'legL' || part === 'legR') this.legDmg = Math.min(1, this.legDmg + accum);
    this.shakeT = 0.25;
    audio.hurt();
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.deathT = 0;
      this.stats.deaths++;
    }
  }

  // ---------- update ----------
  update(dt, locked, spectating = false) {
    const w = this.weapon;

    if (!this.alive) {
      // release the world proxy — a corpse must not soak bullets or draw AI fire
      // while the spectator phase keeps the match running
      this.world.playerProxy.alive = false;
      // Only drive the short death slump before spectator mode takes ownership.
      // Otherwise this would reset the camera to the corpse every frame before
      // the aerial camera runs, trapping an interpolated shot near the floor.
      if (!spectating) {
        this.deathT += dt;
        const t = Math.min(1, this.deathT / 0.8);
        this.camera.position.set(this.pos.x, THREE.MathUtils.lerp(this.eyeHeight, 0.25, t * t) + this.pos.y, this.pos.z);
        this.camera.rotation.set(this.pitch, this.yaw, t * 0.9);
      }
      return;
    }

    // ---- movement intent ----
    let ix = 0, iz = 0;
    if (locked) {
      if (this.keys['KeyW']) iz -= 1;
      if (this.keys['KeyS']) iz += 1;
      if (this.keys['KeyA']) ix -= 1;
      if (this.keys['KeyD']) ix += 1;
      ix += this.padMoveX;
      iz += this.padMoveZ;
    }
    const wantSprint = !!this.keys['ShiftLeft'] || this.sprintHeld;
    // toggle crouch (C); sprinting or jumping stands you back up
    if (wantSprint && iz < 0) this.crouchToggled = false;
    this.crouching = locked && !!this.crouchToggled;
    this.sprinting = locked && wantSprint && iz < 0 && !this.crouching && this.ads < 0.3;

    // Boots carry about fifteen metres. Sprinting past a corner now hands whoever is
    // behind it an approximate fix on you, which is the cost that makes walking —
    // and crouching, and going the long way round — worth something.
    this.sprintNoiseT -= dt;
    if (this.sprinting && this.onGround && this.sprintNoiseT <= 0) {
      this.sprintNoiseT = 0.45;
      this.world.emitNoise?.(this.world.playerProxy, this.pos, 'sprint');
    }

    // clamp to unit intent; partial stick deflection walks at partial speed
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = ix * cos + iz * sin;
    const wz = -ix * sin + iz * cos;
    const speed = 4.4 * this.speedMult * (this.sprinting ? 1.55 : 1) * (this.crouching ? 0.55 : 1) * (1 - this.ads * 0.35) * (this.healing ? 0.6 : 1);

    const accel = this.onGround ? 22 : 5;
    if (this._lungeT <= 0) { // a melee lunge owns the velocity while it lasts
      this.vel.x += (wx * speed - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (wz * speed - this.vel.z) * Math.min(1, accel * dt);
    }

    // ---- clamber / jump / gravity ----
    this.mantleCooldown -= dt;
    if (this.mantle) {
      // clambering: scripted move, physics off
      const m = this.mantle;
      m.t += dt;
      const k = Math.min(1, m.t / m.dur);
      const kY = Math.min(1, k / 0.55);            // rise first…
      const kXZ = Math.max(0, (k - 0.35) / 0.65);  // …then pull over the lip
      this.pos.y = THREE.MathUtils.lerp(m.from.y, m.to.y, 1 - (1 - kY) * (1 - kY));
      this.pos.x = THREE.MathUtils.lerp(m.from.x, m.to.x, kXZ);
      this.pos.z = THREE.MathUtils.lerp(m.from.z, m.to.z, kXZ);
      this.vel.set(0, 0, 0);
      this.onGround = true;
      if (k >= 1) this.mantle = null;
    } else {
      // mantle only on a FRESH Space press — holding jump while brushing crates
      // used to yank you into scripted climbs mid-strafe
      if (locked && this.spacePressed && this.legDmg < 0.75 && this.mantleCooldown <= 0) {
        const ledge = this._findLedge();
        if (ledge) {
          this.mantle = ledge;
          this.mantleCooldown = 0.6;
          this.crouchToggled = false;
        }
      }
      if (locked && this.keys['Space'] && !this.mantle && this.onGround && this.legDmg < 0.75) {
        this.vel.y = 4.6;
        this.onGround = false;
        this.crouchToggled = false;
      }
      this.spacePressed = false;
      this.vel.y -= 13 * dt;

      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.z * dt;
      this.pos.y += this.vel.y * dt;
    }

    // ---- collision ----
    // ground: floor + climbable box tops (step-up within STEP_REACH)
    let groundY = 0;
    for (const box of this.world.colliders) {
      if (box.max.y > STAND_LIMIT) continue; // too tall to stand on (walls/pillars)
      if (box.max.y - this.pos.y <= STEP_REACH && box.containsXZ(this.pos.x, this.pos.z, 0.3)) {
        groundY = Math.max(groundY, box.max.y);
      }
    }
    if (this.pos.y <= groundY) {
      this.pos.y = groundY;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = this.pos.y - groundY < 0.05;
    }
    // horizontal pushout (skip anything we can simply step onto)
    const preX = this.pos.x, preZ = this.pos.z;
    for (const box of this.world.colliders) {
      if (box.max.y - this.pos.y <= STEP_REACH && box.max.y <= STAND_LIMIT) continue;
      const feetTop = this.pos.y + 1.7;
      if (feetTop < box.min.y || this.pos.y > box.max.y) continue;
      box.pushCircleXZ(this.pos, 0.38);
    }
    // clamp the total correction: corner cases can otherwise eject you sideways
    // in one frame, which reads as getting spun around by the geometry
    {
      const cx = this.pos.x - preX, cz = this.pos.z - preZ;
      const cd = Math.hypot(cx, cz);
      const MAX_CORRECT = 0.2;
      if (cd > MAX_CORRECT) {
        this.pos.x = preX + (cx / cd) * MAX_CORRECT;
        this.pos.z = preZ + (cz / cd) * MAX_CORRECT;
      }
    }

    // footsteps
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hSpeed > 1.2) {
      this.stepAcc += hSpeed * dt;
      if (this.stepAcc > 2.6) { this.stepAcc = 0; audio.footstep(); }
      this.bobT += dt * hSpeed * (this.legDmg > 0.3 ? 2.6 : 1.9);
    }

    // ---- melee lunge resolution ----
    this._resolveLunge(dt);

    // ---- healing channel ----
    this.throwCd -= dt;
    if (this.healing) {
      this.healing.t += dt;
      if (this.triggerHeld) {
        this.cancelHeal(); // firing intent interrupts (item not consumed)
      } else if (this.healing && this.healing.t >= this.healing.dur) {
        if (this.healing.kind === 'medkit') {
          useFromPack(this.character, 'medkit');
          this.hp = Math.min(this.maxHp, this.hp + 65);
        } else {
          useFromPack(this.character, 'splint');
          this.armDmg = 0;
          this.legDmg = 0;
        }
        this.healing = null;
        audio.reload(1);
      }
    }

    // ---- ADS ----
    // A *running* reload blocks aiming; a paused one does not. Caught mid-magazine-change
    // by a fight, the player is allowed to bring the gun up on whatever is chambered.
    const adsTarget = this.adsHeld && !this.reloadActive && !this.healing
      && this.swapT <= 0 && !this.sprinting ? 1 : 0;
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * (9 + (this.skills.cardio || 0) * 2));
    const targetFov = THREE.MathUtils.lerp(BASE_FOV, w.adsFov, this.ads);
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }

    // ---- reload (rounds come out of the backpack) ----
    if (this.pumpT > 0) this.pumpT -= dt;

    // Anything that takes a hand off the weapon breaks the reload off where it stands.
    // Sprinting is checked here rather than at the keypress because it is recomputed from
    // the movement input every frame — there is no single moment a sprint "starts".
    if (this.reloadActive && (this.sprinting || this.healing || this.swapT > 0)) {
      this.interruptReload();
    }

    if (this.reloadActive && this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const t = this.ammoType();
        if (this.shellLoading) {
          this.mag += this.infiniteAmmo ? 1 : (t ? consumeAmmo(this.character, t, 1) : 1);
          if (this.mag < w.mag && this.reserve() > 0) {
            // Another round to feed: restart the timer and replay the insert.
            this.reloading = (w.shellReload || 0.45) * (this.progressStats.reloadMult || 1);
            this.arms.loadShell(this.reloading);
            audio.reload(0);
          } else {
            this.shellLoading = false;
            this.reloading = 0;
            // Only when the tube started empty. Shells fed on top of a chambered round
            // need no stroke, and pumping anyway throws a live shell on the floor —
            // which is exactly what it looked like, because it is what it did.
            if (w.pump && this.reloadFromEmpty) {
              this.pumpT = w.pump; this.arms.pump(w.pump);
              this._loadChamber();          // the stroke is what chambers the first shell
            }
          }
        } else {
          // `planReload` decided the capacity when the reload started, and it depends
          // on whether a round was chambered *then* — so it is asked again here with
          // the same magazine count and gives the same answer.
          //
          // `reserve()` already returns Infinity on the firing range, so the plan comes
          // back asking for a full magazine and only the *taking* has to know about it.
          const plan = planReload(w, this.mag, this.reserve(), this.chambered);
          this.mag += (this.infiniteAmmo || !t)
            ? plan.taken
            : consumeAmmo(this.character, t, plan.taken);
          this.reloading = 0;
          // The magazine is in. Whether the bolt now has to be worked is decided *here*,
          // on the state of the chamber right now — not on the state it was in when the
          // reload started. A tactical reload interrupted by a shot arrives with a dead
          // chamber and grows the rack it would not otherwise have owed, which is the
          // price of taking that shot.
          if (!this.chambered) {
            const rack = rackTime(w) * (this.progressStats.reloadMult || 1);
            if (rack > 0) { this.rackT = rack; this.rackDur = rack; }
            else this._loadChamber();
          }
        }
      }
    } else if (this.reloadActive && this.rackT > 0) {
      // The rack: bolt, slide or charging handle worked once, sending a round home. It
      // is its own stage with its own timer so it can be interrupted like any other —
      // sprint out of it and the gun stays on an empty chamber until you work it.
      this.rackT -= dt;
      if (this.rackT <= 0) {
        this.rackT = 0; this.rackDur = 0;
        this._loadChamber();
        audio.reload(1);
      }
    }

    // ---- firing ----
    this.fireCooldown -= dt;
    this.bloom = Math.max(0, this.bloom - dt * 6);
    const wantFire = w.auto ? this.triggerHeld : this.triggerQueued;
    // Pulling the trigger mid-shell-reload breaks off and shoots what is loaded —
    // the whole point of feeding one at a time is that you can stop early.
    if (wantFire && this.shellLoading && this.mag > 0 && this.pumpT <= 0) this.cancelShellReload();
    // Sprinting carries the weapon down: you cannot fire from there, and it takes a
    // moment to bring it back up. DogEater's rule, and it is what stops a sprint from
    // being strictly better than a walk — the cost of closing ground fast is that you
    // arrive unable to shoot for a quarter of a second.
    if (this.sprinting) this.raiseT = w.raise ?? 0.22;
    else if (this.raiseT > 0) this.raiseT -= dt;
    if (this.swapT > 0) this.swapT -= dt;
    if (this.holsterT > 0) this.holsterT -= dt;
    // The action, cycling. DogEater loads the chamber a hair before the weapon is ready
    // to fire again, so the round is up by the time the trigger will answer.
    if (this.chamberT > 0) {
      this.chamberT -= dt;
      if (this.chamberT <= 0) this._loadChamber();
    }
    const weaponUp = this.swapT <= 0 && this.raiseT <= 0 && !this.sprinting;

    // A magazine change no longer locks the trigger. If there is a round in the chamber
    // it can be fired — from the hip, because aiming is still blocked — and firing it is
    // a real decision: the action has no magazine to feed from, so the shot leaves the
    // chamber dead and adds a rack onto the end of the reload. That is the whole shape of
    // the mechanic the chambered round exists for.
    //
    // The rack itself is the exception. Both hands are on the weapon working the bolt,
    // and by definition there is nothing chambered to fire anyway.
    if (wantFire && this.fireCooldown <= 0 && this.pumpT <= 0 && weaponUp
        && this.rackT <= 0 && !this.healing && locked) {
      if (w.melee) {
        this._slash();
      } else if (!this.chambered) {
        // Mid-magazine-change with a dead chamber is not a dry gun, it is a gun being
        // fixed. Clicking at it should not start the reload that is already running, nor
        // make the empty-click noise over the top of it.
        if (this.reloading <= 0) {
          audio.dryFire();
          this.fireCooldown = 0.25;
          this.startReload();
        }
      } else {
        this._fire();
      }
    }
    this.triggerQueued = false;

    // recoil recovery
    // (recoil is integrated with the camera, below — it is an offset, not a decay)
    // Ease toward the impulse rather than snapping to it. Setting `kick` directly
    // moved the muzzle ~0.14 m in a single frame, which reads as a cut rather than a
    // kick; two or three frames of rise is still instant to the eye.
    this.kickTarget = Math.max(0, (this.kickTarget ?? 0) - dt * 6);
    this.kick += (this.kickTarget - this.kick) * Math.min(1, dt * 20);
    if (this.shakeT > 0) this.shakeT -= dt;

    // ---- lean (Q/E, toggle) ----
    //
    // Measured, the player already leans 0.55 m against a fighter's 0.27 m, and gets
    // the full amount in 97% of stances in the pit — so the complaint that the bots
    // lean further is not about distance. It is about *reading* as a lean: a fighter
    // visibly tilts his whole body out of cover, while the player got a camera slide
    // with nine and a half degrees of roll, no body to see, and a quarter of a second
    // of easing that took the snap out of it.
    //
    // So the reach is unchanged and the presentation is not. The roll goes to about
    // sixteen degrees, which is the range every cover shooter uses, and the onset is
    // quicker: a peek is a commitment and it should feel like one.
    if (this.sprinting) this.leanToggle = 0;
    const leanTarget = this.leanToggle || 0;
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * 14);
    // right vector at current yaw
    const rX = cos, rZ = -sin;
    let leanDist = Math.abs(this.lean) * 0.55;
    if (leanDist > 0.02) {
      // don't lean through walls
      const eyeBase = new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
      const leanDir = new THREE.Vector3(rX * Math.sign(this.lean), 0, rZ * Math.sign(this.lean));
      const w = wallHit(this.world, eyeBase, leanDir, 1.2);
      leanDist = Math.min(leanDist, Math.max(0, w.dist - 0.18));
    } else leanDist = 0;
    this.leanAmount = leanDist * Math.sign(this.lean);
    const leanX = rX * this.leanAmount, leanZ = rZ * this.leanAmount;
    const leanDrop = Math.abs(this.leanAmount) * 0.14;

    // ---- camera ----
    const eyeTarget = this.eyeHeight;
    this._eyeSmooth = this._eyeSmooth ?? eyeTarget;
    this._eyeSmooth += (eyeTarget - this._eyeSmooth) * Math.min(1, dt * 10);
    const limpMult = this.legDmg > 0.3 ? 1.8 : 1;
    const bobY = Math.abs(Math.sin(this.bobT)) * 0.045 * limpMult * Math.min(1, hSpeed / 4) * (1 - this.ads * 0.7);
    const bobX = Math.sin(this.bobT) * 0.02 * Math.min(1, hSpeed / 4) * (1 - this.ads * 0.7);
    const shake = this.shakeT > 0 ? (Math.random() - 0.5) * 0.03 : 0;

    this.camera.position.set(
      this.pos.x + bobX * cos + shake + leanX,
      this.pos.y + this._eyeSmooth + bobY + shake - leanDrop,
      this.pos.z - bobX * sin + leanZ
    );
    // The offset rides on top of the aim: +x kicks right, so the camera's yaw (which
    // increases to the left) takes it negative; +y kicks up, and pitch increases upward.
    this.recoil.update(dt);
    // The pitch clamp above runs before the recoil offset is added, so the *sum* is
    // clamped again here: past ±90° a YXZ euler crosses the pole and the whole view
    // reads as flipped. Nothing legitimate ever hits this — it is the last line of
    // defence for whatever upstream bug or input glitch gets this far.
    this.camera.rotation.set(
      Math.max(-1.5, Math.min(1.5, this.pitch + this.recoil.posY * DEG2RAD)),
      this.yaw - this.recoil.posX * DEG2RAD,
      Math.sin(this.bobT) * 0.006 * limpMult - this.leanAmount * LEAN_ROLL,
    );

    // ---- viewmodel pose ----
    //
    // Two poses blended by `ads`: the hip carry, which is a fixed offset because
    // nothing about it has to line up with anything, and the aimed pose, which is
    // *solved* so the weapon's own sights land on the camera's axis. See
    // `solveSightAlignment`. What used to be here was one hardcoded offset shared by
    // every weapon, so only whichever gun it had been eyeballed against was aimed.
    const vm = this.vmRoot;
    const hipPos = _hipPos.set(0.22, -0.22, -0.42);
    _hipQuat.identity();
    let aimed = false;
    if (this.ads > 0.001) aimed = this._solveAds(_adsPos, _adsQuat);

    if (aimed) {
      vm.position.lerpVectors(hipPos, _adsPos, this.ads);
      vm.quaternion.copy(_hipQuat).slerp(_adsQuat, this.ads);
    } else {
      vm.position.copy(hipPos);
      vm.quaternion.copy(_hipQuat);
    }

    // Carry low while sprinting, and on the way back up.
    //
    // Not decoration: the weapon cannot fire in this state, and a control that stops
    // working with nothing on screen to say why reads as a bug rather than as a rule.
    // The gun drops and rolls out of the aiming line, which is the same language every
    // other shooter uses for "not ready".
    const w2 = this.weapon;
    // Low while sprinting, low through a swap, easing up as either ends.
    const swapLow = this.swapT > 0 && this._swapDur > 0
      ? Math.min(1, this.swapT / this._swapDur) : 0;
    const lowTarget = this.sprinting ? 1
      : Math.max(swapLow, this.raiseT > 0
        ? this.raiseT / Math.max(1e-4, w2.raise ?? 0.22) : 0);
    this.lowK = (this.lowK || 0) + (lowTarget - (this.lowK || 0)) * Math.min(1, dt * 12);
    if (this.lowK > 0.001) {
      vm.position.y -= 0.16 * this.lowK;
      vm.position.z += 0.06 * this.lowK;
      vm.rotateX(-0.55 * this.lowK);
      vm.rotateZ(0.35 * this.lowK);
    }

    // Scope glass: solid at the hip, gone by the time the player is looking through
    // it. A scope with no lenses reads as a length of pipe from the outside, and a
    // scope with lenses cannot be seen through — the only way to have both is to fade
    // them out on the way up.
    const lenses = this.currentVM && this.currentVM.group.userData.lenses;
    if (lenses) {
      const glass = Math.max(0, 1 - this.ads * 2.2);
      for (const l of lenses) {
        l.material.opacity = glass;
        l.visible = glass > 0.01;
      }
    }

    // Everything below is felt rather than aimed, so it composes on top — in the
    // weapon's own axes, because a gun kicks about itself.
    //
    // Damped while aiming. The whole point of the sights being on the axis is that
    // you can watch a target through them; at full hip-fire kick the picture washes
    // off the screen and back every shot, which is a lot of motion to sell a recoil
    // the crosshair already communicates.
    const kickVm = this.kick * (1 - this.ads * 0.62);
    vm.position.z += kickVm * 0.07;
    vm.position.y += Math.abs(Math.sin(this.bobT)) * 0.012 * (1 - this.ads);
    vm.position.x += Math.sin(this.bobT) * 0.008 * (1 - this.ads);
    // The arc runs against *this* reload's duration, not the weapon's full magazine
    // change. A shotgun feeds one shell at a time in 0.44 s against a `reload` of 2.4,
    // so measuring the phase against the wrong one left the weapon parked most of the
    // way through its arc and snapping flat between shells — 24 degrees in a single
    // frame, which is a quarter of a metre at the muzzle.
    const reloadDur = this.reloadDur || w.reload;
    // And the *depth* of the tip scales with it. You do not cant a shotgun forty-six
    // degrees to push in one shell — and geometrically you cannot, in 0.44 s, without
    // the muzzle covering 5 cm in a single frame. A full magazine change gets the full
    // arc; a shell feed gets a nod.
    const arc = 0.8 * Math.min(1, Math.max(0.28, reloadDur / 1.4));
    let rx = kickVm * 0.22
      + (this.reloading > 0 ? Math.sin((reloadDur - this.reloading) / reloadDur * Math.PI) * arc : 0);
    let ry = 0;
    let rz = kickVm * 0.05;
    // The knife's strike is the authored `melee` clip on the arms rig, and nothing
    // else. This used to add a procedural arc on top of it — 86 degrees of pitch on
    // the viewmodel root plus 18 cm of sideways travel — so two animations of the
    // same motion fought each other and the forearm went up through the camera.
    if (this.swingT > 0) this.swingT -= dt;
    if (rx || ry || rz) vm.quaternion.multiply(_kickQuat.setFromEuler(_kickEuler.set(rx, ry, rz)));

    // ---- weapon mechanism ----
    // Slide/bolt/pump cycle off the same kick impulse the viewmodel uses, and the
    // magazine drops and reseats through the middle of a reload. Seeing the action
    // work is what makes a shot feel mechanical instead of a sound with a flash.
    this.arms.update(dt);
    const reloadK = this.reloading > 0 && !this.shellLoading && this.reloadDur > 0
      ? (this.reloadDur - this.reloading) / this.reloadDur
      : 0;
    // The pump traces a full back-and-forward over its stroke; the magazine only
    // drops on a magazine-fed reload.
    const pumpK = w.pump && this.pumpT > 0
      ? Math.sin((1 - this.pumpT / w.pump) * Math.PI)
      : 0;
    // The rack, as its own stage rather than a window guessed at inside the reload. The
    // part travels back and forward over `rackDur`, and the support hand is sent to it —
    // see `arms.rackK` below. The magazine guns never racked at all before this: an AK
    // went from empty to firing without the charging handle ever moving.
    // Paused needs no special case: `rackT` simply stops advancing, so the part and the
    // hand freeze mid-stroke, which is what an interrupted rack looks like.
    const rack = this.rackT > 0 && this.rackDur > 0
      ? Math.sin((1 - this.rackT / this.rackDur) * Math.PI)
      : 0;
    // Which is also where the support hand goes: off the handguard and onto the charging
    // handle for the length of the stage, travelling with it.
    this.arms.rackK = this.rackT > 0 ? Math.max(0.08, rack) : 0;
    // The action, driven by the chamber cycle rather than by the recoil impulse it
    // used to be guessed from. This is the same timer that decides when the next round
    // is available, so the bolt is not miming a cycle alongside the real one — it *is*
    // the cycle, and its speed is the weapon's fire rate for free.
    const cycleK = this.chamberT > 0 && this.chamberDur > 0
      ? Math.sin((1 - this.chamberT / this.chamberDur) * Math.PI)
      : 0;
    animateWeaponParts(
      this.currentVM,
      Math.max(cycleK, rack),
      // The magazine is out of the well over exactly the window the rules use, so what
      // the player sees and what the gun will do agree: no magazine visible, no rounds
      // available but the chambered one, and the action unable to feed. It leaves the
      // well a little before `MAG_OUT_AT` and is home a little after `MAG_IN_AT`, which
      // is the hand travel either side of the state change.
      magDropAt(reloadK),
      pumpK,
    );

    // Update the world proxy. The lean goes across in full: the hit model tilts the
    // body about the feet rather than sliding it sideways, so how much of the offset
    // reaches any given height falls out of the geometry. The 0.7 that used to be here
    // was fudging around a model that moved the player's boots when he leaned.
    const pp = this.world.playerProxy;
    pp.pos.copy(this.pos);
    pp.alive = this.alive;
    pp.heightScale = this.heightScale;
    pp.leanX = leanX;
    pp.leanZ = leanZ;
    // The point he is actually looking from, minus the bob and the shake — those are
    // camera feel, not head position. The hit model puts his head here rather than
    // deriving one, so that anything he can see round a corner can shoot him in it.
    if (!pp.eye) pp.eye = new THREE.Vector3();
    pp.eye.set(
      this.pos.x + leanX,
      this.pos.y + this._eyeSmooth - leanDrop,
      this.pos.z + leanZ,
    );
  }

  /**
   * Where the viewmodel has to sit for the sights to be on the camera's axis.
   *
   * The sight positions are read off the weapon *as currently posed* — the arms are
   * holding it, and they breathe — and converted into the viewmodel root's own space,
   * which divides out whatever the root's transform happens to be this frame. The
   * solve then produces the transform that puts them where they belong. Doing it every
   * frame rather than once is what keeps the sight picture steady while the arms move
   * underneath it, which is exactly what shouldering a weapon does in life.
   *
   * Returns false before the weapon has loaded, or for anything with no sights (the
   * knife), and the caller falls back to the hip pose.
   */
  _solveAds(outPos, outQuat) {
    const held = this.currentVM && this.currentVM.group;
    const rear = held && held.userData.sightRear;
    const front = held && held.userData.sightFront;
    if (!rear || !front) return false;

    const vm = this.vmRoot;
    vm.updateMatrixWorld(true);
    // Both points through the same matrix, so the root's own transform cancels.
    vm.worldToLocal(rear.getWorldPosition(_sRear));
    vm.worldToLocal(front.getWorldPosition(_sFront));
    // The weapon's up, as a direction in the same space. It sets the roll: without it
    // the shortest rotation onto the camera axis leaves the gun lying over.
    held.matrixWorld.extractBasis(_tmpA, _sUp, _tmpB);
    vm.getWorldQuaternion(_tmpQ).invert();
    _sUp.applyQuaternion(_tmpQ).normalize();

    const relief = adsRelief(this.weapon.id);
    return solveSightAlignment(_sRear, _sFront, _sUp, relief, vm.scale.x, outPos, outQuat);
  }

  // Ledge in front of us we can clamber onto: top 0.35–1.5 above feet, within reach, facing it.
  _findLedge() {
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const cp = { x: 0, z: 0 }, land = { x: 0, z: 0 };
    let best = null, bestDy = 99;
    for (const box of this.world.colliders) {
      if (box.max.y > STAND_LIMIT) continue;
      const dy = box.max.y - this.pos.y;
      if (dy < 0.35 || dy > 1.5) continue;
      box.closestXZ(this.pos.x, this.pos.z, cp);
      const dx = this.pos.x - cp.x, dz = this.pos.z - cp.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.95 * 0.95 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      // must be roughly facing the ledge
      if ((-dx / d) * fwdX + (-dz / d) * fwdZ < 0.35) continue;
      if (dy < bestDy) {
        bestDy = dy;
        // land point: just past the lip, clamped inside the box footprint
        box.clampInsideXZ(cp.x - (dx / d) * 0.4, cp.z - (dz / d) * 0.4, 0.15, land);
        best = { from: this.pos.clone(), to: new THREE.Vector3(land.x, box.max.y + 0.01, land.z), t: 0, dur: 0.32 + dy * 0.12 };
      }
    }
    return best;
  }

  // Apex-style melee: acquire a target in a forward cone, lunge to close, connect on arrival
  _slash() {
    const w = this.weapon;
    this.fireCooldown = 60 / w.rpm;
    this.swingT = 0.32;
    this.arms.melee(this.swingT);
    audio.slash();

    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    let best = null, bestScore = -Infinity;
    for (const c of this.world.combatants) {
      if (!c.alive || c.team === 'player') continue;
      const to = c.aimPoint().sub(this.camera.position);
      const dist = to.length();
      if (dist > 4.2) continue;
      to.normalize();
      const dot = to.dot(fwd);
      if (dot < 0.45) continue; // ~63° cone
      const score = dot * 3 - dist * 0.4;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best) {
      // lunge at them
      const dx = best.pos.x - this.pos.x, dz = best.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const lungeSpd = Math.min(11, 4 + d * 3);
      this.vel.x = (dx / d) * lungeSpd;
      this.vel.z = (dz / d) * lungeSpd;
      this._lungeTarget = best;
      this._lungeT = 0.24;
    }
  }

  _resolveLunge(dt) {
    if (this._lungeT <= 0) return;
    this._lungeT -= dt;
    const t = this._lungeTarget;
    if (!t || !t.alive) { this._lungeT = 0; return; }
    const dx = t.pos.x - this.pos.x, dz = t.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    // homing dash: re-steer every frame so the damping can't kill it
    if (dist > 0.5) {
      this.vel.x = (dx / dist) * 11;
      this.vel.z = (dz / dist) * 11;
    }
    if (dist < 2.2 || this._lungeT <= 0) {
      if (dist < 3.0) {
        const dmg = WEAPONS.knife.dmg * (this.world.globalDmgMult || 1);
        t.applyDamage(this.world, 'torso', dmg, this.world.playerShooter, t.aimPoint());
        audio.hitFlesh();
        this.shakeT = Math.max(this.shakeT, 0.12);
      }
      this._lungeT = 0;
      this._lungeTarget = null;
    }
  }

  _fire() {
    const w = this.weapon;
    // The round that leaves the barrel is the one that was chambered, so the magazine
    // is untouched here — `_loadChamber` takes the next one out of it when the action
    // finishes cycling. That ordering is what gives a magazine-empty gun one last shot
    // and a dead trigger after it.
    this.chambered = false;
    this.chamberDur = cycleTime(w);
    this.chamberT = this.chamberDur;
    this.fireCooldown = 60 / w.rpm;
    this.world.playerFiredAt = performance.now() / 1000; // crew hears this and clears the lane
    const spread = this.currentSpread();

    const origin = this.camera.position.clone();
    const baseDir = new THREE.Vector3();
    this.camera.getWorldDirection(baseDir);

    // muzzle world position for tracer start
    const muzzle = new THREE.Vector3();
    this.currentVM.muzzle.getWorldPosition(muzzle);

    let hits = 0;
    let nearest = Infinity;
    for (let i = 0; i < w.pellets; i++) {
      const dir = applySpread(baseDir, spread);
      const res = fireRay(this.world, this.world.playerShooter, origin, dir, w);
      if (res.type === 'flesh' || res.type === 'player') hits++;
      if (Number.isFinite(res.dist)) nearest = Math.min(nearest, res.dist);
      this.world.fx.tracer(muzzle, res.point);
      if (res.type === 'wall') {
        this.world.fx.sparks(res.point, dir, res.normal);
        if (Math.random() < 0.35) audio.ricochet();
      }
    }
    this.world.onCombatEvent?.('shot', this.world.playerShooter, {
      weapon: w.id,
      target: null,
      range: Number.isFinite(nearest) ? +nearest.toFixed(2) : null,
      pellets: w.pellets,
      hits,
    });

    // Your shot is the loudest thing you can do. Every hostile in earshot gets a
    // rough fix on this muzzle — which is what makes a suppressed approach, or
    // simply not firing, a real option rather than a stylistic one.
    this.world.emitNoise?.(this.world.playerProxy, muzzle, 'gunshot', w.suppression ?? 1, baseDir);

    audio.shot(w.sound, 1);
    this.arms.fire();
    if (w.pump && this.mag > 0) {
      // Chamber the next round. Firing is locked out until the stroke completes.
      this.pumpT = w.pump;
      this.arms.pump(w.pump);
    }
    this.world.fx.muzzleFlash(muzzle, baseDir, { near: true });
    // Eject a case to the shooter's right. Melee weapons and the empty-chamber case
    // have already returned before here, so anything reaching this point cycled.
    if (!w.melee) {
      _casingRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      _casingAt.copy(muzzle).addScaledVector(baseDir, -0.18).setY(muzzle.y + 0.02);
      this.world.fx.ejectCasing(_casingAt, _casingRight);
    }

    // recoil
    // Modifiers only. The weapon's own strength lives in `recoilVelocity`, which the
    // pattern has already applied — multiplying by `w.recoil` as well would count it
    // twice and make the heavy guns quadratically worse than the light ones.
    const r = (1 - this.ads * 0.35) * (1 - (this.skills.aim || 0) * 0.14) * (1 + this.armDmg * 0.8);
    const kick = this.recoilPattern.next(this.world.simTime ?? performance.now() / 1000);
    this.recoil.add(kick.x * r, kick.y * r, w.recoilImpulse || 0);
    this.bloom += w.recoil * 0.45;
    this.kickTarget = Math.min(1, (this.kickTarget ?? 0) + (w.viewKick ?? 0.55));

    if (this.mag <= 0) this.startReload();
  }
}
