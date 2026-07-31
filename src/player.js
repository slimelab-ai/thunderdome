import * as THREE from 'three';
import {
  WEAPONS, buildViewmodel, animateWeaponParts, solveSightAlignment, adsRelief,
} from './weapons.js';
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
    this.fireCooldown = 0;
    this.triggerHeld = false;
    this.triggerQueued = false;
    this.ads = 0;            // 0..1
    this.adsHeld = false;
    this.bloom = 0;          // recoil bloom
    this.recoilPitch = 0;
    this.recoilYaw = 0;
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
    const t = this.ammoType();
    return t ? ammoInPack(this.character, t) : 0;
  }
  loadMagsFromPack() {
    this.magBySlot = this.slots.map((id) => {
      const w = WEAPONS[id];
      if (w.melee) return 0;
      const t = ITEM_TYPES[id]?.ammo;
      if (!t) return 0;
      return consumeAmmo(this.character, t, w.mag);
    });
    this.mag = this.magBySlot[this.slotIdx] ?? 0;
  }

  _mountViewmodel() {
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
    this.fireCooldown = 0; this.bloom = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
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
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
  }

  // analog look from controller stick / touch drag — deltas already in radians
  addLook(dYaw, dPitch) {
    if (!this.alive) return;
    this.yaw += dYaw;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dPitch));
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
    if (!this.knifeOut) this.magBySlot[this.slotIdx] = this.mag; // mags stay as you left them
    this.knifeOut = false;
    this.slotIdx = n;
    this.mag = this.magBySlot[n] ?? 0;
    this.reloading = 0;
    this.kickTarget = 0.6;
    this._mountViewmodel();
    audio.reload(0);
  }

  drawKnife() {
    if (this.knifeOut || !this.alive) return;
    if (this.slots.length) this.magBySlot[this.slotIdx] = this.mag;
    this.knifeOut = true;
    this.reloading = 0;
    this.kickTarget = 0.8;
    this._mountViewmodel();
    audio.slash(0.4);
  }

  startReload() {
    if (this.weapon.melee || this.reloading > 0 || this.mag >= this.weapon.mag || !this.alive) return;
    if (this.reserve() <= 0) { audio.dryFire(); return; } // nothing left in the pack
    const mult = this.progressStats.reloadMult || 1;
    if (this.weapon.shellReload) {
      // Shell by shell. Each round is its own timer and its own animation, and the
      // player can break off and fire whatever is already in the tube.
      this.shellLoading = true;
      this.reloading = this.weapon.shellReload * mult;
      this.arms.loadShell(this.reloading);
      audio.reload(0);
      return;
    }
    this.reloading = this.weapon.reload * mult;
    this.arms.reload(this.reloading);
    audio.reload(0);
    setTimeout(() => { if (this.reloading > 0) audio.reload(1); }, this.reloading * 600);
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
    const adsTarget = this.adsHeld && this.reloading <= 0 && !this.healing ? 1 : 0;
    this.ads += (adsTarget - this.ads) * Math.min(1, dt * (9 + (this.skills.cardio || 0) * 2));
    const targetFov = THREE.MathUtils.lerp(BASE_FOV, w.adsFov, this.ads);
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 12);
      this.camera.updateProjectionMatrix();
    }

    // ---- reload (rounds come out of the backpack) ----
    if (this.pumpT > 0) this.pumpT -= dt;

    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const t = this.ammoType();
        if (this.shellLoading) {
          this.mag += t ? consumeAmmo(this.character, t, 1) : 1;
          if (this.mag < w.mag && this.reserve() > 0) {
            // Another round to feed: restart the timer and replay the insert.
            this.reloading = (w.shellReload || 0.45) * (this.progressStats.reloadMult || 1);
            this.arms.loadShell(this.reloading);
            audio.reload(0);
          } else {
            this.shellLoading = false;
            this.reloading = 0;
            if (w.pump) { this.pumpT = w.pump; this.arms.pump(w.pump); }  // chamber the first round
          }
        } else {
          this.mag += t ? consumeAmmo(this.character, t, w.mag - this.mag) : (w.mag - this.mag);
          this.reloading = 0;
        }
      }
    }

    // ---- firing ----
    this.fireCooldown -= dt;
    this.bloom = Math.max(0, this.bloom - dt * 6);
    const wantFire = w.auto ? this.triggerHeld : this.triggerQueued;
    // Pulling the trigger mid-shell-reload breaks off and shoots what is loaded —
    // the whole point of feeding one at a time is that you can stop early.
    if (wantFire && this.shellLoading && this.mag > 0 && this.pumpT <= 0) this.cancelShellReload();
    if (wantFire && this.fireCooldown <= 0 && this.pumpT <= 0
        && this.reloading <= 0 && !this.healing && locked) {
      if (w.melee) {
        this._slash();
      } else if (this.mag <= 0) {
        audio.dryFire();
        this.fireCooldown = 0.25;
        this.startReload();
      } else {
        this._fire();
      }
    }
    this.triggerQueued = false;

    // recoil recovery
    this.recoilPitch *= Math.pow(0.001, dt);
    this.recoilYaw *= Math.pow(0.001, dt);
    // Ease toward the impulse rather than snapping to it. Setting `kick` directly
    // moved the muzzle ~0.14 m in a single frame, which reads as a cut rather than a
    // kick; two or three frames of rise is still instant to the eye.
    this.kickTarget = Math.max(0, (this.kickTarget ?? 0) - dt * 6);
    this.kick += (this.kickTarget - this.kick) * Math.min(1, dt * 20);
    if (this.shakeT > 0) this.shakeT -= dt;

    // ---- lean (Q/E, toggle) ----
    if (this.sprinting) this.leanToggle = 0;
    const leanTarget = this.leanToggle || 0;
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * 9);
    // right vector at current yaw
    const rX = cos, rZ = -sin;
    let leanDist = Math.abs(this.lean) * 0.55;
    if (leanDist > 0.02) {
      // don't lean through walls
      const eyeBase = new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
      const leanDir = new THREE.Vector3(rX * Math.sign(this.lean), 0, rZ * Math.sign(this.lean));
      const w = wallHit(this.world.colliders, eyeBase, leanDir, 1.2);
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
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, Math.sin(this.bobT) * 0.006 * limpMult - this.leanAmount * 0.3);

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
    let rx = kickVm * 0.22 + (this.reloading > 0 ? Math.sin((w.reload - this.reloading) / w.reload * Math.PI) * 0.8 : 0);
    let ry = 0;
    let rz = kickVm * 0.05;
    // knife slash: a fast diagonal arc you can actually SEE
    if (this.swingT > 0) {
      this.swingT -= dt;
      const k = Math.sin((1 - Math.max(0, this.swingT) / 0.32) * Math.PI);
      rx += -k * 1.5;
      rz += k * 1.1;
      ry = -k * 0.7;
      vm.position.x -= k * 0.18;
      vm.position.y += k * 0.05;
    }
    if (rx || ry || rz) vm.quaternion.multiply(_kickQuat.setFromEuler(_kickEuler.set(rx, ry, rz)));

    // ---- weapon mechanism ----
    // Slide/bolt/pump cycle off the same kick impulse the viewmodel uses, and the
    // magazine drops and reseats through the middle of a reload. Seeing the action
    // work is what makes a shot feel mechanical instead of a sound with a flash.
    this.arms.update(dt);
    const reloadK = this.reloading > 0 && !this.shellLoading
      ? (w.reload - this.reloading) / w.reload
      : 0;
    // The pump traces a full back-and-forward over its stroke; the magazine only
    // drops on a magazine-fed reload.
    const pumpK = w.pump && this.pumpT > 0
      ? Math.sin((1 - this.pumpT / w.pump) * Math.PI)
      : 0;
    // The slide cycles either from recoil or from being racked during a reload,
    // whichever is further along.
    const rack = w.slideRack && reloadK > w.slideRack[0] && reloadK < w.slideRack[1]
      ? Math.sin((reloadK - w.slideRack[0]) / (w.slideRack[1] - w.slideRack[0]) * Math.PI)
      : 0;
    animateWeaponParts(
      this.currentVM,
      Math.max(Math.min(1, this.kick * 1.6), rack),
      reloadK > 0.12 && reloadK < 0.58 ? Math.sin((reloadK - 0.12) / 0.46 * Math.PI) : 0,
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
    this.mag--;
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
        this.world.fx.sparks(res.point, dir);
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
    this.world.emitNoise?.(this.world.playerProxy, muzzle, 'gunshot');

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
    const r = w.recoil * (1 - this.ads * 0.35) * (1 - (this.skills.aim || 0) * 0.14) * (1 + this.armDmg * 0.8);
    this.recoilPitch += 0.011 * r;
    this.recoilYaw += (Math.random() - 0.5) * 0.008 * r;
    this.bloom += w.recoil * 0.45;
    this.kickTarget = Math.min(1, (this.kickTarget ?? 0) + 0.55);

    if (this.mag <= 0) this.startReload();
  }
}
