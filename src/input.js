import * as THREE from 'three';
import { hasLoS } from './combat.js';

// ============================================================ tunables
// Exposed via window.__game.tuning — aim assist strength especially needs
// hands-on-device iteration, so tweak these live from the console.
export const STICK = {
  deadzone: 0.12,
  expo: 2.0,            // exponential response: out = in^expo on stick magnitude
  yawRate: 4.0,         // rad/s at full deflection (~230°/s)
  pitchRate: 2.8,
  adsSlow: 0.55,        // look-rate multiplier at full ADS
  triggerAt: 0.35,      // analog trigger threshold
};

export const TOUCH = {
  lookSens: 0.0042,     // rad per px of drag on the aim surface
  adsSlow: 0.6,
  stickExpo: 1.8,       // exponential curve on the virtual move stick
};

export const AIM_ASSIST = {
  // friction: look-speed multiplier while the reticle sits inside the slow cone.
  // rotation: fraction of the remaining angular error closed per second.
  gamepad: { friction: 0.45, rotation: 4.5 },
  touch: { friction: 0.42, rotation: 6.0 },   // a touch stronger — thumbs on glass
  range: 42,            // meters; no assist past this
  slowCone: 0.15,       // rad (~8.6°) — friction applies inside
  pullCone: 0.085,      // rad (~4.9°) — rotational pull applies inside
  pullMaxRate: 1.5,     // rad/s cap on the pull
};

// Radial deadzone + exponential response. Returns {x, y, mag} with mag 0..1.
export function stickCurve(x, y, deadzone, expo) {
  const m = Math.hypot(x, y);
  if (m <= deadzone) return { x: 0, y: 0, mag: 0 };
  const n = Math.min(1, (m - deadzone) / (1 - deadzone));
  const c = Math.pow(n, expo);
  return { x: (x / m) * c, y: (y / m) * c, mag: c };
}

// standard-mapping button indices (Xbox layout names)
const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, L3: 10, R3: 11, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15,
};

// Gamepad + touch → player, with aim assist applied to both. Mouse/keyboard
// bypass this entirely (and get no assist).
export class InputHub {
  constructor(player, world, camera, { touch = null, onPause, onResume } = {}) {
    this.player = player;
    this.world = world;
    this.camera = camera;
    this.touch = touch;
    this.onPause = onPause;
    this.onResume = onResume;
    this.prevButtons = [];
    this.gamepadActiveAt = -10;
    this.sprintLatch = false;   // L3 arms it; easing off the stick clears it
    this.rtHeld = false;
    this.ltHeld = false;
    this._fwd = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._best = new THREE.Vector3();
  }

  // true while a pad has produced input recently — lets a controller play
  // without pointer lock and turns its aim assist on
  get gamepadActive() { return performance.now() / 1000 - this.gamepadActiveAt < 3; }

