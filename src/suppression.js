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

/** Is this lane worth routing around right now? */
export function laneIsHot(lane, now) {
  return lane.heat >= SUPPRESSION.hot || now < lane.deadlyUntil;
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
    return this.lanes;
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
