import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SuppressionMap, SUPPRESSION, SUPPRESSING, MARK,
  laneIsHot, coverStep, worthSuppressing, shareHitGround,
} from '../src/suppression.js';

// Line of sight stand-in: a wall along x = 0 blocks anything crossing it, except
// through a doorway between z = -1 and z = 1.
const wallAtX0 = (a, b) => {
  if ((a.x < 0) === (b.x < 0)) return true;
  const t = (0 - a.x) / (b.x - a.x);
  const z = a.z + (b.z - a.z) * t;
  return Math.abs(z) <= 1;
};
const clear = () => true;

test('one round is nothing; sustained fire into a doorway is a hot lane', () => {
  const map = new SuppressionMap();
  const muzzle = { x: 10, y: 1.2, z: 0 };

  map.record(muzzle, SUPPRESSION.shot, 0);
  assert.equal(map.anyHot(0), false, 'a single shot does not pin anyone');

  // A burst, then another, the way an automatic is actually fired.
  for (let i = 0; i < 8; i++) map.record(muzzle, SUPPRESSION.shot, i * 0.12);
  assert.equal(map.anyHot(1), true);
  assert.equal(map.lanes.length, 1, 'a shooter working one angle is one lane');
});

test('heat is capped, and a lane cools within a few seconds of going quiet', () => {
  const map = new SuppressionMap();
  const muzzle = { x: 10, y: 1.2, z: 0 };
  for (let i = 0; i < 40; i++) map.record(muzzle, SUPPRESSION.shot, i * 0.05);
  const lane = map.lanes[0];
  assert.equal(lane.heat, SUPPRESSION.max, 'sustained fire saturates rather than banking');

  const quiet = lane.lastAt;
  map.decayTo(quiet + 2);
  assert.equal(laneIsHot(lane, quiet + 2), true, 'still hot two seconds after the last round');
  map.decayTo(quiet + 5);
  assert.equal(laneIsHot(lane, quiet + 5), false, '...and cold by five, which is the window to push');
});

test('a lane that killed somebody stays deadly however quiet it goes', () => {
  const map = new SuppressionMap();
  const muzzle = { x: 10, y: 1.2, z: 0 };
  map.record(muzzle, SUPPRESSION.kill, 0, { deadly: true });
  const lane = map.lanes[0];
  assert.equal(lane.kills, 1);

  map.decayTo(6);
  assert.equal(lane.heat, 0, 'the heat itself has long gone');
  assert.equal(laneIsHot(lane, 6), true, 'but the angle is still the one that killed him');
  assert.equal(laneIsHot(lane, SUPPRESSION.deadly + 1), false);
});

test('nearby firing positions merge, distant ones do not', () => {
  const map = new SuppressionMap();
  map.record({ x: 10, y: 1, z: 0 }, 1, 0);
  map.record({ x: 10 + SUPPRESSION.merge - 0.5, y: 1, z: 0 }, 1, 0.1);
  assert.equal(map.lanes.length, 1, 'a shooter shifting on his angle is one gun');

  map.record({ x: -10, y: 1, z: 0 }, 1, 0.2);
  assert.equal(map.lanes.length, 2, 'a second gun somewhere else is a second lane');
});

test('a lane only covers ground it can see, inside its range', () => {
  const map = new SuppressionMap();
  const muzzle = { x: 5, y: 1.2, z: 0 };
  for (let i = 0; i < 8; i++) map.record(muzzle, SUPPRESSION.shot, i * 0.1);
  const now = 1;

  // Through the doorway at z ~ 0: covered. Behind the wall: not.
  assert.ok(map.covering({ x: -3, y: 1.15, z: 0 }, wallAtX0, now), 'the doorway is swept');
  assert.equal(map.covering({ x: -3, y: 1.15, z: 6 }, wallAtX0, now), null, 'behind the wall is not');

  // Same clear sightline, but beyond the lane's reach.
  const far = { x: 5 - SUPPRESSION.range - 5, y: 1.15, z: 0 };
  assert.equal(map.covering(far, clear, now), null);
});

