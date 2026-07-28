import test from 'node:test';
import assert from 'node:assert/strict';
import { touchModeFromSignals } from '../src/touch.js';

test('touch mode accepts real touch, coarse pointers, and emulated mobile user agents', () => {
  assert.equal(touchModeFromSignals({ maxTouchPoints: 1 }), true);
  assert.equal(touchModeFromSignals({ coarsePointer: true }), true);
  assert.equal(touchModeFromSignals({ mobileUserAgent: true }), true);
});

test('touch mode remains off on ordinary desktop signals', () => {
  assert.equal(touchModeFromSignals(), false);
});

test('touch query override wins over detected capabilities', () => {
  assert.equal(touchModeFromSignals({ override: '1' }), true);
  assert.equal(touchModeFromSignals({ override: '0', maxTouchPoints: 5, mobileUserAgent: true }), false);
});
