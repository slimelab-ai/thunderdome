/**
 * What a fighter *knows*, as opposed to what is true.
 *
 * Every bot in this game used to read the live transform of whichever enemy was
 * nearest, every frame, through walls, forever. That single fact is what made
 * stealth meaningless: breaking line of sight changed nothing, because nothing the
 * AI did was ever derived from line of sight in the first place. Repositioning was
 * pointless, decoys impossible, and a fighter chasing you round a pillar tracked the
 * pillar's far side before you got there.
 *
 * A contact is a *belief*: a position, a time it was formed, and a radius of error
 * that grows while nobody refreshes it. Sight writes an exact one. Sound writes a
 * wrong one — deliberately displaced, further out the further away it was. Teammates
 * hand over their own, late and blurred. Nothing here reads a position the fighter
 * has no business having.
 *
 * The contract for callers: *navigate* on the belief, *shoot* on what you can see.
 * A contact never authorises a shot; it authorises going to look.
 *
 * Deliberately free of THREE and of the world object so it can be reasoned about
 * — and tested — as arithmetic. Positions are plain `{x, y, z}`.
 */

const TAU = Math.PI * 2;

/**
 * How fast a stale contact's search radius grows, in metres per second.
 *
 * Well under a sprint (≈6 m/s), because a fighter who has just broken contact is
 * assumed to be *manoeuvring*, not fleeing in a straight line — the area he could
 * be in opens up a good deal slower than the distance he could have covered. Raise
 * this and bots give up almost immediately; lower it and they walk to a stale point
 * with unearned confidence.
 */
export const UNCERTAINTY_GROWTH = 1.6;

/** A search area wider than this is the whole arena: the contact is gone. */
export const LOST_RADIUS = 16;

/** ...and so is one this old, however tight the last fix was. */
export const LOST_AGE = 18;

/** Confidence half-life, in seconds. Only ever used to rank contacts. */
export const CONFIDENCE_TAU = 6;

export const VISION = {
  /**
   * Half the horizontal field of view, in radians.
   *
   * 100° each side — wide, because these fighters are scanning, not staring down a
   * scope, and a narrow cone turns every bot into something you can walk up behind.
   * It still leaves a genuine blind arc behind them, which is the entire point.
   */
  halfFov: (100 * Math.PI) / 180,
  /** Effectively unlimited in a 42×30 m pit; here so the check has a bound. */
  range: 60,
  /** Inside this, facing stops mattering — you notice someone at arm's length. */
  proximity: 4,
};

/**
 * What each kind of noise tells a listener, and how far it carries.
 *
 * `error` is the floor; `errorPerMetre` is what distance adds. A gunshot from 40 m
 * away lands a contact roughly 8.6 m from the truth, which is a direction and a
 * neighbourhood — not a target. That gap is where flanking lives.
 *
 * A gunshot carries further than the arena is wide on purpose: firing is a decision
 * to be located. Moving quietly is the counterplay, and it has to actually work.
 */
export const NOISE = {
  gunshot: { range: 48, error: 3.0, errorPerMetre: 0.14, confidence: 0.8 },
  // Being hit beats merely hearing the bang: crack and thump arrive separately, and
  // the round came at *you*, which is a bearing you did not have to guess. This is
  // the only noise that tightens with the shooter's distance faster than the report
  // it came with — otherwise it would never once beat the gunshot that produced it,
  // and the mechanic would be decoration.
  impact: { range: 35, error: 2.5, errorPerMetre: 0.10, confidence: 0.7 },
  grenade: { range: 26, error: 3.5, errorPerMetre: 0.22, confidence: 0.6 },
  sprint: { range: 15, error: 2.0, errorPerMetre: 0.30, confidence: 0.5 },
};

/** Squad comms: late, and rounded off in the telling. */
export const INTEL = {
  delay: 0.7,
  jitter: 0.5,
  error: 2.2,
  confidence: 0.7,
  /** Don't re-call the same contact more often than this. */
  minGap: 1.6,
};

/** How far an unowned bang carries as something worth walking over to look at. */
export const DISTURBANCE_RANGE = 55;

/** How precise a belief has to be before it is worth spending a grenade on. */
export const GRENADE_MAX_ERROR = 4.5;
/** ...and how recently it has to have been formed. */
export const GRENADE_MAX_AGE = 5;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** How wide the search area around a belief has grown by now, in metres. */
export function contactRadius(contact, now) {
  return contact.error + Math.max(0, now - contact.t) * UNCERTAINTY_GROWTH;
}

/** 0..1, purely for ranking one contact against another. */
export function contactConfidence(contact, now) {
  return contact.confidence * Math.exp(-Math.max(0, now - contact.t) / CONFIDENCE_TAU);
}

