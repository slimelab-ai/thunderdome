import * as THREE from 'three';
import { WEAPONS, buildHeldGun } from './weapons.js';
import { fireRay, applySpread, hasLoS, resolveCircle, groundHeight, STEP_REACH, playerAimPoint } from './combat.js';
import { ITEM_TYPES } from './items.js';
import { audio } from './audio.js';
import { FighterRig } from './fighter-rig.js';
import { surface } from './materials.js';
import {
  coordinatedBreachLane, offsetBreachGoal, safeBreachLane, shouldSprintAtTarget,
  searchProbe, SEARCH_PROBES,
} from './tactics.js';
import {
  ContactMemory, contactRadius, withinVision, worthGrenading, clampToArena,
} from './perception.js';
import { SuppressionMap, SUPPRESSION, coverStep } from './suppression.js';

const UP = new THREE.Vector3(0, 1, 0);
const _peekEye = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aimTmp = new THREE.Vector3();
const _scanAim = new THREE.Vector3();
const _scanEye = new THREE.Vector3();
const _targetBelief = new THREE.Vector3();
const _laneFrom = new THREE.Vector3();
const _laneTo = new THREE.Vector3();
const _routePoint = new THREE.Vector3();

/** How often a fighter sweeps every hostile for line of sight, in seconds. */
const SCAN_PERIOD = 0.18;

/** How often he re-checks whether the ground he is on is being covered. */
const SUPPRESSION_PERIOD = 0.22;

/** Sprinting boots are loud. One footfall report per this many seconds. */
const SPRINT_NOISE_PERIOD = 0.45;

/**
 * How far leaning out actually carries the muzzle sideways, in metres.
 *
 * Measured off the rig by `npm run fightercheck`, which prints it. Anything larger
 * here just makes fighters lean out and find nothing, because the shot comes from the
 * real barrel either way.
 */
const PEEK_REACH = 0.29;

/**
 * Riot-shield carry stance.
 *
 * The left arm brings the shield up and across so it fronts the torso; the right arm
 * is pushed *wide* so the weapon clears the shield's edge. That last part is the
 * whole point — with a normal weapon stance the gun sits behind the shield and the
 * fighter appears to fire straight through it. Held out past the edge, he reads as
 * peeking around his own cover to shoot, which is what a shieldman actually does.
 *
 * The head is deliberately left unpinned so the procedural aim pitch still tracks
 * targets, and the shield's top edge sits below eye level so he looks over it.
 *
 * Angles are radians, in the bone-local convention from tools/blender/fighter.py:
 * X is flexion, Z is abduction.
 */
const SHIELD_CARRY = {
  upperarm_l: [-0.45, 0, -0.62],   // up and adducted across the chest
  forearm_l: [-1.30, 0, 0],        // elbow folded so the forearm runs across the body
  hand_l: [0, 0, 0],
  shoulder_r: [0, 0, -0.18],
  upperarm_r: [-0.30, 0.10, 0.80], // abducted wide: the weapon clears the shield edge
  forearm_r: [-1.10, 0, 0],
};

/**
 * Shield placement on the left hand.
 *
 * Solved, not guessed: these are the local position and rotation that put the shield
 * squarely in front of the torso — centre 1.00 m up, 0.34 m forward, facing +Z, so
 * its top edge lands just under eye level and he looks *over* it. Hand-tuning Euler
 * angles against a bone that is already rotated three ways produced a shield floating
 * diagonally above the fighter's head.
 *
 * If `SHIELD_CARRY` changes, re-solve rather than nudge: `tools/poses/stances.js`
 * reports the shield's box in the fighter's own frame, its clearance from the gun,
 * and where the top edge sits relative to the eyes.
 */
const SHIELD_OFFSET = {
  x: -0.490, y: -0.081, z: -0.013,
  rx: -1.584, ry: -0.161, rz: -0.700,
};

function nameTagSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '700 30px Arial';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const w = ctx.measureText(name).width + 24;
  ctx.fillRect(128 - w / 2, 10, w, 42);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 41);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  sp.scale.set(1.5, 0.375, 1);
  return sp;
}

export class Combatant {
  /**
   * opts: { name, team ('player'|'enemy'), weaponId, skill: {spreadMult, reaction, speedMult},
   *         hp, shirt, armor (0..0.6 mitigation), boss, scale, aggro }
   */
  constructor(opts) {
    this.name = opts.name;
    this.team = opts.team;
    this.weaponId = opts.weaponId;
    this.skill = opts.skill;
    this.maxHp = opts.hp;
    this.hp = opts.hp;
    this.armor = opts.armor || 0;
    // per-part mitigation (Tarkov-style slots); plain `armor` maps to body for enemies
    this.armorParts = opts.armorParts || { head: 0, body: opts.armor || 0, limbs: 0 };
    this.boss = !!opts.boss;
    this.archetype = opts.archetype || null; // 'medic' | 'shield' | 'rusher' | 'marksman'
    this.damageMult = opts.damageMult || 1;
    this.damageTakenMult = opts.damageTakenMult || 1;
    this.healingMult = opts.healingMult || 1;
    this.medicCooldownMult = opts.medicCooldownMult || 1;
    this.scale = opts.scale || (0.95 + Math.random() * 0.09); // natural height variety
    this.mendCd = 4;
    this.mendT = 0;
    this.mendTarget = null;
    // soft combat role — a weighting nudge, not a hard rule:
    // pointman pushes, flanker routes wide, support holds angles, shadow escorts the boss
    this.role = opts.role || 'pointman';
    // live ammo: {ammoType: rounds}. Everyone burns real rounds; a dry fighter
    // switches guns, and a fighter with nothing left pulls the knife and charges.
    this.ammoPools = {};
    this.gunOptions = [opts.weaponId];
    this.shirt = opts.shirt;
    this.alive = true;
    this.isPlayer = false;

    this.armDmg = 0;   // 0..1 → worse aim
    this.legDmg = 0;   // 0..1 → slower, limp

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.radius = 0.42 * this.scale;
    this.baseSpeed = (2.9 + Math.random() * 0.3) * (opts.skill.speedMult || 1) * (this.boss ? 0.85 : 1) * (this.archetype === 'rusher' ? 1.3 : 1);

    // AI state
    this.target = null;
    /**
     * Everything this fighter believes about where the enemy is. Nothing in the AI
     * below reads a hostile transform for navigation — it reads this.
     */
    this.perception = new ContactMemory({ owner: this });
    /** The belief currently being acted on, or null when he has genuinely lost you. */
    this.contact = null;
    /** Which angles are being worked, and how hard. */
    this.suppression = new SuppressionMap();
    /** The lane presently covering the ground he is standing on, if any. */
    this.pinnedBy = null;
    this.coverGoal = null;
    this.suppressT = Math.random() * SUPPRESSION_PERIOD;
    /** Seconds left of refusing to advance because every way in is covered. */
    this.holdT = 0;
    this.senseT = Math.random() * SCAN_PERIOD;
    this.sprintNoiseT = 0;
    /** Where to sweep when the picture is empty. */
    this.huntGoal = new THREE.Vector3();
    this.huntT = 0;
    this.thinkTimer = Math.random() * 0.3;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 1 + Math.random() * 1.5;
    this.avoidT = 0;
    this.avoidSide = 1;
    this.navSeed = 1 + ((Math.random() * 0x7fffffff) | 0);
    this.flankSide = Math.random() < 0.5 ? -1 : 1;
    this.cautionT = 0;
    this.repathT = Math.random() * 0.5; // stagger so agents don't all path the same frame
    this._straightOK = true;
    // supplies (assigned at spawn by rank/tier)
    this.nades = 0;
    this.nadeCd = 6 + Math.random() * 8;
    this.healKits = 0;
    this.splints = 0;
    this.healingT = 0;
    this.healingKind = null;
    this.sinceHit = 99;
    // stance: crouch cycling + cosmetic lean so heads aren't all at one height
    this.crouchK = 1;
    this.stanceCrouch = false;
    this.stanceTimer = 0.5 + Math.random() * 2;
    this.leanK = 0;
    this.peekSide = 0;
    // Aiming down sights, 0..1.
    //
    // Bots used to shoot the instant their reaction timer expired, from whatever pose
    // the walk happened to be in, which is why none of them ever looked like they were
    // aiming. Now shouldering is a state with a cost: it takes time, it slows him
    // down, and it is worth it because his shots land.
    this.adsK = 0;
    this.wantsAds = false;
    // Last frame's world displacement, kept so the locomotion blendspace can be told
    // which way he is actually travelling rather than assuming it is where he faces.
    this._moveDX = 0;
    this._moveDZ = 0;
    this.sprintNow = false;
    this.openingGoal = new THREE.Vector3();
    this.openingT = 0;
    // patience: holding an angle too long without moving triggers a push
    this.stallAnchor = { x: 0, z: 0 };
    this.stallT = 0;
    this.pushT = 0;
    this.breachT = 0;
    this.breachTarget = null;
    this.breachGoal = new THREE.Vector3();
    this.breachLane = 0;
    this.cooldown = 0.5 + Math.random();
    this.burstLeft = this._burstSize();
    this.reactionLeft = 0;
    this.hadLoS = false;
    this.animPhase = Math.random() * 6;
    this.moveAmount = 0;
    this.deathT = -1;
    this.fadeT = 0;

    this._buildBody();
  }

