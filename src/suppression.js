/**
 * Where it is currently lethal to stand.
 *
 * Perception answers "where is he"; this answers "which ground is he covering",
 * which is a different question and the one the AI kept getting wrong. Fighters
 * would file round a corner one at a time into a rifle that had been firing into
 * that doorway for six seconds and had already killed two of them. Nothing in the
 * AI was accumulating that — every approach was planned as if the pit were empty.
 *
 * A lane is a firing position with heat. Every round heard from it adds heat; heat
 * bleeds away when the shooting stops. Above a threshold the lane is *hot*, and the
 * ground it can see is ground you do not walk across. A squadmate dying to a lane
 * marks it deadly outright for a while, regardless of how much it is still firing —
 * that is the difference between "someone is shooting" and "that angle kills you".
 *
 * The counterplay falls out of the arithmetic rather than being scripted: heat
 * decays, so a fighter who holds instead of pushing is waiting for the gun to run
 * dry, and pushes in the gap. Suppress, and they stop coming. Stop, and they come.
 *
 * Free of THREE and of the world, like `perception.js` — line of sight arrives as a
 * callback, so this is geometry and bookkeeping that can be tested as arithmetic.
 */

export const SUPPRESSION = {
  /** Heat per round heard from a position. */
  shot: 1,
  /** ...and per squadmate who dies to it. */
  kill: 4,
  /** Heat bled per second of silence. */
  decay: 2,
  /** At or above this, the lane is being actively worked. */
  hot: 3.5,
  /**
   * Ceiling on heat.
   *
   * Sets how long a lane stays dangerous *after* the firing stops: from the cap it
   * takes (max - hot) / decay ≈ 4 s to cool. That window is the whole tactical
   * point — long enough that walking straight in behind the last round is a
   * mistake, short enough that a squad which waits gets its push.
   */
  max: 12,
  /** How long a lane counts as hot after it kills someone, however quiet it goes. */
  deadly: 9,
  /** How far down the lane the fire actually threatens, in metres. */
  range: 30,
  /** Two firing positions this close are one lane. */
  merge: 3.5,
  /** Seconds of cold silence before a lane is forgotten entirely. */
  forget: 14,
};

/**
 * Ground that has actually got somebody shot.
 *
 * Lanes are inference — a gun is over there, so it can see this. A mark is evidence:
 * a man stood here and took rounds. That is worth having separately, because it
 * needs no theory about where the fire came from and survives the shooter moving.
 * Everything else in this file reasons forward from a muzzle; this reasons backward
 * from a wound.
 *
 * It spreads by shouting. A fighter who is hit cries out, and squadmates near enough
 * to hear log the spot too — second-hand, so a little weaker, but the squad learns a
 * killing ground from one man walking into it rather than each of them in turn.
 *
 * Worth knowing before tuning this: against a shooter who holds one angle and keeps
 * firing, a mark says nothing a lane was not already saying — you get hit on ground
 * the gun can see, so both call it dangerous and turning marks off changes the
 * outcome not at all. Measured across paired runs it sits inside the noise either
 * way. Where it has something of its own to contribute is the cases a lane cannot
 * cover: the shooter relocates and his old lane goes stale, he stops firing but
 * still covers the ground, or a fighter who never heard the shots learns from the
 * shout. It is consulted only by `_peekSwept` for that reason — routing on it was
 * tried twice and measured worse, because a mark lands a stride from the cover the
 * victim was using and reads as a reason to abandon it.
 */
export const MARK = {
  /** What one hit says about the ground you were standing on. */
  heat: 6,
  /** ...and what the shout is worth to somebody who only heard it. */
  fromCallout: 4,
  /**
   * Bled off far slower than a lane's. A lane goes cold when the shooting stops,
   * because it was only ever a guess about a gun; ground that killed someone stays
   * worth avoiding well after the noise has died down. One hit keeps a spot hot for
   * about nine seconds, two for the better part of half a minute.
   */
  decay: 0.35,
  hot: 3,
  max: 12,
  /**
   * How far the danger extends from the spot itself, in metres.
   *
   * Deliberately tight. A hit lands where a man was exposed, which is a stride from
   * the cover he was using — spread it wide and you condemn the cover along with the
   * angle, which is the opposite of the lesson.
   */
  radius: 2.2,
  /** Two hits this close together are the same killing ground. */
  merge: 2.5,
  /** How far the cry carries to squadmates. */
  range: 22,
};