export function contactLost(contact, now) {
  return contactRadius(contact, now) > LOST_RADIUS || now - contact.t > LOST_AGE;
}

/** Is a belief good enough to throw a grenade at? Live transforms don't count. */
export function worthGrenading(contact, now) {
  if (!contact) return false;
  if (now - contact.seenAt <= GRENADE_MAX_AGE) return true;
  return contactRadius(contact, now) <= GRENADE_MAX_ERROR && now - contact.t <= GRENADE_MAX_AGE;
}

/**
 * Is `to` inside the cone a fighter at `from` facing `yaw` can actually see?
 *
 * Yaw follows the combat convention: `atan2(dx, dz)`, so forward is
 * `(sin yaw, cos yaw)`. Occlusion is somebody else's job — this is the half of
 * visibility that geometry rays don't cover.
 */
export function withinVision(from, yaw, to, opts = {}) {
  const { halfFov = VISION.halfFov, range = VISION.range, proximity = VISION.proximity } = opts;
  const dx = to.x - from.x, dz = to.z - from.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > range * range) return false;
  if (d2 <= proximity * proximity) return true;
  const d = Math.sqrt(d2);
  const dot = (dx / d) * Math.sin(yaw) + (dz / d) * Math.cos(yaw);
  return dot >= Math.cos(halfFov);
}

/**
 * One fighter's picture of where his enemies are.
 *
 * Keyed by entity, so a contact survives being re-seen, re-heard and re-shared as a
 * single evolving belief rather than a pile of sightings.
 */
export class ContactMemory {
  constructor({ rng = Math.random, owner = null } = {}) {
    this.rng = rng;
    this.owner = owner;
    this.contacts = new Map();
    /** Squad calls in flight: heard, not yet acted on. */
    this.pending = [];
    /** An unowned bang worth walking over to look at. */
    this.disturbance = null;
    this._lastShared = new Map();
  }

  get(entity) { return this.contacts.get(entity) || null; }
  forget(entity) { return this.contacts.delete(entity); }
  get size() { return this.contacts.size; }

  /** A confirmed sighting: exact, and it resets any search in progress. */
  see(entity, pos, now) {
    return this._record(entity, {
      kind: 'visual', x: pos.x, y: pos.y, z: pos.z, error: 0, confidence: 1, t: now,
    });
  }

  /**
   * Line of sight just broke.
   *
   * The belief is left exactly where it was — that stored point *is* the last-known
   * position, and it is what the fighter will go and check.
   */
  markUnseen(entity, now) {
    const c = this.contacts.get(entity);
    if (!c || !c.visible) return c || null;
    c.visible = false;
    c.lostSightAt = now;
    return c;
  }

  /**
   * A noise from `entity`, heard from `listener`.
   *
   * The recorded position is displaced by a random offset inside the error circle,
   * so the belief is genuinely *wrong* rather than fuzzy-but-centred. A bot that
   * always searched the exact origin of a sound would be a bot that can hear
   * through walls with extra steps.
   *
   * Never downgrades a belief that is already tighter than the noise would be.
   */
  hear(entity, pos, kind, listener, now) {
    const spec = NOISE[kind];
    if (!spec) return null;
    const dx = pos.x - listener.x, dz = pos.z - listener.z;
    const dist = Math.hypot(dx, dz);
    if (dist > spec.range) return null;
    const error = spec.error + dist * spec.errorPerMetre;
    const existing = this.contacts.get(entity);
    if (existing && (existing.visible || contactRadius(existing, now) <= error)) return existing;
    const offset = this._scatter(error);
    return this._record(entity, {
      kind: 'sound', noise: kind,
      x: pos.x + offset.x, y: pos.y, z: pos.z + offset.z,
      error, confidence: spec.confidence, t: now,
    });
  }

  /** A bang with nobody's name on it. Somewhere to look when there is nothing better. */
  disturb(pos, now) {
    if (this.disturbance && now - this.disturbance.t < 1) return this.disturbance;
    this.disturbance = { x: pos.x, y: pos.y ?? 0, z: pos.z, t: now };
    return this.disturbance;
  }

  /**
   * Call a live sighting to the rest of the squad.
   *
   * Queued into *their* memories, to land after a comms delay — so a squad converges
   * on where the caller saw you, a beat after he saw you there. Returns how many
   * fighters were told, which is 0 when the contact isn't live or the same call went
   * out moments ago.
   */
  share(entity, now, mates) {
    const c = this.contacts.get(entity);
    if (!c || !c.visible) return 0;
    if (now - (this._lastShared.get(entity) ?? -Infinity) < INTEL.minGap) return 0;
    this._lastShared.set(entity, now);
    let sent = 0;
    for (const mate of mates) {
      const memory = mate?.perception;
      if (!memory || memory === this) continue;
      memory.pending.push({
        entity, x: c.x, y: c.y, z: c.z,
        error: INTEL.error, confidence: c.confidence * INTEL.confidence,
        sentAt: now, at: now + INTEL.delay + memory.rng() * INTEL.jitter,
      });
      sent++;
    }
    return sent;
  }