  update(dt, phase) {
    const p = this.player;
    const now = performance.now() / 1000;
    const inMatch = phase === 'match';
    p.padMoveX = 0;
    p.padMoveZ = 0;

    const pad = this._pad();
    let padLook = { x: 0, y: 0, mag: 0 };
    let padMove = { x: 0, y: 0, mag: 0 };

    if (pad) {
      const val = (i) => pad.buttons[i] ? Math.max(pad.buttons[i].value || 0, pad.buttons[i].pressed ? 1 : 0) : 0;
      const pressed = (i) => val(i) > STICK.triggerAt;
      const edge = (i) => pressed(i) && !this.prevButtons[i];

      if (pad.buttons.some((b) => b.pressed) || pad.axes.some((a) => Math.abs(a) > STICK.deadzone)) {
        this.gamepadActiveAt = now;
      }

      if (edge(BTN.START)) {
        if (inMatch) this.onPause?.();
        else if (phase === 'paused') this.onResume?.();
      }

      if (inMatch && p.alive) {
        padMove = stickCurve(pad.axes[0] || 0, pad.axes[1] || 0, STICK.deadzone, STICK.expo);
        padLook = stickCurve(pad.axes[2] || 0, pad.axes[3] || 0, STICK.deadzone, STICK.expo);
        p.padMoveX += padMove.x;
        p.padMoveZ += padMove.y;

        const rt = pressed(BTN.RT);
        if (rt !== this.rtHeld) { rt ? p.onMouseDown(0) : p.onMouseUp(0); this.rtHeld = rt; }
        const lt = pressed(BTN.LT);
        if (lt !== this.ltHeld) { lt ? p.onMouseDown(2) : p.onMouseUp(2); this.ltHeld = lt; }

        if (edge(BTN.A)) p.onKey('Space', true);
        else if (!pressed(BTN.A) && this.prevButtons[BTN.A]) p.onKey('Space', false);
        if (edge(BTN.B)) p.crouchToggled = !p.crouchToggled;
        if (edge(BTN.X)) p.startReload();
        if (edge(BTN.Y)) p.onWheel(1);
        if (edge(BTN.RB)) p.throwGrenade();
        if (edge(BTN.LB) || edge(BTN.R3)) p.knifeOut ? p.onWheel(1) : p.drawKnife();
        if (edge(BTN.DUP)) p.startHeal('medkit');
        if (edge(BTN.DDOWN)) p.startHeal('splint');
        if (edge(BTN.DLEFT)) p.leanToggle = p.leanToggle === -1 ? 0 : -1;
        if (edge(BTN.DRIGHT)) p.leanToggle = p.leanToggle === 1 ? 0 : 1;
        if (edge(BTN.L3)) this.sprintLatch = true;
      } else {
        if (this.rtHeld) { p.onMouseUp(0); this.rtHeld = false; }
        if (this.ltHeld) { p.onMouseUp(2); this.ltHeld = false; }
      }

      this.prevButtons = pad.buttons.map((_, i) => pressed(i));
    }

    // -------- touch --------
    const touchOn = !!(this.touch && this.touch.enabled);
    let touchLook = { dx: 0, dy: 0 };
    let touchMoveMag = 0;
    if (touchOn && inMatch && p.alive) {
      touchLook = this.touch.consumeLook();
      const mv = stickCurve(this.touch.moveX, this.touch.moveY, 0.06, TOUCH.stickExpo);
      p.padMoveX += mv.x;
      p.padMoveZ += mv.y;
      touchMoveMag = mv.mag;
      this.touch.sync();
    } else if (this.touch) {
      this.touch.consumeLook(); // don't bank aim deltas while paused
    }

    // sprint intent: L3 latches until the stick eases off forward or you ADS
    if (padMove.y > -0.4) this.sprintLatch = false;
    if (p.ads > 0.5) this.sprintLatch = false;
    p.sprintHeld = inMatch && (this.sprintLatch || !!(this.touch && this.touch.sprint));

    if (!inMatch || !p.alive) return;

    // -------- aim assist + look --------
    const target = (this.gamepadActive || touchOn) ? this._assistTarget() : null;

    if (padLook.mag > 0) {
      const mult = this._friction(target, AIM_ASSIST.gamepad);
      const adsK = 1 - p.ads * (1 - STICK.adsSlow);
      p.addLook(
        -padLook.x * STICK.yawRate * adsK * mult * dt,
        -padLook.y * STICK.pitchRate * adsK * mult * dt
      );
    }
    if (touchLook.dx || touchLook.dy) {
      const mult = this._friction(target, AIM_ASSIST.touch);
      const adsK = 1 - p.ads * (1 - TOUCH.adsSlow);
      p.addLook(
        -touchLook.dx * TOUCH.lookSens * adsK * mult,
        -touchLook.dy * TOUCH.lookSens * adsK * mult
      );
    }

    // rotational pull only while the player is actively steering or shooting —
    // an idle crosshair never tracks on its own
    const activeIntent = padLook.mag > 0 || padMove.mag > 0.15 || touchMoveMag > 0.15
      || touchLook.dx !== 0 || touchLook.dy !== 0 || p.triggerHeld || p.adsHeld;
    if (target && activeIntent && target.ang < AIM_ASSIST.pullCone) {
      const cfg = touchOn && !this.gamepadActive ? AIM_ASSIST.touch : AIM_ASSIST.gamepad;
      this._applyPull(target, cfg, dt);
    }
  }

  _pad() {
    if (!navigator.getGamepads) return null;
    let fallback = null;
    for (const g of navigator.getGamepads()) {
      if (!g || !g.connected) continue;
      if (g.mapping === 'standard') return g;
      fallback ||= g;
    }
    return fallback;
  }

  // enemy nearest the crosshair inside the slow cone, in range, with line of sight
  _assistTarget() {
    const cam = this.camera;
    cam.getWorldDirection(this._fwd);
    let best = null;
    let bestAng = AIM_ASSIST.slowCone;
    for (const c of this.world.combatants) {
      if (!c.alive || c.team === 'player') continue;
      c.aimPoint(this._aim);
      this._to.copy(this._aim).sub(cam.position);
      const dist = this._to.length();
      if (dist > AIM_ASSIST.range || dist < 1.0) continue;
      this._to.normalize();
      const ang = this._to.angleTo(this._fwd);
      if (ang >= bestAng) continue;
      if (!hasLoS(this.world.colliders, cam.position, this._aim)) continue;
      this._best.copy(this._aim);
      best = { ang, dist, point: this._best };
      bestAng = ang;
    }
    return best;
  }

  // sensitivity slowdown, strongest dead-center, fading out at the cone edge
  _friction(target, cfg) {
    if (!target) return 1;
    const depth = Math.min(1, (1 - target.ang / AIM_ASSIST.slowCone) * 3);
    return 1 - (1 - cfg.friction) * depth;
  }

  _applyPull(target, cfg, dt) {
    const p = this.player;
    const cam = this.camera.position;
    const dx = target.point.x - cam.x;
    const dy = target.point.y - cam.y;
    const dz = target.point.z - cam.z;
    const wantYaw = Math.atan2(-dx, -dz);          // yaw 0 faces -Z
    const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
    let dYaw = wantYaw - p.yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    const dPitch = wantPitch - p.pitch;
    const k = Math.min(1, cfg.rotation * dt);
    const cap = AIM_ASSIST.pullMaxRate * dt;
    const clamp = (v) => Math.max(-cap, Math.min(cap, v));
    p.addLook(clamp(dYaw * k), clamp(dPitch * k));
  }
}