/** Is this lane worth routing around right now? */
export function laneIsHot(lane, now) {
  return lane.heat >= SUPPRESSION.hot || now < lane.deadlyUntil;
}

/**
 * Tell a squad that this spot just got one of them hit.
 *
 * The victim logs it at full weight — he was there. Everyone in earshot logs it at
 * less, because a shout locates a man about as well as a shout ever does. Returns
 * how many fighters took it on board.
 */
export function shareHitGround(world, victim, pos, now) {
  let told = 0;
  for (const mate of world.combatants) {
    if (!mate.alive || !mate.suppression) continue;
    if (mate.team !== victim.team) continue;
    const own = mate === victim;
    if (!own && Math.hypot(mate.pos.x - pos.x, mate.pos.z - pos.z) > MARK.range) continue;
    mate.suppression.mark(pos, own ? MARK.heat : MARK.fromCallout, now);
    told++;
  }
  return told;
}

/**
 * Putting rounds into a place rather than at a person.
 *
 * The other half of the model, and the half that was missing: fighters knew how to
 * *be* suppressed and never how to suppress. A squad that goes quiet the moment it
 * loses sight hands the initiative back every time — and against a player it reads
 * as three men with rifles doing nothing while he reloads.
 *
 * The requirement is a belief tight enough that the rounds land somewhere
 * meaningful, and enough ammunition that spending it on a guess is not the reason
 * he loses the fight. A pistol does not suppress; a support gunner does it on
 * thinner evidence than a pointman, because that is what the role is for.
 */
export const SUPPRESSING = {
  /** Seconds since the belief was last refreshed. */
  maxAge: 6,
  /** How vague a belief is still worth shooting at, in metres. */
  maxRadius: 9,
  /** ...and how much looser the support role will accept. */
  supportRadiusBonus: 4,
  /** Never burn the last of the pool on a guess. */
  minRounds: 25,
  /** Extra degrees of spread: this is area fire, not aimed fire. */
  spread: 6.5,
};

export function worthSuppressing({ radius, age, rounds, role = 'pointman', auto = false }) {
  if (rounds < SUPPRESSING.minRounds) return false;
  if (!auto && role !== 'support') return false;
  if (age > SUPPRESSING.maxAge) return false;
  const limit = SUPPRESSING.maxRadius + (role === 'support' ? SUPPRESSING.supportRadiusBonus : 0);
  return radius <= limit;
}

/**
 * A step out of the beaten zone: the nearest sampled point the lane cannot see.
 *
 * Sideways before backwards, and at the shortest radius that works, because
 * stepping out of a doorway is a shorter move than retreating down the corridor —
 * and a fighter who sprints all the way back every time he is shot at reads as
 * broken rather than careful. Returns null when there is nowhere to hide, which the
 * caller must treat as "carry on", not "stand still and die".
 */
export function coverStep(lane, from, losFn, {
  radii = [2, 3.5, 5],
  probeY = 1.15,
  standable = () => true,
} = {}) {
  const dx = from.x - lane.x, dz = from.z - lane.z;
  const d = Math.hypot(dx, dz) || 1;
  const ax = dx / d, az = dz / d;      // away from the muzzle
  const px = -az, pz = ax;             // across his line
  const dirs = [
    { x: px, z: pz },
    { x: -px, z: -pz },
    { x: ax * 0.6 + px * 0.8, z: az * 0.6 + pz * 0.8 },
    { x: ax * 0.6 - px * 0.8, z: az * 0.6 - pz * 0.8 },
    { x: ax, z: az },
  ];
  for (const r of radii) {
    for (const dir of dirs) {
      const point = { x: from.x + dir.x * r, y: from.y, z: from.z + dir.z * r };
      // Standable first: it is the cheap test, and a "cover" point inside a crate is
      // a fighter walking into a wall until the fire stops.
      if (!standable(point)) continue;
      if (!losFn(lane, { x: point.x, y: point.y + probeY, z: point.z })) return point;
    }
  }
  return null;
}

/** Everything one fighter knows about which angles are being worked. */
export class SuppressionMap {
  constructor() {
    this.lanes = [];
    /** Ground somebody has actually been hit on. */
    this.marks = [];
    this.at = 0;
  }

