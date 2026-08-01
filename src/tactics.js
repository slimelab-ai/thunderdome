const BREACH_LANES = [0, -1, 1, -2, 2];

/**
 * Lanes to try, in order of how far out of the way they take you.
 *
 * Wider than the assignment table, because rerouting around a covered approach has
 * to have somewhere to go — if the only alternatives are the two the squad is
 * already using, "flank it" degrades into "queue up behind him".
 *
 * It ran to ±3 and that was not far enough to hold an opinion about. Three lanes out
 * is eleven metres off the approach; against a shooter posted wide, the whole far
 * side of the pit sat outside the candidate set, so a squad asked to find a way
 * round one was choosing between seven routes that all walked past him. Every one
 * scored badly, the least-bad won, and they filed into it. ±5 reaches seventeen
 * metres, which is across the arena — the far route is now something the chooser can
 * actually name.
 */
const BREACH_LANE_ORDER = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5];

export function coordinatedBreachLane(squad, fighter) {
  const ordered = [...squad].sort((a, b) => {
    const supportA = a.role === 'support' ? 0 : 1;
    const supportB = b.role === 'support' ? 0 : 1;
    return supportA - supportB || (a.navSeed || 0) - (b.navSeed || 0);
  });
  const index = ordered.indexOf(fighter);
  if (index < 0) return 0;
  if (index < BREACH_LANES.length) return BREACH_LANES[index];
  const magnitude = 3 + Math.floor((index - BREACH_LANES.length) / 2);
  return index % 2 ? -magnitude : magnitude;
}

export function offsetBreachGoal(target, attacker, lane, {
  innerWidth = 5,
  outerStep = 3,
  xLimit = 20,
  zLimit = 14.5,
  /**
   * How far along the line to the target the goal sits, 0..1.
   *
   * 1 puts it level with him, which is what a breach lane has always meant. Less
   * than that is a *staging* point — get around the side first, arrive second — and
   * it exists because every lane ending level with the target is every lane ending
   * inside whatever arc he is covering. A squad offered only those correctly
   * rejects all of them and then has nowhere to go but through one.
   */
  reach = 1,
} = {}) {
  const dx = target.x - attacker.x;
  const dz = target.z - attacker.z;
  const distance = Math.hypot(dx, dz) || 1;
  const fx = dx / distance;
  const fz = dz / distance;
  const width = lane === 0 ? 0 : Math.sign(lane) *
    (innerWidth + Math.max(0, Math.abs(lane) - 1) * outerStep);
  const alongX = attacker.x + dx * reach;
  const alongZ = attacker.z + dz * reach;
  return {
    x: Math.max(-xLimit, Math.min(xLimit, alongX + -fz * width)),
    y: target.y || 0,
    z: Math.max(-zLimit, Math.min(zLimit, alongZ + fx * width)),
  };
}

/**
 * A route cost at or above which no approach is worth taking.
 *
 * Sits exactly at the weight of the destination sample, so that "this lane ends in
 * the beaten zone" is on its own enough to reject the lane, while "this lane crosses
 * the beaten zone on its way somewhere safe" is not. Set any higher — it was 0.75 —
 * and a fighter will happily walk to a spot the gun is covering, arrive, and be shot
 * standing in it, which is a slower version of the thing this file exists to stop.
 */
export const LANE_ABANDON = 0.5;

/**
 * The assigned breach lane if its approach is clear, otherwise the cheapest one.
 *
 * `routeCost(goal, lane)` is the caller's business: 0 for a clear run, up to 1 for
 * ground that is being worked from end to end. The squad's own assignment is tried
 * first and ties go to it, so a crossfire stays a crossfire whenever the fire allows.
 *
 * This used to take a *boolean* — is the route covered at all — and that was wrong
 * in the one situation it exists for. A fighter deciding to reroute is, by
 * definition, already standing in the beaten zone, so every route out of it begins
 * under fire and every lane came back "covered", including the ones that led
 * somewhere safe. The squad would reject all seven and cower behind the nearest
 * crate rather than take four steps right. Crossing the lane to *leave* it is a cost
 * worth paying; ending up parked in it is not, and only a cost can tell those apart.
 *
 * `covered: true` still means stop advancing — but now it means every lane was bad,
 * not merely that every lane started bad.
 */
/**
 * How far along the approach the staging ring sits, tried after the full-depth
 * lanes have all come back covered.
 */
const STAGING_REACH = 0.6;

export function safeBreachLane(target, attacker, assigned, routeCost, opts = {}) {
  // A lane a squadmate has said he is taking costs a little more than one nobody
  // has claimed. Priced rather than reordered: order here only breaks ties, so
  // shuffling it just shoved everyone off their assigned lanes and onto whichever
  // single clean lane was left — measured spread across the angles *fell* from 88
  // degrees to 34. The cost is what actually decides, so the preference belongs in
  // the cost. Small enough that a genuinely safer shared lane still wins, because
  // two men on one good angle beats one man on a lethal one.
  const taken = opts.taken || null;
  const share = opts.sharePenalty ?? 0.15;
  const order = [assigned, ...BREACH_LANE_ORDER.filter(lane => lane !== assigned)];
  let best = null;
  const consider = (reach) => {
    for (const lane of order) {
      const goal = offsetBreachGoal(target, attacker, lane, { ...opts, reach });
      const cost = routeCost(goal, lane) + (taken && taken.has(lane) ? share : 0);
      if (cost <= 0) return { lane, goal, cost: 0, covered: false, staging: reach < 1 };
      if (!best || cost < best.cost - 1e-6) best = { lane, goal, cost, staging: reach < 1 };
    }
    return null;
  };
  const direct = consider(1);
  if (direct) return direct;
  // Everything level with him is covered — which it will be, if he is covering a
  // wide arc, because that is exactly where those goals sit. Before concluding there
  // is nowhere to go, try getting *partway* round: a staging point out to the side
  // is often clean when the position beside him is not, and from there the arc looks
  // different. Without this ring the squad's only remaining option was to hold until
  // the budget ran out and then walk through the best of a bad set.
  const staged = consider(STAGING_REACH);
  if (staged) return staged;
  return { ...best, covered: best.cost >= LANE_ABANDON };
}

