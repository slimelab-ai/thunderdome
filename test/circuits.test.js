import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAST_CREW_STABILIZATION_BANKROLL,
  stabilizeLastCrew,
} from '../src/circuits.js';

function member(name, hp, { benched = false, xp = 0, kills = 0 } = {}) {
  return { name, hp, benched, kills, progress: { totalXp: xp } };
}

test('stabilizes the most experienced deployed crew member when a broke squad is fully down', () => {
  const crew = [
    member('Rook', 0, { xp: 20, kills: 4 }),
    member('Moose', 0, { xp: 90, kills: 12 }),
    member('Bench', 0, { benched: true, xp: 500 }),
  ];

  const stabilized = stabilizeLastCrew(crew, LAST_CREW_STABILIZATION_BANKROLL - 1);

  assert.equal(stabilized, crew[1]);
  assert.equal(crew[1].hp, 1);
  assert.equal(crew[0].hp, 0);
  assert.equal(crew[2].hp, 0);
});

test('does not stabilize crew while a deployed teammate is alive', () => {
  const crew = [member('Rook', 0), member('Moose', 12)];
  assert.equal(stabilizeLastCrew(crew, 0), null);
  assert.equal(crew[0].hp, 0);
});

test('does not stabilize crew above the recovery bankroll threshold', () => {
  const crew = [member('Rook', 0)];
  assert.equal(stabilizeLastCrew(crew, LAST_CREW_STABILIZATION_BANKROLL), null);
  assert.equal(crew[0].hp, 0);
});