  /** Bleed heat down to `now` and drop lanes that have gone cold and quiet. */
  decayTo(now) {
    const dt = now - this.at;
    if (dt <= 0) return this.lanes;
    this.at = now;
    for (let i = this.lanes.length - 1; i >= 0; i--) {
      const lane = this.lanes[i];
      lane.heat = Math.max(0, lane.heat - dt * SUPPRESSION.decay);
      if (lane.heat <= 0 && now - lane.lastAt > SUPPRESSION.forget && now >= lane.deadlyUntil) {
        this.lanes.splice(i, 1);
      }
    }
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.heat = Math.max(0, mark.heat - dt * MARK.decay);
      if (mark.heat <= 0) this.marks.splice(i, 1);
    }
    return this.lanes;
  }

  /** Somebody was hit standing here. */
  mark(pos, heat, now) {
    this.decayTo(now);
    let found = null;
    let nearest = MARK.merge * MARK.merge;
    for (const candidate of this.marks) {
      const dx = candidate.x - pos.x, dz = candidate.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearest) { nearest = d2; found = candidate; }
    }
    if (!found) {
      found = { x: pos.x, y: pos.y || 0, z: pos.z, heat: 0, hits: 0, firstAt: now, lastAt: now };
      this.marks.push(found);
    }
    found.heat = Math.min(MARK.max, found.heat + heat);
    found.hits++;
    found.lastAt = now;
    return found;
  }

  /** The hottest piece of known killing ground this point sits in, or null. */
  markedAt(point, now) {
    this.decayTo(now);
    let worst = null;
    for (const mark of this.marks) {
      if (mark.heat < MARK.hot) continue;
      if (worst && mark.heat <= worst.heat) continue;
      const dx = point.x - mark.x, dz = point.z - mark.z;
      if (dx * dx + dz * dz > MARK.radius * MARK.radius) continue;
      worst = mark;
    }
    return worst;
  }

  /** Anything at all worth routing around — a worked angle or a killing ground. */
  anyDanger(now) {
    if (this.anyHot(now)) return true;
    for (const mark of this.marks) if (mark.heat >= MARK.hot) return true;
    return false;
  }

  /**
   * A round came from here.
   *
   * Merged into a nearby lane rather than filed separately: a fighter working an
   * angle shifts about as he shoots, and a cloud of thirty near-identical lanes
   * would be thirty line-of-sight tests for one gun.
   */
  record(origin, heat, now, { deadly = false } = {}) {
    this.decayTo(now);
    let lane = null;
    let nearest = SUPPRESSION.merge * SUPPRESSION.merge;
    for (const candidate of this.lanes) {
      const dx = candidate.x - origin.x, dz = candidate.z - origin.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearest) { nearest = d2; lane = candidate; }
    }
    if (lane) {
      lane.x += (origin.x - lane.x) * 0.35;
      lane.z += (origin.z - lane.z) * 0.35;
      lane.y = origin.y;
    } else {
      lane = {
        x: origin.x, y: origin.y, z: origin.z,
        heat: 0, kills: 0, firstAt: now, lastAt: now, deadlyUntil: -Infinity,
      };
      this.lanes.push(lane);
    }
    lane.heat = Math.min(SUPPRESSION.max, lane.heat + heat);
    lane.lastAt = now;
    if (deadly) {
      lane.kills++;
      lane.deadlyUntil = now + SUPPRESSION.deadly;
    }
    return lane;
  }

  /** Cheap gate: is anything hot at all? Skips the line-of-sight work when not. */
  anyHot(now) {
    this.decayTo(now);
    for (const lane of this.lanes) if (laneIsHot(lane, now)) return true;
    return false;
  }

  /**
   * The hottest hot lane with a clear shot at `point`, or null.
   *
   * Line of sight is tested last and only when the lane could beat the incumbent,
   * because it is the expensive part and most lanes lose on heat alone.
   */
  covering(point, losFn, now) {
    this.decayTo(now);
    let worst = null;
    for (const lane of this.lanes) {
      if (!laneIsHot(lane, now)) continue;
      if (worst && lane.heat <= worst.heat) continue;
      const dx = point.x - lane.x, dz = point.z - lane.z;
      if (dx * dx + dz * dz > SUPPRESSION.range * SUPPRESSION.range) continue;
      if (!losFn(lane, point)) continue;
      worst = lane;
    }
    return worst;
  }
}
