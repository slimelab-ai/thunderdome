import * as THREE from 'three';
import { hasLoS } from './combat.js';

// ============================================================ tunables
// Exposed via window.__game.tuning — aim assist strength especially needs
// hands-on-device iteration, so tweak these live from the console.
export const STICK = {
  deadzone: 0.12,
  expo: 2.0,            // movement-stick exponent; look response is user-tunable
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
  // Gamepad deliberately stays Halo-like: a narrow, mild slowdown with only
  // enough rotational pull to soften micro-corrections, never steer the aim.
  gamepad: { friction: 0.78, rotation: 1.0, slowCone: 0.105, pullCone: 0.04 },
  touch: { friction: 0.42, rotation: 6.0, slowCone: 0.15, pullCone: 0.085 },
  range: 42,            // meters; no assist past this
  pullMaxRate: 1.5,     // rad/s cap on the pull
};

export const DEFAULT_CONTROLLER_SETTINGS = Object.freeze({
  sensitivity: 0.65,
  exponent: 2.15,
  aimAssist: 0.35,
});

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
const MENU_HOLD_SECONDS = 0.55;

// Gamepad + touch → player, with aim assist applied to both. Mouse/keyboard
// bypass this entirely (and get no assist).
export class InputHub {
  constructor(player, world, camera, {
    touch = null, onPause, onResume, onCycleSpectator, onMenuInput, onControllerActive, onControllerSample,
    controllerSettings = DEFAULT_CONTROLLER_SETTINGS,
  } = {}) {
    this.player = player;
    this.world = world;
    this.camera = camera;
    this.touch = touch;
    this.onPause = onPause;
    this.onResume = onResume;
    this.onCycleSpectator = onCycleSpectator;
    this.onMenuInput = onMenuInput;
    this.onControllerActive = onControllerActive;
    this.onControllerSample = onControllerSample;
    this.controllerSettings = { ...DEFAULT_CONTROLLER_SETTINGS, ...controllerSettings };
    this.prevButtons = [];
    this.menuYHeldFor = 0;
    this.menuYHoldFired = false;
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

  setControllerSettings(settings) {
    this.controllerSettings = { ...this.controllerSettings, ...settings };
  }

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

      if (pad.buttons.some((b) => b.pressed || (b.value || 0) > STICK.triggerAt)
        || pad.axes.some((a) => Math.abs(a) > STICK.deadzone)) {
        this.gamepadActiveAt = now;
        this.onControllerActive?.();
      }
      padLook = stickCurve(
        pad.axes[2] || 0, pad.axes[3] || 0,
        STICK.deadzone, this.controllerSettings.exponent
      );
      this.onControllerSample?.({
        raw: Math.min(1, Math.hypot(pad.axes[2] || 0, pad.axes[3] || 0)),
        curved: padLook.mag,
      });

      if (edge(BTN.START)) {
        if (inMatch) this.onPause?.();
        else if (phase === 'paused') this.onResume?.();
        else if (phase === 'shop' || phase === 'intro') this.onMenuInput?.('advance');
      }

      if (!inMatch) {
        const ax = pad.axes[0] || 0;
        const ay = pad.axes[1] || 0;
        const cursor = stickCurve(ax, ay, 0.14, 1.45);
        if (cursor.mag > 0) {
          this.onMenuInput?.({
            type: 'cursorMove',
            x: cursor.x,
            y: cursor.y,
            magnitude: cursor.mag,
            dt,
          });
        }
        if (edge(BTN.A)) this.onMenuInput?.('activate');
        if (edge(BTN.B)) this.onMenuInput?.('back');
        if (edge(BTN.X)) this.onMenuInput?.('alternate');
        if (pressed(BTN.Y)) {
          if (!this.prevButtons[BTN.Y]) {
            this.menuYHeldFor = 0;
            this.menuYHoldFired = false;
          }
          this.menuYHeldFor += dt;
          if (!this.menuYHoldFired && this.menuYHeldFor >= MENU_HOLD_SECONDS) {
            this.menuYHoldFired = true;
            this.onMenuInput?.('sell');
          }
        } else if (this.prevButtons[BTN.Y]) {
          this.menuYHeldFor = 0;
          this.menuYHoldFired = false;
        }
        if (edge(BTN.DUP)) this.onMenuInput?.('patch');
        if (edge(BTN.LB)) this.onMenuInput?.('previousTab');
        if (edge(BTN.RB)) this.onMenuInput?.('nextTab');
        if (edge(BTN.LT)) this.onMenuInput?.('nextPanel');
        if (edge(BTN.RT)) this.onMenuInput?.('previousPanel');
      } else {
        this.menuYHeldFor = 0;
        this.menuYHoldFired = false;
      }

      if (inMatch && p.alive) {
        padMove = stickCurve(pad.axes[0] || 0, pad.axes[1] || 0, STICK.deadzone, STICK.expo);
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
        if (inMatch && !p.alive) {
          // dead and spectating: d-pad / bumpers switch fighters
          if (edge(BTN.DLEFT) || edge(BTN.LB)) this.onCycleSpectator?.(-1);
          if (edge(BTN.DRIGHT) || edge(BTN.RB)) this.onCycleSpectator?.(1);
        }
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
    } else if (this.touch) {
      this.touch.consumeLook(); // don't bank aim deltas while paused
    }
    if (touchOn) this.touch.sync(); // keep toggle highlights honest even while dead

    // sprint intent: L3 latches until the stick eases off forward or you ADS
    if (padMove.y > -0.4) this.sprintLatch = false;
    if (p.ads > 0.5) this.sprintLatch = false;
    p.sprintHeld = inMatch && (this.sprintLatch || !!(this.touch && this.touch.sprint));

    if (!inMatch || !p.alive) return;

    // -------- aim assist + look --------
    const usingTouchAssist = touchOn && !this.gamepadActive;
    const assistCfg = usingTouchAssist ? AIM_ASSIST.touch : AIM_ASSIST.gamepad;
    const assistStrength = usingTouchAssist ? 1 : this.controllerSettings.aimAssist;
    const target = (this.gamepadActive || touchOn) ? this._assistTarget(assistCfg) : null;

    if (padLook.mag > 0) {
      const mult = this._friction(target, AIM_ASSIST.gamepad, this.controllerSettings.aimAssist);
      const adsK = 1 - p.ads * (1 - STICK.adsSlow);
      p.addLook(
        -padLook.x * STICK.yawRate * this.controllerSettings.sensitivity * adsK * mult * dt,
        -padLook.y * STICK.pitchRate * this.controllerSettings.sensitivity * adsK * mult * dt
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

    // Rotational pull only while the player is actively steering. Merely
    // aiming or firing never makes an idle crosshair track by itself.
    const activeIntent = padLook.mag > 0 || padMove.mag > 0.15 || touchMoveMag > 0.15
      || touchLook.dx !== 0 || touchLook.dy !== 0;
    if (target && activeIntent && target.ang < assistCfg.pullCone) {
      this._applyPull(target, assistCfg, dt, assistStrength);
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
  _assistTarget(cfg = AIM_ASSIST.gamepad) {
    const cam = this.camera;
    cam.getWorldDirection(this._fwd);
    let best = null;
    let bestAng = cfg.slowCone;
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
  _friction(target, cfg, strength = 1) {
    if (!target) return 1;
    const depth = Math.min(1, (1 - target.ang / cfg.slowCone) * 3);
    return 1 - (1 - cfg.friction) * depth * strength;
  }

  _applyPull(target, cfg, dt, strength = 1) {
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
    const k = Math.min(1, cfg.rotation * strength * dt);
    const cap = AIM_ASSIST.pullMaxRate * strength * dt;
    const clamp = (v) => Math.max(-cap, Math.min(cap, v));
    p.addLook(clamp(dYaw * k), clamp(dPitch * k));
  }
}