export function shouldSprintAtTarget({
  sight, melee = false, distance = 0, legDamage = 0, crossingFire = false,
}) {
  if (legDamage >= 0.6) return false;
  if (melee) return distance > 3;
  // Standing in the beaten zone is not the moment to shoulder the weapon. Sight
  // normally lowers a fighter out of his sprint, which is right everywhere except
  // here: taking the push during a reload and then stopping to aim halfway across
  // the lane is how the gap gets wasted. Cross it, then fight.
  if (crossingFire) return true;
  return !sight;
}

/**
 * Where to look next, having arrived at a last-known position and found nobody.
 *
 * Ordered the way a fighter clearing a room actually works it: push through the
 * point first, in case they kept going; then the cover either side of it, which is
 * where somebody who stopped would be; then back toward the approach, in case they
 * slipped past. Offsets are relative to the direction the searcher came *from*, so
 * the pattern is oriented to the fight rather than to the world axes.
 *
 * Crucially finite. A bot that probes forever is a bot that never loses you, which
 * is the omniscience this whole system exists to remove — when the list runs out,
 * the contact goes with it.
 */
const SEARCH_PATTERN = [
  { forward: 1.0, lateral: 0 },
  { forward: 0.15, lateral: -1 },
  { forward: 0.15, lateral: 1 },
  { forward: -0.7, lateral: -0.7 },
  { forward: -0.7, lateral: 0.7 },
];

export const SEARCH_PROBES = SEARCH_PATTERN.length;

export function searchProbe(lastKnown, searcher, radius, index, {
  minRadius = 2.5,
  maxRadius = 9,
  xLimit = 20,
  zLimit = 14.5,
} = {}) {
  const step = SEARCH_PATTERN[Math.max(0, Math.min(index, SEARCH_PATTERN.length - 1))];
  const dx = lastKnown.x - searcher.x;
  const dz = lastKnown.z - searcher.z;
  const distance = Math.hypot(dx, dz) || 1;
  const fx = dx / distance;
  const fz = dz / distance;
  const r = Math.max(minRadius, Math.min(radius, maxRadius));
  const x = lastKnown.x + fx * step.forward * r + -fz * step.lateral * r;
  const z = lastKnown.z + fz * step.forward * r + fx * step.lateral * r;
  return {
    x: Math.max(-xLimit, Math.min(xLimit, x)),
    y: lastKnown.y || 0,
    z: Math.max(-zLimit, Math.min(zLimit, z)),
  };
}

/**
 * Who holds the angle while the rest of the squad moves.
 *
 * Bounding, in one function. The squad's entire answer to a held lane has been "shoot
 * back from wherever I happen to be standing", and against anybody who reacts that
 * loses every time — measured on the lane test at five hundred damage put on a man
 * who was putting out tens of thousands. What was missing is not footwork. It is that
 * nobody was ever *covering* anybody.
 *
 * One fighter sets: he stops advancing, keeps his angle, and puts rounds on the
 * threat whether or not he can see a body — his job is to own the enemy's attention.
 * Everyone else bounds, and may only cross covered ground while he is doing it.
 *
 * Elected rather than assigned, and deterministic: the man who can actually see the
 * target, preferring the ones built to sit still. A rusher is never the setter; he
 * is the reason the setter exists.
 */
export function electOverwatch(squad, target) {
  let best = null;
  let bestScore = -Infinity;
  for (const fighter of squad) {
    if (!fighter.alive || fighter.target !== target) continue;
    if (!fighter.contact?.visible) continue;
    if (fighter.archetype === 'rusher') continue;
    const score = (fighter.role === 'support' ? 3 : 0)
      + (fighter.archetype === 'marksman' ? 3 : 0)
      + (fighter.archetype === 'medic' ? -2 : 0)
      // Deterministic tie-break, so the job does not hop between men every think.
      - ((fighter.navSeed || 0) % 1000) / 1000;
    if (score > bestScore) { bestScore = score; best = fighter; }
  }
  return best;
}

/**
 * Is somebody actually covering this fighter right now?
 *
 * Not "is a setter elected" — is one shooting. A man holding an angle in silence
 * suppresses nobody, and a bound taken on the strength of a nominal overwatch is the
 * same unescorted crossing it always was.
 */
export function isCovered(setter, self, now, within = 1.5) {
  return !!setter && setter !== self && setter.alive && now - (setter.lastShotAt ?? -99) < within;
}


/**
 * How long a squadmate's call stays worth respecting, in seconds.
 *
 * Long enough that a squad fanning out does not immediately re-converge, short
 * enough that a lane goes back in the pool once the man who called it is dead or has
 * changed his mind and not said so.
 */
export const CALL_TTL = 7;

/**
 * The lanes this fighter believes are spoken for.
 *
 * Built from what he has actually been told, not from reading his squadmates'
 * intentions. A man who is out of earshot, or who called before this fighter was
 * listening, is a man whose lane is unknown — and two of them ending up on the same
 * approach is the correct outcome of that, not a bug.
 */
export function lanesSpokenFor(calls, target, now) {
  const taken = new Set();
  if (!calls) return taken;
  for (const [caller, call] of calls) {
    if (!caller.alive) continue;
    if (call.target !== target) continue;
    if (now - call.at > CALL_TTL) continue;
    taken.add(call.lane);
  }
  return taken;
}
