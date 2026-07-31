import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinatedBreachLane, offsetBreachGoal, shouldSprintAtTarget, searchProbe, SEARCH_PROBES,
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
