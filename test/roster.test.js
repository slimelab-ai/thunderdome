import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREW_CONTRACT_CAP, DEPLOYED_CREW_CAP, deployedCrewCount,
  normalizeCrewDeployment, shouldBenchNewHire,
} from '../src/roster.js';

test('new hires enter reserve once all five deployed slots are full', () => {
  const crew = Array.from({ length: DEPLOYED_CREW_CAP }, () => ({ benched: false }));
  assert.equal(shouldBenchNewHire(crew), true);
  crew[2].benched = true;
  assert.equal(shouldBenchNewHire(crew), false);
  assert.equal(CREW_CONTRACT_CAP, 8);
});

test('legacy over-cap squads migrate overflow fighters into reserve', () => {
  const crew = Array.from({ length: 8 }, () => ({ benched: false }));
  normalizeCrewDeployment(crew);
  assert.equal(deployedCrewCount(crew), 5);
  assert.deepEqual(crew.map(member => member.benched), [
    false, false, false, false, false, true, true, true,
  ]);
});
