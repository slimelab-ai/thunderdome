/**
 * Recoil, modelled on DogEater's.
 *
 * The idea it is built on is that recoil is *not* a change to where you are aiming.
 * It is an offset layered on top of your aim, which the weapon pushes and which
 * recovers on its own — so a burst walks the sights up and then puts them back
 * exactly where you were pointing, without the player having to correct anything.
 * That is what makes a pattern learnable: it is repeatable, and it costs you nothing
 * if you simply stop shooting.
 *
 * Four parts, in the order they matter:
 *
 * **A pattern, not a random walk.** Each weapon carries a list of kicks, one per
 * shot, indexed in order and repeated if the magazine outlasts it. The same burst
 * always walks the same way, so it can be learned and fought. A little randomness is
 * added on top so it is not a machine.
 *
 * **Velocity, then position.** A shot adds angular *velocity*; position integrates it
 * and the velocity decays. The sights therefore accelerate away and coast, rather
 * than teleporting, and a fast weapon stacks its kicks into a climb.
 *
 * **Drawback.** Once the velocity has bled off below a threshold, the offset eases
 * back to zero over a duration proportional to how far it went — a long burst takes
 * longer to settle than a tap, and both are bounded. Firing again interrupts it.
 *
 * **The player can fight it, and fighting it is free.** Look input that *opposes* the
 * current offset is absorbed into the offset instead of moving the aim. Pull down
 * against a rising gun and you cancel the climb rather than dragging your aim below
 * where you started — which is what happens in a game that simply adds recoil to your
 * pitch, and why pulling down there always overshoots.
 */

/** Ease that starts and ends at rest. DogEater's `Util.CosAlpha`. */
export function cosAlpha(a) {
  return (-Math.cos(Math.max(0, Math.min(1, a)) * Math.PI) + 1) / 2;
}

/**
 * Tuning shared by every weapon. Per-weapon character lives in the pattern.
 *
 * Angles are degrees, and `x` is rightward while `y` is upward — the convention the
 * patterns in src/weapons.js are written in.
 */
export const RECOIL_TUNING = {
  multiplier: 1,
  recoverySpeed: 5,        // how fast the kick velocity bleeds off
  drawbackThreshold: 1.2,  // deg/s below which the offset starts easing home
  drawbackSpeed: 1,        // degrees per second of drawback, before clamping
  drawbackMinDuration: 0.05,
  drawbackMaxDuration: 0.6,
};

export class Recoil {
  constructor(tuning = RECOIL_TUNING) {
    this.t = tuning;
    this.velX = 0; this.velY = 0;      // deg/s
    this.posX = 0; this.posY = 0;      // deg, the offset applied to the camera
    this.drawback = false;
    this.drawbackAt = 0;
    this.drawbackFromX = 0; this.drawbackFromY = 0;
    // Nothing is happening and nothing needs to: the cheap path, and also what
    // guarantees the offset is *exactly* zero between engagements rather than a
    // residue that accumulates over a match.
    this.stable = true;
    this.clock = 0;
  }

  reset() {
    this.velX = this.velY = this.posX = this.posY = 0;
    this.drawback = false;
    this.stable = true;
  }

  /** Kick, in degrees per second. `x` right, `y` up. */
  add(x, y) {
    this.velX += x * this.t.multiplier;
    this.velY += y * this.t.multiplier;
  }

  /**
   * Look input, in degrees. Returns how much of it should actually move the aim.
   *
   * Input against the offset is spent cancelling it. Pulling down on a climbing gun
   * therefore brings the sights back to where they were pointing and stops, instead
   * of continuing on past — the offset is what moved, so the offset is what the
   * correction should consume.
   */
  applyLook(dx, dy) {
    if (dx === 0 && dy === 0) return { x: 0, y: 0 };
    // Any deliberate input means the player has taken over; stop easing home.
    this.drawback = false;
    if (dx !== 0 || dy !== 0) this.stable = false;
    let aimX = dx, aimY = dy;
    if (dy * this.posY < 0) { this.posY += dy; aimY = 0; }
    if (dx * this.posX < 0) { this.posX += dx; aimX = 0; }
    return { x: aimX, y: aimY };
  }

  update(dt) {
    this.clock += dt;
    const t = this.t;

    if (this.stable) {
      this.posX = 0; this.posY = 0;
      this.drawback = false;
      if (this.velX !== 0 || this.velY !== 0) this.stable = false;
      else return;
    }

    const speed = Math.hypot(this.velX, this.velY);
    const wantDrawback = speed <= t.drawbackThreshold;
    if (!this.drawback && wantDrawback) {
      this.drawback = true;
      this.drawbackAt = this.clock;
      this.drawbackFromX = this.posX;
      this.drawbackFromY = this.posY;
      this.velX = 0; this.velY = 0;
    } else if (this.drawback && !wantDrawback) {
      // A fresh shot landed mid-recovery. The climb continues from where it was.
      this.drawback = false;
    }

    if (this.drawback) {
      const from = Math.hypot(this.drawbackFromX, this.drawbackFromY);
      if (from > 0) {
        const dur = Math.min(Math.max((1 / t.drawbackSpeed) * from, t.drawbackMinDuration),
          t.drawbackMaxDuration);
        const a = (this.clock - this.drawbackAt) / dur;
        if (a >= 1) this.stable = true;
        const k = cosAlpha(a);
        this.posX = this.drawbackFromX * (1 - k);
        this.posY = this.drawbackFromY * (1 - k);
      } else {
        this.stable = true;
      }
    } else {
      this.posX += this.velX * dt;
      this.posY += this.velY * dt;
    }

    const decay = Math.min(1, dt * t.recoverySpeed);
    this.velX += (0 - this.velX) * decay;
    this.velY += (0 - this.velY) * decay;
  }
}

/**
 * Walks a weapon's pattern, one entry per shot.
 *
 * The index resets after `cooldown` without firing, so every burst starts at the top
 * of the pattern and the first shot of an engagement is always the same. A magazine
 * longer than the pattern wraps rather than running out of recoil.
 */
export class RecoilPattern {
  constructor(weapon) {
    this.set(weapon);
  }

  set(weapon) {
    this.pattern = (weapon && weapon.recoilPattern) || [[0, 1]];
    this.velocity = (weapon && weapon.recoilVelocity) ?? 40;
    this.random = (weapon && weapon.recoilRandom) ?? 0;
    this.cooldown = (weapon && weapon.recoilCooldown) ?? 0.7;
    this.index = 0;
    this.lastFire = -Infinity;
  }

  /** The kick for this shot, in degrees per second. */
  next(now, rand = Math.random) {
    if (!this.pattern.length) return { x: 0, y: 0 };
    if (now > this.lastFire + this.cooldown) this.index = 0;
    if (this.index >= this.pattern.length) this.index = 0;
    const [px, py] = this.pattern[this.index++];
    this.lastFire = now;
    // Random point in the unit disc, so the scatter is round rather than square.
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    return {
      x: px * this.velocity + Math.cos(a) * r * this.random,
      y: py * this.velocity + Math.sin(a) * r * this.random,
    };
  }
}