  _burstSize() {
    const w = WEAPONS[this.weaponId];
    if (w.auto) return w.rpm > 700 ? 5 + (Math.random() * 3 | 0) : 3 + (Math.random() * 2 | 0);
    return 1;
  }

  _poolFor(weaponId) {
    const t = ITEM_TYPES[weaponId]?.ammo;
    return t ? (this.ammoPools[t] || 0) : 0;
  }

  // out of rounds for the current gun: fall back to a fed gun, or the knife
  _switchDry(world) {
    const previous = this.weaponId;
    let next = 'knife';
    let bestTier = -2;
    for (const id of this.gunOptions) {
      if (id === this.weaponId || WEAPONS[id].melee) continue;
      if (this._poolFor(id) > 0 && WEAPONS[id].tier > bestTier) { bestTier = WEAPONS[id].tier; next = id; }
    }
    this.weaponId = next;
    this.rig.weaponSocket.remove(this.gun);
    this.gun = buildHeldGun(next);
    this.rig.weaponSocket.add(this.gun);
    this.rig.setWeapon(next, this.gun);
    this.rig.trigger('reload');       // swapping to a fed gun reads as working the weapon
    this.burstLeft = this._burstSize();
    this.cooldown = 0.5;
    world.onCombatEvent?.('weapon_switch', this, { from: previous, to: next, reason: 'dry' });
  }