  /**
   * Advance the picture: land matured squad calls, drop what has gone cold.
   *
   * Returns the contacts that expired this tick, so the caller can report a fighter
   * genuinely losing someone rather than silently forgetting.
   */
  tick(now) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const call = this.pending[i];
      if (call.at > now) continue;
      this.pending.splice(i, 1);
      if (call.entity.alive === false) continue;
      const existing = this.contacts.get(call.entity);
      // Never talk a fighter *out* of something he can see for himself.
      if (existing && (existing.visible || contactRadius(existing, now) <= call.error)) continue;
      const offset = this._scatter(call.error);
      // Timestamped when it was *called*, not when it arrived: the delay is part of
      // how stale the intel is, not something the receiver gets to ignore.
      this._record(call.entity, {
        kind: 'shared', x: call.x + offset.x, y: call.y, z: call.z + offset.z,
        error: call.error, confidence: call.confidence, t: call.sentAt,
      });
    }

    let lost = null;
    for (const [entity, contact] of this.contacts) {
      if (entity.alive === false || contactLost(contact, now)) {
        this.contacts.delete(entity);
        (lost ||= []).push(contact);
      }
    }
    if (this.disturbance && now - this.disturbance.t > 8) this.disturbance = null;
    return lost || [];
  }

  /**
   * Which contact to act on.
   *
   * Something in view beats anything remembered; after that it is confidence against
   * distance, with the usual thumb on the scale for hunting the player, and a bonus
   * for whoever we were already engaging so fighters don't oscillate between two
   * equally plausible ghosts.
   */
  best(now, { from, current = null, playerBias = 0.7, stickiness = 8 } = {}) {
    let best = null, bestScore = -Infinity;
    for (const contact of this.contacts.values()) {
      const dist = Math.hypot(contact.x - from.x, contact.z - from.z);
      const score = (contact.visible ? 100 : 0)
        + contactConfidence(contact, now) * 20
        - dist * (contact.entity.isPlayer ? playerBias : 1) * 0.5
        + (contact.entity === current ? stickiness : 0);
      if (score > bestScore) { bestScore = score; best = contact; }
    }
    return best;
  }

  _scatter(error) {
    const a = this.rng() * TAU;
    const r = Math.sqrt(this.rng()) * error;   // uniform over the disc, not bunched at the centre
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  _record(entity, next) {
    let c = this.contacts.get(entity);
    if (!c) {
      c = { entity, probes: 0, seenAt: -Infinity, lostSightAt: -Infinity, firstAt: next.t };
      this.contacts.set(entity, c);
    }
    const moved = c.x === undefined ? Infinity : Math.hypot(c.x - next.x, c.z - next.z);
    Object.assign(c, next);
    c.visible = next.kind === 'visual';
    if (c.visible) c.seenAt = next.t;
    // New information about *where* restarts the search: probes already walked were
    // walked against a belief that no longer holds.
    if (c.visible || moved > 1.5) { c.probes = 0; c.probeGoal = null; }
    return c;
  }
}

/**
 * Deliver a noise to everyone who could hear it.
 *
 * Only hostiles form contacts — a fighter does not need to be told by ear where his
 * own squad is. A noise with no source (an explosion) is a disturbance for everyone.
 */
export function broadcastNoise(world, source, pos, kind, now, weight = 1, dir = null) {
  let heard = 0;
  for (const listener of world.combatants) {
    if (!listener.alive || !listener.perception) continue;
    if (!source) {
      if (Math.hypot(pos.x - listener.pos.x, pos.z - listener.pos.z) > DISTURBANCE_RANGE) continue;
      listener.perception.disturb(pos, now);
      heard++;
      continue;
    }
    if (listener === source || listener.team === source.team) continue;
    // `weight` carries how threatening the weapon is, which matters to how pinned a
    // listener feels but not at all to how well he can place the bang.
    if (listener.hearNoise(source, pos, kind, now, weight, dir)) heard++;
  }
  return heard;
}

/** Clamp a believed position back inside the pit, so searches never leave it. */
export function clampToArena(pos, xLimit = 20, zLimit = 14.5) {
  return { x: clamp(pos.x, -xLimit, xLimit), y: pos.y || 0, z: clamp(pos.z, -zLimit, zLimit) };
}
