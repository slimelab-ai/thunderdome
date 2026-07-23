import test from 'node:test';
import assert from 'node:assert/strict';
import { directionalCandidate } from '../src/ui-nav.js';

const rect = (left, top, width = 80, height = 40) => ({ left, top, width, height });

test('directional UI navigation prefers aligned controls in the requested direction', () => {
  const controls = [
    rect(100, 100),
    rect(100, 170),
    rect(260, 105),
    rect(20, 105),
    rect(260, 260),
  ];
  assert.equal(directionalCandidate(controls, 0, 'down'), 1);
  assert.equal(directionalCandidate(controls, 0, 'right'), 2);
  assert.equal(directionalCandidate(controls, 0, 'left'), 3);
  assert.equal(directionalCandidate(controls, 1, 'up'), 0);
});

test('directional UI navigation reports no candidate beyond an edge', () => {
  const controls = [rect(0, 0), rect(100, 0)];
  assert.equal(directionalCandidate(controls, 0, 'left'), -1);
  assert.equal(directionalCandidate(controls, 1, 'right'), -1);
  assert.equal(directionalCandidate([], -1, 'down'), -1);
});
