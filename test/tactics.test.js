import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinatedBreachLane, offsetBreachGoal } from '../src/tactics.js';

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
