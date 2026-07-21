import * as THREE from 'three';
import { WEAPONS, buildHeldGun } from './weapons.js';
import { fireRay, applySpread, hasLoS, resolveCircle, groundHeight, STEP_REACH } from './combat.js';
import { audio } from './audio.js';

const SKIN_TONES = [0xc9a17c, 0x8a5a3b, 0x6b4226, 0xd9b28c, 0x5a3a24];
const UP = new THREE.Vector3(0, 1, 0);
const _peekEye = new THREE.Vector3();

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
    this.scale = opts.scale || (0.95 + Math.random() * 0.09); // natural height variety
    this.shirt = opts.shirt;
    this.alive = true;
    this.isPlayer = false;

    this.armDmg = 0;   // 0..1 → worse aim
    this.legDmg = 0;   // 0..1 → slower, limp

    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.radius = 0.42 * this.scale;
    this.baseSpeed = (2.9 + Math.random() * 0.3) * (opts.skill.speedMult || 1) * (this.boss ? 0.85 : 1);

    // AI state
    this.target = null;
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
    this.healingT = 0;
    this.sinceHit = 99;
    // stance: crouch cycling + cosmetic lean so heads aren't all at one height
    this.crouchK = 1;
    this.stanceCrouch = false;
    this.stanceTimer = 0.5 + Math.random() * 2;
    this.leanK = 0;
    this.peekSide = 0;
    this.sprintNow = false;
    // patience: holding an angle too long without moving triggers a push
    this.stallAnchor = { x: 0, z: 0 };
    this.stallT = 0;
    this.pushT = 0;
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

  _buildBody() {
    const g = new THREE.Group();
    const s = this.scale;
    const skin = new THREE.MeshLambertMaterial({ color: SKIN_TONES[(Math.random() * SKIN_TONES.length) | 0] });
    const shirtMat = new THREE.MeshLambertMaterial({ color: this.shirt });
    const pantsMat = new THREE.MeshLambertMaterial({ color: 0x24242c });

    const mk = (geoArgs, mat, part, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(...geoArgs), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.userData = { combatant: this, part };
      g.add(m);
      return m;
    };

    // torso (pivot center)
    this.torso = mk([0.46, 0.58, 0.26], shirtMat, 'torso', 0, 1.14, 0);
    if (this.armorParts.body > 0) {
      const vest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.3), new THREE.MeshLambertMaterial({ color: 0x14161a }));
      vest.position.set(0, 1.16, 0);
      vest.userData = { combatant: this, part: 'torso' };
      g.add(vest);
      this.vest = vest;
    }

    // head
    const headMat = this.boss ? new THREE.MeshLambertMaterial({ color: 0xd4af37 }) : skin;
    this.head = mk([0.26, 0.28, 0.26], headMat, 'head', 0, 1.57, 0);
    if (this.boss) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 0.02), new THREE.MeshBasicMaterial({ color: 0xff2020 }));
      eye.position.set(0, 1.6, 0.14);
      g.add(eye);
      this.bossEye = eye;
    }

    // limbs: geometry translated so pivot = top of limb
    const limb = (w, h, d, mat, part, x, y) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.translate(0, -h / 2, 0);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, 0);
      m.castShadow = true;
      m.userData = { combatant: this, part };
      g.add(m);
      return m;
    };
    this.armL = limb(0.14, 0.58, 0.14, shirtMat, 'armL', -0.31, 1.4);
    this.armR = limb(0.14, 0.58, 0.14, shirtMat, 'armR', 0.31, 1.4);
    this.legL = limb(0.17, 0.85, 0.17, pantsMat, 'legL', -0.12, 0.85);
    this.legR = limb(0.17, 0.85, 0.17, pantsMat, 'legR', 0.12, 0.85);

    // held gun on right arm
    this.gun = buildHeldGun(this.weaponId);
    this.gun.position.set(0.31, 0.9, -0.25);
    g.add(this.gun);

    // name tag
    this.tag = nameTagSprite(this.name, this.team === 'player' ? '#86ff3c' : '#ff5a5a');
    this.tag.position.y = 1.95;
    g.add(this.tag);

    g.scale.setScalar(s);
    this.group = g;
    this.parts = [this.head, this.torso, this.armL, this.armR, this.legL, this.legR];
    if (this.vest) this.parts.push(this.vest);
  }

  addTo(world, pos) {
    this.pos.copy(pos);
    this.group.position.copy(pos);
    world.scene.add(this.group);
    world.combatants.push(this);
    for (const p of this.parts) world.hitMeshes.push(p);
    this.group.updateMatrixWorld(true);
  }

  eyePos(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.55 * this.scale * this.crouchK, this.pos.z);
  }
  aimPoint(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.15 * this.scale * this.crouchK, this.pos.z);
  }

  applyDamage(world, part, dmg, shooter, point) {
    if (!this.alive) return;
    this.sinceHit = 0;
    this.healingT = 0; // getting shot interrupts bandaging
    if (part === 'torso') dmg *= (1 - this.armorParts.body);
    else if (part === 'head') dmg *= (1 - this.armorParts.head);
    else dmg *= (1 - this.armorParts.limbs);
    if (this.boss && part === 'head') dmg *= 0.55; // gold mask
    this.hp -= dmg;

    if (part === 'armL' || part === 'armR') this.armDmg = Math.min(1, this.armDmg + 0.4);
    if (part === 'legL' || part === 'legR') this.legDmg = Math.min(1, this.legDmg + 0.4);

    world.fx.blood(point);
    const camDist = point.distanceTo(world.cameraPos);
    if (camDist < 25) audio.hitFlesh();

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
    // remove hitboxes
    world.hitMeshes = world.hitMeshes.filter(m => m.userData.combatant !== this);
    audio.hurt();
    // squadmates who watch this go down get cautious: no more single-file feeding
    // into whatever corner just killed their buddy
    for (const c of world.combatants) {
      if (c !== this && c.alive && c.team === this.team && c.pos.distanceTo(this.pos) < 9) {
        c.cautionT = Math.max(c.cautionT, 0.9 + Math.random() * 1.1);
      }
    }
    world.onKill(killer, this, part);
    if (killer.isPlayer) world.onHitmarker(true, part === 'head');
  }

  update(world, dt) {
    if (!this.alive) {
      // death fall + fade
      this.deathT += dt;
      if (this.deathT < 0.4) {
        const t = this.deathT / 0.4;
        this.group.rotation.x = -Math.PI / 2 * t * (this.fallFwd ?? (this.fallFwd = Math.random() < 0.5 ? 1 : -1));
        this.group.position.y = this.pos.y + 0.1 * Math.sin(t * Math.PI);
      }
      if (this.deathT > 0.5 && !this.pooled) {
        this.pooled = true;
        world.fx.bloodPool(this.pos);
      }
      if (this.deathT > 6) {
        this.fadeT += dt;
        const op = Math.max(0, 1 - this.fadeT / 1.5);
        this.group.traverse(o => {
          if (o.material && !o.isSprite) { o.material.transparent = true; o.material.opacity = op; }
        });
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
        this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.45);
        this.armDmg = 0;
        this.legDmg = 0;
      }
    }

    // patience meter: parked in one spot with a live target → eventually surge
    const sdx = this.pos.x - this.stallAnchor.x, sdz = this.pos.z - this.stallAnchor.z;
    if (sdx * sdx + sdz * sdz > 9) {
      this.stallAnchor.x = this.pos.x; this.stallAnchor.z = this.pos.z;
      this.stallT = 0;
    } else if (this.target) {
      this.stallT += dt;
      if (this.stallT > 8) {
        this.stallT = 0;
        this.pushT = 3.5 + Math.random() * 1.5;
      }
    }
    if (this.pushT > 0) this.pushT -= dt;

    // stance cycling while engaged: pop up, drop down — heads at varied heights
    this.stanceTimer -= dt;
    if (this.stanceTimer <= 0) {
      this.stanceCrouch = !this.stanceCrouch && Math.random() < 0.45;
      this.stanceTimer = this.stanceCrouch ? 0.9 + Math.random() * 1.1 : 1.1 + Math.random() * 1.9;
    }

    // ---- acquire target ----
    if (this.thinkTimer <= 0 || (this.target && !this._targetAlive())) {
      this.thinkTimer = 0.35 + Math.random() * 0.25;
      this.target = this._acquire(world);
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

    this._traveling = false;
    this._strafing = false;
    this.sprintNow = false;

    if (this.target && !fleeing && this.healingT <= 0) {
      const tp = this._targetPos();
      const dx = tp.x - this.pos.x, dz = tp.z - this.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const fx = dx / (dist || 1), fz = dz / (dist || 1);
      const engage = w.aiRange * (this.boss ? 1.15 : 1);

      if (this.strafeTimer <= 0) {
        this.strafeDir *= -1;
        this.strafeTimer = 1.1 + Math.random() * 1.6;
      }

      // geometric sightline to target — with no sight, range means nothing: keep hunting
      const eye = this.eyePos();
      const aim = this.target.isPlayer
        ? new THREE.Vector3(this.target.pos.x, this.target.pos.y + 1.25 * this.target.heightScale, this.target.pos.z)
        : this.target.aimPoint();
      const sight = hasLoS(world.colliders, eye, aim);

      // corner peek: body stays covered, lean the head/gun out sideways for an angle
      this.peekSide = 0;
      if (!sight && dist < engage * 1.8) {
        for (const side of [this.strafeDir, -this.strafeDir]) {
          _peekEye.set(eye.x + -fz * 0.6 * side, eye.y, eye.z + fx * 0.6 * side);
          if (hasLoS(world.colliders, _peekEye, aim)) { this.peekSide = side; break; }
        }
      }

      // patch up when hurt and out of contact
      if (this.healKits > 0 && this.hp < this.maxHp * 0.38 && this.sinceHit > 2.2 && (!sight || dist > engage * 1.6)) {
        this.healKits--;
        this.healingT = 2.1;
      }
      // frag the target's hiding spot when we can't get an angle
      if (this.nades > 0 && this.nadeCd <= 0 && !sight && dist > 6 && dist < 18 && world.throwGrenade && Math.random() < dt * 0.55) {
        this.nades--;
        this.nadeCd = 13 + Math.random() * 8;
        const ndx = tp.x - this.pos.x, ndz = tp.z - this.pos.z;
        const nd = Math.hypot(ndx, ndz) || 1;
        const nspd = Math.min(12.5, Math.max(7, nd * 0.78));
        const jit = () => 1 + (Math.random() - 0.5) * 0.14;
        world.throwGrenade(this.eyePos(), new THREE.Vector3((ndx / nd) * nspd * jit(), 4.3, (ndz / nd) * nspd * jit()), this);
      }

      // close-range fighters storm high ground; long-range fighters hold and shoot up
      const targetY = this.target.pos.y;
      const heightGap = targetY - this.pos.y;
      const pushHigh = heightGap > 0.8 && w.aiRange <= 15;
      this._onVerticalRoute = false;

      const needTravel = dist > engage || (!sight && !this.peekSide) || pushHigh || this.pushT > 0;
      if (needTravel && this.cautionT > 0) {
        // a squadmate just died up ahead — hold and jink instead of feeding the corner
        this._strafing = true;
        move.x += -fz * this.strafeDir * 0.7; move.z += fx * this.strafeDir * 0.7;
      } else if (needTravel) {
        this._traveling = true;
        this.sprintNow = (dist > 11 || !sight) && this.legDmg < 0.6;
        // travel toward the target through the 3D navmesh.
        // walkableLine is expensive — evaluate it on the repath cadence, not per frame
        this.repathT = (this.repathT ?? 0) - dt;
        if (this.repathT <= 0) {
          this.repathT = 0.45 + Math.random() * 0.35;
          const tpY = this.target.pos.y;
          this._straightOK = world.nav ? world.nav.walkableLine(this.pos.x, this.pos.z, this.pos.y, tp.x, tp.z, tpY) : true;
          if (this._straightOK) {
            this.path = null;
          } else {
            this.path = world.nav.findPath(this.pos, { x: tp.x, y: tpY, z: tp.z }, this.navSeed, this.flankSide);
            this.pathIdx = 0;
          }
        }
        if (this._straightOK || !this.path || !this.path.length) {
          move.x += fx; move.z += fz;
        } else {
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
      } else if (this.peekSide && !sight) {
        // holding a corner peek: plant and shoot around it
        this._strafing = true;
      } else if (dist < engage * 0.45 && this.weaponId !== 'shotgun' && heightGap < 0.8) {
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
      const los = dist < engage * 2.2 && (sight || this.peekSide !== 0) && !this.sprintNow;

      // point-blank surprises get answered fast; long-range spotting takes longer
      if (los && !this.hadLoS) this.reactionLeft = this.skill.reaction * (0.7 + Math.random() * 0.6) * Math.min(1.2, Math.max(0.35, dist / 12));
      this.hadLoS = los;
      if (this.reactionLeft > 0) this.reactionLeft -= dt;

      if (los && this.reactionLeft <= 0 && this.cooldown <= 0 && Math.abs(dy) < 0.35) {
        // fire from the peeked eye when leaning around a corner
        const fireEye = this.peekSide
          ? eye.clone().set(eye.x + -fz * 0.6 * this.peekSide, eye.y, eye.z + fx * 0.6 * this.peekSide)
          : eye;
        const dir = aim.clone().sub(fireEye).normalize();
        const distFactor = 0.7 + dist / 30;
        const spreadDeg = w.spread * this.skill.spreadMult * (1 + this.armDmg * 1.4) * distFactor * (this.crouchK < 0.9 ? 0.8 : 1);
        const pellets = w.pellets;
        for (let i = 0; i < pellets; i++) {
          const sdir = applySpread(dir, spreadDeg + (pellets > 1 ? 3.5 : 0));
          const res = fireRay(world, this, fireEye, sdir, w, this.team === 'enemy' ? world.enemyDmgScale : 1);
          world.fx.tracer(fireEye.clone().addScaledVector(sdir, 0.6), res.point);
          if (res.type === 'wall') { world.fx.sparks(res.point); if (Math.random() < 0.3) audio.ricochet(); }
        }
        const camDist = fireEye.distanceTo(world.cameraPos);
        audio.shot(w.sound, 1.2 / (1 + camDist * 0.09));
        world.fx.muzzleFlash(fireEye.clone().addScaledVector(dir, 0.7));

        this.burstLeft--;
        if (this.burstLeft <= 0) {
          this.burstLeft = this._burstSize();
          this.cooldown = (60 / w.rpm) + 0.5 + Math.random() * 0.5 + (w.auto ? 0.2 : 0);
        } else {
          this.cooldown = 60 / w.rpm;
        }
      }
    } else if (!this.target) {
      // idle scan
      this.yaw += Math.sin(performance.now() * 0.0005 + this.animPhase) * dt * 0.5;
    }

    // ---- stay out of the boss's line of fire ---- (crew only)
    if (this.team === 'player' && world.playerProxy.alive && world.playerAim) {
      const pp = world.playerProxy;
      const rx = this.pos.x - pp.pos.x, rz = this.pos.z - pp.pos.z;
      const along = rx * world.playerAim.x + rz * world.playerAim.z;
      if (along > 0.3 && along < 15) {
        // perpendicular offset from the aim line
        const px = rx - world.playerAim.x * along, pz = rz - world.playerAim.z * along;
        const pd = Math.hypot(px, pz);
        if (pd < 1.9) {
          const strength = (1.9 - pd) * 3.2;
          if (pd > 0.05) { move.x += (px / pd) * strength; move.z += (pz / pd) * strength; }
          else { move.x += -world.playerAim.z * strength; move.z += world.playerAim.x * strength; }
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
      const spd = this.baseSpeed * speedMult * (this.crouchK < 0.9 ? 0.55 : 1) * (this.sprintNow ? 1.45 : 1);
      this.pos.addScaledVector(chosen, spd * dt);
      resolveCircle(this.pos, this.radius, world.colliders, this.pos.y);
      moving = true;
      this.animPhase += dt * spd * 2.6;
      this.moveAmount = Math.min(1, this.moveAmount + dt * 6);
    } else {
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
    // articulated crouch: torso/head sink, hips drop, legs fold — a real squat,
    // and the hitboxes (same meshes) follow the pose
    const wantCrouch = this.healingT > 0 || (this._strafing && this.stanceCrouch) || (this.cautionT > 0 && !this._traveling);
    this.crouchK += ((wantCrouch ? 0.72 : 1) - this.crouchK) * Math.min(1, dt * 8);
    const drop = (1 - this.crouchK) * 1.55;
    const legBend = Math.acos(Math.max(0.2, Math.min(1, (0.85 - drop) / 0.85)));
    // peeking leans harder than plain strafing
    const leanTarget = this.peekSide ? -this.peekSide * 0.26 : (this._strafing ? -this.strafeDir * 0.09 : 0);
    this.leanK += (leanTarget - this.leanK) * Math.min(1, dt * 6);

    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.group.rotation.z = this.leanK;

    this.torso.position.y = 1.14 - drop;
    if (this.vest) this.vest.position.y = 1.16 - drop;
    this.head.position.y = 1.57 - drop;
    if (this.bossEye) this.bossEye.position.y = 1.6 - drop;
    this.armL.position.y = 1.4 - drop;
    this.armR.position.y = 1.4 - drop;
    this.legL.position.y = 0.85 - drop;
    this.legR.position.y = 0.85 - drop;

    const sw = Math.sin(this.animPhase) * 0.55 * this.moveAmount * (this.crouchK < 0.9 ? 0.5 : 1);
    const limp = this.legDmg > 0.3;
    this.legL.rotation.x = sw * (limp ? 0.4 : 1) + legBend;
    this.legR.rotation.x = -sw - legBend * 0.85;
    this.armL.rotation.x = -sw * 0.7;
    // right arm holds gun raised toward target (slung while sprinting)
    const gunUp = this.target && !this.sprintNow;
    this.armR.rotation.x = gunUp ? -1.25 : -sw * 0.7;
    this.gun.visible = true;
    this.gun.position.set(0.31, (gunUp ? 1.35 : 0.9) - drop, gunUp ? -0.35 : -0.25);
    this.gun.rotation.x = gunUp ? -0.06 : 0.3;
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

  _acquire(world) {
    let best = null, bestD = Infinity;
    const consider = (c) => {
      if (!c.alive) return;
      const d = this.pos.distanceToSquared(c.pos) * (c.isPlayer ? 0.7 : 1); // slight bias to hunt the player
      if (d < bestD) { bestD = d; best = c; }
    };
    if (this.team === 'enemy') {
      consider(world.playerProxy);
      for (const c of world.combatants) if (c.team === 'player') consider(c);
    } else {
      for (const c of world.combatants) if (c.team === 'enemy') consider(c);
    }
    return best;
  }

  _targetPos() {
    return this.target.pos;
  }

  removeFrom(world) {
    world.scene.remove(this.group);
    world.hitMeshes = world.hitMeshes.filter(m => m.userData.combatant !== this);
    const i = world.combatants.indexOf(this);
    if (i >= 0) world.combatants.splice(i, 1);
  }
}
