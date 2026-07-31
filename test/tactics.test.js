import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinatedBreachLane, offsetBreachGoal, safeBreachLane, LANE_ABANDON,
  shouldSprintAtTarget, searchProbe, SEARCH_PROBES,
} from '../src/tactics.js';

test('a squad assigns one suppressor and alternating breach lanes', () => {
  const support = { role: 'support', navSeed: 99 };
  const first = { role: 'pointman', navSeed: 10 };
  const second = { role: 'pointman', navSeed: 20 };
  const flanker = { role: 'flanker', navSeed: 30 };
  const squad = [flanker, second, support, first];

  assert.equal(coordinatedBreachLane(squad, support), 0);
  assert.equal(coordinatedBreachLane(squad, first), -1);
  assert.equal(coordinatedBreachLane(squad, second), 1);
  assert.equal(coordinatedBreachLane(squad, flanker), -2);
});

test('breach goals fan out perpendicular to the defended sightline', () => {
  const target = { x: -4, y: 0, z: 10 };
  const attacker = { x: -4, y: 0, z: -10 };

  assert.deepEqual(offsetBreachGoal(target, attacker, 0), { x: -4, y: 0, z: 10 });
  assert.deepEqual(offsetBreachGoal(target, attacker, -1), { x: 1, y: 0, z: 10 });
  assert.deepEqual(offsetBreachGoal(target, attacker, 1), { x: -9, y: 0, z: 10 });
  assert.deepEqual(offsetBreachGoal(target, attacker, -2), { x: 4, y: 0, z: 10 });
});

test('a covered approach is rerouted, and the assigned lane is kept when it is clear', () => {
  const target = { x: 0, y: 0, z: 10 };
  const attacker = { x: 0, y: 0, z: -10 };

  const nothingCovered = safeBreachLane(target, attacker, -1, () => 0);
  assert.equal(nothingCovered.lane, -1, 'the squad assignment stands while it can');
  assert.equal(nothingCovered.covered, false);

  // The whole middle of the pit is being worked; only the wide lanes are clear.
  const middleSwept = goal => (Math.abs(goal.x) < 7 ? 1 : 0);
  const rerouted = safeBreachLane(target, attacker, -1, middleSwept);
  assert.equal(rerouted.covered, false);
  assert.ok(Math.abs(rerouted.goal.x) >= 7, 'it goes around rather than through');
  assert.notEqual(rerouted.lane, -1);
});

test('a route out of the beaten zone beats staying in it, even starting under fire', () => {
  const target = { x: 0, y: 0, z: 10 };
  const attacker = { x: 0, y: 0, z: -10 };
  // The situation that broke the boolean version: a fighter already under fire, so
  // *every* lane costs something. The cheapest one still has to win.
  const cost = goal => (Math.abs(goal.x) >= 7 ? 0.2 : 0.6);
  const out = safeBreachLane(target, attacker, 0, cost);
  assert.equal(out.covered, false, 'partly-swept is not a reason to stop');
  assert.ok(Math.abs(out.goal.x) >= 7, 'it takes the way out rather than cowering');
  assert.equal(out.cost, 0.2);
});

test('ties go to the squad assignment, so a crossfire stays a crossfire', () => {
  const target = { x: 0, y: 0, z: 10 };
  const attacker = { x: 0, y: 0, z: -10 };
  const flat = safeBreachLane(target, attacker, 2, () => 0.3);
  assert.equal(flat.lane, 2);
});

test('when every approach is covered end to end the answer is stop, not least-bad', () => {
  const target = { x: 0, y: 0, z: 10 };
  const attacker = { x: 0, y: 0, z: -10 };
  const pinned = safeBreachLane(target, attacker, 1, () => 1);
  assert.equal(pinned.covered, true);
  assert.equal(pinned.lane, 1, 'it reports the assigned lane so the caller can hold on it');
  assert.deepEqual(pinned.goal, offsetBreachGoal(target, attacker, 1));

  // Just under the abandon line is still worth walking.
  const marginal = safeBreachLane(target, attacker, 1, () => LANE_ABANDON - 0.01);
  assert.equal(marginal.covered, false);
});

test('a search sweeps through the last-known point, then the cover either side', () => {
  const lastKnown = { x: 0, y: 0, z: 4 };
  const searcher = { x: 0, y: 0, z: -6 };   // approaching from -z, so forward is +z

  const push = searchProbe(lastKnown, searcher, 6, 0);
  assert.deepEqual([+push.x.toFixed(2), +push.z.toFixed(2)], [0, 10], 'first, keep going');

  const left = searchProbe(lastKnown, searcher, 6, 1);
  const right = searchProbe(lastKnown, searcher, 6, 2);
  assert.equal(+left.x.toFixed(2), 6);
  assert.equal(+right.x.toFixed(2), -6);
  assert.equal(left.z, right.z, 'the two flanks are the same depth, opposite sides');

  const back = searchProbe(lastKnown, searcher, 6, 3);
  assert.ok(back.z < lastKnown.z, 'last, back toward where he came from');

  // The sweep is finite and stays in the pit.
  const far = searchProbe({ x: 19, y: 0, z: 14 }, { x: 0, y: 0, z: 0 }, 40, 0);
  assert.ok(Math.abs(far.x) <= 20 && Math.abs(far.z) <= 14.5);
  assert.equal(SEARCH_PROBES, 5);
});

test('firearm users stop sprinting on visual contact while melee fighters close', () => {
  assert.equal(shouldSprintAtTarget({ sight: false, distance: 20 }), true);
  assert.equal(shouldSprintAtTarget({ sight: true, distance: 20 }), false);
  assert.equal(shouldSprintAtTarget({ sight: true, melee: true, distance: 8 }), true);
  assert.equal(shouldSprintAtTarget({ sight: false, distance: 20, legDamage: 0.7 }), false);
});