  _buildBody() {
    const s = this.scale;
    this.rig = new FighterRig({ uniformColor: this.shirt, scale: s });
    this.rig.bindOwner(this);
    this.group = this.rig.group;

    const bone = (name) => this.rig.bones.get(name);

    // Held weapon rides the authored hand socket, so a rifle and a knife both sit in
    // the fist and follow every animation without a hand-tuned offset per clip.
    this.gun = buildHeldGun(this.weaponId);
    this.rig.weaponSocket.add(this.gun);
    this.rig.setWeapon(this.weaponId, this.gun);

    // Extra armour reads as extra plate. The base fighter already wears a carrier;
    // this is the visible difference between a rookie and a kitted veteran.
    if (this.armorParts.body > 0) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.30, 0.10), surface('TD_steel_painted'));
      // The chest bone's local +Z is forward (its roll pins local X to world X),
      // so a positive Z offset puts the plate on the chest and a negative one hides
      // it on his back.
      plate.position.set(0, 0.07, 0.15);
      plate.castShadow = true;
      plate.userData = { combatant: this, part: 'torso' };
      bone('chest')?.add(plate);
      this.extraPlate = plate;
    }
    if (this.armorParts.head > 0) {
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 7), surface('TD_steel_painted'));
      lid.position.y = 0.11;
      lid.scale.set(1, 0.85, 1.05);
      lid.castShadow = true;
      bone('head')?.add(lid);   // cosmetic: the rig's head box already covers it
    }

    // The boss's gold mask is a separate mesh on the head bone: the fighter atlas is
    // shared by the whole cast, so tinting one head is not an option.
    if (this.boss) {
      const mask = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8), surface('TD_gold'));
      mask.position.set(0, 0.10, 0.01);
      mask.scale.set(1, 0.95, 1.02);
      mask.castShadow = true;
      mask.userData = { combatant: this, part: 'head' };
      bone('head')?.add(mask);
      const eye = new THREE.Mesh(
        new THREE.BoxGeometry(0.20, 0.035, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x2a0000, emissive: 0xff2020, emissiveIntensity: 3 }),
      );
      eye.position.set(0, 0.11, 0.14);
      bone('head')?.add(eye);
    }

    // archetype dressing, parented to the bones it belongs on
    if (this.archetype === 'shield') {
      // Carried in the left hand, and posed rather than bolted on.
      //
      // The shield has two jobs that pull against each other: it has to be a *stable*
      // frontal barrier (the archetype's rule is "torso immune from the front", so the
      // protected angle must be readable), and it has to be genuinely held, so it
      // falls with the arm when he dies and moves like a carried object. Parenting it
      // to the torso got stability by giving up the second; leaving the arm animated
      // got the second by giving up the first.
      //
      // The answer is to pin the carry pose. The shield rides the hand, but the arm
      // that holds it is held in `SHIELD_CARRY` against the locomotion and aim layers,
      // so it is hand-held and still presents a fixed angle.
      const shield = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.95, 0.06), surface('TD_steel_painted'));
      shield.position.set(SHIELD_OFFSET.x, SHIELD_OFFSET.y, SHIELD_OFFSET.z);
      shield.rotation.set(SHIELD_OFFSET.rx, SHIELD_OFFSET.ry, SHIELD_OFFSET.rz);
      shield.castShadow = true;
      shield.userData = { combatant: this, part: 'shield' };
      bone('hand_l')?.add(shield);
      this.shieldMesh = shield;
      for (const [name, euler] of Object.entries(SHIELD_CARRY)) this.rig.pinBone(name, euler);
    } else if (this.archetype === 'medic') {
      const cross = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.16, 0.02),
        new THREE.MeshStandardMaterial({ color: 0xd8d8d8, emissive: 0xff3030, emissiveIntensity: 0.25 }),
      );
      cross.position.set(0.09, 0.06, 0.15);
      bone('chest')?.add(cross);
    } else if (this.archetype === 'rusher') {
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.29, 0.05, 0.29),
        new THREE.MeshStandardMaterial({ color: 0x902a08, emissive: 0xff5a1a, emissiveIntensity: 1.6 }),
      );
      band.position.y = 0.135;
      bone('head')?.add(band);
    }

    // name tag — crew only; giant red enemy labels made targets trivial to spot
    if (this.team === 'player') {
      this.tag = nameTagSprite(this.name, '#86ff3c');
      this.tag.position.y = 1.95 * s;
      this.tag.material.opacity = 0.55;
      this.tag.scale.multiplyScalar(0.75);
      this.group.add(this.tag);
    } else {
      this.tag = { visible: false }; // stub so death code can hide it uniformly
    }

    // Hitboxes are the rig's bone-parented proxies plus any prop that should eat
    // shots in its own right.
    this.parts = [...this.rig.hitboxes];
    if (this.extraPlate) this.parts.push(this.extraPlate);
    if (this.shieldMesh) this.parts.push(this.shieldMesh); // the shield physically eats frontal shots
  }

  addTo(world, pos) {
    this.pos.copy(pos);
    // Where he came in. Not knowledge of the enemy — knowledge of the pit, which is
    // what a fighter with no contact at all sweeps toward.
    this.spawnPos = pos.clone();
    this.group.position.copy(pos);
    world.scene.add(this.group);
    world.combatants.push(this);
    for (const p of this.parts) world.hitMeshes.push(p);
    if (this.archetype === 'marksman') {
      // the laser IS the telegraph — see red, move
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      this.laser = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.7 }));
      this.laser.visible = false;
      this.laser.frustumCulled = false;
      world.scene.add(this.laser);
    }
    this.group.updateMatrixWorld(true);
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.55 * this.scale * this.crouchK, this.pos.z);
  }

  /**
   * The barrel tip, in the world, as drawn.
   *
   * Not a point derived from where the fighter is standing — the actual node on the
   * actual weapon, after the animation, the lean and the aim offset have all been
   * applied. Shots are fired from here and drawn from here, and those being the same
   * point is the whole guarantee: if a round can reach you, the weapon that fired it
   * was somewhere you could see.
   *
   * Falls back to the eye before the weapon has loaded.
   */
  muzzleWorld(out = new THREE.Vector3()) {
    const m = this.gun && this.gun.userData.muzzle;
    if (!m) return this.eyePos(out);
    this.group.updateMatrixWorld(true);
    return out.setFromMatrixPosition(m.matrixWorld);
  }
  aimPoint(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.15 * this.scale * this.crouchK, this.pos.z);
  }

  applyDamage(world, part, dmg, shooter, point, dir = null) {
    if (!this.alive) return;
    if (part === 'shield') { dmg *= 0.06; world.fx.sparks(point, dir); audio.ricochet(); }
    // Crack and thump: being hit gives up roughly where it came from, and only
    // roughly. Gated on `sinceHit` so a burst — or a shotgun — is one noise rather
    // than one per round that lands.
    if (shooter?.pos && shooter.team !== this.team && this.sinceHit > 0.5) {
      world.emitNoise?.(shooter, shooter.pos, 'impact');
    }
    this.sinceHit = 0;
    this.healingT = 0; // getting shot interrupts bandaging
    this.mendT = 0;
    if (part === 'torso') dmg *= (1 - this.armorParts.body);
    else if (part === 'head') dmg *= (1 - this.armorParts.head);
    else dmg *= (1 - this.armorParts.limbs);
    dmg *= this.damageTakenMult;
    if (this.boss && part === 'head') dmg *= 0.55; // gold mask
    const hpBefore = this.hp;
    this.hp -= dmg;
    world.onDamage?.(shooter, this, Math.min(hpBefore, Math.max(0, dmg)));

    if (part === 'armL' || part === 'armR') this.armDmg = Math.min(1, this.armDmg + 0.4);
    if (part === 'legL' || part === 'legR') this.legDmg = Math.min(1, this.legDmg + 0.4);

    if (part !== 'shield') {
      world.fx.blood(point, dir);
      if (this.hp > 0) this.rig.trigger('hit_react', part === 'head' ? 1 : 0.75);
    }
    const camDist = point.distanceTo(world.cameraPos);
    if (camDist < 25 && part !== 'shield') audio.hitFlesh();

    if (this.hp <= 0) {
      this.die(world, shooter, part);
    } else if (shooter.isPlayer) {
      world.onHitmarker(false, part === 'head');
    }
  }

  die(world, killer, part) {
    this.alive = false;
    this.deathT = 0;
    this.tag.visible = false;
    // Which authored collapse plays depends on where the shot came from, so a
    // fighter shot in the back falls forward. Headshots skip the bracing entirely.
    let fromFront = 1;
    if (killer?.pos) {
      const toKiller = _aimTmp.set(killer.pos.x - this.pos.x, 0, killer.pos.z - this.pos.z);
      fromFront = toKiller.x * Math.sin(this.yaw) + toKiller.z * Math.cos(this.yaw);
    }
    this.rig.die(fromFront, part === 'head');
    if (this.laser) this.laser.visible = false;
    if (this.bountyMarker) { this.group.remove(this.bountyMarker); this.bountyMarker = null; }
    this.bountyRevealed = false;
    // remove hitboxes
    world.hitMeshes = world.hitMeshes.filter(m => m.userData.combatant !== this);
    audio.hurt();
    // Squadmates who watch this go down get cautious, and — the part that actually
    // stops the single-file feed — they remember *the angle that did it*. Caution is
    // a couple of seconds of jinking; a deadly lane is a piece of ground the squad
    // will route around for the next nine, however quiet it goes.
    const now = world.simTime ?? 0;
    for (const c of world.combatants) {
      if (c === this || !c.alive || c.team !== this.team) continue;
      if (killer?.pos) c.suppression?.record(killer.pos, SUPPRESSION.kill, now, { deadly: true });
      if (c.archetype !== 'rusher' && c.pos.distanceTo(this.pos) < 9) {
        c.cautionT = Math.max(c.cautionT, 0.9 + Math.random() * 1.1);
      }
    }
    world.onKill(killer, this, part);
    if (killer.isPlayer) world.onHitmarker(true, part === 'head');
  }

  update(world, dt) {
    if (!this.alive) {
      // The collapse is an authored clip now, so all this has to do is keep the mixer
      // running, drop the blood pool once the body is down, and fade the corpse out.
      this.deathT += dt;
      this.rig.update(dt);
      if (this.deathT > 1.1 && !this.pooled) {
        this.pooled = true;
        world.fx.bloodPool(this.pos);
      }
      if (this.deathT > 6) {
        if (!this.fadingOwn) {
          // Fighter materials are shared across the cast; fading has to happen on
          // private copies or one corpse takes every fighter with it.
          this.fadingOwn = true;
          this.rig.privatizeMaterials();
        }
        this.fadeT += dt;
        const op = Math.max(0, 1 - this.fadeT / 1.5);
        this.rig.setOpacity(op);
        if (op <= 0) this.group.visible = false;
      }
      return;
    }

    const w = WEAPONS[this.weaponId];
    this.cooldown -= dt;
    this.thinkTimer -= dt;
    this.strafeTimer -= dt;
    this.sinceHit += dt;
    this.nadeCd -= dt;
    if (this.cautionT > 0) this.cautionT -= dt;

    // bandaging channel: crouched, helpless, healing
    if (this.healingT > 0) {
      this.healingT -= dt;
      if (this.healingT <= 0) {
        if (this.healingKind === 'splint') {
          this.armDmg = 0;
          this.legDmg = 0;
        } else {
          this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.45);
        }
        this.healingKind = null;
      }
    }

    // medics keep their squad in the fight
    if (this.archetype === 'medic') {
      this.mendCd -= dt;
      if (this.mendT > 0) {
        this.mendT -= dt;
        if (this.mendT <= 0 && this.mendTarget?.alive) {
          const t = this.mendTarget;
          const hpBefore = t.hp;
          t.hp = Math.min(t.maxHp, t.hp + t.maxHp * 0.4 * this.healingMult);
          t.armDmg = 0; t.legDmg = 0;
          world.onSupport?.(this, Math.max(0, t.hp - hpBefore));
          this.mendCd = 9 * this.medicCooldownMult;
          this.mendTarget = null;
        }
      } else if (this.mendCd <= 0 && this.sinceHit > 1.5 && (!this.mendTarget || !this.mendTarget.alive)) {
        this.mendTarget = null;
        let bd = 13 * 13;
        for (const c of world.combatants) {
          if (c === this || !c.alive || c.team !== this.team) continue;
          if (c.hp < c.maxHp * 0.6) {
            const d = this.pos.distanceToSquared(c.pos);
            if (d < bd) { bd = d; this.mendTarget = c; }
          }
        }
      }
    }

    // patience meter: parked in one spot with a live target → eventually surge
    const sdx = this.pos.x - this.stallAnchor.x, sdz = this.pos.z - this.stallAnchor.z;
    if (sdx * sdx + sdz * sdz > 9) {
      this.stallAnchor.x = this.pos.x; this.stallAnchor.z = this.pos.z;
      this.stallT = 0;
    } else if (this.target) {
      this.stallT += dt;
      if (this.stallT > (this.role === 'support' ? 13 : 8)) {
        this.stallT = 0;
        this.pushT = 3.5 + Math.random() * 1.5;
      }
    }
    if (this.pushT > 0) this.pushT -= dt;
    if (this.breachT > 0) this.breachT -= dt;

    // stance cycling while engaged: pop up, drop down — heads at varied heights
    this.stanceTimer -= dt;
    if (this.stanceTimer <= 0) {
      this.stanceCrouch = !this.stanceCrouch && Math.random() < 0.45;
      this.stanceTimer = this.stanceCrouch ? 0.9 + Math.random() * 1.1 : 1.1 + Math.random() * 1.9;
    }

    // ---- perceive ----
    // Sweep every hostile for an actual sightline, then age the picture. Everything
    // downstream navigates on what comes out of here, not on the live transforms.
    const now = world.simTime ?? (this._clock = (this._clock ?? 0) + dt);
    this.senseT -= dt;
    if (this.senseT <= 0) {
      this.senseT = SCAN_PERIOD * (0.85 + Math.random() * 0.3);
      this._scan(world, now);
    }
    for (const gone of this.perception.tick(now)) {
      world.onCombatEvent?.('contact_lost', this, {
        target: gone.entity?.isPlayer ? 'YOU' : gone.entity?.name || null,
        kind: gone.kind,
        age: +(now - gone.t).toFixed(2),
        probes: gone.probes,
      });
    }
    // Sprinting boots give a fighter away. He pays the same price the player does.
    this.sprintNoiseT -= dt;
    if (this.sprintNow && this.sprintNoiseT <= 0) {
      this.sprintNoiseT = SPRINT_NOISE_PERIOD;
      world.emitNoise?.(this, this.pos, 'sprint');
    }

    // ---- suppression ----
    // Am I standing in something's beaten zone, and if so where is out of it?
    // Rushers were told and do not care, which is the whole archetype.
    this.suppression.decayTo(now);
    if (this.holdT > 0) this.holdT -= dt;
    this.suppressT -= dt;
    if (this.suppressT <= 0 && this.archetype !== 'rusher') {
      this.suppressT = SUPPRESSION_PERIOD * (0.85 + Math.random() * 0.3);
      const before = this.pinnedBy;
      const sees = (from, to) => this._laneSees(world, from, to);
      this.pinnedBy = this.suppression.anyHot(now)
        ? this.suppression.covering(this.aimPoint(_routePoint), sees, now)
        : null;
      // Searching for cover costs fifteen sightlines; confirming the piece he is
      // already running to costs one. Only re-solve when the lane changes or the
      // spot he picked has stopped being cover.
      if (!this.pinnedBy) {
        this.coverGoal = null;
      } else if (!this.coverGoal || this.pinnedBy !== before ||
                 sees(this.pinnedBy, _routePoint.set(this.coverGoal.x, this.coverGoal.y + 1.15, this.coverGoal.z))) {
        this.coverGoal = coverStep(this.pinnedBy, this.pos, sees);
      }
      if (before && !this.pinnedBy) {
        // He just made it out of the lane. Settle here for a beat rather than
        // stepping straight back into it — without this he oscillates on the edge of
        // cover, which looks worse than never having taken cover at all.
        this.holdT = Math.max(this.holdT, 1.2 + Math.random() * 1.2);
      }
      if (this.pinnedBy && !before) {
        world.onCombatEvent?.('suppressed', this, {
          lane: [this.pinnedBy.x, this.pinnedBy.y, this.pinnedBy.z].map(v => +v.toFixed(2)),
          heat: +this.pinnedBy.heat.toFixed(2),
          kills: this.pinnedBy.kills,
          range: +Math.hypot(this.pinnedBy.x - this.pos.x, this.pinnedBy.z - this.pos.z).toFixed(2),
          cover_found: !!this.coverGoal,
        });
      }
    }

    // ---- acquire target ----
    if (this.thinkTimer <= 0 || (this.target && !this._targetAlive())) {
      this.thinkTimer = 0.35 + Math.random() * 0.25;
      const previousTarget = this.target;
      this.contact = this.perception.best(now, { from: this.pos, current: this.target });
      this.target = this.contact?.entity || null;
      if (this.target !== previousTarget) {
        world.onCombatEvent?.('target_change', this, {
          from: previousTarget?.isPlayer ? 'YOU' : previousTarget?.name || null,
          to: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
          via: this.contact?.kind || null,
        });
      }
    } else if (this.target) {
      // Keep the record pointer live: `tick` may have replaced or dropped it.
      this.contact = this.perception.get(this.target);
      if (!this.contact) this.target = null;
    }

    const speedMult = 1 - this.legDmg * 0.45;
    let moving = false;
    const move = new THREE.Vector3();

    // ---- hazard avoidance ----
    let fleeing = false;
    for (const z of world.zones) {
      const dx = this.pos.x - z.x, dz = this.pos.z - z.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < (z.r + 1.5) * (z.r + 1.5)) {
        const d = Math.max(0.01, Math.sqrt(d2));
        move.x += (dx / d) * 3; move.z += (dz / d) * 3;
        fleeing = true;
      }
    }
    // live grenades: everyone scatters — except rushers, who were warned and do not care
    if (world.grenades && this.archetype !== 'rusher') for (const gr of world.grenades) {
      const dx = this.pos.x - gr.pos.x, dz = this.pos.z - gr.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 6.5 * 6.5) {
        const d = Math.max(0.01, Math.sqrt(d2));
        move.x += (dx / d) * 4; move.z += (dz / d) * 4;
        fleeing = true;
      }
    }

    this._traveling = false;
    this._strafing = false;
    this.sprintNow = false;

    if (this.target && !fleeing && this.healingT <= 0 && this.mendT <= 0) {
      // geometric sightline to target — with no sight, range means nothing: keep hunting
      const eye = this.eyePos();
      const aim = this.target.isPlayer
        ? playerAimPoint(world.colliders, eye, world.playerProxy, _aimTmp).clone()
        : this.target.aimPoint();
      // Re-checked every frame for the fighter he is actually engaging, because the
      // moment sight breaks is the moment the belief freezes, and a scan-cadence
      // answer would leave him tracking a live transform for a fifth of a second.
      const sight = hasLoS(world.colliders, eye, aim) &&
        withinVision(this.pos, this.yaw, this.target.pos);
      if (sight) {
        // How wide the search had grown at the moment he re-found them. Captured
        // before the sighting collapses it to zero, because it is the number that
        // says whether he walked onto a stale belief or never really lost contact.
        this._reacquireRadius = !this.contact ? null
          : this.contact.visible ? 0
            : contactRadius(this.contact, now);
        this.contact = this.perception.see(this.target, this.target.pos, now);
        // Call it in. The squad converges on where *he* saw them, a beat later.
        this.perception.share(this.target, now, world.combatants.filter(
          c => c.alive && c !== this && c.team === this.team));
      } else if (this.contact?.visible) {
        this.perception.markUnseen(this.target, now);
        world.onCombatEvent?.('contact_broken', this, {
          target: this.target.isPlayer ? 'YOU' : this.target.name || null,
          last_known: [this.contact.x, this.contact.y, this.contact.z].map(v => +v.toFixed(2)),
        });
      }

      // Where he *believes* the target is — the whole point of the exercise. While he
      // can see them this is the truth; the instant he cannot, it is a memory that
      // stops moving, and every route below is planned against it.
      const belief = this.contact || { x: this.pos.x, y: this.pos.y, z: this.pos.z, error: 0, t: now };
      const uncertainty = this.contact ? contactRadius(this.contact, now) : 0;
      const tp = this._searchGoal(belief, uncertainty, sight, now, world, _targetBelief);
      const dx = tp.x - this.pos.x, dz = tp.z - this.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const fx = dx / (dist || 1), fz = dz / (dist || 1);
      const engage = w.aiRange * (this.boss ? 1.15 : 1) * (this.role === 'support' ? 1.35 : 1);

      if (this.strafeTimer <= 0) {
        this.strafeDir *= -1;
        this.strafeTimer = 1.1 + Math.random() * 1.6;
      }

      // Corner peek: body stays covered, lean the weapon out sideways for an angle.
      //
      // PEEK_REACH is how far leaning actually carries the muzzle, measured off the
      // rig — not a number picked to make the AI effective. It used to be 0.6 m
      // against a lean worth about a quarter of that, so a fighter could shoot from a
      // point two thirds of a metre outside his own body: an angle that did not exist
      // from the other end, which is exactly what an unfair peek is.
      //
      // The shot itself is fired from the real muzzle regardless of what this decides,
      // so the worst a wrong guess here can do is make him lean out and find nothing.
      this.peekSide = 0;
      if (!sight && dist < engage * 1.8) {
        for (const side of [this.strafeDir, -this.strafeDir]) {
          _peekEye.set(eye.x + -fz * PEEK_REACH * side, eye.y, eye.z + fx * PEEK_REACH * side);
          if (hasLoS(world.colliders, _peekEye, aim)) { this.peekSide = side; break; }
        }
      }

      // patch up when hurt and out of contact
      if (this.healKits > 0 && this.hp < this.maxHp * 0.38 && this.sinceHit > 2.2 && (!sight || dist > engage * 1.6)) {
        this.healKits--;
        this.healingT = 2.1;
        this.healingKind = 'medkit';
      } else if (this.splints > 0 && Math.max(this.armDmg, this.legDmg) >= 0.4 &&
        this.sinceHit > 2.2 && (!sight || dist > engage * 1.6)) {
        this.splints--;
        this.healingT = 1.8;
        this.healingKind = 'splint';
      }
      // Frag the target's hiding spot when we can't get an angle — but only a spot he
      // has actual reason to believe in.
      //
      // This is where the old model was at its worst: a grenade thrown at the live
      // transform of somebody the thrower had never seen, arcing round a corner onto
      // a player who had done everything right. Now it costs a recent sighting or a
      // tight enough sound fix, and it lands on the *belief* — so a frag chases where
      // you were, and repositioning beats it.
      const fraggable = worthGrenading(this.contact, now);
      if (this.healingT <= 0 && this.nades > 0 && this.nadeCd <= 0 && !sight && fraggable &&
        dist > 6 && dist < 18 && world.throwGrenade && Math.random() < dt * 0.55) {
        let friendlyInBlast = false;
        for (const c of world.combatants) {
          if (c === this || !c.alive || c.team !== this.team) continue;
          const bdx = c.pos.x - tp.x, bdz = c.pos.z - tp.z;
          if (bdx * bdx + bdz * bdz < 8 * 8) { friendlyInBlast = true; break; }
        }
        if (!friendlyInBlast && this.team === 'player' && world.playerProxy.alive) {
          const bdx = world.playerProxy.pos.x - tp.x, bdz = world.playerProxy.pos.z - tp.z;
          if (bdx * bdx + bdz * bdz < 8 * 8) friendlyInBlast = true;
        }
        if (!friendlyInBlast) {
          this.nades--;
          this.nadeCd = 13 + Math.random() * 8;
          const ndx = tp.x - this.pos.x, ndz = tp.z - this.pos.z;
          const nd = Math.hypot(ndx, ndz) || 1;
          const nspd = Math.min(12.5, Math.max(7, nd * 0.78));
          const jit = () => 1 + (Math.random() - 0.5) * 0.14;
          this.rig.trigger('throw');
          world.throwGrenade(this.eyePos(), new THREE.Vector3((ndx / nd) * nspd * jit(), 4.3, (ndz / nd) * nspd * jit()), this);
          world.onCombatEvent?.('grenade_throw', this, { target: this.target?.name || null, range: dist });
        } else {
          this.nadeCd = 2; // re-evaluate shortly
        }
      }

      // close-range fighters storm high ground; long-range fighters hold and shoot up
      const heightGap = tp.y - this.pos.y;
      const pushHigh = heightGap > 0.8 && w.aiRange <= 15 && this.role !== 'support';
      this._onVerticalRoute = false;

      // opening play: run the assigned lane until contact, arrival, or the whistle
      if (this.openingT > 0) {
        this.openingT -= dt;
        const odx = this.openingGoal.x - this.pos.x, odz = this.openingGoal.z - this.pos.z;
        if (sight || this.sinceHit < 0.6 || odx * odx + odz * odz < 2.2 * 2.2) this.openingT = 0;
      }
      const opening = this.openingT > 0;

      // medic en route to a patient
      const assist = this.archetype === 'medic' && this.mendTarget?.alive && this.mendCd <= 0;
      if (assist) {
        const adx = this.mendTarget.pos.x - this.pos.x, adz = this.mendTarget.pos.z - this.pos.z;
        if (adx * adx + adz * adz < 2.2 * 2.2) this.mendT = 1.6;
      }

      const blindPush = !sight && !this.peekSide;
      if (blindPush && dist > 5 &&
          (this.breachT <= 0 || this.breachTarget !== this.target)) {
        const squad = world.combatants.filter(candidate =>
          candidate.alive && candidate.team === this.team);
        const assigned = coordinatedBreachLane(squad, this);
        // The squad's assignment still comes first — a crossfire is only a crossfire
        // if the lanes stay spread. It gets overruled only by ground that is being
        // actively covered, which is the one thing worth breaking formation over.
        const choice = this.archetype === 'rusher'
          ? { lane: assigned, goal: offsetBreachGoal(tp, this.pos, assigned), covered: false }
          : safeBreachLane(tp, this.pos, assigned, goal => this._routeSwept(world, goal, now));
        this.breachLane = choice.lane;
        this.breachTarget = this.target;
        this.breachGoal.set(choice.goal.x, choice.goal.y, choice.goal.z);
        this.breachT = 6;
        if (choice.covered) {
          // Every way in is being worked. Hold — the gun has to stop eventually, and
          // walking in one at a time until it does is how a squad gets fed to a
          // doorway. Re-decide the moment the hold runs out, not in six seconds.
          this.holdT = 1.6 + Math.random() * 1.4;
          this.breachT = this.holdT;
          world.onCombatEvent?.('pinned_down', this, {
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            hold: +this.holdT.toFixed(2),
            heat: this.pinnedBy ? +this.pinnedBy.heat.toFixed(2) : null,
          });
        } else if (choice.lane !== assigned) {
          world.onCombatEvent?.('lane_rerouted', this, {
            from: assigned, to: choice.lane,
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            goal: [choice.goal.x, choice.goal.y, choice.goal.z].map(v => +v.toFixed(2)),
          });
        }
        if (this.breachLane !== 0) {
          world.onCombatEvent?.('breach_commit', this, {
            lane: this.breachLane,
            target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
            goal: [choice.goal.x, choice.goal.y, choice.goal.z].map(value => +value.toFixed(2)),
          });
        }
      }
      const breachDistance = this.pos.distanceToSquared(this.breachGoal);
      const breaching = this.breachLane !== 0 && this.breachTarget === this.target &&
        this.breachT > 0 && breachDistance > 2.2 * 2.2;
      if (!breaching && this.breachT > 0 && breachDistance <= 2.2 * 2.2) this.breachT = 0;

      // One fighter establishes the direct sightline. Side lanes remain committed
      // through momentary contact so the squad creates an actual crossfire.
      const needTravel = dist > engage || blindPush || breaching || pushHigh || this.pushT > 0 || assist;
      // Standing in a lane somebody is working: getting out of it outranks
      // everything below, including the breach he is committed to.
      //
      // Deliberately *not* conditioned on having lost sight of the shooter. That was
      // the first attempt and it barely moved the numbers, because against a genuinely
      // commanding angle a fighter can see the gun perfectly well — he is standing in
      // the open being shot by it. Trading from open ground against a held rifle is
      // the losing half of the exchange every time; the answer is to take cover and
      // fight from there, which the peek machinery below already knows how to do.
      //
      // Nowhere to go reads as carry on, never as stand still and die.
      const breakingCover = !!this.pinnedBy && !!this.coverGoal && !assist &&
        this.archetype !== 'rusher';
      if (breakingCover) {
        this._traveling = true;
        this.sprintNow = this.legDmg < 0.6;
        this._steerToward(world, dt, this.coverGoal.x, this.pos.y, this.coverGoal.z, move);
      } else if ((needTravel || opening) && (this.cautionT > 0 || this.holdT > 0) && !assist) {
        // A squadmate just died up ahead, or every approach is covered: hold the
        // angle and jink rather than feeding the corner one man at a time.
        this._strafing = true;
        move.x += -fz * this.strafeDir * 0.7; move.z += fx * this.strafeDir * 0.7;
      } else if (needTravel || opening) {
        this._traveling = true;
        let gx, gz, gy;
        if (opening) {
          gx = this.openingGoal.x; gz = this.openingGoal.z; gy = this.openingGoal.y || 0;
        } else if (assist) {
          gx = this.mendTarget.pos.x; gz = this.mendTarget.pos.z; gy = this.mendTarget.pos.y;
        } else if (breaching) {
          gx = this.breachGoal.x; gz = this.breachGoal.z; gy = this.breachGoal.y;
        } else if (this.role === 'shadow' && this.team === 'player' && !sight &&
                   Math.hypot(world.playerProxy.pos.x - this.pos.x, world.playerProxy.pos.z - this.pos.z) > 8) {
          // bodyguard: never stray far from the boss while out of contact
          gx = world.playerProxy.pos.x; gz = world.playerProxy.pos.z; gy = world.playerProxy.pos.y;
        } else {
          gx = tp.x; gz = tp.z; gy = tp.y;
        }
        // A firearm user lowers out of sprint on visual contact, even while
        // continuing toward a committed breach goal. Distance alone used to
        // keep the gun down across a completely visible gap.
        this.sprintNow = shouldSprintAtTarget({
          sight: sight || this.peekSide !== 0,
          melee: !!w.melee,
          distance: dist,
          legDamage: this.legDmg,
        });
        this._steerToward(world, dt, gx, gy, gz, move);
      } else if (this.peekSide && !sight) {
        // Working a corner peek: step out into the angle.
        //
        // Planting and shooting around it was only viable while the shot came from a
        // point 60 cm outside his own body. It comes off the real barrel now, and a
        // lean carries that 29 cm, so the rest has to be movement — which is movement
        // the other side can see, which is the entire point.
        this._strafing = true;
        move.x += -fz * this.peekSide * 0.5;
        move.z += fx * this.peekSide * 0.5;
      } else if (dist < engage * 0.45 && this.weaponId !== 'shotgun' && !w.melee && heightGap < 0.8) {
        this._strafing = true;
        if (this._ledgeAhead(world, -fx, -fz)) {
          // backing up would mean falling off — hold and strafe instead
          if (this._ledgeAhead(world, -fz * this.strafeDir, fx * this.strafeDir)) this.strafeDir *= -1;
          move.x += -fz * this.strafeDir * 0.8; move.z += fx * this.strafeDir * 0.8;
        } else {
          move.x -= fx * 0.8; move.z -= fz * 0.8;
          move.x += -fz * this.strafeDir * 0.6; move.z += fx * this.strafeDir * 0.6;
        }
      } else if (this.weaponId === 'shotgun' && dist > 3) {
        move.x += fx; move.z += fz;
      } else {
        this._strafing = true;
        if (this._ledgeAhead(world, -fz * this.strafeDir, fx * this.strafeDir)) this.strafeDir *= -1;
        move.x += -fz * this.strafeDir; move.z += fx * this.strafeDir;
      }

      // face target
      const targetYaw = Math.atan2(dx, dz);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, dt * 7);

      // ---- shooting ----
      // dry gun? switch to a fed one, or pull the knife
      if (!w.melee && ITEM_TYPES[this.weaponId]?.ammo && this._poolFor(this.weaponId) <= 0) {
        this._switchDry(world);
      }
      // Where the weapon actually is, and what it can actually see from there.
      //
      // A peek only earns a shot once the fighter has leaned far enough that his
      // weapon is genuinely clear of the corner. Deciding to peek and firing in the
      // same frame is how a bot shoots you from behind a wall he has not come out
      // from behind yet.
      const muzzle = this.muzzleWorld(_muzzle);
      const muzzleSight = (sight || this.peekSide !== 0)
        && hasLoS(world.colliders, muzzle, aim);
      // Everything above navigates on the belief; everything from here down is about
      // a target the weapon can genuinely see, so it measures the real gap. Using the
      // remembered distance to time a shot would let a stale memory tighten or widen
      // a group that is actually being aimed at a body in plain view.
      const fireDist = muzzleSight ? this.pos.distanceTo(this.target.pos) : dist;
      const visibleTarget = fireDist < engage * 2.2 && muzzleSight;
      const los = visibleTarget && !this.sprintNow;

      // marksman laser telegraph
      if (this.laser) {
        this.laser.visible = los && this.alive;
        if (this.laser.visible) {
          const pts = this.laser.geometry.attributes.position.array;
          pts[0] = muzzle.x; pts[1] = muzzle.y; pts[2] = muzzle.z;
          pts[3] = aim.x; pts[4] = aim.y; pts[5] = aim.z;
          this.laser.geometry.attributes.position.needsUpdate = true;
        }
      }

      // point-blank surprises get answered fast; long-range spotting takes longer
      if (visibleTarget && !this.hadLoS) {
        this.reactionLeft = this.skill.reaction * (0.7 + Math.random() * 0.6) *
          Math.min(1.2, Math.max(0.35, fireDist / 12));
        world.onCombatEvent?.('sight_acquired', this, {
          target: this.target?.isPlayer ? 'YOU' : this.target?.name || null,
          range: +fireDist.toFixed(2),
          sprinting: this.sprintNow,
          role: this.role,
          // How wrong he was a moment ago — the number that says whether he walked
          // onto you or merely re-found what he never really lost.
          searched_from: this._reacquireRadius == null ? null : +this._reacquireRadius.toFixed(2),
        });
      }
      // Recognition begins while the weapon is coming up; firing still requires
      // the separate sprint, ADS, reaction, and aim gates below.
      this.hadLoS = visibleTarget;
      if (this.reactionLeft > 0) this.reactionLeft -= dt;

      // Shoulder the weapon when there is something to shoot at a range worth aiming
      // at. Inside knife range nobody bothers, and a sprinting fighter has the weapon
      // down by definition.
      this.wantsAds = los && !this.sprintNow && !w.melee && fireDist > 2.2;
      // Up in about a third of a second, down slower — a fighter who has just been
      // shot at keeps his weapon up for a moment.
      const adsRate = this.wantsAds ? 3.4 : 2.0;
      this.adsK += ((this.wantsAds ? 1 : 0) - this.adsK) * Math.min(1, dt * adsRate);
      // Settled enough to shoot. Close in he fires from the hip; at distance he has to
      // actually get the weapon up first, which is the visible tell that he is aiming.
      const settled = this.adsK > Math.min(0.62, 0.12 + fireDist * 0.045);

      if (w.melee && los && this.reactionLeft <= 0 && this.cooldown <= 0 && fireDist < w.meleeRange) {
        // slash
        const mdmg = w.dmg * this.damageMult * (this.team === 'enemy' ? world.enemyDmgScale : 1) * (world.globalDmgMult || 1);
        if (this.target.isPlayer) world.onPlayerDamaged(mdmg, Math.random() < 0.2 ? 'armL' : 'torso', this.pos);
        else this.target.applyDamage(world, 'torso', mdmg, this, this.target.aimPoint());
        audio.slash(1.2 / (1 + eye.distanceTo(world.cameraPos) * 0.09));
        this.cooldown = 60 / w.rpm;
      } else if (!w.melee && los && settled && this.reactionLeft <= 0 && this.cooldown <= 0 && Math.abs(dy) < 0.35) {
        // The round leaves the barrel, wherever the barrel happens to be. Leaning
        // around a corner moves it because the animation moves it, not because the
        // shot gets a private offset the fighter's body never took.
        const fireEye = muzzle.clone();
        const dir = aim.clone().sub(fireEye).normalize();
        const distFactor = 0.7 + fireDist / 30;
        // A shouldered weapon groups roughly twice as tight as a hip-fired one. This
        // is the mechanical half of the ADS state: without it, taking the time to aim
        // would be pure cost and the AI would be strictly worse for doing it.
        const spreadDeg = w.spread * this.skill.spreadMult * (1 + this.armDmg * 1.4)
          * distFactor * (this.crouchK < 0.9 ? 0.8 : 1) * (1.35 - 0.72 * this.adsK);
        const pellets = w.pellets;
        for (let i = 0; i < pellets; i++) {
          const sdir = applySpread(dir, spreadDeg + (pellets > 1 ? 3.5 : 0));
          const res = fireRay(world, this, fireEye, sdir, w,
            this.damageMult * (this.team === 'enemy' ? world.enemyDmgScale : 1));
          world.fx.tracer(fireEye, res.point);
          if (res.type === 'wall') { world.fx.sparks(res.point, sdir); if (Math.random() < 0.3) audio.ricochet(); }
        }
        const camDist = fireEye.distanceTo(world.cameraPos);
        audio.shot(w.sound, 1.2 / (1 + camDist * 0.09));
        world.fx.muzzleFlash(fireEye, dir);
        this.rig.trigger('fire');

        // Firing is a decision to be located. Everyone hostile inside earshot gets a
        // rough fix on the muzzle — the loudest, cheapest way to give yourself away.
        world.emitNoise?.(this, muzzle, 'gunshot');

        this.shotsFired = (this.shotsFired || 0) + 1;
        world.onCombatEvent?.('shot', this, {
          target: this.target?.name || null, weapon: this.weaponId, range: fireDist,
          line_of_sight: los, role: this.role,
        });
        const ammoT = ITEM_TYPES[this.weaponId]?.ammo;
        if (ammoT) this.ammoPools[ammoT] = Math.max(0, (this.ammoPools[ammoT] || 0) - 1);
        this.burstLeft--;
        if (this.burstLeft <= 0) {
          this.burstLeft = this._burstSize();
          this.cooldown = (60 / w.rpm) + 0.5 + Math.random() * 0.5 + (w.auto ? 0.2 : 0);
        } else {
          this.cooldown = 60 / w.rpm;
        }
      }
      // Nothing in view: let the weapon down.
    } else if (!this.target && !fleeing && this.healingT <= 0 && this.mendT <= 0) {
      // Nobody on the board at all: no sighting, no sound, nothing called in.
      //
      // The old AI could never reach this state — it always had the nearest enemy
      // transform to walk at — so "idle" meant standing still and swaying. A fighter
      // who has genuinely lost everyone has to go and *find* someone, or the removal
      // of omniscience just turns into a stalemate where both squads mill about.
      this._huntFor(world, dt, now, move);
    }

    // ---- clear the boss's line of fire ---- (crew only, and only when he's SHOOTING)
    // They react to gunfire like people: a beat late, imperfectly. Your gaze moves no one,
    // and a merc crossing you mid-burst can absolutely eat a round — that one's on you.
    if (this.team === 'player' && world.playerProxy.alive && world.playerAim) {
      const now = performance.now() / 1000;
      const firing = world.playerFiredAt && now - world.playerFiredAt < 1.2;
      if (firing) {
        if (now - (this._ffSeen || -99) > 1.6) this._ffNotice = now + 0.15 + Math.random() * 0.35; // fresh burst → reaction time
        this._ffSeen = now;
        if (now >= this._ffNotice) {
          const pp = world.playerProxy;
          const rx = this.pos.x - pp.pos.x, rz = this.pos.z - pp.pos.z;
          const along = rx * world.playerAim.x + rz * world.playerAim.z;
          if (along > 0.3 && along < 12) {
            const px = rx - world.playerAim.x * along, pz = rz - world.playerAim.z * along;
            const pd = Math.hypot(px, pz);
            if (pd < 1.1) {
              const strength = (1.1 - pd) * 1.7;
              if (pd > 0.05) { move.x += (px / pd) * strength; move.z += (pz / pd) * strength; }
              else { move.x += -world.playerAim.z * strength; move.z += world.playerAim.x * strength; }
            }
          }
        }
      }
    }

    // ---- separation ---- (suspended on stairs/ledge routes: shoving = falling)
    if (!this._onVerticalRoute) for (const c of world.combatants) {
      if (c === this || !c.alive) continue;
      const dx = this.pos.x - c.pos.x, dz = this.pos.z - c.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.3 * 1.3 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        move.x += (dx / d) * (1.3 - d) * 1.5;
        move.z += (dz / d) * (1.3 - d) * 1.5;
      }
    }

    // ---- steering + movement ----
    if (move.lengthSq() > 0.01) {
      move.normalize();
      // wall-following with side commitment: flipping sides every frame stalls
      // against wide walls, so once blocked we pick a side and hold it until clear
      // sample along the path, not just the endpoint — thin walls hide between samples otherwise
      const isBlocked = (dir) => {
        // march the walked height along the ray — a ledge that's a wall from HERE
        // may be a mere step from the stair we'll be standing on by then
        let y = this.pos.y;
        for (const t of [0.8, 1.5, 2.2]) {
          const px = this.pos.x + dir.x * t, pz = this.pos.z + dir.z * t;
          y = groundHeight(world.colliders, px, pz, y);
          for (const box of world.colliders) {
            if (box.max.y - y <= STEP_REACH || box.min.y > y + 1.5) continue;
            if (box.containsXZ(px, pz, this.radius)) return true;
          }
        }
        return false;
      };
      const rot = (v, a) => v.clone().applyAxisAngle(UP, a);

      // stuck detector: wanting to move but going nowhere → burst in a random direction
      this.progressT = (this.progressT ?? 1.2) - dt;
      if (this.progressT <= 0) {
        const moved = this.lastProgressPos ? this.pos.distanceTo(this.lastProgressPos) : 99;
        if (moved < 0.5) {
          this.jiggleT = 0.7 + Math.random() * 0.7;
          const a = Math.random() * Math.PI * 2;
          this.jiggleDir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        }
        this.lastProgressPos = this.pos.clone();
        this.progressT = 1.2;
      }

      let chosen = null;
      if (this.jiggleT > 0) {
        this.jiggleT -= dt;
        if (!isBlocked(this.jiggleDir)) chosen = this.jiggleDir;
        else this.jiggleT = 0;
      }
      if (this.avoidT > 0) this.avoidT -= dt;
      if (chosen) {
        // committed jiggle
      } else if (!isBlocked(move)) {
        chosen = move;
        this.avoidT = 0;
      } else {
        if (this.avoidT <= 0) {
          const left = !isBlocked(rot(move, 0.9)), right = !isBlocked(rot(move, -0.9));
          this.avoidSide = left && !right ? 1 : right && !left ? -1 : (Math.random() < 0.5 ? 1 : -1);
          this.avoidT = 0.9 + Math.random() * 0.6;
        }
        for (const a of [0.6, 0.95, 1.3, 1.65]) {
          const cand = rot(move, a * this.avoidSide);
          if (!isBlocked(cand)) { chosen = cand; break; }
        }
        if (!chosen) for (const a of [0.6, 0.95, 1.3, 1.65]) {
          const cand = rot(move, -a * this.avoidSide);
          if (!isBlocked(cand)) { chosen = cand; break; }
        }
        if (!chosen) chosen = rot(move, 2.6 * (this.avoidSide || 1));
      }
      // Shouldered weapon costs pace. It is what makes an aiming fighter read as
      // committed to the shot instead of jogging past with a gun up.
      const spd = this.baseSpeed * speedMult * (this.crouchK < 0.9 ? 0.55 : 1)
        * (this.sprintNow ? 1.45 : 1) * (1 - 0.32 * this.adsK);
      const px = this.pos.x, pz = this.pos.z;
      this.pos.addScaledVector(chosen, spd * dt);
      resolveCircle(this.pos, this.radius, world.colliders, this.pos.y);
      // Speed *actually achieved*, not speed intended: a fighter grinding along a wall
      // should not play a full-speed run cycle on the spot.
      this.currentSpeed = dt > 0 ? Math.hypot(this.pos.x - px, this.pos.z - pz) / dt : 0;
      this._moveDX = this.pos.x - px;
      this._moveDZ = this.pos.z - pz;
      moving = true;
      this.animPhase += dt * spd * 2.6;
      this.moveAmount = Math.min(1, this.moveAmount + dt * 6);
    } else {
      this.currentSpeed = 0;
      this.moveAmount = Math.max(0, this.moveAmount - dt * 6);
    }

    // clamp to arena
    this.pos.x = Math.max(-21, Math.min(21, this.pos.x));
    this.pos.z = Math.max(-15, Math.min(15, this.pos.z));

    // terrain-follow: climb stairs / platforms, drop off ledges
    const gY = groundHeight(world.colliders, this.pos.x, this.pos.z, this.pos.y);
    this.pos.y += (gY - this.pos.y) * Math.min(1, dt * 10);
    if (Math.abs(gY - this.pos.y) < 0.02) this.pos.y = gY;

    // ---- pose ----
    // crouchK stays the gameplay value that eyePos/aimPoint and the hit model read;
    // the visible squat comes from the authored crouch clips, which are keyed to
    // roughly the same head height.
    const wantCrouch = this.healingT > 0 || this.mendT > 0 || (this._strafing && this.stanceCrouch) || (this.cautionT > 0 && !this._traveling);
    this.crouchK += ((wantCrouch ? 0.72 : 1) - this.crouchK) * Math.min(1, dt * 8);
    // peeking leans harder than plain strafing. Sign: positive is to his right, which
    // is exactly where the peek eye offsets for side=+1.
    const leanTarget = this.peekSide ? this.peekSide : (this._strafing ? this.strafeDir * 0.35 : 0);
    this.leanK += (leanTarget - this.leanK) * Math.min(1, dt * 6);

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;

    // ---- drive the animation rig ----
    // Which way he is travelling *in his own frame*, so the blendspace can pick a
    // cross-step over a forward walk. Local +Z is forward (see the yaw convention at
    // the top of the steering code); local +X is therefore his left, so the rightward
    // component carries a minus sign.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const wdx = this._moveDX || 0, wdz = this._moveDZ || 0;
    const localF = wdx * sy + wdz * cy;
    const localR = -(wdx * cy - wdz * sy);
    // A limping fighter's stride slows with him, because the blendspace advances on
    // distance travelled — the leg wound is visible in the walk, not just the numbers.
    this.rig.setStance(this.currentSpeed || 0, this.crouchK < 0.9, localR, localF);
    // Lean is a spine bend in the rig now, not a roll of the whole object: rolling
    // pivoted him about his feet and lifted a boot off the floor.
    this.rig.setLean(this.leanK);
    // The weapon comes up on the same curve the accuracy does, so what the player
    // sees and what the dice see are the same number.
    if (!this.target || this.sprintNow) this.adsK = Math.max(0, this.adsK - dt * 2.0);
    this.rig.setAimWeight(this.adsK);
    if (this.target) {
      // He points the weapon where he *thinks* they are. Aiming the rig at the live
      // transform was the most visible tell of the old model: a fighter tracking you
      // through solid concrete, muzzle following you along the far side of a wall.
      const tp = this.contact && !this.contact.visible
        ? _aimTmp.set(this.contact.x, (this.contact.y || 0) + 1.25, this.contact.z)
        : this.target.isPlayer
          ? _aimTmp.set(this.target.pos.x, this.target.pos.y + 1.25, this.target.pos.z)
          : this.target.aimPoint(_aimTmp);
      const flat = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z);
      // Yaw is what the hips have not caught up to yet. Feeding it to the aim offset
      // means he tracks a target beside him by twisting, then turns his feet — rather
      // than the whole body snapping round as one rigid piece.
      let dy = Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z) - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.rig.setAim(
        Math.atan2(tp.y - (this.pos.y + 1.35 * this.scale), Math.max(0.4, flat)), dy);
    } else {
      this.rig.setAim(0, 0);
    }
    // Bandaging is a sustained additive clip; start it once on the rising edge.
    const patching = this.healingT > 0 || this.mendT > 0;
    if (patching && !this._patchAnim) { this.rig.trigger('heal'); this._patchAnim = true; }
    else if (!patching && this._patchAnim) { this.rig.stop('heal'); this._patchAnim = false; }

    this.rig.update(dt);
  }

  /**
   * Route to a world point through the navmesh, accumulating into `move`.
   *
   * Lifted out of the engagement branch verbatim so a fighter with no contact can
   * use the same pathing to go looking. `walkableLine` is expensive, so the straight
   * -line test runs on the repath cadence rather than every frame.
   */
  _steerToward(world, dt, gx, gy, gz, move) {
    this.repathT = (this.repathT ?? 0) - dt;
    if (this.repathT <= 0) {
      this.repathT = 0.45 + Math.random() * 0.35;
      this._straightOK = world.nav ? world.nav.walkableLine(this.pos.x, this.pos.z, this.pos.y, gx, gz, gy) : true;
      if (this._straightOK) {
        this.path = null;
      } else {
        this.path = world.nav.findPath(this.pos, { x: gx, y: gy, z: gz }, this.navSeed, this.flankSide);
        this.pathIdx = 0;
      }
    }
    if (this._straightOK || !this.path || !this.path.length) {
      const gd = Math.hypot(gx - this.pos.x, gz - this.pos.z) || 1;
      move.x += (gx - this.pos.x) / gd; move.z += (gz - this.pos.z) / gd;
      return;
    }
    const reached = (wp) => {
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      return dx * dx + dz * dz < 0.9 * 0.9 && Math.abs(wp.y - this.pos.y) < 1.2;
    };
    while (this.pathIdx < this.path.length - 1 && reached(this.path[this.pathIdx])) this.pathIdx++;
    const goal = this.path[Math.min(this.pathIdx, this.path.length - 1)];
    this._onVerticalRoute = Math.abs((goal.y ?? this.pos.y) - this.pos.y) > 0.25;
    const gdx = goal.x - this.pos.x, gdz = goal.z - this.pos.z;
    const gd = Math.hypot(gdx, gdz) || 1;
    move.x += gdx / gd; move.z += gdz / gd;
  }

  /**
   * Where to walk, given a belief.
   *
   * While the target is in sight this is simply where they are. Once sight breaks it
   * is the last-known position — and once he has *reached* the last-known position
   * and found an empty corner, it becomes a finite sweep of the ground around it:
   * push through, check the cover either side, then back toward his own approach.
   *
   * When that sweep runs out, the contact is dropped. That is the part that keeps
   * this honest — a searcher who never gives up is an omniscient searcher wearing a
   * costume.
   */
  _searchGoal(belief, uncertainty, sight, now, world, out) {
    const contact = this.contact;
    if (sight || !contact || contact.visible) return out.set(belief.x, belief.y, belief.z);

    const name = () => (contact.entity?.isPlayer ? 'YOU' : contact.entity?.name || null);
    const arrived = (goal, reach) => {
      const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z;
      return dx * dx + dz * dz < reach * reach;
    };
    // Close enough counts as arrived: the belief has an error radius, so insisting on
    // standing exactly on a remembered point is precision the fighter does not have.
    const reach = Math.max(2, Math.min(uncertainty, 6) * 0.6);

    if (!contact.probeGoal) {
      if (!arrived(contact, reach)) return out.set(contact.x, contact.y, contact.z);
      contact.probeFrom = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    } else if (arrived(contact.probeGoal, 1.8)) {
      contact.probes++;
      if (contact.probes >= SEARCH_PROBES) {
        // Swept every angle and found nothing. He has lost you, properly.
        this.perception.forget(contact.entity);
        world.onCombatEvent?.('search_exhausted', this, {
          target: name(),
          last_known: [contact.x, contact.y, contact.z].map(v => +v.toFixed(2)),
          age: +(now - contact.t).toFixed(2),
        });
        return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
      }
    } else {
      return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
    }

    contact.probeGoal = clampToArena(
      searchProbe(contact, contact.probeFrom || this.pos, uncertainty, contact.probes));
    world.onCombatEvent?.('search_probe', this, {
      target: name(),
      probe: contact.probes,
      radius: +uncertainty.toFixed(2),
      goal: [contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z].map(v => +v.toFixed(2)),
    });
    return out.set(contact.probeGoal.x, contact.probeGoal.y, contact.probeGoal.z);
  }

  /**
   * Sweep the pit with nothing to go on.
   *
   * Priority is the last unexplained bang, then the far side of the arena from where
   * he came in — which is knowledge of the *venue*, not of the enemy. He walks it
   * with the weapon up rather than sprinting, because he is clearing ground, not
   * chasing a contact.
   */
  _huntFor(world, dt, now, move) {
    // Being shot at by somebody you cannot even find is the clearest case there is:
    // get off the X first, look for him second.
    if (this.pinnedBy && this.coverGoal) {
      this._traveling = true;
      this.sprintNow = this.legDmg < 0.6;
      this._steerToward(world, dt, this.coverGoal.x, this.pos.y, this.coverGoal.z, move);
      return;
    }
    const disturbance = this.perception.disturbance;
    if (disturbance && disturbance.t > (this._huntFrom ?? -Infinity)) {
      this._huntFrom = disturbance.t;
      this.huntGoal.set(disturbance.x, disturbance.y, disturbance.z);
      this.huntT = 9;
      world.onCombatEvent?.('search_disturbance', this, {
        goal: [disturbance.x, disturbance.y, disturbance.z].map(v => +v.toFixed(2)),
      });
    }
    this.huntT -= dt;
    const dx = this.huntGoal.x - this.pos.x, dz = this.huntGoal.z - this.pos.z;
    if (this.huntT <= 0 || dx * dx + dz * dz < 2.5 * 2.5) {
      // Away from his own corner, with enough spread that a squad fans out instead of
      // filing to the same spot.
      const anchorX = -(this.spawnPos?.x ?? this.pos.x);
      const anchorZ = -(this.spawnPos?.z ?? this.pos.z);
      this.huntGoal.set(
        Math.max(-19, Math.min(19, anchorX * 0.7 + (Math.random() - 0.5) * 18)),
        0,
        Math.max(-13, Math.min(13, anchorZ * 0.7 + (Math.random() - 0.5) * 14)),
      );
      this.huntT = 7 + Math.random() * 5;
    }
    this._traveling = true;
    this._steerToward(world, dt, this.huntGoal.x, this.huntGoal.y, this.huntGoal.z, move);
    const yaw = Math.atan2(this.huntGoal.x - this.pos.x, this.huntGoal.z - this.pos.z);
    let dy = yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    // Slower than the lock-on turn: he is looking around, not tracking anyone.
    this.yaw += dy * Math.min(1, dt * 2.6);
    // ...and the head keeps sweeping either side of his line of travel, which is what
    // gives the field of view something to find.
    this.yaw += Math.sin(now * 0.9 + this.animPhase) * dt * 0.7;
  }

  // would moving 0.9m in (dx,dz) walk us off a >0.8m ledge?
  _ledgeAhead(world, dx, dz) {
    const d = Math.hypot(dx, dz) || 1;
    const px = this.pos.x + (dx / d) * 0.9, pz = this.pos.z + (dz / d) * 0.9;
    const g = groundHeight(world.colliders, px, pz, this.pos.y);
    return this.pos.y - g > 0.8;
  }

  _targetAlive() {
    const t = this.target;
    return t && t.alive;
  }

  /**
   * Sweep every hostile for a sightline and write what he finds into memory.
   *
   * This replaces `_acquire`, which walked the live roster and returned whoever was
   * nearest — through walls, from behind, at any range. Target selection now happens
   * in `ContactMemory.best`, over beliefs, and this is the only thing in the AI that
   * is allowed to look at a hostile transform at all.
   *
   * The fighter he is already engaging gets re-checked every frame in the main loop;
   * this is the wider sweep that finds *new* people, on a slower cadence.
   */
  _scan(world, now) {
    const eye = this.eyePos(_scanEye);
    const look = (hostile) => {
      if (!hostile.alive) return;
      if (!withinVision(this.pos, this.yaw, hostile.pos)) {
        this.perception.markUnseen(hostile, now);
        return;
      }
      const aim = hostile.isPlayer
        ? playerAimPoint(world.colliders, eye, world.playerProxy, _scanAim)
        : hostile.aimPoint(_scanAim);
      if (hasLoS(world.colliders, eye, aim)) this.perception.see(hostile, hostile.pos, now);
      else this.perception.markUnseen(hostile, now);
    };
    if (this.team === 'enemy') look(world.playerProxy);
    for (const c of world.combatants) if (c.team !== this.team) look(c);
  }

  /**
   * A noise reached him. Only ever called through `world.emitNoise`.
   *
   * A gunshot does two separate jobs, and conflating them was the bug: it is a
   * rough fix on *where he is*, and it is evidence that *that angle is being
   * worked*. The second one accumulates — one round is nothing, twenty into the
   * same doorway is a reason to go round.
   */
  hearNoise(source, pos, kind, now) {
    const contact = this.perception.hear(source, pos, kind, this.pos, now);
    // Gated on the contact, which is falsy exactly when the noise was out of
    // earshot — a fighter cannot be pinned by fire he cannot hear.
    if (contact && kind === 'gunshot') this.suppression.record(pos, SUPPRESSION.shot, now);
    return contact;
  }

  /** Line of sight between two loose `{x, y, z}` points, without allocating. */
  _laneSees(world, from, to) {
    return hasLoS(
      world.colliders,
      _laneFrom.set(from.x, from.y, from.z),
      _laneTo.set(to.x, to.y, to.z),
    );
  }

  /**
   * Does getting to `goal` mean crossing ground somebody is presently covering?
   *
   * Sampled along the route rather than at the endpoint, because the endpoint is
   * rarely the problem — the doorway two thirds of the way there is. Bails
   * immediately when nothing is hot, which is most of the time.
   */
  _routeSwept(world, goal, now) {
    if (!this.suppression.anyHot(now)) return false;
    const sees = (from, to) => this._laneSees(world, from, to);
    const chest = this.pos.y + 1.15 * this.scale;
    for (const t of [0.45, 0.75, 1]) {
      _routePoint.set(
        this.pos.x + (goal.x - this.pos.x) * t,
        chest,
        this.pos.z + (goal.z - this.pos.z) * t,
      );
      if (this.suppression.covering(_routePoint, sees, now)) return true;
    }
    return false;
  }

  removeFrom(world) {
    if (this.laser) world.scene.remove(this.laser);
    this.rig.dispose();
    world.scene.remove(this.group);
    world.hitMeshes = world.hitMeshes.filter(m => m.userData.combatant !== this);
    const i = world.combatants.indexOf(this);
    if (i >= 0) world.combatants.splice(i, 1);
  }
}