test('the hottest covering lane wins, and a cold one never covers anything', () => {
  const map = new SuppressionMap();
  for (let i = 0; i < 4; i++) map.record({ x: 5, y: 1, z: 0 }, SUPPRESSION.shot, i * 0.1);
  for (let i = 0; i < 10; i++) map.record({ x: -5, y: 1, z: 0 }, SUPPRESSION.shot, i * 0.1);
  const hottest = map.covering({ x: 0, y: 1.15, z: 0 }, clear, 1);
  assert.equal(hottest.x, -5);

  const cold = new SuppressionMap();
  cold.record({ x: 5, y: 1, z: 0 }, SUPPRESSION.shot, 0);
  assert.equal(cold.covering({ x: 0, y: 1.15, z: 0 }, clear, 0), null);
});

test('breaking cover steps out of the lane rather than retreating down it', () => {
  const lane = { x: 5, y: 1.2, z: 0, heat: 10 };
  // Standing in the doorway; sideways along the wall gets out of the sightline.
  const step = coverStep(lane, { x: -3, y: 0, z: 0 }, wallAtX0);
  assert.ok(step, 'there is somewhere to go');
  assert.ok(Math.abs(step.z) > 1, 'out of the doorway, not straight back down it');
  assert.equal(wallAtX0(lane, { x: step.x, y: step.y + 1.15, z: step.z }), false);
});

test('nowhere to hide returns null, so the caller carries on instead of freezing', () => {
  const lane = { x: 5, y: 1.2, z: 0, heat: 10 };
  assert.equal(coverStep(lane, { x: -3, y: 0, z: 0 }, clear), null);
});

test('cover you cannot stand in is not cover', () => {
  const lane = { x: 5, y: 1.2, z: 0, heat: 10 };
  const from = { x: -3, y: 0, z: 0 };
  const out = coverStep(lane, from, wallAtX0);
  // Every spot the wall would hide him in is inside a crate: he must be told there
  // is nowhere to go, not sent to grind into it.
  assert.equal(coverStep(lane, from, wallAtX0, { standable: () => false }), null);
  assert.ok(out, 'and with clear ground he still finds it');
});

test('ground that got somebody hit is dangerous without any theory about the shooter', () => {
  const map = new SuppressionMap();
  const spot = { x: 4, y: 0, z: 4 };
  map.mark(spot, MARK.heat, 0);

  assert.ok(map.markedAt({ x: 4, y: 1.15, z: 4 }, 0), 'the spot itself');
  assert.ok(map.markedAt({ x: 4 + MARK.radius - 0.3, y: 1.15, z: 4 }, 0), 'and its immediate surround');
  assert.equal(map.markedAt({ x: 4 + MARK.radius + 1, y: 1.15, z: 4 }, 0), null, 'but not the next room');
  // No lanes at all — a mark needs no sightline to mean something.
  assert.equal(map.lanes.length, 0);
  assert.equal(map.anyDanger(0), true);
});

test('a killing ground outlasts the shooting that made it, and hits compound', () => {
  const once = new SuppressionMap();
  once.mark({ x: 0, y: 0, z: 0 }, MARK.heat, 0);
  const at = t => once.markedAt({ x: 0, y: 1.15, z: 0 }, t);
  assert.ok(at(8), 'still known nine seconds later');
  assert.equal(at(12), null, 'eventually forgotten');

  // Two men down on the same patch is a different proposition from one.
  const twice = new SuppressionMap();
  twice.mark({ x: 0, y: 0, z: 0 }, MARK.heat, 0);
  twice.mark({ x: 1, y: 0, z: 0 }, MARK.heat, 1);
  assert.equal(twice.marks.length, 1, 'the same patch, not two');
  assert.equal(twice.marks[0].hits, 2);
  assert.ok(twice.markedAt({ x: 0, y: 1.15, z: 0 }, 20), 'and it stays known far longer');
});

test('a bite outweighs a bang, and twice bitten is simply not crossed', () => {
  const map = new SuppressionMap();
  const far = { x: 40, y: 0, z: 40 };          // somewhere he is not standing
  map.mark({ x: 0, y: 0, z: 0 }, MARK.heat, 0);
  assert.equal(map.markWeightAt({ x: 0, y: 1.15, z: 0 }, 0, far), MARK.weight);
  assert.ok(MARK.weight > 1, 'heavier than ground merely presumed covered');

  map.mark({ x: 0.5, y: 0, z: 0 }, MARK.heat, 1);
  assert.equal(map.markWeightAt({ x: 0, y: 1.15, z: 0 }, 1, far), MARK.repeatWeight);
  assert.equal(map.markWeightAt({ x: 30, y: 1.15, z: 30 }, 1, far), 0, 'clean ground is free');
});

test('the mark a fighter is standing in does not price his own way out', () => {
  const map = new SuppressionMap();
  map.mark({ x: 0, y: 0, z: 0 }, MARK.heat, 0);
  const point = { x: 1, y: 1.15, z: 0 };
  // Asked cold, the spot is dangerous...
  assert.ok(map.markedAt(point, 0));
  // ...but not to the man who made it by being shot there, or every route he could
  // take out of his own cover would price as badly as staying in it.
  assert.equal(map.markedAt(point, 0, { x: 0.5, y: 0, z: 0 }), null);
  assert.equal(map.markWeightAt(point, 0, { x: 0.5, y: 0, z: 0 }), 0);
  // Somebody else, standing clear, still sees it for what it is.
  assert.ok(map.markedAt(point, 0, { x: 20, y: 0, z: 20 }));
});

test('marks are dropped once cold, rather than accumulating forever', () => {
  const map = new SuppressionMap();
  map.mark({ x: 0, y: 0, z: 0 }, MARK.heat, 0);
  map.decayTo(MARK.heat / MARK.decay + 1);
  assert.equal(map.marks.length, 0);
  assert.equal(map.anyDanger(100), false);
});

test('a hit is shouted to the squad, weaker second-hand and not at all to the enemy', () => {
  const make = (team, x) => {
    const c = { team, alive: true, pos: { x, y: 0, z: 0 }, suppression: new SuppressionMap() };
    return c;
  };
  const victim = make('enemy', 0);
  const near = make('enemy', 5);
  const far = make('enemy', MARK.range + 10);
  const hostile = make('player', 5);
  const dead = make('enemy', 5); dead.alive = false;
  const world = { combatants: [victim, near, far, hostile, dead] };

  assert.equal(shareHitGround(world, victim, victim.pos, 0), 2, 'himself and the man in earshot');
  assert.equal(victim.suppression.marks[0].heat, MARK.heat);
  assert.equal(near.suppression.marks[0].heat, MARK.fromCallout);
  assert.ok(near.suppression.marks[0].heat < victim.suppression.marks[0].heat,
    'hearing about it is worth less than being there');
  assert.equal(far.suppression.marks.length, 0);
  assert.equal(hostile.suppression.marks.length, 0, 'the enemy does not learn from your cry');
  assert.equal(dead.suppression.marks.length, 0);
});

test('area fire needs a belief worth spending rounds on', () => {
  const ok = { radius: 5, age: 2, rounds: 120, role: 'pointman', auto: true };
  assert.equal(worthSuppressing(ok), true);

  assert.equal(worthSuppressing({ ...ok, age: SUPPRESSING.maxAge + 1 }), false, 'stale');
  assert.equal(worthSuppressing({ ...ok, radius: SUPPRESSING.maxRadius + 1 }), false, 'too vague');
  assert.equal(worthSuppressing({ ...ok, rounds: SUPPRESSING.minRounds - 1 }), false,
    'never on the last of the pool');
  assert.equal(worthSuppressing({ ...ok, auto: false }), false, 'a pistol does not suppress');

  // The support gunner is the one who does this, so he does it on thinner evidence —
  // and he will do it with a weapon that is not automatic.
  const vague = { ...ok, radius: SUPPRESSING.maxRadius + 2 };
  assert.equal(worthSuppressing(vague), false);
  assert.equal(worthSuppressing({ ...vague, role: 'support' }), true);
  assert.equal(worthSuppressing({ ...ok, auto: false, role: 'support' }), true);
});
